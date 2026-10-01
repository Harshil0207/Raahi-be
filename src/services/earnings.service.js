const mongoose = require('mongoose');
const Ride = require('../models/Ride');
const RideRequest = require('../models/RideRequest');
const { RIDE_STATUS, RIDE_REQUEST_STATUS } = require('../constants/rideStatus');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../constants/paymentStatus');
const {
  BOOKING_TYPE,
  ALL_BOOKING_TYPES,
  SERVICE_TYPE,
  ALL_SERVICE_TYPES,
  SERVICES
} = require('../constants/services');

/**
 * Earnings and lifetime statistics, computed in MongoDB from completed rides.
 *
 * Every figure here comes from a real ride the rider finished: nothing is
 * estimated or projected, and nothing is added up outside the database. A rider
 * with no completed rides gets zeros, not placeholder numbers.
 *
 * Fares are read from the ride rather than the Payment collection because the
 * ride carries the settled amount and the payment method together, which keeps
 * this to a single indexed scan per window. Just as importantly, the amount on
 * the ride is the amount it settled at — a rate change tomorrow cannot reprice
 * a trip taken today, so nothing here recomputes a fare from current rates.
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * "Today" means today where the rider is driving, so every day boundary here is
 * the server's local midnight. Mongo groups in UTC unless told otherwise, and
 * toISOString() would report UTC too, so both sides are pinned to this zone —
 * otherwise a late-evening ride in a zone ahead of UTC lands on the wrong day.
 */
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const localKey = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const startOfDay = (d = new Date()) => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

// Weeks start on Monday, which is what a driver thinks of as "this week".
function startOfWeek(d = new Date()) {
  const copy = startOfDay(d);
  const weekday = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - weekday);
  return copy;
}

const startOfMonth = (d = new Date()) => {
  const copy = startOfDay(d);
  copy.setDate(1);
  return copy;
};

const EMPTY = {
  total: 0,
  gross: 0,
  commission: 0,
  trips: 0,
  distanceKm: 0,
  cash: 0,
  upi: 0,
  cashCollected: 0,
  upiCollected: 0,
  settled: 0,
  avgPerTrip: 0,
  avgPerKm: 0
};

/** How the two booking types read to a rider: people, or packages. */
const BOOKING_LABEL = {
  [BOOKING_TYPE.RIDE]: 'Passenger',
  [BOOKING_TYPE.PARCEL]: 'Parcel'
};

const RANGE_LABEL = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  all: 'All time',
  custom: 'Custom range'
};

const ALL_RANGES = Object.keys(RANGE_LABEL);

// ------------------------------------------------------------ the date window

/**
 * A `YYYY-MM-DD` filter value as a moment in the server's zone.
 *
 * Built from the parts rather than parsed, because `new Date('2026-09-21')` is
 * midnight *UTC* — which is the previous evening here, and would quietly shift
 * a custom range by a day. That is the day-boundary bug this file already fixed
 * once for the chart; the filters must not reintroduce it.
 */
