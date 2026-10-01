const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const Rider = require('../models/Rider');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const settings = require('./settings.service');
const notifications = require('./notification.service');
const { getIo, rooms } = require('../config/socket');
const { ROLES } = require('../constants/userRoles');
const { RIDE_STATUS } = require('../constants/rideStatus');
const { CONVERSATION_STATUS, MESSAGE_TYPE, SENDABLE_TYPES, CHAT_EVENTS } = require('../constants/chat');

/**
 * Chat between the customer and the rider on one ride.
 *
 * Authorisation is the whole job here. Everything goes through `participantOf`,
 * which resolves the caller against the conversation stored on the server and
 * returns which side they are — or refuses. No function in this file takes a
 * customerId or riderId from a caller, so a client cannot post into a ride it
 * has nothing to do with by supplying someone else's id.
 *
 * Kept separate from the complaint conversation on purpose: a support thread
 * outlives the ride and involves an admin, and mixing the two would mean one
 * authorisation rule trying to cover two different sets of participants.
 */

const chatRoom = (rideId) => `${rooms.ride(rideId)}:chat`;

/**
 * Whether a ride is one people can be talking about at all: there is nobody to
 * talk to before a rider accepts, and nothing to say once it is cancelled.
 */
const rideAllowsChat = (ride) =>
  ride.status !== RIDE_STATUS.SEARCHING && ride.status !== RIDE_STATUS.CANCELLED;

function emit(rideId, event, payload) {
  const io = getIo();
  if (io) io.to(chatRoom(rideId)).emit(event, payload);
}

const serialiseMessage = (message) => ({
  id: message._id,
  conversationId: message.conversationId,
  rideId: message.rideId,
  senderId: message.senderId,
  senderRole: message.senderRole,
  message: message.message,
  messageType: message.messageType,
  readAt: message.readAt,
  createdAt: message.createdAt
});

const serialiseConversation = (conversation, side) => ({
  id: conversation._id,
  rideId: conversation.rideId,
  status: conversation.status,
  canSend: conversation.status !== CONVERSATION_STATUS.CLOSED,
  closesAt: conversation.closesAt,
  lastMessageAt: conversation.lastMessageAt,
  lastMessagePreview: conversation.lastMessagePreview,
  messageCount: conversation.messageCount,
  unread: side ? conversation.unread[side] : conversation.unread
});

/**
 * Opened when a rider accepts. Called from the ride service inside the accept
 * flow, and deliberately forgiving: a chat that fails to open must not undo an
 * accepted ride, so the caller logs and carries on.
 */
async function openForRide(ride) {
  if (!settings.get('chat.rideChatEnabled')) return null;
  if (!ride.riderId) return null;

  const existing = await ChatConversation.findOne({ rideId: ride._id });
  if (existing) return existing;

  const rider = await Rider.findById(ride.riderId).select('userId');
  if (!rider) return null;

  const conversation = await ChatConversation.create({
    rideId: ride._id,
    customerId: ride.customerId,
    riderId: ride.riderId,
    riderUserId: rider.userId,
    status: CONVERSATION_STATUS.OPEN
  });

  await ChatMessage.create({
    conversationId: conversation._id,
    rideId: ride._id,
    senderRole: 'system',
    messageType: MESSAGE_TYPE.SYSTEM,
    message: 'You can message each other until shortly after the trip ends.'
  });

  return conversation;
}

/**
 * Called when the ride reaches a terminal state. The chat does not slam shut at
 * drop-off — a customer who has just left something in the car needs a minute —
 * so it moves to CLOSING and the configured window decides when it is read-only.
 */
async function closeForRide(ride) {
  const conversation = await ChatConversation.findOne({ rideId: ride._id });
  if (!conversation || conversation.status === CONVERSATION_STATUS.CLOSED) return null;

  // The grace period after a trip is for sorting out what happened on it — a
  // forgotten bag, a wrong drop-off. A cancelled ride has none of that to sort
  // out, so its conversation closes there and then rather than staying open for
  // an argument about the cancellation.
  const graceMinutes = rideAllowsChat(ride) ? settings.get('chat.openAfterCompletionMinutes') : 0;

  if (graceMinutes <= 0) {
    conversation.status = CONVERSATION_STATUS.CLOSED;
    conversation.closesAt = new Date();
  } else {
    conversation.status = CONVERSATION_STATUS.CLOSING;
    conversation.closesAt = new Date(Date.now() + graceMinutes * 60_000);
  }
  await conversation.save();

  emit(ride._id, CHAT_EVENTS.CLOSED, {
    rideId: ride._id,
    status: conversation.status,
    closesAt: conversation.closesAt
  });

  return conversation;
}

