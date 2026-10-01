const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ALL_ROLES, ROLES } = require('../constants/userRoles');

const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    /**
     * Optional at the schema level, required by the registration validator.
     *
     * Google hands over a name and a verified address and nothing else, so an
     * account created that way has no phone number until its owner supplies one
     * during onboarding. The alternative — inventing a placeholder — would put a
     * number that belongs to a real stranger on somebody's account, and Raahi
     * dispatches rides to phone numbers.
     *
     * `unique` is declared as an index below rather than here, because a plain
     * unique index treats every phone-less account as colliding with every
     * other one on null.
     */
    phone: { type: String, trim: true, default: null },

    /**
     * Optional, because an account can now exist without one.
     *
     * A Google-only account has no password and must not be given a blank or
     * placeholder one — an empty string would hash to a real bcrypt digest that
     * an empty submitted password would then match. `comparePassword` refuses
     * outright when this is unset, and `login` does the same, so "no password"
     * can never become "any password".
     */
    password: { type: String, select: false },

    /**
     * Whether a password is set, as a readable field.
     *
     * `password` is `select: false`, so anything that reads it on an ordinarily
     * fetched user sees `undefined` and would conclude there is no password —
     * which is how a signed-in user would be told their own account has none.
     * This mirrors it, is maintained in one place below, and is safe to send.
     */
    passwordSet: { type: Boolean },
    role: { type: String, enum: ALL_ROLES, default: ROLES.CUSTOMER, index: true },
    isActive: { type: Boolean, default: true },

    /**
     * Every way this person can prove who they are, beyond a password.
     *
     * A list rather than a `googleId` column, so a second provider is a new
     * entry instead of a new column and a migration. `providerId` is Google's
     * `sub` claim — stable for the life of the account, and never the email,
     * which people change.
     *
     * Never sent to a client: `toPublic` reports only which providers are
     * linked, because the app needs to know whether to offer "set a password"
     * and nothing downstream has any use for the id itself.
     */
    authProviders: {
      type: [
        {
          _id: false,
          provider: { type: String, enum: ['google'], required: true },
          providerId: { type: String, required: true },

          /**
           * `provider:providerId`, which is what the unique index below is on.
           *
           * Indexing `providerId` alone would give a guarantee that holds only
           * while Google is the only provider — two providers could in
           * principle issue the same id string and the database would reject a
           * legitimate account. Namespacing it costs one derived field and
           * makes the constraint true regardless of what gets added later.
           */
          providerKey: { type: String, required: true },
          email: { type: String, lowercase: true, trim: true },
          linkedAt: { type: Date, default: Date.now }
        }
      ],
      default: []
    },

    /**
     * Whether the address has been proved, and by whom.
     *
     * Google's `email_verified` counts: Google has done the same check we would
     * have, for an address it issued or verified itself. A self-registered
     * account starts false and stays false until the emailed link is followed.
     */
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },

    // Kept for the account screen and for support, not used in any decision.
    lastLoginAt: { type: Date, default: null },
    lastLoginProvider: { type: String, default: null },

    // Scored by riders after a trip; see `customerRating` on the ride.
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },

    // Hashed refresh tokens, so logout can revoke a single device without
    // invalidating the others and a stolen database dump is not a session dump.
    refreshTokens: {
      type: [
        {
          _id: false,
          tokenHash: { type: String, required: true },
          createdAt: { type: Date, default: Date.now }
        }
      ],
      default: [],
      select: false
    }
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();

  // An account may legitimately have no password — a Google-only one. Hashing
  // an empty value would produce a real digest that an empty submitted password
  // matches, so the absence is preserved as an absence.
  if (!this.password) {
    this.passwordSet = false;
    return next();
  }

  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  this.passwordSet = true;
  next();
});

/**
 * The customer's own running average, kept the same way the rider's is: a sum
 * and a count rather than a stored mean, so one more score is an increment and
 * never a read-modify-write that two riders can race each other on.
 */
userSchema.virtual('rating').get(function rating() {
  return this.ratingCount ? Number((this.ratingSum / this.ratingCount).toFixed(2)) : null;
});

/**
 * Whether a plaintext password matches — and false when there is none to match.
 *
 * The guard is the point. `bcrypt.compare(anything, undefined)` rejects, but an
 * account whose password had been stored as `''` would hash to a valid digest
 * that an empty submitted password matches. Refusing here means a Google-only
 * account cannot be signed into with a password at all, by anyone, ever.
 */
userSchema.methods.comparePassword = async function comparePassword(plain) {
  if (!this.password || !plain) return false;
  return bcrypt.compare(plain, this.password);
};

/** Whether this account can be signed into with a password at all. */
/**
 * Whether this account can be signed into with a password.
 *
 * `undefined` reads as yes, and that is not a guess: `password` was `required`
 * before this field existed, so every account that predates it has one. A
 * default of `false` in the schema would have been applied when reading those
 * documents back and told every existing user their own account had no
 * password — so the field is deliberately left without one, and set explicitly
 * on both paths that create an account.
 */
/**
 * Whether there is enough here to use Raahi.
 *
 * A phone number is the one thing a ride cannot be dispatched without, and it
 * is the one thing Google does not supply — so this is what routes a new Google
 * account to "complete your profile" instead of to the home screen. It is
 * computed rather than stored, so it cannot fall out of step with the fields it
 * describes.
 */
userSchema.virtual('profileComplete').get(function profileComplete() {
  return Boolean(this.name && this.phone);
});

userSchema.methods.hasPassword = function hasPassword() {
  return this.passwordSet !== false;
};

userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    isActive: this.isActive,
    rating: this.rating,
    ratingCount: this.ratingCount,
    emailVerified: this.emailVerified,

    /**
     * What the app routes on after sign-in, so the decision is the server's.
     * A client that computed it from the fields it happened to receive would be
     * one field away from sending somebody to the wrong screen.
     */
    profileComplete: this.profileComplete,

    /**
     * WHICH providers are linked, never their ids.
     *
     * The app needs this to decide whether to offer "set a password" and to
     * show what the account is connected to. Google's subject id is an
     * identifier for this person at Google and has no business in a response
     * body, a log, or a client's memory.
     */
    linkedProviders: (this.authProviders || []).map((entry) => entry.provider),

    /**
     * Whether signing in with a password is possible for this account, so the
     * UI can tell a Google-only user why their password does not work rather
     * than showing them a generic failure.
     */
    hasPassword: this.passwordSet !== false,

    createdAt: this.createdAt
  };
};

/**
 * One account per external identity, enforced by the database.
 *
 * This is what makes "do not create a second account for an existing user" a
 * property rather than a hope. Two Google sign-ins arriving in the same
 * millisecond both find no account and both try to create one; the second
 * insert is refused here, and the service retries as a link. A check in
 * application code cannot do that, because both checks run before either write.
 *
 * PARTIAL, NOT SPARSE. A partial filter indexes only the documents that carry a
 * provider key. `sparse` would look equivalent and is not: it skips documents
 * where the path is MISSING, and every password-only account has the path
 * present-but-empty — so they would all collide with each other on null.
 */
userSchema.index(
  { 'authProviders.providerKey': 1 },
  { unique: true, partialFilterExpression: { 'authProviders.providerKey': { $type: 'string' } } }
);

/**
 * One account per phone number, among the accounts that have one.
 *
 * Partial for the same reason as above: an account created through Google has
 * no number yet, and a plain unique index would let exactly one such account
 * exist in the entire system before every subsequent one collided on null.
 */
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } }
);

module.exports = mongoose.model('User', userSchema);