function localDay(value, endOfDay = false) {
  if (!value) return null;
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return null;
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * Turns the requested range into the window the pipelines filter on.
 *
 * `from`/`to` are inclusive whole local days. A range of `all` has no lower
 * bound at all, which is what a bare request asks for and what the screen used
 * to show before there were filters.
 */
function resolveRange({ range, from, to } = {}, now = new Date()) {
  // Dates on their own mean a custom window; naming the range is optional.
  const key = ALL_RANGES.includes(range) ? range : from || to ? 'custom' : 'all';
  const today = startOfDay(now);

  const spans = {
    today: () => ({ from: today, to: null }),
    week: () => ({ from: startOfWeek(now), to: null }),
    month: () => ({ from: startOfMonth(now), to: null }),
    last7: () => {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { from: start, to: null };
    },
    last30: () => {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { from: start, to: null };
    },
    all: () => ({ from: null, to: null }),
    // An open end means "up to now", so a half-specified range still works.
    custom: () => ({ from: localDay(from), to: localDay(to, true) })
  };

  return { key, label: RANGE_LABEL[key], ...spans[key]() };
}

// -------------------------------------------------------------- the pipelines

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * The service a ride settled as.
 *
 * `pricing.serviceType` is the snapshot taken when the ride was created, so it
 * is read first — exactly as `fare.service.pricingOf` reads it at settlement.
 * Rides from before services existed carry neither and were all cars.
 */
const SERVICE_EXPR = {
  $ifNull: ['$pricing.serviceType', { $ifNull: ['$serviceType', SERVICE_TYPE.CAR] }]
};

/**
 * Passenger work or delivery work, derived from that same service rather than
 * read off the ride, so the two breakdowns can never disagree about a ride.
 */
const BOOKING_EXPR = {
  $switch: {
    branches: ALL_SERVICE_TYPES.map((type) => ({
      case: { $eq: ['$serviceKey', type] },
      then: SERVICES[type].bookingType
    })),
    default: BOOKING_TYPE.RIDE
  }
};

// A completed ride always has a final fare; the guard is for the one that was
// settled at zero versus one whose field never landed — both must count as a
// trip, and neither may turn a sum into null.
const FARE = { $ifNull: ['$finalFare', 0] };
const DISTANCE = { $ifNull: ['$finalDistanceKm', 0] };

/**
 * What the rider actually keeps, read from the split frozen onto the ride.
 *
 * The fallback is not a default — it is the truth about an older ride. Trips
 * completed before the platform took a commission have no snapshot, and the
 * rider kept the whole fare on those. Applying today's 15% to them would invent
 * a deduction that never happened and quietly reduce a figure the rider has
 * already been shown and already been paid.
 */
const EARNING = { $ifNull: ['$finance.riderEarningAmount', FARE] };
const COMMISSION = { $ifNull: ['$finance.platformCommissionAmount', 0] };

const whenMethod = (method, expr) => ({ $cond: [{ $eq: ['$payment.method', method] }, expr, 0] });

/**
 * The accumulators every window, service and booking line is built from.
 *
 * `total` is the rider's money, net of commission — everywhere this service
 * says "earnings" it means what the rider keeps. `gross` is the fare the
 * customer paid, and `commission` is the difference. Keeping all three means no
 * screen has to subtract one from another and get it slightly wrong.
 *
 * `cash` and `upi` split the rider's earnings by how the fare was paid, so they
 * still add up to `total`. What passed through the rider's hands is a different
 * question, and `cashCollected` answers it — that figure is the one the wallet
 * shows, because it is the money they physically took.
 */
const TOTALS = {
  total: { $sum: EARNING },
  gross: { $sum: FARE },
  commission: { $sum: COMMISSION },
  trips: { $sum: 1 },
  distanceKm: { $sum: DISTANCE },
  cash: { $sum: whenMethod(PAYMENT_METHOD.CASH, EARNING) },
  upi: { $sum: whenMethod(PAYMENT_METHOD.UPI, EARNING) },
  cashCollected: { $sum: whenMethod(PAYMENT_METHOD.CASH, FARE) },
  upiCollected: { $sum: whenMethod(PAYMENT_METHOD.UPI, FARE) },
  settled: { $sum: { $cond: [{ $eq: ['$payment.status', PAYMENT_STATUS.PAID] }, EARNING, 0] } }
};

/**
 * The stages every earnings query starts with: this rider's completed rides,
 * narrowed by the window and the filters.
 *
 * The indexed fields are matched first and on their own, so the service filter
 * — which needs a computed field — never costs the index.
 */
function completedRides({ riderId, from, to, serviceType, method }) {
  const match = { riderId: oid(riderId), status: RIDE_STATUS.COMPLETED };

  if (from || to) {
    match.completedAt = {};
    if (from) match.completedAt.$gte = from;
    if (to) match.completedAt.$lte = to;
  }
  if (method) match['payment.method'] = method;

  const stages = [
    { $match: match },
    { $addFields: { serviceKey: SERVICE_EXPR } },
    { $addFields: { bookingKey: BOOKING_EXPR } }
  ];

  if (serviceType) stages.push({ $match: { serviceKey: serviceType } });

  return stages;
}

// ----------------------------------------------------------------- the shapes

/**
 * One aggregation row as the apps read it.
 *
 * Every derived figure is guarded, because a service can legitimately earn
 * nothing: an ambulance run is free at the point of use, so it is a trip worth
 * zero rather than a missing trip, and the averages must come out as 0 and not
 * NaN.
 */
function finaliseTotals(row) {
  const trips = row?.trips || 0;
  if (!trips) return { ...EMPTY };

  const total = round2(row.total || 0);
  const distanceKm = round2(row.distanceKm || 0);
  const settled = round2(row.settled || 0);

  return {
    total,
    // What the customers paid, before the platform's share.
    gross: round2(row.gross || 0),
    commission: round2(row.commission || 0),
    trips,
    distanceKm,
    cash: round2(row.cash || 0),
    upi: round2(row.upi || 0),
    // The fare that passed through the rider's own hands, as opposed to the
    // part of it they keep.
    cashCollected: round2(row.cashCollected || 0),
    upiCollected: round2(row.upiCollected || 0),
    settled,
    avgPerTrip: round2(total / trips),
    avgPerKm: distanceKm > 0 ? round2(total / distanceKm) : 0
  };
}

/**
 * How much of the window's money this line is, as a whole percent.
 *
 * Worked out here rather than in the apps: the rule is that every figure on the
 * screen is computed from the database, and a bar's length is a figure like any
 * other. A window that earned nothing has no shares to give out — the line
 * still carries its trip count.
 */
const shareOf = (amount, windowTotal) =>
  windowTotal > 0 ? Math.round((amount / windowTotal) * 100) : 0;

/**
 * Every service in the catalogue, in catalogue order, whether or not it has
 * trips in this window.
 *
 * Filled rather than filtered for the same reason the chart keeps its empty
 * days: a breakdown that silently omits a service cannot be told apart from one
 * where the service does not exist. The screen decides what to show; this
 * decides what is true.
 */
function fillServices(rows = [], windowTotal = 0) {
  const byType = new Map(rows.map((row) => [row._id, row]));

  return ALL_SERVICE_TYPES.map((serviceType) => {
    const totals = finaliseTotals(byType.get(serviceType));

    return {
      serviceType,
      bookingType: SERVICES[serviceType].bookingType,
      label: SERVICES[serviceType].label,
      vehicle: SERVICES[serviceType].vehicle,
      ...totals,
      share: shareOf(totals.total, windowTotal)
    };
  }).sort((a, b) => SERVICES[a.serviceType].order - SERVICES[b.serviceType].order);
}

/** Passenger work and parcel work as two separate lines, both always present. */
function fillBookings(rows = [], windowTotal = 0) {
  const byType = new Map(rows.map((row) => [row._id, row]));

  return ALL_BOOKING_TYPES.map((bookingType) => {
    const totals = finaliseTotals(byType.get(bookingType));

    return {
      bookingType,
      label: BOOKING_LABEL[bookingType],
      ...totals,
      share: shareOf(totals.total, windowTotal)
    };
  });
}

// ------------------------------------------------------------------ the reads

/** One aggregation pass over a rider's completed rides in a window. */
async function totalsFor(riderId, { from = null, to = null, serviceType = null, method = null } = {}) {
  const [row] = await Ride.aggregate([
    ...completedRides({ riderId, from, to, serviceType, method }),
    { $group: { _id: null, ...TOTALS } }
  ]);

  return finaliseTotals(row);
}

/**
 * The selected window's totals and both breakdowns, in one pass.
 *
 * A `$facet` because all three read the same set of rides: splitting them into
 * three queries would scan the same rides three times to reach the same answer.
 */
async function windowBreakdown(riderId, filters) {
  const [row] = await Ride.aggregate([
    ...completedRides({ riderId, ...filters }),
    {
      $facet: {
        totals: [{ $group: { _id: null, ...TOTALS } }],
        services: [{ $group: { _id: '$serviceKey', ...TOTALS } }],
        bookings: [{ $group: { _id: '$bookingKey', ...TOTALS } }]
      }
    }
  ]);

  const totals = finaliseTotals(row?.totals?.[0]);

  return {
    totals,
    services: fillServices(row?.services, totals.total),
    bookings: fillBookings(row?.bookings, totals.total)
  };
}

/**
 * Per-day totals for the chart, with empty days filled in so the axis is
 * continuous.
 *
 * Deliberately anchored to the last `days` days rather than to the selected
 * range: the chart is the recent trend, and a range of "today" would otherwise
 * collapse it to a single bar. It still honours the service and payment
 * filters, so the trend is the trend for whatever is being looked at.
 */
async function dailyBreakdown(riderId, filters, days) {
  const from = startOfDay();
  from.setDate(from.getDate() - (days - 1));

  const rows = await Ride.aggregate([
    ...completedRides({ riderId, ...filters, from, to: null }),
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: TIMEZONE } },
        // The rider's own money, like every other `total` this service returns.
        // This summed the gross fare, so the chart stood next to a headline of
        // ₹8,500 and added up to ₹10,000 — the commission, shown to the rider as
        // if they had earned it.
        total: { $sum: EARNING },
        fare: { $sum: FARE },
        trips: { $sum: 1 }
      }
    }
  ]);

  const byDate = new Map(rows.map((r) => [r._id, r]));
  const out = [];

  for (let i = 0; i < days; i += 1) {
    const day = new Date(from);
    day.setDate(from.getDate() + i);
    const key = localKey(day);
    const hit = byDate.get(key);
    out.push({
      date: key,
      total: round2(hit?.total || 0),
      fare: round2(hit?.fare || 0),
      trips: hit?.trips || 0
    });
  }

  return out;
}

