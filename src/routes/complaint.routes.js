const express = require('express');
const { z } = require('zod');
const complaintController = require('../controllers/complaint.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { objectId } = require('../validators/common.validator');
const { COMPLAINT_STATUS, COMPLAINT_PRIORITY } = require('../constants/complaint');

const router = express.Router();

router.use(authenticate);

const createSchema = z.object({
  rideId: objectId.optional(),
  // Validated against the admin-configured list in the service; the shape check
  // here only keeps junk from reaching it.
  category: z.string().trim().min(2).max(40).toUpperCase(),
  subject: z.string().trim().min(4, 'Give it a short subject').max(140),
  description: z.string().trim().min(10, 'Tell us what happened').max(4000),
  priority: z.enum(Object.values(COMPLAINT_PRIORITY)).optional()
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(Object.values(COMPLAINT_STATUS)).optional()
});

const replySchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty').max(4000)
});

const complaintParams = validate({ params: z.object({ complaintId: objectId }) });

router.get('/categories', complaintController.categories);
router.get('/unread', complaintController.unread);

router.post('/', validate({ body: createSchema }), complaintController.create);
router.get('/', validate({ query: listSchema }), complaintController.list);
router.get('/:complaintId', complaintParams, complaintController.detail);
router.post('/:complaintId/messages', complaintParams, validate({ body: replySchema }), complaintController.reply);

module.exports = router;
