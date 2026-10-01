const crypto = require('crypto');
const Payment = require('../models/Payment');
const Ride = require('../models/Ride');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const notifications = require('./notification.service');
const settings = require('./settings.service');
const providers = require('./payments');
const waiting = require('./waiting.service');
const fareService = require('./fare.service');
const { round2 } = require('../utils/calculateFare');
const { SOCKET_EVENTS } = require('../constants/socketEvents');
const {
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  TERMINAL_PAYMENT_STATUSES
} = require('../constants/paymentStatus');
const { RIDE_STATUS, FINISHED_RIDE_STATUSES } = require('../constants/rideStatus');

/**
 * Collecting the fare.
 *
 * The rule this file exists to hold: a UPI payment becomes PAID because a
 * provider said the money arrived, never because a client said so. Cash is the
 * deliberate exception — there is no system that can observe a note changing
 * hands, so the rider, who is the person holding it, confirms it. Those are the
 * only two ways a payment settles, and both of them go through `settle` below.
 *
 * Settlement is what finishes a ride. Until it happens the ride sits in
 * AWAITING_PAYMENT: the trip is over, the fare is fixed, the money is not in.
 */

/**
 * Created when the trip ends, for the amount the server settled on.
 *
 * The amount comes from the ride, which got it from the fare service, which got
 * it from the pricing the ride was created under. At no point does a client
 * contribute a number to this.
 */
async function createForRide(ride, method = null) {
  const existing = await Payment.findOne({ rideId: ride._id });
  if (existing) return existing;

  const chosen = method || defaultMethod();

  const payment = await Payment.create({
    rideId: ride._id,
    customerId: ride.customerId,
    riderId: ride.riderId,
    amount: ride.finalFare,
    currency: ride.currency,
    method: chosen,
    status: PAYMENT_STATUS.PENDING
  });

  ride.payment.method = payment.method;
  ride.payment.status = payment.status;
  ride.payment.paymentId = payment._id;
  await ride.save();

  return payment;
}


/**
 * Fix what the customer owes, including the time they took to pay it.
 *
 * Called at the two moments the amount stops being provisional: just before a
 * UPI order is raised with the provider, and at the instant a cash payment is
 * confirmed. Both are the same event in different clothes — the point where
 * the customer's obligation becomes a number somebody acts on.
 *
 * ORDERING MATTERS. For UPI this has to run BEFORE the provider order exists,
 * because the gateway holds the amount from then on and `isShortPayment` will
 * later compare what arrived against `payment.amount`. Repricing after the
 * order would make a perfectly good payment look short and refuse to settle a
 * ride the customer had paid for in full.
 *
 * `recompute` is for a second order after a failed one: the customer has been
 * waiting longer, so the end moves and the charge grows. The START never moves
 * — a failed payment does not buy back the free period.
 */
async function fixAmountOwed(ride, payment, { recompute = false } = {}) {
  if (!waiting.stopPayment(ride, { recompute })) return false;

  const repriced = fareService.repriceWithWaiting(ride);

  ride.finalFare = repriced.finalFare;
  ride.finance = { ...(ride.finance ? ride.finance.toObject?.() || ride.finance : {}), ...repriced.finance };

  await Ride.updateOne(
    { _id: ride._id },
    {
      $set: {
        finalFare: ride.finalFare,
        finance: ride.finance,
        'waiting.payment': ride.waiting.payment
      }
    }
  );

  // The payment has to be for what is actually owed, or the rider collects one
  // number while the ledger posts another.
  if (payment && payment.amount !== ride.finalFare) {
    payment.amount = ride.finalFare;
    await payment.save();
  }

  return true;
}

const defaultMethod = () =>
  settings.get('payment.cashEnabled') ? PAYMENT_METHOD.CASH : PAYMENT_METHOD.UPI;

/** Refuses a method an admin has turned off, or one with no gateway behind it. */
function assertMethodAvailable(method) {
  if (method === PAYMENT_METHOD.CASH) {
    if (!settings.get('payment.cashEnabled')) {
      throw ApiError.badRequest('Cash payments are not accepted at the moment');
    }
    return;
  }

  if (!settings.get('payment.upiEnabled')) {
    throw ApiError.badRequest('UPI payments are not accepted at the moment');
  }

  const provider = providers.active();
  if (!provider.available) {
    throw new ApiError(501, provider.unavailableReason || 'UPI payments are not available yet');
  }
}

// ------------------------------------------------------------------ loading

/**
 * A ride and the payment that goes with it, creating the payment if the trip
 * ended without one.
 *
 * A TRIP THAT ENDED HAS A FARE TO COLLECT, FULL STOP. The ride moves to
 * AWAITING_PAYMENT in its own write and the payment row is created immediately
 * after, so anything that goes wrong in between — a failed write, a restart, a
 * bad index — leaves a real debt with nothing to collect it against. The rider
 * is then stuck on a screen reading "No payment record for this ride" with no
 * way forward at all, and the money is simply lost.
 *
 * So a missing row is repaired rather than reported, but ONLY for a ride that
 * has genuinely finished. `createForRide` reads the amount from the ride, which
 * got it from the fare service, so the repair invents nothing: it writes the
 * same row the completion would have written. It is idempotent, so two callers
 * arriving together end up with one payment.
 *
 * Any other status keeps the old refusal, because a missing payment there means
 * something is wrong that this should not paper over.
 */
