const UserSettings = require('../models/UserSettings');
const ApiError = require('../utils/ApiError');
const {
  SETTINGS,
  MANDATORY_NOTIFICATIONS,
  groupsFor,
  keysInGroup,
  keysFor,
  defaultsFor
} = require('../config/userSettingsSchema');

/**
 * Reading and writing one person's own preferences.
 *
 * Two rules hold everything else up:
 *
 *   The role decides the keys. `groupsFor` and `keysInGroup` are derived from
 *   the caller's role on every call, so a customer asking for a rider's group
 *   is not refused by a check somebody remembered to write — there is simply
 *   nothing there to give them.
 *
 *   Defaults are resolved at read, never written. A document holds only what
 *   its owner actually chose. See the note on the model for why that is worth
 *   more than seeding a row per user.
 */

/** One value, as it will be stored, or a 400 naming the field and the problem. */
function coerce(key, raw) {
  const def = SETTINGS[key];
  const fail = (message) => {
    throw ApiError.badRequest('That setting could not be saved', [{ field: key, message }]);
  };

  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    // Strings are accepted because a form control and a JSON body disagree
    // about what a checkbox is; anything else is a caller getting it wrong.
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fail('Must be on or off');
  }

  if (def.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) fail('Must be a number');
    if (def.min !== undefined && value < def.min) fail(`Must be at least ${def.min}`);
    if (def.max !== undefined && value > def.max) fail(`Must be at most ${def.max}`);
    return value;
  }

  if (def.type === 'enum') {
    if (!def.values.includes(raw)) fail(`Must be one of: ${def.values.join(', ')}`);
    return raw;
  }

  // Unreachable while every declared setting is one of the three types above.
  // Here so that adding a fourth type to the registry and forgetting to handle
  // it fails loudly on the first write rather than storing something odd.
  return fail('This setting cannot be changed');
}

/** Everything this person has chosen, over the defaults for their role. */
async function settingsFor(user) {
  const stored = await UserSettings.findOne({ userId: user._id });
  const chosen = stored ? Object.fromEntries(stored.values) : {};

  const allowed = keysFor(user.role);
  const values = defaultsFor(user.role);

  for (const key of allowed) {
    // A key the registry no longer declares, or one belonging to the other
    // role, is ignored rather than served. A rider who used to be a customer
    // keeps their old rows harmlessly until they touch that setting again.
    if (key in chosen) values[key] = chosen[key];
  }

  return values;
}

/**
 * The shape the apps read: values, plus enough of the registry to render the
 * screen without a second source of truth in the frontend.
 *
 * The labels and descriptions travel with the values on purpose. The
 * alternative is the same wording typed into a React component, where it drifts
 * from what the backend actually enforces — a select offering a choice the
 * server rejects, or a description of a rule that changed a release ago.
 */
async function describeFor(user) {
  const values = await settingsFor(user);

  const groups = groupsFor(user.role).map((group) => ({
    group,
    settings: keysInGroup(group, user.role).map((key) => {
      const def = SETTINGS[key];
      return {
        key,
        type: def.type,
        value: values[key],
        default: def.default,
        label: def.label,
        description: def.description,
        ...(def.type === 'enum' ? { values: def.values } : {}),
        ...(def.type === 'number' ? { min: def.min, max: def.max } : {})
      };
    })
  }));

  return {
    values,
    groups,
    // So the apps can say "always on" rather than leaving a gap where a switch
    // would be, and so nobody builds one later without reading this.
    mandatoryNotifications: MANDATORY_NOTIFICATIONS
  };
}

/**
 * Applies a patch to one group.
 *
 * Scoped to a group rather than taking the whole document because that is how
 * the screen is laid out and how the brief's API reads — but the scoping is
 * also what makes a partial update safe: the keys allowed are computed from the
 * group and the role, so a rider cannot reach a customer key by naming a group
 * they do share, and nobody can reach a platform setting at all.
 *
 * Every key is checked before anything is written. A patch with one bad value
 * changes nothing, rather than applying the good half and reporting a failure.
 */
async function updateGroup(user, group, patch) {
  if (!groupsFor(user.role).includes(group)) {
    throw ApiError.notFound('No such settings section');
  }

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw ApiError.badRequest('Send the settings to change as an object');
  }

  const allowed = new Set(keysInGroup(group, user.role));
  const entries = Object.entries(patch);

  if (!entries.length) throw ApiError.badRequest('Nothing to change');

  const unknown = entries.filter(([key]) => !allowed.has(key)).map(([key]) => key);
  if (unknown.length) {
    throw ApiError.badRequest(
      'That setting could not be saved',
      // Named rather than silently dropped. A key going quietly missing is how
      // a frontend ships a switch that appears to work for a whole release.
      unknown.map((key) => ({ field: key, message: `Not a setting in ${group}` }))
    );
  }

  const coerced = {};
  for (const [key, raw] of entries) coerced[key] = coerce(key, raw);

  const $set = Object.fromEntries(Object.entries(coerced).map(([key, value]) => [`values.${key}`, value]));

  await UserSettings.findOneAndUpdate(
    { userId: user._id },
    { $set, $setOnInsert: { userId: user._id } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return describeFor(user);
}

/**
 * Whether a notification of this type should reach this person.
 *
 * Called on the delivery path, so it answers `true` when anything is wrong —
 * an unreadable settings document, a type nobody mapped, a user who no longer
 * exists. A preference that fails open costs somebody a notification they
 * asked not to have; one that fails closed loses the message telling them their
 * rider has arrived.
 */
async function wantsNotification(userId, type) {
  const key = NOTIFICATION_KEY_FOR_TYPE[type];
  if (!key) return true;

  try {
    const stored = await UserSettings.findOne({ userId }).select('values');
    if (!stored) return true;

    const value = stored.values.get(key);
    return value === undefined ? SETTINGS[key].default : value !== false;
  } catch {
    return true;
  }
}

/**
 * Which switch governs which notification type.
 *
 * A type that is absent here is always delivered, which is why the security and
 * account types are simply not listed — there is no key to turn them off with.
 * Several trip types share one switch because "ride updates" is how a person
 * thinks about them; splitting accepted, arrived and started into three would
 * be a longer screen describing the same decision.
 */
const NOTIFICATION_KEY_FOR_TYPE = {
  RIDE_ACCEPTED: 'notifications.rideUpdates',
  RIDER_NEARBY: 'notifications.rideUpdates',
  RIDER_ARRIVED: 'notifications.rideUpdates',
  TRIP_STARTED: 'notifications.rideUpdates',
  TRIP_COMPLETED: 'notifications.rideUpdates',
  RIDE_CANCELLED: 'notifications.rideCancelled',
  PAYMENT_UPDATED: 'notifications.payment',
  SUPPORT: 'notifications.support'
};

module.exports = {
  settingsFor,
  describeFor,
  updateGroup,
  wantsNotification,
  NOTIFICATION_KEY_FOR_TYPE,
  // Exported for tests: the validation is the part worth checking directly.
  coerce
};
