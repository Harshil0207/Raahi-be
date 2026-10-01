const mongoose = require('mongoose');
const User = require('../../models/User');
const Rider = require('../../models/Rider');
const Ride = require('../../models/Ride');
const Payment = require('../../models/Payment');
const Complaint = require('../../models/Complaint');
const settings = require('../settings.service');
const { ROLES } = require('../../constants/userRoles');
const { RIDE_STATUS, ACTIVE_RIDE_STATUSES } = require('../../constants/rideStatus');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../../constants/paymentStatus');
const { OPEN_STATUSES, COMPLAINT_PRIORITY } = require('../../constants/complaint');

/**
 * The numbers on the dashboard, computed in MongoDB.
 *
 * Every figure is an aggregate over an indexed range. Nothing downloads a
 * collection to count it, and the whole dashboard is a fixed number of queries
 * regardless of how many rides exist — which is the only way a page like this
 * stays usable once the platform has real volume.
 *
 * Day boundaries are the server's local midnight, and the pipelines are told so
 * explicitly, because Mongo groups in UTC unless given a timezone and a
 * late-evening ride would otherwise land on the wrong day.
 */

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const round2 = (n) => Math.round(((n || 0) + Number.EPSILON) * 100) / 100;
const oid = (id) => new mongoose.Types.ObjectId(String(id));

const startOfDay = (d = new Date()) => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/** Turns a named range into the window the pipelines filter on. */
function resolveRange({ range = 'today', from, to } = {}) {
  const now = new Date();
  const today = startOfDay(now);

  const spans = {
    today: () => ({ from: today, to: now, label: 'Today' }),
    yesterday: () => {
      const start = new Date(today);
      start.setDate(start.getDate() - 1);
      return { from: start, to: new Date(today.getTime() - 1), label: 'Yesterday' };
    },
    last7: () => {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { from: start, to: now, label: 'Last 7 days' };
    },
    last30: () => {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { from: start, to: now, label: 'Last 30 days' };
    },
    month: () => ({
      from: new Date(now.getFullYear(), now.getMonth(), 1),
      to: now,
      label: 'This month'
    }),
    custom: () => ({
      from: from ? startOfDay(from) : today,
      // An inclusive end date: a custom range ending "today" should contain today.
      to: to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : now,
      label: 'Custom range'
    })
  };

  const resolved = (spans[range] || spans.today)();
  return { ...resolved, range };
}

const EMPTY_RIDE_TOTALS = {
  total: 0,
  completed: 0,
  cancelled: 0,
  revenue: 0,
  distanceKm: 0,
  avgFare: 0,
  avgDistanceKm: 0
};

/** Ride counts and money for one window, in a single grouped pass. */
async function rideTotals(from, to) {
  const [row] = await Ride.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.CANCELLED] }, 1, 0] } },
        revenue: { $sum: { $ifNull: ['$finalFare', 0] } },
        distanceKm: { $sum: { $ifNull: ['$finalDistanceKm', 0] } },
        completedDistance: {
          $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, { $ifNull: ['$finalDistanceKm', 0] }, 0] }
        }
      }
    }
  ]);

  if (!row) return { ...EMPTY_RIDE_TOTALS };

  return {
    total: row.total,
    completed: row.completed,
    cancelled: row.cancelled,
    revenue: round2(row.revenue),
    distanceKm: round2(row.distanceKm),
    // Averaged over completed rides only: a cancelled ride has no fare, and
    // including it would quietly drag the average toward zero.
    avgFare: row.completed ? round2(row.revenue / row.completed) : 0,
    avgDistanceKm: row.completed ? round2(row.completedDistance / row.completed) : 0
  };
}

/** Payment split for one window, by method and by settlement state. */
async function paymentTotals(from, to) {
  const [row] = await Payment.aggregate([
    { $match: { createdAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        cash: {
          $sum: { $cond: [{ $eq: ['$method', PAYMENT_METHOD.CASH] }, '$amount', 0] }
        },
        upi: {
          $sum: { $cond: [{ $eq: ['$method', PAYMENT_METHOD.UPI] }, '$amount', 0] }
        },
        settled: {
          $sum: { $cond: [{ $eq: ['$status', PAYMENT_STATUS.PAID] }, '$amount', 0] }
        },
        pending: {
          $sum: { $cond: [{ $ne: ['$status', PAYMENT_STATUS.PAID] }, '$amount', 0] }
        },
        count: { $sum: 1 }
      }
    }
  ]);

  if (!row) return { cash: 0, upi: 0, settled: 0, pending: 0, count: 0 };

  return {
    cash: round2(row.cash),
    upi: round2(row.upi),
    settled: round2(row.settled),
    pending: round2(row.pending),
    count: row.count
  };
}

