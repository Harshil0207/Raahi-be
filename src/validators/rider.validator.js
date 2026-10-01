const { z } = require('zod');
const authValidator = require('./auth.validator');
const { objectId } = require('./common.validator');
const { ALL_SERVICE_TYPES } = require('../constants/services');
const { PAYMENT_METHOD } = require('../constants/paymentStatus');
const { ALL_LEDGER_TYPES } = require('../constants/finance');
const { ALL_RANGES } = require('../services/earnings.service');

const statusSchema = z.object({
  isOnline: z.boolean()
});

const profileSchema = z
  .object({
    vehicle: z
      .object({
        type: z.enum(['bike', 'auto', 'car']).optional(),
        make: z.string().trim().optional(),
        model: z.string().trim().optional(),
        numberPlate: z.string().trim().min(4).optional(),
        color: z.string().trim().optional()
      })
      .optional(),
    licence: z
      .object({
        number: z.string().trim().min(5).optional(),
        expiresAt: z.coerce.date().optional()
      })
      .optional()
  })
  .refine((d) => d.vehicle || d.licence, { message: 'Nothing to update' });

const requestParamsSchema = z.object({
  requestId: objectId
});

// A control left on "All" sends nothing, but a form that serialises its own
// state can send an empty string; both mean "no filter" rather than "invalid".
const blankToUndefined = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Earnings screen's filters.
 *
 * Dates are whole days rather than instants: the rider asks for "the 3rd to the
 * 9th", and the service turns each end into local midnight itself. Accepting a
 * full timestamp here would hand the caller a way to straddle a day boundary
 * the aggregation has been careful to respect.
 */
const earningsQuerySchema = z
  .object({
    days: z.coerce.number().int().min(7).max(90).default(14),
    range: blankToUndefined(z.enum(ALL_RANGES).optional()),
    from: blankToUndefined(z.string().regex(ISO_DAY, 'Use YYYY-MM-DD').optional()),
    to: blankToUndefined(z.string().regex(ISO_DAY, 'Use YYYY-MM-DD').optional()),
    serviceType: blankToUndefined(z.enum(ALL_SERVICE_TYPES).optional()),
    method: blankToUndefined(z.enum(Object.values(PAYMENT_METHOD)).optional())
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['from']
  });


// ------------------------------------------------------------------ wallet

const rechargeSchema = z.object({
  // The real floor is the platform's minimum, which an admin can change, so it
  // is enforced in the service where that value can be read. This only refuses
  // what is not an amount at all.
  amount: z.coerce.number().positive('Enter an amount to recharge')
});

const rechargeParamsSchema = z.object({
  rechargeId: objectId
});

const ledgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: blankToUndefined(z.enum(ALL_LEDGER_TYPES).optional())
});

/**
 * The vehicle and licence a rider supplies during onboarding.
 *
 * The same shapes the registration validator already enforces, imported rather
 * than rewritten so the two paths into a rider profile cannot drift apart and
 * accept different things.
 */
const onboardingSchema = z.object({
  vehicle: authValidator.vehicleSchema,
  licence: authValidator.licenceSchema
});

module.exports = {
  onboardingSchema,
  statusSchema,
  profileSchema,
  requestParamsSchema,
  earningsQuerySchema,
  rechargeSchema,
  rechargeParamsSchema,
  ledgerQuerySchema
};
