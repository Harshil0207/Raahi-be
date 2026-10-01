const adminAuthService = require('../../services/admin/adminAuth.service');
const dashboardService = require('../../services/admin/dashboard.service');
const peopleService = require('../../services/admin/people.service');
const ridesService = require('../../services/admin/rides.service');
const financeService = require('../../services/admin/finance.service');
const complaintService = require('../../services/complaint.service');
const chatService = require('../../services/chat.service');
const settings = require('../../services/settings.service');
const audit = require('../../services/audit.service');
const { SERVICES, ALL_SERVICE_TYPES } = require('../../constants/services');
const feed = require('../../services/notification.feed');
const User = require('../../models/User');
const Rider = require('../../models/Rider');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { ok, created } = require('../../utils/response');
const { ADMIN_ROLES, ROLE_PERMISSIONS, ALL_PERMISSIONS } = require('../../constants/adminRoles');
const { ROLES } = require('../../constants/userRoles');

/**
 * HTTP for the admin console. Thin on purpose: request in, service call,
 * response out. The rules live in the services; the permission checks live in
 * the route definitions.
 */

// --------------------------------------------------------------------- session

const login = asyncHandler(async (req, res) => {
  const result = await adminAuthService.login(req.body);
  return ok(res, result, 'Signed in');
});

const me = asyncHandler(async (req, res) => ok(res, req.admin.toPublic()));

const changePassword = asyncHandler(async (req, res) => {
  const result = await adminAuthService.changePassword(req.admin, req.body);
  return ok(res, result, 'Password changed');
});

const updateProfile = asyncHandler(async (req, res) => {
  const admin = await adminAuthService.updateOwnProfile(req.admin, req.body);
  return ok(res, admin, 'Profile updated');
});

// ------------------------------------------------------------------- dashboard

const dashboardSummary = asyncHandler(async (req, res) => ok(res, await dashboardService.summary(req.query)));
const dashboardSeries = asyncHandler(async (req, res) => ok(res, await dashboardService.series(req.query)));
const dashboardActive = asyncHandler(async (req, res) => ok(res, await dashboardService.activeRides(req.query.limit)));
const dashboardTopRiders = asyncHandler(async (req, res) =>
  ok(res, await dashboardService.topRiders(req.query, req.query.limit))
);

// ------------------------------------------------------------------- customers

const listCustomers = asyncHandler(async (req, res) => ok(res, await peopleService.listCustomers(req.query)));
const customerDetail = asyncHandler(async (req, res) => ok(res, await peopleService.customerDetail(req.params.userId)));

// ---------------------------------------------------------------------- riders

const listRiders = asyncHandler(async (req, res) => ok(res, await peopleService.listRiders(req.query)));
const riderDetail = asyncHandler(async (req, res) => ok(res, await peopleService.riderDetail(req.params.riderId)));

const setRiderVerification = asyncHandler(async (req, res) => {
  const result = await peopleService.setRiderVerification(req, req.params.riderId, req.body);
  return ok(res, result, result.unchanged ? 'Already set' : 'Rider verification updated');
});

const forceRiderOffline = asyncHandler(async (req, res) => {
  const result = await peopleService.forceRiderOffline(req, req.params.riderId, req.body.reason);
  return ok(res, result, 'Rider taken offline');
});

// ------------------------------------------------------------------- accounts

const setBlocked = asyncHandler(async (req, res) => {
  const result = await peopleService.setBlocked(req, req.params.userId, req.body);
  return ok(res, result, req.body.blocked ? 'Account blocked' : 'Account unblocked');
});

const updateAccount = asyncHandler(async (req, res) => {
  const result = await peopleService.updateAccount(req, req.params.userId, req.body);
  return ok(res, result, 'Account updated');
});

/** Resolves a rider id from a user id, so the console can link either way. */
const resolveRider = asyncHandler(async (req, res) => {
  const rider = await Rider.findOne({ userId: req.params.userId }).select('_id');
  if (!rider) throw ApiError.notFound('No rider profile for that account');
  return ok(res, { riderId: rider._id });
});

// ----------------------------------------------------------------------- rides

const listRides = asyncHandler(async (req, res) => ok(res, await ridesService.list(req.query)));
const rideDetail = asyncHandler(async (req, res) => ok(res, await ridesService.detail(req.params.rideId)));

const cancelRide = asyncHandler(async (req, res) => {
  const result = await ridesService.cancelRide(req, req.params.rideId, req.body.reason);
  return ok(res, result, 'Ride cancelled');
});

