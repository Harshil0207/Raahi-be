const mongoose = require('mongoose');

const NOTIFICATION_TYPE = {
  RIDE_ACCEPTED: 'RIDE_ACCEPTED',
  RIDER_NEARBY: 'RIDER_NEARBY',
  RIDER_ARRIVED: 'RIDER_ARRIVED',
  TRIP_STARTED: 'TRIP_STARTED',
  TRIP_COMPLETED: 'TRIP_COMPLETED',
  RIDE_CANCELLED: 'RIDE_CANCELLED',
  PAYMENT_UPDATED: 'PAYMENT_UPDATED',
  SUPPORT: 'SUPPORT',
  SYSTEM: 'SYSTEM'
};

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPE), required: true },

    title: { type: String, required: true },
    body: { type: String },

    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
    readAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// The feed is always "this user, newest first", and unread counts filter on readAt.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

notificationSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    type: this.type,
    title: this.title,
    body: this.body,
    rideId: this.rideId,
    read: Boolean(this.readAt),
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPE = NOTIFICATION_TYPE;
