const env = require('../config/env');
const authService = require('../services/auth.service');
const googleConfig = require('../config/google');
const recovery = require('../services/accountRecovery.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/response');

const REFRESH_COOKIE = 'refreshToken';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: env.isProduction,
  path: '/api/v1/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000
};

// Mobile clients read the token from the body, web clients use the cookie.
const readRefreshToken = (req) => req.body?.refreshToken || req.cookies?.[REFRESH_COOKIE] || null;

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  return created(res, result, 'Account created');
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  return ok(res, result, 'Logged in');
});

/**
 * Signing in with Google.
 *
 * One endpoint for both halves, because from here they are the same event: a
 * verified identity either matches an account or does not. Which of those
 * happened is reported back as `created`/`linked` so the app can route a new
 * user to onboarding, not so it can decide anything about them.
 *
 * Same cookie, same tokens, same response shape as the password routes. There
 * is no second session mechanism for Google users.
 */
const google = asyncHandler(async (req, res) => {
  const result = await authService.signInWithGoogle(req.body);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  return ok(res, result, result.created ? 'Account created' : 'Logged in');
});

/**
 * Which sign-in methods this deployment offers.
 *
 * Public and unauthenticated, because the login screen needs it before anybody
 * is signed in. It carries the Google client id, which is public by design —
 * it identifies the application a token was minted for and is what the audience
 * check compares against. There is no client secret in this architecture to
 * withhold.
 */
const providers = asyncHandler(async (req, res) =>
  ok(res, { google: googleConfig.describe() })
);

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(readRefreshToken(req));
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  return ok(res, result, 'Token refreshed');
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.user._id, readRefreshToken(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  return ok(res, null, 'Logged out');
});

/**
 * Asking for a password reset link.
 *
 * One response, whatever happened. Whether an account exists, whether a link
 * was already sent a moment ago, and whether there is a mail provider at all
 * are all invisible from here — the first would let anyone enumerate Raahi's
 * users, and the other two would leak the first by their absence.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  await recovery.requestPasswordReset(req.body.email);
  return ok(res, null, "If an account exists for that address, we've sent recovery instructions.");
});

const resetPassword = asyncHandler(async (req, res) => {
  const result = await recovery.resetPassword(req.body);
  // Every session was dropped, including this one if there was one. They sign
  // in again with the new password, which is the point.
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  return ok(res, result, 'Password updated. Please sign in.');
});

const sendVerification = asyncHandler(async (req, res) => {
  const result = await recovery.sendVerification(req.user);
  return ok(
    res,
    result,
    result.deliversForReal
      ? 'Verification email sent'
      : 'Verification link generated — no mail provider is configured, so it was logged rather than sent.'
  );
});

const verifyEmail = asyncHandler(async (req, res) => {
  const result = await recovery.verifyEmail(req.body.token);
  return ok(res, result, 'Email verified');
});

const me = asyncHandler(async (req, res) => {
  const result = await authService.getCurrentUser(req.user);
  return ok(res, result);
});

module.exports = {
  register,
  login,
  google,
  providers,
  forgotPassword,
  resetPassword,
  sendVerification,
  verifyEmail,
  refresh,
  logout,
  me
};
