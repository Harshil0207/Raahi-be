const PAYMENT_METHOD = {
  CASH: 'CASH',
  UPI: 'UPI'
};

/**
 * Where a payment has got to. Deliberately separate from the ride's own status:
 * a ride is a journey, a payment is money, and the two finish at different
 * moments.
 *
 * INITIATED is retained for rows written before PROCESSING existed. Nothing
 * writes it any more; it is read as equivalent to PROCESSING.
 */
const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  INITIATED: 'INITIATED',
  PROCESSING: 'PROCESSING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED'
};

// A payment here is finished with, one way or another, and will not move again
// on its own.
const TERMINAL_PAYMENT_STATUSES = [
  PAYMENT_STATUS.PAID,
  PAYMENT_STATUS.CANCELLED,
  PAYMENT_STATUS.REFUNDED
];

// Money has been asked for and not yet arrived.
const IN_FLIGHT_PAYMENT_STATUSES = [PAYMENT_STATUS.INITIATED, PAYMENT_STATUS.PROCESSING];

module.exports = {
  PAYMENT_METHOD,
  ALL_PAYMENT_METHODS: Object.values(PAYMENT_METHOD),
  PAYMENT_STATUS,
  ALL_PAYMENT_STATUSES: Object.values(PAYMENT_STATUS),
  TERMINAL_PAYMENT_STATUSES,
  IN_FLIGHT_PAYMENT_STATUSES
};
