const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Admin sessions use their own signing key.
 *
 * A claim saying "this is an admin token" would be enough only if every
 * verifier remembered to check it. A separate secret makes the mistake
 * impossible instead: a customer token cannot verify against the admin key, and
 * an admin token cannot verify against the customer key, whatever the middleware
 * forgets to look at.
 *
 * `ADMIN_JWT_SECRET` should be set in production. Without it the key is derived
 * from the access secret, which still yields a distinct key rather than sharing
 * one, so the separation holds on a default install.
 */
const adminSecret =
  env.admin.jwtSecret || crypto.scryptSync(env.jwt.accessSecret, 'hayabusa:admin:jwt', 32).toString('hex');

function signAdminToken(admin) {
  return jwt.sign(
    { sub: String(admin._id), role: admin.role, ver: admin.tokenVersion, typ: 'admin' },
    adminSecret,
    { expiresIn: env.admin.sessionExpiresIn }
  );
}

function verifyAdminToken(token) {
  const decoded = jwt.verify(token, adminSecret);
  // Belt as well as braces: a token minted for anything else is refused even if
  // it somehow verified.
  if (decoded.typ !== 'admin') throw new Error('Not an admin token');
  return decoded;
}

module.exports = { signAdminToken, verifyAdminToken };