/**
 * Headline figures.
 *
 * Some of these are point-in-time (riders online now) and some belong to the
 * chosen window (rides today). They are returned in separate objects so the UI
 * never labels a live number as if it were filtered.
 */
async function summary(options = {}) {
  const window = resolveRange(options);
  const { from, to } = window;

  const [
    customers,
    newCustomers,
    riders,
    newRiders,
    onlineRiders,
    availableRiders,
    activeRides,
    rides,
    payments,
    openComplaints,
    urgentComplaints
  ] = await Promise.all([
    User.countDocuments({ role: ROLES.CUSTOMER }),
    User.countDocuments({ role: ROLES.CUSTOMER, createdAt: { $gte: from, $lte: to } }),
    Rider.countDocuments(),
    Rider.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    Rider.countDocuments({ isOnline: true }),
    Rider.countDocuments({ isOnline: true, isAvailable: true, activeRideId: null }),
    Ride.countDocuments({ status: { $in: ACTIVE_RIDE_STATUSES } }),
    rideTotals(from, to),
    paymentTotals(from, to),
    Complaint.countDocuments({ status: { $in: OPEN_STATUSES } }),
    Complaint.countDocuments({ status: { $in: OPEN_STATUSES }, priority: COMPLAINT_PRIORITY.URGENT })
  ]);

  return {
    window: { range: window.range, from, to, label: window.label },

    // True right now, whatever window is selected.
    live: {
      totalCustomers: customers,
      totalRiders: riders,
      onlineRiders,
      offlineRiders: riders - onlineRiders,
      availableRiders,
      busyRiders: onlineRiders - availableRiders,
      activeRides,
      openComplaints,
      urgentComplaints,
      maintenanceMode: settings.get('system.maintenanceMode')
    },

    // Belongs to the selected window.
    period: {
      rides: rides.total,
      completedRides: rides.completed,
      cancelledRides: rides.cancelled,
      completionRate: rides.total ? Math.round((rides.completed / rides.total) * 100) : null,
      revenue: rides.revenue,
      avgFare: rides.avgFare,
      avgDistanceKm: rides.avgDistanceKm,
      newCustomers,
      newRiders,
      cashCollected: payments.cash,
      upiCollected: payments.upi,
      settled: payments.settled,
      pendingPayments: payments.pending,
      currency: settings.get('fare.currency')
    }
  };
}

/**
 * Daily series for the charts.
 *
 * One pass per collection with the days filled in afterwards, so a day with no
 * rides is a zero rather than a gap — a chart that silently drops empty days
 * misrepresents a quiet week as a busy one.
 */
