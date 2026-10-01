const settings = require('./settings.service');
const { vehicleFor } = require('../constants/services');
const Rider = require('../models/Rider');
const RideRequest = require('../models/RideRequest');
const Ride = require('../models/Ride');
const logger = require('../utils/logger');
const notifications = require('./notification.service');
const { SOCKET_EVENTS } = require('../constants/socketEvents');
const { RIDE_REQUEST_STATUS, RIDE_STATUS } = require('../constants/rideStatus');
const { RELIABILITY_WEIGHTS, PRIOR, POOL_MULTIPLIER } = require('../constants/matching');

const timers = new Map();

const coordsOf = (place) => ({
  lat: place.location.coordinates[1],
  lng: place.location.coordinates[0]
});

/**
 * Online, unassigned riders inside the radius, best first.
 *
 * "Best" is mostly "nearest" — see `constants/matching.js` for the weighting
 * and why it leans that way. The two things worth knowing here:
 *
 * `$geoNear` has to be the first stage and is what uses the 2dsphere index, so
 * the search is still a radius search; the scoring reorders what it found
 * rather than scanning the fleet.
 *
 * The pool is wider than the cap. Scoring the nearest N and then sorting them
 * gives back the same N in a different order, which is not a ranking — so a
 * multiple of the cap is fetched, ranked, and cut to the cap afterwards.
 *
 * THE RATING GATE USED TO DO NOTHING. It was written as a query on `rating`,
 * which is a virtual: the field is not stored, so `{ rating: null }` matched
 * every rider and the `$or` was satisfied by all of them. It is computed from
 * `ratingSum` and `ratingCount` in the pipeline now, where it is a real value.
 */
async function findNearbyRiders(pickup, { radiusKm, limit, vehicle } = {}) {
  const radius = radiusKm ?? settings.get('ride.matchingRadiusKm');
  const cap = limit ?? settings.get('ride.maxRidersPerRequest');
  const minimumRating = settings.get('rider.minimumRating');

  const query = { isOnline: true, isAvailable: true, activeRideId: null };

  // A bike job only reaches bike riders. Without this a car rider is offered a
  // bike fare for a job they cannot take, and the customer waits out the whole
  // window for nothing.
  if (vehicle) query['vehicle.type'] = vehicle;

  const rated = {
    $cond: [{ $gt: ['$ratingCount', 0] }, { $divide: ['$ratingSum', '$ratingCount'] }, null]
  };

  const stages = [
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [pickup.lng, pickup.lat] },
        distanceField: 'distanceMeters',
        maxDistance: radius * 1000,
        spherical: true,
        query
      }
    },
    { $limit: Math.max(cap, cap * POOL_MULTIPLIER) },
    { $addFields: { ratingAvg: rated, ...reliabilityFields() } }
  ];

  // 0 disables the gate; above it, unrated riders still qualify, because a new
  // rider has nothing to be judged on yet.
  if (minimumRating > 0) {
    stages.push({ $match: { $or: [{ ratingAvg: null }, { ratingAvg: { $gte: minimumRating } }] } });
  }

  stages.push(
    { $addFields: { matchScore: scoreExpression(radius * 1000) } },
    // Distance breaks a tie, so two riders with identical records are still
    // offered nearest first rather than in whatever order the index returned.
    { $sort: { matchScore: -1, distanceMeters: 1 } },
    { $limit: cap },
    {
      $project: {
        _id: 1,
        userId: 1,
        vehicle: 1,
        distanceMeters: 1,
        matchScore: 1,
        acceptanceRate: 1,
        cancellationRate: 1,
        ratingAvg: 1
      }
    }
  );

  return Rider.aggregate(stages);
}

/**
 * The three rates, each smoothed towards the prior described in the constants.
 *
 * `$ifNull` on every counter because these fields were added after riders
 * existed: a document written before them has no key at all, and arithmetic on
 * a missing value yields null, which would sort every long-standing rider to
 * the bottom of the list the day this shipped.
 */
