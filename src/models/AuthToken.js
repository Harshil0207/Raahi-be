const mongoose = require('mongoose');

/**
 * A single-use token for proving something about an account out of band.
 *
 * Password resets and email verifications, in one collection because they are
 * the same object with a different purpose: a secret we sent to an address, a
 * deadline, and the fact of it having been used.
 *
 * ONLY THE HASH IS STORED. The token itself exists in the email and in the
 * user's URL bar and nowhere else, so a dump of this collection is a list of
 * digests rather than a list of working password-reset links. It is the same
 * reasoning as the refresh tokens on the user document, and the same SHA-256.
 *
 * `usedAt` rather than deletion, so a link that has already been followed can
 * be told apart from one that never existed — the first deserves "this link has
 * already been used", the second deserves nothing at all.
 */
const TOKEN_TYPE = {
  PASSWORD_RESET: 'password_reset',
  EMAIL_VERIFY: 'email_verify'
};

const authTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(TOKEN_TYPE), required: true },
    tokenHash: { type: String, required: true },

    /**
     * The address it was sent to, at the time it was sent.
     *
     * A reset link stays bound to the address that asked for it. If the account
     * changes its email before the link is followed, the link is spent on an
     * address that is no longer the account's and must not work — otherwise a
     * stale link becomes a way in for whoever still controls the old inbox.
     */
    sentTo: { type: String, required: true, lowercase: true, trim: true },

    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

/**
 * The lookup every redemption does: find this exact secret, of this purpose.
 *
 * Unique, because two rows sharing a hash would mean one link redeeming two
 * tokens. Not partial or sparse: `tokenHash` is required, so every row has one.
 */
authTokenSchema.index({ tokenHash: 1, type: 1 }, { unique: true });

/**
 * Expired rows removed by the database rather than by a job nobody remembers.
 *
 * `expireAfterSeconds: 0` means "delete when `expiresAt` passes". Mongo's TTL
 * monitor runs about once a minute, so this is tidying, not enforcement — the
 * deadline is still checked when the token is redeemed.
 */
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Most recent first, for the resend cooldown. */
authTokenSchema.index({ userId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('AuthToken', authTokenSchema);
module.exports.TOKEN_TYPE = TOKEN_TYPE;
