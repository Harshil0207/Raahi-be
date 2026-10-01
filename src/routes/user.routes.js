const express = require('express');
const { z } = require('zod');
const userController = require('../controllers/user.controller');
const userSettingsRoutes = require('./userSettings.routes');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');

const router = express.Router();

const updateSchema = z
  .object({
    name: z.string().trim().min(2).optional(),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/).optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Nothing to update' });

router.use(authenticate);

router.get('/me', userController.getMe);
router.patch('/me', validate({ body: updateSchema }), userController.updateMe);

// The person's own preferences. Here rather than at the top level because
// `/settings` already means the platform's public configuration.
router.use('/me/settings', userSettingsRoutes);

module.exports = router;