async function loadRidePayment(rideId) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  let payment = await Payment.findOne({ rideId: ride._id });

  if (!payment && ride.status === RIDE_STATUS.AWAITING_PAYMENT) {
    logger.warn(`[Payment] ride ${ride._id} was awaiting payment with no payment row; creating one`);
    payment = await createForRide(ride, ride.payment?.method || null);
  }

  if (!payment) throw ApiError.notFound('No payment record for this ride');

  return { ride, payment };
}

function assertRidersRide(ride, rider) {
  if (!ride.riderId || String(ride.riderId) !== String(rider._id)) {
    throw ApiError.forbidden('This ride is not assigned to you');
  }
}

function assertCollectable(ride) {
  if (!FINISHED_RIDE_STATUSES.includes(ride.status)) {
    throw ApiError.badRequest('The fare can only be collected once the trip is finished');
  }
}

// ------------------------------------------------------------ choosing how

/**
 * The rider picks how the customer is paying, at the drop-off.
 *
 * Changing the method is allowed while the ride is awaiting payment — a QR that
 * will not scan is a normal reason to take cash instead — but not after the
 * money is in, which is what the terminal check below refuses.
 */
async function setMethodForRide(rideId, rider, method) {
  const { ride, payment } = await loadRidePayment(rideId);
  assertRidersRide(ride, rider);
  assertCollectable(ride);

  if (TERMINAL_PAYMENT_STATUSES.includes(payment.status)) {
    throw ApiError.conflict('This fare has already been settled');
  }

  assertMethodAvailable(method);

  payment.method = method;
  payment.status = PAYMENT_STATUS.PENDING;
  payment.providerOrderId = null;
  payment.failureReason = null;
  await payment.save();

  ride.payment.method = payment.method;
  ride.payment.status = payment.status;
  await ride.save();

  notifyParties(ride, payment);
  return payment;
}

/** The customer's own choice, kept for the summary screen. Same rules. */
async function selectMethod(rideId, customerId, method) {
  const { ride, payment } = await loadRidePayment(rideId);

  if (String(ride.customerId) !== String(customerId)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }
  assertCollectable(ride);

  if (TERMINAL_PAYMENT_STATUSES.includes(payment.status)) {
    throw ApiError.conflict('This ride has already been paid for');
  }

  assertMethodAvailable(method);

  payment.method = method;
  payment.status = PAYMENT_STATUS.PENDING;
  await payment.save();

  ride.payment.method = payment.method;
  ride.payment.status = payment.status;
  await ride.save();

  notifyParties(ride, payment);
  return payment;
}

// ------------------------------------------------------------------- UPI

/**
 * Asks the provider to expect the fare, and returns something to scan.
 *
 * Calling it twice on the same ride reuses the order already open rather than
 * creating a second one, so a rider whose screen reloaded is not collecting the
 * same fare through two different references.
 */
/**
 * A merchant order id, unique to this attempt.
 *
 * Shaped so a human reading a gateway dashboard can find the ride: the prefix
 * says which platform, then the ride, then when, then enough randomness that
 * two attempts in the same millisecond cannot collide. Only underscores and
 * hyphens, and under 63 characters, because that is what PhonePe accepts.
 *
 * It is never reused. A retried payment gets a new one, which is what makes a
 * retry a genuinely new attempt at the gateway rather than a second answer to
 * a question already asked.
 */
/** The page the customer comes back to, with the ride they were paying for. */
function returnUrl(rideId) {
  // eslint-disable-next-line global-require
  const phonepe = require('../config/phonepe');
  if (!phonepe.redirectUrl) return undefined;

  const separator = phonepe.redirectUrl.includes('?') ? '&' : '?';
  return `${phonepe.redirectUrl}${separator}ride=${encodeURIComponent(String(rideId))}`;
}

