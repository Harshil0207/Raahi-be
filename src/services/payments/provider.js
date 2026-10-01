const crypto = require('crypto');
const logger = require('../../utils/logger');
const { PAYMENT_STATUS } = require('../../constants/paymentStatus');

/**
 * What every payment provider has to be able to do.
 *
 * The point of the interface is that ride completion never knows which gateway
 * is behind it. Swapping one for another is writing a new file in this folder
 * and changing a setting — not editing the ride service, which has no business
 * knowing about merchant IDs.
 *
 * The contract, in four calls:
 *
 *   createPayment()    ask the provider to expect this much money
 *   generateQrCode()   render something the customer can scan
 *   verifyPayment()    ask the provider whether it actually arrived
 *   getPaymentStatus() the same question, without side effects
 *
 * `verifyPayment` is the only thing in the entire system allowed to decide that
 * a UPI payment succeeded. No endpoint takes "paid: true" from a client, and
 * there is no code path where a rider tapping a button marks a gateway payment
 * as settled. That asymmetry is the whole reason this layer exists.
 */

class PaymentProvider {
  constructor({ id, label, isProduction = false }) {
    this.id = id;
    this.label = label;
    this.isProduction = isProduction;
  }

  /** Whether this provider can collect anything at all right now. */
  // eslint-disable-next-line class-methods-use-this -- overridden per provider.
  get available() {
    return false;
  }

  /** Why it cannot, in words an admin can act on. Null when it can. */
  // eslint-disable-next-line class-methods-use-this
  get unavailableReason() {
    return null;
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async createPayment(_request) {
    throw new Error('createPayment is not implemented by this provider');
  }

  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async verifyPayment(_providerRef) {
    throw new Error('verifyPayment is not implemented by this provider');
  }

  async getPaymentStatus(providerRef) {
    return this.verifyPayment(providerRef);
  }

  /**
   * A QR the customer scans, as both the raw payload and a rendered SVG.
   *
   * Both are returned because they answer different needs: the payload is what
   * a UPI app opens from a deep link on the same phone, and the SVG is what a
   * second phone points its camera at. Rendering server-side keeps the two in
   * step — a client drawing its own QR from a payload it reformatted is a
   * class of bug where money goes to the wrong place.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  async generateQrCode(_request) {
    throw new Error('generateQrCode is not implemented by this provider');
  }

  /**
   * Whether a webhook body really came from this provider.
   *
   * Default is refusal. A provider that cannot prove a callback's origin has no
   * business acting on one, and defaulting to `true` here would mean anyone who
   * can reach the URL can mark rides paid.
   */
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  verifyWebhookSignature(_rawBody, _signature) {
    return false;
  }
}

/**
 * A UPI intent string, per the NPCI deep-linking spec.
 *
 * The amount is fixed into the string rather than left for the payer to type,
 * so a customer cannot scan a ₹100 fare and send ₹10 — and the transaction
 * reference ties the payment back to the ride it settles.
 */
function upiIntent({ vpa, payeeName, amount, currency = 'INR', reference, note, merchantCode }) {
  const params = new URLSearchParams();
  params.set('pa', vpa);
  if (payeeName) params.set('pn', payeeName);
  if (merchantCode) params.set('mc', merchantCode);
  if (reference) params.set('tr', reference);
  if (note) params.set('tn', note.slice(0, 50));
  params.set('am', Number(amount).toFixed(2));
  params.set('cu', currency);

  // URLSearchParams encodes spaces as '+', which several UPI apps read
  // literally and show as part of the payee's name.
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * The scannable image for a payload. SVG so it stays sharp at any size.
 *
 * `qrcode` is required here rather than at the top of the file on purpose. It
 * is needed only when a provider is actually collecting a payment, and a
 * top-level require made the whole payment service — and therefore the whole
 * app — fail to load on any install that predates the dependency. A missing
 * drawing library should cost a QR code, not the platform.
 */
async function qrSvg(payload) {
  let QRCode;
  try {
    // eslint-disable-next-line global-require
    QRCode = require('qrcode');
  } catch {
    logger.warn('The `qrcode` package is not installed, so no QR image can be drawn. Run `npm install`.');
    return null;
  }

  return QRCode.toString(payload, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M'
  });
}

/** A reference the provider and the ledger can both be searched by. */
const reference = (prefix) => `${prefix}${crypto.randomBytes(8).toString('hex')}`.toUpperCase();

/** Maps whatever a provider calls its states onto ours. */
const PROVIDER_STATUS = {
  created: PAYMENT_STATUS.PROCESSING,
  pending: PAYMENT_STATUS.PROCESSING,
  authorized: PAYMENT_STATUS.PROCESSING,
  captured: PAYMENT_STATUS.PAID,
  paid: PAYMENT_STATUS.PAID,
  success: PAYMENT_STATUS.PAID,
  failed: PAYMENT_STATUS.FAILED,
  cancelled: PAYMENT_STATUS.CANCELLED,
  refunded: PAYMENT_STATUS.REFUNDED
};

module.exports = { PaymentProvider, upiIntent, qrSvg, reference, PROVIDER_STATUS };
