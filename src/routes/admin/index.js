const express = require('express');
const { z } = require('zod');
const controller = require('../../controllers/admin/admin.controller');
const { authenticateAdmin, requirePermission, requireRole } = require('../../middleware/adminAuth.middleware');
const { validate } = require('../../middleware/validate.middleware');
const { adminAuthLimiter, adminWriteLimiter } = require('../../middleware/rateLimit.middleware');
const { objectId } = require('../../validators/common.validator');
const { ADMIN_ROLES, PERMISSIONS: P } = require('../../constants/adminRoles');
const V = require('../../validators/admin.validator');
const { refundSchema } = require('../../validators/ride.validator');
const assistantRoutes = require('../assistant.routes');

/**
 * The admin API.
 *
 * Read this file to know who can do what: every route carries the permission it
 * needs, next to the handler it guards. That is deliberate — a permission table
 * kept somewhere else drifts from the routes it is meant to describe.
 *
 * `authenticateAdmin` covers everything below the login route, so no handler
 * here can be reached with a customer's or a rider's token.
 */
const router = express.Router();

// ------------------------------------------------------------------ public
router.post('/auth/login', adminAuthLimiter, validate({ body: V.loginSchema }), controller.login);

// ------------------------------------------------------- authenticated below
router.use(authenticateAdmin);

router.get('/auth/me', controller.me);

/**
 * The AI assistant, for operators.
 *
 * The same router the customer and rider apps use, mounted under this console's
 * own authentication so `req.admin` is what identifies the thread. An operator
 * reaches their own conversations and nobody else's — there is no route here
 * that reads another account's, by design.
 */
router.use('/assistant', assistantRoutes);
router.post(
  '/auth/change-password',
  adminWriteLimiter,
  validate({ body: V.changePasswordSchema }),
  controller.changePassword
);
router.patch('/auth/profile', adminWriteLimiter, validate({ body: V.profileSchema }), controller.updateProfile);

// --------------------------------------------------------------- dashboard
const dashboardQuery = validate({ query: V.dashboardQuery });

router.get('/dashboard/summary', requirePermission(P.RIDES_READ), dashboardQuery, controller.dashboardSummary);
router.get('/dashboard/series', requirePermission(P.RIDES_READ), dashboardQuery, controller.dashboardSeries);
router.get('/dashboard/active-rides', requirePermission(P.RIDES_READ), dashboardQuery, controller.dashboardActive);
router.get('/dashboard/top-riders', requirePermission(P.RIDERS_READ), dashboardQuery, controller.dashboardTopRiders);

// --------------------------------------------------------------- customers
const userParams = validate({ params: z.object({ userId: objectId }) });

router.get(
  '/customers',
  requirePermission(P.USERS_READ),
  validate({ query: V.listCustomersQuery }),
  controller.listCustomers
);
router.get('/customers/:userId', requirePermission(P.USERS_READ), userParams, controller.customerDetail);
router.patch(
  '/customers/:userId',
  requirePermission(P.USERS_UPDATE),
  adminWriteLimiter,
  userParams,
  validate({ body: V.updateAccountSchema }),
  controller.updateAccount
);
router.post(
  '/customers/:userId/block',
  requirePermission(P.USERS_BLOCK),
  adminWriteLimiter,
  userParams,
  validate({ body: V.blockSchema }),
  controller.setBlocked
);

// ------------------------------------------------------------------ riders
const riderParams = validate({ params: z.object({ riderId: objectId }) });

router.get('/riders', requirePermission(P.RIDERS_READ), validate({ query: V.listRidersQuery }), controller.listRiders);
router.get('/riders/by-user/:userId', requirePermission(P.RIDERS_READ), userParams, controller.resolveRider);
router.get('/riders/:riderId', requirePermission(P.RIDERS_READ), riderParams, controller.riderDetail);
/**
 * Clearing a rider to carry passengers.
 *
 * RIDERS_UPDATE, the same permission that can force one offline — both are
 * decisions about whether somebody is on the road. The reason is required on a
 * refusal and is shown to the rider, so "you were rejected" is never the whole
 * message they get.
 */
router.post(
  '/riders/:riderId/verification',
  requirePermission(P.RIDERS_UPDATE),
  adminWriteLimiter,
  riderParams,
  validate({ body: V.riderVerificationSchema }),
  controller.setRiderVerification
);

