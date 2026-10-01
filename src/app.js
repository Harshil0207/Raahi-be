const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const routes = require('./routes');
const { apiLimiter } = require('./middleware/rateLimit.middleware');
const { notFound, errorHandler } = require('./middleware/error.middleware');
const { transactionsSupported } = require('./utils/withTransaction');

const app = express();

// Behind a load balancer this is what makes req.ip (and rate limiting) correct.
app.set('trust proxy', 1);

app.use(helmet());
/**
 * The customer/rider app and the admin console are separate origins, so both are
 * allowed. An explicit list rather than a reflected origin: with credentials on,
 * echoing back whatever Origin arrives would let any site call the API as the
 * signed-in user.
 */
/**
 * EVERY configured origin, not just the first.
 *
 * This read `env.frontendUrl`, which is only `frontendUrls[0]`, while `env.js`
 * documents the list as "what CORS and the socket handshake use". So a second
 * entry — the LAN address used for phone testing, an apex alongside a www, a
 * preview deployment — was parsed, trimmed, and then silently ignored, and the
 * refusal looked like a backend fault.
 *
 * `admin.url` stays in the list because the console may still be served from
 * its own origin in some deployments. Where it is served from the app itself it
 * is simply a duplicate, which `Set` removes.
 */
const allowedOrigins = [...new Set([...env.frontendUrls, env.admin.url].filter(Boolean))];

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all is a server-to-server or same-origin request.
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed'));
    },
    credentials: true
  })
);
/**
 * The gateway callback proves itself with a signature over the exact bytes it
 * sent, so those bytes have to survive parsing.
 *
 * This lived on the webhook route itself, which never ran: body-parser marks a
 * request parsed and the second `express.json` short-circuits, so `verify` was
 * skipped and the raw body was always undefined. A real gateway would have had
 * every callback rejected, and it would have looked like the gateway's fault.
 *
 * Kept only for that one path — holding a copy of every request body in memory
 * to serve a single endpoint is not a trade worth making.
 */
const WEBHOOK_PATH = '/api/v1/payments/webhook';

app.use(
  express.json({
    limit: '100kb',
    verify: (req, _res, buf) => {
      if ((req.originalUrl || req.url || '').startsWith(WEBHOOK_PATH)) req.rawBody = buf;
    }
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(env.isProduction ? 'combined' : 'dev'));

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'OK',
    data: {
      uptime: process.uptime(),
      // Whether financial writes are running in transactions. `null` means
      // nothing has needed one yet. Worth surfacing: running without them is a
      // real reduction in guarantee, and nobody should have to read logs to
      // find out which mode a deployment is in.
      transactions: transactionsSupported()
    }
  });
});

app.use('/api/v1', apiLimiter, routes);

// Order matters: unmatched routes become a 404 error, then everything funnels
// through the single error handler.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
