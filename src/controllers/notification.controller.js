const notificationFeed = require('../services/notification.feed');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const list = asyncHandler(async (req, res) => {
  const result = await notificationFeed.list(req.user._id, req.query);
  return ok(res, result);
});

const markRead = asyncHandler(async (req, res) => {
  const notification = await notificationFeed.markRead(req.user._id, req.params.notificationId);
  return ok(res, notification, 'Marked as read');
});

const markAllRead = asyncHandler(async (req, res) => {
  const result = await notificationFeed.markAllRead(req.user._id);
  return ok(res, result, 'All notifications marked as read');
});

module.exports = { list, markRead, markAllRead };