router.post(
  '/riders/:riderId/offline',
  requirePermission(P.RIDERS_UPDATE),
  adminWriteLimiter,
  riderParams,
  validate({ body: V.reasonSchema }),
  controller.forceRiderOffline
);
// A rider account is a user account, so blocking runs through the same handler
// with the rider-specific permission.
router.patch(
  '/rider-accounts/:userId',
  requirePermission(P.RIDERS_UPDATE),
  adminWriteLimiter,
  userParams,
  validate({ body: V.updateAccountSchema }),
  controller.updateAccount
);
router.post(
  '/rider-accounts/:userId/block',
  requirePermission(P.RIDERS_BLOCK),
  adminWriteLimiter,
  userParams,
  validate({ body: V.blockSchema }),
  controller.setBlocked
);

// ------------------------------------------------------------------- rides
const rideParams = validate({ params: z.object({ rideId: objectId }) });

router.get('/rides', requirePermission(P.RIDES_READ), validate({ query: V.listRidesQuery }), controller.listRides);
router.get('/rides/:rideId', requirePermission(P.RIDES_READ), rideParams, controller.rideDetail);
router.post(
  '/rides/:rideId/cancel',
  requirePermission(P.RIDES_MANAGE),
  adminWriteLimiter,
  rideParams,
  validate({ body: V.reasonSchema }),
  controller.cancelRide
);

// Reading a conversation between two people is logged every time.
router.get('/rides/:rideId/chat', requirePermission(P.CHAT_READ), rideParams, controller.viewRideChat);

// ---------------------------------------------------------------- payments
const paymentParams = validate({ params: z.object({ paymentId: objectId }) });

router.get(
  '/payments',
  requirePermission(P.PAYMENTS_READ),
  validate({ query: V.listPaymentsQuery }),
  controller.listPayments
);
router.get('/payments/:paymentId', requirePermission(P.PAYMENTS_READ), paymentParams, controller.paymentDetail);
router.post(
  '/payments/:paymentId/settle-cash',
  requirePermission(P.PAYMENTS_MANAGE),
  adminWriteLimiter,
  paymentParams,
  validate({ body: z.object({ note: z.string().trim().max(300).optional() }) }),
  controller.settleCash
);

// -------------------------------------------------------------- complaints
const complaintParams = validate({ params: z.object({ complaintId: objectId }) });

router.get(
  '/complaints',
  requirePermission(P.COMPLAINTS_READ),
  validate({ query: V.listComplaintsQuery }),
  controller.listComplaints
);
router.get('/complaints/counts', requirePermission(P.COMPLAINTS_READ), controller.complaintCounts);
router.get('/complaints/:complaintId', requirePermission(P.COMPLAINTS_READ), complaintParams, controller.complaintDetail);
router.patch(
  '/complaints/:complaintId',
  requirePermission(P.COMPLAINTS_MANAGE),
  adminWriteLimiter,
  complaintParams,
  validate({ body: V.updateComplaintSchema }),
  controller.updateComplaint
);
router.post(
  '/complaints/:complaintId/notes',
  requirePermission(P.COMPLAINTS_MANAGE),
  adminWriteLimiter,
  complaintParams,
  validate({ body: V.noteSchema }),
  controller.addComplaintNote
);
router.post(
  '/complaints/:complaintId/messages',
  requirePermission(P.COMPLAINTS_MANAGE),
  adminWriteLimiter,
  complaintParams,
  validate({ body: V.messageSchema }),
  controller.replyToComplaint
);


// ------------------------------------------------------------------ finance
//
// Reading the money and moving it are separate permissions. Every route here
// is behind FINANCE_READ; the one that changes a balance is behind
// FINANCE_ADJUST as well, which only the finance and admin roles carry.
router.get('/finance/overview', requirePermission(P.FINANCE_READ), dashboardQuery, controller.financeOverview);
router.get(
  '/finance/balances',
  requirePermission(P.FINANCE_READ),
  validate({ query: V.balancesQuery }),
  controller.riderBalances
);
router.get(
  '/finance/ledger',
  requirePermission(P.FINANCE_READ),
  validate({ query: V.ledgerQuery }),
  controller.platformLedger
);
router.get('/finance/provider', requirePermission(P.FINANCE_READ), controller.paymentProvider);

// The payment gateway's configuration and how it is performing. Read-only, and
// carries nothing secret — see `paymentOverview`.
router.get('/payments-overview', requirePermission(P.FINANCE_READ), controller.paymentOverview);

/**
 * Refunding a fare through the gateway.
 *
 * FINANCE_ADJUST rather than FINANCE_READ: this is the permission that gates
 * moving money, and a refund moves it outward. The reason is required and lands
 * in the audit log beside the admin who asked for it.
 */
router.post(
  '/payments/:paymentId/refund',
  adminWriteLimiter,
  requirePermission(P.FINANCE_ADJUST),
  paymentParams,
  validate({ body: refundSchema }),
  controller.refundPayment
);