function reliabilityFields() {
  const counter = (field) => ({ $ifNull: [`$${field}`, 0] });

  const smoothed = (successes, trials, priorTrials, priorRate) => ({
    $divide: [
      { $add: [successes, priorTrials * priorRate] },
      { $add: [trials, priorTrials] }
    ]
  });

  return {
    acceptanceRate: smoothed(
      counter('offersAccepted'),
      counter('offersReceived'),
      PRIOR.offers,
      PRIOR.acceptanceRate
    ),
    cancellationRate: smoothed(
      counter('ridesCancelled'),
      counter('offersAccepted'),
      PRIOR.rides,
      PRIOR.cancellationRate
    ),
    smoothedRating: smoothed(
      { $ifNull: ['$ratingSum', 0] },
      { $ifNull: ['$ratingCount', 0] },
      PRIOR.ratings,
      PRIOR.rating
    )
  };
}

/**
 * One number in 0..1, higher is better.
 *
 * Distance is turned into a score by how much of the search radius is left: a
 * rider at the pickup scores 1, one at the edge scores 0. That keeps the two
 * halves on the same scale, so the weight setting means what it says.
 */
function scoreExpression(radiusMeters) {
  const weight = Math.min(1, Math.max(0, settings.get('ride.reliabilityWeight')));

  const proximity = {
    $max: [0, { $subtract: [1, { $divide: ['$distanceMeters', Math.max(1, radiusMeters)] }] }]
  };

  // Ratings run 1..5, so the bottom of the scale is 1 rather than 0.
  const ratingScore = { $divide: [{ $subtract: ['$smoothedRating', 1] }, 4] };

  const reliability = {
    $add: [
      { $multiply: ['$acceptanceRate', RELIABILITY_WEIGHTS.acceptance] },
      { $multiply: [{ $subtract: [1, '$cancellationRate'] }, RELIABILITY_WEIGHTS.completion] },
      { $multiply: [ratingScore, RELIABILITY_WEIGHTS.rating] }
    ]
  };

  return {
    $add: [{ $multiply: [proximity, 1 - weight] }, { $multiply: [reliability, weight] }]
  };
}

function requestPayload(ride, request) {
  return {
    requestId: request._id,
    rideId: ride._id,
    // What the job is. Without these the rider screen cannot tell a delivery
    // from a passenger waiting at the kerb, which is the one thing it must not
    // get wrong.
    bookingType: ride.bookingType,
    serviceType: ride.serviceType,
    pickup: { address: ride.pickup.address, ...coordsOf(ride.pickup) },
    destination: { address: ride.destination.address, ...coordsOf(ride.destination) },
    estimatedDistanceKm: ride.estimatedDistanceKm,
    estimatedDurationMin: ride.estimatedDurationMin,
    estimatedFare: ride.estimatedFare,
    currency: ride.currency,
    distanceToPickupKm: request.distanceToPickupKm,
    // Which attempt this offer belongs to. The rider app keys its ring on
    // `requestId`, which is already unique per round, so this is here for the
    // logs and for anything that wants to say "asked again" in the UI.
    round: request.round ?? 0,
    expiresAt: request.expiresAt
  };
}

/**
 * Offers the ride to every nearby rider at once and starts the server-side clock.
 * The stored expiresAt is what accept() checks; the timer below only exists to
 * push the expiry notification out, so a process restart cannot let a stale
 * request be accepted.
 */
