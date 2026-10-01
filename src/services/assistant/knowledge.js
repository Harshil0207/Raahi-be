const settings = require('../settings.service');
const fareService = require('../fare.service');
const { ASSISTANT_ROLE } = require('../../constants/assistant');

/**
 * What the platform currently charges and how it currently behaves, written out
 * for the model to read.
 *
 * Every number here is read from the live settings service at the moment the
 * question is asked. None of it is written into the prompt as a literal, and
 * none of it is cached beyond the settings service's own thirty-second window.
 * That is the whole point of this file: an admin who changes the bike rate in
 * the console has changed what the assistant will quote on the next question,
 * without anybody touching a prompt.
 *
 * So there is exactly one rule to keep when editing this file: if a value can
 * be changed in the admin console, read it — do not type it.
 */

/**
 * A price, written the way the currency setting is written.
 *
 * `fare.currency` holds whatever an admin typed — it ships as the ISO code
 * `INR`, but it could equally be `₹`. A code needs a space after it and a
 * symbol does not, and "INR6 per km" is the kind of detail a model repeats back
 * to a customer verbatim.
 */
const money = (currency, amount) => {
  const value = Number(amount).toFixed(2).replace(/\.00$/, '');
  const separator = /^[A-Za-z]{2,}$/.test(String(currency)) ? ' ' : '';
  return `${currency}${separator}${value}`;
};

/** Bullet list of what can be booked today, at today's prices. */
function serviceLines(currency) {
  const services = fareService.availableServices();

  if (!services.length) {
    return ['- No services are currently available for booking.'];
  }

  return services.map((service) => {
    const parts = [`${money(currency, service.ratePerKm)} per km`];

    if (service.baseFare > 0) parts.push(`base fare ${money(currency, service.baseFare)}`);
    if (service.minimumFare > 0) parts.push(`minimum ${money(currency, service.minimumFare)}`);
    if (service.maximumFare > 0) parts.push(`capped at ${money(currency, service.maximumFare)}`);

    const price = service.free ? 'free of charge' : parts.join(', ');
    return `- ${service.label} (${service.bookingType.toLowerCase()}): ${price}. ${service.description}.`;
  });
}

/**
 * Facts every role may be told. Platform policy and pricing — nothing here
 * belongs to any particular person.
 */
function commonFacts() {
  const currency = settings.get('fare.currency');
  const lines = [];

  lines.push(`Platform name: ${settings.get('system.platformName')}`);
  lines.push(`Currency symbol: ${currency}`);

  lines.push('', 'Services available right now, with current prices:');
  lines.push(...serviceLines(currency));

  const cancellation = settings.get('fare.cancellationCharge');
  const waiting = settings.get('fare.waitingChargePerMinute');

  lines.push('', 'How a fare is worked out:');
  lines.push(
    `- distance in km x the per-km rate for the chosen service, plus that service's base fare if it has one, then lifted to the minimum fare and held at the maximum fare if those are set.`
  );
  if (waiting > 0) lines.push(`- waiting time is charged at ${money(currency, waiting)} per minute.`);
  lines.push(
    cancellation > 0
      ? `- cancelling after a rider has accepted costs ${money(currency, cancellation)}.`
      : '- there is no cancellation charge.'
  );
  lines.push('- the fare is quoted before booking and a booked ride keeps the price it was quoted at, even if an admin changes rates afterwards.');

  lines.push('', 'Requests and matching:');
  lines.push(`- a request is offered to nearby riders for ${settings.get('ride.requestTimeoutSeconds')} seconds.`);
  lines.push('- if nobody accepts in that window the request expires, and the customer can send it again.');
  lines.push(
    `- a customer can re-send an expired request up to ${settings.get('ride.maxReRequests')} time(s); each attempt is a fresh round offered to riders again.`
  );
  lines.push(`- riders are searched within ${settings.get('ride.matchingRadiusKm')} km of the pickup point.`);

  lines.push('', 'Starting a trip:');
  lines.push(
    `- the customer is given a ${settings.get('ride.otpLength')}-digit OTP. The rider must enter it before the trip can start, which is how the platform confirms the right person got in.`
  );
  lines.push(`- the code expires after ${settings.get('ride.otpExpiryMinutes')} minutes and allows ${settings.get('ride.otpMaxAttempts')} attempts.`);
  lines.push('- never tell anyone their OTP; the assistant is not given it.');

  const methods = [];
  if (settings.get('payment.cashEnabled')) methods.push('cash');
  // Whether UPI can actually collect, not just whether the switch is on.
  // eslint-disable-next-line global-require
  if (require('../payments').upiAvailable()) methods.push('UPI');

  lines.push('', 'Payment:');
  lines.push(methods.length ? `- accepted methods: ${methods.join(' and ')}.` : '- no payment method is currently available.');

  if (settings.get('system.maintenanceMode')) {
    lines.push('', `IMPORTANT: the platform is in maintenance mode right now. ${settings.get('system.maintenanceMessage')}`);
  }

  return lines;
}

