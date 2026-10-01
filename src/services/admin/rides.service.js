const mongoose = require('mongoose');
const Ride = require('../../models/Ride');
const Rider = require('../../models/Rider');
const RideRequest = require('../../models/RideRequest');
const Payment = require('../../models/Payment');
const ApiError = require('../../utils/ApiError');
const audit = require('../audit.service');
const { round2 } = require('../../utils/calculateFare');
const complaintService = require('../complaint.service');
const paymentService = require('../payment.service');
const matchingService = require('../matching.service');
const chatService = require('../chat.service');
const notifications = require('../notification.service');
const { SOCKET_EVENTS } = require('../../constants/socketEvents');
const { RIDE_STATUS, ACTIVE_RIDE_STATUSES, canTransition } = require('../../constants/rideStatus');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../../constants/paymentStatus');

/**
 * Ride operations from the console.
 *
 * Reading is unrestricted to anyone with rides.read. Writing is not: the only
 * mutation offered is cancelling a stuck ride, and it goes through the same
 * state machine the customer and rider flows use. An admin cannot set a ride to
 * an arbitrary status, because a ride's status is a claim about what happened in
 * the physical world, and letting the console rewrite that would make the whole
 * lifecycle meaningless.
 */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjectId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ''));

async function list({
  page = 1,
  limit = 25,
  status,
  paymentStatus,
  paymentMethod,
  customerId,
  riderId,
  search,
  from,
  to
} = {}) {
  const filter = {};

  if (status === 'ACTIVE') filter.status = { $in: ACTIVE_RIDE_STATUSES };
  else if (status) filter.status = status;

  if (paymentStatus) filter['payment.status'] = paymentStatus;
  if (paymentMethod) filter['payment.method'] = paymentMethod;
  if (customerId) filter.customerId = customerId;
  if (riderId) filter.riderId = riderId;

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  // A ride id is the useful search; an address search is a convenience on top.
  if (search) {
    if (isObjectId(search)) {
      filter._id = new mongoose.Types.ObjectId(search);
    } else {
      const term = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ 'pickup.address': term }, { 'destination.address': term }];
    }
  }

  const [rides, total] = await Promise.all([
    Ride.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select(
        'status pickup.address destination.address estimatedDistanceKm finalDistanceKm estimatedFare finalFare fareRatePerKm currency payment customerId riderId createdAt acceptedAt completedAt rating'
      )
      .populate('customerId', 'name phone')
      .lean(),
    Ride.countDocuments(filter)
  ]);

  // Rider names in one query for the page, rather than a populate per row.
  const riderIds = [...new Set(rides.map((ride) => ride.riderId).filter(Boolean).map(String))];
  const riders = riderIds.length
    ? await Rider.find({ _id: { $in: riderIds } })
        .select('userId vehicle')
        .populate('userId', 'name phone')
        .lean()
    : [];
  const riderBy = new Map(riders.map((rider) => [String(rider._id), rider]));

  return {
    rides: rides.map((ride) => ({
      ...ride,
      customer: ride.customerId,
      rider: ride.riderId ? riderBy.get(String(ride.riderId)) || null : null
    })),
    total,
    page,
    limit
  };
}

/**
 * The timeline the ride detail page draws.
 *
 * Built from the stamps the ride actually carries, so a step with no stamp shows
 * as not reached rather than being invented. A cancelled ride keeps whatever it
 * got through before it stopped.
 */
