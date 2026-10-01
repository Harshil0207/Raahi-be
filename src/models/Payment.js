const mongoose = require('mongoose');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../constants/paymentStatus');

/**
 * One attempt to collect a fare through a gateway.
 *
 * WHY ATTEMPTS ARE A LIST. A payment gateway will not let a merchant order id
 * be reused, and a customer whose card is declined must be able to try again.
 * But a ride has exactly one fare and exactly one settlement — the unique index
 * on `rideId` below is what stops a ride being paid for twice, and every piece
 * of idempotency downstream is keyed on the ride. So the attempt is what
 * multiplies, not the payment: each one carries its own merchant order id and
 * its own outcome, and the payment they belong to is still one row.
 *
 * Nothing here decides anything. The authoritative status is on the payment,
 * and it is only ever written from what the provider was asked directly.
 */
const attemptSchema = new mongoose.Schema(
  {
    /** Ours, and unique across every attempt. What the provider is queried by. */
    merchantOrderId: { type: String, required: true },

    /** Theirs. Recorded because support conversations happen in their terms. */
    providerOrderId: { type: String, default: null },
    providerPaymentId: { type: String, default: null },

    provider: { type: String, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PROCESSING },

    /** Where the customer was sent. Not secret, but not useful to anybody else. */
    checkoutUrl: { type: String, default: null },

    /** Whether the provider ever called us about this attempt. */
    callbackReceived: { type: Boolean, default: false },
    callbackAt: { type: Date, default: null },

    paymentMode: { type: String, default: null },
    failureReason: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },

    /**
     * A trimmed copy of what the provider last said.
     *
     * Deliberately small and deliberately not the raw body: masked card
     * numbers and VPAs belong to the customer and identify nothing a support
     * request needs that the transaction id does not.
     */
    meta: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true, _id: true }
);

const paymentSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },

    amount: { type: Number, required: true },
    currency: { type: String, required: true },

    method: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
      index: true
    },

    /** Which gateway is handling this, when one is. Cash has none. */
    provider: { type: String, default: null },

    // Filled in by the gateway integration for UPI. Cash settles without them.
    // These mirror the live attempt so existing readers keep working unchanged.
    providerOrderId: { type: String, default: null },
    providerPaymentId: { type: String, default: null },
    checkoutUrl: { type: String, default: null },
    failureReason: { type: String, default: null },

    attempts: { type: [attemptSchema], default: [] },

    settledAt: { type: Date, default: null },

    // Set when a settled fare is reversed. Kept separate from `settledAt` so a
    // refunded payment still records when the money originally arrived — a
    // refund is a second event, not a correction of the first.
    refundedAt: { type: Date, default: null },
    refund: {
      merchantRefundId: { type: String, default: null },
      providerRefundId: { type: String, default: null },
      amount: { type: Number, default: null },
      // The gateway's own verdict, never ours. It starts PROCESSING and only
      // becomes PAID when the provider's refund status API says so.
      status: { type: String, default: null },
      requestedAt: { type: Date, default: null },
      // When the provider confirmed it — which is also when the ledger moved.
      // Null while a refund is in flight, and on a refund that failed.
      settledAt: { type: Date, default: null },
      failureReason: { type: String, default: null },
      // Why an admin asked for it. Carried onto the ledger rows, so the books
      // say who reversed what and what for.
      reason: { type: String, default: null },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
    }
  },
  { timestamps: true }
);

/**
 * The webhook's lookup, which used to be a collection scan.
 *
 * A callback arrives carrying a merchant order id and nothing else useful, and
 * every one of them had to read every payment ever taken to find its row. It is
 * sparse because cash payments have no attempts and there is no reason to index
 * a few hundred thousand nulls.
 */
paymentSchema.index({ 'attempts.merchantOrderId': 1 }, { sparse: true });

/** The same question asked of the live attempt mirrored onto the payment. */
paymentSchema.index({ providerOrderId: 1 }, { sparse: true });

/** The admin transaction list: newest first, filterable by status. */
paymentSchema.index({ status: 1, createdAt: -1 });

/** A customer's own payment history. */
paymentSchema.index({ customerId: 1, createdAt: -1 });

/**
 * The refund callback's lookup.
 *
 * A refund callback carries a refund id, not an order id, so it cannot use the
 * attempts index above. Unique, because two payments claiming one refund id
 * would mean a refund confirmed against the wrong ride's books — the kind of
 * mistake a database should refuse rather than a reviewer catch.
 *
 * PARTIAL, NOT SPARSE. This was `sparse: true` and that was wrong in a way that
 * broke every payment after the first. A sparse index skips documents where the
 * field is MISSING; `merchantRefundId` defaults to `null`, so it is present on
 * every payment ever written, null included. Every unrefunded payment therefore
 * landed in the index under the same null key and the second one was refused
 * with a duplicate-key error — which surfaced as a trip that ended with no
 * payment record to collect against. A partial filter indexes only the
 * documents that actually carry a refund id.
 */
paymentSchema.index(
  { 'refund.merchantRefundId': 1 },
  { unique: true, partialFilterExpression: { 'refund.merchantRefundId': { $type: 'string' } } }
);

module.exports = mongoose.model('Payment', paymentSchema);