function newMerchantOrderId(rideId) {
  const stamp = Date.now();
  const salt = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RAAHI_${String(rideId)}_${stamp}_${salt}`;
}

/** The attempt currently being paid, if any. */
const liveAttempt = (payment) =>
  [...(payment.attempts || [])]
    .reverse()
    .find((attempt) => !TERMINAL_PAYMENT_STATUSES.includes(attempt.status) && attempt.status !== PAYMENT_STATUS.FAILED) || null;

/** An attempt by its merchant order id, whatever state it is in. */
const attemptByOrderId = (payment, merchantOrderId) =>
  (payment.attempts || []).find((attempt) => attempt.merchantOrderId === merchantOrderId) || null;

/**
 * Makes sure there is a live checkout for this fare, and returns it.
 *
 * Reuses an open attempt rather than opening a second one. That matters for
 * more than tidiness: two live orders for one ride means the customer can pay
 * the wrong one, and the one they paid is not the one being polled.
 *
 * The amount is fixed with the provider BEFORE the order is created, because
 * the short-payment guard later compares what arrived against `payment.amount`
 * — settling that after the gateway has been told a number would let the two
 * disagree, and the disagreement always favours whoever is paying.
 */
async function ensureCheckout(ride, payment, { provider }) {
  const open = liveAttempt(payment);
  if (open && open.checkoutUrl) return { attempt: open, reused: true };

  await fixAmountOwed(ride, payment, { recompute: !open });

  const merchantOrderId = newMerchantOrderId(ride._id);
  const shortRef = String(ride._id).slice(-6).toUpperCase();

  let order;
  try {
    order = await provider.createPayment({
      amount: payment.amount,
      currency: payment.currency,
      reference: merchantOrderId,
      description: `Raahi ride ${shortRef}`,
      /**
       * Where the customer lands afterwards, carrying the ride with them.
       *
       * The gateway sends them back to a URL of our choosing and says nothing
       * useful in it, so the ride id is put there by us — otherwise the page
       * they return to has no idea which payment it is looking at.
       *
       * It is an address, not an answer. The page it opens asks our own
       * backend what happened; nothing is settled because somebody arrived at
       * a URL, which anyone can do.
       */
      redirectUrl: returnUrl(ride._id),
      metaInfo: { udf1: String(ride._id), udf2: String(payment._id) }
    });
  } catch (err) {
    // The attempt is recorded even though it never opened, so a customer
    // tapping twice against a gateway that is down produces a readable history
    // rather than silence.
    payment.attempts.push({
      merchantOrderId,
      provider: provider.id,
      amount: payment.amount,
      status: PAYMENT_STATUS.FAILED,
      failureReason: err.message?.slice(0, 200) || 'The gateway could not be reached'
    });
    payment.failureReason = 'The payment could not be started. Please try again.';
    await payment.save();
    logger.error(`[Payment] could not open a checkout for ride ${ride._id}: ${err.message}`);
    throw err;
  }

  payment.attempts.push({
    merchantOrderId,
    providerOrderId: order.providerOrderId || null,
    provider: provider.id,
    amount: payment.amount,
    status: order.status || PAYMENT_STATUS.PROCESSING,
    checkoutUrl: order.checkoutUrl || order.checkoutRef || null,
    expiresAt: order.expiresAt || null
  });

  const attempt = payment.attempts[payment.attempts.length - 1];

  // Mirrored onto the payment so every existing reader — the poll, the admin
  // list, the old webhook lookup — keeps working without knowing about attempts.
  payment.provider = provider.id;
  payment.providerOrderId = order.providerRef || merchantOrderId;
  payment.checkoutUrl = attempt.checkoutUrl;
  payment.failureReason = null;
  payment.status = attempt.status;

  logger.info(`[Payment] checkout opened for ride ${ride._id} attempt ${merchantOrderId} via ${provider.id}`);

  return { attempt, reused: false };
}

/**
 * The customer paying for their own ride.
 *
 * The counterpart to the rider's collection flow, and the one a redirect
 * gateway needs: PhonePe hands back a URL that has to open on the payer's
 * device. The rider cannot do this part for them.
 *
 * Nothing about the amount, the ride or the rider comes from the request. The
 * customer supplies a ride id, their ownership of it is checked, and every
 * figure is read from the ride.
 */
async function startCheckout(rideId, customerId) {
  const { ride, payment } = await loadRidePayment(rideId);

  if (String(ride.customerId) !== String(customerId)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }

  assertCollectable(ride);

  if (payment.status === PAYMENT_STATUS.PAID) {
    throw ApiError.conflict('This fare has already been paid');
  }

  assertMethodAvailable(PAYMENT_METHOD.UPI);
  const provider = providers.active();

  if (payment.method !== PAYMENT_METHOD.UPI) {
    payment.method = PAYMENT_METHOD.UPI;
    ride.payment.method = PAYMENT_METHOD.UPI;
  }

  const { attempt, reused } = await ensureCheckout(ride, payment, { provider });
  await payment.save();

  ride.payment.status = payment.status;
  await ride.save();

  notifyParties(ride, payment);

  return {
    payment: publicPayment(payment),
    checkout: {
      url: attempt.checkoutUrl,
      merchantOrderId: attempt.merchantOrderId,
      expiresAt: attempt.expiresAt,
      reused
    },
    provider: { id: provider.id, label: provider.label, sandbox: !provider.isProduction }
  };
}

async function startUpiCollection(rideId, rider) {
  const { ride, payment } = await loadRidePayment(rideId);
  assertRidersRide(ride, rider);
  assertCollectable(ride);

  if (payment.status === PAYMENT_STATUS.PAID) {
    throw ApiError.conflict('This fare has already been paid');
  }

  assertMethodAvailable(PAYMENT_METHOD.UPI);
  const provider = providers.active();

  if (payment.method !== PAYMENT_METHOD.UPI) {
    payment.method = PAYMENT_METHOD.UPI;
    ride.payment.method = PAYMENT_METHOD.UPI;
  }

  // Same attempt as the customer's own checkout would open, so the two cannot
  // end up paying different orders for one ride.
  const { attempt } = await ensureCheckout(ride, payment, { provider });

  await payment.save();

  ride.payment.status = payment.status;
  await ride.save();

  const qr = await provider.generateQrCode({
    providerRef: attempt.merchantOrderId,
    checkoutUrl: attempt.checkoutUrl,
    amount: payment.amount,
    currency: payment.currency,
    note: `Raahi ride ${String(ride._id).slice(-6).toUpperCase()}`
  });

  notifyParties(ride, payment);

  return {
    payment: publicPayment(payment),
    qr,
    checkout: { url: attempt.checkoutUrl, merchantOrderId: attempt.merchantOrderId },
    provider: { id: provider.id, label: provider.label, sandbox: !provider.isProduction }
  };
}

/**
 * Asks the provider whether the money arrived, and settles if it did.
 *
 * This is the only route from "the customer says they paid" to a PAID payment,
 * and it does not take the customer's word for it — or the rider's. It asks the
 * gateway and believes the gateway.
 */
async function refreshUpiStatus(rideId, actor) {
  const { ride, payment } = await loadRidePayment(rideId);

  const isCustomer = String(payment.customerId) === String(actor.userId || actor._id);
  const isRider = payment.riderId && String(payment.riderId) === String(actor.riderId || actor._id);
  if (!isCustomer && !isRider) throw ApiError.forbidden('Not your payment');

  // A payment the gateway has already confirmed is not asked about again. But if
  // its money never made it to the ledger, this poll is the retry: settle it now
  // rather than reporting success over a ride that was never finished.
  if (payment.status === PAYMENT_STATUS.PAID) {
    if (isFullySettled(ride, payment)) return publicPayment(payment);
    return publicPayment(await settle(ride, payment, {}));
  }

  if (payment.method !== PAYMENT_METHOD.UPI || !payment.providerOrderId) {
    return publicPayment(payment);
  }

  const provider = providers.active();
  const result = await provider.verifyPayment(payment.providerOrderId);

  if (result.status === PAYMENT_STATUS.PAID) {
    // The amount the provider collected has to be the amount owed. A short
    // payment is not a payment; treating it as one would settle a ₹100 fare
    // for ₹10 and post the difference to nobody.
    if (isShortPayment(payment, result.amount)) {
      payment.status = PAYMENT_STATUS.FAILED;
      payment.failureReason = `Received ${payment.currency} ${result.amount} against a fare of ${payment.currency} ${payment.amount}`;
      await payment.save();
      notifyParties(ride, payment);
      return publicPayment(payment);
    }

    return publicPayment(await settle(ride, payment, { paidAt: result.paidAt }));
  }

  if (result.status !== payment.status && !TERMINAL_PAYMENT_STATUSES.includes(payment.status)) {
    payment.status = result.status;
    if (result.status === PAYMENT_STATUS.FAILED) payment.failureReason = 'The payment did not go through';
    await payment.save();

    ride.payment.status = payment.status;
    await ride.save();
    notifyParties(ride, payment);
  }

  return publicPayment(payment);
}

// ------------------------------------------------------------------ cash

/**
 * Cash is confirmed by the rider, who is the one actually handed the money.
 *
 * This is the single place in the system where a person's assertion settles a
 * payment, and it is limited to the method where no alternative exists. It
 * cannot be used to settle a UPI payment — the method check below is what stops
 * a rider from tapping their way past the gateway.
 */
async function confirmCashPayment(rideId, rider) {
  const { ride, payment } = await loadRidePayment(rideId);
  assertRidersRide(ride, rider);
  assertCollectable(ride);

  if (payment.method !== PAYMENT_METHOD.CASH) {
    throw ApiError.badRequest('This ride is not set to be paid in cash');
  }
  // Same retry as the UPI poll: PAID but not posted means the last attempt
  // failed after the flag was set, and this tap is what finishes it.
  if (isFullySettled(ride, payment)) return publicPayment(payment);

  assertMethodAvailable(PAYMENT_METHOD.CASH);

  return publicPayment(await settle(ride, payment, {}));
}

/**
 * A support agent settling a cash payment the rider could not.
 *
 * Goes through exactly the same settlement as the rider's own confirmation, and
 * that is the whole point of it existing here rather than in the admin service.
 * It used to flip the payment to PAID on its own: the commission was never
 * booked, the rider's debt was never recorded, the ride never left
 * AWAITING_PAYMENT, and the rider was left permanently unavailable — and because
 * the rider's own confirm then saw a PAID payment and returned, nobody could put
 * it right. One click lost the fare.
 *
 * There is deliberately no console equivalent for UPI. An agent clicking "paid"
 * on a UPI payment would be inventing a transaction that never happened.
 */
async function settleCashFromConsole(ride, payment) {
  if (payment.method !== PAYMENT_METHOD.CASH) {
    throw ApiError.badRequest(
      'Only cash payments can be settled from the console. A UPI payment has to be confirmed by the gateway.'
    );
  }

  if (isFullySettled(ride, payment)) return payment;
  return settle(ride, payment, {});
}

// -------------------------------------------------------------- settlement

/**
 * Marks the money in and finishes the ride.
 *
 * Safe to call twice: a payment already PAID short-circuits, and the ride
 * service's finalise is itself idempotent, so a webhook arriving twice or a
 * poll racing a webhook both end with one set of ledger entries.
 */
async function settle(ride, payment, { paidAt = null } = {}) {
  // Required here rather than at the top of the file: the ride service owns the
  // lifecycle and calls into this one to create the payment, so a module-level
  // require in both directions would be circular.
  // eslint-disable-next-line global-require
  const rideService = require('./ride.service');

  /**
   * The ledger first, the flag second.
   *
   * This used to run the other way round, and that ordering lost money. Both
   * doors into settlement refuse to re-enter a payment already marked PAID, so
   * a failure between the flag and the posting left a ride whose money had
   * never been recorded and which nobody — not the rider, not the gateway, not
   * support — could settle again. The rider was holding the customer's cash
   * with no debt against them.
   *
   * Posting first inverts the failure: the worst case is a correct ledger and a
   * payment still marked pending, which the next tap or the next webhook
   * finishes, because `finaliseRide` returns quietly on a ride already
   * complete.
   */
  /**
   * Cash closes the payment clock here.
   *
   * A UPI ride already closed it when its order was raised, and `stopPayment`
   * refuses to close twice — so the amount the gateway collected stays the
   * amount the ledger posts. For cash there is no earlier moment: the rider
   * confirms, and that confirmation is when the waiting stops.
   *
   * Before `finaliseRide`, because that is what reads the split and posts it.
   */
  await fixAmountOwed(ride, payment);

  await rideService.finaliseRide(ride, payment);

  if (payment.status !== PAYMENT_STATUS.PAID) {
    payment.status = PAYMENT_STATUS.PAID;
    payment.settledAt = paidAt ? new Date(paidAt) : new Date();
    await payment.save();
  }

  ride.payment.status = PAYMENT_STATUS.PAID;
  await ride.save();

  notifyParties(ride, payment);
  return payment;
}

/**
 * Whether a payment marked PAID has actually had its money posted.
 *
 * The two are separate facts, and the gap between them is a settlement that
 * failed part way. A PAID payment on a ride still awaiting one is not finished
 * business — it is a retry waiting to happen.
 */
const isFullySettled = (ride, payment) =>
  payment.status === PAYMENT_STATUS.PAID && ride.status === RIDE_STATUS.COMPLETED;

/**
 * Whether the provider collected less than the fare.
 *
 * Shared by the poll and the webhook because they are two routes to the same
 * decision, and the webhook used to skip it — a gateway confirming ₹10 against a
 * ₹100 fare settled the whole thing and posted a commission on money that never
 * arrived.
 */
const isShortPayment = (payment, amount) =>
  amount != null && Number(amount) + 0.001 < payment.amount;

/**
 * A gateway calling us back.
 *
 * The signature is checked before anything else, and a body that cannot be
 * proven to come from the provider is dropped. Then the payment is re-verified
 * against the provider rather than trusted from the body — a callback is a
 * prompt to go and look, not a source of truth.
 */
async function handleWebhook({ rawBody, signature, body }) {
  const provider = providers.active();

  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    throw ApiError.unauthorized('Webhook signature could not be verified');
  }

  /**
   * Which payment this callback is about.
   *
   * Providers disagree about where they put the reference, so the provider
   * says. One that offers `parseWebhook` — PhonePe does, because its callbacks
   * are an `event` plus a nested `payload` — is asked; anything else falls back
   * to the flat shapes the older providers use.
   *
   * Only the IDENTIFIER is taken from the body. What the payment is worth and
   * whether it succeeded are asked of the provider directly below, because a
   * callback body is the one input an attacker would most like to write.
   */
  const parsed = typeof provider.parseWebhook === 'function' ? provider.parseWebhook(body) : null;
  const reference = parsed?.merchantOrderId || body?.providerRef || body?.order_id || body?.id;

  if (!reference) throw ApiError.badRequest('Webhook carried no payment reference');

  if (parsed?.isRefund) {
    // A refund callback is a nudge, not a verdict — exactly like a payment one.
    // It tells us which refund to go and ask about; whether the money actually
    // went back is decided by the gateway's refund status API inside
    // `refreshRefund`, which is also the only place the ledger moves.
    const refundRef = parsed.merchantRefundId || reference;
    logger.info(`[Payment] refund callback ${parsed.event} for ${refundRef}`);

    const refunded = await Payment.findOne({ 'refund.merchantRefundId': refundRef });
    if (!refunded) {
      logger.warn(`[Payment] refund callback for unknown refund ${refundRef}`);
      return { handled: false, event: parsed.event };
    }

    const outcome = await refreshRefund(refunded);
    return { handled: true, event: parsed.event, refundStatus: outcome.refund.status };
  }

  const payment = await Payment.findOne({
    $or: [{ 'attempts.merchantOrderId': reference }, { providerOrderId: reference }]
  });

  if (!payment) {
    // Not a fare. A rider topping up their platform balance pays through the
    // same gateway and the callback looks identical, so before giving up this
    // asks whether the reference belongs to a recharge. Without this the
    // callback had nowhere to land and a recharge only ever settled when the
    // rider happened to have the screen open to poll it.
    // Required here rather than at the top: recharges already reach into this
    // module's provider registry, and a cycle at load time is not worth the
    // tidiness of one import line.
    // eslint-disable-next-line global-require
    const recharges = require('./recharge.service');
    const recharge = await recharges.settleFromCallback(reference);
    if (recharge) return { handled: true, kind: 'recharge', status: recharge.status };

    logger.warn(`[Payment] callback for unknown reference ${reference}`);
    return { handled: false };
  }

  const attempt = attemptByOrderId(payment, reference);
  if (attempt) {
    attempt.callbackReceived = true;
    attempt.callbackAt = new Date();
  }

  const ride = await Ride.findById(payment.rideId);
  if (!ride) return { handled: false };

  /**
   * Already settled, so there is nothing left to do.
   *
   * PhonePe retries callbacks, and a retry that arrived after the poll had
   * already settled the ride must not run the money path a second time. The
   * ledger would refuse the duplicate anyway — every entry is keyed on the
   * ride — but returning here means the common duplicate costs one read
   * instead of a gateway round trip and a transaction that rolls itself back.
   */
  if (isFullySettled(ride, payment)) {
    await payment.save();
    logger.info(`[Payment] duplicate callback ignored for ride ${ride._id}`);
    return { handled: true, status: PAYMENT_STATUS.PAID, duplicate: true };
  }

  const result = await provider.verifyPayment(reference);
  applyProviderResult(payment, attempt, result);

  if (result.status !== PAYMENT_STATUS.PAID) {
    await payment.save();
    notifyParties(ride, payment);
    return { handled: true, status: result.status };
  }

  // The same short-payment guard the poll applies. Whichever route confirms
  // first decides the ride, so both have to refuse an underpayment or the
  // callback becomes the cheaper way to settle a ₹100 fare for ₹10.
  if (isShortPayment(payment, result.amount)) {
    payment.status = PAYMENT_STATUS.FAILED;
    payment.failureReason = `Received ${payment.currency} ${result.amount} against a fare of ${payment.currency} ${payment.amount}`;
    if (attempt) attempt.status = PAYMENT_STATUS.FAILED;
    await payment.save();
    notifyParties(ride, payment);
    return { handled: true, status: PAYMENT_STATUS.FAILED };
  }

  await settle(ride, payment, { paidAt: result.paidAt });
  return { handled: true, status: PAYMENT_STATUS.PAID };
}

/**
 * Copies what the provider reported onto the payment and its attempt.
 *
 * Kept in one place because the poll and the callback both need it and they
 * used to do it differently — the poll recorded the transaction id and the
 * callback did not, so which route confirmed a payment changed what support
 * could see about it afterwards.
 */
function applyProviderResult(payment, attempt, result) {
  if (result.providerPaymentId) payment.providerPaymentId = result.providerPaymentId;

  if (attempt) {
    attempt.status = result.status;
    if (result.providerOrderId) attempt.providerOrderId = result.providerOrderId;
    if (result.providerPaymentId) attempt.providerPaymentId = result.providerPaymentId;
    if (result.paymentMode) attempt.paymentMode = result.paymentMode;
    if (result.raw) attempt.meta = result.raw;
    if (result.status === PAYMENT_STATUS.FAILED) {
      attempt.failureReason = result.failureReason || 'The payment did not go through.';
    }
  }

  if (result.status === PAYMENT_STATUS.FAILED) {
    payment.failureReason = result.failureReason || 'The payment did not go through.';
  }
}

/**
 * The authoritative status of one payment, for the customer watching it.
 *
 * Addressed by payment id rather than ride id because that is what a payment
 * screen holds after a redirect, and because the brief for this integration
 * asks for it that way. Ownership is checked against the payment, not a role.
 *
 * It re-asks the provider only when there is something to ask about — an
 * in-flight attempt. A screen polling a settled payment costs a read here and
 * nothing at the gateway.
 */
async function statusForPayment(paymentId, actor) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw ApiError.notFound('Payment not found');

  const ownedByCustomer = String(payment.customerId) === String(actor.userId || '');
  const ownedByRider = actor.riderId && String(payment.riderId) === String(actor.riderId);
  if (!ownedByCustomer && !ownedByRider) {
    throw ApiError.forbidden('This payment does not belong to you');
  }

  const ride = await Ride.findById(payment.rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  if (isFullySettled(ride, payment)) return { payment: publicPayment(payment), rideStatus: ride.status };

  const attempt = liveAttempt(payment);
  if (payment.method !== PAYMENT_METHOD.UPI || !attempt) {
    return { payment: publicPayment(payment), rideStatus: ride.status };
  }

  const provider = providers.active();
  const result = await provider.verifyPayment(attempt.merchantOrderId);
  applyProviderResult(payment, attempt, result);

  if (result.status === PAYMENT_STATUS.PAID && !isShortPayment(payment, result.amount)) {
    await settle(ride, payment, { paidAt: result.paidAt });
    return { payment: publicPayment(payment), rideStatus: ride.status };
  }

  if (result.status === PAYMENT_STATUS.PAID) {
    payment.status = PAYMENT_STATUS.FAILED;
    payment.failureReason = `Received ${payment.currency} ${result.amount} against a fare of ${payment.currency} ${payment.amount}`;
  } else if (!TERMINAL_PAYMENT_STATUSES.includes(result.status)) {
    payment.status = result.status;
  }

  await payment.save();
  ride.payment.status = payment.status;
  await ride.save();
  notifyParties(ride, payment);

  return { payment: publicPayment(payment), rideStatus: ride.status };
}

/**
 * Asks the gateway to send a settled fare back.
 *
 * Deliberately does NOT move the ledger. PhonePe accepts a refund and settles
 * it asynchronously, so the money has not gone anywhere when this returns —
 * writing a reversal now would mean the books say a customer was refunded
 * because we asked, which is the fake refund this must not be. The ledger moves
 * in `refreshRefund`, once the provider confirms.
 */
async function requestRefund(paymentId, { amount = null, reason = null, admin = null } = {}) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw ApiError.notFound('Payment not found');

  if (payment.status !== PAYMENT_STATUS.PAID) {
    throw ApiError.conflict('Only a paid fare can be refunded');
  }
  if (payment.refundedAt) throw ApiError.conflict('This fare has already been refunded');

  // A refund already with the gateway is not a reason to ask again. Asking twice
  // means two refund ids against one payment, and PhonePe would settle both.
  if (payment.refund?.merchantRefundId && payment.refund.status !== PAYMENT_STATUS.FAILED) {
    throw ApiError.conflict('A refund for this fare is already with the gateway');
  }

  const provider = providers.active();
  if (typeof provider.refund !== 'function') {
    throw ApiError.notImplemented(`${provider.label} does not support refunds through Raahi yet.`);
  }

  const settledAttempt =
    (payment.attempts || []).find((a) => a.status === PAYMENT_STATUS.PAID) || liveAttempt(payment);
  if (!settledAttempt) throw ApiError.conflict('This payment has no gateway attempt to refund');

  const value = amount == null ? payment.amount : Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > payment.amount) {
    throw ApiError.badRequest('A refund cannot be for more than the fare', [
      { field: 'amount', message: `Between 0 and ${payment.amount}` }
    ]);
  }

  // PARTIAL REFUNDS ARE NOT SUPPORTED, and are refused rather than half-done.
  // The ledger reverses a ride line for line, with keys derived from the ride,
  // so there is no honest way to post four-fifths of that. Doing it properly
  // means deciding whose share shrinks — the rider's, the platform's, or both
  // in proportion — which is a commercial policy, not an arithmetic detail.
  if (round2(value) !== round2(payment.amount)) {
    throw ApiError.badRequest('Raahi can only refund a fare in full', [
      { field: 'amount', message: `Must be the whole fare of ${payment.amount}` }
    ]);
  }

  const merchantRefundId = `RFND_${String(payment._id)}_${Date.now()}`;

  const result = await provider.refund({
    merchantRefundId,
    originalMerchantOrderId: settledAttempt.merchantOrderId,
    amount: value
  });

  payment.refund = {
    merchantRefundId,
    providerRefundId: result.refundId || null,
    amount: value,
    status: result.status,
    requestedAt: new Date(),
    settledAt: null,
    failureReason: null,
    reason: reason ? String(reason).trim() : null,
    requestedBy: admin?._id || null
  };
  await payment.save();

  logger.info(
    `[Payment] refund requested for payment ${payment._id} ref ${merchantRefundId}` +
      (admin ? ` by admin ${admin._id}` : '')
  );

  // A gateway can settle a refund instantly. Ask once, so a refund that is
  // already done does not sit looking pending until somebody reloads.
  const settled = await refreshRefund(payment);

  return { refund: settled.refund, status: settled.refund.status };
}

/**
 * Re-asks the gateway what became of a refund, and moves the ledger if it is done.
 *
 * THIS IS THE ONLY PLACE A REFUND BECOMES REAL. Neither the admin's request nor
 * PhonePe's callback is believed: the request is us talking, and a callback is
 * an unauthenticated claim about somebody else's money until the status API
 * confirms it. So both of those do nothing but bring us here.
 *
 * The reversal itself goes through the same `walletService.refundRide` the admin
 * console uses, with the same ride-derived idempotency keys. That is deliberate:
 * a refund settled twice, or refunded here after being reversed by hand, posts
 * nothing the second time because the database refuses the duplicate key — not
 * because a check happened to run.
 *
 * Accepts a payment document or an id, because the request path already has one
 * loaded and re-reading it would be a second chance to disagree with itself.
 */
async function refreshRefund(paymentOrId) {
  const payment =
    typeof paymentOrId === 'object' && paymentOrId?.save
      ? paymentOrId
      : await Payment.findById(paymentOrId);

  if (!payment) throw ApiError.notFound('Payment not found');
  if (!payment.refund?.merchantRefundId) {
    throw ApiError.conflict('No refund has been requested for this fare');
  }

  // Already settled. Nothing to ask, and nothing left to post.
  if (payment.refund.settledAt) return { refund: payment.refund, posted: 0, changed: false };

  const provider = providers.active();
  if (typeof provider.refundStatus !== 'function') {
    throw ApiError.notImplemented(`${provider.label} cannot report refund status.`);
  }

  const result = await provider.refundStatus(payment.refund.merchantRefundId);

  if (result.status === PAYMENT_STATUS.FAILED) {
    payment.refund.status = PAYMENT_STATUS.FAILED;
    payment.refund.failureReason = result.failureReason || 'The gateway could not refund this fare';
    await payment.save();
    logger.warn(`[Payment] refund ${payment.refund.merchantRefundId} failed at the gateway`);
    return { refund: payment.refund, posted: 0, changed: true };
  }

  if (result.status !== PAYMENT_STATUS.PAID) {
    // Still in flight. Record what the gateway said and leave the books alone.
    const was = payment.refund.status;
    payment.refund.status = result.status;
    if (was !== result.status) await payment.save();
    return { refund: payment.refund, posted: 0, changed: was !== result.status };
  }

  // Confirmed. Now, and only now, the money comes back out of the books.
  const walletService = require('./wallet.service');
  const ride = await Ride.findById(payment.rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  const split = fareService.splitOf(ride);
  const posted = await walletService.refundRide({
    ride,
    split,
    method: payment.method,
    paymentId: payment._id,
    reason: payment.refund.reason || 'Refunded through the payment gateway'
  });

  payment.refund.status = PAYMENT_STATUS.PAID;
  payment.refund.settledAt = new Date();
  payment.refund.providerRefundId = result.refundId || payment.refund.providerRefundId;
  payment.status = PAYMENT_STATUS.REFUNDED;
  payment.refundedAt = payment.refundedAt || payment.refund.settledAt;
  await payment.save();

  await Ride.updateOne({ _id: ride._id }, { $set: { 'payment.status': PAYMENT_STATUS.REFUNDED } });

  logger.info(
    `[Payment] refund ${payment.refund.merchantRefundId} confirmed; ` +
      `${posted.posted.length} ledger entries posted`
  );

  return { refund: payment.refund, posted: posted.posted.length, changed: true };
}

// ----------------------------------------------------------------- reading

/**
 * Somebody's own payments, newest first.
 *
 * SCOPED BY WHO IS ASKING, not by a parameter. There is no customer id or rider
 * id in the request, because the moment there is, this route is one guessed
 * ObjectId away from being somebody else's payment history — and a fare, a
 * method and a settlement time are exactly the sort of thing that should not
 * leak. A rider sees the rides they drove; a customer sees the rides they took.
 *
 * The rows are the same `publicPayment` shape the ride screen uses, so a
 * gateway order id is no more visible here than it is there. The ride is
 * populated for what a person actually recognises a trip by — where they went,
 * and when.
 */
async function historyFor(actor, { page = 1, limit = 20 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * size;

  const filter = actor.riderId ? { riderId: actor.riderId } : { customerId: actor.userId };

  const [rows, total] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size)
      .populate('rideId', 'pickup.address destination.address status completedAt createdAt'),
    Payment.countDocuments(filter)
  ]);

  return {
    items: rows.map((payment) => {
      const ride = payment.rideId && typeof payment.rideId === 'object' ? payment.rideId : null;

      return {
        ...publicPayment(payment),
        // `populate` replaced the id with the document, and `publicPayment`
        // would have passed that whole ride — rider id and all — into the
        // response. Put the id back.
        rideId: String(ride?._id || payment.rideId),
        ride: ride
          ? {
              id: String(ride._id),
              status: ride.status,
              pickup: ride.pickup?.address || null,
              destination: ride.destination?.address || null,
              at: ride.completedAt || ride.createdAt
            }
          : null
      };
    }),
    page: Math.max(Number(page) || 1, 1),
    limit: size,
    total,
    pages: Math.max(Math.ceil(total / size), 1)
  };
}

async function getForRide(rideId, actor) {
  // Through the loader, so a finished trip whose payment row never got written
  // heals on the next read instead of showing both parties a dead end. This is
  // the call behind the rider's "collect the fare" panel, which is exactly
  // where being told there is no payment record leaves them with nothing to do.
  const { payment } = await loadRidePayment(rideId);

  // Ownership, not role. This checked `role !== 'rider'`, which let any signed-in
  // rider read the fare, method and settlement time of any ride in the system —
  // including rides they had nothing to do with.
  const isCustomer = String(payment.customerId) === String(actor.userId || actor._id);
  const isRider = payment.riderId && actor.riderId && String(payment.riderId) === String(actor.riderId);
  if (!isCustomer && !isRider) throw ApiError.forbidden('Not your payment');

  return publicPayment(payment);
}

/**
 * What either app is allowed to know about a payment.
 *
 * Provider references are deliberately absent. They are how a gateway is
 * queried, and a ride's payment screen has no use for one.
 */
const publicPayment = (payment) => ({
  id: payment._id,
  rideId: payment.rideId,
  amount: payment.amount,
  currency: payment.currency,
  method: payment.method,
  status: payment.status,
  provider: payment.provider || null,
  failureReason: payment.failureReason,
  settledAt: payment.settledAt,
  createdAt: payment.createdAt,

  /**
   * Where the customer was sent, while there is still a payment to finish.
   *
   * Included so a reload lands back on the checkout instead of a dead end —
   * the URL is not a secret, it is the page the customer is meant to be on.
   * Dropped once the payment is settled or dead, because a live-looking link
   * to a closed order is worse than no link.
   */
  checkoutUrl: TERMINAL_PAYMENT_STATUSES.includes(payment.status) ? null : payment.checkoutUrl || null,

  /**
   * How many times this fare has been attempted, and whether one is open.
   * Enough for the screen to say "try again" honestly without exposing the
   * gateway's own identifiers, which stay out of every client payload.
   */
  attempts: (payment.attempts || []).length,

  // A customer may see that their fare is coming back and when it did. They
  // may not see the gateway's refund id, or the note the admin wrote.
  refund: payment.refund?.status
    ? {
        status: payment.refund.status,
        amount: payment.refund.amount,
        settledAt: payment.refund.settledAt || null
      }
    : null
});

function notifyParties(ride, payment) {
  const body = {
    rideId: ride._id,
    paymentId: payment._id,
    method: payment.method,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    rideStatus: ride.status
  };

  notifications.toCustomer(ride.customerId, SOCKET_EVENTS.PAYMENT_UPDATED, body);
  if (ride.riderId) notifications.toRider(ride.riderId, SOCKET_EVENTS.PAYMENT_UPDATED, body);
}

/** What the rider's payment screen needs to draw itself, without guessing. */
function methodOptions() {
  const provider = providers.active();

  return [
    {
      method: PAYMENT_METHOD.CASH,
      enabled: settings.get('payment.cashEnabled') === true,
      label: 'Cash',
      description: 'The customer hands you the fare.'
    },
    {
      method: PAYMENT_METHOD.UPI,
      enabled: providers.upiAvailable(),
      label: 'UPI',
      description: 'The customer scans a code and pays the platform.',
      unavailableReason: providers.upiAvailable()
        ? null
        : provider.unavailableReason || 'UPI is turned off at the moment'
    }
  ];
}

module.exports = {
  createForRide,
  startCheckout,
  statusForPayment,
  requestRefund,
  refreshRefund,
  selectMethod,
  setMethodForRide,
  confirmCashPayment,
  settleCashFromConsole,
  startUpiCollection,
  refreshUpiStatus,
  handleWebhook,
  getForRide,
  historyFor,
  methodOptions,
  publicPayment,
  // Exported for tests. Both are decisions that used to be wrong — one route
  // skipped the short-payment check, and a PAID flag was read as "finished"
  // when the money had never been posted.
  isFullySettled,
  isShortPayment
};
