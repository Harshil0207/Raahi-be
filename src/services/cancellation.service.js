const settings = require('./settings.service');
const { reasonsFor } = require('../constants/cancellation');
const { RIDE_STATUS } = require('../constants/rideStatus');
const { round2 } = require('../utils/calculateFare');

/**
 * What a cancellation costs, and why.
 *
 * The rules, in the order they are applied:
 *
 *   1. Nobody accepted it yet — free. No one's time was spent.
 *   2. Inside the free window after acceptance — free. Changing your mind in
 *      the first minute is not a thing to charge for.
 *   3. Otherwise the configured fee for whoever cancelled, which is zero
 *      unless an operator has set one.
 *
 * Both fees default to zero, so nothing is charged until somebody decides it
 * should be. That is the difference between a fee system and a fee.
 */
function feeFor(ride, cancelledBy) {
  if (!ride.riderId || !ride.acceptedAt) return 0;

  const freeWindowMs = settings.get('cancellation.freeWindowSeconds') * 1000;
  if (Date.now() - new Date(ride.acceptedAt).getTime() <= freeWindowMs) return 0;

  const configured =
    cancelledBy === 'rider' ? settings.get('cancellation.riderFee') : settings.get('cancellation.customerFee');

  return round2(Math.max(0, Number(configured) || 0));
}

/**
 * Turns a submitted reason into what gets stored.
 *
 * An unrecognised code is not an error — it is recorded as "other" with the
 * text kept. Refusing the cancellation because the reason did not match a list
 * would leave somebody stuck in a ride they want out of, which is the wrong
 * way round: the reason is for us, the cancellation is for them.
 */
function describe(cancelledBy, { reasonCode, note } = {}) {
  const reasons = reasonsFor(cancelledBy);
  const known = reasonCode && reasons[reasonCode] ? reasonCode : null;

  const text = known && known !== 'other' ? reasons[known] : note?.trim() || reasons.other;

  return {
    reasonCode: known || (note ? 'other' : null),
    note: note?.trim() || null,
    reason: text
  };
}

/** Whether the ride had got far enough for a cancellation to cost anything. */
const isChargeable = (ride) =>
  Boolean(ride.riderId) && [RIDE_STATUS.ACCEPTED, RIDE_STATUS.ARRIVING, RIDE_STATUS.ARRIVED].includes(ride.status);

module.exports = { feeFor, describe, isChargeable };