async function dispatchRide(ride) {
  const pickup = coordsOf(ride.pickup);
  const riders = await findNearbyRiders(pickup, { vehicle: vehicleFor(ride.serviceType) });

  if (!riders.length) {
    logger.debug(`[Ride] no riders nearby ride=${ride._id} round=${ride.reRequestCount || 0}`);
    notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_NO_RIDERS, { rideId: ride._id });
    return { requested: 0 };
  }

  const expiresAt = new Date(Date.now() + settings.get('ride.requestTimeoutSeconds') * 1000);

  notifications.toAdminBoard(ride._id, ride.status);

  /**
   * Which attempt this is. Round 0 is the original booking; each "Request
   * again" increments `reRequestCount` before dispatching, so the round is
   * simply that counter.
   *
   * It goes into the offer document because the unique index is scoped by it:
   * without a round, a second offer to a rider who was already asked in round
   * one is a duplicate key, and the whole dispatch fails.
   */
  const round = ride.reRequestCount || 0;

  /**
   * One rider colliding must not cost the round.
   *
   * `insertMany` with `ordered: false` asks MongoDB to attempt every document
   * and then THROWS a bulk-write error if any failed — the successful inserts
   * are in `err.insertedDocs`, not in a return value. So the previous shape,
   * which awaited the call and used its result, turned one duplicate into a
   * failed dispatch: no offers emitted, no ring, and a 500 back to the
   * customer. Now a partial round still reaches the riders it did insert, and
   * only a genuinely empty round reports nothing requested.
   */
  const rows = riders.map((rider) => ({
    rideId: ride._id,
    riderId: rider._id,
    round,
    distanceToPickupKm: Number((rider.distanceMeters / 1000).toFixed(2)),
    expiresAt
  }));

  let requests = [];
  try {
    requests = await RideRequest.insertMany(rows, { ordered: false });
  } catch (err) {
    // Whatever did land is on the error. Anything else is a real failure.
    requests = err?.insertedDocs || [];
    const duplicates = (err?.writeErrors || []).filter((e) => e?.err?.code === 11000 || e?.code === 11000);

    if (!requests.length && !duplicates.length) throw err;

    logger.warn(
      `Ride ${ride._id} round ${round}: ${requests.length} of ${rows.length} offers created` +
        (duplicates.length ? `, ${duplicates.length} already existed` : '')
    );
  }

  requests.forEach((request) => {
    notifications.toRider(request.riderId, SOCKET_EVENTS.RIDE_NEW, requestPayload(ride, request));
  });

  /**
   * An offer made is an offer counted — for the riders it actually reached,
   * not for everyone the search turned up. A duplicate that the index rejected
   * was never a new offer, and counting it would mark a rider as having
   * ignored a ring nobody sent them.
   *
   * Not awaited into the dispatch's critical path on purpose: a counter that
   * fails to move is a slightly stale ranking, and holding up an offer for it
   * would make a ranking detail cost somebody a ride.
   */
  if (requests.length) {
    Rider.updateMany({ _id: { $in: requests.map((r) => r.riderId) } }, { $inc: { offersReceived: 1 } }).catch(
      (err) => logger.error(`Could not record offers for ride ${ride._id}: ${err.message}`)
    );
  }

  logger.debug(
    `[Ride] dispatched ride=${ride._id} round=${round} offers=${requests.length}` +
      ` expiresAt=${expiresAt.toISOString()} requestIds=${requests.map((r) => r._id).join(',')}`
  );

  // A round that reached nobody is the same outcome as finding nobody nearby,
  // and the customer has to be told either way — otherwise the app sits on
  // "searching" until a timer that was never armed fails to fire.
  if (!requests.length) {
    notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_NO_RIDERS, { rideId: ride._id });
    return { requested: 0, round };
  }

  // Only arm the clock once something is actually pending. An empty round with
  // a timer would fire an expiry for offers that were never made.
  scheduleExpiry(ride._id, expiresAt);

  return { requested: requests.length, round, expiresAt };
}

function scheduleExpiry(rideId, expiresAt) {
  cancelExpiry(rideId);

  const delay = Math.max(expiresAt.getTime() - Date.now(), 0) + 500;
  const timer = setTimeout(() => {
    timers.delete(String(rideId));
    expireRide(rideId).catch((err) => logger.error('Ride request expiry sweep failed', err));
  }, delay);

  if (timer.unref) timer.unref();
  timers.set(String(rideId), timer);
}

function cancelExpiry(rideId) {
  const timer = timers.get(String(rideId));
  if (timer) {
    clearTimeout(timer);
    timers.delete(String(rideId));
  }
}

/**
 * Closes out every offer whose deadline has passed, and tells the customer if
 * the ride is still unassigned.
 *
 * The predicate is `expiresAt <= now`, not simply "pending". Scoped only by
 * ride, this sweep would also close the offers of a round that had just been
 * dispatched — and a customer who taps "Request again" in the half-second
 * between a deadline passing and this sweep running gets exactly that overlap.
 * Comparing the deadline makes the sweep self-limiting: it can only ever close
 * what is genuinely overdue, so a live round is untouchable and any offer left
 * behind by a cancelled timer is cleaned up by the next sweep instead of
 * lingering as PENDING for ever.
 */
