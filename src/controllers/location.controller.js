const locationService = require('../services/location.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const save = asyncHandler(async (req, res) => {
  const location = await locationService.saveDeviceLocation(req.user._id, req.body);
  return ok(res, location, 'Location saved');
});

const current = asyncHandler(async (req, res) => {
  const location = await locationService.getCurrentLocation(req.user._id);
  return ok(res, location);
});

module.exports = { save, current };
