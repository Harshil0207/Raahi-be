const express = require('express');
const env = require('../config/env');
const riderController = require('../controllers/rider.controller');
const walletController = require('../controllers/wallet.controller');
const { authenticate, loadRider } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { validate } = require('../middleware/validate.middleware');
const { locationLimiter } = require('../middleware/rateLimit.middleware');
const { ROLES } = require('../constants/userRoles');
const {
  onboardingSchema,
  statusSchema,
  profileSchema,
  requestParamsSchema,
  earningsQuerySchema,
  rechargeSchema,
  rechargeParamsSchema,
  ledgerQuerySchema
} = require('../validators/rider.validator');
const { locationSchema } = require('../validators/location.validator');

const router = express.Router();

/**
 * Creating the rider profile, for an account that has none yet.
 *
 * ABOVE the `loadRider` block below, and that placement is the whole point: a
 * rider who signed up with Google has a user account with `role: rider` and no
 * rider document, so `loadRider` would answer "rider profile not found" — which
 * is the state this endpoint exists to leave.
 */
router.post(
  '/onboarding',
  authenticate,
  authorize(ROLES.RIDER),
  validate({ body: onboardingSchema }),
  riderController.createProfile
);

// Everything below is rider-only and runs with req.rider already loaded.
router.use(authenticate, authorize(ROLES.RIDER), loadRider);

router.get('/profile', riderController.getProfile);
router.patch('/profile', validate({ body: profileSchema }), riderController.updateProfile);
router.patch('/status', validate({ body: statusSchema }), riderController.setStatus);

router.post('/location', locationLimiter, validate({ body: locationSchema }), riderController.updateLocation);

router.get('/ride-requests', riderController.listRideRequests);
router.post(
  '/ride-requests/:requestId/accept',
  validate({ params: requestParamsSchema }),
  riderController.acceptRideRequest
);
router.post(
  '/ride-requests/:requestId/reject',
  validate({ params: requestParamsSchema }),
  riderController.rejectRideRequest
);

router.get('/earnings', validate({ query: earningsQuerySchema }), riderController.earnings);
router.get('/stats', riderController.stats);

router.get('/active-ride', riderController.activeRide);

// ------------------------------------------------------------------ wallet
//
// No rider id appears in any of these paths. The wallet a rider reads is the
// one attached to their own token, so there is nothing here to point at
// somebody else's money.
router.get('/wallet', walletController.summary);
router.get('/wallet/ledger', validate({ query: ledgerQuerySchema }), walletController.ledger);
router.get('/wallet/recharges', walletController.recharges);
router.post('/wallet/recharge', validate({ body: rechargeSchema }), walletController.startRecharge);
router.get(
  '/wallet/recharge/:rechargeId',
  validate({ params: rechargeParamsSchema }),
  walletController.rechargeStatus
);
router.post(
  '/wallet/recharge/:rechargeId/cancel',
  validate({ params: rechargeParamsSchema }),
  walletController.cancelRecharge
);

/**
 * Settles a sandbox recharge, standing in for the rider's UPI app.
 *
 * Mounted conditionally rather than guarded inside the handler, exactly as the
 * `/payments/sandbox/...` route is: outside development this path does not
 * exist, so there is no endpoint to discover and no flag to flip. The handler
 * refuses anyway unless the sandbox provider is the active one, and the sandbox
 * provider cannot be constructed in production — three independent guards for
 * one development convenience, because the thing it touches is money.
 */
if (!env.isProduction) {
  router.post(
    '/wallet/recharge/:rechargeId/simulate',
    validate({ params: rechargeParamsSchema }),
    walletController.simulateRecharge
  );
}

module.exports = router;
