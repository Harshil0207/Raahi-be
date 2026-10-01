const { z } = require('zod');
const { ALL_SERVICE_TYPES } = require('../constants/services');
const { objectId } = require('./common.validator');
const { ALL_ADMIN_ROLES, ALL_PERMISSIONS } = require('../constants/adminRoles');
const { RIDE_STATUS } = require('../constants/rideStatus');
const { ALL_VERIFICATION_STATUSES } = require('../constants/riderVerification');
const { PAYMENT_METHOD, PAYMENT_STATUS } = require('../constants/paymentStatus');
const { COMPLAINT_STATUS, COMPLAINT_PRIORITY } = require('../constants/complaint');
const { SETTING_GROUPS } = require('../config/settingsSchema');
const { ROLES } = require('../constants/userRoles');
const { ALL_LEDGER_TYPES, ALL_WALLET_STATUSES, LEDGER_DIRECTION } = require('../constants/finance');

/** Shapes for the admin API. Nothing here is trusted from the client. */

const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128)
  // Long enough is most of it, but an admin password of "aaaaaaaaaa" is not a
  // password, so a mix is required.
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required')
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: password
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(80)
});

// A date range that every list and chart endpoint shares.
const rangeSchema = {
  range: z.enum(['today', 'yesterday', 'last7', 'last30', 'month', 'custom']).default('today'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
};

const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25)
};

const dashboardQuery = z.object({
  ...rangeSchema,
  limit: z.coerce.number().int().min(1).max(200).optional()
});

const boolish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const dateWindow = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
};

const listCustomersQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  search: z.string().trim().min(1).max(80).optional(),
  isActive: boolish
});

const listRidersQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  search: z.string().trim().min(1).max(80).optional(),
  isOnline: boolish,
  isAvailable: boolish,
  isActive: boolish,
  // Every status is filterable, including GRANDFATHERED — an admin cannot SET
  // that one, but they do need to find the riders carrying it.
  verificationStatus: z.enum(ALL_VERIFICATION_STATUSES).optional()
});

const listRidesQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  status: z.enum([...Object.values(RIDE_STATUS), 'ACTIVE']).optional(),
  paymentStatus: z.enum(Object.values(PAYMENT_STATUS)).optional(),
  paymentMethod: z.enum(Object.values(PAYMENT_METHOD)).optional(),
  customerId: objectId.optional(),
  riderId: objectId.optional(),
  search: z.string().trim().min(1).max(80).optional()
});

const listPaymentsQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  status: z.enum(Object.values(PAYMENT_STATUS)).optional(),
  method: z.enum(Object.values(PAYMENT_METHOD)).optional(),
  customerId: objectId.optional(),
  riderId: objectId.optional(),
  search: z.string().trim().min(1).max(80).optional()
});

const listComplaintsQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  status: z.enum([...Object.values(COMPLAINT_STATUS), 'OPEN_ANY']).optional(),
  priority: z.enum(Object.values(COMPLAINT_PRIORITY)).optional(),
  category: z.string().trim().max(40).optional(),
  userRole: z.enum(Object.values(ROLES)).optional(),
  assignedAdmin: z.union([objectId, z.literal('UNASSIGNED')]).optional(),
  overdue: boolish,
  search: z.string().trim().min(1).max(80).optional()
});

const updateComplaintSchema = z
  .object({
    status: z.enum(Object.values(COMPLAINT_STATUS)).optional(),
    priority: z.enum(Object.values(COMPLAINT_PRIORITY)).optional(),
    // null unassigns; an id assigns.
    assignedAdmin: z.union([objectId, z.null()]).optional(),
    resolution: z.string().trim().max(2000).optional()
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const blockSchema = z.object({
  blocked: z.boolean(),
  reason: z.string().trim().max(300).optional()
});

const updateAccountSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: z.string().trim().regex(/^[0-9+\-\s()]{7,20}$/, 'Enter a valid phone number').optional()
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const reasonSchema = z.object({ reason: z.string().trim().max(300).optional() });
const noteSchema = z.object({ note: z.string().trim().min(1, 'Write the note').max(2000) });
const messageSchema = z.object({ message: z.string().trim().min(1, 'Write a reply').max(4000) });

// Settings are validated against the registry in the service, which knows each
// key's type and range. Here we only check it is a flat object of scalars or
// string arrays, so nothing structurally strange reaches it.
const pricingParamsSchema = z.object({
  serviceType: z.enum(ALL_SERVICE_TYPES)
});

/**
 * One service's four values. Every field optional so the screen can save just
 * the switch, but at least one has to be present — the controller refuses an
 * empty patch. Ranges are checked again by the settings registry, which is the
 * authority; these are the shape checks.
 */
const pricingPatchSchema = z
  .object({
    ratePerKm: z.coerce.number().min(0).max(500).optional(),
    enabled: z.coerce.boolean().optional(),
    minimumFare: z.coerce.number().min(0).max(5000).optional(),
    maximumFare: z.coerce.number().min(0).max(100000).optional()
  })
  .strict();

const settingsPatchSchema = z
  .record(z.union([z.number(), z.boolean(), z.string(), z.array(z.string())]))
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const settingsGroupParams = z.object({ group: z.enum(SETTING_GROUPS) });

const auditQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  adminId: objectId.optional(),
  resource: z.string().trim().max(40).optional(),
  action: z.string().trim().max(60).optional()
});

