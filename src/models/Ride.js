const mongoose = require('mongoose');
const { RIDE_STATUS } = require('../constants/rideStatus');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../constants/paymentStatus');
const { BOOKING_TYPE, SERVICE_TYPE, ALL_PACKAGE_SIZES } = require('../constants/services');

const placeSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, trim: true },
    placeId: { type: String, trim: true },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true } // [lng, lat]
    }
  },
  { _id: false }
);

/**
 * Who the package is going between, and what it is.
 *
 * Only filled for a parcel. The sender is usually the customer, but not always
 * — someone sends a forgotten laptop to a colleague — so both ends are named
 * rather than assumed from the account.
 */
const parcelSchema = new mongoose.Schema(
  {
    senderName: { type: String, required: true, trim: true, maxlength: 80 },
    senderPhone: { type: String, required: true, trim: true, maxlength: 20 },
    receiverName: { type: String, required: true, trim: true, maxlength: 80 },
    receiverPhone: { type: String, required: true, trim: true, maxlength: 20 },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    size: { type: String, enum: ALL_PACKAGE_SIZES, required: true },
    weightKg: { type: Number, min: 0, max: 200, default: null }
  },
  { _id: false }
);

const rideSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', default: null, index: true },

    // What the job is, and what turns up to do it. Kept apart because a bike
    // carries both people and packages, at different prices.
    bookingType: {
      type: String,
      enum: Object.values(BOOKING_TYPE),
      default: BOOKING_TYPE.RIDE,
      index: true
    },
    serviceType: {
      type: String,
      enum: Object.values(SERVICE_TYPE),
      // Rides booked before services existed were all cars.
      default: SERVICE_TYPE.CAR,
      index: true
    },

    // Present only on a parcel. A passenger ride has nobody to hand over to.
    parcel: { type: parcelSchema, default: undefined },

    pickup: { type: placeSchema, required: true },
    destination: { type: placeSchema, required: true },

    estimatedDistanceKm: { type: Number, required: true },
    estimatedDurationMin: { type: Number },
    estimatedFare: { type: Number, required: true },

    finalDistanceKm: { type: Number, default: null },

    /**
     * The journey itself, before anything was added for waiting.
     *
     * Kept apart from `finalFare` so a receipt can show what the trip cost and
     * what the waiting cost without subtracting one from the other and hoping
     * the arithmetic still holds. It is also the figure the minimum and
     * maximum fare were applied to: a waiting charge is compensation for time
     * and is added on top of a capped fare, not swallowed by the cap.
     */
    rideFare: { type: Number, default: null },
    finalFare: { type: Number, default: null },

    /**
     * How many times the customer has asked again after nobody accepted.
     *
     * Counted on the ride rather than inferred from the request rows, because
     * the rule is about the customer's patience with this trip, not about how
     * many riders happened to be nearby each round. `ride.maxReRequests` is the
     * ceiling.
     */
    reRequestCount: { type: Number, default: 0 },

    // Rate is copied onto the ride so old rides keep their pricing when it changes.
    fareRatePerKm: { type: Number, required: true },
    currency: { type: String, required: true },

    // The full pricing the ride was created under, not just the per-km rate.
    // Settlement reads this, so an admin raising the fare tomorrow can never
    // reprice a trip taken today. `fareRatePerKm` above stays as the column
    // rides created before this field have.
    pricing: {
      // The service the rate came from, so a settled ride can be read back
      // without inferring the price from today's catalogue.
      serviceType: { type: String },
      ratePerKm: { type: Number },
      baseFare: { type: Number, default: 0 },
      minimumFare: { type: Number, default: 0 },
      maximumFare: { type: Number, default: 0 },
      currency: { type: String }
    },

    /**
     * How the settled fare was divided, frozen at drop-off.
     *
     * Written once, when the trip ends, from the commission rate in force at
     * that moment. Nothing recomputes it: an admin moving the commission from
     * 15% to 20% tomorrow changes what the next ride is split at and leaves
     * every ride already driven exactly as it settled. That is the same rule
     * `pricing` above applies to the fare itself, for the same reason — a
     * figure a rider has already been shown must not move afterwards.
     */
    finance: {
      fareAmount: { type: Number, default: null },
      platformCommissionRate: { type: Number, default: null },
      platformCommissionAmount: { type: Number, default: null },
      riderEarningAmount: { type: Number, default: null },
      currency: { type: String, default: null },
      // Set when the ledger entries for this ride were posted. Its presence is
      // what tells a second completion attempt that the money is already done.
      postedAt: { type: Date, default: null }
    },

    status: {
      type: String,
      enum: Object.values(RIDE_STATUS),
      default: RIDE_STATUS.SEARCHING,
      index: true
    },

    otp: {
      hash: { type: String, required: true, select: false },
      // Encrypted copy so the owning customer can read their code back after a
      // refresh. Never selected by default and never sent to the rider.
      enc: { type: String, default: null, select: false },
      attempts: { type: Number, default: 0 },
      verifiedAt: { type: Date, default: null },
      // Null on rides created before the expiry setting existed; those stay valid.
      expiresAt: { type: Date, default: null }
    },

    payment: {
      method: { type: String, enum: Object.values(PAYMENT_METHOD), default: null },
      status: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING },
      paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null }
    },

    /**
     * What the customer thought of the rider.
     *
     * Kept under its original name so rides scored before the categories
     * existed still read back correctly; `categories` is simply absent on
     * those. The overall value is what feeds the rider's running average —
     * the categories are context for whoever reads a complaint later, not a
     * second score to average.
     */
    rating: {
      value: { type: Number, min: 1, max: 5, default: null },
      comment: { type: String, trim: true, maxlength: 300, default: null },
      categories: {
        driving: { type: Number, min: 1, max: 5, default: null },
        behaviour: { type: Number, min: 1, max: 5, default: null },
        vehicle: { type: Number, min: 1, max: 5, default: null }
      },
      at: { type: Date, default: null }
    },

    /** And what the rider thought of the customer. */
    customerRating: {
      value: { type: Number, min: 1, max: 5, default: null },
      comment: { type: String, trim: true, maxlength: 300, default: null },
      categories: {
        behaviour: { type: Number, min: 1, max: 5, default: null },
        readiness: { type: Number, min: 1, max: 5, default: null },
        communication: { type: Number, min: 1, max: 5, default: null }
      },
      at: { type: Date, default: null }
    },

    cancellation: {
      by: { type: String, enum: ['customer', 'rider', 'system'], default: null },
      /**
       * The human-readable line, kept as the field every existing screen and
       * export already reads. `reasonCode` is the countable version beside it;
       * rides cancelled before the codes existed simply have none.
       */
      reason: { type: String, trim: true, default: null },
      reasonCode: { type: String, trim: true, default: null },
      note: { type: String, trim: true, maxlength: 300, default: null },
      /**
       * What it cost, worked out by the rules in force at the time and frozen
       * here. Zero is a real answer — most cancellations are free — and is
       * stored rather than left null so a receipt can say so plainly.
       */
      fee: { type: Number, default: 0 },
      at: { type: Date, default: null }
    },

    acceptedAt: { type: Date, default: null },
    // When the rider set off towards the pickup, as distinct from reaching it.
    arrivingAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },

    /**
     * What live tracking has worked out about this trip.
     *
     * `nearbyNotifiedAt` is the once-only latch: a rider circling for parking
     * crosses the nearby threshold over and over, and a customer does not want
     * to be told five times. It is a timestamp rather than a boolean so support
     * can see WHEN it fired, which is the question actually asked afterwards.
     *
     * The distance is the last one measured from an accurate enough fix, kept
     * so a customer reconnecting is told how far away their rider is without
     * waiting for the next ping.
     */
    tracking: {
      nearbyNotifiedAt: { type: Date, default: null },
      lastDistanceMeters: { type: Number, default: null },
      lastFixAt: { type: Date, default: null }
    },
    /**
     * Time the rider spent waiting, and what it cost.
     *
     * TWO TIMESTAMPS PER PHASE, AND NOTHING THAT TICKS. There is no counter
     * being incremented and no document rewritten every second — the elapsed
     * time is a function of the two dates, computed whenever anybody asks. A
     * refresh, a reconnect, a closed browser or a restarted server therefore
     * all give the same answer, and a customer cannot buy back their free
     * minutes by reloading the page.
     *
     * `freeMinutes` and `perMinute` are copied here when each phase starts, the
     * same way the commission rate is frozen when a fare settles: the rules a
     * ride was charged under must stay with the ride, so that an operator
     * changing the price this afternoon cannot reprice this morning's trips.
     */
    waiting: {
      // Rider parked at the pickup: starts at ARRIVED, stops at OTP.
      pickup: {
        startedAt: { type: Date, default: null },
        endedAt: { type: Date, default: null },
        seconds: { type: Number, default: 0 },
        minutes: { type: Number, default: 0 },
        charge: { type: Number, default: 0 },
        freeMinutes: { type: Number, default: null },
        perMinute: { type: Number, default: null }
      },
      // Rider at the drop-off waiting to be paid: starts when the journey ends,
      // stops when the amount owed is fixed.
      payment: {
        startedAt: { type: Date, default: null },
        endedAt: { type: Date, default: null },
        seconds: { type: Number, default: 0 },
        minutes: { type: Number, default: 0 },
        charge: { type: Number, default: 0 },
        freeMinutes: { type: Number, default: null },
        perMinute: { type: Number, default: null }
      }
    },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

rideSchema.index({ customerId: 1, createdAt: -1 });
rideSchema.index({ riderId: 1, createdAt: -1 });
rideSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Ride', rideSchema);
