const Rider = require('../models/Rider');
const ApiError = require('../utils/ApiError');
const { RIDER_VERIFICATION } = require('../constants/riderVerification');
const settings = require('./settings.service');
const walletService = require('./wallet.service');
const { ACTIVE_RIDE_STATUSES } = require('../constants/rideStatus');
const Ride = require('../models/Ride');
const logger = require('../utils/logger');
const { ROLES } = require('../constants/userRoles');

async function getProfile(rider) {
  await rider.populate('userId', 'name email phone');
  const wallet = await walletService.summary(rider._id);

  return {
    ...rider.toPublic(),
    user: {
      name: rider.userId.name,
      email: rider.userId.email,
      phone: rider.userId.phone
    },
    // Carried on the profile so the driving screen knows on first load whether
    // the rider is blocked, rather than finding out when they tap GO.
    wallet: {
      outstanding: wallet.outstanding,
      available: wallet.available,
      currency: wallet.currency,
      status: wallet.status,
      canGoOnline: wallet.canGoOnline,
      nearingLimit: wallet.nearingLimit,
      threshold: wallet.threshold,
      requiredRecharge: wallet.requiredRecharge
    }
  };
}

async function updateProfile(rider, updates) {
  if (updates.vehicle) Object.assign(rider.vehicle, updates.vehicle);
  if (updates.licence) Object.assign(rider.licence, updates.licence);
  await rider.save();
  return rider.toPublic();
}

/**
 * Going offline is refused mid-ride: a rider with a customer on board cannot
 * simply disappear from the system.
 */
async function setStatus(rider, isOnline) {
  if (!isOnline && rider.activeRideId) {
    const active = await Ride.exists({ _id: rider.activeRideId, status: { $in: ACTIVE_RIDE_STATUSES } });
    if (active) throw ApiError.conflict('Finish or cancel your current ride before going offline');
  }

  if (isOnline && settings.get('rider.onlineRequiresLocation') && !rider.currentLocation) {
    throw ApiError.badRequest('Send your current location before going online');
  }

  /**
   * Cleared to carry passengers, before anything else about going online.
   *
   * The gate itself is a platform setting, defaulting to ON. Turning it off is
   * how a local or staging environment stops needing a human in the loop for
   * every test rider; a live deployment that turns it off has decided to let
   * anyone who registers carry passengers, which is why it says so in the
   * setting's own description rather than being a quiet flag.
   *
   * Server-side, on the endpoint, not in the app: the button can be hidden but
   * the route is reachable either way, and "the UI does not show it" is not a
   * rule. Only going online is gated — a rider already on a trip is never
   * thrown off it, and going offline is always allowed.
   */
  if (isOnline && settings.get('rider.requireVerification') && !rider.isVerified()) {
    throw ApiError.forbidden(
      rider.verification === RIDER_VERIFICATION.REJECTED
        ? 'Your rider application was not approved. Contact support if you think this is wrong.'
        : 'Your rider account is waiting to be approved. You will be able to go online once it is.'
    );
  }

  if (isOnline && settings.get('system.maintenanceMode')) {
    throw ApiError.conflict(settings.get('system.maintenanceMessage'));
  }

  /**
   * What the rider owes the platform.
   *
   * Checked here, on the way in, rather than only in the app: the endpoint is
   * reachable with or without the button, and a rule that lives in React is a
   * suggestion. Only going *online* is gated — going offline is always allowed,
   * and a trip already running is never touched by this.
   */
  if (isOnline) await walletService.assertCanGoOnline(rider._id);

  // Bank the finished session before flipping the flag, so the running total
  // stays accurate without a scheduled job.
  if (isOnline && !rider.isOnline) {
    rider.onlineSince = new Date();
  } else if (!isOnline && rider.isOnline && rider.onlineSince) {
    rider.onlineSeconds += Math.floor((Date.now() - rider.onlineSince.getTime()) / 1000);
    rider.onlineSince = null;
  }

  rider.isOnline = isOnline;
  rider.isAvailable = isOnline ? !rider.activeRideId : false;
  await rider.save();

  return rider.toPublic();
}

async function getActiveRide(rider) {
  if (!rider.activeRideId) return null;
  const ride = await Ride.findOne({ _id: rider.activeRideId, status: { $in: ACTIVE_RIDE_STATUSES } });
  return ride || null;
}

/**
 * Creating the rider profile for somebody who signed in before they had one.
 *
 * A Google sign-up gives Raahi a name and a verified address. It gives no
 * vehicle and no licence, so there is no rider profile to create at that moment
 * — the account exists with `role: rider` and nothing to drive. This is the
 * step that fills that in, and it lands the rider in PENDING like every other
 * new rider rather than anywhere closer to the road.
 *
 * Refuses when a profile already exists, so it cannot be used to overwrite a
 * rejected rider's details and quietly re-enter the queue.
 */
async function createProfile(user, { vehicle, licence }) {
  if (user.role !== ROLES.RIDER) {
    throw ApiError.forbidden('This account is not a rider account');
  }

  const existing = await Rider.findOne({ userId: user._id });
  if (existing) {
    throw ApiError.conflict('This account already has a rider profile');
  }

  const rider = await Rider.create({
    userId: user._id,
    vehicle,
    licence,
    verificationStatus: RIDER_VERIFICATION.PENDING
  });

  logger.info(`[Rider] profile created for ${user._id}, pending verification`);
  return rider.toPublic();
}

module.exports = { getProfile, updateProfile, setStatus, getActiveRide, createProfile };
