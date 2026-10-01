const paymentService = require('../services/payment.service');
const providers = require('../services/payments');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { ok } = require('../utils/response');
const { PAYMENT_STATUS } = require('../constants/paymentStatus');

const selectMethod = asyncHandler(async (req, res) => {
  const payment = await paymentService.selectMethod(req.params.rideId, req.user._id, req.body.method);
  return ok(res, payment, 'Payment method selected');
});

const setRiderMethod = asyncHandler(async (req, res) => {
  const payment = await paymentService.setMethodForRide(req.params.rideId, req.rider, req.body.method);
  return ok(res, payment, 'Payment method selected');
});

const startUpi = asyncHandler(async (req, res) => {
  const result = await paymentService.startUpiCollection(req.params.rideId, req.rider);
  return ok(res, result, 'Ask the customer to scan and pay');
});

/**
 * The customer starting their own payment.
 *
 * A redirect gateway needs the payer's device — PhonePe hands back a URL that
 * has to open where the customer is, and the rider cannot do that part for
 * them. Only the ride id comes from the request; the amount, the rider and the
 * status are all read server-side.
 */
const startCheckout = asyncHandler(async (req, res) => {
  const result = await paymentService.startCheckout(req.params.rideId, req.user._id);
  return ok(res, result, 'Continue to the payment page');
});

/**
 * One payment's authoritative status, by payment id.
 *
 * The route a customer's screen polls after coming back from a gateway, where
 * what it holds is the payment rather than the ride. Whether the payment
 * succeeded is decided here by asking the provider — never by what the
 * redirect back into the app said.
 */
const paymentStatus = asyncHandler(async (req, res) => {
  const actor = req.rider ? { riderId: req.rider._id, userId: req.user._id } : { userId: req.user._id };
  const result = await paymentService.statusForPayment(req.params.paymentId, actor);
  return ok(res, result);
});

const confirmCash = asyncHandler(async (req, res) => {
  const payment = await paymentService.confirmCashPayment(req.params.rideId, req.rider);
  return ok(res, payment, 'Cash payment confirmed');
});

/**
 * Polled by both apps while a UPI payment is outstanding.
 *
 * It re-asks the provider every time rather than returning the stored status,
 * which is what turns polling into the settlement path: the first poll after
 * the customer pays is what finishes the ride. Nothing in the request says
 * whether it succeeded.
 */
const status = asyncHandler(async (req, res) => {
  const actor = req.rider ? { riderId: req.rider._id, userId: req.user._id } : { userId: req.user._id };
  const payment = await paymentService.refreshUpiStatus(req.params.rideId, actor);
  return ok(res, payment);
});

const detail = asyncHandler(async (req, res) => {
  // The same actor shape the poll uses, so ownership is decided the same way on
  // both routes: the customer by their user id, the rider by their profile id.
  const actor = req.rider ? { riderId: req.rider._id, userId: req.user._id } : { userId: req.user._id };
  const payment = await paymentService.getForRide(req.params.rideId, actor);
  return ok(res, payment);
});

const options = asyncHandler(async (_req, res) => ok(res, { methods: paymentService.methodOptions() }));

const webhook = asyncHandler(async (req, res) => {
  const result = await paymentService.handleWebhook({
    rawBody: req.rawBody,
    signature: req.get('x-payment-signature') || req.get('x-razorpay-signature') || '',
    body: req.body
  });

  return ok(res, result);
});

/**
 * Development only — the route that mounts this does not exist in production.
 *
 * It reaches into the sandbox provider to mark a payment as received, which is
 * what a customer's UPI app would have caused. Guarded twice over: the route is
 * absent outside development, and the provider itself refuses to construct in
 * production.
 */
const sandboxPay = asyncHandler(async (req, res) => {
  const provider = providers.active();
  if (provider.id !== 'sandbox' || typeof provider.simulatePayment !== 'function') {
    throw ApiError.badRequest('The sandbox provider is not active');
  }

  const outcome = req.body?.outcome === 'FAILED' ? PAYMENT_STATUS.FAILED : PAYMENT_STATUS.PAID;
  const result = provider.simulatePayment(req.params.providerRef, outcome);

  return ok(res, result, 'Sandbox payment updated');
});

/**
 * The signed-in person's own payments.
 *
 * The actor is built here from the session, never from the query string, which
 * is what keeps this from becoming a way to read somebody else's history.
 */
const history = asyncHandler(async (req, res) => {
  const actor = req.rider ? { riderId: req.rider._id } : { userId: req.user._id };
  const result = await paymentService.historyFor(actor, {
    page: req.query.page,
    limit: req.query.limit
  });
  return ok(res, result);
});

module.exports = {
  startCheckout,
  paymentStatus,
  history,
  selectMethod,
  setRiderMethod,
  startUpi,
  confirmCash,
  status,
  detail,
  options,
  webhook,
  sandboxPay
};
