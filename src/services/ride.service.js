const bcrypt = require('bcryptjs');
const Ride = require('../models/Ride');
const Rider = require('../models/Rider');
const User = require('../models/User');
const RideRequest = require('../models/RideRequest');
const ApiError = require('../utils/ApiError');
const { BOOKING_TYPE } = require('../constants/services');
const logger = require('../utils/logger');
const generateOtp = require('../utils/generateOtp');
const { encryptOtp, decryptOtp } = require('../utils/otpCipher');
const notifications = require('./notification.service');
const feed = require('./notification.feed');
const matchingService = require('./matching.service');
const mapsService = require('./maps.service');
const fareService = require('./fare.service');
const settings = require('./settings.service');
const chatService = require('./chat.service');
const paymentService = require('./payment.service');
const walletService = require('./wallet.service');
const waiting = require('./waiting.service');
const cancellation = require('./cancellation.service');
const { round2 } = require('../utils/calculateFare');
const { SOCKET_EVENTS } = require('../constants/socketEvents');
const { ROLES } = require('../constants/userRoles');
const { RIDER_CATEGORIES, CUSTOMER_CATEGORIES } = require('../constants/ratings');
const { RIDE_STATUS, RIDE_REQUEST_STATUS, ACTIVE_RIDE_STATUSES, canTransition } = require('../constants/rideStatus');
const { PAYMENT_STATUS } = require('../constants/paymentStatus');

const OTP_SALT_ROUNDS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertTransition(ride, next) {
  if (!canTransition(ride.status, next)) {
    throw ApiError.conflict(`A ride in ${ride.status} cannot move to ${next}`);
  }
}

const toPlace = ({ address, placeId, lat, lng }) => ({
  address,
  placeId,
  location: { type: 'Point', coordinates: [lng, lat] }
});

// What the customer is allowed to see about the rider once one is assigned.
async function riderSummary(riderId) {
  const rider = await Rider.findById(riderId).populate('userId', 'name phone');
  if (!rider) return null;

  return {
    id: rider._id,
    name: rider.userId?.name,
    phone: rider.userId?.phone,
    vehicle: rider.vehicle,
    rating: rider.rating,
    totalRides: rider.totalRides,
    currentLocation: rider.currentLocation
  };
}

function serialiseRide(ride, extra = {}) {
  const plain = ride.toObject ? ride.toObject() : ride;
  if (plain.otp) {
    delete plain.otp.hash;
    delete plain.otp.enc;
  }

  /**
   * The waiting state travels with the ride, including the server's clock.
   *
   * Both apps already re-read the ride on load, on reconnect and whenever it
   * moves on, so attaching it here is what makes a refresh, a dropped socket
   * and a closed browser all recover the timer without a route of their own.
   *
   * `serverNow` is the part that matters for billing honesty: a screen that
   * counts from its own `Date.now()` against a server start time is wrong by
   * however far that phone's clock has drifted. With both numbers it can work
   * out the offset and display the same elapsed time everyone else sees —
   * while the figure actually charged is still computed on this side.
   */
  return { ...plain, waiting: waiting.stateOf(ride), ...extra };
}

/**
 * Rolling 24-hour cancellation limit, read from settings.
 *
 * Counted from the cancellation stamp rather than a per-user counter, so the
 * window really does roll and there is no column to drift out of sync.
 */
async function assertCancellationsWithinLimit(customerId) {
  const limit = settings.get('customer.cancellationsPerDay');

  const recent = await Ride.countDocuments({
    customerId,
    status: RIDE_STATUS.CANCELLED,
    'cancellation.by': 'customer',
    'cancellation.at': { $gte: new Date(Date.now() - DAY_MS) }
  });

  if (recent >= limit) {
    throw ApiError.tooManyRequests(
      `You have cancelled ${recent} rides in the last 24 hours. Please contact support to book again.`
    );
  }
}

async function createRide(customerId, { pickup, destination, serviceType, parcel }) {
  if (settings.get('system.maintenanceMode')) {
    throw ApiError.conflict(settings.get('system.maintenanceMessage'));
  }

  // The service decides the price and whether this is a delivery at all, so it
  // is checked against the catalogue before anything else. The booking type is
  // taken from the service rather than from the payload: a client cannot book
  // a parcel at passenger prices by sending a mismatched pair.
  const { bookingType } = fareService.assertBookable(serviceType);

  if (bookingType === BOOKING_TYPE.PARCEL && !parcel) {
    throw ApiError.badRequest('A delivery needs the package details', [
      { field: 'parcel', message: 'Who is sending it, who is receiving it, and what it is' }
    ]);
  }

  const active = await Ride.countDocuments({ customerId, status: { $in: ACTIVE_RIDE_STATUSES } });
  if (active >= settings.get('customer.maxActiveRides')) {
    throw ApiError.conflict('You already have a ride in progress');
  }

  await assertCancellationsWithinLimit(customerId);

  // Distance and fare come from the server, never from the client payload.
  const route = await mapsService.getRoute(
    { lat: pickup.lat, lng: pickup.lng },
    { lat: destination.lat, lng: destination.lng }
  );

  // Pricing is read once here and stored on the ride. Settlement uses the stored
  // copy, so a rate change between booking and drop-off cannot move the price.
  const pricing = fareService.currentPricing(serviceType);
  const fare = fareService.estimateFare(route.distanceKm, serviceType);

  const otp = generateOtp(settings.get('ride.otpLength'));

  const ride = await Ride.create({
    customerId,
    bookingType,
    serviceType,
    // Stored only for a delivery; a passenger ride has nobody to hand over to.
    parcel: bookingType === BOOKING_TYPE.PARCEL ? parcel : undefined,
    pickup: toPlace(pickup),
    destination: toPlace(destination),
    estimatedDistanceKm: fare.distanceKm,
    estimatedDurationMin: route.durationMin,
    estimatedFare: fare.amount,
    fareRatePerKm: fare.ratePerKm,
    currency: fare.currency,
    pricing,
    otp: {
      hash: await bcrypt.hash(otp, OTP_SALT_ROUNDS),
      enc: encryptOtp(otp),
      expiresAt: new Date(Date.now() + settings.get('ride.otpExpiryMinutes') * 60_000)
    }
  });

  const dispatch = await matchingService.dispatchRide(ride);

  // The OTP is returned once, to the customer who created the ride. It is never
  // read back from the API afterwards and the rider only ever submits it.
  return {
    ride: serialiseRide(ride),
    otp,
    fare,
    route: { distanceKm: fare.distanceKm, durationMin: route.durationMin, source: route.source },
    ridersNotified: dispatch.requested,
    requestExpiresAt: dispatch.expiresAt || null
  };
}