/**
 * Settles whether the window has passed. Checked on read and on send rather than
 * swept by a job, so a restarted process cannot leave a chat open indefinitely.
 */
async function applyExpiry(conversation) {
  if (conversation.status !== CONVERSATION_STATUS.CLOSING) return conversation;
  if (!conversation.closesAt || conversation.closesAt.getTime() > Date.now()) return conversation;

  conversation.status = CONVERSATION_STATUS.CLOSED;
  await conversation.save();
  return conversation;
}

/**
 * Which side of this conversation the caller is, or a refusal.
 *
 * The one place membership is decided. `user` is the authenticated user from the
 * request or socket; nothing here reads an id from client input.
 */
function sideOf(conversation, user) {
  if (String(conversation.customerId) === String(user._id)) return 'customer';
  if (String(conversation.riderUserId) === String(user._id)) return 'rider';
  return null;
}

async function participantOf(rideId, user) {
  const conversation = await ChatConversation.findOne({ rideId });
  if (!conversation) throw ApiError.notFound('This ride has no chat');

  const side = sideOf(conversation, user);
  if (!side) throw ApiError.forbidden('You are not part of this conversation');

  await applyExpiry(conversation);
  return { conversation, side };
}

/** The chat for a ride, as the caller sees it. Creates nothing. */
async function getForRide(rideId, user) {
  const { conversation, side } = await participantOf(rideId, user);
  return serialiseConversation(conversation, side);
}

/**
 * Message history, newest page first but returned oldest-first so the client can
 * render straight down. `before` pages backwards through a long thread.
 */
async function listMessages(rideId, user, { limit = 30, before } = {}) {
  const { conversation, side } = await participantOf(rideId, user);

  const filter = { conversationId: conversation._id };
  if (before) filter.createdAt = { $lt: before };

  const page = await ChatMessage.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean();

  return {
    conversation: serialiseConversation(conversation, side),
    messages: page.reverse().map(serialiseMessage),
    hasMore: page.length === Math.min(limit, 100)
  };
}

/**
 * Stores a message and pushes it to the other side.
 *
 * The sender, the conversation and the ride state are all resolved server-side.
 * The caller supplies text and nothing else that matters.
 */
async function sendMessage(rideId, user, { message, messageType = MESSAGE_TYPE.TEXT }) {
  if (!settings.get('chat.rideChatEnabled')) {
    throw ApiError.forbidden('Chat is currently disabled');
  }

  const { conversation, side } = await participantOf(rideId, user);

  if (conversation.status === CONVERSATION_STATUS.CLOSED) {
    throw ApiError.conflict('This conversation is closed');
  }

  if (!SENDABLE_TYPES.includes(messageType)) {
    throw ApiError.badRequest(`${messageType} messages are not supported yet`);
  }

  const text = String(message || '').trim();
  if (!text) throw ApiError.badRequest('Message cannot be empty');

  const maxLength = settings.get('chat.maxMessageLength');
  if (text.length > maxLength) {
    throw ApiError.badRequest(`Message cannot be longer than ${maxLength} characters`);
  }

  const stored = await ChatMessage.create({
    conversationId: conversation._id,
    rideId: conversation.rideId,
    senderId: user._id,
    senderRole: side === 'customer' ? ROLES.CUSTOMER : ROLES.RIDER,
    message: text,
    messageType
  });

  const recipient = side === 'customer' ? 'rider' : 'customer';

  await ChatConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessageAt: stored.createdAt,
        lastMessagePreview: text.slice(0, 120)
      },
      $inc: { messageCount: 1, [`unread.${recipient}`]: 1 }
    }
  );

  const payload = serialiseMessage(stored);
  emit(conversation.rideId, CHAT_EVENTS.NEW, payload);

  // The other party may have the app open but not the chat screen, so the badge
  // is pushed to their personal room as well as the conversation room.
  if (recipient === 'customer') {
    notifications.toCustomer(conversation.customerId, CHAT_EVENTS.NEW, payload);
  } else {
    notifications.toRider(conversation.riderId, CHAT_EVENTS.NEW, payload);
  }

  return payload;
}