/**
 * Earnings on trips that are driven but not paid for.
 *
 * A separate query because the windows above only look at COMPLETED rides, and
 * a ride only reaches COMPLETED once its money has posted — so "unsettled"
 * computed from them was arithmetically always zero, and the warning badge that
 * depended on it could never appear. The rides that are genuinely outstanding
 * are the ones sitting in AWAITING_PAYMENT: the trip is over, the fare is
 * fixed, the money is not in.
 */
async function unsettledEarnings(riderId) {
  const [row] = await Ride.aggregate([
    {
      $match: {
        riderId: new mongoose.Types.ObjectId(String(riderId)),
        status: RIDE_STATUS.AWAITING_PAYMENT
      }
    },
    { $group: { _id: null, total: { $sum: EARNING }, gross: { $sum: FARE }, trips: { $sum: 1 } } }
  ]);

  return {
    total: round2(row?.total || 0),
    gross: round2(row?.gross || 0),
    trips: row?.trips || 0
  };
}

/** The last few trips in the selected window, newest first. */
async function recentRides(riderId, filters, limit = 10) {
  return Ride.aggregate([
    ...completedRides({ riderId, ...filters }),
    { $sort: { completedAt: -1 } },
    { $limit: limit },
    {
      $project: {
        finalFare: 1,
        finalDistanceKm: 1,
        currency: 1,
        completedAt: 1,
        payment: 1,
        serviceKey: 1,
        bookingKey: 1,
        'pickup.address': 1,
        'destination.address': 1
      }
    }
  ]);
}

