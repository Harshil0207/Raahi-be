const env = require('./env');

/**
 * PhonePe credentials and endpoints.
 *
 * Everything here comes from the environment. Nothing PhonePe issues — the
 * client secret, the webhook password — is ever written to MongoDB, logged, or
 * returned by an API, including the admin API. Which provider is active is a
 * platform setting an admin can change; the keys that provider needs are not.
 *
 * SANDBOX BY DEFAULT. `PHONEPE_ENV` has to say `production` in so many letters
 * before this will talk to the live host. A missing or misspelt value is
 * sandbox, because the failure mode of guessing wrong in that direction is a
 * developer wondering why a test payment did not arrive, and in the other
 * direction it is somebody's actual money.
 *
 * ABOUT THE BASE URLS. PhonePe's own documentation disagrees with itself: the
 * API reference pages for authorization, create payment, order status and
 * refund all give the sandbox host as `api-preprod.phonepe.com/apis/pg-sandbox`,
 * while the UAT Sandbox page writes it without the hyphen. The four consistent
 * pages win here, and `PHONEPE_BASE_URL` / `PHONEPE_AUTH_BASE_URL` exist so
 * that if a particular account is served by the other spelling it is a line in
 * an env file rather than a code change. See docs/PHONEPE.md.
 */

const SANDBOX = {
  // Authorization and the payment APIs sit under the same sandbox host, and
  // under DIFFERENT hosts in production — which is exactly the kind of detail
  // that is easy to get wrong when switching, so both are named separately.
  auth: 'https://api-preprod.phonepe.com/apis/pg-sandbox',
  api: 'https://api-preprod.phonepe.com/apis/pg-sandbox'
};

const PRODUCTION = {
  auth: 'https://api.phonepe.com/apis/identity-manager',
  api: 'https://api.phonepe.com/apis/pg'
};

const mode = (process.env.PHONEPE_ENV || 'sandbox').trim().toLowerCase();
const isProduction = mode === 'production';

const hosts = isProduction ? PRODUCTION : SANDBOX;

const trimSlash = (url) => String(url || '').replace(/\/+$/, '');

const config = {
  mode: isProduction ? 'production' : 'sandbox',
  isProduction,

  merchantId: process.env.PHONEPE_MERCHANT_ID || '',
  clientId: process.env.PHONEPE_CLIENT_ID || '',
  clientSecret: process.env.PHONEPE_CLIENT_SECRET || '',
  // PhonePe issues this alongside the client id; it is not a version of our
  // code. Sent as a string because that is what the token endpoint expects.
  clientVersion: process.env.PHONEPE_CLIENT_VERSION || '',

  authBaseUrl: trimSlash(process.env.PHONEPE_AUTH_BASE_URL || hosts.auth),
  baseUrl: trimSlash(process.env.PHONEPE_BASE_URL || hosts.api),

  /**
   * Where PhonePe sends the customer back to after checkout.
   *
   * This is a return address, not a result. The page it lands on asks our own
   * backend what happened; nothing about the payment is decided by the customer
   * arriving at a URL, because anybody can visit a URL.
   */
  redirectUrl: process.env.PHONEPE_REDIRECT_URL || '',

  /**
   * The webhook credentials configured in the PhonePe dashboard.
   *
   * PhonePe hashes these as SHA256(username:password) and sends the result as
   * the callback's Authorization header. They are a shared secret and are
   * treated exactly like the client secret.
   */
  webhookUsername: process.env.PHONEPE_WEBHOOK_USERNAME || '',
  webhookPassword: process.env.PHONEPE_WEBHOOK_PASSWORD || '',

  /** How long a checkout stays payable. PhonePe allows 300–3600 seconds. */
  expireAfterSeconds: clamp(Number(process.env.PHONEPE_EXPIRE_AFTER_SECONDS) || 900, 300, 3600),

  /** How long to wait on a PhonePe call before giving up. */
  timeoutMs: clamp(Number(process.env.PHONEPE_TIMEOUT_MS) || 15000, 2000, 60000)
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * What is missing before payments can be taken, in words an operator can act on.
 *
 * Returns an array so the admin screen can list every gap at once rather than
 * making somebody fix one, retry, and discover the next.
 */
function missingConfig() {
  const gaps = [];

  if (!config.clientId) gaps.push('PHONEPE_CLIENT_ID');
  if (!config.clientSecret) gaps.push('PHONEPE_CLIENT_SECRET');
  if (!config.clientVersion) gaps.push('PHONEPE_CLIENT_VERSION');
  if (!config.redirectUrl) gaps.push('PHONEPE_REDIRECT_URL');

  return gaps;
}

/** Whether callbacks can be authenticated. Separate from being able to charge. */
const webhookConfigured = () => Boolean(config.webhookUsername && config.webhookPassword);

/**
 * The safe half of the configuration, for the admin screen and for logs.
 *
 * There is no code path that puts a secret in here. The client id is shown
 * truncated because an operator needs to tell two environments apart, not to
 * read the whole value back.
 */
function describe() {
  return {
    mode: config.mode,
    isProduction: config.isProduction,
    merchantId: config.merchantId || null,
    clientIdHint: config.clientId ? `${config.clientId.slice(0, 6)}…` : null,
    baseUrl: config.baseUrl,
    authBaseUrl: config.authBaseUrl,
    redirectUrl: config.redirectUrl || null,
    webhookConfigured: webhookConfigured(),
    expireAfterSeconds: config.expireAfterSeconds,
    missing: missingConfig()
  };
}

/**
 * A guard for anything that must never run against real money by accident.
 *
 * The app's own NODE_ENV and PhonePe's mode are separate facts, and the
 * combination that matters is a production deployment still pointed at the
 * sandbox — that takes payments that will never settle.
 */
const mismatchedEnvironment = () => env.isProduction && !config.isProduction;

module.exports = {
  ...config,
  SANDBOX,
  PRODUCTION,
  missingConfig,
  webhookConfigured,
  mismatchedEnvironment,
  describe
};
