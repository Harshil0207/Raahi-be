const Ride = require('../models/Ride');
const settings = require('./settings.service');
const notifications = require('./notification.service');
const feed = require('./notification.feed');
const rideService = require('./ride.service');
const logger = require('../utils/logger');
const { haversineKm } = require('../utils/calculateDistance');
const { SOCKET_EVENTS } = require('../constants/socketEvents');
const { RIDE_STATUS } = require('../constants/rideStatus');

/**
 * How close the rider is, and what that means.
 *
 * THE SERVER DECIDES ARRIVAL. A rider's phone saying "I'm here" is a claim; the
 * distance between two coordinates is a fact, and a fare and a wait time hang
 * off which one the platform believes. So the transition to ARRIVED is made
 * here, from the rider's own reported position, measured against the pickup the
 * customer chose — and the rider's manual "I've arrived" button still works
 * beside it, for the case where GPS is being useless and they really are there.
 *
 * It does NOT own the transition itself. `ride.service.markArrived` already
 * writes the status, records the notification and tells the admin board, and
 * having two places that can move a ride to ARRIVED is how those three things
 * drift apart. This decides *whether*; that performs.
 *
 * Nothing here may break a ride. It is called from the location path, which
 * runs several times a minute per active trip, so every failure is logged and
 * swallowed: a rider's position must keep flowing even if the proximity check
 * is having a bad day.
 */

const metresBetween = (from, to) => haversineKm(from, to) * 1000;

/**
 * The coordinates out of a stored place.
 *
 * A ride's pickup and destination are GeoJSON — `{ address, location: { type,
 * coordinates: [lng, lat] } }` — and GeoJSON puts LONGITUDE FIRST. Reading
 * `.lat` off one of those gives undefined, and the distance comes back NaN,
 * which compares false against every threshold: the rider would approach, the
 * customer would be told nothing, and the trip would never mark itself arrived.
 * A silent failure, in other words, which is why this is a named function
 * rather than an inline pair of indexes.
 */
