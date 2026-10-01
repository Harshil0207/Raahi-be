const RIDE_STATUS = {
  SEARCHING: 'SEARCHING',
  ACCEPTED: 'ACCEPTED',
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
  OTP_VERIFIED: 'OTP_VERIFIED',
  IN_PROGRESS: 'IN_PROGRESS',
  // The journey is over and the fare is fixed, but the money has not been
  // collected yet. A ride sits here while the rider takes cash, or while the
  // customer scans a QR code, and leaves only when the payment is actually
  // settled. Keeping it distinct from COMPLETED is what lets "completed" keep
  // meaning "done and paid for" everywhere it is counted.
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
};

// Every allowed move in the ride lifecycle. Anything not listed here is rejected
// by assertTransition, so a new status can never silently skip a step.
const ALLOWED_TRANSITIONS = {
  [RIDE_STATUS.SEARCHING]: [RIDE_STATUS.ACCEPTED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.ACCEPTED]: [RIDE_STATUS.ARRIVING, RIDE_STATUS.ARRIVED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.ARRIVING]: [RIDE_STATUS.ARRIVED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.ARRIVED]: [RIDE_STATUS.OTP_VERIFIED, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.OTP_VERIFIED]: [RIDE_STATUS.IN_PROGRESS, RIDE_STATUS.CANCELLED],
  [RIDE_STATUS.IN_PROGRESS]: [RIDE_STATUS.AWAITING_PAYMENT],
  // Deliberately not cancellable. The journey happened; cancelling it would
  // erase a trip the customer actually took and a fare the rider actually
  // earned. An unpaid ride is a debt to chase, not a ride to undo.
  [RIDE_STATUS.AWAITING_PAYMENT]: [RIDE_STATUS.COMPLETED],
  [RIDE_STATUS.COMPLETED]: [],
  [RIDE_STATUS.CANCELLED]: []
};

// States where the ride still occupies a rider / can still be called off.
//
// AWAITING_PAYMENT belongs here: the rider is standing at the drop-off
// collecting money and is not free to take another job. It is excluded from
// cancellation by the transition table above rather than by being left out of
// this list, so the two rules stay in the place each one belongs.
const ACTIVE_RIDE_STATUSES = [
  RIDE_STATUS.SEARCHING,
  RIDE_STATUS.ACCEPTED,
  RIDE_STATUS.ARRIVING,
  RIDE_STATUS.ARRIVED,
  RIDE_STATUS.OTP_VERIFIED,
  RIDE_STATUS.IN_PROGRESS,
  RIDE_STATUS.AWAITING_PAYMENT
];

// The journey is over, whether or not the money has landed. Used where the
// question is "did this trip happen" rather than "is it settled".
const FINISHED_RIDE_STATUSES = [RIDE_STATUS.AWAITING_PAYMENT, RIDE_STATUS.COMPLETED];

const canTransition = (from, to) => (ALLOWED_TRANSITIONS[from] || []).includes(to);

const RIDE_REQUEST_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
};

module.exports = {
  RIDE_STATUS,
  RIDE_REQUEST_STATUS,
  ALLOWED_TRANSITIONS,
  ACTIVE_RIDE_STATUSES,
  FINISHED_RIDE_STATUSES,
  canTransition
};
