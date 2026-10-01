const crypto = require('crypto');
const User = require('../models/User');
const Rider = require('../models/Rider');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/userRoles');
const { RIDER_VERIFICATION } = require('../constants/riderVerification');
const { issueTokens, verifyRefreshToken } = require('../utils/generateToken');
const logger = require('../utils/logger');
const googleVerify = require('./google.verify');

const MAX_SESSIONS = 5;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function storeRefreshToken(userId, refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const user = await User.findById(userId).select('+refreshTokens');

  user.refreshTokens.push({ tokenHash });
  // Oldest sessions fall off rather than growing the document forever.
  if (user.refreshTokens.length > MAX_SESSIONS) {
    user.refreshTokens = user.refreshTokens.slice(-MAX_SESSIONS);
  }

  await user.save();
}

async function register(payload) {
  const { name, email, phone, password, role, vehicle, licence } = payload;

  const existing = await User.findOne({ $or: [{ email }, { phone }] });
  if (existing) {
    const field = existing.email === email.toLowerCase() ? 'email' : 'phone';
    throw ApiError.conflict(`An account with this ${field} already exists`);
  }

  if (role === ROLES.RIDER && (!vehicle || !licence)) {
    throw ApiError.badRequest('Vehicle and licence details are required to register as a rider');
  }

  const user = await User.create({ name, email, phone, password, role });

  let rider = null;
  if (role === ROLES.RIDER) {
    try {
      // Explicitly pending: identity is proved, the rider is not yet cleared.
      rider = await Rider.create({
        userId: user._id,
        vehicle,
        licence,
        verificationStatus: RIDER_VERIFICATION.PENDING
      });
    } catch (err) {
      // Without a rider profile the account is unusable, so don't leave it behind.
      await User.deleteOne({ _id: user._id });
      throw err;
    }
  }

  const tokens = issueTokens(user);
  await storeRefreshToken(user._id, tokens.refreshToken);

  return { user: user.toPublic(), rider: rider ? rider.toPublic() : null, ...tokens };
}

async function login({ email, password }) {
  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    /**
     * One message for both halves, deliberately.
     *
     * "No account with that email" and "wrong password" together are an account
     * enumeration oracle: anyone can discover who has a Raahi account by trying
     * addresses. The same sentence for both tells an attacker nothing and tells
     * a real user everything they can act on.
     *
     * The Google-only case is folded in here too. Saying "this account uses
     * Google" would confirm the address exists, so the hint belongs after a
     * successful Google sign-in, not before a failed password one.
     */
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.isActive) {
    throw ApiError.forbidden('This account has been deactivated');
  }

  return finishSignIn(user, 'password');
}

/**
 * Everything that happens once an identity is established, whichever way.
 *
 * Shared by the password path and the Google path on purpose: the brief asks
 * for one authentication mechanism rather than a second one bolted on for
 * Google users, and the way to guarantee that is for both to leave through the
 * same door. The tokens, the session cap, the rider lookup and the shape of the
 * response are therefore identical by construction, not by review.
 */
async function finishSignIn(user, provider) {
  const tokens = issueTokens(user);
  await storeRefreshToken(user._id, tokens.refreshToken);

  // Recorded for the account screen and for support. Never read by a decision,
  // so a wrong value here cannot let anybody in.
  await User.updateOne(
    { _id: user._id },
    { $set: { lastLoginAt: new Date(), lastLoginProvider: provider } }
  );

  const rider = user.role === ROLES.RIDER ? await Rider.findOne({ userId: user._id }) : null;

  return { user: user.toPublic(), rider: rider ? rider.toPublic() : null, ...tokens };
}

/**
 * Signing in with Google, and the account rules around it.
 *
 * The order of the three lookups is the whole design, and it is what stops a
 * second account being created for somebody who already has one:
 *
 *   1. By the Google subject id. This is the returning Google user. The id is
 *      stable for the life of their Google account and survives an email
 *      change, which is exactly why it is looked at before the address.
 *   2. By the verified email. This is the person who registered with a password
 *      and is now using the Google button on the same address. Their Google
 *      identity is LINKED to the account they already have — no new account,
 *      and no password required, because Google has just proved they control
 *      the address the account is registered to.
 *   3. Nothing found: a new account.
 *
 * ROLE IS NOT TAKEN FROM THE CLIENT for an existing account. A returning user
 * keeps the role they have; the requested role only matters when there is no
 * account yet, and even then it is constrained to the two self-service roles by
 * the validator. There is no path here by which a client's request body changes
 * what an existing account is allowed to do.
 */
