const settings = require('./settings.service');
const Location = require('../models/Location');
const Rider = require('../models/Rider');
const Ride = require('../models/Ride');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const notifications = require('./notification.service');
const tracking = require('./tracking.service');
const mapsService = require('./maps.service');
const { SOCKET_EVENTS } = require('../constants/socketEvents');
const { isValidCoordinates } = require('../utils/calculateDistance');

const toPoint = ({ lat, lng }) => ({ type: 'Point', coordinates: [lng, lat] });
const fromPoint = (point) =>
  point?.coordinates ? { lat: point.coordinates[1], lng: point.coordinates[0] } : null;

function assertCoordinates(coords) {
  if (!isValidCoordinates(coords)) {
    throw ApiError.badRequest('Latitude and longitude are out of range');
  }
}

// Device location for any user. Riders keep their authoritative position on the
// Rider document as well, since that is what the geospatial matching reads.
async function saveDeviceLocation(userId, payload) {
  assertCoordinates(payload);

  const doc = await Location.findOneAndUpdate(
    { userId },
    {
      location: toPoint(payload),
      accuracy: payload.accuracy,
      heading: payload.heading,
      speed: payload.speed,
      recordedAt: new Date()
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return { ...fromPoint(doc.location), recordedAt: doc.recordedAt };
}

async function getCurrentLocation(userId) {
  const doc = await Location.findOne({ userId });
  if (!doc) throw ApiError.notFound('No location on record for this user');

  return {
    ...fromPoint(doc.location),
    accuracy: doc.accuracy,
    heading: doc.heading,
    speed: doc.speed,
    recordedAt: doc.recordedAt
  };
}

/**
 * Rider position update. Accepted while offline too, because a rider has to have
 * a known position before they are allowed to go online.
 *
 * Writes are throttled to one every LOCATION_MIN_UPDATE_INTERVAL_MS while the
 * rider is idle; during an active ride every ping is persisted because the
 * customer is watching the marker move. The broadcast happens either way, so
 * clients still see a smooth track — this is the seam where a Redis-backed store
 * would replace the Mongo write later.
 */
async function updateRiderLocation(rider, payload) {
  assertCoordinates(payload);

  const onActiveRide = Boolean(rider.activeRideId);
  const sinceLastWrite = rider.lastLocationAt ? Date.now() - rider.lastLocationAt.getTime() : Infinity;
  const shouldPersist = onActiveRide || sinceLastWrite >= settings.get('rider.locationUpdateIntervalMs');

  if (shouldPersist) {
    await Rider.updateOne(
      { _id: rider._id },
      { currentLocation: toPoint(payload), lastLocationAt: new Date() }
    );
  }

  if (!onActiveRide) return { persisted: shouldPersist, onActiveRide };

  /**
   * How far the rider is from where they are going, and what that means.
   *
   * Awaited rather than fired and forgotten, because the distance it works out
   * is included in the broadcast below — a customer should get the marker and
   * the "1.8 km away" in one message rather than in two that disagree for a
   * second. It never throws: see the note in `tracking.service`.
   */
  let proximity = null;
  try {
    proximity = await tracking.onRiderFix(rider.activeRideId, rider._id, payload);
  } catch (err) {
    logger.warn(`Proximity check failed for ride ${rider.activeRideId}: ${err.message}`);
  }

  notifications.toRide(rider.activeRideId, SOCKET_EVENTS.RIDER_LOCATION, {
    rideId: rider.activeRideId,
    riderId: rider._id,
    lat: payload.lat,
    lng: payload.lng,
    heading: payload.heading ?? null,
    // What the customer's card reads from. Null when the fix was too vague to
    // measure against, which the screen shows as "updating" rather than as a
    // distance it would be wrong to trust.
    distanceMeters: proximity?.distance ?? null,
    leg: proximity?.leg ?? null,
    at: new Date()
  });

  return { persisted: shouldPersist, onActiveRide, proximity };
}

/**
 * Where the rider is, how far off, and how long they are likely to be.
 *
 * Read on refresh and on reconnect, so somebody coming back to the screen is
 * not left looking at a blank card until the next ping. Both parties may read
 * it: the customer watches their rider approach, and the rider's own screen
 * shows the same distance and ETA for the leg they are driving.
 *
 * The ETA is computed here rather than on every position update, because it is
 * a call to the routing provider and a rider sends a position several times a
 * minute. A screen asking for it every half-minute is proportionate; asking for
 * it on every fix would be a routing bill for no extra precision.
 */
async function getRideTracking(rideId, actor) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  /**
   * Who may see this.
   *
   * Checked against the ride document, never against ids in the request. A
   * rider is matched on their rider profile and a customer on their user
   * account, because those are different collections and comparing the wrong
   * pair would let one ride's participant read another's.
   */
  const isCustomer = String(ride.customerId) === String(actor.userId);
  const isRider = actor.riderId && ride.riderId && String(ride.riderId) === String(actor.riderId);

  if (!isCustomer && !isRider) throw ApiError.notFound('Ride not found');

  if (!ride.riderId) throw ApiError.badRequest('No rider is assigned to this ride yet');

  const rider = await Rider.findById(ride.riderId);
  const position = fromPoint(rider?.currentLocation);

  const summary = tracking.summarise(ride);
  const target = tracking.targetOf(ride);

  /**
   * The estimate, and only when there is something to estimate.
   *
   * `getRoute` falls back to a straight line when the provider is unreachable,
   * and reports that by leaving `durationMin` null. That null is carried
   * through rather than filled in: a screen showing "Calculating ETA…" is
   * honest, and "0 min" is not.
   */
  let eta = null;
  if (position && target) {
    const route = await mapsService.getRoute(position, target.point);
    eta = {
      leg: target.leg,
      durationMin: route.durationMin ?? null,
      distanceKm: route.distanceKm ?? null,
      /**
       * The road the rider will actually take, encoded, when the provider
       * gave one.
       *
       * Null on the straight-line fallback, and the screen draws a dashed
       * direct line in that case rather than pretending a road was returned.
       * Both providers encode it the same way, so the client decodes one path.
       */
      polyline: route.polyline || null,
      source: route.source || mapsService.providerName
    };
  }

  return {
    rideId: String(ride._id),
    status: ride.status,
    position: position ? { ...position, updatedAt: rider.lastLocationAt } : null,
    tracking: summary,
    eta
  };
}

module.exports = {
  saveDeviceLocation,
  getCurrentLocation,
  updateRiderLocation,
  getRideTracking,
  toPoint,
  fromPoint
};
