const mongoose = require('mongoose');
const Ride = require('../../models/Ride');
const Rider = require('../../models/Rider');
const RiderWallet = require('../../models/RiderWallet');
const WalletLedger = require('../../models/WalletLedger');
const Recharge = require('../../models/Recharge');
const Payment = require('../../models/Payment');
const walletService = require('../wallet.service');
const fareService = require('../fare.service');
const earningsService = require('../earnings.service');
const rechargeService = require('../recharge.service');
const audit = require('../audit.service');
const settings = require('../settings.service');
const ApiError = require('../../utils/ApiError');
const { resolveRange, round2 } = require('./dashboard.service');
const { RIDE_STATUS } = require('../../constants/rideStatus');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../../constants/paymentStatus');
const { WALLET_STATUS, RECHARGE_STATUS, LEDGER_DIRECTION, outstandingOf } = require('../../constants/finance');

/**
 * What the platform earned, what riders earned, and what riders owe.
 *
 * The categories are kept apart on purpose, and the one that matters most is
 * recharge: money a rider pays to clear a debt is not revenue. It is a debt
 * being settled — the revenue was recognised when the ride completed and the
 * commission was taken. Adding recharges to the day's takings would count the
 * same ₹15 twice, once as commission and once as cash in.
 *
 * So `rides` and `recharges` are separate blocks below, and nothing in this
 * file adds them together.
 */

const oid = (value) =>
  value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));

// A ride's settled split, falling back for trips completed before the platform
// took any commission — on those the rider genuinely kept the whole fare.
const FARE = { $ifNull: ['$finalFare', 0] };
const COMMISSION = { $ifNull: ['$finance.platformCommissionAmount', 0] };
const EARNING = { $ifNull: ['$finance.riderEarningAmount', FARE] };

const byMethod = (method, expr) => ({ $cond: [{ $eq: ['$payment.method', method] }, expr, 0] });

/**
 * The money side of one window.
 *
 * Counted on completed rides only, keyed off `completedAt`. A ride that is
 * awaiting payment has a fare but no settled money, and counting it would
 * report income the platform has not received.
 */
async function ridesFinance(from, to) {
  const [row] = await Ride.aggregate([
    { $match: { status: RIDE_STATUS.COMPLETED, completedAt: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: null,
        rides: { $sum: 1 },
        gross: { $sum: FARE },
        commission: { $sum: COMMISSION },
        riderEarnings: { $sum: EARNING },
        cashGross: { $sum: byMethod(PAYMENT_METHOD.CASH, FARE) },
        upiGross: { $sum: byMethod(PAYMENT_METHOD.UPI, FARE) },
        cashCommission: { $sum: byMethod(PAYMENT_METHOD.CASH, COMMISSION) },
        upiCommission: { $sum: byMethod(PAYMENT_METHOD.UPI, COMMISSION) },
        cashRides: { $sum: byMethod(PAYMENT_METHOD.CASH, 1) },
        upiRides: { $sum: byMethod(PAYMENT_METHOD.UPI, 1) }
      }
    }
  ]);

  const empty = {
    rides: 0,
    gross: 0,
    commission: 0,
    riderEarnings: 0,
    cashGross: 0,
    upiGross: 0,
    cashCommission: 0,
    upiCommission: 0,
    cashRides: 0,
    upiRides: 0,
    effectiveCommissionPercent: 0
  };
  if (!row) return empty;

  const gross = round2(row.gross);
  const commission = round2(row.commission);

  return {
    rides: row.rides,
    gross,
    commission,
    riderEarnings: round2(row.riderEarnings),
    cashGross: round2(row.cashGross),
    upiGross: round2(row.upiGross),
    cashCommission: round2(row.cashCommission),
    upiCommission: round2(row.upiCommission),
    cashRides: row.cashRides,
    upiRides: row.upiRides,
    // What the platform actually kept, across a window that may span a rate
    // change. Reported rather than assumed equal to the current setting.
    effectiveCommissionPercent: gross > 0 ? round2((commission / gross) * 100) : 0
  };
}

