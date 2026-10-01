const mongoose = require('mongoose');

/**
 * Every admin mutation, with what the value was and what it became.
 *
 * Written after the change has succeeded, so the log records what happened
 * rather than what was attempted. Deliberately append-only: nothing in the
 * codebase updates or deletes a row here.
 */
const auditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    adminEmail: { type: String, required: true },
    adminRole: { type: String, required: true },

    // e.g. 'settings.update', 'rider.block', 'complaint.resolve'
    action: { type: String, required: true, index: true },

    // e.g. 'Setting', 'Rider', 'Complaint'
    resource: { type: String, required: true, index: true },
    resourceId: { type: String, default: null },

    // Only the fields that moved. Secrets never reach this — see audit.service.
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },

    note: { type: String, default: null },

    ip: { type: String, default: null },
    userAgent: { type: String, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ resource: 1, resourceId: 1, createdAt: -1 });
auditLogSchema.index({ adminId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
