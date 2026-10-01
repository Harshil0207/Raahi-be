const Setting = require('../models/Setting');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { SETTINGS, SETTING_GROUPS, KEYS, keysInGroup, defaults } = require('../config/settingsSchema');
const { ALL_SERVICE_TYPES } = require('../constants/services');
const { CUSTOMER_CANCEL_REASONS, RIDER_CANCEL_REASONS } = require('../constants/cancellation');
const { RIDER_CATEGORIES, CUSTOMER_CATEGORIES } = require('../constants/ratings');

/**
 * Reads and writes platform configuration.
 *
 * Settings are read on nearly every ride, so they are held in memory and
 * refreshed on a short interval. Writes update the cache immediately, so an
 * admin sees their own change take effect at once; the interval only matters for
 * a second process that did not make the change.
 *
 * The cache is deliberately a plain object behind `get`/`load`. Swapping it for
 * Redis later means reimplementing those two functions and nothing else.
 */

const CACHE_TTL_MS = 30_000;

let cache = null;
let cachedAt = 0;
let loading = null;

function isStale() {
  return !cache || Date.now() - cachedAt > CACHE_TTL_MS;
}

async function readFromDb() {
  const rows = await Setting.find().lean();
  const byKey = new Map(rows.map((row) => [row.key, row]));

  // Defaults fill any gap, so a key added in a deploy works before it is seeded.
  const values = defaults();
  const meta = {};

  for (const key of KEYS) {
    const row = byKey.get(key);
    if (row && row.value !== undefined && row.value !== null) values[key] = row.value;
    meta[key] = row
      ? { updatedAt: row.updatedAt, updatedBy: row.updatedBy, seeded: false }
      : { updatedAt: null, updatedBy: null, seeded: true };
  }

  return { values, meta };
}

async function load({ force = false } = {}) {
  if (!force && !isStale()) return cache;

  // Concurrent callers share one read rather than stampeding the database.
  if (!loading) {
    loading = readFromDb()
      .then((fresh) => {
        cache = fresh;
        cachedAt = Date.now();
        return cache;
      })
      .catch((err) => {
        // A settings read must not take the platform down: fall back to defaults
        // and say so loudly, rather than throwing inside a ride request.
        logger.error(`Settings load failed, using defaults: ${err.message}`);
        if (!cache) cache = { values: defaults(), meta: {} };
        return cache;
      })
      .finally(() => {
        loading = null;
      });
  }

  return loading;
}

/** Warmed at boot so the first ride of the day does not wait on a query. */
async function init() {
  await load({ force: true });
  return cache.values;
}

/**
 * Synchronous read of one value. Callers on a request path have already been
 * through `load` (via init at boot, or an explicit await), so this never blocks.
 */
function get(key) {
  if (!(key in SETTINGS)) throw new Error(`Unknown setting: ${key}`);
  if (cache) return cache.values[key];
  return SETTINGS[key].default;
}

/** Several values at once, for a service that needs a whole group. */
function group(name) {
  return keysInGroup(name).reduce((acc, key) => {
    acc[key.slice(name.length + 1)] = get(key);
    return acc;
  }, {});
}

async function refresh() {
  return load({ force: true });
}

// ------------------------------------------------------------------ validation

function coerce(key, raw) {
  const def = SETTINGS[key];
  const fail = (message) => {
    throw ApiError.badRequest('Validation failed', [{ field: key, message }]);
  };

  if (def.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) fail('Must be a number');
    if (def.min !== undefined && value < def.min) fail(`Must be at least ${def.min}`);
    if (def.max !== undefined && value > def.max) fail(`Must be at most ${def.max}`);
    return value;
  }

  if (def.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fail('Must be true or false');
  }

  if (def.type === 'string') {
    if (typeof raw !== 'string') fail('Must be text');
    const value = raw.trim();
    if (def.maxLength && value.length > def.maxLength) fail(`Must be ${def.maxLength} characters or fewer`);
    if (def.required && !value) fail('Required');
    return value;
  }

  if (def.type === 'string[]') {
    if (!Array.isArray(raw)) fail('Must be a list');
    const value = raw.map((item) => String(item).trim().toUpperCase()).filter(Boolean);
    if (!value.length) fail('At least one entry is required');
    if (def.maxItems && value.length > def.maxItems) fail(`At most ${def.maxItems} entries`);
    if (new Set(value).size !== value.length) fail('Entries must be unique');
    return value;
  }

  return fail('Unsupported setting type');
}

/**
 * Cross-setting rules. A value can be individually valid and still leave the
 * platform in a state that cannot serve a ride, so these run after coercion on
 * the merged result rather than on the patch alone.
 */
