const mongoose = require('mongoose');
const { CONVERSATION_STATUS } = require('../constants/chat');

/**
 * One conversation per ride, created when a rider accepts.
 *
 * The participants are copied here from the ride at creation so authorising a
 * message is a single indexed read rather than a join, and so a later change to
 * the ride cannot silently widen who may post.
 *
 * Unread counts are kept per side rather than derived from the messages, because
 * the badge is read on every screen and counting unread rows would be the most
 * frequent query in the app.
 */
const chatConversationSchema = new mongoose.Schema(
  {
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', required: true, index: true },
    // The rider's user account, so a rider socket can be matched without a join.
    riderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: Object.values(CONVERSATION_STATUS),
      default: CONVERSATION_STATUS.OPEN,
      index: true
    },

    // When the grace period after drop-off runs out. Null while the ride is live.
    closesAt: { type: Date, default: null },

    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: null },

    unread: {
      customer: { type: Number, default: 0 },
      rider: { type: Number, default: 0 }
    },

    messageCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

chatConversationSchema.index({ customerId: 1, lastMessageAt: -1 });
chatConversationSchema.index({ riderId: 1, lastMessageAt: -1 });

module.exports = mongoose.model('ChatConversation', chatConversationSchema);
