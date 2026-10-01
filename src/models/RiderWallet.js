const mongoose = require('mongoose');
const {
  WALLET_STATUS,
  ALL_WALLET_STATUSES,
  outstandingOf,
  availableOf
} = require('../constants/finance');

/**
 * One account per rider, holding the running totals.
 *
 * The balance here is a cache of the ledger, not the truth: every movement is a
 * WalletLedger row, and this document is what those rows add up to. Keeping
 * both means the common reads — can this rider go online, what do they owe —
 * are a single lookup, while the ledger stays the record that can be audited
 * and replayed.
 *
 * `balance` is signed, from the rider's point of view. See constants/finance.js
 * for the convention; the two virtuals below are the only way the rest of the
 * application should ask "what do they owe" and "what are they owed", so the
 * sign is interpreted in exactly one place.
 */
const riderWalletSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      required: true,
      unique: true
    },

    currency: { type: String, required: true },

    // > 0 the platform owes the rider; < 0 the rider owes the platform.
    balance: { type: Number, default: 0 },

    // Lifetime counters, kept for the wallet and admin screens so neither has to
    // scan the whole ledger to show a headline figure. Each is incremented in
    // the same write as the ledger row that justifies it.
    lifetimeEarnings: { type: Number, default: 0 },
    lifetimeCommission: { type: Number, default: 0 },
    lifetimeCashCollected: { type: Number, default: 0 },
    lifetimeUpiCollected: { type: Number, default: 0 },
    lifetimeRecharged: { type: Number, default: 0 },
    lifetimeAdjustments: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ALL_WALLET_STATUSES,
      default: WALLET_STATUS.ACTIVE,
      index: true
    },

    // The ceiling in force when `status` was last worked out, so a screen can
    // explain the block without re-reading settings, and so a change to the
    // setting is visibly what moved a rider in or out of it.
    thresholdAtStatus: { type: Number, default: null },
    statusChangedAt: { type: Date, default: null },

    // Monotonic per rider. Gives the ledger a stable order even when two rows
    // share a timestamp, which they do whenever a ride posts its lines together.
    sequence: { type: Number, default: 0 },

    lastEntryAt: { type: Date, default: null }
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

riderWalletSchema.virtual('outstanding').get(function outstanding() {
  return outstandingOf(this.balance);
});

riderWalletSchema.virtual('available').get(function available() {
  return availableOf(this.balance);
});

/**
 * What the rider and admin apps are allowed to see. Deliberately explicit: the
 * two balances are named rather than left as one signed number, because the
 * whole point of the model is that money owed and money earned are different
 * things that must not be read as each other.
 */
riderWalletSchema.methods.toPublic = function toPublic() {
  return {
    riderId: this.riderId,
    currency: this.currency,
    available: this.available,
    outstanding: this.outstanding,
    status: this.status,
    threshold: this.thresholdAtStatus,
    lifetime: {
      earnings: this.lifetimeEarnings,
      commission: this.lifetimeCommission,
      cashCollected: this.lifetimeCashCollected,
      upiCollected: this.lifetimeUpiCollected,
      recharged: this.lifetimeRecharged,
      adjustments: this.lifetimeAdjustments
    },
    lastEntryAt: this.lastEntryAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('RiderWallet', riderWalletSchema);