/**
 * Everything the Earnings screen draws, for one rider.
 *
 * `today` / `week` / `month` / `allTime` are fixed windows and stay that way;
 * `range` is whatever was asked for, and it is the window the service and
 * booking breakdowns cover. The service and payment filters apply to all of
 * them, so nothing on the screen is counting a different set of rides.
 */
async function getEarnings(riderId, query = {}) {
  const days = Math.min(Math.max(Number(query.days) || 14, 7), 90);
  const range = resolveRange(query);
  const filters = {
    serviceType: query.serviceType || null,
    method: query.method || null
  };
  const windowFilters = { ...filters, from: range.from, to: range.to };

  const [today, week, month, allTime, selected, breakdown, recent, unsettled] = await Promise.all([
    totalsFor(riderId, { ...filters, from: startOfDay() }),
    totalsFor(riderId, { ...filters, from: startOfWeek() }),
    totalsFor(riderId, { ...filters, from: startOfMonth() }),
    totalsFor(riderId, filters),
    windowBreakdown(riderId, windowFilters),
    dailyBreakdown(riderId, filters, days),
    recentRides(riderId, windowFilters),
    unsettledEarnings(riderId)
  ]);

  return {
    currency: recent[0]?.currency || 'INR',
    filters: {
      range: range.key,
      label: range.label,
      from: range.from,
      to: range.to,
      serviceType: filters.serviceType,
      method: filters.method,
      days
    },
    today,
    week,
    month,
    allTime,
    unsettled,
    range: { key: range.key, label: range.label, from: range.from, to: range.to, ...selected.totals },
    services: selected.services,
    bookings: selected.bookings,
    breakdown,
    recent: recent.map((ride) => ({
      rideId: ride._id,
      fare: ride.finalFare,
      distanceKm: ride.finalDistanceKm,
      completedAt: ride.completedAt,
      method: ride.payment?.method || null,
      paymentStatus: ride.payment?.status || null,
      serviceType: ride.serviceKey,
      bookingType: ride.bookingKey,
      serviceLabel: SERVICES[ride.serviceKey]?.label || null,
      pickup: ride.pickup?.address,
      destination: ride.destination?.address
    }))
  };
}

