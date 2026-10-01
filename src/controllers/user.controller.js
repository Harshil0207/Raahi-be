const userService = require('../services/user.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const getMe = asyncHandler(async (req, res) => ok(res, req.user.toPublic()));

const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile(req.user._id, req.body);
  return ok(res, user, 'Profile updated');
});

module.exports = { getMe, updateMe };
