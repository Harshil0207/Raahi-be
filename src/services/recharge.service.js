const Recharge = require('../models/Recharge');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const settings = require('./settings.service');
const env = require('../config/env');
const providers = require('./payments');
const walletService = require('./wallet.service');
const { RECHARGE_STATUS, round2 } = require('../constants/finance');
const { PAYMENT_STATUS } = require('../constants/paymentStatus');

/**
 * A rider paying down what they owe the platform.
 *
 * The shape is the same as collecting a fare, for the same reason: the rider
 * asking to recharge does not make money appear. A row is created, a provider
 * is asked to collect, and the ledger is touched only once that provider
 * confirms it has the money. Nothing here accepts "paid" from the app.
 *
 * The minimum is enforced on this side of the wire. The app knows it too — it
 * is in the public settings so the keypad can grey out the button — but that is
 * a courtesy to the rider, not the rule.
 */

async function start(rider, rawAmount) {
  const minimum = settings.get('finance.minimumRecharge');
  const amount = round2(Number(rawAmount));

  if (!Number.isFinite(amount) || amount <= 0) {
    throw ApiError.badRequest('Enter an amount to recharge', [
      { field: 'amount', message: 'Must be a positive amount' }
    ]);
  }

  const wallet = await walletService.walletOf(rider._id);
  const currency = wallet.currency;

  if (amount < minimum) {
    throw ApiError.badRequest(`The smallest recharge is ${currency} ${minimum}`, [
      { field: 'amount', message: `Must be at least ${minimum}` }
    ]);
  }

  // One open attempt at a time. Otherwise a rider who taps twice ends up with
  // two QR codes and pays whichever they happen to scan — or both.
  const open = await Recharge.findOne({
    riderId: rider._id,
    status: { $in: [RECHARGE_STATUS.PENDING, RECHARGE_STATUS.PROCESSING] }
  }).sort({ createdAt: -1 });

  if (open && round2(open.amount) === amount) {
    return withCheckout(open, { reuse: true });
  }
  if (open) {
    open.status = RECHARGE_STATUS.CANCELLED;
    open.failureReason = 'Replaced by a new recharge';
    await open.save();
  }

  const provider = providers.active();
  if (!provider.available) {
    /**
     * The production message is right for a rider: no gateway is connected, so
     * there is nothing they can do in the app and someone has to be told.
     *
     * It is unhelpful to whoever is developing, though, because the cause is a
     * single setting they have almost certainly not changed —
     * `finance.paymentProvider` defaults to "none" so that a fresh deployment
     * refuses UPI rather than faking it. Outside production the message names
     * that setting, which turns a dead end into an instruction.
     */
    const reason =
      provider.unavailableReason ||
      'Online recharge is not available yet. Please settle your balance with the operations team.';

    throw new ApiError(
      501,
      env.isProduction
        ? reason
        : `${reason} (Development: set finance.paymentProvider to "sandbox" in the admin console under Settings → Finance to enable test recharges.)`
    );
  }

  let recharge;
  try {
    recharge = await Recharge.create({
      riderId: rider._id,
      amount,
      currency,
      provider: provider.id,
      status: RECHARGE_STATUS.PENDING,
      minimumAtRequest: minimum
    });
  } catch (err) {
    // The index refused a second live attempt, which means another request got
    // there between our read and this write. Hand back whatever it opened
    // rather than an error: the rider asked to recharge and there is now a
    // recharge to pay.
    if (err?.code !== 11000) throw err;

    const raced = await Recharge.findOne({ riderId: rider._id, open: true }).sort({ createdAt: -1 });
    if (raced) return withCheckout(raced, { reuse: true });
    throw err;
  }

  try {
    const order = await provider.createPayment({
      amount,
      currency,
      reference: String(recharge._id),
      description: `Raahi balance recharge`
    });

    recharge.providerRef = order.providerRef;
    recharge.checkoutRef = order.checkoutRef || order.providerRef;
    recharge.status = RECHARGE_STATUS.PROCESSING;
    await recharge.save();
  } catch (err) {
    recharge.status = RECHARGE_STATUS.FAILED;
    recharge.failureReason = err.message?.slice(0, 200) || 'Could not start the payment';
    await recharge.save();
    throw err;
  }

  return withCheckout(recharge);
}

/** The row plus something to scan. */
async function withCheckout(recharge, { reuse = false } = {}) {
  const provider = providers.active();

  let qr = null;
  if (recharge.providerRef && provider.available) {
    qr = await provider
      .generateQrCode({
        providerRef: recharge.providerRef,
        amount: recharge.amount,
        currency: recharge.currency,
        note: 'Raahi balance recharge'
      })
      .catch((err) => {
        logger.warn(`Could not render a recharge QR for ${recharge._id}: ${err.message}`);
        return null;
      });
  }

  return {
    recharge: publicRecharge(recharge),
    qr,
    reused: reuse,
    provider: { id: provider.id, label: provider.label, sandbox: !provider.isProduction }
  };
}

/**
 * Asks the provider whether the recharge landed, and applies it if so.
 *
 * Applying is a single ledger posting keyed on the recharge id, so polling this
 * twice — or polling it while a webhook arrives — credits the rider once.
 */
