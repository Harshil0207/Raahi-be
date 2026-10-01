const User = require('../../models/User');
const Rider = require('../../models/Rider');
const { ADMIN_SETTABLE, CAN_GO_ONLINE } = require('../../constants/riderVerification');
const Ride = require('../../models/Ride');
const Payment = require('../../models/Payment');
const ApiError = require('../../utils/ApiError');
const audit = require('../audit.service');
const complaintService = require('../complaint.service');
const earningsService = require('../earnings.service');
const notifications = require('../notification.service');
const { ROLES } = require('../../constants/userRoles');
const { RIDE_STATUS, ACTIVE_RIDE_STATUSES } = require('../../constants/rideStatus');

/**
 * Customer and rider management.
 *
 * Both are Users underneath, so the two halves share their search and blocking
 * logic. What differs is the detail view: a rider has a vehicle, a licence, a
 * location and earnings, and a customer has none of those.
 *
 * Nothing here returns a password, a refresh token or an OTP. The list of
 * selected fields is explicit for exactly that reason — a `find()` with no
 * projection would start leaking the moment someone adds a sensitive field.
 */

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PUBLIC_USER_FIELDS = 'name email phone role isActive createdAt updatedAt';

/**
 * Search across name, email and phone.
 *
 * Anchored to the start of the term for phone and email so the query can use an
 * index; name stays a contains-match because operators search by surname.
 */
function searchFilter(search) {
  if (!search) return {};
  const term = escapeRegex(search.trim());
  return {
    $or: [
      { name: new RegExp(term, 'i') },
      { email: new RegExp(`^${term}`, 'i') },
      { phone: new RegExp(`${term}$`) }
    ]
  };
}

// ---------------------------------------------------------------- customers

async function listCustomers({ page = 1, limit = 25, search, isActive, from, to } = {}) {
  const filter = { role: ROLES.CUSTOMER, ...searchFilter(search) };
  if (typeof isActive === 'boolean') filter.isActive = isActive;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const [customers, total] = await Promise.all([
    User.find(filter)
      .select(PUBLIC_USER_FIELDS)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter)
  ]);

  // Ride counts for the page only — a per-row count over the whole collection
  // is the classic way to make a list page quadratic.
  const ids = customers.map((c) => c._id);
  const rideCounts = ids.length
    ? await Ride.aggregate([
        { $match: { customerId: { $in: ids } } },
        {
          $group: {
            _id: '$customerId',
            rides: { $sum: 1 },
            completed: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, 1, 0] } },
            spend: { $sum: { $ifNull: ['$finalFare', 0] } },
            lastRideAt: { $max: '$createdAt' }
          }
        }
      ])
    : [];

  const statsBy = new Map(rideCounts.map((row) => [String(row._id), row]));

  return {
    customers: customers.map((customer) => ({
      ...customer,
      stats: statsBy.get(String(customer._id)) || { rides: 0, completed: 0, spend: 0, lastRideAt: null }
    })),
    total,
    page,
    limit
  };
}

async function customerDetail(userId) {
  const customer = await User.findOne({ _id: userId, role: ROLES.CUSTOMER }).select(PUBLIC_USER_FIELDS).lean();
  if (!customer) throw ApiError.notFound('Customer not found');

  const [rides, activeRide, payments, complaints, totals] = await Promise.all([
    Ride.find({ customerId: userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('status pickup.address destination.address estimatedFare finalFare currency payment createdAt completedAt rating')
      .lean(),
    Ride.findOne({ customerId: userId, status: { $in: ACTIVE_RIDE_STATUSES } })
      .select('status pickup.address destination.address estimatedFare currency riderId createdAt')
      .lean(),
    Payment.find({ customerId: userId }).sort({ createdAt: -1 }).limit(20).lean(),
    complaintService.forUser(userId),
    Ride.aggregate([
      { $match: { customerId: customer._id } },
      {
        $group: {
          _id: null,
          rides: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.CANCELLED] }, 1, 0] } },
          spend: { $sum: { $ifNull: ['$finalFare', 0] } },
          distanceKm: { $sum: { $ifNull: ['$finalDistanceKm', 0] } }
        }
      }
    ])
  ]);

  return {
    customer,
    stats: totals[0] || { rides: 0, completed: 0, cancelled: 0, spend: 0, distanceKm: 0 },
    activeRide,
    rides,
    payments,
    complaints
  };
}

// ------------------------------------------------------------------- riders