/** Recharges collected in the window. Kept well away from ride revenue. */
async function rechargesFinance(from, to) {
  const [row] = await Recharge.aggregate([
    { $match: { status: RECHARGE_STATUS.PAID, settledAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, collected: { $sum: '$amount' }, count: { $sum: 1 } } }
  ]);

  return { collected: round2(row?.collected || 0), count: row?.count || 0 };
}

/**
 * What riders owe right now, across the platform.
 *
 * Point-in-time rather than windowed: a debt is a debt today whenever it was
 * incurred, and asking "how much is outstanding this week" is a question with
 * no sensible answer.
 */
async function outstandingFinance() {
  const [row] = await RiderWallet.aggregate([
    {
      $group: {
        _id: null,
        // Only the negative side. A rider the platform owes money to is not
        // carrying a debt, and netting the two would hide how much is out
        // there behind riders who happen to be in credit.
        outstanding: { $sum: { $cond: [{ $lt: ['$balance', 0] }, { $abs: '$balance' }, 0] } },
        payable: { $sum: { $cond: [{ $gt: ['$balance', 0] }, '$balance', 0] } },
        ridersInDebt: { $sum: { $cond: [{ $lt: ['$balance', 0] }, 1, 0] } },
        blocked: { $sum: { $cond: [{ $eq: ['$status', WALLET_STATUS.PAYMENT_REQUIRED] }, 1, 0] } },
        wallets: { $sum: 1 }
      }
    }
  ]);

  return {
    outstanding: round2(row?.outstanding || 0),
    payable: round2(row?.payable || 0),
    ridersInDebt: row?.ridersInDebt || 0,
    blocked: row?.blocked || 0,
    wallets: row?.wallets || 0,
    threshold: settings.get('finance.maxOutstandingBalance')
  };
}

/** The financial block on the admin dashboard. */
async function platformFinance(options = {}) {
  const window = resolveRange(options);
  const [rides, recharges, balances] = await Promise.all([
    ridesFinance(window.from, window.to),
    rechargesFinance(window.from, window.to),
    outstandingFinance()
  ]);

  return {
    window: { range: window.range, from: window.from, to: window.to },
    currency: settings.get('fare.currency'),
    commissionRate: settings.get('finance.platformCommissionPercent'),
    rides,
    // Separate block, separate heading, never summed with the one above.
    recharges,
    balances
  };
}

// --------------------------------------------------------------- per rider

async function riderFinance(riderId) {
  const rider = await Rider.findById(riderId).populate('userId', 'name email phone');
  if (!rider) throw ApiError.notFound('Rider not found');

  const [wallet, earnings, recharges] = await Promise.all([
    walletService.summary(riderId),
    earningsService.getEarnings(riderId, { range: 'all' }),
    rechargeService.history(riderId, { page: 1, limit: 10 })
  ]);

  return {
    rider: {
      id: rider._id,
      name: rider.userId?.name,
      email: rider.userId?.email,
      phone: rider.userId?.phone,
      vehicle: rider.vehicle,
      isOnline: rider.isOnline
    },
    wallet,
    earnings,
    recharges
  };
}

async function riderLedger(riderId, query) {
  const rider = await Rider.exists({ _id: riderId });
  if (!rider) throw ApiError.notFound('Rider not found');

  return walletService.ledgerFor(riderId, query);
}

/**
 * Riders ranked by what they owe, for the finance queue.
 *
 * Blocked riders first, then by size of debt, because the list exists to answer
 * "who is off the road and why".
 */
