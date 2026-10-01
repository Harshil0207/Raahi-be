const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * Runs a unit of financial work in a MongoDB transaction where the deployment
 * supports one, and without a session where it does not.
 *
 * Transactions need a replica set or a sharded cluster. A single `mongod` — a
 * laptop, a small self-hosted install — cannot start one, and the driver says
 * so with a specific error rather than degrading. Two ways to handle that: make
 * transactions mandatory and refuse to run on a standalone, or run without one
 * and make sure the work is safe anyway.
 *
 * This takes the second path, and what it buys is bounded rather than total.
 * Every posting carries an idempotency key with a unique index behind it, and
 * the balance moves by `$inc` rather than read-modify-write, so concurrent
 * posts cannot lose each other and a repeat cannot double a debt. What it does
 * NOT survive is a crash between the increment and its ledger row: the balance
 * moves, no row records it, and the retry increments again. `reconcile`
 * recomputes from the rows and repairs exactly that. A replica set closes the
 * window outright, and production should have one.
 *
 * The fallback is logged loudly, and it is re-probed rather than latched for
 * the lifetime of the process — see below for why that matters.
 */

// null until the first attempt tells us.
let supported = null;

// When to try a session again after deciding we cannot have one.
let probeAfter = 0;
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The driver's own words for "this deployment has no transactions".
 *
 * Deliberately narrow. This used to also match a bare `IllegalOperation` and any
 * `code === 20`, and it was applied to every error that escaped the transaction
 * — including errors thrown by the financial work itself. One unrelated failure
 * during an election was enough to take a correctly configured replica set and
 * run it without transactions until someone restarted the process, with a single
 * warning line as the only trace.
 */
const UNSUPPORTED =
  /Transaction numbers are only allowed on a replica set member or mongos|Transactions are not supported/i;

const isUnsupported = (err) => UNSUPPORTED.test(err?.message || '');

/** A session that cannot even be opened is a different, unambiguous failure. */
const cannotOpenSession = (err) =>
  err?.code === 20 || err?.codeName === 'IllegalOperation' || isUnsupported(err);

function standDown(reason) {
  supported = false;
  probeAfter = Date.now() + PROBE_INTERVAL_MS;
  logger.warn(
    `MongoDB transactions are unavailable (${reason}); financial writes will rely on idempotency keys and atomic updates instead, and a crash mid-posting will need reconciling. A replica set is recommended in production.`
  );
}

/**
 * @param {(session|null) => Promise<any>} work  receives the session, or null
 *   when the deployment cannot give one. Pass it to every write inside.
 */
async function withTransaction(work) {
  // A standalone deployment is re-probed occasionally rather than written off:
  // the cost is one failed session every few minutes, and the payoff is that a
  // deployment which regains its replica set starts using transactions again
  // without anyone noticing it had stopped.
  if (supported === false && Date.now() < probeAfter) return work(null);

  let session;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    if (!cannotOpenSession(err)) throw err;
    standDown('no session could be started');
    return work(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    supported = true;
    probeAfter = 0;
    return result;
  } catch (err) {
    if (isUnsupported(err)) {
      standDown('the deployment reports no transaction support');
      return work(null);
    }
    // Anything else belongs to the caller. Re-running the work without a
    // session because a financial rule was violated would be the worst possible
    // reading of this error.
    throw err;
  } finally {
    await session.endSession().catch(() => {});
  }
}

/** For the health endpoint and the admin console: which mode are we in. */
const transactionsSupported = () => supported;

/** Test seam. */
const resetTransactionSupport = () => {
  supported = null;
  probeAfter = 0;
};

module.exports = {
  withTransaction,
  transactionsSupported,
  resetTransactionSupport,
  // Test seam. This predicate decides whether an error means "this deployment
  // has no transactions" or "your financial work failed", and getting it wrong
  // in the second direction silently drops the guarantee for the whole process.
  isUnsupported
};