function buildTimeline(ride, payment = null) {
  const steps = [
    { key: 'REQUESTED', label: 'Requested', at: ride.createdAt },
    { key: 'ACCEPTED', label: 'Accepted', at: ride.acceptedAt },
    { key: 'ARRIVING', label: 'On the way', at: ride.arrivingAt },
    { key: 'ARRIVED', label: 'Arrived at pickup', at: ride.arrivedAt },
    { key: 'OTP_VERIFIED', label: 'Code verified', at: ride.otp?.verifiedAt },
    { key: 'IN_PROGRESS', label: 'Trip started', at: ride.startedAt },
    { key: 'COMPLETED', label: 'Completed', at: ride.completedAt },
    {
      // Settlement time lives on the Payment record, not the ride's embedded
      // copy, so it is read from there when the caller has loaded it.
      key: 'PAYMENT',
      label: payment?.status === PAYMENT_STATUS.PAID ? 'Payment settled' : 'Payment pending',
      at: payment?.status === PAYMENT_STATUS.PAID ? payment.settledAt || null : null
    }
  ];

  const timeline = steps.map((step) => ({ ...step, at: step.at || null, reached: Boolean(step.at) }));

  if (ride.status === RIDE_STATUS.CANCELLED) {
    timeline.push({
      key: 'CANCELLED',
      label: `Cancelled by ${ride.cancellation?.by || 'system'}`,
      at: ride.cancellation?.at || null,
      reached: true,
      terminal: true
    });
  }

  return timeline;
}

async function detail(rideId) {
  const ride = await Ride.findById(rideId).populate('customerId', 'name email phone isActive createdAt').lean();
  if (!ride) throw ApiError.notFound('Ride not found');

  // The pickup code is never exposed here, not even as a hash. An admin who
  // could read it could start someone's trip.
  delete ride.otp?.hash;
  delete ride.otp?.enc;

  const [rider, payment, requests, complaints, chat, trail] = await Promise.all([
    ride.riderId
      ? Rider.findById(ride.riderId)
          .select('userId vehicle rating totalRides currentLocation isOnline')
          .populate('userId', 'name email phone isActive')
          .lean()
      : null,
    Payment.findOne({ rideId: ride._id }).lean(),
    // Who was offered this ride and what they did with it: the first thing to
    // look at when a customer says nobody picked them up.
    RideRequest.find({ rideId: ride._id })
      .sort({ createdAt: 1 })
      .select('riderId status distanceToPickupKm expiresAt respondedAt createdAt')
      .lean(),
    complaintService.forRide(ride._id),
    chatService
      .adminViewConversation(ride._id)
      .then((result) => ({ exists: true, messageCount: result.messages.length, status: result.conversation.status }))
      .catch(() => ({ exists: false })),
    audit.forResource('Ride', ride._id)
  ]);

  return {
    ride: {
      ...ride,
      customer: ride.customerId,
      pricing: ride.pricing || { ratePerKm: ride.fareRatePerKm, currency: ride.currency }
    },
    rider,
    payment,
    requests,
    complaints,
    chat,
    timeline: buildTimeline(ride, payment),
    auditTrail: trail
  };
}

/**
 * Cancels a ride that is stuck.
 *
 * This exists because a real platform has rides that neither party ends — a
 * rider whose phone died mid-trip leaves the customer unable to book again. It
 * runs the same cleanup the normal cancellation does: the rider is freed,
 * pending requests are withdrawn, the chat is closed and both sides are told.
 */
async function cancelRide(req, rideId, reason) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
    throw ApiError.conflict(`This ride is already ${ride.status}`);
  }
  if (!canTransition(ride.status, RIDE_STATUS.CANCELLED)) {
    throw ApiError.conflict(`A ride cannot go from ${ride.status} to CANCELLED`);
  }

  const previousStatus = ride.status;

  ride.status = RIDE_STATUS.CANCELLED;
  ride.cancellation = { by: 'system', reason: reason || 'Cancelled by support', at: new Date() };
  if (ride.payment.status === PAYMENT_STATUS.PENDING) ride.payment.status = PAYMENT_STATUS.FAILED;
  await ride.save();

  await matchingService.cancelPendingRequests(ride._id, 'Cancelled by support');

  if (ride.riderId) {
    await Rider.updateOne({ _id: ride.riderId }, { isAvailable: true, activeRideId: null });
    notifications.toRider(ride.riderId, SOCKET_EVENTS.RIDE_CANCELLED, {
      rideId: ride._id,
      cancelledBy: 'system',
      reason: ride.cancellation.reason
    });
  }

  notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_CANCELLED, {
    rideId: ride._id,
    cancelledBy: 'system',
    reason: ride.cancellation.reason
  });

  await chatService.closeForRide(ride).catch(() => {});

  await audit.record(req, {
    action: 'ride.cancel',
    resource: 'Ride',
    resourceId: ride._id,
    oldValue: { status: previousStatus },
    newValue: { status: ride.status },
    note: reason || null
  });

  return { id: ride._id, status: ride.status };
}