async function signInWithGoogle({ idToken, role, phone } = {}) {
  const identity = await googleVerify.verifyIdToken(idToken);
  const providerKey = `google:${identity.providerId}`;

  // 1 — the returning Google user.
  const byProvider = await User.findOne({ 'authProviders.providerKey': providerKey });
  if (byProvider) {
    if (!byProvider.isActive) throw ApiError.forbidden('This account has been deactivated');
    return { ...(await finishSignIn(byProvider, 'google')), created: false, linked: false };
  }

  // 2 — an account already exists on this verified address.
  const byEmail = await User.findOne({ email: identity.email });
  if (byEmail) {
    if (!byEmail.isActive) throw ApiError.forbidden('This account has been deactivated');

    byEmail.authProviders.push({
      provider: 'google',
      providerId: identity.providerId,
      providerKey,
      email: identity.email
    });

    // Google verifying the address is the same fact our own verification email
    // would have established, so it counts.
    if (!byEmail.emailVerified) {
      byEmail.emailVerified = true;
      byEmail.emailVerifiedAt = new Date();
    }

    await byEmail.save();
    logger.info(`[Auth] Google identity linked to existing account ${byEmail._id}`);

    return { ...(await finishSignIn(byEmail, 'google')), created: false, linked: true };
  }

  // 3 — nobody here yet.
  return createFromGoogle(identity, { providerKey, role, phone });
}

/**
 * A brand-new account from a Google identity.
 *
 * Google gives us a name and a verified address and nothing else, so a phone
 * number is still needed — Raahi cannot dispatch a ride without one. The
 * account is created without it when none is supplied and the app collects it
 * during onboarding; what is NOT done is inventing a placeholder, because a
 * fabricated phone number is a number that belongs to somebody else.
 */
async function createFromGoogle(identity, { providerKey, role, phone }) {
  const chosenRole = role === ROLES.RIDER ? ROLES.RIDER : ROLES.CUSTOMER;

  if (phone) {
    const taken = await User.findOne({ phone });
    if (taken) {
      throw ApiError.conflict('That phone number is already registered to another account');
    }
  }

  try {
    const user = await User.create({
      name: identity.name || identity.email.split('@')[0],
      email: identity.email,
      phone: phone || null,
      // Explicitly no password. The model refuses to compare against an absent
      // one, so this account cannot be signed into with a password until its
      // owner sets it.
      passwordSet: false,
      role: chosenRole,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      authProviders: [
        { provider: 'google', providerId: identity.providerId, providerKey, email: identity.email }
      ]
    });

    logger.info(`[Auth] new ${chosenRole} account created from Google identity`);
    return { ...(await finishSignIn(user, 'google')), created: true, linked: false };
  } catch (err) {
    /**
     * Two sign-ins for the same new person, at the same moment.
     *
     * Both found nothing and both tried to insert; the unique index refused the
     * second. That is the database doing the job a pre-flight check cannot,
     * because both checks ran before either write. The loser reads the row the
     * winner just wrote and signs in against it, so the person gets one account
     * and no error.
     */
    if (err?.code === 11000) {
      const existing = await User.findOne({
        $or: [{ 'authProviders.providerKey': providerKey }, { email: identity.email }]
      });
      if (existing) {
        logger.info('[Auth] concurrent Google sign-in resolved to the account that won the insert');
        return { ...(await finishSignIn(existing, 'google')), created: false, linked: false };
      }
    }
    throw err;
  }
}

async function refresh(refreshToken) {
  if (!refreshToken) throw ApiError.unauthorized('Refresh token is missing');

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    throw ApiError.unauthorized('Refresh token is invalid or expired');
  }

  const user = await User.findById(decoded.sub).select('+refreshTokens');
  if (!user || !user.isActive) throw ApiError.unauthorized('Account is no longer active');

  const tokenHash = hashToken(refreshToken);
  const stored = user.refreshTokens.find((entry) => entry.tokenHash === tokenHash);
  if (!stored) throw ApiError.unauthorized('Refresh token has been revoked');

  // Rotate: the presented token is replaced so a leaked one cannot be reused.
  const tokens = issueTokens(user);
  user.refreshTokens = user.refreshTokens.filter((entry) => entry.tokenHash !== tokenHash);
  user.refreshTokens.push({ tokenHash: hashToken(tokens.refreshToken) });
  await user.save();

  return { user: user.toPublic(), ...tokens };
}

async function logout(userId, refreshToken) {
  if (!refreshToken) return;
  await User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { tokenHash: hashToken(refreshToken) } } }
  );
}

async function getCurrentUser(user) {
  const rider = user.role === ROLES.RIDER ? await Rider.findOne({ userId: user._id }) : null;
  return { user: user.toPublic(), rider: rider ? rider.toPublic() : null };
}

module.exports = { register, login, signInWithGoogle, refresh, logout, getCurrentUser };
