const crypto = require('crypto');
const env = require('./../config/env');

/**
 * The ride OTP is verified against a bcrypt hash, which cannot be reversed. The
 * customer still needs to see their own code after a refresh, so a second copy
 * is kept encrypted with AES-256-GCM: recoverable by the server, useless on its
 * own to anyone who only has the database.
 *
 * Only the customer who owns an active ride can ask for it; the rider never can.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let key;

function getKey() {
  if (key) return key;

  if (env.otp.encryptionKey) {
    const raw = Buffer.from(env.otp.encryptionKey, 'hex');
    if (raw.length !== 32) {
      throw new Error('OTP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    key = raw;
  } else {
    // Derived rather than random, so restarts can still read existing rides.
    key = crypto.scryptSync(env.jwt.accessSecret, 'hayabusa:otp', 32);
  }

  return key;
}

function encryptOtp(otp) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptOtp(payload) {
  if (!payload) return null;

  const [iv, tag, data] = String(payload).split('.');
  if (!iv || !tag || !data) return null;

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext — treat as unavailable rather than crash.
    return null;
  }
}

module.exports = { encryptOtp, decryptOtp };
