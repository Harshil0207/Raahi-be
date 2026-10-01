const Admin = require('../models/Admin');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAdminToken } = require('../utils/adminToken');

/**
 * Authentication and permission checks for the admin API.
 *
 * Hiding a menu item in the console is a courtesy to the operator; this is the
 * part that actually decides. Every admin route goes through `authenticateAdmin`
 * and every mutating one through `requirePermission`.
 */

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.adminAccessToken || null;
}

const authenticateAdmin = asyncHandler(async (req, res, next) => {
  const token = readToken(req);
  if (!token) throw ApiError.unauthorized();

  let decoded;
  try {
    decoded = verifyAdminToken(token);
  } catch {
    throw ApiError.unauthorized('Admin session is invalid or expired');
  }

  const admin = await Admin.findById(decoded.sub);
  if (!admin || !admin.isActive) throw ApiError.unauthorized('This admin account is not active');

  // Bumped when the password changes or the account is disabled, which ends
  // every session that was open at the time rather than only the current one.
  if ((decoded.ver ?? 0) !== admin.tokenVersion) {
    throw ApiError.unauthorized('Admin session has been ended, please sign in again');
  }

  req.admin = admin;
  next();
});

/**
 * Requires all of the listed permissions.
 *
 * The message names what was missing: an operator seeing "requires
 * settings.update" can ask for the right thing, where a bare 403 just looks broken.
 */
const requirePermission = (...required) => (req, res, next) => {
  if (!req.admin) return next(ApiError.unauthorized());

  const held = new Set(req.admin.permissions());
  const missing = required.filter((permission) => !held.has(permission));

  if (missing.length) {
    return next(ApiError.forbidden(`This action requires: ${missing.join(', ')}`));
  }

  next();
};

/** For the few things only a super admin may do, such as creating other admins. */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.admin) return next(ApiError.unauthorized());
  if (!roles.includes(req.admin.role)) {
    return next(ApiError.forbidden(`This action is restricted to: ${roles.join(', ')}`));
  }
  next();
};

module.exports = { authenticateAdmin, requirePermission, requireRole };
