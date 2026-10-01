const mongoose = require('mongoose');
const { RIDER_VERIFICATION, CAN_GO_ONLINE, ALL_VERIFICATION_STATUSES } = require('../constants/riderVerification');

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number], // [longitude, latitude] — GeoJSON order, not lat/lng
      required: true,
      default: undefined
    }
  },
  { _id: false }
);

const riderSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },
    vehicle: {
      type: { type: String, enum: ['bike', 'auto', 'car'], required: true },
      make: { type: String, trim: true },
      model: { type: String, trim: true },
      numberPlate: { type: String, required: true, trim: true, uppercase: true },
      color: { type: String, trim: true }
    },
    licence: {
      number: { type: String, required: true, trim: true, uppercase: true },
      expiresAt: { type: Date }
    },

    /**
     * Whether Raahi has cleared this rider to carry passengers.
     *
     * NOT defaulted in the schema, deliberately. A default is applied when an
     * existing document is read back, so `default: PENDING` would have made
     * every rider already working read as unverified the moment this deployed —
     * and `assertVerified` below would have taken them all off the road. An
     * absent value therefore means "predates this field" and is treated as
     * grandfathered; both paths that create a rider set it explicitly.
     */
    verificationStatus: { type: String, enum: ALL_VERIFICATION_STATUSES },
    verificationNote: { type: String, trim: true, default: null },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    isOnline: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: false },
    currentLocation: { type: pointSchema, default: undefined },
    lastLocationAt: { type: Date },

    activeRideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },

    totalRides: { type: Number, default: 0 },
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },

    /**
     * Reliability, as three counts rather than two rates.
     *
     * Rates are derived where they are used, so nothing here can drift out of
     * step with itself: an offer is only ever counted once, and a rate computed
     * from counts is always consistent with them. Offers that simply expired
     * are counted as received and not accepted, which is the honest reading —
     * a rider who ignores every ring is not a rider who accepts everything.
     */
    offersReceived: { type: Number, default: 0 },
    offersAccepted: { type: Number, default: 0 },
    ridesCancelled: { type: Number, default: 0 },

    // Online time, banked when the rider goes offline. `onlineSince` marks the
    // session in progress so the total stays correct without a background job.
    onlineSince: { type: Date, default: null },
    onlineSeconds: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Drives the nearby-rider search in matching.service.
riderSchema.index({ currentLocation: '2dsphere' });
riderSchema.index({ isOnline: 1, isAvailable: 1 });

riderSchema.virtual('rating').get(function rating() {
  return this.ratingCount ? Number((this.ratingSum / this.ratingCount).toFixed(2)) : null;
});

/**
 * The status, with the absent case resolved.
 *
 * One place decides what "no value" means, so the gate, the admin list and the
 * rider's own screen cannot disagree about a rider who predates the field.
 */
riderSchema.virtual('verification').get(function verification() {
  return this.verificationStatus || RIDER_VERIFICATION.GRANDFATHERED;
});

/** Whether this rider may go online at all. */
riderSchema.methods.isVerified = function isVerified() {
  return CAN_GO_ONLINE.includes(this.verification);
};

riderSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    verificationStatus: this.verification,
    // Why they were turned down, which is the one thing a rejected rider needs
    // and cannot get anywhere else.
    verificationNote: this.verificationNote,
    canGoOnline: this.isVerified(),
    vehicle: this.vehicle,
    isOnline: this.isOnline,
    isAvailable: this.isAvailable,
    // When the current online session began; null while offline. The client
    // shows the session length from this rather than counting on its own.
    onlineSince: this.onlineSince,
    currentLocation: this.currentLocation,
    lastLocationAt: this.lastLocationAt,
    activeRideId: this.activeRideId,
    totalRides: this.totalRides,
    rating: this.rating,

    /**
     * The rider's own record, for their own screen.
     *
     * Safe here because `toPublic` is only ever the rider's own view — their
     * profile and their session. What a CUSTOMER sees of a rider comes from
     * `riderSummary` in ride.service, which has no idea these exist and must
     * not: how often somebody turns down work is between them and Raahi.
     *
     * Counts rather than rates, so the screen can tell "no trips yet" from
     * "nothing accepted", which a percentage flattens into the same 0%.
     */
    offersReceived: this.offersReceived,
    offersAccepted: this.offersAccepted,
    ridesCancelled: this.ridesCancelled
  };
};

module.exports = mongoose.model('Rider', riderSchema);
