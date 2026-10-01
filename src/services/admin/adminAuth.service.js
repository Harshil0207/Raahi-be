const Admin = require('../../models/Admin');
const ApiError = require('../../utils/ApiError');
const audit = require('../audit.service');
const { signAdminToken } = require('../../utils/adminToken');
const { ADMIN_ROLES, ALL_PERMISSIONS } = require('../../constants/adminRoles');

/** Admin sessions, password changes, and the admin-management screens. */

async function login({ email, password }) {
  const admin = await Admin.findOne({ email }).select('+password');

  // One message for a wrong address and a wrong password, so the endpoint cannot
  // be used to find out which admin accounts exist.
  const invalid = ApiError.unauthorized('Email or password is incorrect');
  if (!admin) throw invalid;
  if (!(await admin.comparePassword(password))) throw invalid;
  if (!admin.isActive) throw ApiError.forbidden('This admin account has been disabled');

  admin.lastLoginAt = new Date();
  await admin.save();

  return { admin: admin.toPublic(), accessToken: signAdminToken(admin) };
}

async function changePassword(admin, { currentPassword, newPassword }) {
  const withPassword = await Admin.findById(admin._id).select('+password');

  if (!(await withPassword.comparePassword(currentPassword))) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'currentPassword', message: 'Current password is incorrect' }
    ]);
  }
  if (currentPassword === newPassword) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'newPassword', message: 'New password must be different' }
    ]);
  }

  withPassword.password = newPassword;
  // Ends every other session this admin had open.
  withPassword.tokenVersion += 1;
  await withPassword.save();

  // A fresh token so the admin who just changed their password stays signed in.
  return { accessToken: signAdminToken(withPassword) };
}

async function updateOwnProfile(admin, { name }) {
  admin.name = name;
  await admin.save();
  return admin.toPublic();
}

// ------------------------------------------------------- admin management

async function listAdmins({ page = 1, limit = 25, search, role, isActive } = {}) {
  const filter = {};
  if (role) filter.role = role;
  if (typeof isActive === 'boolean') filter.isActive = isActive;
  if (search) {
    const term = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: term }, { email: term }];
  }

  const [admins, total] = await Promise.all([
    Admin.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Admin.countDocuments(filter)
  ]);

  return { admins: admins.map((a) => a.toPublic()), total, page, limit };
}

function assertKnownPermissions(permissions = []) {
  const unknown = permissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (unknown.length) {
    throw ApiError.badRequest('Validation failed', [
      { field: 'permissions', message: `Unknown permission(s): ${unknown.join(', ')}` }
    ]);
  }
}

async function createAdmin(req, payload) {
  const existing = await Admin.findOne({ email: payload.email });
  if (existing) throw ApiError.conflict('An admin with that email already exists');

  assertKnownPermissions(payload.extraPermissions);
  assertKnownPermissions(payload.deniedPermissions);

  const admin = await Admin.create({ ...payload, createdBy: req.admin._id });

  await audit.record(req, {
    action: 'admin.create',
    resource: 'Admin',
    resourceId: admin._id,
    newValue: { email: admin.email, role: admin.role, extraPermissions: admin.extraPermissions }
  });

  return admin.toPublic();
}

async function updateAdmin(req, adminId, patch) {
  const admin = await Admin.findById(adminId);
  if (!admin) throw ApiError.notFound('Admin not found');

  assertKnownPermissions(patch.extraPermissions);
  assertKnownPermissions(patch.deniedPermissions);

  // A super admin must not be able to lock themselves out or quietly demote
  // themselves mid-session; both are irreversible from inside the console.
  const isSelf = String(admin._id) === String(req.admin._id);
  if (isSelf && patch.role && patch.role !== admin.role) {
    throw ApiError.badRequest('You cannot change your own role');
  }
  if (isSelf && patch.isActive === false) {
    throw ApiError.badRequest('You cannot disable your own account');
  }

  if (admin.role === ADMIN_ROLES.SUPER_ADMIN && !isSelf) {
    const others = await Admin.countDocuments({
      role: ADMIN_ROLES.SUPER_ADMIN,
      isActive: true,
      _id: { $ne: admin._id }
    });
    const losingSuper = patch.isActive === false || (patch.role && patch.role !== ADMIN_ROLES.SUPER_ADMIN);
    if (losingSuper && others === 0) {
      throw ApiError.conflict('There must be at least one active super admin');
    }
  }

  const before = {
    name: admin.name,
    role: admin.role,
    isActive: admin.isActive,
    extraPermissions: [...admin.extraPermissions],
    deniedPermissions: [...admin.deniedPermissions]
  };

  Object.assign(admin, patch);
  // Disabling an account or narrowing its permissions should take effect now,
  // not whenever the current token happens to expire.
  if (patch.isActive === false || patch.role || patch.extraPermissions || patch.deniedPermissions) {
    admin.tokenVersion += 1;
  }
  await admin.save();

  const after = {
    name: admin.name,
    role: admin.role,
    isActive: admin.isActive,
    extraPermissions: [...admin.extraPermissions],
    deniedPermissions: [...admin.deniedPermissions]
  };

  await audit.record(req, {
    action: 'admin.update',
    resource: 'Admin',
    resourceId: admin._id,
    oldValue: before,
    newValue: after
  });

  return admin.toPublic();
}

/**
 * Sets a new password for another admin and ends their sessions. The caller
 * supplies the password; nothing is emailed, because there is no mail transport
 * configured and a password shown in an API response that claims to have been
 * sent would be worse than one the operator has to hand over deliberately.
 */
async function resetAdminPassword(req, adminId, newPassword) {
  const admin = await Admin.findById(adminId).select('+password');
  if (!admin) throw ApiError.notFound('Admin not found');

  admin.password = newPassword;
  admin.tokenVersion += 1;
  await admin.save();

  await audit.record(req, {
    action: 'admin.password_reset',
    resource: 'Admin',
    resourceId: admin._id,
    note: 'Password replaced and all sessions ended'
  });

  return { id: admin._id, sessionsEnded: true };
}

async function adminActivity(adminId, limit = 50) {
  const { logs } = await audit.list({ adminId, limit, page: 1 });
  return logs;
}

module.exports = {
  login,
  changePassword,
  updateOwnProfile,
  listAdmins,
  createAdmin,
  updateAdmin,
  resetAdminPassword,
  adminActivity
};
