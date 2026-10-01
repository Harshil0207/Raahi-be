const chatService = require('../services/chat.service');
const logger = require('../utils/logger');
const { CHAT_EVENTS } = require('../constants/chat');

/**
 * Chat over the socket.
 *
 * Every handler re-authorises against the stored conversation. The socket is
 * already authenticated, but being a signed-in user says nothing about whether
 * this is your ride — so `authoriseJoin` runs on join, and the send path goes
 * through the service, which checks membership again rather than trusting that
 * the client is in the room it says it is.
 *
 * Typing is the one thing that is not stored. It is a transient hint about the
 * next second, worth nothing a moment later, and writing a row per keystroke
 * would be the heaviest write in the app for the least value.
 */
function registerChatHandlers(io, socket) {
  const { user } = socket;

  socket.on(CHAT_EVENTS.JOIN, async ({ rideId } = {}, ack) => {
    try {
      if (!rideId) return ack?.({ success: false, message: 'rideId is required' });

      const result = await chatService.authoriseJoin(rideId, user);
      if (!result.ok) return ack?.({ success: false, message: result.reason });

      socket.join(result.room);

      return ack?.({
        success: true,
        data: {
          rideId,
          side: result.side,
          status: result.conversation.status,
          canSend: result.conversation.status !== 'CLOSED'
        }
      });
    } catch (err) {
      logger.error(`chat:join failed for ${user._id}: ${err.message}`);
      return ack?.({ success: false, message: 'Could not join the conversation' });
    }
  });

  socket.on(CHAT_EVENTS.LEAVE, ({ rideId } = {}, ack) => {
    if (rideId) socket.leave(chatService.chatRoom(rideId));
    ack?.({ success: true });
  });

  socket.on(CHAT_EVENTS.SEND, async ({ rideId, message, messageType } = {}, ack) => {
    try {
      if (!rideId) return ack?.({ success: false, message: 'rideId is required' });

      const stored = await chatService.sendMessage(rideId, user, { message, messageType });
      return ack?.({ success: true, data: stored });
    } catch (err) {
      // An expected ApiError carries a message worth showing; anything else does not.
      const message = err.expected ? err.message : 'Could not send the message';
      if (!err.expected) logger.error(`chat:message failed for ${user._id}: ${err.message}`);
      return ack?.({ success: false, message });
    }
  });

  socket.on(CHAT_EVENTS.TYPING, async ({ rideId, typing = true } = {}) => {
    if (!rideId) return;

    // Authorised, but never persisted.
    const result = await chatService.authoriseJoin(rideId, user).catch(() => ({ ok: false }));
    if (!result.ok) return;

    socket.to(result.room).emit(CHAT_EVENTS.TYPING, { rideId, side: result.side, typing: Boolean(typing) });
  });

  socket.on(CHAT_EVENTS.READ, async ({ rideId } = {}, ack) => {
    try {
      if (!rideId) return ack?.({ success: false, message: 'rideId is required' });
      const result = await chatService.markRead(rideId, user);
      return ack?.({ success: true, data: result });
    } catch (err) {
      return ack?.({ success: false, message: err.expected ? err.message : 'Could not mark as read' });
    }
  });
}

module.exports = registerChatHandlers;