async function listRides(user, { status, page = 1, limit = 20 }) {
  const filter = {};

  if (user.role === ROLES.RIDER) {
    const rider = await Rider.findOne({ userId: user._id }).select('_id');
    filter.riderId = rider?._id || null;
  } else {
    filter.customerId = user._id;
  }

  if (status) filter.status = status;

  const [rides, total] = await Promise.all([
    Ride.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Ride.countDocuments(filter)
  ]);

  return { rides: rides.map((ride) => serialiseRide(ride)), total, page, limit };
}

// Either party on the ride may read it; nobody else can.
async function getRide(rideId, user) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  if (user.role === ROLES.RIDER) {
    const rider = await Rider.findOne({ userId: user._id }).select('_id');
    if (!rider || String(ride.riderId) !== String(rider._id)) {
      throw ApiError.forbidden('This ride is not assigned to you');
    }
  } else if (String(ride.customerId) !== String(user._id)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }

  const rider = ride.riderId ? await riderSummary(ride.riderId) : null;

  /**
   * When the current round of asking riders runs out, or null if none is open.
   *
   * The customer's screen has no other way to tell "still being offered to
   * riders" from "offered to riders, and none of them took it" — both are
   * SEARCHING. Without this it showed a search animation indefinitely after
   * every rider had already declined or timed out.
   *
   * Only computed while searching; once a rider has it, the question is moot.
   */
  let searchExpiresAt = null;
  if (ride.status === RIDE_STATUS.SEARCHING && !ride.riderId) {
    const open = await RideRequest.findOne({
      rideId: ride._id,
      status: RIDE_REQUEST_STATUS.PENDING,
      expiresAt: { $gt: new Date() }
    })
      .sort({ expiresAt: -1 })
      .select('expiresAt')
      .lean();

    searchExpiresAt = open?.expiresAt || null;
  }

  return serialiseRide(ride, {
    rider,
    searchExpiresAt,
    reRequestsLeft: Math.max(settings.get('ride.maxReRequests') - (ride.reRequestCount || 0), 0)
  });
}

/**
 * Only one rider can win a ride, and an offer that has run out cannot be taken.
 *
 * Three claims, each a single-document conditional update, which Mongo applies
 * atomically: the OFFER, then the rider, then the ride. Whoever's filter still
 * matches wins; everyone else is turned away.
 *
 * The offer claim is the one that used to be missing. It was a read of
 * `request.status`, a series of awaits, and then a `save()` that wrote
 * ACCEPTED unconditionally — so an expiry sweep landing in between was
 * overwritten, and a request that had genuinely expired ended up ACCEPTED.
 * Folding the deadline and the status into the filter closes that window: the
 * update simply does not match an offer that is no longer PENDING or whose
 * time has passed, and the race cannot be lost because there is nothing
 * between the check and the write.
 */