// -------------------------------------------------------------------- payments

const listPayments = asyncHandler(async (req, res) => ok(res, await ridesService.listPayments(req.query)));
const paymentDetail = asyncHandler(async (req, res) =>
  ok(res, await ridesService.paymentDetail(req.params.paymentId))
);

const settleCash = asyncHandler(async (req, res) => {
  const result = await ridesService.settleCashPayment(req, req.params.paymentId, req.body.note);
  return ok(res, result, 'Payment marked settled');
});

// ------------------------------------------------------------------ complaints

const listComplaints = asyncHandler(async (req, res) => ok(res, await complaintService.listForAdmin(req.query)));
const complaintCounts = asyncHandler(async (req, res) => ok(res, await complaintService.adminCounts(req.admin._id)));
const complaintDetail = asyncHandler(async (req, res) =>
  ok(res, await complaintService.detailForAdmin(req.params.complaintId))
);

const updateComplaint = asyncHandler(async (req, res) => {
  const { complaint, before, after } = await complaintService.updateAsAdmin(
    req.params.complaintId,
    req.admin,
    req.body
  );

  // One entry describing the whole action, rather than one per field.
  await audit.record(req, {
    action: 'complaint.update',
    resource: 'Complaint',
    resourceId: complaint.id,
    oldValue: before,
    newValue: after,
    note: req.body.resolution ? 'Resolution recorded' : null
  });

  return ok(res, complaint, 'Complaint updated');
});

const addComplaintNote = asyncHandler(async (req, res) => {
  const complaint = await complaintService.addNote(req.params.complaintId, req.admin, req.body.note);

  await audit.record(req, {
    action: 'complaint.note',
    resource: 'Complaint',
    resourceId: req.params.complaintId,
    // The note text itself is in the complaint; the log records that one was added.
    note: 'Internal note added'
  });

  return ok(res, complaint, 'Note added');
});

const replyToComplaint = asyncHandler(async (req, res) => {
  const message = await complaintService.replyAsAdmin(req.params.complaintId, req.admin, req.body.message);

  await audit.record(req, {
    action: 'complaint.reply',
    resource: 'Complaint',
    resourceId: req.params.complaintId,
    note: 'Replied to the reporter'
  });

  return created(res, message, 'Reply sent');
});

// ------------------------------------------------------------------------ chat

/**
 * Reading a ride's chat is an intrusion into two people's conversation, so it is
 * logged every single time — the brief's requirement, and the right default.
 */
const viewRideChat = asyncHandler(async (req, res) => {
  const result = await chatService.adminViewConversation(req.params.rideId);

  await audit.record(req, {
    action: 'chat.view',
    resource: 'ChatConversation',
    resourceId: result.conversation.id,
    note: `Viewed the chat on ride ${req.params.rideId}`
  });

  return ok(res, result);
});

// -------------------------------------------------------------------- settings

const getSettings = asyncHandler(async (req, res) => ok(res, { groups: await settings.describeAll() }));

/**
 * The same service settings, arranged the way an operator thinks about them:
 * one card per service rather than twenty-four rows in a list.
 *
 * It is a view, not a second store. Writes go back through `updateGroup`, so
 * the validation, the audit entries and the cache invalidation are the ones
 * every other setting gets.
 */
const getPricing = asyncHandler(async (req, res) => {
  const groups = await settings.describeAll();
  const rows = groups.find((g) => g.group === 'services')?.settings || [];

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const field = (type, name) => byKey.get(`services.${type}.${name}`);

  const services = ALL_SERVICE_TYPES.map((type) => {
    const service = SERVICES[type];
    const rate = field(type, 'ratePerKm');

    return {
      serviceType: type,
      bookingType: service.bookingType,
      label: service.label,
      description: service.description,
      vehicle: service.vehicle,
      order: service.order,
      ratePerKm: rate.value,
      enabled: field(type, 'enabled').value,
      minimumFare: field(type, 'minimumFare').value,
      maximumFare: field(type, 'maximumFare').value,
      // The registry's own limits, so the form cannot offer a value the
      // backend will refuse.
      limits: {
        ratePerKm: { min: rate.min, max: rate.max },
        minimumFare: { min: field(type, 'minimumFare').min, max: field(type, 'minimumFare').max },
        maximumFare: { min: field(type, 'maximumFare').min, max: field(type, 'maximumFare').max }
      },
      isDefault: rate.isDefault,
      updatedAt: rate.updatedAt,
      updatedBy: rate.updatedBy
    };
  }).sort((a, b) => a.order - b.order);

  return ok(res, { services, currency: settings.get('fare.currency') });
});