async function series(options = {}) {
  const window = resolveRange(options);
  const { from, to } = window;

  const dayKey = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TIMEZONE } });

  const [rideRows, customerRows, riderRows, paymentRows, complaintRows] = await Promise.all([
    Ride.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: dayKey('$createdAt'),
          rides: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.COMPLETED] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', RIDE_STATUS.CANCELLED] }, 1, 0] } },
          revenue: { $sum: { $ifNull: ['$finalFare', 0] } }
        }
      }
    ]),
    User.aggregate([
      { $match: { role: ROLES.CUSTOMER, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: dayKey('$createdAt'), count: { $sum: 1 } } }
    ]),
    Rider.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: dayKey('$createdAt'), count: { $sum: 1 } } }
    ]),
    Payment.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: dayKey('$createdAt'),
          cash: { $sum: { $cond: [{ $eq: ['$method', PAYMENT_METHOD.CASH] }, '$amount', 0] } },
          upi: { $sum: { $cond: [{ $eq: ['$method', PAYMENT_METHOD.UPI] }, '$amount', 0] } }
        }
      }
    ]),
    Complaint.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: dayKey('$createdAt'), count: { $sum: 1 } } }
    ])
  ]);

  const index = (rows) => new Map(rows.map((row) => [row._id, row]));
  const rideBy = index(rideRows);
  const customerBy = index(customerRows);
  const riderBy = index(riderRows);
  const paymentBy = index(paymentRows);
  const complaintBy = index(complaintRows);

  const pad = (n) => String(n).padStart(2, '0');
  const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const days = [];
  const cursor = startOfDay(from);
  // A very long custom range would produce an unreadable chart and a large
  // payload; 180 points is more than any operator reads at once.
  for (let i = 0; i < 180 && cursor <= to; i += 1) {
    const key = localKey(cursor);
    const ride = rideBy.get(key);
    const payment = paymentBy.get(key);

    days.push({
      date: key,
      rides: ride?.rides || 0,
      completed: ride?.completed || 0,
      cancelled: ride?.cancelled || 0,
      revenue: round2(ride?.revenue || 0),
      newCustomers: customerBy.get(key)?.count || 0,
      newRiders: riderBy.get(key)?.count || 0,
      cash: round2(payment?.cash || 0),
      upi: round2(payment?.upi || 0),
      complaints: complaintBy.get(key)?.count || 0
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  const totals = days.reduce(
    (acc, day) => ({
      cash: round2(acc.cash + day.cash),
      upi: round2(acc.upi + day.upi)
    }),
    { cash: 0, upi: 0 }
  );

  return {
    window: { range: window.range, from, to, label: window.label },
    days,
    // Payment-method split for the donut, derived from the same pass.
    paymentMix: [
      { method: PAYMENT_METHOD.CASH, amount: totals.cash },
      { method: PAYMENT_METHOD.UPI, amount: totals.upi }
    ]
  };
}

/**
 * Rides in flight, for the live board. Capped, because this is a monitoring
 * view and an operator cannot watch two hundred rides at once.
 */
async function activeRides(limit = 50) {
  const rides = await Ride.find({ status: { $in: ACTIVE_RIDE_STATUSES } })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .select('status pickup.address destination.address estimatedFare currency customerId riderId createdAt acceptedAt')
    .populate('customerId', 'name phone')
    .lean();

  const riderIds = rides.map((ride) => ride.riderId).filter(Boolean);
  const riders = riderIds.length
    ? await Rider.find({ _id: { $in: riderIds } })
        .select('userId vehicle currentLocation')
        .populate('userId', 'name phone')
        .lean()
    : [];

  const riderBy = new Map(riders.map((rider) => [String(rider._id), rider]));

  return rides.map((ride) => ({
    id: ride._id,
    status: ride.status,
    pickup: ride.pickup?.address,
    destination: ride.destination?.address,
    estimatedFare: ride.estimatedFare,
    currency: ride.currency,
    customer: ride.customerId ? { id: ride.customerId._id, name: ride.customerId.name } : null,
    rider: ride.riderId ? riderBy.get(String(ride.riderId)) || null : null,
    createdAt: ride.createdAt,
    acceptedAt: ride.acceptedAt
  }));
}

/** Top riders by settled earnings in the window, for the leaderboard panel. */
async function topRiders(options = {}, limit = 10) {
  const { from, to } = resolveRange(options);

  const rows = await Ride.aggregate([
    { $match: { status: RIDE_STATUS.COMPLETED, completedAt: { $gte: from, $lte: to }, riderId: { $ne: null } } },
    {
      $group: {
        _id: '$riderId',
        trips: { $sum: 1 },
        earnings: { $sum: { $ifNull: ['$finalFare', 0] } },
        distanceKm: { $sum: { $ifNull: ['$finalDistanceKm', 0] } }
      }
    },
    { $sort: { earnings: -1 } },
    { $limit: Math.min(limit, 50) },
    { $lookup: { from: 'riders', localField: '_id', foreignField: '_id', as: 'rider' } },
    { $unwind: '$rider' },
    { $lookup: { from: 'users', localField: 'rider.userId', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    {
      $project: {
        riderId: '$_id',
        name: '$user.name',
        vehicle: '$rider.vehicle',
        rating: '$rider.rating',
        trips: 1,
        earnings: 1,
        distanceKm: 1
      }
    }
  ]);

  return rows.map((row) => ({
    ...row,
    earnings: round2(row.earnings),
    distanceKm: round2(row.distanceKm)
  }));
}

module.exports = { summary, series, activeRides, topRiders, resolveRange, round2, oid, TIMEZONE };
