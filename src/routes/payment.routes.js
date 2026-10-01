const express = require('express');
const paymentController = require('../controllers/payment.controller');
const { authenticate, loadRider, attachRider } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { validate } = require('../middleware/validate.middleware');
const env = require('../config/env');
const { ROLES } = require('../constants/userRoles');
const {
  rideParamsSchema,
  paymentMethodSchema,
  paymentParamsSchema,
  paymentHistoryQuery
} = require('../validators/ride.validator');

const router = express.Router();
const rideParams = validate({ params: rideParamsSchema });

/**
 * A gateway calling back.
 *
 * Mounted before `authenticate` because a provider has no session — it proves
 * itself with a signature over the body instead, which the payment service
 * checks before it looks at anything else. An unsigned or wrongly signed body
 * is refused, so this being public does not make it trusting.
 *
 * The bytes that signature covers are kept by the app's own parser (see app.js);
 * a second `express.json` here would be skipped, which is how this endpoint came
 * to be signed against an undefined body.
 */
router.post('/webhook', paymentController.webhook);

/**
 * Stands in for a customer opening their UPI app.
 *
 * Development only, and mounted conditionally rather than guarded inside the
 * handler — in production this path does not exist at all, so there is no
 * endpoint to find, no flag to flip and no chance of it being reachable by
 * mistake. It is the counterpart to the sandbox provider, and it is the reason
 * the rider app can be built against the real waiting-for-payment flow without
 * anyone being able to declare their own payment successful.
 */
if (!env.isProduction) {
  router.post('/sandbox/:providerRef/pay', paymentController.sandboxPay);
}

router.use(authenticate);

router.get('/options', paymentController.options);

/**
 * The signed-in person's own payment history.
 *
 * Above `/:rideId`, or Express would read `mine` as a ride id and the route
 * would answer 400 for the rest of its life. It takes no id of any kind: who is
 * asking comes from the session, so there is nothing here to change to somebody
 * else's. `attachRider` is what makes a rider see the trips they drove rather
 * than the ones they took.
 */
router.get(
  '/mine',
  attachRider,
  validate({ query: paymentHistoryQuery }),
  paymentController.history
);

/**
 * The customer's own payment, by payment id rather than by ride.
 *
 * Separate from the ride-scoped poll because after a redirect the app is
 * holding a payment and may not have the ride loaded. Ownership is checked
 * against the payment itself.
 */
router.get(
  '/:paymentId/status',
  attachRider,
  validate({ params: paymentParamsSchema }),
  paymentController.paymentStatus
);


// Both sides of a ride may read and poll its payment, so the rider profile is
// attached when there is one rather than demanded.
router.get('/:rideId', rideParams, attachRider, paymentController.detail);
router.get('/:rideId/status', rideParams, attachRider, paymentController.status);

router.post(
  '/:rideId/method',
  authorize(ROLES.CUSTOMER),
  rideParams,
  validate({ body: paymentMethodSchema }),
  paymentController.selectMethod
);

// The rider chooses how the customer is paying, at the drop-off.
router.post(
  '/:rideId/rider-method',
  authorize(ROLES.RIDER),
  loadRider,
  rideParams,
  validate({ body: paymentMethodSchema }),
  paymentController.setRiderMethod
);

// Opens a UPI collection and returns something to scan.
/**
 * The customer paying for their own ride.
 *
 * Customer-only: a redirect gateway hands back a URL that must open on the
 * payer's device, so this is the one payment action the rider cannot take for
 * them. The rider's own collection route below opens the same attempt, so the
 * two cannot end up pointing at different orders.
 */
router.post(
  '/:rideId/checkout',
  authorize(ROLES.CUSTOMER),
  rideParams,
  paymentController.startCheckout
);

router.post('/:rideId/upi', authorize(ROLES.RIDER), loadRider, rideParams, paymentController.startUpi);

// The rider confirms cash because they are the one who receives it. There is
// deliberately no equivalent for UPI: that settles when the gateway says so.
router.post(
  '/:rideId/collect-cash',
  authorize(ROLES.RIDER),
  loadRider,
  rideParams,
  paymentController.confirmCash
);

module.exports = router;