async function expireRide(rideId) {
  const now = new Date();

  const overdue = await RideRequest.find({
    rideId,
    status: RIDE_REQUEST_STATUS.PENDING,
    expiresAt: { $lte: now }
  })
    .select({ _id: 1, riderId: 1, round: 1 })
    .lean();

  if (overdue.length) {
    await RideRequest.updateMany(
      { _id: { $in: overdue.map((r) => r._id) }, status: RIDE_REQUEST_STATUS.PENDING },
      { status: RIDE_REQUEST_STATUS.EXPIRED, respondedAt: now }
    );
  }

  const ride = await Ride.findById(rideId);
  if (!ride) return;

  // Still-live offers mean a newer round is running, so this sweep is history
  // catching up and must not tell anyone the search is over.
  const stillLive = await RideRequest.countDocuments({
    rideId,
    status: RIDE_REQUEST_STATUS.PENDING,
    expiresAt: { $gt: now }
  });
  if (stillLive > 0) return;

  /**
   * Which offers died, named individually.
   *
   * The event used to carry only `rideId`, which does not change between
   * rounds — so a late expiry from round one was indistinguishable from the
   * expiry of the round the customer is actually watching, and could blank a
   * live search. Listing the offer ids lets every client ignore an event that
   * is not about what it currently holds.
   */
  logger.debug(
    `[Ride] expired ride=${rideId} offers=${overdue.length}` +
      ` requestIds=${overdue.map((r) => r._id).join(',')}`
  );

  notifications.toRide(rideId, SOCKET_EVENTS.RIDE_EXPIRED, {
    rideId,
    expiredRequests: overdue.length,
    requestIds: overdue.map((r) => String(r._id)),
    round: overdue.length ? Math.max(...overdue.map((r) => r.round ?? 0)) : (ride.reRequestCount || 0)
  });

  if (ride.status === RIDE_STATUS.SEARCHING) {
    notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_NO_RIDERS, {
      rideId,
      message: 'No rider accepted the request in time'
    });
  }
}

// Called once a ride leaves SEARCHING, so the losing riders stop seeing the card.
async function invalidateOtherRequests(rideId, acceptedRequestId) {
  const losing = await RideRequest.find({
    rideId,
    _id: { $ne: acceptedRequestId },
    status: RIDE_REQUEST_STATUS.PENDING
  }).select('_id riderId');

  if (!losing.length) return;

  await RideRequest.updateMany(
    { _id: { $in: losing.map((r) => r._id) } },
    { status: RIDE_REQUEST_STATUS.EXPIRED, respondedAt: new Date() }
  );

  losing.forEach((request) => {
    notifications.toRider(request.riderId, SOCKET_EVENTS.RIDE_EXPIRED, {
      requestId: request._id,
      rideId,
      reason: 'Another rider accepted this ride'
    });
  });
}

async function cancelPendingRequests(rideId, reason = 'Ride cancelled') {
  cancelExpiry(rideId);

  const pending = await RideRequest.find({ rideId, status: RIDE_REQUEST_STATUS.PENDING }).select('_id riderId');
  if (!pending.length) return;

  await RideRequest.updateMany(
    { rideId, status: RIDE_REQUEST_STATUS.PENDING },
    { status: RIDE_REQUEST_STATUS.CANCELLED, respondedAt: new Date() }
  );

  pending.forEach((request) => {
    notifications.toRider(request.riderId, SOCKET_EVENTS.RIDE_CANCELLED, {
      requestId: request._id,
      rideId,
      reason
    });
  });
}

module.exports = {
  findNearbyRiders,
  dispatchRide,
  // Exported for tests: the ranking is arithmetic, and it is worth checking
  // without a database standing in the way.
  reliabilityFields,
  scoreExpression,
  expireRide,
  invalidateOtherRequests,
  cancelPendingRequests,
  cancelExpiry,
  requestPayload,
  coordsOf
};