/**
 * Asking the gateway again what became of a refund.
 *
 * FINANCE_ADJUST, not FINANCE_READ: this reads from PhonePe but it can post the
 * ledger reversal, so it is a money-moving action even though it decides
 * nothing itself.
 */
router.post(
  '/payments/:paymentId/refund/reconcile',
  adminWriteLimiter,
  requirePermission(P.FINANCE_ADJUST),
  paymentParams,
  controller.reconcileRefund
);

router.get('/riders/:riderId/finance', requirePermission(P.FINANCE_READ), riderParams, controller.riderFinance);
router.get(
  '/riders/:riderId/ledger',
  requirePermission(P.FINANCE_READ),
  riderParams,
  validate({ query: V.ledgerQuery }),
  controller.riderLedger
);
router.post(
  '/riders/:riderId/balance/adjust',
  requirePermission(P.FINANCE_ADJUST),
  adminWriteLimiter,
  riderParams,
  validate({ body: V.adjustBalanceSchema }),
  controller.adjustRiderBalance
);
router.post(
  '/riders/:riderId/balance/reconcile',
  requirePermission(P.FINANCE_ADJUST),
  adminWriteLimiter,
  riderParams,
  controller.reconcileRider
);

// Reversing a settled fare. Behind FINANCE_ADJUST rather than RIDES_UPDATE,
// because what it moves is money rather than a ride's state.
router.post(
  '/rides/:rideId/refund',
  requirePermission(P.FINANCE_ADJUST),
  adminWriteLimiter,
  validate({ params: z.object({ rideId: objectId }) }),
  validate({ body: V.refundRideSchema }),
  controller.refundRide
);

// ---------------------------------------------------------------- settings
router.get('/settings', requirePermission(P.SETTINGS_READ), controller.getSettings);

// Pricing is a settings group with its own screen, so it gets its own pair of
// routes and the same two permissions.
router.get('/settings/pricing', requirePermission(P.SETTINGS_READ), controller.getPricing);
router.patch(
  '/settings/pricing/:serviceType',
  requirePermission(P.SETTINGS_UPDATE),
  adminWriteLimiter,
  validate({ params: V.pricingParamsSchema, body: V.pricingPatchSchema }),
  controller.updatePricing
);
router.patch(
  '/settings/:group',
  requirePermission(P.SETTINGS_UPDATE),
  adminWriteLimiter,
  validate({ params: V.settingsGroupParams, body: V.settingsPatchSchema }),
  controller.updateSettings
);

// ----------------------------------------------------------- notifications
router.get(
  '/notifications',
  requirePermission(P.NOTIFICATIONS_READ),
  validate({ query: V.notificationsQuery }),
  controller.listNotifications
);
router.post(
  '/notifications/broadcast',
  requirePermission(P.NOTIFICATIONS_SEND),
  adminWriteLimiter,
  validate({ body: V.broadcastSchema }),
  controller.broadcast
);

// ------------------------------------------------------------- audit logs
router.get('/audit-logs', requirePermission(P.AUDIT_READ), validate({ query: V.auditQuery }), controller.listAuditLogs);

// ---------------------------------------------------------------- admins
const adminParams = validate({ params: z.object({ adminId: objectId }) });

router.get('/admins/permissions', requirePermission(P.ADMINS_READ), controller.permissionMatrix);
router.get('/admins', requirePermission(P.ADMINS_READ), validate({ query: V.listAdminsQuery }), controller.listAdmins);
router.get('/admins/:adminId/activity', requirePermission(P.AUDIT_READ), adminParams, controller.adminActivity);

// Creating and changing admins is a super-admin act, on top of the permission.
router.post(
  '/admins',
  requireRole(ADMIN_ROLES.SUPER_ADMIN),
  requirePermission(P.ADMINS_MANAGE),
  adminWriteLimiter,
  validate({ body: V.createAdminSchema }),
  controller.createAdmin
);
router.patch(
  '/admins/:adminId',
  requireRole(ADMIN_ROLES.SUPER_ADMIN),
  requirePermission(P.ADMINS_MANAGE),
  adminWriteLimiter,
  adminParams,
  validate({ body: V.updateAdminSchema }),
  controller.updateAdmin
);
router.post(
  '/admins/:adminId/password',
  requireRole(ADMIN_ROLES.SUPER_ADMIN),
  requirePermission(P.ADMINS_MANAGE),
  adminWriteLimiter,
  adminParams,
  validate({ body: V.resetPasswordSchema }),
  controller.resetAdminPassword
);

module.exports = router;
