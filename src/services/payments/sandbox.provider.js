const env = require('../../config/env');
const logger = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');
const { PaymentProvider, upiIntent, qrSvg, reference } = require('./provider');
const { PAYMENT_STATUS } = require('../../constants/paymentStatus');

/**
 * A stand-in gateway for development, and nothing else.
 *
 * It exists so the whole collection flow — create, show a QR, wait, verify,
 * post to the ledger — can be built and driven before a real merchant account
 * is available. Three things keep it from being mistaken for one:
 *
 *  1. It refuses to load in production. Not a warning: a thrown error at
 *     startup, because a platform that boots with a fake gateway takes real
 *     rides and settles none of them.
 *
 *  2. It never settles by itself. A payment stays PROCESSING until something
 *     outside the rider's app calls `simulatePayment`, which is reachable only
 *     through a route that is not mounted outside development. The rider still
 *     cannot mark their own UPI payment as received — which is the rule this
 *     whole layer is here to enforce, and a test double that broke it would be
 *     testing the wrong system.
 *
 *  3. Its state lives in memory and dies with the process. Nothing it invents
 *     is written to MongoDB, so no sandbox payment can ever be mistaken for a
 *     real one in the data.
 */
class SandboxProvider extends PaymentProvider {
  constructor() {
    super({ id: 'sandbox', label: 'Sandbox (development only)', isProduction: false });

    if (env.isProduction) {
      throw new Error(
        'The sandbox payment provider cannot be used in production. Configure a real gateway, or set finance.paymentProvider to "none" to collect cash only.'
      );
    }

    /** providerRef → { status, amount, currency, paidAt } */
    this.payments = new Map();
    logger.warn('Payments: sandbox provider active — no real money will move.');
  }

  get available() {
    return true;
  }

  async createPayment({ amount, currency, description }) {
    const providerRef = reference('SBX');

    this.payments.set(providerRef, {
      status: PAYMENT_STATUS.PROCESSING,
      amount,
      currency,
      description,
      paidAt: null
    });

    return { providerRef, checkoutRef: providerRef, status: PAYMENT_STATUS.PROCESSING };
  }

  async generateQrCode({ providerRef, amount, currency, note }) {
    const record = this.payments.get(providerRef);
    if (!record) throw ApiError.notFound('Unknown sandbox payment');

    // A real-shaped UPI intent so the app renders exactly what it would in
    // production — pointed at an obviously fake payee so a stray scan in the
    // office cannot move money.
    const payload = upiIntent({
      vpa: env.payments.upi.vpa || 'sandbox@raahi',
      payeeName: env.payments.upi.payeeName || 'Raahi Sandbox',
      amount,
      currency,
      reference: providerRef,
      note
    });

    return { payload, svg: await qrSvg(payload), format: 'upi-intent', sandbox: true };
  }

  async verifyPayment(providerRef) {
    const record = this.payments.get(providerRef);
    // A reference this process has never seen is unverifiable, not paid. After
    // a restart every in-flight sandbox payment lands here, which is the right
    // answer: the memory is gone, so the claim cannot be substantiated.
    if (!record) return { status: PAYMENT_STATUS.FAILED, amount: null, paidAt: null };

    return { status: record.status, amount: record.amount, paidAt: record.paidAt };
  }

  /**
   * Stands in for the customer opening their UPI app and paying.
   *
   * Only reachable from the development-only sandbox route. Nothing on the
   * rider or customer API can call this.
   */
  simulatePayment(providerRef, outcome = PAYMENT_STATUS.PAID) {
    const record = this.payments.get(providerRef);
    if (!record) throw ApiError.notFound('Unknown sandbox payment');

    record.status = outcome;
    record.paidAt = outcome === PAYMENT_STATUS.PAID ? new Date() : null;
    return { status: record.status, amount: record.amount, paidAt: record.paidAt };
  }
}

module.exports = SandboxProvider;
