const mongoose = require('mongoose');
const { RECHARGE_STATUS, ALL_RECHARGE_STATUSES } = require('../constants/finance');

/**
 * A rider paying down what they owe the platform.
 *
 * The row is created the moment the rider asks to recharge and starts as
 * PENDING. It only reaches PAID when the payment provider says so — the ledger
 * is not touched before that, so an abandoned recharge leaves a record of the
 * attempt and no money.
 *
 * `providerRef` is the provider's own identifier for the collection. It is what
 * a verification callback is matched against, and it is the only thing about
 * the payment instrument stored here: no VPA, no card, no credential of any
 * kind ever lands in this collection.
 */
const rechargeSchema = new mongoose.Schema(
  {
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },

    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },

    status: {
      type: String,
      enum: ALL_RECHARGE_STATUSES,
      default: RECHARGE_STATUS.PENDING,
      index: true
    },

    provider: { type: String, required: true },
    providerRef: { type: String, default: null, index: true },
    // A payment page or UPI intent string the rider's app renders as a QR. Not
    // a credential; it is public by nature, since the point is to show it.
    checkoutRef: { type: String, default: null },

    failureReason: { type: String, default: null },

    // The balance either side of the recharge, copied from the ledger row it
    // produced. Lets the history screen say "₹151 → ₹121" without a join.
    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },

    // The minimum in force when this was raised, so a rejected attempt can be
    // explained later even after an admin changes the setting.
    minimumAtRequest: { type: Number, default: null },

    settledAt: { type: Date, default: null },

    /**
     * True while this attempt is still live, and the field the index below is
     * built on.
     *
     * Derived from `status` rather than set by hand — see the hook. It exists
     * because a partial index cannot be expressed over a list of statuses
     * portably, and without an index the "one open attempt at a time" rule was
     * a read followed by a write: two taps both found nothing open, both
     * created an attempt, and the rider was handed two payable QR codes.
     */
    open: { type: Boolean, default: true }
  },
  { timestamps: true }
);

const LIVE = [RECHARGE_STATUS.PENDING, RECHARGE_STATUS.PROCESSING];

rechargeSchema.pre('save', function syncOpen(next) {
  this.open = LIVE.includes(this.status);
  next();
});

// The constraint the service's check now has behind it. Scoped to live
// attempts, so a rider may have any number of settled or abandoned ones.
// `open` is in the key as well as the filter so this is a distinct index from
// the plain one on `riderId` rather than a second opinion about it.
rechargeSchema.index({ riderId: 1, open: 1 }, { unique: true, partialFilterExpression: { open: true } });

rechargeSchema.index({ riderId: 1, createdAt: -1 });

module.exports = mongoose.model('Recharge', rechargeSchema);