async function refresh(rider, rechargeId) {
  const recharge = await Recharge.findOne({ _id: rechargeId, riderId: rider._id });
  if (!recharge) throw ApiError.notFound('Recharge not found');

  if (recharge.status === RECHARGE_STATUS.PAID) {
    return { recharge: publicRecharge(recharge), wallet: await walletService.summary(rider._id) };
  }
  if (!recharge.providerRef) {
    return { recharge: publicRecharge(recharge), wallet: await walletService.summary(rider._id) };
  }

  const provider = providers.active();
  const result = await provider.verifyPayment(recharge.providerRef);

  if (result.status === PAYMENT_STATUS.PAID) {
    // Never credit more than was asked for, and never credit a short payment as
    // if it were the full amount.
    const collected = result.amount == null ? recharge.amount : round2(Number(result.amount));
    if (collected + 0.001 < recharge.amount) {
      recharge.status = RECHARGE_STATUS.FAILED;
      recharge.failureReason = `Received ${recharge.currency} ${collected} against ${recharge.currency} ${recharge.amount}`;
      await recharge.save();
      return { recharge: publicRecharge(recharge), wallet: await walletService.summary(rider._id) };
    }

    return applyPaid(recharge, result.paidAt);
  }

  if (result.status === PAYMENT_STATUS.FAILED) {
    recharge.status = RECHARGE_STATUS.FAILED;
    recharge.failureReason = 'The payment did not go through';
    await recharge.save();
  }

  return { recharge: publicRecharge(recharge), wallet: await walletService.summary(rider._id) };
}

/** Posts a confirmed recharge to the ledger. Safe to call more than once. */
async function applyPaid(recharge, paidAt = null) {
  const posting = await walletService.applyRecharge(recharge);

  recharge.status = RECHARGE_STATUS.PAID;
  recharge.settledAt = recharge.settledAt || (paidAt ? new Date(paidAt) : new Date());

  const entry = posting.posted[0];
  if (entry) {
    recharge.balanceBefore = entry.balanceBefore;
    recharge.balanceAfter = entry.balanceAfter;
  }
  await recharge.save();

  return {
    recharge: publicRecharge(recharge),
    wallet: await walletService.summary(recharge.riderId),
    applied: posting.posted.length > 0
  };
}

/**
 * A gateway callback that turns out to be a recharge rather than a fare.
 *
 * THE CALLBACK IS STILL NOT BELIEVED. It brings one thing — a reference — and
 * everything else is asked of the provider, exactly as the fare path does it.
 * Returns null when the reference is not a recharge at all, so the caller can
 * carry on treating it as unknown.
 *
 * Crediting is idempotent at the database: `walletService.applyRecharge` posts
 * a single entry keyed on the recharge id, so a callback that races the rider's
 * own poll credits them once and the second posting is refused by a unique
 * index rather than by a check that might not have run.
 */
async function settleFromCallback(providerRef) {
  if (!providerRef) return null;

  const recharge = await Recharge.findOne({ providerRef });
  if (!recharge) return null;

  if (recharge.status === RECHARGE_STATUS.PAID) return { status: recharge.status, applied: false };

  const provider = providers.active();
  const result = await provider.verifyPayment(providerRef);

  if (result.status === PAYMENT_STATUS.PAID) {
    const collected = result.amount == null ? recharge.amount : round2(Number(result.amount));

    // Same rule as the poll: a short payment is not a recharge.
    if (collected + 0.001 < recharge.amount) {
      recharge.status = RECHARGE_STATUS.FAILED;
      recharge.failureReason = `Received ${recharge.currency} ${collected} against ${recharge.currency} ${recharge.amount}`;
      await recharge.save();
      return { status: recharge.status, applied: false };
    }

    const applied = await applyPaid(recharge, result.paidAt);
    logger.info(`[Recharge] ${recharge._id} settled by callback`);
    return { status: RECHARGE_STATUS.PAID, applied: applied.applied };
  }

  if (result.status === PAYMENT_STATUS.FAILED) {
    recharge.status = RECHARGE_STATUS.FAILED;
    recharge.failureReason = 'The payment did not go through';
    await recharge.save();
  }

  return { status: recharge.status, applied: false };
}

async function history(riderId, { page = 1, limit = 20 } = {}) {
  const [rows, total] = await Promise.all([
    Recharge.find({ riderId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Recharge.countDocuments({ riderId })
  ]);

  return { recharges: rows.map(publicRecharge), total, page, limit };
}

async function cancel(rider, rechargeId) {
  const recharge = await Recharge.findOne({ _id: rechargeId, riderId: rider._id });
  if (!recharge) throw ApiError.notFound('Recharge not found');

  if (recharge.status === RECHARGE_STATUS.PAID) {
    throw ApiError.conflict('This recharge has already been collected');
  }

  recharge.status = RECHARGE_STATUS.CANCELLED;
  await recharge.save();

  return publicRecharge(recharge);
}

/**
 * What the rider is allowed to see. The provider reference is deliberately
 * absent — it is how the gateway is queried, not something the app needs.
 */
const publicRecharge = (recharge) => ({
  id: recharge._id,
  amount: recharge.amount,
  currency: recharge.currency,
  status: recharge.status,
  balanceBefore: recharge.balanceBefore,
  balanceAfter: recharge.balanceAfter,
  failureReason: recharge.failureReason,
  settledAt: recharge.settledAt,
  createdAt: recharge.createdAt
});

module.exports = { start, refresh, applyPaid, settleFromCallback, history, cancel, publicRecharge };