function checkConsistency(values) {
  const problems = [];

  const min = values['fare.minimumFare'];
  const max = values['fare.maximumFare'];
  if (max > 0 && min > max) {
    problems.push({ field: 'fare.minimumFare', message: 'Minimum fare cannot exceed the maximum fare' });
  }

  // Every service off means nobody can book anything at all.
  const enabled = ALL_SERVICE_TYPES.filter((type) => values[`services.${type}.enabled`]);
  if (!enabled.length) {
    problems.push({
      field: `services.${ALL_SERVICE_TYPES[0]}.enabled`,
      message: 'At least one service must stay available, or no ride can be booked'
    });
  }

  // A floor above the cap would make every fare of that service impossible.
  for (const type of ALL_SERVICE_TYPES) {
    const floor = values[`services.${type}.minimumFare`];
    const cap = values[`services.${type}.maximumFare`];
    if (cap > 0 && floor > cap) {
      problems.push({
        field: `services.${type}.minimumFare`,
        message: 'Minimum fare cannot exceed the maximum fare'
      });
    }
  }

  // Arriving before being nearby is nonsense, and would mean a customer is told
  // their rider has arrived without ever being told they were close.
  if (values['tracking.arrivedMeters'] >= values['tracking.nearbyMeters']) {
    problems.push({
      field: 'tracking.arrivedMeters',
      message: 'The arrival distance must be smaller than the nearby distance'
    });
  }

  if (!values['payment.cashEnabled'] && !values['payment.upiEnabled']) {
    problems.push({
      field: 'payment.cashEnabled',
      message: 'At least one payment method must stay enabled, or no ride can be paid for'
    });
  }

  // ------------------------------------------------------------- finance
  //
  // Required here rather than at the top of the file: the payments module reads
  // settings, so a module-level require would be circular.
  // eslint-disable-next-line global-require
  const { PROVIDER_IDS } = require('./payments');

  const provider = String(values['finance.paymentProvider'] || '').toLowerCase();
  if (!PROVIDER_IDS.includes(provider)) {
    problems.push({
      field: 'finance.paymentProvider',
      message: `Not a provider this build knows about. Available: ${PROVIDER_IDS.join(', ')}`
    });
  }

  // Turning UPI on with nothing behind it would show customers a payment option
  // that refuses every time they pick it.
  if (values['payment.upiEnabled'] && provider === 'none') {
    problems.push({
      field: 'payment.upiEnabled',
      message: 'Choose a payment provider before enabling UPI, or customers will be offered a method that cannot collect'
    });
  }

  // A ceiling of zero plus a commission means the first cash ride a rider takes
  // puts them over it and takes them off the road. Almost always a mistake, and
  // an expensive one to discover through a support queue.
  if (
    values['payment.cashEnabled'] &&
    values['finance.platformCommissionPercent'] > 0 &&
    values['finance.maxOutstandingBalance'] === 0
  ) {
    problems.push({
      field: 'finance.maxOutstandingBalance',
      message:
        'With cash enabled and a commission above 0%, a ceiling of 0 blocks every rider after their first cash ride'
    });
  }

  for (const [key, listKey] of [
    ['support.autoUrgentCategories', 'support.customerComplaintCategories']
  ]) {
    const allowed = new Set([...values[listKey], ...values['support.riderComplaintCategories']]);
    const unknown = values[key].filter((c) => !allowed.has(c));
    if (unknown.length) {
      problems.push({ field: key, message: `Not a complaint category: ${unknown.join(', ')}` });
    }
  }

  if (problems.length) throw ApiError.badRequest('Validation failed', problems);
}

// --------------------------------------------------------------------- writing

/**
 * Applies a patch to one group and returns what actually changed.
 *
 * Only keys belonging to the group are accepted, so a request that targets
 * `/settings/fare` cannot reach `system.maintenanceMode`. Unchanged values are
 * dropped, which keeps the audit log free of no-op entries.
 */