/** Clears the caller's own unread count. A side can only mark its own side read. */
async function markRead(rideId, user) {
  const { conversation, side } = await participantOf(rideId, user);

  const otherRole = side === 'customer' ? ROLES.RIDER : ROLES.CUSTOMER;

  await Promise.all([
    ChatConversation.updateOne({ _id: conversation._id }, { $set: { [`unread.${side}`]: 0 } }),
    ChatMessage.updateMany(
      { conversationId: conversation._id, senderRole: otherRole, readAt: null },
      { $set: { readAt: new Date() } }
    )
  ]);

  emit(conversation.rideId, CHAT_EVENTS.READ, { rideId, readBy: side, at: new Date() });

  return { unread: 0 };
}

/**
 * Badge for the tab bar: unread across every conversation the caller is in.
 *
 * Which side to count is resolved from the authenticated user rather than taken
 * as an argument, so no caller can ask for someone else's total.
 */
async function unreadTotal(user) {
  const isRider = user.role === ROLES.RIDER;

  const match = isRider ? { riderUserId: user._id } : { customerId: user._id };
  const field = isRider ? '$unread.rider' : '$unread.customer';

  const [row] = await ChatConversation.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: field } } }
  ]);

  return { unread: row?.total || 0 };
}

/**
 * Whether the caller may join the socket room. Separate from `participantOf` so
 * the socket handler can answer without throwing an HTTP error.
 */
async function authoriseJoin(rideId, user) {
  const conversation = await ChatConversation.findOne({ rideId });
  if (!conversation) return { ok: false, reason: 'This ride has no chat' };

  const side = sideOf(conversation, user);
  if (!side) return { ok: false, reason: 'You are not part of this conversation' };

  await applyExpiry(conversation);

  return { ok: true, side, conversation, room: chatRoom(rideId) };
}

/**
 * Support view. Reading a customer's conversation is a real intrusion, so this
 * is only reachable with the chat.read permission and the caller is expected to
 * have written an audit entry — see the admin chat controller.
 */
async function adminViewConversation(rideId, { limit = 200 } = {}) {
  const conversation = await ChatConversation.findOne({ rideId }).lean();
  if (!conversation) throw ApiError.notFound('This ride has no chat');

  const messages = await ChatMessage.find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(Math.min(limit, 500))
    .lean();

  return {
    conversation: { ...serialiseConversation(conversation, null), unread: conversation.unread },
    messages: messages.map(serialiseMessage)
  };
}

/** Closes the chats of rides that ended while the process was down. */
async function sweepClosings() {
  const stale = await ChatConversation.find({
    status: CONVERSATION_STATUS.CLOSING,
    closesAt: { $lte: new Date() }
  }).select('_id rideId');

  if (!stale.length) return 0;

  await ChatConversation.updateMany(
    { _id: { $in: stale.map((c) => c._id) } },
    { $set: { status: CONVERSATION_STATUS.CLOSED } }
  );

  stale.forEach((c) => emit(c.rideId, CHAT_EVENTS.CLOSED, { rideId: c.rideId, status: CONVERSATION_STATUS.CLOSED }));
  logger.info(`Closed ${stale.length} chat conversation(s) past their window`);

  return stale.length;
}

/** True when a ride is in a state where a chat should exist. */
module.exports = {
  openForRide,
  closeForRide,
  getForRide,
  listMessages,
  sendMessage,
  markRead,
  unreadTotal,
  authoriseJoin,
  adminViewConversation,
  sweepClosings,
  rideAllowsChat,
  chatRoom,
  serialiseMessage,
  // Exported for the authorisation tests: this is the single membership
  // decision, so it is the one function worth testing in isolation.
  sideOf
};
