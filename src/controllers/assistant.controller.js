const assistantService = require('../services/assistant.service');
const gemini = require('../config/gemini');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { ok } = require('../utils/response');
const { OWNER_TYPE, QUICK_ACTIONS, LIMITS } = require('../constants/assistant');

/**
 * The AI assistant's HTTP surface.
 *
 * Every handler here begins with `actorOf(req)`, and that is the only place the
 * caller's identity comes from. The request body carries a message and, at
 * most, a conversation id. It does not carry a role, a user id, a name or a
 * permission, and nothing here would read one if it did.
 */

/**
 * Who is asking, from the token the auth middleware already verified.
 *
 * Both middlewares can have run — the routes are mounted under one or the
 * other, never both — so an admin is recognised first and a user second.
 */
function actorOf(req) {
  if (req.admin) {
    return {
      ownerType: OWNER_TYPE.ADMIN,
      ownerId: req.admin._id,
      _id: req.admin._id,
      role: 'admin',
      name: req.admin.name,
      isActive: req.admin.isActive
    };
  }

  return {
    ownerType: OWNER_TYPE.USER,
    ownerId: req.user._id,
    _id: req.user._id,
    role: req.user.role,
    name: req.user.name,
    isActive: req.user.isActive
  };
}

/** Whether the assistant can be used at all, and what to suggest asking it. */
const status = asyncHandler(async (req, res) => {
  const actor = actorOf(req);
  const role = assistantService.roleOf(actor);

  return ok(res, {
    ...gemini.describe(),
    role,
    quickActions: QUICK_ACTIONS[role] || [],
    maxMessageLength: LIMITS.MAX_MESSAGE_LENGTH
  });
});

/** Ask a question, wait for the whole answer. */
const sendMessage = asyncHandler(async (req, res) => {
  const result = await assistantService.ask({
    actor: actorOf(req),
    conversationId: req.body.conversationId || null,
    message: req.body.message
  });

  return ok(res, result, 'Answered');
});

/**
 * The same question, streamed.
 *
 * Server-sent events over the existing POST rather than a socket: the ride
 * system's Socket.IO connection carries ride state, and putting support chat
 * through it would couple two things that have no reason to fail together.
 *
 * Because this responds 200 the moment the headers go out, a failure after that
 * point cannot be an HTTP status. It is sent as an `error` event instead, and
 * the client renders it the same way it renders a failed request.
 */
const streamMessage = asyncHandler(async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx and friends not to buffer, which would defeat the point.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  // If the person closes the panel mid-answer, stop writing into a dead socket.
  let aborted = false;
  req.on('close', () => {
    aborted = true;
  });

  try {
    const result = await assistantService.askStream({
      actor: actorOf(req),
      conversationId: req.body.conversationId || null,
      message: req.body.message,
      onChunk: (text) => {
        if (!aborted) send('chunk', { text });
      }
    });

    send('done', result);
  } catch (err) {
    // The full error is already logged by the service's translator. What goes
    // over the wire is the clean sentence and nothing else.
    const expected = err?.expected === true;
    if (!expected) logger.error(`Assistant stream failed: ${err?.stack || err?.message}`);

    send('error', {
      message: expected ? err.message : 'The AI assistant is temporarily unavailable. Please try again.'
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

const listConversations = asyncHandler(async (req, res) => {
  const conversations = await assistantService.listConversations(actorOf(req));
  return ok(res, { conversations });
});

const getConversation = asyncHandler(async (req, res) => {
  const result = await assistantService.getConversation(actorOf(req), req.params.conversationId);
  return ok(res, result);
});

const deleteConversation = asyncHandler(async (req, res) => {
  const result = await assistantService.deleteConversation(actorOf(req), req.params.conversationId);
  return ok(res, result, 'Conversation deleted');
});

module.exports = {
  status,
  sendMessage,
  streamMessage,
  listConversations,
  getConversation,
  deleteConversation
};