async function listRiders({ page = 1, limit = 25, search, isOnline, isAvailable, isActive, from, to } = {}) {
  // Rider fields and user fields live in different collections, so a search term
  // is resolved against users first and the ids carried into the rider query.
  const riderFilter = {};
  if (typeof isOnline === 'boolean') riderFilter.isOnline = isOnline;
  if (typeof isAvailable === 'boolean') riderFilter.isAvailable = isAvailable;
  if (from || to) {
    riderFilter.createdAt = {};
    if (from) riderFilter.createdAt.$gte = from;
    if (to) riderFilter.createdAt.$lte = to;
  }

  if (search || typeof isActive === 'boolean') {
    const userFilter = { role: ROLES.RIDER, ...searchFilter(search) };
    if (typeof isActive === 'boolean') userFilter.isActive = isActive;

    const userIds = await User.find(userFilter).select('_id').limit(500).lean();
    riderFilter.userId = { $in: userIds.map((u) => u._id) };
  }

  const [riders, total] = await Promise.all([
    Rider.find(riderFilter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('userId', PUBLIC_USER_FIELDS)
      .lean(),
    Rider.countDocuments(riderFilter)
  ]);

  return {
    riders: riders.map((rider) => ({
      id: rider._id,
      user: rider.userId,
      vehicle: rider.vehicle,
      isOnline: rider.isOnline,
      isAvailable: rider.isAvailable,
      activeRideId: rider.activeRideId,
      totalRides: rider.totalRides,
      rating: rider.rating,
      lastLocationAt: rider.lastLocationAt,
      createdAt: rider.createdAt
    })),
    total,
    page,
    limit
  };
}

async function riderDetail(riderId) {
  const rider = await Rider.findById(riderId).populate('userId', PUBLIC_USER_FIELDS);
  if (!rider) throw ApiError.notFound('Rider not found');

  const [rides, activeRide, payments, complaints, earnings, stats] = await Promise.all([
    Ride.find({ riderId: rider._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select('status pickup.address destination.address finalFare currency payment createdAt completedAt rating')
      .lean(),
    rider.activeRideId
      ? Ride.findById(rider.activeRideId)
          .select('status pickup.address destination.address estimatedFare currency customerId createdAt')
          .populate('customerId', 'name phone')
          .lean()
      : null,
    Payment.find({ riderId: rider._id }).sort({ createdAt: -1 }).limit(20).lean(),
    complaintService.forUser(rider.userId._id),
    earningsService.getEarnings(rider._id, { days: 14 }),
    earningsService.getStats(rider)
  ]);

  return {
    rider: {
      id: rider._id,
      user: rider.userId,
      vehicle: rider.vehicle,
      // Licence number is operationally necessary for a dispute; nothing else
      // about the document is exposed.
      licence: rider.licence ? { number: rider.licence.number } : null,
      isOnline: rider.isOnline,
      isAvailable: rider.isAvailable,
      onlineSince: rider.onlineSince,
      activeRideId: rider.activeRideId,
      totalRides: rider.totalRides,
      rating: rider.rating,
      currentLocation: rider.currentLocation,
      lastLocationAt: rider.lastLocationAt,
      createdAt: rider.createdAt
    },
    activeRide,
    rides,
    payments,
    complaints,
    earnings,
    stats
  };
}

// ------------------------------------------------------------------ mutations

/**
 * Blocks or unblocks an account.
 *
 * `isActive` is the same flag the customer and rider authentication already
 * checks, so a blocked account stops working on the next request rather than
 * only at the next login. A rider is also taken offline, because an account that
 * cannot authenticate must not stay in the matching pool.
 */
async function setBlocked(req, userId, { blocked, reason }) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  if (user.isActive === !blocked) {
    return { id: user._id, isActive: user.isActive, unchanged: true };
  }

  if (blocked) {
    const active = await Ride.findOne({
      $or: [{ customerId: user._id }, { riderId: await riderIdOf(user) }],
      status: { $in: ACTIVE_RIDE_STATUSES }
    }).select('_id');

    if (active) {
      throw ApiError.conflict(
        `This account is on ride ${active._id}. Resolve the ride before blocking, so neither party is left stranded.`
      );
    }
  }

  user.isActive = !blocked;
  // A blocked account's refresh tokens go too, otherwise a stored session could
  // mint a fresh access token for an hour.
  if (blocked) user.refreshTokens = [];
  await user.save();

  if (user.role === ROLES.RIDER) {
    await Rider.updateOne({ userId: user._id }, { isOnline: false, isAvailable: false });
  }

  notifications.toUser(user._id, 'account:status', { isActive: user.isActive });

  await audit.record(req, {
    action: blocked ? 'account.block' : 'account.unblock',
    resource: user.role === ROLES.RIDER ? 'Rider' : 'Customer',
    resourceId: user._id,
    oldValue: { isActive: !user.isActive },
    newValue: { isActive: user.isActive },
    note: reason || null
  });

  return { id: user._id, isActive: user.isActive };
}

async function riderIdOf(user) {
  if (user.role !== ROLES.RIDER) return null;
  const rider = await Rider.findOne({ userId: user._id }).select('_id');
  return rider?._id || null;
}

/**
 * Corrects contact details. Deliberately narrow: an admin may fix a mistyped
 * name or phone number, and may not change an email or a role, because either
 * would amount to taking over the account.
 */
async function updateAccount(req, userId, patch) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('Account not found');

  const before = { name: user.name, phone: user.phone };

  if (patch.name !== undefined) user.name = patch.name;
  if (patch.phone !== undefined) {
    const clash = await User.findOne({ phone: patch.phone, _id: { $ne: user._id } }).select('_id');
    if (clash) throw ApiError.conflict('Another account already uses that phone number');
    user.phone = patch.phone;
  }

  await user.save();

  await audit.record(req, {
    action: 'account.update',
    resource: user.role === ROLES.RIDER ? 'Rider' : 'Customer',
    resourceId: user._id,
    oldValue: before,
    newValue: { name: user.name, phone: user.phone }
  });

  return user.toPublic();
}

/**
 * Takes a rider offline from the console.
 *
 * Only ever in that direction. An admin cannot put a rider *online*: being
 * online means a real person is available to drive, and the platform has no way
 * to know that on their behalf.
 */
/**
 * Clearing a rider to carry passengers, or refusing to.
 *
 * The judgement this whole gate exists for, and the one thing in it a machine
 * does not decide. Rejecting takes the rider off the road immediately if they
 * are on it — an approval that can be revoked but leaves the rider online until
 * they next toggle it is not a revocation.
 *
 * `GRANDFATHERED` is not settable: it means "was working before any of this
 * existed" and an admin asserting it retrospectively would erase the
 * distinction between a rider somebody checked and one nobody has.
 */
async function setRiderVerification(req, riderId, { status, note }) {
  const rider = await Rider.findById(riderId);
  if (!rider) throw ApiError.notFound('Rider not found');

  if (!ADMIN_SETTABLE.includes(status)) {
    throw ApiError.badRequest('That is not a verification status an admin can set');
  }

  const before = rider.verification;
  if (before === status) {
    return { id: rider._id, verificationStatus: status, unchanged: true };
  }

  rider.verificationStatus = status;
  rider.verificationNote = note || null;
  rider.verifiedAt = new Date();
  rider.verifiedBy = req.admin?._id || null;

  // Anything other than approval means they are not allowed to be out there,
  // so they come off the road now rather than at their next toggle.
  if (!CAN_GO_ONLINE.includes(status) && rider.isOnline) {
    if (rider.activeRideId) {
      throw ApiError.conflict('This rider is on a ride. Resolve the ride before rejecting them.');
    }
    if (rider.onlineSince) {
      rider.onlineSeconds += Math.floor((Date.now() - rider.onlineSince.getTime()) / 1000);
      rider.onlineSince = null;
    }
    rider.isOnline = false;
    rider.isAvailable = false;
  }

  await rider.save();

  notifications.toRider(rider._id, 'rider:verification', {
    verificationStatus: status,
    note: rider.verificationNote
  });

  await audit.record(req, {
    action: 'rider.verification',
    resource: 'Rider',
    resourceId: rider._id,
    oldValue: { verificationStatus: before },
    newValue: { verificationStatus: status },
    note: note || null
  });

  return { id: rider._id, verificationStatus: status, unchanged: false };
}

async function forceRiderOffline(req, riderId, reason) {
  const rider = await Rider.findById(riderId);
  if (!rider) throw ApiError.notFound('Rider not found');

  if (rider.activeRideId) {
    throw ApiError.conflict('This rider is on a ride. Resolve the ride first.');
  }
  if (!rider.isOnline) return { id: rider._id, isOnline: false, unchanged: true };

  if (rider.onlineSince) {
    rider.onlineSeconds += Math.floor((Date.now() - rider.onlineSince.getTime()) / 1000);
    rider.onlineSince = null;
  }
  rider.isOnline = false;
  rider.isAvailable = false;
  await rider.save();

  notifications.toRider(rider._id, 'rider:forced_offline', { reason: reason || null });

  await audit.record(req, {
    action: 'rider.force_offline',
    resource: 'Rider',
    resourceId: rider._id,
    oldValue: { isOnline: true },
    newValue: { isOnline: false },
    note: reason || null
  });

  return { id: rider._id, isOnline: false };
}

module.exports = {
  setRiderVerification,
  listCustomers,
  customerDetail,
  listRiders,
  riderDetail,
  setBlocked,
  updateAccount,
  forceRiderOffline
};