async function updateGroup(groupName, patch, admin) {
  if (!SETTING_GROUPS.includes(groupName)) throw ApiError.notFound('Unknown settings group');

  const allowed = keysInGroup(groupName);
  const unknown = Object.keys(patch).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw ApiError.badRequest('Validation failed', unknown.map((key) => ({
      field: key,
      message: `Not a setting in the ${groupName} group`
    })));
  }

  await load();

  const coerced = {};
  for (const [key, raw] of Object.entries(patch)) coerced[key] = coerce(key, raw);

  checkConsistency({ ...cache.values, ...coerced });

  const changes = [];
  for (const [key, value] of Object.entries(coerced)) {
    const before = cache.values[key];
    if (JSON.stringify(before) === JSON.stringify(value)) continue;

    await Setting.findOneAndUpdate(
      { key },
      { key, group: groupName, value, updatedBy: admin?._id || null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    changes.push({ key, from: before, to: value });
  }

  if (changes.length) await refresh();

  return changes;
}

/** Writes the registry defaults for anything not yet stored. Idempotent. */
async function seed() {
  const existing = new Set((await Setting.find().select('key').lean()).map((row) => row.key));
  const missing = KEYS.filter((key) => !existing.has(key));

  if (missing.length) {
    await Setting.insertMany(
      missing.map((key) => ({ key, group: SETTINGS[key].group, value: SETTINGS[key].default })),
      { ordered: false }
    );
    logger.info(`Seeded ${missing.length} platform setting(s)`);
  }

  await refresh();
  return missing;
}

/** Everything the admin settings screen needs: value, limits, and provenance. */
async function describeAll() {
  await load();

  return SETTING_GROUPS.map((groupName) => ({
    group: groupName,
    settings: keysInGroup(groupName).map((key) => {
      const def = SETTINGS[key];
      const meta = cache.meta[key] || {};
      return {
        key,
        value: cache.values[key],
        type: def.type,
        default: def.default,
        min: def.min,
        max: def.max,
        maxLength: def.maxLength,
        maxItems: def.maxItems,
        label: def.label,
        description: def.description,
        highImpact: Boolean(def.highImpact),
        updatedAt: meta.updatedAt || null,
        updatedBy: meta.updatedBy || null,
        isDefault: Boolean(meta.seeded) || JSON.stringify(cache.values[key]) === JSON.stringify(def.default)
      };
    })
  }));
}

/** The handful of values the customer and rider apps are allowed to know. */
async function publicSettings() {
  await load();

  return {
    platformName: get('system.platformName'),
    maintenanceMode: get('system.maintenanceMode'),
    maintenanceMessage: get('system.maintenanceMode') ? get('system.maintenanceMessage') : null,
    supportPhone: get('system.supportPhone') || null,
    supportEmail: get('system.supportEmail') || null,
    currency: get('fare.currency'),
    payment: {
      cashEnabled: get('payment.cashEnabled'),
      // Whether the app should offer UPI at all: the switch being on is not
      // enough if nothing is standing behind it to take the money.
      // eslint-disable-next-line global-require
      upiEnabled: require('./payments').upiAvailable()
    },
    // What the rider app needs to explain a block and size a recharge. These
    // are platform policy, not anybody's personal figures.
    finance: {
      maxOutstandingBalance: get('finance.maxOutstandingBalance'),
      minimumRecharge: get('finance.minimumRecharge'),
      warningPercent: get('finance.walletWarningPercent')
    },
    chat: {
      enabled: get('chat.rideChatEnabled'),
      maxMessageLength: get('chat.maxMessageLength')
    },
    ride: {
      // The rider app draws one box per digit, so it has to know how many
      // before the customer's code arrives.
      otpLength: get('ride.otpLength')
    },
    complaintCategories: {
      customer: get('support.customerComplaintCategories'),
      rider: get('support.riderComplaintCategories')
    },
    /**
     * Enough for each app to offer the right list and to warn honestly before
     * somebody taps cancel. The fees here are what the rules WOULD charge —
     * what is actually charged is worked out on this side from the ride's own
     * timestamps and comes back on the cancelled ride.
     */
    cancellation: {
      freeWindowSeconds: get('cancellation.freeWindowSeconds'),
      customerFee: get('cancellation.customerFee'),
      riderFee: get('cancellation.riderFee'),
      reasons: {
        customer: CUSTOMER_CANCEL_REASONS,
        rider: RIDER_CANCEL_REASONS
      }
    },
    ratingCategories: {
      rider: RIDER_CATEGORIES,
      customer: CUSTOMER_CATEGORIES
    },
    // The catalogue with today's rates. A service an admin has turned off is
    // absent rather than flagged, so the apps have nothing to decide.
    // Required here rather than at the top: the fare service reads settings, so
    // a module-level require would be circular.
    services: require('./fare.service').availableServices()
  };
}

module.exports = {
  init,
  get,
  group,
  refresh,
  seed,
  updateGroup,
  describeAll,
  publicSettings,
  // Exported for the validation tests. `updateGroup` needs a database to
  // persist, but the decision about whether a value is allowed at all does not,
  // and that is the decision worth testing.
  coerce,
  checkConsistency
};