const notificationsQuery = z.object({
  ...paginationSchema,
  ...dateWindow,
  type: z.string().trim().max(40).optional(),
  userId: objectId.optional()
});

const broadcastSchema = z.object({
  audience: z.enum(['customers', 'riders', 'all']),
  title: z.string().trim().min(3).max(120),
  body: z.string().trim().min(3).max(500)
});

const permissionList = z.array(z.enum(ALL_PERMISSIONS)).max(ALL_PERMISSIONS.length).optional();

const createAdminSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password,
  role: z.enum(ALL_ADMIN_ROLES),
  extraPermissions: permissionList,
  deniedPermissions: permissionList
});

const updateAdminSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    role: z.enum(ALL_ADMIN_ROLES).optional(),
    isActive: z.boolean().optional(),
    extraPermissions: permissionList,
    deniedPermissions: permissionList
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const resetPasswordSchema = z.object({ newPassword: password });

const listAdminsQuery = z.object({
  ...paginationSchema,
  search: z.string().trim().min(1).max(80).optional(),
  role: z.enum(ALL_ADMIN_ROLES).optional(),
  isActive: boolish
});


// ------------------------------------------------------------------ finance

const balancesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(ALL_WALLET_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
  minOutstanding: z.coerce.number().min(0).optional()
});

const ledgerQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: z.enum(ALL_LEDGER_TYPES).optional(),
  riderId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

/**
 * A manual balance change.
 *
 * The reason is required here as well as in the service. Validating it at the
 * edge means a request without one is refused before any money is touched, and
 * the service keeps its own check because it is also reachable from a script.
 */
const adjustBalanceSchema = z.object({
  direction: z.enum([LEDGER_DIRECTION.CREDIT, LEDGER_DIRECTION.DEBIT]),
  amount: z.coerce.number().positive().max(1_000_000),
  reason: z.string().trim().min(4, 'Give a reason for this adjustment').max(300),
  note: z.string().trim().max(300).optional(),
  // One per submission, generated by the console when the dialog opens. A
  // retried request carries the same one and moves the balance once; a second
  // deliberate correction is a new dialog and a new key.
  idempotencyKey: z.string().trim().min(8).max(80).optional()
});

/**
 * Reversing a settled ride. A reason is mandatory for the same reason it is on
 * an adjustment: a refund that nobody has to explain is a silent financial
 * modification.
 */
const refundRideSchema = z.object({
  reason: z.string().trim().min(4, 'Give a reason for this refund').max(300),
  note: z.string().trim().max(300).optional()
});

/** Approving or refusing a rider. The reason is required on a refusal. */
const riderVerificationSchema = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED', 'PENDING']),
    note: z.string().trim().max(300).optional()
  })
  .refine((data) => data.status !== 'REJECTED' || (data.note && data.note.length >= 3), {
    message: 'Say why the rider was not approved — they are told this',
    path: ['note']
  });

module.exports = {
  riderVerificationSchema,
  loginSchema,
  changePasswordSchema,
  profileSchema,
  dashboardQuery,
  listCustomersQuery,
  listRidersQuery,
  listRidesQuery,
  listPaymentsQuery,
  listComplaintsQuery,
  updateComplaintSchema,
  blockSchema,
  updateAccountSchema,
  reasonSchema,
  noteSchema,
  messageSchema,
  settingsPatchSchema,
  pricingParamsSchema,
  pricingPatchSchema,
  settingsGroupParams,
  auditQuery,
  notificationsQuery,
  broadcastSchema,
  createAdminSchema,
  updateAdminSchema,
  resetPasswordSchema,
  listAdminsQuery
,
  balancesQuery,
  ledgerQuery,
  adjustBalanceSchema,
  refundRideSchema
};