async function acceptRideRequest(rider, requestId) {
  const now = new Date();

  /**
   * Claim the offer. `expiresAt: { $gt: now }` is what makes EXPIRED →
   * ACCEPTED unreachable rather than merely unlikely.
   */
  const request = await RideRequest.findOneAndUpdate(
    {
      _id: requestId,
      riderId: rider._id,
      status: RIDE_REQUEST_STATUS.PENDING,
      expiresAt: { $gt: now }
    },
    { status: RIDE_REQUEST_STATUS.ACCEPTED, respondedAt: now },
    { new: true }
  );

  // The claim failed. Read the document to say why — this cannot reintroduce a
  // race, because nothing further happens either way.
  if (!request) {
    const existing = await RideRequest.findById(requestId).lean();

    if (!existing) throw ApiError.notFound('Ride request not found');
    if (String(existing.riderId) !== String(rider._id)) {
      throw ApiError.forbidden('This request was not sent to you');
    }
    if (existing.status !== RIDE_REQUEST_STATUS.PENDING) {
      throw ApiError.conflict(`This request is already ${existing.status.toLowerCase()}`);
    }

    // Still PENDING but past its deadline: mark it, so the row reflects what
    // happened rather than waiting for the sweep.
    await RideRequest.updateOne(
      { _id: requestId, status: RIDE_REQUEST_STATUS.PENDING },
      { status: RIDE_REQUEST_STATUS.EXPIRED, respondedAt: now }
    );
    throw ApiError.conflict('This request has expired');
  }

  /** Undo the offer claim when a later claim fails, so it is not left ACCEPTED. */
  const releaseOffer = () =>
    RideRequest.updateOne(
      { _id: request._id, status: RIDE_REQUEST_STATUS.ACCEPTED },
      { status: RIDE_REQUEST_STATUS.EXPIRED, respondedAt: new Date() }
    );

  const claimedRider = await Rider.findOneAndUpdate(
    { _id: rider._id, isOnline: true, isAvailable: true, activeRideId: null },
    // Counted on the claim rather than afterwards, so a rider who wins the
    // race is credited exactly once and one who loses it is not credited at
    // all — the same write decides both.
    { $set: { isAvailable: false, activeRideId: request.rideId }, $inc: { offersAccepted: 1 } },
    { new: true }
  );
  if (!claimedRider) {
    await releaseOffer();
    throw ApiError.conflict('You are not available to take a ride right now');
  }

  const ride = await Ride.findOneAndUpdate(
    { _id: request.rideId, status: RIDE_STATUS.SEARCHING, riderId: null },
    { riderId: rider._id, status: RIDE_STATUS.ACCEPTED, acceptedAt: new Date() },
    { new: true }
  );

  if (!ride) {
    await Rider.updateOne(
      { _id: rider._id },
      { $set: { isAvailable: true, activeRideId: null }, $inc: { offersAccepted: -1 } }
    );
    await releaseOffer();
    throw ApiError.conflict('This ride was already taken');
  }

  logger.debug(
    `[Ride] accepted ride=${ride._id} request=${request._id}` +
      ` round=${request.round ?? 0} rider=${rider._id}`
  );

  // The offer was already marked ACCEPTED by the claim above; writing it again
  // here is what used to clobber a concurrent expiry.
  matchingService.cancelExpiry(ride._id);
  await matchingService.invalidateOtherRequests(ride._id, request._id);

  // Chat exists only once there are two parties to it. A failure here must not
  // undo an accepted ride, so it is logged rather than thrown.
  await chatService.openForRide(ride).catch((err) => {
    logger.error(`Could not open chat for ride ${ride._id}: ${err.message}`);
  });

  const summary = await riderSummary(rider._id);
  feed.record(
    ride.customerId,
    feed.NOTIFICATION_TYPE.RIDE_ACCEPTED,
    'A rider accepted your ride',
    `${summary?.name || 'Your rider'} is on the way in a ${summary?.vehicle?.type || 'vehicle'}.`,
    ride._id
  );
  notifications.toAdminBoard(ride._id, ride.status);
  notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_ACCEPTED, {
    rideId: ride._id,
    status: ride.status,
    rider: summary,
    acceptedAt: ride.acceptedAt
  });

  return { ride: serialiseRide(ride), rider: summary };
}

async function rejectRideRequest(rider, requestId) {
  const request = await RideRequest.findOne({ _id: requestId, riderId: rider._id });
  if (!request) throw ApiError.notFound('Ride request not found');

  if (request.status !== RIDE_REQUEST_STATUS.PENDING) {
    throw ApiError.conflict(`This request is already ${request.status.toLowerCase()}`);
  }

  request.status = RIDE_REQUEST_STATUS.REJECTED;
  request.respondedAt = new Date();
  await request.save();

  const stillPending = await RideRequest.countDocuments({
    rideId: request.rideId,
    status: RIDE_REQUEST_STATUS.PENDING
  });

  if (stillPending === 0) {
    const ride = await Ride.findById(request.rideId).select('customerId status');
    if (ride?.status === RIDE_STATUS.SEARCHING) {
      notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_NO_RIDERS, {
        rideId: ride._id,
        message: 'All nearby riders declined the request'
      });
    }
  }

  return { requestId: request._id, status: request.status };
}

async function listRideRequests(rider) {
  const requests = await RideRequest.find({
    riderId: rider._id,
    status: RIDE_REQUEST_STATUS.PENDING,
    expiresAt: { $gt: new Date() }
  })
    .sort({ createdAt: -1 })
    .populate('rideId');

  return requests
    .filter((request) => request.rideId && request.rideId.status === RIDE_STATUS.SEARCHING)
    .map((request) => matchingService.requestPayload(request.rideId, request));
}

/**
 * The pickup code, for the customer who booked the ride and nobody else. Limited
 * to rides that are still running, so a completed ride stops handing it out.
 */
async function getOtpForCustomer(rideId, customerId) {
  const ride = await Ride.findById(rideId).select('+otp.enc');
  if (!ride) throw ApiError.notFound('Ride not found');

  if (String(ride.customerId) !== String(customerId)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }

  if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
    throw ApiError.conflict('This ride is no longer active');
  }

  const otp = decryptOtp(ride.otp.enc);
  if (!otp) throw ApiError.notFound('The pickup code is not available for this ride');

  return { rideId: ride._id, otp, verifiedAt: ride.otp.verifiedAt };
}

/**
 * Scoring a finished trip, from either side.
 *
 * Both directions go through here because the rules are the same ones: only a
 * completed ride, only by someone who was on it, and only once. Two functions
 * would be two places for "only once" to be got wrong, and a rating that can
 * be submitted twice is a rider's average that anyone can move at will.
 *
 * The overall star is what feeds the running average. The categories are
 * stored beside it and deliberately NOT averaged into anything: they exist to
 * tell whoever reads a one-star ride later what actually went wrong.
 */