/** One service at a time, which is how the screen edits them. */
const updatePricing = asyncHandler(async (req, res) => {
  const { serviceType } = req.params;

  if (!SERVICES[serviceType]) throw ApiError.notFound('Unknown service');

  // Rewritten into settings keys here so the route stays about one service and
  // the store stays the single source of truth.
  const patch = {};
  for (const name of ['ratePerKm', 'enabled', 'minimumFare', 'maximumFare']) {
    if (req.body[name] !== undefined) patch[`services.${serviceType}.${name}`] = req.body[name];
  }

  if (!Object.keys(patch).length) throw ApiError.badRequest('Nothing to change');

  const changes = await settings.updateGroup('services', patch, req.admin);

  await Promise.all(
    changes.map((change) =>
      audit.record(req, {
        // A distinct action so "who changed the bike rate" is one query rather
        // than a scan of every settings edit.
        action: change.key.endsWith('.enabled') ? 'service.availability' : 'service.pricing',
        resource: 'Service',
        resourceId: serviceType,
        oldValue: { serviceType, field: change.key.split('.').pop(), value: change.from },
        newValue: { serviceType, field: change.key.split('.').pop(), value: change.to }
      })
    )
  );

  return ok(res, { serviceType, changes }, changes.length ? 'Pricing updated' : 'Nothing to change');
});

const updateSettings = asyncHandler(async (req, res) => {
  const changes = await settings.updateGroup(req.params.group, req.body, req.admin);

  if (changes.length) {
    // One entry per changed value, because "who changed the fare and from what"
    // is the question this log exists to answer.
    await Promise.all(
      changes.map((change) =>
        audit.record(req, {
          action: 'settings.update',
          resource: 'Setting',
          resourceId: change.key,
          oldValue: { value: change.from },
          newValue: { value: change.to }
        })
      )
    );
  }

  return ok(res, { changes, groups: await settings.describeAll() }, changes.length ? 'Settings saved' : 'No changes');
});

// --------------------------------------------------------------- notifications

const listNotifications = asyncHandler(async (req, res) => {
  const result = await feed.listForAdmin(req.query);
  return ok(res, result);
});

/**
 * Sends an operational notice to a role.
 *
 * Capped and audited. There is no push provider connected, so this reaches the
 * in-app feed and nothing else — which is what the response says, rather than
 * implying a push that never left the building.
 */
const broadcast = asyncHandler(async (req, res) => {
  const { audience, title, body } = req.body;

  const filter = audience === 'all' ? {} : { role: audience === 'riders' ? ROLES.RIDER : ROLES.CUSTOMER };
  const recipients = await User.find({ ...filter, isActive: true }).select('_id').limit(5000).lean();

  let sent = 0;
  for (const recipient of recipients) {
    const entry = await feed.record(recipient._id, feed.NOTIFICATION_TYPE.SYSTEM, title, body);
    if (entry) sent += 1;
  }

  await audit.record(req, {
    action: 'notification.broadcast',
    resource: 'Notification',
    newValue: { audience, title, recipients: sent }
  });

  return ok(res, {
    audience,
    recipients: sent,
    truncated: recipients.length >= 5000,
    delivery: 'in-app feed only — no push provider is configured'
  }, `Sent to ${sent} recipient(s)`);
});

// ------------------------------------------------------------------ audit logs

const listAuditLogs = asyncHandler(async (req, res) => ok(res, await audit.list(req.query)));

// -------------------------------------------------------------------- admins

const listAdmins = asyncHandler(async (req, res) => ok(res, await adminAuthService.listAdmins(req.query)));

const createAdmin = asyncHandler(async (req, res) => {
  const admin = await adminAuthService.createAdmin(req, req.body);
  return created(res, admin, 'Admin created');
});

const updateAdmin = asyncHandler(async (req, res) => {
  const admin = await adminAuthService.updateAdmin(req, req.params.adminId, req.body);
  return ok(res, admin, 'Admin updated');
});

const resetAdminPassword = asyncHandler(async (req, res) => {
  const result = await adminAuthService.resetAdminPassword(req, req.params.adminId, req.body.newPassword);
  return ok(res, result, 'Password reset and sessions ended');
});

const adminActivity = asyncHandler(async (req, res) =>
  ok(res, { logs: await adminAuthService.adminActivity(req.params.adminId) })
);

