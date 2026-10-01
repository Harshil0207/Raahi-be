const mongoose = require('mongoose');
const { ROLES } = require('../constants/userRoles');

/**
 * The support conversation on one complaint.
 *
 * Separate from ChatMessage because the participants are different — a reporter
 * and whichever admin picks it up, not two people on a ride — and because these
 * outlive the ride they may refer to. One authorisation rule cannot sensibly
 * cover both.
 */
const complaintMessageSchema = new mongoose.Schema(
  {
    complaintId: { type: mongoose.Schema.Types.ObjectId, ref: 'Complaint', required: true, index: true },

    // Exactly one of these is set. An admin reply has adminId; a reporter's has senderId.
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    senderRole: { type: String, enum: [...Object.values(ROLES), 'admin', 'system'], required: true },
    senderName: { type: String, required: true },

    message: { type: String, required: true, trim: true, maxlength: 4000 },

    readAt: { type: Date, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

complaintMessageSchema.index({ complaintId: 1, createdAt: 1 });

module.exports = mongoose.model('ComplaintMessage', complaintMessageSchema);
