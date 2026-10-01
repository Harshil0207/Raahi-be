const env = require('../../config/env');
const logger = require('../../utils/logger');
const settings = require('../settings.service');
const NoneProvider = require('./none.provider');
const SandboxProvider = require('./sandbox.provider');
const { PhonePeProvider } = require('./phonepe.provider');

/**
 * Which gateway is collecting money, resolved from platform settings.
 *
 * Providers are built lazily and cached, because constructing one may read the
 * environment or open a client, and because `none` — the default — should cost
 * nothing at all. The cache is keyed by provider id, so an admin switching
 * provider takes effect on the next call without a restart.
 *
 * Adding a real gateway is: write `<name>.provider.js` extending
 * PaymentProvider, add it to FACTORIES, ship its keys in the environment. No
 * other file changes, which is the entire point.
 */

const FACTORIES = {
  none: () => new NoneProvider(),
  sandbox: () => new SandboxProvider(),
  phonepe: () => new PhonePeProvider()
  // razorpay: () => new RazorpayProvider(),
  // cashfree: () => new CashfreeProvider(),
};

const PROVIDER_IDS = Object.keys(FACTORIES);

const cache = new Map();

function build(id) {
  const factory = FACTORIES[id];
  if (!factory) return null;

  try {
    return factory();
  } catch (err) {
    // A provider that refuses to construct — the sandbox in production, a
    // gateway missing its keys — must not take the process down or, worse,
    // silently collect nothing. Fall back to refusing UPI outright and say so.
    logger.error(`Payment provider "${id}" could not start: ${err.message}. Falling back to none.`);
    return null;
  }
}

/** The provider in force right now. Never null. */
function active() {
  const id = String(settings.get('finance.paymentProvider') || 'none').toLowerCase();

  if (!cache.has(id)) cache.set(id, build(id));
  const provider = cache.get(id);

  if (provider) return provider;

  if (!cache.has('none')) cache.set('none', build('none'));
  return cache.get('none');
}

/**
 * Whether UPI can actually be collected, as opposed to merely being switched
 * on. Both halves have to be true: an admin enabled it, and something is
 * standing behind it to take the money.
 */
function upiAvailable() {
  return settings.get('payment.upiEnabled') === true && active().available;
}

/** What the admin console shows about the payment setup. No secrets. */
function describe() {
  const provider = active();

  return {
    id: provider.id,
    label: provider.label,
    available: provider.available,
    isProduction: provider.isProduction,
    unavailableReason: provider.unavailableReason,
    upiEnabled: settings.get('payment.upiEnabled') === true,
    upiCollectable: upiAvailable(),
    // Whether a payee is configured at all — not the address itself, which has
    // no business on an admin screen that does not need it.
    payeeConfigured: Boolean(env.payments.upi.vpa),
    known: PROVIDER_IDS
  };
}

/** Test seam: forget built providers so a settings change is picked up clean. */
const reset = () => cache.clear();

module.exports = { active, upiAvailable, describe, reset, PROVIDER_IDS };
