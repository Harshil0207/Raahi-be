const express = require('express');
const { z } = require('zod');
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { objectId } = require('../validators/common.validator');
const { MESSAGE_TYPE } = require('../constants/chat');

const router = express.Router();

router.use(authenticate);

const rideParams = validate({ params: z.object({ rideId: objectId }) });

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.coerce.date().optional()
});

const sendSchema = z.object({
  // The length ceiling is a setting, so the real check lives in the service;
  // this only keeps an absurd payload from reaching it.
  message: z.string().trim().min(1, 'Message cannot be empty').max(4000),
  messageType: z.enum(Object.values(MESSAGE_TYPE)).default(MESSAGE_TYPE.TEXT)
});

// Unread across every conversation, for the tab-bar badge.
router.get('/unread', chatController.unreadTotal);

router.get('/:rideId', rideParams, chatController.getConversation);
router.get('/:rideId/messages', rideParams, validate({ query: listSchema }), chatController.listMessages);
router.post('/:rideId/messages', rideParams, validate({ body: sendSchema }), chatController.sendMessage);
router.post('/:rideId/read', rideParams, chatController.markRead);

module.exports = router;