function pointOf(place) {
  const coordinates = place?.location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const [lng, lat] = coordinates;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Is this fix good enough to act on?
 *
 * Accuracy is the radius the device thinks it is within. A phone indoors
 * reports a position a kilometre out with complete confidence, and acting on
 * that would tell a customer their rider had arrived while the rider was two
 * streets away. A fix that fails this is still broadcast — it is the best
 * anyone has, and the marker should move — but it decides nothing.
 *
 * `accuracy` absent is treated as usable: some browsers omit it, and refusing
 * every fix from those devices would turn tracking off for them entirely.
 */
function isDecisive(payload) {
  const accuracy = payload?.accuracy;
  if (accuracy == null) return true;
  if (!Number.isFinite(accuracy) || accuracy < 0) return false;

  return accuracy <= settings.get('tracking.maxAccuracyMeters');
}

/** The point the rider is currently heading for, or null if they are not. */
function targetOf(ride) {
  // Before the code is verified, the rider is going to the customer.
  if (ride.status === RIDE_STATUS.ACCEPTED || ride.status === RIDE_STATUS.ARRIVING) {
    const point = pointOf(ride.pickup);
    return point ? { point, leg: 'pickup' } : null;
  }

  // Afterwards they are going to the drop-off. Distance is still worth
  // reporting — it is what the customer's "x km away" reads from — but there is
  // no arrival to detect: the trip ends when the rider completes it.
  if (ride.status === RIDE_STATUS.OTP_VERIFIED || ride.status === RIDE_STATUS.IN_PROGRESS) {
    const point = pointOf(ride.destination);
    return point ? { point, leg: 'destination' } : null;
  }

  return null;
}

/**
 * One rider position, considered.
 *
 * Returns what it worked out, for the caller to log or ignore. Callers must not
 * depend on it: this is a side-effect function whose return value exists for
 * tests and diagnostics.
 */
async function onRiderFix(rideId, riderId, payload) {
  if (!settings.get('tracking.enabled')) return { skipped: 'tracking disabled' };

  const ride = await Ride.findById(rideId);
  if (!ride) return { skipped: 'ride not found' };

  // Only the assigned rider's position says anything about this ride.
  if (!ride.riderId || String(ride.riderId) !== String(riderId)) {
    return { skipped: 'not the assigned rider' };
  }

  const target = targetOf(ride);
  if (!target) return { skipped: `nothing to measure in ${ride.status}` };

  const distance = Math.round(metresBetween({ lat: payload.lat, lng: payload.lng }, target.point));
  const decisive = isDecisive(payload);

  // The measurement is recorded either way, so a customer reconnecting is told
  // how far off their rider is without waiting for the next ping. A fix too
  // vague to decide on is still the best estimate of where the rider is.
  ride.tracking.lastDistanceMeters = distance;
  ride.tracking.lastFixAt = new Date();

  if (!decisive) {
    await ride.save();
    return { distance, leg: target.leg, decided: false, reason: 'fix not accurate enough' };
  }

  // Only the approach to the pickup has thresholds. On the way to the
  // destination the distance is information, not a trigger.
  if (target.leg !== 'pickup') {
    await ride.save();
    return { distance, leg: target.leg, decided: false };
  }

  const nearbyAt = settings.get('tracking.nearbyMeters');
  const arrivedAt = settings.get('tracking.arrivedMeters');

  let nearby = false;
  let arrived = false;

  /**
   * Nearby, once.
   *
   * The latch is written before the notification is sent, and saved with the
   * rest of the ride: two fixes arriving together would otherwise both find it
   * unset and both notify. A duplicate here is not cosmetic — it is the same
   * phone buzzing twice for one event.
   */
  if (distance <= nearbyAt && !ride.tracking.nearbyNotifiedAt) {
    ride.tracking.nearbyNotifiedAt = new Date();
    nearby = true;
  }

  await ride.save();

  if (nearby) {
    notifications.toCustomer(ride.customerId, SOCKET_EVENTS.RIDE_RIDER_NEARBY, {
      rideId: ride._id,
      status: ride.status,
      distanceMeters: distance
    });

    feed.record(
      ride.customerId,
      feed.NOTIFICATION_TYPE.RIDER_NEARBY,
      'Your rider is nearby',
      'They are close to your pickup point.',
      ride._id
    );
  }

  /**
   * Arrived.
   *
   * Delegated rather than written here, so the status, the stored notification
   * and the admin board all move together — the same path the rider's own
   * button takes. `markArrived` asserts the transition itself, so a ride that
   * has already moved on is refused there rather than double-guarded here.
   */
  if (distance <= arrivedAt && ride.status !== RIDE_STATUS.ARRIVED) {
    try {
      await rideService.markArrived(ride._id, { _id: ride.riderId });
      arrived = true;
    } catch (err) {
      // A ride that moved on between the read and the write, or a transition
      // the table refuses. Neither is a fault worth breaking the stream for.
      logger.debug(`Tracking: could not mark ride ${ride._id} arrived — ${err.message}`);
    }
  }

  return { distance, leg: target.leg, decided: true, nearby, arrived };
}

/**
 * Whatever the customer's screen needs to describe the approach.
 *
 * Read on reconnect and on refresh, so a customer coming back does not sit
 * looking at a blank card until the next ping arrives.
 */
function summarise(ride) {
  const staleAfter = settings.get('tracking.staleAfterSeconds') * 1000;
  const lastFixAt = ride.tracking?.lastFixAt || null;

  return {
    enabled: settings.get('tracking.enabled'),
    distanceMeters: ride.tracking?.lastDistanceMeters ?? null,
    lastFixAt,
    // "Going stale", not "offline". A phone in a lift is not a rider who has
    // abandoned the trip, and saying so starts a support ticket over a tunnel.
    stale: lastFixAt ? Date.now() - new Date(lastFixAt).getTime() > staleAfter : true,
    nearbyNotifiedAt: ride.tracking?.nearbyNotifiedAt || null,
    /**
     * The window itself, not just the verdict.
     *
     * `stale` above is true at the moment this was built. A screen has to keep
     * deciding it afterwards, because nothing re-renders while nothing is
     * arriving — which is exactly the state being detected. Sending the number
     * is what stops the client hard-coding its own.
     */
    staleAfterSeconds: settings.get('tracking.staleAfterSeconds'),
    thresholds: {
      nearbyMeters: settings.get('tracking.nearbyMeters'),
      arrivedMeters: settings.get('tracking.arrivedMeters')
    }
  };
}

module.exports = {
  onRiderFix,
  summarise,
  // Exported for tests: these are the decisions worth checking on their own, and
  // neither needs a database to be right.
  isDecisive,
  targetOf,
  metresBetween,
  pointOf
};