function scoreRide({ rating, comment, categories }, allowed) {
  const clean = {};

  for (const key of allowed) {
    const value = categories?.[key];
    if (value != null) clean[key] = value;
  }

  return {
    value: rating,
    comment: comment || null,
    categories: clean,
    at: new Date()
  };
}

async function loadRateableRide(rideId) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  if (ride.status !== RIDE_STATUS.COMPLETED) {
    throw ApiError.badRequest('You can only rate a completed ride');
  }

  return ride;
}

/** The customer scores the rider. */
async function rateRide(rideId, customerId, { rating, comment, categories }) {
  const ride = await loadRateableRide(rideId);

  if (String(ride.customerId) !== String(customerId)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }
  if (ride.rating?.value) throw ApiError.conflict('You have already rated this ride');

  ride.rating = scoreRide({ rating, comment, categories }, RIDER_CATEGORIES);

  /**
   * Claimed, not just saved.
   *
   * The check above read the copy this request loaded, so two submissions
   * arriving together both pass it — and both then increment the rider's
   * average for one ride. Making the write conditional on the rating still
   * being unset means exactly one of them counts.
   */
  const claimed = await Ride.updateOne(
    { _id: ride._id, 'rating.value': null },
    { $set: { rating: ride.rating } }
  );

  if (!claimed.modifiedCount) throw ApiError.conflict('You have already rated this ride');

  if (ride.riderId) {
    await Rider.updateOne({ _id: ride.riderId }, { $inc: { ratingSum: rating, ratingCount: 1 } });
  }

  return { rideId: ride._id, rating: ride.rating };
}

/** The rider scores the customer. */
async function rateCustomer(rideId, rider, { rating, comment, categories }) {
  const ride = await loadRateableRide(rideId);

  if (!ride.riderId || String(ride.riderId) !== String(rider._id)) {
    throw ApiError.forbidden('This ride is not assigned to you');
  }
  if (ride.customerRating?.value) throw ApiError.conflict('You have already rated this ride');

  ride.customerRating = scoreRide({ rating, comment, categories }, CUSTOMER_CATEGORIES);

  const claimed = await Ride.updateOne(
    { _id: ride._id, 'customerRating.value': null },
    { $set: { customerRating: ride.customerRating } }
  );

  if (!claimed.modifiedCount) throw ApiError.conflict('You have already rated this ride');

  await User.updateOne({ _id: ride.customerId }, { $inc: { ratingSum: rating, ratingCount: 1 } });

  return { rideId: ride._id, rating: ride.customerRating };
}

// Loads a ride and checks the caller is the rider assigned to it.
async function loadAssignedRide(rideId, rider) {
  const ride = await Ride.findById(rideId).select('+otp.hash');
  if (!ride) throw ApiError.notFound('Ride not found');
  if (!ride.riderId || String(ride.riderId) !== String(rider._id)) {
    throw ApiError.forbidden('This ride is not assigned to you');
  }
  return ride;
}

async function markArriving(rideId, rider) {
  const ride = await loadAssignedRide(rideId, rider);
  assertTransition(ride, RIDE_STATUS.ARRIVING);

  ride.status = RIDE_STATUS.ARRIVING;
  ride.arrivingAt = new Date();
  await ride.save();

  notifications.toAdminBoard(ride._id, ride.status);
  notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_ARRIVING, { rideId: ride._id, status: ride.status });
  return serialiseRide(ride);
}

async function markArrived(rideId, rider) {
  const ride = await loadAssignedRide(rideId, rider);
  assertTransition(ride, RIDE_STATUS.ARRIVED);

  ride.status = RIDE_STATUS.ARRIVED;
  ride.arrivedAt = new Date();

  /**
   * The customer's clock starts here, once.
   *
   * Arrival can be reported twice — the proximity check and the rider's own
   * button race each other by design — and the latch inside is what stops the
   * second one moving the clock forward and wiping out the wait already
   * accrued. It is deliberately tied to the STATUS CHANGE rather than to the
   * proximity check, so a rider who marks themselves arrived by hand because
   * their GPS is hopeless still starts the same clock.
   */
  waiting.startPickup(ride);

  await ride.save();

  feed.record(
    ride.customerId,
    feed.NOTIFICATION_TYPE.RIDER_ARRIVED,
    'Your rider has arrived',
    'Share your pickup code to start the trip.',
    ride._id
  );
  notifications.toAdminBoard(ride._id, ride.status);

  const payload = { rideId: ride._id, status: ride.status, arrivedAt: ride.arrivedAt };

  /**
   * The customer's copy carries who arrived and where.
   *
   * Enough for the alert to stand on its own, so a customer whose app missed
   * the acceptance event — a reconnect, a cold start, a backgrounded tab — is
   * still told something useful rather than "your rider has arrived" with no
   * rider named. The rider's own copy below stays thin: their screen already
   * knows all of this.
   *
   * Nothing else is added. Not the rider's phone, which the customer already
   * has from acceptance, and not their live coordinates, which this event is
   * not about.
   */
  const arrivedRider = await riderSummary(ride.riderId);
  notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_ARRIVED, {
    ...payload,
    rider: arrivedRider ? { id: arrivedRider.id, name: arrivedRider.name } : null,
    pickup: { address: ride.pickup?.address || null }
  });

  /**
   * The rider is told too, because they did not necessarily ask.
   *
   * When the rider taps "I've arrived" their own screen moves on the HTTP
   * reply and this is redundant. But the proximity check calls this as well,
   * and in that case nobody has spoken to the rider's app at all — without
   * this it keeps offering "I've arrived" for a ride that already has, and the
   * tap comes back 409.
   */
  notifications.toRider(ride.riderId, SOCKET_EVENTS.RIDE_ARRIVED, payload);

  return serialiseRide(ride);
}

