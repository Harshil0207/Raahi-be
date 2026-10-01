const mongoose = require('mongoose');
const { MESSAGE_TYPE } = require('../constants/chat');
const { ROLES } = require('../constants/userRoles');

const chatMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatConversation',
      required: true,
      index: true
    },
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true, index: true },

    // The sender's user id, taken from the authenticated socket or request —
    // never from the payload.
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    senderRole: { type: String, enum: [...Object.values(ROLES), 'system'], required: true },

    message: { type: String, required: true, trim: true },
    messageType: { type: String, enum: Object.values(MESSAGE_TYPE), default: MESSAGE_TYPE.TEXT },

    readAt: { type: Date, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The only read pattern: one conversation, newest last, paged.
chatMessageSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