/** The role/permission matrix, so the console renders the real thing. */
const permissionMatrix = asyncHandler(async (req, res) =>
  ok(res, { roles: ADMIN_ROLES, rolePermissions: ROLE_PERMISSIONS, permissions: ALL_PERMISSIONS })
);


// --------------------------------------------------------------------- finance

/** The money block on the dashboard: what came in, and to whom. */
const financeOverview = asyncHandler(async (req, res) =>
  ok(res, await financeService.platformFinance(req.query))
);

/** Riders ranked by what they owe, for the collections queue. */
const riderBalances = asyncHandler(async (req, res) =>
  ok(res, await financeService.listRiderBalances(req.query))
);

const riderFinance = asyncHandler(async (req, res) =>
  ok(res, await financeService.riderFinance(req.params.riderId))
);

const riderLedger = asyncHandler(async (req, res) =>
  ok(res, await financeService.riderLedger(req.params.riderId, req.query))
);

const platformLedger = asyncHandler(async (req, res) =>
  ok(res, await financeService.platformLedger(req.query))
);

/**
 * Moving a rider's balance by hand.
 *
 * Behind FINANCE_ADJUST, the narrowest permission in the system. The service
 * insists on a reason, posts a ledger entry and writes an audit row — none of
 * which this handler can skip, because none of it lives here.
 */
const adjustRiderBalance = asyncHandler(async (req, res) => {
  const result = await financeService.adjustRiderBalance(req, req.params.riderId, req.body);
  return ok(res, result, 'Balance adjusted');
});

/**
 * Reverses a settled ride's money.
 *
 * Behind the same permission as an adjustment, and idempotent on the ride: a
 * second attempt reverses nothing and says so.
 */
const refundRide = asyncHandler(async (req, res) => {
  const result = await financeService.refundRide(req, req.params.rideId, req.body);
  return ok(res, result, result.refunded ? 'Ride refunded' : 'This ride was already refunded');
});

/** Recomputes a wallet from its ledger. Audited whether or not it moved. */
const reconcileRider = asyncHandler(async (req, res) => {
  const result = await financeService.reconcileRider(req, req.params.riderId);
  return ok(res, result, result.drift === 0 ? 'Balance matches the ledger' : 'Balance repaired from the ledger');
});

/** What is collecting money right now. Never includes a key or a secret. */
/**
 * The payment settings screen: which gateway, which environment, how it is going.
 *
 * Reads only. Switching provider is a platform setting and goes through the
 * settings API with its own audit trail; the credentials the provider uses are
 * environment variables and are not editable — or readable — from here at all.
 */
const paymentOverview = asyncHandler(async (req, res) => ok(res, await ridesService.paymentOverview()));

const refundPayment = asyncHandler(async (req, res) => {
  const result = await ridesService.refundPayment(req, req.params.paymentId, {
    amount: req.body.amount,
    reason: req.body.reason
  });
  return ok(res, result, 'Refund requested');
});

const reconcileRefund = asyncHandler(async (req, res) => {
  const result = await ridesService.reconcileRefund(req, req.params.paymentId);
  return ok(
    res,
    result,
    result.posted ? 'Refund confirmed and reversed in the ledger' : 'The gateway has not settled this refund yet'
  );
});

const paymentProvider = asyncHandler(async (req, res) =>
  // eslint-disable-next-line global-require
  ok(res, require('../../services/payments').describe())
);

module.exports = {
  login,
  me,
  changePassword,
  updateProfile,
  dashboardSummary,
  dashboardSeries,
  dashboardActive,
  dashboardTopRiders,
  listCustomers,
  customerDetail,
  listRiders,
  riderDetail,
  forceRiderOffline,
  setRiderVerification,
  setBlocked,
  updateAccount,
  resolveRider,
  listRides,
  rideDetail,
  cancelRide,
  listPayments,
  paymentDetail,
  settleCash,
  listComplaints,
  complaintCounts,
  complaintDetail,
  updateComplaint,
  addComplaintNote,
  replyToComplaint,
  viewRideChat,
  getSettings,
  updateSettings,
  getPricing,
  updatePricing,
  listNotifications,
  broadcast,
  listAuditLogs,
  listAdmins,
  createAdmin,
  updateAdmin,
  resetAdminPassword,
  adminActivity,
  permissionMatrix,
  financeOverview,
  riderBalances,
  riderFinance,
  riderLedger,
  platformLedger,
  adjustRiderBalance,
  refundRide,
  reconcileRider,
  paymentProvider,
  paymentOverview,
  refundPayment,
  reconcileRefund
};
