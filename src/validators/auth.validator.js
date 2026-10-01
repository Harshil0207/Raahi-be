const { z } = require('zod');
const { ALL_ROLES, ROLES } = require('../constants/userRoles');

const vehicleSchema = z.object({
  type: z.enum(['bike', 'auto', 'car']),
  make: z.string().trim().optional(),
  model: z.string().trim().optional(),
  numberPlate: z.string().trim().min(4, 'Number plate looks too short'),
  color: z.string().trim().optional()
});

const licenceSchema = z.object({
  number: z.string().trim().min(5, 'Licence number looks too short'),
  expiresAt: z.coerce.date().optional()
});

/**
 * What a Raahi account's password has to be.
 *
 * The admin console has had a rule like this from the start; customers and
 * riders were held to "at least 8 characters", which lets through `password`
 * and `12345678`. The mix is the part that matters — length alone is satisfied
 * by `aaaaaaaa`.
 *
 * Shared by registration and by the reset flow deliberately: a reset that
 * accepted a weaker password than registration would be the way around the
 * rule, and it is the flow somebody uses when their account has just been
 * compromised.
 *
 * Existing passwords are untouched. They are already hashed, nothing here
 * re-checks them, and forcing a reset on every user to satisfy a new rule is a
 * bigger harm than the rule prevents.
 */
const userPassword = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'That password is too long')
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number')
  .regex(/[^A-Za-z0-9]/, 'Include a symbol');

const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required'),
    email: z.string().trim().email('A valid email is required'),
    phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'A valid phone number is required'),
    password: userPassword,
    role: z.enum(ALL_ROLES).default(ROLES.CUSTOMER),
    vehicle: vehicleSchema.optional(),
    licence: licenceSchema.optional()
  })
  .refine((data) => data.role !== ROLES.RIDER || (data.vehicle && data.licence), {
    message: 'Riders must provide vehicle and licence details',
    path: ['vehicle']
  });

const loginSchema = z.object({
  email: z.string().trim().email('A valid email is required'),
  password: z.string().min(1, 'Password is required')
});

/**
 * What a Google sign-in may send.
 *
 * The token, and two things about an account that does not exist yet. Note
 * what is absent: email, name and Google id. Those come out of the token Google
 * signed, and accepting them here would be the "trust the frontend" the brief
 * rules out — a caller could sign in as anybody by typing their address.
 *
 * `role` is constrained to the two self-service roles. Admins are a separate
 * model with a separate login, so there is no string a client can send that
 * makes one.
 */
const googleSchema = z.object({
  idToken: z.string().min(20, 'Google sign-in did not return a token'),
  role: z.enum(ALL_ROLES).optional(),
  // Offered during onboarding when a new Google account has no number yet.
  phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'A valid phone number is required').optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional()
});

/** Asking for a reset link. Deliberately accepts anything email-shaped. */
const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address')
});

const resetPasswordSchema = z.object({
  token: z.string().min(10, 'This reset link is invalid'),
  password: userPassword
});

const verifyEmailSchema = z.object({
  token: z.string().min(10, 'This verification link is invalid')
});

module.exports = {
  vehicleSchema,
  licenceSchema,
  registerSchema,
  loginSchema,
  googleSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  userPassword
};
