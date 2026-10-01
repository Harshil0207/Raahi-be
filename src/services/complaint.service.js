const crypto = require('crypto');
const Complaint = require('../models/Complaint');
const ComplaintMessage = require('../models/ComplaintMessage');
const Ride = require('../models/Ride');
const Rider = require('../models/Rider');
const Admin = require('../models/Admin');
const ApiError = require('../utils/ApiError');
const settings = require('./settings.service');
const feed = require('./notification.feed');
const notifications = require('./notification.service');
const { ROLES } = require('../constants/userRoles');
const {
  COMPLAINT_STATUS,
  COMPLAINT_PRIORITY,
  OPEN_STATUSES,
  canTransition,
  SLA_SETTING
} = require('../constants/complaint');

/**
 * Complaints, from both sides of a ride, and the support thread on each.
 *
 * The reporter's view and the admin's view are different enough to be separate
 * functions rather than one function with a role flag: a reporter sees their own
 * complaints and the replies, an admin sees a queue and the internal notes. The
 * one thing they share is `loadForReporter`, which is where ownership is checked.
 */

const REFERENCE_PREFIX = 'HB';

function newReference() {
  // Short, unambiguous, and not sequential — a guessable reference invites
  // people to try their luck at reading someone else's complaint.
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  const stamp = Date.now().toString(36).toUpperCase().slice(-4);
  return `${REFERENCE_PREFIX}-${stamp}${random}`;
}

function dueDateFor(priority) {
  const hours = settings.get(SLA_SETTING[priority] || SLA_SETTING[COMPLAINT_PRIORITY.MEDIUM]);
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

const categoriesFor = (role) =>
  role === ROLES.RIDER
    ? settings.get('support.riderComplaintCategories')
    : settings.get('support.customerComplaintCategories');

const serialiseForReporter = (complaint) => ({
  id: complaint._id,
  reference: complaint.reference,
  rideId: complaint.rideId,
  category: complaint.category,
  subject: complaint.subject,
  description: complaint.description,
  priority: complaint.priority,
  status: complaint.status,
  resolution: complaint.resolution,
  unread: complaint.unread?.reporter ?? 0,
  lastMessageAt: complaint.lastMessageAt,
  createdAt: complaint.createdAt,
  updatedAt: complaint.updatedAt,
  resolvedAt: complaint.resolvedAt,
  // Whether support is handling it, without naming the individual: which agent
  // has the ticket is internal, that someone has it is reassuring.
  isAssigned: Boolean(complaint.assignedAdmin)
});

const serialiseForAdmin = (complaint) => ({
  id: complaint._id,
  reference: complaint.reference,
  createdBy: complaint.createdBy,
  userRole: complaint.userRole,
  rideId: complaint.rideId,
  category: complaint.category,
  subject: complaint.subject,
  description: complaint.description,
  priority: complaint.priority,
  status: complaint.status,
  assignedAdmin: complaint.assignedAdmin,
  adminNotes: complaint.adminNotes,
  resolution: complaint.resolution,
  dueAt: complaint.dueAt,
  isOverdue: Boolean(
    complaint.dueAt && OPEN_STATUSES.includes(complaint.status) && complaint.dueAt.getTime() < Date.now()
  ),
  unread: complaint.unread,
  lastMessageAt: complaint.lastMessageAt,
  createdAt: complaint.createdAt,
  updatedAt: complaint.updatedAt,
  resolvedAt: complaint.resolvedAt,
  closedAt: complaint.closedAt
});

const serialiseMessage = (message) => ({
  id: message._id,
  complaintId: message.complaintId,
  senderRole: message.senderRole,
  senderName: message.senderName,
  message: message.message,
  readAt: message.readAt,
  createdAt: message.createdAt
});

// ------------------------------------------------------------------- reporting

/**
 * Files a complaint.
 *
 * If a ride is referenced it must be one the reporter was actually on — this is
 * the only place that link is established, and it is checked against the ride
 * rather than accepted from the payload.
 */
async function create(user, { rideId, category, subject, description, priority }) {
  const allowed = categoriesFor(user.role);
  if (!allowed.includes(category)) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'category', message: `Not an available category. Choose one of: ${allowed.join(', ')}` }
    ]);
  }

  if (rideId) {
    const ride = await Ride.findById(rideId).select('customerId riderId');
    if (!ride) throw ApiError.notFound('Ride not found');

    if (user.role === ROLES.RIDER) {
      const rider = await Rider.findOne({ userId: user._id }).select('_id');
      if (!rider || String(ride.riderId) !== String(rider._id)) {
        throw ApiError.forbidden('That ride is not one of yours');
      }
    } else if (String(ride.customerId) !== String(user._id)) {
      throw ApiError.forbidden('That ride is not one of yours');
    }
  }

  // Some categories are too serious to be filed as low priority by someone who
  // is upset and picking from a dropdown.
  const forcedUrgent = settings.get('support.autoUrgentCategories').includes(category);
  const finalPriority = forcedUrgent ? COMPLAINT_PRIORITY.URGENT : priority || COMPLAINT_PRIORITY.MEDIUM;

  const complaint = await Complaint.create({
    reference: newReference(),
    createdBy: user._id,
    userRole: user.role,
    rideId: rideId || null,
    category,
    subject,
    description,
    priority: finalPriority,
    dueAt: dueDateFor(finalPriority),
    unread: { admin: 1, reporter: 0 }
  });

  await ComplaintMessage.create({
    complaintId: complaint._id,
    senderId: user._id,
    senderRole: user.role,
    senderName: user.name,
    message: description
  });

  feed.record(
    user._id,
    feed.NOTIFICATION_TYPE.SUPPORT,
    'Complaint received',
    `We have your report ${complaint.reference} and will come back to you.`,
    rideId || null
  );

  return serialiseForReporter(complaint);
}

