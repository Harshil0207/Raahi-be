const chatService = require('../services/chat.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

/**
 * REST alongside the socket. History and unread counts are ordinary reads that
 * the socket has no business carrying, and `send` is here so a message still
 * goes through when the socket is down — the app is on a phone, and a dropped
 * connection should cost the user a retry, not the message.
 */

const getConversation = asyncHandler(async (req, res) => {
  const conversation = await chatService.getForRide(req.params.rideId, req.user);
  return ok(res, conversation);
});

const listMessages = asyncHandler(async (req, res) => {
  const result = await chatService.listMessages(req.params.rideId, req.user, {
    limit: req.query.limit,
    before: req.query.before
  });
  return ok(res, result);
});

const sendMessage = asyncHandler(async (req, res) => {
  const message = await chatService.sendMessage(req.params.rideId, req.user, req.body);
  return ok(res, message, 'Message sent', 201);
});

const markRead = asyncHandler(async (req, res) => {
  const result = await chatService.markRead(req.params.rideId, req.user);
  return ok(res, result, 'Marked as read');
});

const unreadTotal = asyncHandler(async (req, res) => {
  const result = await chatService.unreadTotal(req.user);
  return ok(res, result);
});

module.exports = { getConversation, listMessages, sendMessage, markRead, unreadTotal };
