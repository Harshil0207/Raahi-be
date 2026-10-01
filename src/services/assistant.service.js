const { ApiError: GeminiApiError } = require('@google/genai');
const AssistantConversation = require('../models/AssistantConversation');
const AssistantMessage = require('../models/AssistantMessage');
const gemini = require('../config/gemini');
const prompt = require('./assistant/prompt');
const context = require('./assistant/context');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const {
  ASSISTANT_ROLE,
  MESSAGE_ROLE,
  MESSAGE_STATUS,
  LIMITS
} = require('../constants/assistant');

/**
 * The AI assistant.
 *
 * One turn is: find or open the thread, read the recent history, gather live
 * platform facts and verified account context, ask the model, store both sides.
 * Everything a client sends is a question and a conversation id — the role, the
 * account facts and the rules come from the server every time.
 *
 * Nothing here can change the platform. The assistant reads and explains; it
 * has no tools, no function calling and no write path. That is deliberate: a
 * support bot that could cancel a ride or move a balance would be a new way to
 * do both, sitting outside every check the real endpoints carry.
 */

const UNAVAILABLE = 'The AI assistant is temporarily unavailable. Please try again in a moment.';

// ------------------------------------------------------------------ hygiene

/**
 * What arrives from a client before it goes anywhere near the model.
 *
 * This is tidying, not a security control — the security control is that the
 * message goes into a user turn and never into the system instruction. Control
 * characters are dropped because they are never typed on purpose and they are
 * the usual way of hiding text from a human reviewing a log.
 */
function sanitise(raw) {
  const text = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Zero-width and direction-override characters, which render as nothing and
    // can make a message read differently to a person than to the model.
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .trim();

  if (!text) throw ApiError.badRequest('Please type a message first');
  if (text.length > LIMITS.MAX_MESSAGE_LENGTH) {
    throw ApiError.badRequest(`Please keep your message under ${LIMITS.MAX_MESSAGE_LENGTH} characters`);
  }

  return text;
}

