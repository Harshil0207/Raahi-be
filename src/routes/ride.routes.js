const express = require('express');
const rideController = require('../controllers/ride.controller');
const { authenticate, loadRider, attachRider } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { validate } = require('../middleware/validate.middleware');
const { otpLimiter } = require('../middleware/rateLimit.middleware');
const { ROLES } = require('../constants/userRoles');
const { z } = require('zod');
const {
  createRideSchema,
  listRidesSchema,
  rideParamsSchema,
  verifyOtpSchema,
  cancelSchema,
  requestAgainSchema,
  completeSchema
} = require('../validators/ride.validator');

const router = express.Router();
const rideParams = validate({ params: rideParamsSchema });

router.use(authenticate);

// Customer
router.post('/', authorize(ROLES.CUSTOMER), validate({ body: createRideSchema }), rideController.create);
router.get('/', validate({ query: listRidesSchema }), rideController.list);
router.get('/:rideId', rideParams, rideController.detail);
/**
 * Live tracking for this ride. Either participant, never anyone else — the
 * service checks membership against the ride document itself.
 */
router.get('/:rideId/rider-location', attachRider, rideParams, rideController.riderLocation);
router.get('/:rideId/otp', authorize(ROLES.CUSTOMER), rideParams, rideController.otp);

/**
 * The overall star is required; the categories are not.
 *
 * `strict()` on the categories is what stops a client inventing its own — a
 * key nobody asked about would otherwise be accepted, stored, and quietly
 * shown to support as though it meant something.
 */
const stars = z.coerce.number().int().min(1).max(5);

const rateSchema = z.object({
  rating: stars,
  comment: z.string().trim().max(300).optional(),
  categories: z
    .object({ driving: stars.optional(), behaviour: stars.optional(), vehicle: stars.optional() })
    .strict()
    .optional()
});

const rateCustomerSchema = z.object({
  rating: stars,
  comment: z.string().trim().max(300).optional(),
  categories: z
    .object({ behaviour: stars.optional(), readiness: stars.optional(), communication: stars.optional() })
    .strict()
    .optional()
});
router.post(
  '/:rideId/rate',
  authorize(ROLES.CUSTOMER),
  rideParams,
  validate({ body: rateSchema }),
  rideController.rate
);

// The other direction. `attachRider` is what makes `req.rider` the profile the
// service checks the ride against, rather than a user id a client could send.
router.post(
  '/:rideId/rate-customer',
  authorize(ROLES.RIDER),
  attachRider,
  rideParams,
  validate({ body: rateCustomerSchema }),
  rideController.rateCustomer
);

// Either party, subject to the state rules in ride.service
/**
 * Asking again for a ride nobody took.
 *
 * Customer-only: the rider's side of an expired offer is simply that the card
 * disappeared. The service validates that the ride is theirs, that it is still
 * searching, that the previous round is finished and that the ceiling has not
 * been reached.
 */
router.post(
  '/:rideId/request-again',
  authorize(ROLES.CUSTOMER),
  rideParams,
  validate({ body: requestAgainSchema }),
  rideController.requestAgain
);

// What they could switch to, priced for this ride's distance.
router.get(
  '/:rideId/change-options',
  authorize(ROLES.CUSTOMER),
  rideParams,
  rideController.changeOptions
);

router.post('/:rideId/cancel', rideParams, validate({ body: cancelSchema }), rideController.cancel);

// Rider-driven trip lifecycle
const riderOnly = [authorize(ROLES.RIDER), loadRider];

router.post('/:rideId/arriving', riderOnly, rideParams, rideController.arriving);
router.post('/:rideId/arrived', riderOnly, rideParams, rideController.arrived);
router.post(
  '/:rideId/verify-otp',
  riderOnly,
  otpLimiter,
  rideParams,
  validate({ body: verifyOtpSchema }),
  rideController.verifyOtp
);
router.post('/:rideId/start', riderOnly, rideParams, rideController.start);
router.post(
  '/:rideId/complete',
  riderOnly,
  rideParams,
  validate({ body: completeSchema }),
  rideController.complete
);

module.exports = router;
