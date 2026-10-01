const AuditLog = require('../models/AuditLog');
const logger = require('../utils/logger');

/**
 * Records what an admin changed.
 *
 * Two rules shape this file. Writing an audit row must never break the action it
 * describes, so failures are logged and swallowed — a missing log line is better
 * than a half-applied block. And nothing sensitive may be recorded, so values are
 * put through a redactor rather than trusted to be harmless.
 */

const SENSITIVE = /password|token|secret|otp|refresh|authorization|cookie|hash|enc$/i;

/**
 * Strips anything that should not be retained anywhere, at any depth. Applied to
 * both old and new values, because a document read before an update carries the
 * same secrets as one read after it.
 */
function redact(value, depth = 0) {
  if (value == null) return null;

  // Past the depth limit, drop the branch rather than copying it through
  // unexamined: returning it whole is exactly how a secret nested six levels
  // down would end up in the log verbatim. A scalar at the limit is safe to
  // keep, since a key below cannot hide inside it.
  if (depth > 4) {
    if (typeof value === 'object') return '[too deep]';
    return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));

  if (value instanceof Date) return value;

  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE.test(key)) continue;
      out[key] = redact(item, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;

  return value;
}

const clientIp = (req) =>
  (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req?.ip || req?.socket?.remoteAddress || null;

/**
 * @param req   the Express request, for the admin and the client details
 * @param entry { action, resource, resourceId, oldValue, newValue, note }
 */
async function record(req, entry) {
  const admin = req?.admin;
  if (!admin) {
    logger.warn(`Audit entry without an admin: ${entry.action}`);
    return null;
  }

  try {
    return await AuditLog.create({
      adminId: admin._id,
      adminEmail: admin.email,
      adminRole: admin.role,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ? String(entry.resourceId) : null,
      oldValue: redact(entry.oldValue),
      newValue: redact(entry.newValue),
      note: entry.note || null,
      ip: clientIp(req),
      userAgent: req?.headers?.['user-agent']?.slice(0, 300) || null
    });
  } catch (err) {
    logger.error(`Failed to write audit log for ${entry.action}: ${err.message}`);
    return null;
  }
}

async function list({ page = 1, limit = 25, adminId, resource, action, from, to } = {}) {
  const filter = {};
  if (adminId) filter.adminId = adminId;
  if (resource) filter.resource = resource;
  if (action) filter.action = new RegExp(`^${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter)
  ]);

  return { logs, total, page, limit };
}

/** The trail for one thing, used on the rider, ride and complaint detail pages. */
async function forResource(resource, resourceId, limit = 20) {
  return AuditLog.find({ resource, resourceId: String(resourceId) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = { record, list, forResource, redact };
