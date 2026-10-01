const express = require('express');
const settings = require('../services/settings.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const router = express.Router();

/**
 * The slice of configuration the customer and rider apps need, unauthenticated
 * because the login screen has to know whether the platform is in maintenance
 * before anyone can sign in.
 *
 * Only the values in `publicSettings` are exposed. Commission rates, SLA targets
 * and matching parameters are none of a rider's business and stay on the admin API.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, await settings.publicSettings()))
);

module.exports = router;
