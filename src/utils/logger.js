const stamp = () => new Date().toISOString();

/**
 * Whether the lifecycle traces below are printed.
 *
 * On outside production, and switchable either way with RIDE_DEBUG — so the
 * ride/offer lifecycle can be followed on a deployed environment when
 * something needs diagnosing, without redeploying, and without a per-ride log
 * line in normal production output.
 *
 * Read lazily rather than captured at require time: `logger` is required by
 * almost everything, often before dotenv has run.
 */
const debugEnabled = () => {
  const flag = (process.env.RIDE_DEBUG || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  return (process.env.NODE_ENV || 'development') !== 'production';
};

const logger = {
  info: (...args) => console.log(stamp(), '[info]', ...args),
  warn: (...args) => console.warn(stamp(), '[warn]', ...args),
  error: (...args) => console.error(stamp(), '[error]', ...args),

  /**
   * A step in a lifecycle worth following end to end.
   *
   * Used for the ride request flow — created, dispatched, expired, asked
   * again, accepted — where the thing you need in order to debug a report like
   * "asking again does nothing" is the sequence of ids and rounds, not any one
   * error. Silent in production unless RIDE_DEBUG is set.
   */
  debug: (...args) => {
    if (debugEnabled()) console.log(stamp(), '[debug]', ...args);
  }
};

module.exports = logger;
