const express = require('express');
const { z } = require('zod');
const assistantController = require('../controllers/assistant.controller');
const { validate } = require('../middleware/validate.middleware');
const { assistantLimiter } = require('../middleware/rateLimit.middleware');
const { objectId } = require('../validators/common.validator');
const { LIMITS } = require('../constants/assistant');

/**
 * The AI assistant.
 *
 * Deliberately NOT mounted at `/chats`: that is the customer-to-rider
 * conversation on a live ride, and the two have nothing in common beyond the
 * word. Keeping them apart means the ride chat's permissions, socket rooms and
 * retention rules stay about rides.
 *
 * This router carries no authentication of its own. It is mounted twice — once
 * under the customer/rider `authenticate`, once under the admin
 * `authenticateAdmin` — so each mount brings the right identity with it and the
 * handlers do not have to choose. See `routes/index.js` and `routes/admin`.
 *
 * Note what is absent: there is no route that reads somebody else's
 * conversation, for an admin or anyone. A private exchange with a support
 * assistant is not operations data, and an endpoint that existed "just for
 * support" would be the one that leaked it.
 */
const router = express.Router();

const conversationParams = validate({ params: z.object({ conversationId: objectId }) });

const askSchema = z.object({
  // The real limit lives in the service, which is what both the streaming and
  // the non-streaming path go through. This only stops an absurd payload from
  // reaching it.
  message: z.string().trim().min(1, 'Message cannot be empty').max(LIMITS.MAX_MESSAGE_LENGTH),
  conversationId: objectId.optional().nullable()
});

/**
 * Deliberately not in the schema: `role`, `userId`, `name`, `systemInstruction`
 * or anything resembling them. Zod strips unknown keys, so a client sending
 * `{"message": "...", "role": "ADMIN"}` has that key dropped here, and the
 * controller would not read it either way.
 */

router.get('/status', assistantController.status);

router.post('/messages', assistantLimiter, validate({ body: askSchema }), assistantController.sendMessage);
router.post('/messages/stream', assistantLimiter, validate({ body: askSchema }), assistantController.streamMessage);

router.get('/conversations', assistantController.listConversations);
router.get('/conversations/:conversationId', conversationParams, assistantController.getConversation);
router.delete('/conversations/:conversationId', conversationParams, assistantController.deleteConversation);

module.exports = router;
