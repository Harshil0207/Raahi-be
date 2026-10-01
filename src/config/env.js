const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const required = ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 5000),
  /**
   * Every origin the customer/rider app is served from.
   *
   * A list rather than one value, because testing on a phone means the app is
   * reached at a LAN address as well as at localhost, and CORS and the socket
   * handshake both have to allow each one. Set it as a comma-separated list:
   *
   *   FRONTEND_URL=http://localhost:3000,http://192.168.1.8:3000
   *
   * Spaces and trailing slashes are stripped. An `Origin` header never carries
   * either, so one stray space in the environment would otherwise be a silent
   * CORS refusal that looks like a backend fault.
   */
  frontendUrls: (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((url) => url.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  mongoUri: process.env.MONGODB_URI,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
  },

  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',

  maps: {
    // auto | google | osm — auto picks Google when a key is set, OSM otherwise.
    provider: (process.env.MAPS_PROVIDER || 'auto').toLowerCase(),
    nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    osrmUrl: process.env.OSRM_URL || 'https://router.project-osrm.org',
    // Nominatim's usage policy requires an identifying User-Agent.
    userAgent: process.env.MAPS_USER_AGENT || 'Raahi/1.0 (ride booking backend)'
  },

  fare: {
    perKm: num(process.env.FARE_PER_KM, 8),
    currency: process.env.FARE_CURRENCY || 'INR'
  },

  matching: {
    requestTimeoutSeconds: num(process.env.RIDE_REQUEST_TIMEOUT_SECONDS, 20),
    radiusKm: num(process.env.MATCHING_RADIUS_KM, 5),
    maxRiders: num(process.env.MAX_RIDERS_PER_REQUEST, 10)
  },

  otp: {
    maxAttempts: num(process.env.OTP_MAX_ATTEMPTS, 5),
    // 64 hex characters. Falls back to a key derived from the access secret so
    // the feature works without extra setup; set it explicitly in production.
    encryptionKey: process.env.OTP_ENCRYPTION_KEY || ''
  },

  location: {
    minUpdateIntervalMs: num(process.env.LOCATION_MIN_UPDATE_INTERVAL_MS, 3000)
  },

  /**
   * Payment collection.
   *
   * Everything secret about a gateway lives here, which means it lives in the
   * environment and never in MongoDB. Which provider is active is a platform
   * setting an admin can change; the credentials that provider needs are not,
   * because an admin console is the wrong place to hold a signing key.
   *
   * The payee details are not secret — a VPA is printed on a QR code for
   * strangers to scan — but they belong beside the keys rather than in the
   * database, so a deployment is configured in one place.
   */
  payments: {
    upi: {
      vpa: process.env.UPI_PAYEE_VPA || '',
      payeeName: process.env.UPI_PAYEE_NAME || '',
      // Some PSPs require their own merchant code on the intent string.
      merchantCode: process.env.UPI_MERCHANT_CODE || ''
    },
    gateway: {
      keyId: process.env.PAYMENT_GATEWAY_KEY_ID || '',
      keySecret: process.env.PAYMENT_GATEWAY_KEY_SECRET || '',
      webhookSecret: process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET || '',
      baseUrl: process.env.PAYMENT_GATEWAY_BASE_URL || ''
    }

    // PhonePe's own credentials are read in `config/phonepe.js` rather than
    // here, because they are one provider's and this block is every
    // provider's. Nothing about them differs in how it is treated: environment
    // only, never MongoDB, never an API response.
  },

  /**
   * The AI assistant.
   *
   * The key lives here and nowhere else. It is never read by the frontend
   * build, never written to MongoDB, and never returned by any endpoint — the
   * browser talks to our own API, and only this process talks to Google. An
   * empty key is a supported state: the assistant reports itself unavailable
   * and the rest of the platform is unaffected.
   */
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // `-latest` rather than a pinned version, so the deployment does not stop
    // working the day a specific model is retired. Pin it here if a particular
    // model's behaviour is being relied on.
    /**
     * A PINNED model, never a `-latest` alias.
     *
     * This defaulted to `gemini-flash-latest`, which is what the SDK's own
     * quickstart shows. That alias resolved to `gemini-2.0-flash`, Google
     * retired that model, and the alias was never repointed — so every request
     * came back 404 NOT_FOUND. An alias is a name Google may quietly stop
     * honouring, and the failure arrives at runtime as a generic outage rather
     * than at configuration time as a mistake.
     *
     * Run `npm run assistant:check --list` to see the models this key can
     * actually use, and set GEMINI_MODEL to one of them.
     */
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    // A support answer that takes longer than this is no longer useful to
    // somebody standing on a pavement.
    timeoutMs: num(process.env.GEMINI_TIMEOUT_MS, 20000),
    maxOutputTokens: num(process.env.GEMINI_MAX_OUTPUT_TOKENS, 800),
    /**
     * Only for tests: points the SDK at a local server that speaks the Gemini
     * REST protocol, so the request shape, the streaming parser and the error
     * handling can be exercised without spending a real quota. Unset in every
     * real deployment, which is when the SDK uses Google's own endpoint.
     */
    baseUrl: process.env.GEMINI_BASE_URL || ''
  },

  admin: {
    // Separate signing key so an admin token and a customer token can never be
    // swapped. Falls back to a key derived from the access secret.
    jwtSecret: process.env.ADMIN_JWT_SECRET || '',
    sessionExpiresIn: process.env.ADMIN_SESSION_EXPIRES_IN || '8h',
    // The admin console runs on its own origin.
    /**
     * Trimmed and de-slashed, exactly like `frontendUrls` above.
     *
     * This value is compared against the browser's `Origin` header, which never
     * carries a trailing slash. Pasting a URL out of a browser bar or a Vercel
     * dashboard almost always brings one — `https://example.vercel.app/` — and
     * the comparison then fails for a reason nothing in the logs explains. The
     * frontend list has been normalised since it was written; this one was not.
     */
    url: (process.env.ADMIN_URL || 'https://raahi-fe-six.vercel.app/').trim().replace(/\/+$/, ''),
    // Used once, by `npm run admin:create`, to bootstrap the first super admin.
    seedEmail: process.env.ADMIN_SEED_EMAIL || '',
    seedPassword: process.env.ADMIN_SEED_PASSWORD || '',
    seedName: process.env.ADMIN_SEED_NAME || 'Super Admin'
  }
};

env.isProduction = env.nodeEnv === 'production';

// The primary origin, for anything that needs exactly one — a link in an email,
// a redirect. `frontendUrls` is what CORS and the socket handshake use.
env.frontendUrl = env.frontendUrls[0];

module.exports = env;