/**
 * The rider types in the code the customer shows them. Attempts are counted on
 * the ride itself so the limit survives reconnects, and a burnt-out ride has to
 * be cancelled rather than retried indefinitely.
 */
async function verifyOtp(rideId, rider, otp) {
  const ride = await loadAssignedRide(rideId, rider);

  if (ride.otp.verifiedAt) throw ApiError.conflict('OTP has already been verified for this ride');
  assertTransition(ride, RIDE_STATUS.OTP_VERIFIED);

  const maxAttempts = settings.get('ride.otpMaxAttempts');
  if (ride.otp.attempts >= maxAttempts) {
    throw ApiError.tooManyRequests('Too many incorrect OTP attempts, ask the customer to cancel and rebook');
  }

  // Codes issued before the expiry setting existed have no expiresAt, and those
  // stay valid — the check only applies where the ride carries a deadline.
  if (ride.otp.expiresAt && ride.otp.expiresAt.getTime() < Date.now()) {
    throw ApiError.conflict('This pickup code has expired, ask the customer to cancel and rebook');
  }

  const matches = await bcrypt.compare(otp, ride.otp.hash);
  if (!matches) {
    ride.otp.attempts += 1;
    await ride.save();
    const remaining = Math.max(maxAttempts - ride.otp.attempts, 0);
    throw ApiError.badRequest(`Incorrect OTP, ${remaining} attempt(s) remaining`);
  }

  ride.otp.verifiedAt = new Date();
  ride.status = RIDE_STATUS.OTP_VERIFIED;

  // The customer is in the vehicle; the rider is no longer waiting for them.
  // The charge is computed and frozen here, and nothing afterwards adds to it.
  waiting.stopPickup(ride);

  await ride.save();

  notifications.toAdminBoard(ride._id, ride.status);
  notifications.toRide(ride._id, SOCKET_EVENTS.RIDE_STARTED, {
    rideId: ride._id,
    status: ride.status,
    otpVerifiedAt: ride.otp.verifiedAt
  });

  return serialiseRide(ride);
}

async function startRide(rideId, rider) {
  const ride = await loadAssignedRide(rideId, rider);

  if (!ride.otp.verifiedAt) throw ApiError.badRequest('Verify the pickup OTP before starting the trip');
  assertTransition(ride, RIDE_STATUS.IN_PROGRESS);

  ride.status = RIDE_STATUS.IN_PROGRESS;
  ride.startedAt = new Date();
  await ride.save();

  feed.record(
    ride.customerId,
    feed.NOTIFICATION_TYPE.TRIP_STARTED,
    'Your trip has started',
    'You are on your way.',
    ride._id
  );
  notifications.toRide(ride._id, SOCKET_EVENTS.RIDE_STARTED, {
    rideId: ride._id,
    status: ride.status,
    startedAt: ride.startedAt
  });

  return serialiseRide(ride);
}

/**
 * Drop-off: the journey ends and the fare is fixed.
 *
 * This no longer completes the ride. It moves it to AWAITING_PAYMENT, where it
 * stays until the money is actually collected — cash confirmed by the rider, or
 * UPI confirmed by the gateway. "Completed" is reserved for rides that are done
 * *and* paid for, because that is what every count, every earnings figure and
 * every payout in the platform takes it to mean.
 *
 * The rider app may report the metered distance, but it is only accepted within
 * a sane band around the server's own estimate — otherwise the quoted distance
 * stands.
 */
