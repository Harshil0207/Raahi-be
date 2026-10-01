const { z } = require('zod');
const { objectId, place } = require('./common.validator');
const { RIDE_STATUS } = require('../constants/rideStatus');
const { PAYMENT_METHOD } = require('../constants/paymentStatus');
const { ALL_SERVICE_TYPES, ALL_PACKAGE_SIZES } = require('../constants/services');

/**
 * Package details. Required for a delivery and rejected for a passenger ride —
 * the service decides which, so the shape is checked here and the pairing is
 * checked in the service against the catalogue.
 */
const parcelSchema = z.object({
  senderName: z.string().trim().min(2).max(80),
  senderPhone: z.string().trim().regex(/^[0-9+\-\s]{6,20}$/, 'Enter a phone number'),
  receiverName: z.string().trim().min(2).max(80),
  receiverPhone: z.string().trim().regex(/^[0-9+\-\s]{6,20}$/, 'Enter a phone number'),
  description: z.string().trim().min(3).max(300),
  size: z.enum(ALL_PACKAGE_SIZES),
  weightKg: z.coerce.number().min(0).max(200).optional()
});

const createRideSchema = z.object({
  pickup: place,
  destination: place,
  // Only the service is taken from the client. The rate, the distance and the
  // fare are all the server's.
  serviceType: z.enum(ALL_SERVICE_TYPES),
  parcel: parcelSchema.optional()
});

const quoteSchema = z.object({
  pickup: place,
  destination: place
});

const listRidesSchema = z.object({
  status: z.enum(Object.values(RIDE_STATUS)).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const rideParamsSchema = z.object({
  rideId: objectId
});

const verifyOtpSchema = z.object({
  otp: z.string().trim().regex(/^[0-9]{4,6}$/, 'OTP must be 4 to 6 digits')
});

/**
 * `reason` is kept for anything still sending free text — the old shape stays
 * valid rather than breaking a client mid-deploy. New callers send a code, and
 * the code is checked against the caller's own list in the service, because
 * which reasons are offered depends on which side is cancelling.
 */
/** A payment id in the path, for the routes addressed by payment rather than ride. */
const paymentParamsSchema = z.object({
  paymentId: objectId
});

/**
 * A refund amount, when one is given.
 *
 * Optional because the fare is the only amount that can be refunded — the
 * service refuses anything smaller, since the ledger reverses a ride line for
 * line and there is no honest way to post part of that. It stays accepted so a
 * caller may state the figure explicitly, and a mistyped one is refused rather
 * than silently rounded to the whole fare.
 */
const refundSchema = z.object({
  amount: z.coerce.number().positive().optional(),
  reason: z.string().trim().min(3).max(300)
});

/** Paging for a person's own payment history. */
const paymentHistoryQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

const cancelSchema = z.object({
  reasonCode: z.string().trim().max(40).optional(),
  note: z.string().trim().max(300).optional(),
  reason: z.string().trim().max(300).optional()
});

const completeSchema = z.object({
  distanceKm: z.coerce.number().positive().optional(),
  paymentMethod: z.enum(Object.values(PAYMENT_METHOD)).optional()
});

const paymentMethodSchema = z.object({
  method: z.enum(Object.values(PAYMENT_METHOD))
});

/**
 * Re-asking carries at most a service type. Everything else about the ride —
 * the route, the distance, the price — is already on the server and is not
 * open to being restated by the client.
 */
const requestAgainSchema = z.object({
  serviceType: z.enum(ALL_SERVICE_TYPES).optional()
});

module.exports = {
  requestAgainSchema,
  createRideSchema,
  quoteSchema,
  listRidesSchema,
  rideParamsSchema,
  verifyOtpSchema,
  cancelSchema,
  paymentParamsSchema,
  refundSchema,
  paymentHistoryQuery,
  completeSchema,
  paymentMethodSchema
};