/** Support routes, only where the admin has actually filled them in. */
function supportFacts() {
  const phone = settings.get('system.supportPhone');
  const email = settings.get('system.supportEmail');
  const lines = ['', 'Getting help from a person:'];

  lines.push('- the app has a built-in complaint system; a complaint raised there reaches the support team.');
  if (phone) lines.push(`- support phone: ${phone}`);
  if (email) lines.push(`- support email: ${email}`);
  if (!phone && !email) {
    lines.push('- no support phone or email is published; the in-app complaint system is the route.');
  }

  return lines;
}

function riderFacts() {
  const currency = settings.get('fare.currency');

  return [
    '',
    'Rider earnings and wallet policy:',
    `- the platform takes ${settings.get('finance.platformCommissionPercent')}% commission on each completed trip; the rider keeps the rest.`,
    `- when a customer pays cash, the rider has collected the platform's share too, so it is recorded as owed and shows as an outstanding balance.`,
    `- a rider can owe up to ${money(currency, settings.get('finance.maxOutstandingBalance'))}. Past that they cannot go online until they recharge.`,
    `- the smallest recharge is ${money(currency, settings.get('finance.minimumRecharge'))}.`,
    `- a warning appears once the balance reaches ${settings.get('finance.walletWarningPercent')}% of the limit.`,
    '',
    'Going online:',
    settings.get('rider.onlineRequiresLocation')
      ? '- location permission must be granted; the browser needs a secure origin (https, or localhost) to offer the prompt at all.'
      : '- location permission is not required to go online.',
    '- a rider is blocked from going online if they owe more than the limit, if their account is not approved, or if they are already on a trip.',
    `- riders may cancel at most ${settings.get('rider.cancellationsPerDay')} accepted ride(s) a day.`
  ];
}

function customerFacts() {
  return [
    '',
    'Customer limits:',
    `- at most ${settings.get('customer.maxActiveRides')} ride(s) can be active at once.`,
    `- at most ${settings.get('customer.cancellationsPerDay')} cancellation(s) a day.`,
    settings.get('customer.chargeCancellationAfterAccept')
      ? '- cancelling after a rider has accepted is charged.'
      : '- cancelling is not charged.'
  ];
}

function adminFacts() {
  const groups = [
    'fare (base rates, minimums, maximums, waiting and cancellation charges)',
    'services (per-service rate, availability, floor and cap)',
    'finance (platform commission, outstanding balance ceiling, minimum recharge, payment provider)',
    'ride (request timeout, re-request limit, matching radius, OTP rules)',
    'customer and rider (active ride and cancellation limits, location requirement, minimum rating)',
    'payment (which methods are offered, timeout, retry limit)',
    'chat (ride chat on/off, message length, how long it stays open after drop-off)',
    'notification, support (complaint categories and SLA hours), and system (platform name, maintenance mode, support contacts)'
  ];

  return [
    '',
    'Admin console:',
    '- Settings is organised into groups: ' + groups.join('; ') + '.',
    '- a change is saved per group, is validated server-side, and is written to the audit log with the old and new value against the admin who made it.',
    '- settings marked high-impact affect pricing or availability and take effect for new bookings immediately; rides already booked keep their quoted fare.',
    '- riders, customers, rides, complaints and payments each have their own section, and what an operator can do there depends on their permissions.',
    '- a manual balance adjustment needs a permission and a written reason, and writes both an audit entry and a wallet ledger entry. There is no silent edit.',
    `- current commission is ${settings.get('finance.platformCommissionPercent')}% and the outstanding balance ceiling is ${money(settings.get('fare.currency'), settings.get('finance.maxOutstandingBalance'))}.`
  ];
}

/**
 * The block of live platform facts for one role.
 *
 * Roles differ in what is *useful*, not in what is secret — none of this is
 * personal data. A customer is not given the rider commission policy because it
 * would only crowd out the answer they asked for.
 */
function facts(role) {
  const lines = [...commonFacts()];

  if (role === ASSISTANT_ROLE.RIDER) lines.push(...riderFacts());
  if (role === ASSISTANT_ROLE.CUSTOMER) lines.push(...customerFacts());
  if (role === ASSISTANT_ROLE.ADMIN) {
    lines.push(...customerFacts(), ...riderFacts(), ...adminFacts());
  }

  lines.push(...supportFacts());

  return lines.join('\n');
}

module.exports = { facts };
