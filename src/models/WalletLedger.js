const mongoose = require('mongoose');
const { ALL_LEDGER_TYPES, ALL_LEDGER_DIRECTIONS } = require('../constants/finance');
const { PAYMENT_METHOD } = require('../constants/paymentStatus');

/**
 * Every movement of money that concerns a rider, one row each.
 *
 * Rows are append-only. Nothing in the application updates or deletes one: a
 * mistake is corrected by posting the opposite entry, which is why
 * ADMIN_ADJUSTMENT exists and why it insists on a reason. A ledger you can edit
 * is not a ledger.
 *
 * `amount` is always positive; `direction` carries the sign. `balanceBefore`
 * and `balanceAfter` are written at post time so a row can be read on its own
 * months later without replaying everything before it — and so a gap or a
 * disagreement between consecutive rows is detectable.
 */
const walletLedgerSchema = new mongoose.Schema(
  {
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },

    // Per-rider position in the ledger. Two rows posted in the same millisecond
    // still have an unambiguous order.
    sequence: { type: Number, required: true },

    type: { type: String, enum: ALL_LEDGER_TYPES, required: true, index: true },
    direction: { type: String, enum: ALL_LEDGER_DIRECTIONS, required: true },

    // Positive magnitude. The sign is `direction`, never this.
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },

    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },

    description: { type: String, required: true, trim: true, maxlength: 300 },

    // What this row was caused by. A ride posts several rows; a recharge posts
    // one; an adjustment posts one and names the admin who made it.
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null, index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    rechargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recharge', default: null },
    paymentMethod: { type: String, enum: [...Object.values(PAYMENT_METHOD), null], default: null },

    // Only ever set on ADMIN_ADJUSTMENT. The reason is required by the service,
    // not by the schema, so a bad call fails with a message rather than a
    // validation error the admin cannot act on.
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    reason: { type: String, trim: true, maxlength: 300, default: null },

    /**
     * What makes a repeat post harmless.
     *
     * A duplicate ride completion, a payment webhook delivered twice, a rider
     * double-tapping recharge: each derives the same key, the unique index
     * below rejects the second write, and the wallet is left alone. This is the
     * whole of the idempotency story — there is no "have we done this already?"
     * read that another request could race past between the check and the write.
     */
    idempotencyKey: { type: String, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The guarantee. Scoped to the rider so two riders can share a natural key
// (`ride:<id>:earning`) without colliding.
walletLedgerSchema.index({ riderId: 1, idempotencyKey: 1 }, { unique: true });

// How the wallet screen and the admin ledger read it: newest first, per rider.
walletLedgerSchema.index({ riderId: 1, sequence: -1 });
walletLedgerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WalletLedger', walletLedgerSchema);
