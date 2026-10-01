const Notification = require('../models/Notification');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const notifications = require('./notification.service');
const userSettings = require('./userSettings.service');
const { SOCKET_EVENTS } = require('../constants/socketEvents');

const { NOTIFICATION_TYPE } = Notification;

/**
 * The stored notification feed, as opposed to notification.service, which does
 * the transient socket push. Records are written as ride events actually happen,
 * so the feed is a history of real events rather than a rendering of the ride
 * list — which is what makes unread state meaningful.
 *
 * Writing a notification must never break the ride flow it describes, so
 * failures are logged and swallowed.
 */
async function record(userId, type, title, body, rideId = null) {
  if (!userId) return null;

  try {
    /**
     * The person's own preference, checked before anything is written.
     *
     * Before the record, not just before the socket push: a notification that
     * was switched off should not be sitting in the feed to be found later
     * either. Security and account types have no switch at all, so they are
     * never filtered here — see MANDATORY_NOTIFICATIONS in the registry.
     */
    if (!(await userSettings.wantsNotification(userId, type))) return null;

    const entry = await Notification.create({ userId, type, title, body, rideId });

    // Push so an open app updates its badge without polling. Addressed to the
    // person, not to their customer room, so riders receive theirs too.
    notifications.toUser(userId, SOCKET_EVENTS.NOTIFICATION_NEW, entry.toPublic());
    return entry;
  } catch (err) {
    logger.warn('Could not record notification:', err.message);
    return null;
  }
}

async function list(userId, { limit = 30, before } = {}) {
  const filter = { userId };
  if (before) filter.createdAt = { $lt: new Date(before) };

  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 30, 100)),
    Notification.countDocuments({ userId, readAt: null })
  ]);

  return { notifications: items.map((n) => n.toPublic()), unread };
}

async function markRead(userId, id) {
  const entry = await Notification.findOneAndUpdate(
    { _id: id, userId, readAt: null },
    { readAt: new Date() },
    { new: true }
  );
  if (!entry) throw ApiError.notFound('Notification not found');
  return entry.toPublic();
}

async function markAllRead(userId) {
  const result = await Notification.updateMany({ userId, readAt: null }, { readAt: new Date() });
  return { updated: result.modifiedCount };
}

/**
 * The whole feed, for the admin notifications screen — what the platform has
 * been telling people, so support can see what a customer already knows.
 */
async function listForAdmin({ page = 1, limit = 30, type, userId, from, to } = {}) {
  const filter = {};
  if (type) filter.type = type;
  if (userId) filter.userId = userId;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const [items, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', 'name email role')
      .lean(),
    Notification.countDocuments(filter)
  ]);

  return {
    notifications: items.map((item) => ({
      id: item._id,
      type: item.type,
      title: item.title,
      body: item.body,
      rideId: item.rideId,
      read: Boolean(item.readAt),
      recipient: item.userId,
      createdAt: item.createdAt
    })),
    total,
    page,
    limit
  };
}

module.exports = { record, list, listForAdmin, markRead, markAllRead, NOTIFICATION_TYPE };
