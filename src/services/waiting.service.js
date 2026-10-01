const settings = require('./settings.service');
const { round2 } = require('../utils/calculateFare');

/**
 * What the customer owes for keeping the rider waiting.
 *
 * Two separate phases, deliberately kept apart. PICKUP waiting runs from the
 * moment the ride is marked arrived until the pickup code is verified — the
 * time the rider spends parked outside waiting for someone to come down.
 * PAYMENT waiting runs from the end of the journey until the fare is settled —
 * the time they spend at the drop-off waiting to be paid. An operator can price
 * them differently because they are different situations.
 *
 * THE SERVER OWNS EVERY TIMESTAMP HERE. Nothing on this path reads a clock sent
 * by a browser: a customer whose device is running ten minutes slow would
 * otherwise get ten free minutes, and one running fast would be billed for
 * time nobody waited. The apps are given a start time and the server's current
 * time, and they count for display only; what is actually charged is worked out
 * here, from timestamps this process wrote.
 *
 * Nothing ticks. There is no interval, no per-second write, no timer object —
 * a waiting phase is two timestamps, and the charge is a function of them. That
 * is what makes a refresh, a reconnect, a crashed browser or a restarted server
 * all behave the same way: the elapsed time is recomputed from what is stored,
 * never accumulated in memory.
 */

/** The rules in force right now, as a ride should record them. */
function currentRules() {
  return {
    pickup: {
      freeMinutes: settings.get('waiting.freePickupMinutes'),
      perMinute: settings.get('waiting.pickupChargePerMinute')
    },
    payment: {
      freeMinutes: settings.get('waiting.freePaymentMinutes'),
      perMinute: settings.get('waiting.paymentChargePerMinute')
    }
  };
}

/**
 * The charge for one waiting phase.
 *
 * Every started minute after the free period costs a full minute — `ceil`, not
 * `round` and not `floor`. So with three free minutes: 3:00 is free, 3:01 costs
 * one minute, 4:00 still costs one, and 4:01 costs two. Rounding down instead
 * would give away a minute on every trip; rounding to nearest would charge for
 * a minute nobody waited.
 *
 * Returns whole seconds and minutes alongside the money so a receipt can show
 * the working rather than an unexplained number.
 */
function chargeFor({ startedAt, endedAt, freeMinutes, perMinute }) {
  if (!startedAt || !endedAt) return { seconds: 0, minutes: 0, charge: 0 };

  const elapsedMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  // A clock that went backwards, or an end recorded before a start. Charging a
  // negative fare would credit the customer for waiting.
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));

  const freeSeconds = Math.max(0, Number(freeMinutes) || 0) * 60;
  const chargeableSeconds = Math.max(0, seconds - freeSeconds);
  const minutes = Math.ceil(chargeableSeconds / 60);

  return {
    seconds,
    minutes,
    charge: round2(minutes * Math.max(0, Number(perMinute) || 0))
  };
}

/** The stored shape of one phase, before anything has happened. */
const emptyPhase = () => ({
  startedAt: null,
  endedAt: null,
  seconds: 0,
  minutes: 0,
  charge: 0
});

/**
 * Makes sure the ride has somewhere to record waiting, and that it remembers
 * the rules it is being charged under.
 *
 * The rules are copied onto the ride at the moment each phase starts, the same
 * way the commission rate is frozen when a fare is settled. An operator raising
 * the per-minute charge this afternoon must not reprice a customer who was kept
 * waiting this morning.
 */
function ensure(ride) {
  if (!ride.waiting) ride.waiting = {};
  if (!ride.waiting.pickup) ride.waiting.pickup = emptyPhase();
  if (!ride.waiting.payment) ride.waiting.payment = emptyPhase();
  return ride.waiting;
}

/**
 * Start a phase, once.
 *
 * The guard is the whole point. Arrival can be reported twice — the proximity
 * check and the rider's own button race each other by design — and a second
 * start would move the clock forward and quietly wipe out the wait that had
 * already accrued. First start wins; later ones do nothing.
 */
function startPhase(ride, phase, rules) {
  const waiting = ensure(ride);
  if (waiting[phase].startedAt) return false;

  waiting[phase].startedAt = new Date();
  waiting[phase].freeMinutes = rules.freeMinutes;
  waiting[phase].perMinute = rules.perMinute;

  return true;
}

/**
 * Close a phase and work out what it cost.
 *
 * `recompute` is for the one case where an amount is being fixed a second time:
 * a UPI order that failed, and a new one being raised for a customer who has
 * now been waiting longer. The START is never touched — a failed payment does
 * not buy back the free period — only the end moves.
 */
function stopPhase(ride, phase, { recompute = false } = {}) {
  const waiting = ensure(ride);
  const record = waiting[phase];

  if (!record.startedAt) return false;
  if (record.endedAt && !recompute) return false;

  record.endedAt = new Date();

  const { seconds, minutes, charge } = chargeFor({
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    // The rules the phase started under, not today's.
    freeMinutes: record.freeMinutes,
    perMinute: record.perMinute
  });

  record.seconds = seconds;
  record.minutes = minutes;
  record.charge = charge;

  return true;
}

const startPickup = (ride) => startPhase(ride, 'pickup', currentRules().pickup);
const stopPickup = (ride) => stopPhase(ride, 'pickup');

const startPayment = (ride) => startPhase(ride, 'payment', currentRules().payment);
const stopPayment = (ride, options) => stopPhase(ride, 'payment', options);

/** Everything charged for waiting on this ride. */
function totalCharge(ride) {
  const waiting = ride?.waiting || {};
  return round2((waiting.pickup?.charge || 0) + (waiting.payment?.charge || 0));
}

/**
 * What a screen needs to show a live timer.
 *
 * `serverNow` is the important part. A client that counts from its own
 * `Date.now()` against a server start time is wrong by however far its clock
 * has drifted — and phones drift by minutes. Sending the server's current time
 * alongside lets the app work out the offset once and count correctly, while
 * the number that is actually billed is still the one computed here.
 *
 * `charge` is what the phase has cost SO FAR on an open phase, and what it
 * finally cost on a closed one. It is advisory on an open phase: the figure
 * that gets charged is the one written when the phase closes.
 */
function phaseState(record) {
  if (!record?.startedAt) return null;

  const open = !record.endedAt;
  const upTo = record.endedAt || new Date();

  const live = chargeFor({
    startedAt: record.startedAt,
    endedAt: upTo,
    freeMinutes: record.freeMinutes,
    perMinute: record.perMinute
  });

  return {
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    open,
    freeMinutes: record.freeMinutes ?? null,
    perMinute: record.perMinute ?? null,
    seconds: live.seconds,
    minutes: live.minutes,
    charge: open ? live.charge : record.charge
  };
}

function stateOf(ride) {
  const waiting = ride?.waiting || {};

  return {
    serverNow: new Date(),
    pickup: phaseState(waiting.pickup),
    payment: phaseState(waiting.payment),
    totalCharge: totalCharge(ride)
  };
}

module.exports = {
  chargeFor,
  currentRules,
  startPickup,
  stopPickup,
  startPayment,
  stopPayment,
  totalCharge,
  stateOf,
  // Exported for the ride service, which needs to build the sub-document on a
  // ride created before this existed.
  ensure
};