/**
 * Lifetime performance. Acceptance and cancellation rates come from the actual
 * RideRequest and Ride records; anything the data cannot support is returned as
 * null so the UI can say "not enough data" instead of showing a made-up figure.
 */
async function getStats(rider) {
  const riderId = new mongoose.Types.ObjectId(String(rider._id));

  const [rideRows, requestRows] = await Promise.all([
    Ride.aggregate([
      { $match: { riderId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          fare: { $sum: '$finalFare' },
          earning: { $sum: EARNING },
          distance: { $sum: '$finalDistanceKm' }
        }
      }
    ]),
    RideRequest.aggregate([{ $match: { riderId } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
  ]);

  const rides = Object.fromEntries(rideRows.map((r) => [r._id, r]));
  const requests = Object.fromEntries(requestRows.map((r) => [r._id, r.count]));

  const completed = rides[RIDE_STATUS.COMPLETED]?.count || 0;
  const cancelled = rides[RIDE_STATUS.CANCELLED]?.count || 0;
  const totalFare = round2(rides[RIDE_STATUS.COMPLETED]?.fare || 0);
  // What the rider kept, which is what "trip earning" has to mean on a screen
  // labelled Earnings. This was the gross fare, so a rider averaging ₹85 a trip
  // was shown ₹100.
  const totalEarning = round2(rides[RIDE_STATUS.COMPLETED]?.earning || 0);
  const totalDistanceKm = round2(rides[RIDE_STATUS.COMPLETED]?.distance || 0);

  const accepted = requests[RIDE_REQUEST_STATUS.ACCEPTED] || 0;
  const rejected = requests[RIDE_REQUEST_STATUS.REJECTED] || 0;
  const expired = requests[RIDE_REQUEST_STATUS.EXPIRED] || 0;
  const offered = accepted + rejected + expired;

  return {
    totalTrips: completed,
    cancelledTrips: cancelled,
    totalDistanceKm,
    avgTripEarning: completed ? round2(totalEarning / completed) : 0,
    avgTripFare: completed ? round2(totalFare / completed) : 0,
    // Percentages are only meaningful once something has actually happened.
    acceptanceRate: offered ? Math.round((accepted / offered) * 100) : null,
    cancellationRate: completed + cancelled ? Math.round((cancelled / (completed + cancelled)) * 100) : null,
    offersReceived: offered,
    onlineSeconds: currentOnlineSeconds(rider),
    rating: rider.rating,
    ratingCount: rider.ratingCount
  };
}

// Accumulated online time, plus the session in progress if the rider is online now.
function currentOnlineSeconds(rider) {
  const banked = rider.onlineSeconds || 0;
  if (!rider.isOnline || !rider.onlineSince) return banked;
  return banked + Math.floor((Date.now() - rider.onlineSince.getTime()) / 1000);
}

module.exports = {
  getEarnings,
  getStats,
  currentOnlineSeconds,
  startOfDay,
  startOfWeek,
  startOfMonth,
  // Exported for the tests: the shaping is pure, and it is where a zero-earning
  // service would be dropped or turned into NaN if anyone got it wrong.
  finaliseTotals,
  fillServices,
  fillBookings,
  resolveRange,
  RANGE_LABEL,
  ALL_RANGES,
  BOOKING_LABEL
};
