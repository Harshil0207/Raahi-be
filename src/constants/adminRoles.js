/**
 * Admin roles and what each one may do.
 *
 * Permissions are the unit the backend checks; roles are a convenience for
 * assigning a sensible set of them. An admin's effective permissions are their
 * role's defaults plus anything granted to them individually, so a support agent
 * can be given one extra capability without being promoted.
 *
 * SUPER_ADMIN is deliberately not a list: it is the only role that can create
 * other admins, and a wildcard avoids a new permission silently failing to reach
 * the person who is supposed to be able to grant it.
 */

const ADMIN_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  SUPPORT: 'SUPPORT',
  OPERATIONS: 'OPERATIONS',
  FINANCE: 'FINANCE'
};

const PERMISSIONS = {
  USERS_READ: 'users.read',
  USERS_UPDATE: 'users.update',
  USERS_BLOCK: 'users.block',

  RIDERS_READ: 'riders.read',
  RIDERS_UPDATE: 'riders.update',
  RIDERS_BLOCK: 'riders.block',

  RIDES_READ: 'rides.read',
  RIDES_MANAGE: 'rides.manage',

  PAYMENTS_READ: 'payments.read',
  PAYMENTS_MANAGE: 'payments.manage',

  // Rider wallets and the platform ledger. Separate from PAYMENTS_* because
  // reading what a ride was charged and moving what a rider owes are different
  // powers: the first is reconciliation, the second is money changing hands.
  // FINANCE_ADJUST is the narrower of the two on purpose — it is the only
  // permission in the system that can alter a balance.
  FINANCE_READ: 'finance.read',
  FINANCE_ADJUST: 'finance.adjust',

  COMPLAINTS_READ: 'complaints.read',
  COMPLAINTS_MANAGE: 'complaints.manage',

  SETTINGS_READ: 'settings.read',
  SETTINGS_UPDATE: 'settings.update',

  // Read only, deliberately: an admin can look at a ride conversation and is
  // logged doing it. There is no writing into one, so there is no permission
  // for it either.
  CHAT_READ: 'chat.read',

  NOTIFICATIONS_READ: 'notifications.read',
  NOTIFICATIONS_SEND: 'notifications.send',

  AUDIT_READ: 'audit.read',

  ADMINS_READ: 'admins.read',
  ADMINS_MANAGE: 'admins.manage'
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

const P = PERMISSIONS;

const ROLE_PERMISSIONS = {
  [ADMIN_ROLES.SUPER_ADMIN]: ALL_PERMISSIONS,

  // Everything operational, but not the ability to mint other admins.
  [ADMIN_ROLES.ADMIN]: [
    P.USERS_READ, P.USERS_UPDATE, P.USERS_BLOCK,
    P.RIDERS_READ, P.RIDERS_UPDATE, P.RIDERS_BLOCK,
    P.RIDES_READ, P.RIDES_MANAGE,
    P.PAYMENTS_READ, P.PAYMENTS_MANAGE,
    P.FINANCE_READ, P.FINANCE_ADJUST,
    P.COMPLAINTS_READ, P.COMPLAINTS_MANAGE,
    P.SETTINGS_READ, P.SETTINGS_UPDATE,
    P.CHAT_READ,
    P.NOTIFICATIONS_READ, P.NOTIFICATIONS_SEND,
    P.AUDIT_READ,
    P.ADMINS_READ
  ],

  // Handles complaints and needs the context around them, but changes nothing else.
  [ADMIN_ROLES.SUPPORT]: [
    P.USERS_READ,
    P.RIDERS_READ,
    P.RIDES_READ,
    P.PAYMENTS_READ,
    P.FINANCE_READ,
    P.COMPLAINTS_READ, P.COMPLAINTS_MANAGE,
    P.CHAT_READ,
    P.NOTIFICATIONS_READ,
    P.SETTINGS_READ
  ],

  // Keeps rides and riders moving; no money, no configuration. Deliberately
  // has neither finance permission: dispatch does not need to see what a rider
  // owes, and certainly does not need to change it.
  [ADMIN_ROLES.OPERATIONS]: [
    P.USERS_READ,
    P.RIDERS_READ, P.RIDERS_UPDATE, P.RIDERS_BLOCK,
    P.RIDES_READ, P.RIDES_MANAGE,
    P.COMPLAINTS_READ,
    P.PAYMENTS_READ,
    P.CHAT_READ,
    P.NOTIFICATIONS_READ, P.NOTIFICATIONS_SEND,
    P.SETTINGS_READ
  ],

  // Reconciles payments and rider balances. Cannot touch rides.
  [ADMIN_ROLES.FINANCE]: [
    P.USERS_READ,
    P.RIDERS_READ,
    P.RIDES_READ,
    P.PAYMENTS_READ, P.PAYMENTS_MANAGE,
    P.FINANCE_READ, P.FINANCE_ADJUST,
    P.COMPLAINTS_READ,
    P.SETTINGS_READ,
    P.AUDIT_READ
  ]
};

/** Role defaults plus individual grants, minus individual revocations. */
function permissionsFor({ role, extraPermissions = [], deniedPermissions = [] }) {
  const base = ROLE_PERMISSIONS[role] || [];
  const denied = new Set(deniedPermissions);
  return [...new Set([...base, ...extraPermissions])].filter((p) => !denied.has(p));
}

module.exports = {
  ADMIN_ROLES,
  ALL_ADMIN_ROLES: Object.values(ADMIN_ROLES),
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsFor
};
