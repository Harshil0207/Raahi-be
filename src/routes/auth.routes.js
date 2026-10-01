const express = require('express');
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');
const {
  registerSchema,
  loginSchema,
  googleSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema
} = require('../validators/auth.validator');

const router = express.Router();

/**
 * Which sign-in methods this deployment offers.
 *
 * Unauthenticated and unthrottled: it is read once by the login screen before
 * anybody is signed in, and it carries nothing but a public client id.
 */
router.get('/providers', authController.providers);

router.post('/register', authLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), authController.login);

/**
 * Google sign-in.
 *
 * Behind the same rate limiter as the password routes. A Google ID token cannot
 * be brute-forced, but this endpoint creates accounts, and an unthrottled
 * account-creation endpoint is its own problem.
 */
router.post('/google', authLimiter, validate({ body: googleSchema }), authController.google);
router.post('/refresh', validate({ body: refreshSchema }), authController.refresh);
/**
 * Forgetting and proving.
 *
 * `forgot-password` and `reset-password` are public by necessity — somebody who
 * cannot sign in is the only person who needs them — and both sit behind the
 * auth limiter, which is what stops the first becoming a way to send somebody
 * a thousand emails and the second a way to grind through reset tokens.
 *
 * `resend-verification` is authenticated: only the account's owner may ask for
 * another link, and the link goes to the address on the account either way, so
 * there is nothing an attacker gains by being able to call it.
 */
router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  authController.resetPassword
);

router.post(
  '/verify-email',
  authLimiter,
  validate({ body: verifyEmailSchema }),
  authController.verifyEmail
);

router.post('/resend-verification', authenticate, authController.sendVerification);

router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);

module.exports = router;