/** The assistant role for a signed-in account. Never taken from the request. */
function roleOf(actor) {
  if (actor.ownerType === 'ADMIN') return ASSISTANT_ROLE.ADMIN;
  return actor.role === 'rider' ? ASSISTANT_ROLE.RIDER : ASSISTANT_ROLE.CUSTOMER;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

// ------------------------------------------------------------ conversations

const scope = (actor) => ({ ownerType: actor.ownerType, ownerId: actor.ownerId });

/**
 * The thread this turn belongs to.
 *
 * A conversation id that is not this account's is a 404 rather than a 403: the
 * caller learns nothing about whether it exists.
 */
async function resolveConversation(actor, conversationId, role) {
  if (conversationId) {
    const existing = await AssistantConversation.findOne({ _id: conversationId, ...scope(actor) });
    if (!existing) throw ApiError.notFound('Conversation not found');

    if (existing.messageCount >= LIMITS.MAX_MESSAGES_PER_CONVERSATION) {
      throw ApiError.badRequest('This conversation is full. Start a new chat to carry on.');
    }

    return existing;
  }

  return AssistantConversation.create({ ...scope(actor), role });
}

/**
 * The recent turns, oldest first, in the shape the SDK wants.
 *
 * Only the two roles the model understands are replayed, and only the text.
 * A turn we failed to answer is not replayed as an empty assistant message,
 * because that teaches the model that empty answers are acceptable.
 */
async function history(conversationId) {
  const rows = await AssistantMessage.find({
    conversationId,
    status: MESSAGE_STATUS.OK
  })
    .sort({ createdAt: -1 })
    .limit(LIMITS.HISTORY_TURNS * 2)
    .lean();

  return rows
    .reverse()
    .map((row) => ({
      role: row.role === MESSAGE_ROLE.ASSISTANT ? 'model' : 'user',
      parts: [{ text: row.content }]
    }));
}

// ------------------------------------------------------------------- errors

/**
 * Anything the SDK throws, turned into something safe to show.
 *
 * The real error goes to the log with its status and message; the client gets a
 * sentence. Nothing about the key, the model, the account or the request shape
 * crosses this line.
 */
function translate(err, { role }) {
  const status = err instanceof GeminiApiError ? err.status : err?.status;

  // The whole upstream failure, in the log, where an operator can act on it.
  // Everything returned below is a sentence; the two must never be the same
  // text, or one of them is wrong.
  logger.error(
    `Assistant call failed (${role}) — status ${status ?? 'none'}, model ${env.gemini.model}: ${err?.message}`
  );

  if (err?.name === 'AbortError' || /timeout|aborted/i.test(err?.message || '')) {
    return new ApiError(504, 'The assistant took too long to answer. Please try again.');
  }

  // 401/403 means the key is wrong or has lost access. An operator problem,
  // and the person asking must not be told which.
  if (status === 401 || status === 403) {
    logger.error(
      'Assistant: Gemini rejected the API key. Check GEMINI_API_KEY in .env, and that the ' +
        'Generative Language API is enabled for it. The server must be restarted after the file changes.'
    );
    return new ApiError(503, UNAVAILABLE);
  }

  /**
   * 404 means the MODEL does not exist for this key — and it is worth its own
   * branch because it is silent otherwise.
   *
   * This is what a retired model looks like, and it is how this integration
   * failed the first time: `gemini-flash-latest` pointed at a model Google had
   * withdrawn, every request 404'd, and the client was told the assistant was
   * "temporarily unavailable" — which is true of nothing that a restart would
   * fix. Naming the model and listing the alternatives turns a mystery into a
   * one-line change.
   */
  if (status === 404) {
    logger.error(
      `Assistant: the model "${env.gemini.model}" is not available to this API key. ` +
        'Set GEMINI_MODEL in .env to one the key can use, then restart.'
    );
    // Fetched once, lazily, and only on this failure — so the useful half of
    // the answer arrives without a listing call on every healthy request.
    reportAvailableModels();
    return new ApiError(503, UNAVAILABLE);
  }

  if (status === 429) {
    return new ApiError(503, 'The assistant is busy right now. Please try again in a moment.');
  }

  return new ApiError(503, UNAVAILABLE);
}

/**
 * Log which models this key CAN use, after a 404 has said which one it cannot.
 *
 * Deliberately fire-and-forget and rate-limited to once a minute: a support
 * panel being hammered while the model name is wrong must not turn into a
 * listing call per keystroke, and nothing here may affect the response the
 * caller already has.
 */
let lastListingAt = 0;

function reportAvailableModels() {
  if (Date.now() - lastListingAt < 60_000) return;
  lastListingAt = Date.now();

  (async () => {
    try {
      const names = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const model of await gemini.getClient().models.list()) {
        if (model?.name) names.push(model.name.replace(/^models\//, ''));
        if (names.length >= 40) break;
      }
      logger.error(
        names.length
          ? `Assistant: models available to this key — ${names.join(', ')}`
          : 'Assistant: the key returned no usable models.'
      );
    } catch (listErr) {
      logger.error(`Assistant: could not list models either — ${listErr?.message}`);
    }
  })();
}

/** Reads the answer out of a response, and says why there is not one. */
function readAnswer(response) {
  const blocked = response?.promptFeedback?.blockReason;
  if (blocked) {
    return { text: null, reason: `blocked: ${blocked}` };
  }

  const text = (response?.text || '').trim();
  if (text) return { text, reason: null };

  const finish = response?.candidates?.[0]?.finishReason;
  return { text: null, reason: finish ? `no text (${finish})` : 'no text' };
}

const EMPTY_ANSWER =
  'I could not put together an answer to that one. Try rewording it, or raise a complaint in the app if you need a person to look at it.';

// -------------------------------------------------------------- the request

/**
 * Everything the model is given for one turn, assembled fresh.
 *
 * Separate from the call itself so a test can read exactly what would be sent
 * without spending a request — which is the only way to assert that a secret
 * never appears in it.
 */
async function buildRequest({ actor, role, conversation, message }) {
  const [past, accountContext] = await Promise.all([
    history(conversation._id),
    context.gather(role, actor)
  ]);

  return {
    model: env.gemini.model,
    contents: [...past, { role: 'user', parts: [{ text: message }] }],
    config: {
      // A field of its own. The user's text is in `contents` and can never
      // reach this side of the request.
      systemInstruction: prompt.build({
        role,
        name: firstName(actor.name),
        context: accountContext
      }),
      maxOutputTokens: env.gemini.maxOutputTokens,
      // Low, not zero: support answers should be consistent, and a fare quoted
      // twice should read the same both times.
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(env.gemini.timeoutMs)
    }
  };
}

/** Persists the pair and updates the thread's summary fields. */
async function persist({ actor, conversation, question, answer, status, usage }) {
  const rows = [
    { conversationId: conversation._id, ...scope(actor), role: MESSAGE_ROLE.USER, content: question },
    {
      conversationId: conversation._id,
      ...scope(actor),
      role: MESSAGE_ROLE.ASSISTANT,
      content: answer,
      status,
      usage
    }
  ];

  const [, stored] = await AssistantMessage.insertMany(rows);

  conversation.messageCount += 2;
  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = AssistantMessage.preview(answer);
  // The thread is named after the question that started it, which is what
  // somebody scanning a list is actually looking for.
  if (!conversation.title) conversation.title = AssistantMessage.preview(question).slice(0, 80);
  await conversation.save();

  return stored;
}

/**
 * Ask a question and get an answer.
 *
 * On failure nothing is stored, so the thread never fills with questions that
 * were never answered and a retry starts from a clean state.
 */
async function ask({ actor, conversationId, message }) {
  if (!gemini.isConfigured()) {
    logger.error('Assistant asked for but GEMINI_API_KEY is not set');
    throw new ApiError(503, UNAVAILABLE);
  }

  const role = roleOf(actor);
  const question = sanitise(message);
  const conversation = await resolveConversation(actor, conversationId, role);

  const request = await buildRequest({ actor, role, conversation, message: question });

  const startedAt = Date.now();
  let response;
  try {
    response = await gemini.getClient().models.generateContent(request);
  } catch (err) {
    throw translate(err, { role });
  }

  const latencyMs = Date.now() - startedAt;
  const { text, reason } = readAnswer(response);

  if (!text) logger.warn(`Assistant produced no answer (${role}): ${reason}`);

  const stored = await persist({
    actor,
    conversation,
    question,
    answer: text || EMPTY_ANSWER,
    status: text ? MESSAGE_STATUS.OK : MESSAGE_STATUS.EMPTY,
    usage: {
      promptTokens: response?.usageMetadata?.promptTokenCount ?? null,
      responseTokens: response?.usageMetadata?.candidatesTokenCount ?? null,
      latencyMs
    }
  });

  return {
    conversationId: String(conversation._id),
    message: toPublicMessage(stored)
  };
}

/**
 * The same turn, delivered as it is generated.
 *
 * Streaming is a better experience and it changes nothing about the security
 * model: the same request is built by the same function, and the same pair is
 * stored at the end. `onChunk` is called with each piece of text.
 *
 * A stream that fails part-way keeps what arrived rather than throwing it away,
 * because the person has already read it.
 */
async function askStream({ actor, conversationId, message, onChunk }) {
  if (!gemini.isConfigured()) {
    logger.error('Assistant asked for but GEMINI_API_KEY is not set');
    throw new ApiError(503, UNAVAILABLE);
  }

  const role = roleOf(actor);
  const question = sanitise(message);
  const conversation = await resolveConversation(actor, conversationId, role);

  const request = await buildRequest({ actor, role, conversation, message: question });

  const startedAt = Date.now();
  let text = '';
  let usage = null;
  let blockedReason = null;

  try {
    const stream = await gemini.getClient().models.generateContentStream(request);

    for await (const chunk of stream) {
      if (chunk?.promptFeedback?.blockReason) blockedReason = chunk.promptFeedback.blockReason;
      if (chunk?.usageMetadata) usage = chunk.usageMetadata;

      const piece = chunk?.text || '';
      if (piece) {
        text += piece;
        onChunk?.(piece);
      }
    }
  } catch (err) {
    // Nothing readable arrived, so this is an ordinary failure.
    if (!text) throw translate(err, { role });

    // Something did arrive and has already been shown. Keep it, note the break.
    logger.error(`Assistant stream broke after ${text.length} characters (${role}): ${err.message}`);
  }

  const answer = text.trim();
  if (!answer && blockedReason) logger.warn(`Assistant stream blocked (${role}): ${blockedReason}`);

  const stored = await persist({
    actor,
    conversation,
    question,
    answer: answer || EMPTY_ANSWER,
    status: answer ? MESSAGE_STATUS.OK : MESSAGE_STATUS.EMPTY,
    usage: {
      promptTokens: usage?.promptTokenCount ?? null,
      responseTokens: usage?.candidatesTokenCount ?? null,
      latencyMs: Date.now() - startedAt
    }
  });

  return {
    conversationId: String(conversation._id),
    message: toPublicMessage(stored)
  };
}

// ------------------------------------------------------------------ reading

const toPublicMessage = (row) => ({
  id: String(row._id),
  role: row.role,
  content: row.content,
  status: row.status,
  createdAt: row.createdAt
});

const toPublicConversation = (row) => ({
  id: String(row._id),
  title: row.title,
  role: row.role,
  messageCount: row.messageCount,
  lastMessageAt: row.lastMessageAt,
  lastMessagePreview: row.lastMessagePreview,
  createdAt: row.createdAt
});

async function listConversations(actor) {
  const rows = await AssistantConversation.find(scope(actor))
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .limit(LIMITS.MAX_CONVERSATIONS)
    .lean();

  return rows.map(toPublicConversation);
}

async function getConversation(actor, conversationId) {
  const conversation = await AssistantConversation.findOne({
    _id: conversationId,
    ...scope(actor)
  }).lean();

  if (!conversation) throw ApiError.notFound('Conversation not found');

  const messages = await AssistantMessage.find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .lean();

  return {
    conversation: toPublicConversation(conversation),
    messages: messages.map(toPublicMessage)
  };
}

/** Deletes the thread and everything in it. There is no soft delete. */
async function deleteConversation(actor, conversationId) {
  const conversation = await AssistantConversation.findOneAndDelete({
    _id: conversationId,
    ...scope(actor)
  });

  if (!conversation) throw ApiError.notFound('Conversation not found');

  const { deletedCount } = await AssistantMessage.deleteMany({ conversationId: conversation._id });

  return { id: String(conversation._id), deletedMessages: deletedCount };
}

module.exports = {
  ask,
  askStream,
  listConversations,
  getConversation,
  deleteConversation,
  // Exported for tests: these are the decisions worth checking on their own,
  // and none of them needs either a database or a model to be right.
  sanitise,
  roleOf,
  buildRequest,
  translate,
  readAnswer
};
