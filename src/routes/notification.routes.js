const express = require('express');
const { z } = require('zod');
const notificationController = require('../controllers/notification.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { objectId } = require('../validators/common.validator');

const router = express.Router();

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.coerce.date().optional()
});

router.use(authenticate);

router.get('/', validate({ query: listSchema }), notificationController.list);
router.post('/read-all', notificationController.markAllRead);
router.post(
  '/:notificationId/read',
  validate({ params: z.object({ notificationId: objectId }) }),
  notificationController.markRead
);

module.exports = router;