async function listForReporter(user, { page = 1, limit = 20, status } = {}) {
  const filter = { createdBy: user._id };
  if (status) filter.status = status;

  const [complaints, total] = await Promise.all([
    Complaint.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Complaint.countDocuments(filter)
  ]);

  return { complaints: complaints.map(serialiseForReporter), total, page, limit };
}

async function loadForReporter(complaintId, user) {
  const complaint = await Complaint.findById(complaintId);
  if (!complaint) throw ApiError.notFound('Complaint not found');
  if (String(complaint.createdBy) !== String(user._id)) {
    throw ApiError.forbidden('This complaint is not yours');
  }
  return complaint;
}

async function detailForReporter(complaintId, user) {
  const complaint = await loadForReporter(complaintId, user);

  const messages = await ComplaintMessage.find({ complaintId: complaint._id }).sort({ createdAt: 1 }).lean();

  // Opening the thread is what marks it read; there is nothing else to mark.
  if (complaint.unread.reporter > 0) {
    await Complaint.updateOne({ _id: complaint._id }, { $set: { 'unread.reporter': 0 } });
    await ComplaintMessage.updateMany(
      { complaintId: complaint._id, senderRole: 'admin', readAt: null },
      { $set: { readAt: new Date() } }
    );
    complaint.unread.reporter = 0;
  }

  return {
    complaint: serialiseForReporter(complaint),
    messages: messages.map(serialiseMessage)
  };
}

/** A reply from the reporter. Brings a waiting complaint back into the queue. */
async function replyAsReporter(complaintId, user, message) {
  const complaint = await loadForReporter(complaintId, user);

  if (complaint.status === COMPLAINT_STATUS.CLOSED) {
    throw ApiError.conflict('This complaint is closed. Please open a new one.');
  }

  const stored = await ComplaintMessage.create({
    complaintId: complaint._id,
    senderId: user._id,
    senderRole: user.role,
    senderName: user.name,
    message
  });

  const update = {
    $set: { lastMessageAt: stored.createdAt },
    $inc: { 'unread.admin': 1 }
  };

  // A reply from the person support was waiting on puts it back in review, so it
  // does not sit in a waiting bucket that nobody is watching.
  if (
    complaint.status === COMPLAINT_STATUS.WAITING_FOR_USER ||
    complaint.status === COMPLAINT_STATUS.WAITING_FOR_RIDER ||
    complaint.status === COMPLAINT_STATUS.RESOLVED
  ) {
    update.$set.status = COMPLAINT_STATUS.IN_REVIEW;
  }

  await Complaint.updateOne({ _id: complaint._id }, update);

  return serialiseMessage(stored);
}

async function unreadForReporter(user) {
  const [row] = await Complaint.aggregate([
    { $match: { createdBy: user._id } },
    { $group: { _id: null, total: { $sum: '$unread.reporter' } } }
  ]);
  return { unread: row?.total || 0 };
}

/** Categories the app offers, so the picker is never out of step with the server. */
function availableCategories(user) {
  return { categories: categoriesFor(user.role) };
}

// ----------------------------------------------------------------- admin queue