async function completeRide(rideId, rider, { distanceKm, paymentMethod } = {}) {
  const ride = await loadAssignedRide(rideId, rider);
  assertTransition(ride, RIDE_STATUS.AWAITING_PAYMENT);

  const reported = Number(distanceKm);
  const withinTolerance =
    Number.isFinite(reported) &&
    reported > 0 &&
    reported <= ride.estimatedDistanceKm * 1.5 &&
    reported >= ride.estimatedDistanceKm * 0.5;

  const actualDistance = withinTolerance ? reported : ride.estimatedDistanceKm;
  const fare = fareService.finalFare(ride, actualDistance);

  /**
   * Pickup waiting is closed by now — it stops at the pickup code — so this is
   * a no-op on any ride that went through the code. It is here for the one
   * that did not: a ride settled by support, say, where the clock would
   * otherwise be left running and its charge never computed.
   */
  waiting.stopPickup(ride);

  /**
   * And the second clock starts: the customer now has the free period to pay
   * before the rider's time at the drop-off starts costing them.
   */
  waiting.startPayment(ride);

  ride.finalDistanceKm = fare.distanceKm;

  /**
   * The journey and the waiting are kept apart.
   *
   * `rideFare` is what `buildFare` produced, floor and cap already applied.
   * The waiting charge goes on top of it rather than through it: a maximum
   * fare limits what a journey costs, and a rider who sat outside for twenty
   * minutes on a capped trip would otherwise be compensated with nothing.
   */
  ride.rideFare = fare.amount;
  ride.finalFare = round2(fare.amount + (ride.waiting?.pickup?.charge || 0));

  /**
   * The split, frozen now.
   *
   * Taken from the commission in force at this moment and written onto the
   * ride, so an admin changing the rate this afternoon cannot reach back and
   * alter what this rider earned this morning. Nothing downstream recomputes
   * it — the ledger, the wallet and the earnings screen all read this snapshot.
   */
  // Commission is taken on the whole of what the customer pays, waiting
  // included — the same rule the platform already applies to everything else
  // on the fare.
  const commission = fareService.split(ride.finalFare, fareService.currentCommissionRate());
  ride.finance = {
    fareAmount: commission.fareAmount,
    platformCommissionRate: commission.platformCommissionRate,
    platformCommissionAmount: commission.platformCommissionAmount,
    riderEarningAmount: commission.riderEarningAmount,
    currency: ride.currency,
    postedAt: null
  };

  ride.status = RIDE_STATUS.AWAITING_PAYMENT;
  // The journey ended now, whatever time the money lands.
  ride.completedAt = new Date();

  /**
   * Claimed, not just saved.
   *
   * `assertTransition` above reads the copy this request loaded, so two taps
   * arriving together both pass it and both write a snapshot — and the second
   * one wins, leaving a ride whose frozen commission was computed from a
   * different distance than the payment the customer was charged. Making the
   * move conditional on the status we read means exactly one of them proceeds.
   */
  const claimed = await Ride.updateOne(
    { _id: ride._id, status: RIDE_STATUS.IN_PROGRESS },
    {
      $set: {
        status: RIDE_STATUS.AWAITING_PAYMENT,
        finalDistanceKm: ride.finalDistanceKm,
        rideFare: ride.rideFare,
        finalFare: ride.finalFare,
        finance: ride.finance,
        // Both clocks, in the same write that claims the ride: the pickup
        // wait that has just been billed, and the payment wait that starts now.
        waiting: ride.waiting,
        completedAt: ride.completedAt
      }
    }
  );

  if (!claimed.modifiedCount) {
    throw ApiError.conflict('This ride has already been completed');
  }

  const payment = await paymentService.createForRide(ride, paymentMethod);

  // The rider is not freed here. They are standing at the drop-off collecting a
  // fare, which is still this ride's work; `finaliseRide` releases them once it
  // is in.

  notifications.toAdminBoard(ride._id, ride.status);
  notifications.toRide(ride._id, SOCKET_EVENTS.RIDE_AWAITING_PAYMENT, {
    rideId: ride._id,
    status: ride.status,
    finalDistanceKm: ride.finalDistanceKm,
    finalFare: ride.finalFare,
    currency: ride.currency,
    payment: payment ? { id: payment._id, method: payment.method, status: payment.status } : null
  });

  return {
    ride: serialiseRide(ride),
    fare,
    payment: payment ? paymentService.publicPayment(payment) : null,
    // What the rider will be left with, shown on their own summary screen only.
    earning: commission
  };
}

/**
 * The money is in. Post it, finish the ride, free the rider.
 *
 * Called by the payment service the moment a payment settles, by either route.
 * Idempotent from both ends: a ride already COMPLETED returns immediately, and
 * the ledger entries carry keys that make a second posting a no-op even if two
 * callers arrive at once.
 */
async function finaliseRide(ride, payment) {
  if (ride.status === RIDE_STATUS.COMPLETED) return serialiseRide(ride);

  if (ride.status !== RIDE_STATUS.AWAITING_PAYMENT) {
    throw ApiError.conflict(`A ride in ${ride.status} cannot be settled`);
  }

  const split = fareService.splitOf(ride);

  // The ledger first. If this throws, the ride stays in AWAITING_PAYMENT and
  // can be settled again — a ride marked complete with no money posted against
  // it is the one outcome there is no way back from.
  const posting = await walletService.settleRide({
    ride,
    split,
    method: payment.method,
    paymentId: payment._id
  });

  /**
   * One winner finishes the ride.
   *
   * The guard at the top of this function reads the copy the caller loaded, so
   * two settlements racing each other both got past it. The ledger held — its
   * keys are unique — but everything after it ran twice: the rider's trip count
   * was incremented twice for one ride, the customer got two "trip complete"
   * notifications, and two RIDE_COMPLETED events went out. A conditional move
   * means the side effects belong to whoever actually changed the status.
   */
  const finished = await Ride.updateOne(
    { _id: ride._id, status: RIDE_STATUS.AWAITING_PAYMENT },
    {
      $set: {
        status: RIDE_STATUS.COMPLETED,
        'finance.postedAt': ride.finance?.postedAt || new Date()
      }
    }
  );

  ride.status = RIDE_STATUS.COMPLETED;

  if (!finished.modifiedCount) return serialiseRide(ride);

  await Rider.updateOne(
    { _id: ride.riderId },
    { isAvailable: true, activeRideId: null, $inc: { totalRides: 1 } }
  );

  // Chat stays reachable for the configured window after drop-off, then goes
  // read-only — a customer who left something in the car needs those minutes.
  await chatService.closeForRide(ride).catch((err) => {
    logger.error(`Could not close chat for ride ${ride._id}: ${err.message}`);
  });

  feed.record(
    ride.customerId,
    feed.NOTIFICATION_TYPE.TRIP_COMPLETED,
    'Trip complete',
    `Your fare is ${ride.currency} ${ride.finalFare}.`,
    ride._id
  );

  notifications.toAdminBoard(ride._id, ride.status);
  notifications.toRide(ride._id, SOCKET_EVENTS.RIDE_COMPLETED, {
    rideId: ride._id,
    status: ride.status,
    finalDistanceKm: ride.finalDistanceKm,
    finalFare: ride.finalFare,
    currency: ride.currency,
    payment: { id: payment._id, method: payment.method, status: payment.status }
  });

  // The rider's own earning and balance go to the rider alone. A customer never
  // learns their driver's commission or what they owe the platform.
  notifications.toRider(ride.riderId, SOCKET_EVENTS.RIDE_COMPLETED, {
    rideId: ride._id,
    status: ride.status,
    earning: {
      fareAmount: split.fareAmount,
      platformCommissionRate: split.platformCommissionRate,
      platformCommissionAmount: split.platformCommissionAmount,
      riderEarningAmount: split.riderEarningAmount,
      currency: split.currency || ride.currency
    },
    wallet: posting.wallet ? posting.wallet.toPublic() : null
  });

  return serialiseRide(ride);
}

