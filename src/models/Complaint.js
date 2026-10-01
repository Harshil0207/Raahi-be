const mongoose = require('mongoose');
const { COMPLAINT_STATUS, COMPLAINT_PRIORITY } = require('../constants/complaint');
const { ROLES } = require('../constants/userRoles');

/**
 * A complaint from a customer or a rider.
 *
 * `reference` is the human-readable id support and the reporter quote at each
 * other. The ObjectId is what the system uses; nobody reads one aloud.
 *
 * `category` is a plain string rather than an enum because the allowed
 * categories are a platform setting an admin can edit. It is validated against
 * the active list at creation, and a complaint keeps its category afterwards
 * even if that category is later removed — the record is of what was reported.
 */
const complaintSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userRole: { type: String, enum: Object.values(ROLES), required: true },

    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null, index: true },

    category: { type: String, required: true, index: true },
    subject: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, required: true, trim: true, maxlength: 4000 },

    priority: {
      type: String,
      enum: Object.values(COMPLAINT_PRIORITY),
      default: COMPLAINT_PRIORITY.MEDIUM,
      index: true
    },
    status: {
      type: String,
      enum: Object.values(COMPLAINT_STATUS),
      default: COMPLAINT_STATUS.OPEN,
      index: true
    },

    assignedAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },

    // Never shown to the reporter. Replies to them are messages, not notes.
    adminNotes: {
      type: [
        {
          _id: false,
          adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
          adminName: { type: String, required: true },
          note: { type: String, required: true, trim: true, maxlength: 2000 },
          createdAt: { type: Date, default: Date.now }
        }
      ],
      default: []
    },

    resolution: { type: String, default: null, trim: true, maxlength: 2000 },

    // Derived from the priority's SLA at creation, and again if the priority moves.
    dueAt: { type: Date, default: null, index: true },

    unread: {
      reporter: { type: Number, default: 0 },
      admin: { type: Number, default: 0 }
    },
    lastMessageAt: { type: Date, default: null },

    resolvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// The triage queue: open complaints, worst first, oldest first.
complaintSchema.index({ status: 1, priority: -1, createdAt: 1 });
complaintSchema.index({ createdBy: 1, createdAt: -1 });
complaintSchema.index({ assignedAdmin: 1, status: 1 });

module.exports = mongoose.model('Complaint', complaintSchema);