async function listRiderBalances({ page = 1, limit = 25, status, search, minOutstanding } = {}) {
  const match = {};
  if (status) match.status = status;
  if (minOutstanding) match.balance = { $lte: -Math.abs(Number(minOutstanding)) };

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: 'riders',
        localField: 'riderId',
        foreignField: '_id',
        as: 'rider'
      }
    },
    { $unwind: '$rider' },
    {
      $lookup: {
        from: 'users',
        localField: 'rider.userId',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' }
  ];

  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    pipeline.push({ $match: { $or: [{ 'user.name': rx }, { 'user.email': rx }, { 'user.phone': rx }] } });
  }

  pipeline.push({
    $addFields: {
      outstanding: { $cond: [{ $lt: ['$balance', 0] }, { $abs: '$balance' }, 0] }
    }
  });

  const [rows, countRow] = await Promise.all([
    RiderWallet.aggregate([
      ...pipeline,
      { $sort: { outstanding: -1, updatedAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $project: {
          riderId: 1,
          balance: 1,
          outstanding: 1,
          status: 1,
          currency: 1,
          lifetimeEarnings: 1,
          lifetimeCommission: 1,
          lifetimeRecharged: 1,
          lastEntryAt: 1,
          name: '$user.name',
          email: '$user.email',
          phone: '$user.phone',
          vehicle: '$rider.vehicle',
          isOnline: '$rider.isOnline'
        }
      }
    ]),
    RiderWallet.aggregate([...pipeline, { $count: 'total' }])
  ]);

  return {
    riders: rows.map((row) => ({
      ...row,
      balance: round2(row.balance),
      outstanding: round2(row.outstanding),
      available: row.balance > 0 ? round2(row.balance) : 0
    })),
    total: countRow[0]?.total || 0,
    page,
    limit,
    threshold: settings.get('finance.maxOutstandingBalance')
  };
}

/**
 * An admin moving a rider's balance by hand.
 *
 * Four things happen and none of them is optional: the request is refused
 * without a reason, the movement is posted to the ledger like any other, an
 * audit row records who did it and why, and the rider's app is told. There is
 * no path that writes a balance without leaving all four behind — which is what
 * "no silent financial modifications" has to mean if it is to mean anything.
 */
async function adjustRiderBalance(req, riderId, { direction, amount, reason, note, idempotencyKey }) {
  /**
   * The signed balance, read off the wallet rather than from `summary`.
   *
   * `summary` builds on `toPublic`, which deliberately withholds the signed
   * number so the apps are forced to read `available` and `outstanding`
   * instead. The audit row is the one place the sign is the point — it is what
   * distinguishes "owes ₹150" from "is owed ₹150" — and this recorded
   * `undefined` on both sides of the change. An adjustment crossing zero lost
   * its whole effect from the record.
   */
  const snapshot = async () => {
    const wallet = await walletService.walletOf(riderId);
    return {
      balance: round2(wallet.balance),
      outstanding: wallet.outstanding,
      status: wallet.status
    };
  };

  const before = await snapshot();

  const result = await walletService.adjust({
    riderId,
    direction,
    amount,
    reason,
    note,
    idempotencyKey,
    admin: req.admin
  });

  const after = await snapshot();

  await audit.record(req, {
    action: 'rider.balance.adjust',
    resource: 'rider',
    resourceId: riderId,
    oldValue: before,
    newValue: {
      ...after,
      direction,
      amount: round2(Number(amount)),
      // False when the same submission was replayed and the ledger refused it,
      // so the trail shows an attempt that moved nothing rather than implying
      // a second adjustment took place.
      posted: Boolean(result.posted.length)
    },
    note: reason
  });

  return { wallet: await walletService.summary(riderId), entry: result.posted[0] || null };
}

/**
 * Recomputes a rider's balance from their ledger and records the result.
 *
 * The repair for a wallet that drifted from its rows — possible only on a
 * deployment without transactions, and only after a crash mid-posting. Audited
 * whether or not anything moved, because "we checked and it was fine" is worth
 * as much in a financial trail as "we found a problem".
 */