// ----------------------------------------------------------------- payments

/**
 * What the payment gateway is doing, for the admin settings screen.
 *
 * Counts rather than money movements: the ledger is where money is accounted
 * for, and this is an operational view — is the gateway configured, is it
 * pointed at sandbox or production, and how many payments are getting through.
 *
 * Nothing secret is in the response. The provider's `describe()` and the
 * PhonePe config's `describe()` both return only the safe half; there is no
 * code path that puts a client secret or a webhook password into an API.
 */
async function paymentOverview() {
  // eslint-disable-next-line global-require
  const providers = require('../payments');
  // eslint-disable-next-line global-require
  const { PAYMENT_STATUS, PAYMENT_METHOD } = require('../../constants/paymentStatus');

  const provider = providers.active();

  const [byStatus, online] = await Promise.all([
    Payment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    Payment.aggregate([
      { $match: { method: PAYMENT_METHOD.UPI, status: PAYMENT_STATUS.PAID } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
    ])
  ]);

  const counts = Object.fromEntries(byStatus.map((row) => [row._id, row.count]));

  /**
   * The provider's own configuration, when it has any to describe.
   *
   * Asked of the provider rather than switched on its id, so adding a second
   * gateway does not mean editing this function — and so a provider that keeps
   * no configuration simply reports none.
   */
  const configuration =
    provider.id === 'phonepe'
      ? // eslint-disable-next-line global-require
        require('../../config/phonepe').describe()
      : null;

  return {
    provider: providers.describe(),
    configuration,
    counts: {
      success: counts[PAYMENT_STATUS.PAID] || 0,
      failed: counts[PAYMENT_STATUS.FAILED] || 0,
      pending: (counts[PAYMENT_STATUS.PENDING] || 0) + (counts[PAYMENT_STATUS.PROCESSING] || 0),
      cancelled: counts[PAYMENT_STATUS.CANCELLED] || 0,
      refunded: counts[PAYMENT_STATUS.REFUNDED] || 0
    },
    online: {
      collected: round2(online[0]?.amount || 0),
      payments: online[0]?.count || 0
    }
  };
}

/**
 * An admin asking the gateway to refund a fare.
 *
 * Thin on purpose: the payment service owns the rule that a refund is not a
 * refund until the provider confirms it, and duplicating any part of that here
 * would give the console its own opinion about when money moved.
 */
async function refundPayment(req, paymentId, { amount, reason }) {
  const result = await paymentService.requestRefund(paymentId, { amount, reason, admin: req.admin });

  await audit.record(req, {
    action: 'payment.refund',
    resource: 'Payment',
    resourceId: paymentId,
    newValue: { amount: result.refund.amount, status: result.status },
    note: reason
  });

  return result;
}

/**
 * Asking the gateway again what became of a refund.
 *
 * A refund can settle minutes or hours after it is asked for, and the callback
 * that would have told us may never arrive — a tunnel that was down, a webhook
 * misconfigured, a retry budget spent. This is the manual version of the same
 * question, and it goes through the same code, so a refund reconciled from the
 * console and one confirmed by a callback are the same event with the same
 * ledger rows.
 *
 * It is audited even when nothing changed, because "an admin checked and it was
 * still pending" is worth being able to see afterwards.
 */
async function reconcileRefund(req, paymentId) {
  const result = await paymentService.refreshRefund(paymentId);

  await audit.record(req, {
    action: 'payment.refund.reconcile',
    resource: 'Payment',
    resourceId: paymentId,
    newValue: {
      status: result.refund.status,
      settledAt: result.refund.settledAt,
      ledgerEntriesPosted: result.posted
    }
  });

  return result;
}

async function listPayments({
  page = 1,
  limit = 25,
  status,
  method,
  customerId,
  riderId,
  search,
  from,
  to
} = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (method) filter.method = method;
  if (customerId) filter.customerId = customerId;
  if (riderId) filter.riderId = riderId;
  if (search && isObjectId(search)) filter.rideId = new mongoose.Types.ObjectId(search);

  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const [payments, total, totals] = await Promise.all([
    Payment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('customerId', 'name phone')
      .lean(),
    Payment.countDocuments(filter),
    // The filtered total, so the header figure matches what is on screen rather
    // than being the sum of one page.
    Payment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          amount: { $sum: '$amount' },
          settled: { $sum: { $cond: [{ $eq: ['$status', PAYMENT_STATUS.PAID] }, '$amount', 0] } }
        }
      }
    ])
  ]);

  const riderIds = [...new Set(payments.map((p) => p.riderId).filter(Boolean).map(String))];
  const riders = riderIds.length
    ? await Rider.find({ _id: { $in: riderIds } }).select('userId').populate('userId', 'name phone').lean()
    : [];
  const riderBy = new Map(riders.map((rider) => [String(rider._id), rider]));

  const sums = totals[0] || { amount: 0, settled: 0 };

  return {
    payments: payments.map((payment) => ({
      ...payment,
      customer: payment.customerId,
      rider: riderBy.get(String(payment.riderId)) || null
    })),
    totals: {
      amount: Math.round(sums.amount * 100) / 100,
      settled: Math.round(sums.settled * 100) / 100,
      outstanding: Math.round((sums.amount - sums.settled) * 100) / 100
    },
    total,
    page,
    limit
  };
}

