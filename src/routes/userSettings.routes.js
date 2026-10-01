const express = require('express');
const userSettingsController = require('../controllers/userSettings.controller');

/**
 * A person's own preferences.
 *
 * Mounted under `/users/me/settings`, NOT at `/settings` — that path is already
 * the platform's public configuration (maintenance mode, the service catalogue,
 * support contacts) and is deliberately unauthenticated so the login screen can
 * read it. Two different things called settings is confusing enough without
 * them sharing a URL.
 *
 * The parent router authenticates, so every handler below has a verified
 * `req.user`. The role on that user is what decides which groups exist; there
 * is no separate customer and rider API, and no role check to forget, because
 * the registry resolves the groups from the role on each call.
 */
const router = express.Router();

router.get('/', userSettingsController.get);
router.patch('/:group', userSettingsController.updateGroup);

module.exports = router;
