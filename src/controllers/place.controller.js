const placeService = require('../services/place.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/response');

const list = asyncHandler(async (req, res) => {
  const places = await placeService.list(req.user._id);
  return ok(res, { places });
});

const create = asyncHandler(async (req, res) => {
  const place = await placeService.create(req.user._id, req.body);
  return created(res, place, 'Place saved');
});

const update = asyncHandler(async (req, res) => {
  const place = await placeService.update(req.user._id, req.params.placeId, req.body);
  return ok(res, place, 'Place updated');
});

const remove = asyncHandler(async (req, res) => {
  const result = await placeService.remove(req.user._id, req.params.placeId);
  return ok(res, result, 'Place removed');
});

module.exports = { list, create, update, remove };
