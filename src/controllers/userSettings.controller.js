const userSettings = require('../services/userSettings.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

/**
 * The authenticated user, always. There is no path here that reads a user id
 * from the request body or the query — `req.user` is set by the auth
 * middleware from a verified token, and it is the only identity these handlers
 * can see.
 */
const get = asyncHandler(async (req, res) => ok(res, await userSettings.describeFor(req.user)));

const updateGroup = asyncHandler(async (req, res) => {
  const settings = await userSettings.updateGroup(req.user, req.params.group, req.body);
  return ok(res, settings, 'Saved');
});

module.exports = { get, updateGroup };