async function listForAdmin({
  page = 1,
  limit = 25,
  status,
  priority,
  category,
  userRole,
  assignedAdmin,
  overdue,
  search,
  from,
  to
} = {}) {
  const filter = {};

  if (status === 'OPEN_ANY') filter.status = { $in: OPEN_STATUSES };
  else if (status) filter.status = status;

  if (priority) filter.priority = priority;
  if (category) filter.category = category;
  if (userRole) filter.userRole = userRole;
  if (assignedAdmin === 'UNASSIGNED') filter.assignedAdmin = null;
  else if (assignedAdmin) filter.assignedAdmin = assignedAdmin;

  if (overdue) {
    filter.dueAt = { $lt: new Date() };
    filter.status = filter.status || { $in: OPEN_STATUSES };
  }

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  if (search) {
    const term = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ reference: term }, { subject: term }];
  }

  const [complaints, total] = await Promise.all([
    Complaint.find(filter)
      .sort({ priority: -1, createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('createdBy', 'name email phone role')
      .populate('assignedAdmin', 'name email role'),
    Complaint.countDocuments(filter)
  ]);

  return {
    complaints: complaints.map((complaint) => ({
      ...serialiseForAdmin(complaint),
      reporter: complaint.createdBy,
      assignedTo: complaint.assignedAdmin
    })),
    total,
    page,
    limit
  };
}

/** Counts for the triage tabs, in one pass rather than one query per tab. */
async function adminCounts(adminId) {
  const [byStatus, mine, overdue] = await Promise.all([
    Complaint.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Complaint.countDocuments({ assignedAdmin: adminId, status: { $in: OPEN_STATUSES } }),
    Complaint.countDocuments({ status: { $in: OPEN_STATUSES }, dueAt: { $lt: new Date() } })
  ]);

  const counts = byStatus.reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});

  return {
    ...counts,
    OPEN_ANY: OPEN_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0),
    URGENT: await Complaint.countDocuments({ priority: COMPLAINT_PRIORITY.URGENT, status: { $in: OPEN_STATUSES } }),
    ASSIGNED_TO_ME: mine,
    OVERDUE: overdue
  };
}

async function detailForAdmin(complaintId) {
  const complaint = await Complaint.findById(complaintId)
    .populate('createdBy', 'name email phone role isActive createdAt')
    .populate('assignedAdmin', 'name email role');
  if (!complaint) throw ApiError.notFound('Complaint not found');

  const [messages, ride] = await Promise.all([
    ComplaintMessage.find({ complaintId: complaint._id }).sort({ createdAt: 1 }).lean(),
    complaint.rideId
      ? Ride.findById(complaint.rideId).select(
          'status pickup.address destination.address finalFare estimatedFare currency payment createdAt completedAt riderId'
        )
      : null
  ]);

  if (complaint.unread.admin > 0) {
    await Complaint.updateOne({ _id: complaint._id }, { $set: { 'unread.admin': 0 } });
    complaint.unread.admin = 0;
  }

  return {
    complaint: serialiseForAdmin(complaint),
    reporter: complaint.createdBy,
    assignedTo: complaint.assignedAdmin,
    ride,
    messages: messages.map(serialiseMessage)
  };
}

/**
 * Status, priority and assignment, in one call because support changes them
 * together. Returns the complaint and what moved, so the caller can write one
 * audit entry describing the whole action.
 */