/**
 * Customers may call off a ride until the trip actually starts; riders may drop
 * an accepted ride before the OTP is verified. Either way the rider goes back
 * into the pool and no offer is left hanging.
 */
/**
 * Calling off a ride, and what it costs.
 *
 * The reason is recorded as a code as well as a line of text, so "why do people
 * cancel here" is a question the admin side can actually answer rather than a
 * pile of free text. The fee is worked out here, from the configured rules and
 * the ride's own timestamps — never sent by the app.
 */
async function cancelRide(rideId, user, { reasonCode = null, note = null } = {}) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  let cancelledBy;
  if (user.role === ROLES.RIDER) {
    const rider = await Rider.findOne({ userId: user._id }).select('_id');
    if (!rider || String(ride.riderId) !== String(rider._id)) {
      throw ApiError.forbidden('This ride is not assigned to you');
    }
    if (ride.otp.verifiedAt) {
      throw ApiError.conflict('The trip has already started and cannot be cancelled by the rider');
    }
    cancelledBy = 'rider';
  } else {
    if (String(ride.customerId) !== String(user._id)) {
      throw ApiError.forbidden('This ride does not belong to you');
    }
    cancelledBy = 'customer';
  }

  assertTransition(ride, RIDE_STATUS.CANCELLED);

  const described = cancellation.describe(cancelledBy, { reasonCode, note });
  const fee = cancellation.feeFor(ride, cancelledBy);

  ride.status = RIDE_STATUS.CANCELLED;
  ride.cancellation = { by: cancelledBy, ...described, fee, at: new Date() };

  /**
   * Close any clock that was still running.
   *
   * A cancelled ride is never priced — it does not go through `completeRide` —
   * so this charges nobody anything. It is here so the record is complete: a
   * ride abandoned at the pickup should say how long the rider actually waited
   * there, rather than leaving a start with no end for a support agent to
   * puzzle over later. Cancellation fees are a separate rule and stay where
   * they are.
   */
  waiting.stopPickup(ride);
  waiting.stopPayment(ride);
  if (ride.payment.status === PAYMENT_STATUS.PENDING) ride.payment.status = PAYMENT_STATUS.FAILED;
  await ride.save();

  await matchingService.cancelPendingRequests(ride._id, `Cancelled by ${cancelledBy}`);

  /**
   * A rider's fee is collected; a customer's is recorded only.
   *
   * The rider has a wallet, so the charge goes through the ledger like every
   * other movement and shows up in their outstanding balance. A customer has no
   * stored instrument — cash and UPI are both taken at the end of a ride that,
   * here, never happened — so the figure is stored on the ride and nothing is
   * taken. That is a limitation worth being honest about rather than a bug:
   * writing a number into a wallet the customer does not have would be the fake
   * money movement this codebase does not do.
   */
  if (fee > 0 && cancelledBy === 'rider') {
    await walletService.chargeCancellation({ ride, amount: fee });
  }

  if (ride.riderId) {
    await Rider.updateOne(
      { _id: ride.riderId },
      {
        $set: { isAvailable: true, activeRideId: null },
        // Only the rider's own cancellations count against their record. A
        // customer changing their mind is not a mark against the rider who
        // was on the way, and ranking them down for it would be a penalty for
        // having accepted.
        ...(cancelledBy === 'rider' ? { $inc: { ridesCancelled: 1 } } : {})
      }
    );
    notifications.toRider(ride.riderId, SOCKET_EVENTS.RIDE_CANCELLED, {
      rideId: ride._id,
      cancelledBy,
      reason: ride.cancellation.reason,
      fee: cancelledBy === 'rider' ? fee : 0
    });
  }

  await chatService.closeForRide(ride).catch(() => {});

  const cancelTitle = 'Ride cancelled';
  const cancelBody = `This ride was cancelled by the ${cancelledBy}.`;
  feed.record(ride.customerId, feed.NOTIFICATION_TYPE.RIDE_CANCELLED, cancelTitle, cancelBody, ride._id);
  if (ride.riderId) {
    const riderUser = await Rider.findById(ride.riderId).select('userId');
    if (riderUser) {
      feed.record(riderUser.userId, feed.NOTIFICATION_TYPE.RIDE_CANCELLED, cancelTitle, cancelBody, ride._id);
    }
  }

  notifications.toAdminBoard(ride._id, ride.status);
  notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_CANCELLED, {
    rideId: ride._id,
    cancelledBy,
    reason: ride.cancellation.reason,
    fee: cancelledBy === 'customer' ? fee : 0
  });

  return serialiseRide(ride);
}

