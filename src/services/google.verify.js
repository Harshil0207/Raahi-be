const { OAuth2Client } = require('google-auth-library');
const google = require('../config/google');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Turning a Google ID token into an identity we are willing to act on.
 *
 * THE FRONTEND CONTRIBUTES NOTHING BUT THE TOKEN. Not the email, not the name,
 * not the Google id, and certainly not the role. Everything this returns is
 * read out of a JWT that Google signed, after that signature has been checked
 * against Google's published keys. A caller can send any token they like; if
 * Google did not sign it for this application, it is refused.
 *
 * Verification is `google-auth-library`'s own `verifyIdToken`, which is the
 * official mechanism for this flow. It fetches and caches Google's certificates
 * and checks the signature, the expiry and the audience. The issuer and the
 * subject are checked here on top, because a library default is a thing that
 * can change and these two are what make the token Google's and about somebody.
 */

/** One client for the process; it caches Google's certificates internally. */
let client = null;
const oauth = () => {
  client = client || new OAuth2Client(google.clientId);
  return client;
};

/** For tests: swap in a double that implements `verifyIdToken`. */
function __setClient(replacement) {
  client = replacement;
}

/**
 * Verifies an ID token and returns the identity inside it.
 *
 * Throws an ApiError the customer can read. The underlying reason goes to the
 * log, never to the response — "invalid audience" tells an attacker which of
 * their guesses was closest, and tells a real user nothing they can act on.
 */
async function verifyIdToken(idToken) {
  if (!google.configured()) {
    throw ApiError.notImplemented('Google sign-in is not configured on this server.');
  }
  if (!idToken || typeof idToken !== 'string') {
    throw ApiError.badRequest('Google sign-in did not return a token');
  }

  let payload;
  try {
    const ticket = await oauth().verifyIdToken({
      idToken,
      // The audience check: a token minted for somebody else's application is
      // still a perfectly valid Google token, and must not be accepted here.
      audience: google.clientId
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn(`[Google] ID token rejected: ${err.message}`);
    throw ApiError.unauthorized('That Google sign-in could not be verified. Please try again.');
  }

  if (!payload) {
    throw ApiError.unauthorized('That Google sign-in could not be verified. Please try again.');
  }

  // Google issues under two spellings of the same issuer and uses both.
  if (!google.ISSUERS.includes(payload.iss)) {
    logger.warn(`[Google] ID token from unexpected issuer ${payload.iss}`);
    throw ApiError.unauthorized('That Google sign-in could not be verified. Please try again.');
  }

  // Belt and braces over the library's own expiry check, which is the one claim
  // whose absence would otherwise make a stolen token valid forever.
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) {
    throw ApiError.unauthorized('That Google sign-in has expired. Please try again.');
  }

  if (!payload.sub) {
    throw ApiError.unauthorized('That Google sign-in could not be verified. Please try again.');
  }

  /**
   * An unverified address is not an identity we will link an account to.
   *
   * This is the claim that stops account takeover. Linking on email means that
   * whoever controls an address controls the Raahi account on it — so the
   * address has to be one Google has actually verified, not merely one a Google
   * account has typed into a profile field.
   */
  if (!payload.email || payload.email_verified !== true) {
    throw ApiError.badRequest(
      'Your Google account does not have a verified email address, so it cannot be used to sign in.'
    );
  }

  return {
    providerId: String(payload.sub),
    email: String(payload.email).trim().toLowerCase(),
    emailVerified: true,
    name: (payload.name || '').trim() || null,
    // Deliberately not returned: picture, locale, hd, and the raw payload.
    // Nothing downstream needs them and every one of them is another field that
    // could end up in a log or a response.
    issuedAt: payload.iat || null
  };
}

module.exports = { verifyIdToken, __setClient };
