const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ALL_ADMIN_ROLES, ADMIN_ROLES, ALL_PERMISSIONS, permissionsFor } = require('../constants/adminRoles');

const SALT_ROUNDS = 10;

/**
 * Admins are a separate collection from users, not a role on User.
 *
 * That keeps the two authentication paths from ever meeting: a customer's token
 * has a `sub` that does not exist here, and an admin token is signed with a
 * different secret, so neither can be presented to the other's endpoints.
 */
const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },

    role: { type: String, enum: ALL_ADMIN_ROLES, default: ADMIN_ROLES.SUPPORT, index: true },

    // Grants and revocations on top of the role, so one agent can be given a
    // single extra capability without being moved to a broader role.
    extraPermissions: { type: [{ type: String, enum: ALL_PERMISSIONS }], default: [] },
    deniedPermissions: { type: [{ type: String, enum: ALL_PERMISSIONS }], default: [] },

    isActive: { type: Boolean, default: true, index: true },

    lastLoginAt: { type: Date, default: null },

    // Cleared on password change and on disable, which ends every open session.
    tokenVersion: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null }
  },
  { timestamps: true }
);

adminSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
});

adminSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

adminSchema.methods.permissions = function permissions() {
  return permissionsFor(this);
};

adminSchema.methods.can = function can(permission) {
  return this.permissions().includes(permission);
};

adminSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    permissions: this.permissions(),
    isActive: this.isActive,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt
  };
};

module.exports = mongoose.model('Admin', adminSchema);
