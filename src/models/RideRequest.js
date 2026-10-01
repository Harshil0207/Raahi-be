const mongoose = require('mongoose');
const { RIDE_REQUEST_STATUS } = require('../constants/rideStatus');

const rideRequestSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, index: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },

    status: {
      type: String,
      enum: Object.values(RIDE_REQUEST_STATUS),
      default: RIDE_REQUEST_STATUS.PENDING
    },

    distanceToPickupKm: { type: Number },

    /**
     * Which dispatch round this offer belongs to.
     *
     * A ride is offered to riders in rounds: the first booking is round 0, and
     * every "Request again" is the next one. The round is what makes a second
     * offer to the same rider a DIFFERENT document rather than a duplicate —
     * see the unique index below, which is the whole reason this field exists.
     */
    round: { type: Number, required: true, default: 0, min: 0 },

    // Authoritative deadline. The rider app shows a countdown, the server decides.
    expiresAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

/**
 * One offer per rider PER ROUND.
 *
 * This was `{rideId, riderId}` unique, which reads as the obvious invariant —
 * a rider should not be asked about the same ride twice at once — and was the
 * bug behind "Request again does nothing". The nearby riders in round two are
 * usually the same people as in round one, so every insert in the second
 * dispatch collided on this index: the round threw before it could emit, the
 * re-request endpoint failed, and the rider's phone never rang for the new
 * offer. Two separate reported symptoms, one index.
 *
 * Adding the round keeps the invariant that matters — no rider holds two live
 * offers for one ride — while letting each round be its own document, so the
 * expired offers stay in the database as history instead of being overwritten.
 */
rideRequestSchema.index({ rideId: 1, riderId: 1, round: 1 }, { unique: true });
rideRequestSchema.index({ riderId: 1, status: 1, expiresAt: -1 });

module.exports = mongoose.model('RideRequest', rideRequestSchema);
