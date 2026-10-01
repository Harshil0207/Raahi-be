const env = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Sending email, or honestly declining to.
 *
 * Raahi has no mail provider wired in. Rather than pretend — a `sendMail` that
 * resolves and does nothing is how a password reset becomes a support ticket —
 * this is a small registry with the same shape as the payment providers, and a
 * default that refuses.
 *
 * WHAT `available` MEANS. It is the difference between "the mail went" and "we
 * returned 200". Every caller checks it, and the ones that cannot do their job
 * without delivery say so rather than claiming success. In development the
 * console provider prints the link so the flow is usable on a laptop; it
 * reports itself as a development stand-in and is refused outright when
 * NODE_ENV is production, because a production deployment that quietly logs
 * reset links to stdout is worse than one that fails loudly.
 */

class Mailer {
  constructor({ id, label, available, unavailableReason = null }) {
    this.id = id;
    this.label = label;
    this.available = available;
    this.unavailableReason = unavailableReason;
  }

  // eslint-disable-next-line no-unused-vars, class-methods-use-this
  async send(_message) {
    throw new Error('This mailer cannot send');
  }
}

/** The default: no provider, and no pretending otherwise. */
class NoMailer extends Mailer {
  constructor() {
    super({
      id: 'none',
      label: 'None',
      available: false,
      unavailableReason:
        'No email provider is configured, so Raahi cannot send verification or password-reset messages.'
    });
  }
}

/**
 * Development only. Writes the message where a developer will see it.
 *
 * Deliberately NOT called a mailer that works: `available` is true so the flow
 * can be walked end to end on a laptop, and every response that depends on it
 * says the message was logged rather than sent.
 */
class ConsoleMailer extends Mailer {
  constructor() {
    super({ id: 'console', label: 'Console (development only)', available: true });
    this.sent = [];
  }

  async send(message) {
    this.sent.push(message);
    logger.info(
      `[Mail] (development, not delivered) to=${message.to} subject=${message.subject}\n${message.text}`
    );
    return { delivered: false, logged: true };
  }
}

/**
 * Which mailer this deployment has.
 *
 * Resolved once. A real provider would be selected here by an env var and added
 * to this file; the shape it has to satisfy is `available` plus `send`.
 */
let active = null;

function mailer() {
  if (active) return active;

  // A provider would be chosen here, e.g. by MAIL_PROVIDER. There is none yet.
  active = env.isProduction ? new NoMailer() : new ConsoleMailer();
  return active;
}

/** For tests, and for a deployment that wires a real provider later. */
function __setMailer(replacement) {
  active = replacement;
}

const describe = () => {
  const current = mailer();
  return {
    id: current.id,
    label: current.label,
    available: current.available,
    unavailableReason: current.unavailableReason,
    // True only for the development stand-in, so nothing reports a logged
    // message as a delivered one.
    deliversForReal: current.available && current.id !== 'console'
  };
};

module.exports = { mailer, describe, __setMailer, Mailer, NoMailer, ConsoleMailer };