/**
 * Asking again for a ride nobody took, optionally on a different vehicle.
 *
 * A dispatch round that nobody accepts leaves the ride sitting in SEARCHING
 * with every offer expired — which is a real state and used to be an invisible
 * one: the customer's screen kept saying "finding your rider" indefinitely
 * while nothing at all was happening. This is the way out of it.
 *
 * Every condition the request has to satisfy is checked here rather than
 * trusted from the app:
 *
 *   the ride is the caller's own
 *   it is still searching, with no rider assigned
 *   no offer from the previous round is still live, so this cannot run twice
 *     over the top of a round that has not finished
 *   the re-request ceiling has not been reached
 *   the service asked for exists and is still enabled
 *
 * A changed service is repriced from the current catalogue, not from anything
 * the client sends. The distance is the one thing kept: the route has not
 * changed, and re-asking the maps provider for the same two points would spend
 * a call to learn what the ride already knows.
 */
async function requestAgain(rideId, customerId, { serviceType = null } = {}) {
  if (settings.get('system.maintenanceMode')) {
    throw ApiError.conflict(settings.get('system.maintenanceMessage'));
  }

  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  if (String(ride.customerId) !== String(customerId)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }

  if (ride.status !== RIDE_STATUS.SEARCHING || ride.riderId) {
    throw ApiError.conflict(
      ride.riderId
        ? 'A rider has already accepted this ride. Cancel it if you want a different vehicle.'
        : `A ride in ${ride.status} cannot be requested again`
    );
  }

  // A live offer means the previous round is still running. Asking again now
  // would put the same ride in front of riders twice.
  const stillOpen = await RideRequest.countDocuments({
    rideId: ride._id,
    status: RIDE_REQUEST_STATUS.PENDING,
    expiresAt: { $gt: new Date() }
  });
  if (stillOpen > 0) {
    throw ApiError.conflict('Riders are still being asked. Give them a moment.');
  }

  const ceiling = settings.get('ride.maxReRequests');
  if (ride.reRequestCount >= ceiling) {
    throw ApiError.conflict(
      ceiling === 0
        ? 'Please book a new ride.'
        : `You have asked ${ceiling} time${ceiling === 1 ? '' : 's'} already. Please book a new ride.`
    );
  }

  const changing = serviceType && serviceType !== ride.serviceType;

  if (changing) {
    const { bookingType } = fareService.assertBookable(serviceType);

    // A passenger ride cannot become a delivery on the way: there is nobody to
    // collect from and nothing to hand over, and the package details a delivery
    // needs were never asked for.
    if (bookingType !== ride.bookingType) {
      throw ApiError.badRequest(
        bookingType === BOOKING_TYPE.PARCEL
          ? 'Sending a package is a different booking. Cancel this ride and start a delivery.'
          : 'This is a delivery. Cancel it and book a ride if you want to travel yourself.'
      );
    }

    const pricing = fareService.currentPricing(serviceType);
    const fare = fareService.estimateFare(ride.estimatedDistanceKm, serviceType);

    ride.serviceType = serviceType;
    ride.estimatedFare = fare.amount;
    ride.fareRatePerKm = fare.ratePerKm;
    ride.currency = fare.currency;
    ride.pricing = pricing;
  } else {
    // Unchanged service, but the rate may have moved since the ride was
    // created. Re-asking is a new offer to riders, so it is priced afresh —
    // and the customer is shown the result before they confirm.
    fareService.assertBookable(ride.serviceType);
    const pricing = fareService.currentPricing(ride.serviceType);
    const fare = fareService.estimateFare(ride.estimatedDistanceKm, ride.serviceType);

    ride.estimatedFare = fare.amount;
    ride.fareRatePerKm = fare.ratePerKm;
    ride.currency = fare.currency;
    ride.pricing = pricing;
  }

  ride.reRequestCount += 1;
  await ride.save();

  logger.debug(
    `[Ride] re-request ride=${ride._id} round=${ride.reRequestCount}` +
      ` service=${ride.serviceType} fare=${ride.estimatedFare}`
  );

  const dispatch = await matchingService.dispatchRide(ride);

  return {
    ride: serialiseRide(ride),
    dispatch,
    reRequestsLeft: Math.max(ceiling - ride.reRequestCount, 0)
  };
}

/**
 * What the customer may switch to, priced for this ride's distance.
 *
 * Read from the catalogue and the live pricing, so a service an admin has since
 * turned off does not appear and a rate change is reflected before the customer
 * commits. Deliveries and passenger rides are kept apart: only services of the
 * same booking type are offered, because switching between them is a different
 * booking rather than a different vehicle.
 */
async function changeOptions(rideId, customerId) {
  const ride = await Ride.findById(rideId).lean();
  if (!ride) throw ApiError.notFound('Ride not found');

  if (String(ride.customerId) !== String(customerId)) {
    throw ApiError.forbidden('This ride does not belong to you');
  }

  const quotes = fareService.quoteAll(ride.estimatedDistanceKm);

  return {
    rideId: ride._id,
    distanceKm: ride.estimatedDistanceKm,
    currency: ride.currency,
    serviceType: ride.serviceType,
    bookingType: ride.bookingType,
    canChange: ride.status === RIDE_STATUS.SEARCHING && !ride.riderId,
    reRequestsLeft: Math.max(settings.get('ride.maxReRequests') - (ride.reRequestCount || 0), 0),
    services: quotes.filter((quote) => quote.bookingType === ride.bookingType)
  };
}

module.exports = {
  createRide,
  requestAgain,
  changeOptions,
  listRides,
  getRide,
  acceptRideRequest,
  rejectRideRequest,
  listRideRequests,
  getOtpForCustomer,
  rateRide,
  rateCustomer,
  markArriving,
  markArrived,
  verifyOtp,
  startRide,
  completeRide,
  finaliseRide,
  cancelRide,
  riderSummary,
  serialiseRide
};
