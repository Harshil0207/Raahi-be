/**
 * The accounting vocabulary, in one place.
 *
 * THE CONVENTION, which everything in the money path follows:
 *
 *   A ledger `amount` is ALWAYS a positive magnitude. The sign lives in
 *   `direction`, never in the number.
 *
 *   A wallet `balance` is signed, and it is written from the rider's point of
 *   view:
 *
 *     balance > 0   the platform owes the rider this much   (payable earnings)
 *     balance < 0   the rider owes the platform this much   (outstanding)
 *
 *   CREDIT moves the balance up, DEBIT moves it down, and MEMO records
 *   something true about the money without moving it at all.
 *
 * One signed balance rather than two counters is what keeps a cash ride and a
 * UPI ride from needing different arithmetic:
 *
 *   cash ₹100 at 15%   earning +85, cash taken -100   → -15, so ₹15 outstanding
 *   UPI  ₹100 at 15%   earning +85                    → +85, nothing outstanding
 *   recharge ₹30 on -151                              → -121
 *
 * Those are the brief's own worked examples, and they fall out of the
 * convention rather than being special-cased.
 *
 * MEMO exists because the ledger has to be readable as a story, not just as a
 * running total. The platform's commission and the money a gateway collected
 * are both facts worth recording against the ride, but neither is a movement in
 * the rider's balance — the commission is already taken out of the earning
 * credit, and the gateway's money never passed through the rider's hands.
 * Recording them as CREDIT or DEBIT would double-count; leaving them out would
 * make the ledger unauditable.
 */

const LEDGER_TYPE = {
  RIDE_EARNING: 'RIDE_EARNING',
  PLATFORM_COMMISSION: 'PLATFORM_COMMISSION',
  CASH_COLLECTION: 'CASH_COLLECTION',
  UPI_PAYMENT: 'UPI_PAYMENT',
  RIDER_RECHARGE: 'RIDER_RECHARGE',
  ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
  REFUND: 'REFUND',
  // Charged to a rider who called off a ride they had accepted. A debit, so it
  // moves the same balance the platform's commission does and counts towards
  // the debt that stops them going online.
  CANCELLATION_FEE: 'CANCELLATION_FEE'
};

const ALL_LEDGER_TYPES = Object.values(LEDGER_TYPE);

const LEDGER_DIRECTION = {
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
  MEMO: 'MEMO'
};

const ALL_LEDGER_DIRECTIONS = Object.values(LEDGER_DIRECTION);

/** How a direction moves a signed balance. MEMO is deliberately zero. */
const SIGN = {
  [LEDGER_DIRECTION.CREDIT]: 1,
  [LEDGER_DIRECTION.DEBIT]: -1,
  [LEDGER_DIRECTION.MEMO]: 0
};

const WALLET_STATUS = {
  ACTIVE: 'ACTIVE',
  // Owes more than the configured ceiling. Cannot go online until it is paid
  // down; an active trip is never interrupted by it.
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED'
};

const RECHARGE_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
};

/**
 * The error the go-online endpoint returns when the ceiling is exceeded, named
 * so the rider app can recognise it without matching on prose.
 */
const RIDER_BALANCE_LIMIT_REACHED = 'RIDER_BALANCE_LIMIT_REACHED';

// Money is rounded at every boundary it crosses. Kept here rather than imported
// from calculateFare so the accounting layer does not depend on the fare layer.
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** What a rider owes, as a non-negative number, from a signed balance. */
const outstandingOf = (balance) => (balance < 0 ? Math.abs(round2(balance)) : 0);

/** What the platform owes the rider, as a non-negative number. */
const availableOf = (balance) => (balance > 0 ? round2(balance) : 0);

module.exports = {
  LEDGER_TYPE,
  ALL_LEDGER_TYPES,
  LEDGER_DIRECTION,
  ALL_LEDGER_DIRECTIONS,
  SIGN,
  WALLET_STATUS,
  ALL_WALLET_STATUSES: Object.values(WALLET_STATUS),
  RECHARGE_STATUS,
  ALL_RECHARGE_STATUSES: Object.values(RECHARGE_STATUS),
  RIDER_BALANCE_LIMIT_REACHED,
  outstandingOf,
  availableOf,
  round2
};