async function reconcileRider(req, riderId) {
  const result = await walletService.reconcile(riderId);

  await audit.record(req, {
    action: 'rider.balance.reconcile',
    resource: 'rider',
    resourceId: riderId,
    oldValue: { balance: result.before },
    newValue: { balance: result.after, drift: result.drift, entries: result.entries },
    note: result.drift === 0 ? 'No drift found' : `Repaired a drift of ${result.drift}`
  });

  return result;
}

/** Every movement across the platform, for the finance ledger screen. */
async function platformLedger({ page = 1, limit = 50, type, riderId, from, to } = {}) {
  const filter = {};
  if (type) filter.type = type;
  if (riderId) filter.riderId = oid(riderId);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const [entries, total] = await Promise.all([
    WalletLedger.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WalletLedger.countDocuments(filter)
  ]);

  return { entries, total, page, limit };
}

/**
 * Reversing a settled ride's money.
 *
 * Reads the ride's own snapshot rather than recomputing anything, so a refund
 * reverses what was actually posted even if the commission has changed since.
 * The reversal is idempotent on the ride, so a second click refunds nothing and
 * the audit row says so.
 */
async function refundRide(req, rideId, { reason, note }) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw ApiError.notFound('Ride not found');

  if (ride.status !== RIDE_STATUS.COMPLETED) {
    throw ApiError.badRequest('Only a completed ride can be refunded');
  }

  const payment = await Payment.findOne({ rideId: ride._id });
  if (!payment || payment.status !== PAYMENT_STATUS.PAID) {
    throw ApiError.badRequest('This ride has no settled payment to reverse');
  }

  const split = fareService.splitOf(ride);
  const before = await walletService.walletOf(ride.riderId);

  const result = await walletService.refundRide({
    ride,
    split,
    method: payment.method,
    paymentId: payment._id,
    reason
  });

  const after = await walletService.walletOf(ride.riderId);

  if (result.posted.length) {
    payment.status = PAYMENT_STATUS.REFUNDED;
    payment.refundedAt = new Date();
    await payment.save();

    await Ride.updateOne({ _id: ride._id }, { $set: { 'payment.status': PAYMENT_STATUS.REFUNDED } });
  }

  await audit.record(req, {
    action: 'ride.refund',
    resource: 'Ride',
    resourceId: ride._id,
    oldValue: { paymentStatus: PAYMENT_STATUS.PAID, riderBalance: round2(before.balance) },
    newValue: {
      paymentStatus: payment.status,
      riderBalance: round2(after.balance),
      fareAmount: split.fareAmount,
      commissionReversed: split.platformCommissionAmount,
      earningReversed: split.riderEarningAmount,
      method: payment.method,
      // False when this ride had already been refunded, so the trail does not
      // imply a second reversal took place.
      posted: Boolean(result.posted.length)
    },
    note: note || reason
  });

  return {
    rideId: ride._id,
    refunded: Boolean(result.posted.length),
    wallet: await walletService.summary(ride.riderId),
    reversed: {
      fareAmount: split.fareAmount,
      commission: split.platformCommissionAmount,
      earning: split.riderEarningAmount,
      method: payment.method
    },
    // Said plainly because it is a commercial decision, not an accounting one:
    // on a cash ride the rider is holding the customer's money and the ledger
    // reversal does not take it back.
    note:
      payment.method === PAYMENT_METHOD.CASH
        ? 'The rider collected this fare in cash. The reversal restores their balance; recovering the cash itself is a separate adjustment.'
        : null
  };
}

module.exports = {
  platformFinance,
  riderFinance,
  riderLedger,
  listRiderBalances,
  adjustRiderBalance,
  refundRide,
  reconcileRider,
  platformLedger,
  // Exported for the dashboard, which shows the same figures in its own layout.
  ridesFinance,
  outstandingFinance,
  // Re-exported so callers that only need the sign convention do not have to
  // reach into the constants themselves.
  outstandingOf,
  LEDGER_DIRECTION
};