async function paymentDetail(paymentId) {
  const payment = await Payment.findById(paymentId).populate('customerId', 'name email phone').lean();
  if (!payment) throw ApiError.notFound('Payment not found');

  const [ride, rider, trail] = await Promise.all([
    Ride.findById(payment.rideId)
      .select('status pickup.address destination.address finalDistanceKm finalFare fareRatePerKm pricing currency createdAt completedAt')
      .lean(),
    Rider.findById(payment.riderId).select('userId vehicle').populate('userId', 'name phone').lean(),
    audit.forResource('Payment', payment._id)
  ]);

  return { payment: { ...payment, customer: payment.customerId }, ride, rider, auditTrail: trail };
}

/**
 * Marks a cash payment settled when the rider could not.
 *
 * Only cash, and only from PENDING. UPI settlement has to come from a gateway
 * callback — a support agent clicking "paid" on a UPI payment would be inventing
 * a transaction that never happened, and the money would never arrive.
 */
async function settleCashPayment(req, paymentId, note) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw ApiError.notFound('Payment not found');

  if (payment.method !== PAYMENT_METHOD.CASH) {
    throw ApiError.badRequest(
      'Only cash payments can be settled from the console. A UPI payment has to be confirmed by the gateway.'
    );
  }
  const ride = await Ride.findById(payment.rideId);
  if (!ride) throw ApiError.notFound('The ride this payment belongs to no longer exists');

  if (payment.status === PAYMENT_STATUS.PAID && ride.status === RIDE_STATUS.COMPLETED) {
    return { id: payment._id, status: payment.status, unchanged: true };
  }

  const previous = payment.status;

  /**
   * Through the payment service, not around it.
   *
   * This used to set the status here and update the ride's copy of it, and that
   * was all it did. No commission was booked, no earning was credited, no debt
   * was recorded against the rider who was holding the customer's cash, and the
   * ride never left AWAITING_PAYMENT — which left the rider permanently
   * unavailable and the ride unfinishable, because the rider's own confirm then
   * saw a PAID payment and returned. Settling here now posts the same ledger
   * the rider's own tap would have.
   */
  await paymentService.settleCashFromConsole(ride, payment);

  await audit.record(req, {
    action: 'payment.settle_cash',
    resource: 'Payment',
    resourceId: payment._id,
    oldValue: { status: previous },
    newValue: { status: payment.status, amount: payment.amount },
    note: note || null
  });

  return { id: payment._id, status: payment.status };
}

module.exports = {
  list,
  detail,
  cancelRide,
  listPayments,
  paymentOverview,
  refundPayment,
  reconcileRefund,
  paymentDetail,
  settleCashPayment,
  buildTimeline
};
