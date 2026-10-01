const crypto = require('crypto');
const User = require('../models/User');
const AuthToken = require('../models/AuthToken');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const env = require('../config/env');
const { mailer, describe: describeMailer } = require('./mailer');

const { TOKEN_TYPE } = AuthToken;

/**
 * Forgetting a password, and proving an address.
 *
 * Two flows, one shape: mint a secret, store only its hash, email the secret,
 * and redeem it once before it expires.
 *
 * THE RESPONSES DO NOT SAY WHETHER AN ACCOUNT EXISTS. "No account with that
 * email" is an account-enumeration oracle — anyone can discover who is on Raahi
 * by trying addresses, and for a ride-hailing app that is a list of people and
 * their phone numbers waiting to be assembled. So the request endpoint answers
 * the same way whatever it found, and the work it does behind that answer
 * differs. This is also why the cooldown below is keyed on the account rather
 * than reported to the caller: a "wait 60 seconds" that only appears for real
 * addresses leaks exactly what the flat response was hiding.
 */

const RESET_TTL_MINUTES = 30;
const VERIFY_TTL_HOURS = 24;

/** How long before another message of the same kind may be requested. */
const RESEND_COOLDOWN_SECONDS = 60;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * A secret with enough entropy that guessing is not a strategy.
 *
 * 32 bytes, url-safe. It is never stored — only its digest is — so this is the
 * one moment it exists in this process.
 */
const mint = () => crypto.randomBytes(32).toString('base64url');

const frontendBase = () => env.frontendUrls[0] || 'http://localhost:3000';

/**
 * Whether a fresh token may be issued, without telling the caller either way.
 *
 * Returns false when one was issued moments ago. Prevents the resend button
 * from becoming a way to send somebody a hundred emails.
 */
async function withinCooldown(userId, type) {
  const recent = await AuthToken.findOne({ userId, type }).sort({ createdAt: -1 });
  if (!recent) return false;
  return Date.now() - new Date(recent.createdAt).getTime() < RESEND_COOLDOWN_SECONDS * 1000;
}

async function issue(user, type, ttlMs) {
  const token = mint();

  await AuthToken.create({
    userId: user._id,
    type,
    tokenHash: hash(token),
    sentTo: user.email,
    expiresAt: new Date(Date.now() + ttlMs)
  });

  return token;
}

// ------------------------------------------------------------ password reset

/**
 * Asks for a reset link.
 *
 * Always resolves, and always with the same message. What actually happened is
 * in the return value for the caller's own logging, never in the response.
 */
async function requestPasswordReset(email) {
  const normalised = String(email || '').trim().toLowerCase();
  const user = await User.findOne({ email: normalised });

  if (!user || !user.isActive) {
    logger.info('[Auth] password reset requested for an address with no active account');
    return { sent: false, reason: 'no-account' };
  }

  if (await withinCooldown(user._id, TOKEN_TYPE.PASSWORD_RESET)) {
    return { sent: false, reason: 'cooldown' };
  }

  const token = await issue(user, TOKEN_TYPE.PASSWORD_RESET, RESET_TTL_MINUTES * 60 * 1000);
  const link = `${frontendBase()}/reset-password?token=${encodeURIComponent(token)}`;

  const post = mailer();
  if (!post.available) {
    // The token exists and the link is valid; nothing carried it. Saying so in
    // the log is the only honest record, and the caller still gets the flat
    // response so this does not become an enumeration channel either.
    logger.warn('[Auth] password reset token issued but no mail provider is configured');
    return { sent: false, reason: 'no-mailer' };
  }

  await post.send({
    to: user.email,
    subject: 'Reset your Raahi password',
    text:
      `Someone asked to reset the password for your Raahi account.\n\n${link}\n\n` +
      `This link works once and expires in ${RESET_TTL_MINUTES} minutes. ` +
      'If it was not you, you can ignore this message — nothing has changed.'
  });

  return { sent: true, reason: null };
}

/**
 * Redeems a reset link and sets the new password.
 *
 * Every other session is dropped. A password reset is what somebody does when
 * they think their account is compromised, and leaving the intruder's refresh
 * tokens valid would make the reset cosmetic.
 */
async function resetPassword({ token, password }) {
  const record = await AuthToken.findOne({
    tokenHash: hash(String(token || '')),
    type: TOKEN_TYPE.PASSWORD_RESET
  });

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.');
  }

  const user = await User.findById(record.userId).select('+password +refreshTokens');
  if (!user || !user.isActive) {
    throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.');
  }

  // The link is bound to the address it was sent to. If the account's email has
  // changed since, whoever still holds the old inbox must not get in.
  if (user.email !== record.sentTo) {
    throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.');
  }

  user.password = password;
  user.refreshTokens = [];
  await user.save();

  record.usedAt = new Date();
  await record.save();

  // Any other outstanding reset link is now stale too.
  await AuthToken.deleteMany({
    userId: user._id,
    type: TOKEN_TYPE.PASSWORD_RESET,
    usedAt: null
  });

  logger.info(`[Auth] password reset completed for ${user._id}; other sessions revoked`);
  return { user: user.toPublic() };
}

// -------------------------------------------------------- email verification

/**
 * Sends (or resends) a verification link.
 *
 * Called with the signed-in user, so there is nothing to hide here — the caller
 * already knows the account exists. The cooldown IS reported in this direction,
 * because the person waiting for it is the account's owner.
 */
async function sendVerification(user) {
  if (user.emailVerified) {
    throw ApiError.conflict('This address is already verified');
  }

  if (await withinCooldown(user._id, TOKEN_TYPE.EMAIL_VERIFY)) {
    throw new ApiError(
      429,
      `Please wait ${RESEND_COOLDOWN_SECONDS} seconds before asking for another verification email.`
    );
  }

  const token = await issue(user, TOKEN_TYPE.EMAIL_VERIFY, VERIFY_TTL_HOURS * 60 * 60 * 1000);
  const link = `${frontendBase()}/verify-email?token=${encodeURIComponent(token)}`;

  const post = mailer();
  if (!post.available) {
    throw ApiError.notImplemented(post.unavailableReason);
  }

  await post.send({
    to: user.email,
    subject: 'Confirm your Raahi email address',
    text: `Confirm your email address to finish setting up Raahi.\n\n${link}\n\nThis link expires in ${VERIFY_TTL_HOURS} hours.`
  });

  return { sent: true, deliversForReal: describeMailer().deliversForReal };
}

async function verifyEmail(token) {
  const record = await AuthToken.findOne({
    tokenHash: hash(String(token || '')),
    type: TOKEN_TYPE.EMAIL_VERIFY
  });

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('This verification link is invalid or has expired.');
  }

  const user = await User.findById(record.userId);
  if (!user || !user.isActive) {
    throw ApiError.badRequest('This verification link is invalid or has expired.');
  }

  // Verifying proves control of the address the link went to, not of whatever
  // the account's address is now.
  if (user.email !== record.sentTo) {
    throw ApiError.badRequest('This verification link is invalid or has expired.');
  }

  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  await user.save();

  record.usedAt = new Date();
  await record.save();

  return { user: user.toPublic() };
}

module.exports = {
  requestPasswordReset,
  resetPassword,
  sendVerification,
  verifyEmail,
  RESET_TTL_MINUTES,
  VERIFY_TTL_HOURS,
  RESEND_COOLDOWN_SECONDS
};
