const Recharge = require('../models/Recharge');
const logger = require('../utils/logger');
const providers = require('../services/payments');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const rechargeService = require('../services/recharge.service');
const earningsService = require('../services/earnings.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

/**
 * The rider's own money.
 *
 * Every handler here reads `req.rider`, which the auth middleware loaded from
 * the token. No endpoint takes a rider id from the request — a rider can only
 * ever see their own wallet, and there is no parameter to tamper with.
 */

/**
 * The wallet screen in one call.
 *
 * Balances come from the ledger and earnings come from completed rides. They
 * are fetched separately and returned separately, because they answer different
 * questions: what the rider is owed right now, and what they have driven. A
 * screen that derived one from the other would eventually show a rider their
 * debt as if it were their income.
 */
const summary = asyncHandler(async (req, res) => {
  const [wallet, earnings] = await Promise.all([
    walletService.summary(req.rider._id),
    earningsService.getEarnings(req.rider._id, { range: 'today' })
  ]);

  return ok(res, { wallet, earnings });
});

const ledger = asyncHandler(async (req, res) => {
  const result = await walletService.ledgerFor(req.rider._id, req.query);
  return ok(res, result);
});

const recharges = asyncHandler(async (req, res) => {
  const result = await rechargeService.history(req.rider._id, req.query);
  return ok(res, result);
});

const startRecharge = asyncHandler(async (req, res) => {
  const result = await rechargeService.start(req.rider, req.body.amount);
  return ok(res, result, 'Scan the code to pay');
});

/**
 * Polled while the rider waits for their payment to land.
 *
 * It asks the provider, it does not accept an answer from the client. A rider
 * calling this a hundred times credits their balance exactly once, because the
 * posting is keyed on the recharge.
 */
const rechargeStatus = asyncHandler(async (req, res) => {
  const result = await rechargeService.refresh(req.rider, req.params.rechargeId);
  return ok(res, result);
});

const cancelRecharge = asyncHandler(async (req, res) => {
  const recharge = await rechargeService.cancel(req.rider, req.params.rechargeId);
  return ok(res, recharge, 'Recharge cancelled');
});

/**
 * Stands in for the rider opening their UPI app and paying — development only.
 *
 * WHY THIS EXISTS. A sandbox recharge sits at PROCESSING until something
 * outside the app settles it, which is the rule that stops a rider declaring
 * their own payment received. Correct, and it also means a balance cannot be
 * cleared while developing: the provider reference is deliberately withheld
 * from `publicRecharge`, so the app has nothing to hand the existing
 * `/payments/sandbox/:providerRef/pay` route. This gives the same capability
 * keyed on the rider's own recharge instead.
 *
 * WHAT IT DOES NOT DO. It does not touch a balance, write a ledger row, or
 * invent a transaction. All it does is flip the SANDBOX PROVIDER's in-memory
 * record to paid — exactly what a customer's UPI app causes — and then run the
 * ordinary `refresh`, which queries the provider and posts through the same
 * code a real gateway's answer goes through. So the money movement is the real
 * one, the ledger entry is the real one, and exercising this exercises
 * production behaviour rather than a shortcut around it.
 *
 * THREE GUARDS, ANY ONE OF WHICH IS SUFFICIENT.
 *   1. The route is mounted only when NODE_ENV is not production, so in
 *      production the path does not exist.
 *   2. This handler refuses unless the ACTIVE provider is the sandbox one.
 *   3. The sandbox provider throws on construction in production, so it can
 *      never be the active provider there.
 */
const simulateRecharge = asyncHandler(async (req, res) => {
  const provider = providers.active();

  if (provider.id !== 'sandbox' || typeof provider.simulatePayment !== 'function') {
    throw ApiError.badRequest(
      'Simulating a payment needs the sandbox provider. Set finance.paymentProvider to "sandbox" in the admin console.'
    );
  }

  // Scoped to the caller's own recharge: there is no rider id in the path, and
  // one rider cannot settle another's.
  const recharge = await Recharge.findOne({
    _id: req.params.rechargeId,
    riderId: req.rider._id
  });
  if (!recharge) throw ApiError.notFound('Recharge not found');
  if (!recharge.providerRef) throw ApiError.conflict('This recharge has no payment to settle');

  const outcome = req.body?.outcome === 'FAILED' ? 'FAILED' : 'PAID';
  provider.simulatePayment(recharge.providerRef, outcome);

  // Settled by the ordinary path, not by hand. `refresh` asks the provider and
  // posts the ledger entry, and it is idempotent — calling this twice credits
  // the balance once.
  const result = await rechargeService.refresh(req.rider, recharge._id);

  logger.warn(
    `[sandbox] recharge ${recharge._id} marked ${outcome} for rider ${req.rider._id} —` +
      ' no real money moved'
  );

  return ok(res, result, outcome === 'PAID' ? 'Sandbox payment received' : 'Sandbox payment failed');
});

module.exports = {
  summary,
  ledger,
  recharges,
  startRecharge,
  rechargeStatus,
  cancelRecharge,
  simulateRecharge
};