async function updateAsAdmin(complaintId, admin, patch) {
  const complaint = await Complaint.findById(complaintId);
  if (!complaint) throw ApiError.notFound('Complaint not found');

  const before = {
    status: complaint.status,
    priority: complaint.priority,
    assignedAdmin: complaint.assignedAdmin ? String(complaint.assignedAdmin) : null
  };

  if (patch.status && patch.status !== complaint.status) {
    if (!canTransition(complaint.status, patch.status)) {
      throw ApiError.conflict(`A complaint cannot go from ${complaint.status} to ${patch.status}`);
    }
    if (patch.status === COMPLAINT_STATUS.RESOLVED && !(patch.resolution || complaint.resolution)) {
      throw ApiError.badRequest('Validation failed', [
        { field: 'resolution', message: 'Say what the resolution was before resolving' }
      ]);
    }

    complaint.status = patch.status;
    if (patch.status === COMPLAINT_STATUS.RESOLVED) complaint.resolvedAt = new Date();
    if (patch.status === COMPLAINT_STATUS.CLOSED) complaint.closedAt = new Date();
  }

  if (patch.priority && patch.priority !== complaint.priority) {
    complaint.priority = patch.priority;
    // A re-prioritised complaint gets the new priority's deadline, measured from
    // now: the point of raising it is that it needs attention sooner.
    complaint.dueAt = dueDateFor(patch.priority);
  }

  if (patch.assignedAdmin !== undefined) {
    if (patch.assignedAdmin === null) {
      complaint.assignedAdmin = null;
    } else {
      const assignee = await Admin.findById(patch.assignedAdmin).select('_id isActive');
      if (!assignee || !assignee.isActive) throw ApiError.badRequest('That admin cannot be assigned');
      complaint.assignedAdmin = assignee._id;
    }
  }

  if (patch.resolution !== undefined) complaint.resolution = patch.resolution;

  await complaint.save();

  const after = {
    status: complaint.status,
    priority: complaint.priority,
    assignedAdmin: complaint.assignedAdmin ? String(complaint.assignedAdmin) : null
  };

  // Tell the reporter when the outcome changes, not on every internal edit.
  if (before.status !== after.status) {
    if (after.status === COMPLAINT_STATUS.RESOLVED) {
      feed.record(
        complaint.createdBy,
        feed.NOTIFICATION_TYPE.SUPPORT,
        'Complaint resolved',
        `${complaint.reference}: ${complaint.resolution || 'Support has resolved your report.'}`,
        complaint.rideId
      );
    } else if (
      after.status === COMPLAINT_STATUS.WAITING_FOR_USER ||
      after.status === COMPLAINT_STATUS.WAITING_FOR_RIDER
    ) {
      feed.record(
        complaint.createdBy,
        feed.NOTIFICATION_TYPE.SUPPORT,
        'Support needs a reply',
        `${complaint.reference} is waiting on you.`,
        complaint.rideId
      );
    }
  }

  return { complaint: serialiseForAdmin(complaint), before, after };
}

/** Internal note. Never leaves the admin console. */
async function addNote(complaintId, admin, note) {
  const complaint = await Complaint.findById(complaintId);
  if (!complaint) throw ApiError.notFound('Complaint not found');

  complaint.adminNotes.push({ adminId: admin._id, adminName: admin.name, note });
  await complaint.save();

  return serialiseForAdmin(complaint);
}

/** A reply the reporter will see, as opposed to a note. */
async function replyAsAdmin(complaintId, admin, message) {
  const complaint = await Complaint.findById(complaintId);
  if (!complaint) throw ApiError.notFound('Complaint not found');

  if (complaint.status === COMPLAINT_STATUS.CLOSED) {
    throw ApiError.conflict('This complaint is closed');
  }

  const stored = await ComplaintMessage.create({
    complaintId: complaint._id,
    adminId: admin._id,
    senderRole: 'admin',
    // The agent's own name is internal; the reporter sees the platform.
    senderName: `${settings.get('system.platformName')} Support`,
    message
  });

  const update = {
    $set: { lastMessageAt: stored.createdAt },
    $inc: { 'unread.reporter': 1 }
  };

  // Replying to an untouched complaint is the moment it is being worked on.
  if (complaint.status === COMPLAINT_STATUS.OPEN) update.$set.status = COMPLAINT_STATUS.IN_REVIEW;
  if (!complaint.assignedAdmin) update.$set.assignedAdmin = admin._id;

  await Complaint.updateOne({ _id: complaint._id }, update);

  feed.record(
    complaint.createdBy,
    feed.NOTIFICATION_TYPE.SUPPORT,
    'Support replied',
    `${complaint.reference}: ${message.slice(0, 120)}`,
    complaint.rideId
  );

  notifications.toUser(complaint.createdBy, 'complaint:message', {
    complaintId: complaint._id,
    reference: complaint.reference
  });

  return serialiseMessage(stored);
}

/** Complaints attached to one ride, for the ride detail page. */
async function forRide(rideId) {
  const complaints = await Complaint.find({ rideId }).sort({ createdAt: -1 });
  return complaints.map(serialiseForAdmin);
}

/** Complaints filed by one person, for the customer and rider detail pages. */
async function forUser(userId, limit = 20) {
  const complaints = await Complaint.find({ createdBy: userId }).sort({ createdAt: -1 }).limit(limit);
  return complaints.map(serialiseForAdmin);
}

module.exports = {
  create,
  listForReporter,
  detailForReporter,
  replyAsReporter,
  unreadForReporter,
  availableCategories,
  listForAdmin,
  adminCounts,
  detailForAdmin,
  updateAsAdmin,
  addNote,
  replyAsAdmin,
  forRide,
  forUser,
  // Exported so the two views can be tested against each other: the reporter's
  // must not carry anything internal.
  serialiseForReporter,
  serialiseForAdmin,
  dueDateFor,
  newReference
};
