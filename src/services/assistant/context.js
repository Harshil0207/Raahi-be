const Ride = require('../../models/Ride');
const Rider = require('../../models/Rider');
const Complaint = require('../../models/Complaint');
const walletService = require('../wallet.service');
const settings = require('../settings.service');
const logger = require('../../utils/logger');
const { ASSISTANT_ROLE } = require('../../constants/assistant');
const { ACTIVE_RIDE_STATUSES, RIDE_STATUS } = require('../../constants/rideStatus');
const { COMPLAINT_STATUS } = require('../../constants/complaint');

/**
 * The few verified facts about the person asking.
 *
 * Two rules govern everything in this file.
 *
 * The first is that it is read from the database, never from the request. "My
 * ride expired" is answered from the ride's stored status; the client saying so
 * counts for nothing. A model that repeats back a status the browser asserted
 * is worse than one that says it does not know.
 *
 * The second is minimum necessary. Explaining why a request expired needs the
 * status and the time — not the pickup address, not the drop address, not
 * coordinates, not a phone number, not an email, not the OTP, and not anybody
 * else's details. What is left out here is as deliberate as what is included,
 * because all of it leaves the building.
 *
 * A failure gathering context is never fatal: the assistant answers from
 * platform knowledge alone rather than refusing to answer at all.
 */

const NONE = 'No account details are available for this question.';

const money = (amount) => `${settings.get('fare.currency')}${Number(amount).toFixed(2).replace(/\.00$/, '')}`;

/** "4 minutes ago" — relative, so the model never has to reason about clocks. */
function ago(date) {
  if (!date) return 'unknown';

  const seconds = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `${seconds} second(s) ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute(s) ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour(s) ago`;

  return `${Math.round(hours / 24)} day(s) ago`;
}

/**
 * One ride, reduced to what explains its state.
 *
 * Addresses are excluded on purpose: no question in the support set needs them,
 * and they are the most sensitive thing on the document.
 */
function describeRide(ride, label) {
  if (!ride) return null;

  const lines = [
    `${label}:`,
    `- status: ${ride.status}`,
    `- service: ${ride.serviceType}`,
    `- booked: ${ago(ride.createdAt)}`
  ];

  // The settled fare where there is one, the quote until then — and said to be
  // an estimate, so the model never presents a quote as a final charge.
  if (ride.finalFare != null) lines.push(`- final fare: ${money(ride.finalFare)}`);
  else if (ride.estimatedFare != null) lines.push(`- estimated fare (not yet settled): ${money(ride.estimatedFare)}`);

  if (ride.payment?.method) lines.push(`- payment method: ${ride.payment.method}`);
  if (ride.payment?.status) lines.push(`- payment status: ${ride.payment.status}`);
  if (ride.reRequestCount) lines.push(`- times re-sent to riders: ${ride.reRequestCount}`);
  if (ride.cancellation?.reason) lines.push(`- cancellation reason on record: ${ride.cancellation.reason}`);
  if (ride.cancellation?.by) lines.push(`- cancelled by: ${ride.cancellation.by}`);

  return lines.join('\n');
}

async function openComplaints(filter) {
  const count = await Complaint.countDocuments({
    ...filter,
    status: { $nin: [COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.CLOSED] }
  });
  return count ? `- open complaints on this account: ${count}` : '- no open complaints on this account.';
}

async function customerContext(user) {
  const blocks = [];

  const active = await Ride.findOne({ customerId: user._id, status: { $in: ACTIVE_RIDE_STATUSES } })
    .sort({ createdAt: -1 })
    .lean();

  const latest =
    active || (await Ride.findOne({ customerId: user._id }).sort({ createdAt: -1 }).lean());

  if (active) {
    blocks.push(describeRide(active, 'The customer has a ride in progress right now'));
  } else if (latest) {
    blocks.push(describeRide(latest, 'The customer has no ride in progress. Their most recent ride'));
  } else {
    blocks.push('The customer has not booked a ride yet.');
  }

  blocks.push(await openComplaints({ createdBy: user._id }));

  return blocks.filter(Boolean).join('\n\n');
}

async function riderContext(user) {
  const rider = await Rider.findOne({ userId: user._id });
  if (!rider) return 'This account does not have a rider profile.';

  const blocks = [];

  const wallet = await walletService.summary(rider._id);
  const eligibility = await walletService.checkCanGoOnline(rider._id);

  const status = [
    'Rider status right now:',
    `- online: ${rider.isOnline ? 'yes' : 'no'}`,
    `- available for new requests: ${rider.isAvailable ? 'yes' : 'no'}`,
    `- on a trip: ${rider.activeRideId ? 'yes' : 'no'}`,
    `- location known to the platform: ${rider.currentLocation ? `yes, updated ${ago(rider.lastLocationAt)}` : 'no'}`,
    `- completed trips: ${rider.totalRides}`,
    rider.rating != null ? `- rating: ${rider.rating}` : '- rating: not rated yet'
  ];

  const balance = [
    'Rider wallet, as recorded on the server:',
    wallet.outstanding > 0
      ? `- currently owes the platform ${money(wallet.outstanding)}`
      : `- owes nothing; available balance ${money(wallet.available)}`,
    `- the ceiling is ${money(wallet.threshold)}`,
    `- allowed to go online on balance: ${eligibility.allowed ? 'yes' : 'no'}`
  ];

  if (!eligibility.allowed) {
    balance.push(
      `- blocked because the amount owed is over the ceiling. A recharge of at least ${money(eligibility.requiredRecharge)} would clear it.`
    );
  }

  /**
   * Every reason the platform would refuse, gathered in one place so the model
   * gives the real reason rather than guessing at the most common one.
   */
  const blockers = [];
  if (!eligibility.allowed) blockers.push('the outstanding balance is over the ceiling');
  if (rider.activeRideId) blockers.push('they are already on a trip');
  if (!user.isActive) blockers.push('the account is not active');
  if (settings.get('rider.onlineRequiresLocation') && !rider.currentLocation) {
    blockers.push('the platform has no location for them, and location is required to go online');
  }

  const reason = blockers.length
    ? `Why they cannot go online: ${blockers.join('; ')}.`
    : 'There is nothing on the server stopping this rider from going online.';

  blocks.push(status.join('\n'), balance.join('\n'), reason);

  if (rider.activeRideId) {
    const ride = await Ride.findById(rider.activeRideId).lean();
    const described = describeRide(ride, 'Their current trip');
    if (described) blocks.push(described);
  }

  blocks.push(await openComplaints({ createdBy: user._id }));

  return blocks.join('\n\n');
}

/**
 * The admin gets platform totals, not anybody's personal data.
 *
 * An operator asking the assistant a question is not a reason to hand a
 * language model a customer's record. Anything about a specific person is
 * looked up in the console, where it is behind a permission and leaves an
 * audit trail.
 */
async function adminContext() {
  const [active, searching] = await Promise.all([
    Ride.countDocuments({ status: { $in: ACTIVE_RIDE_STATUSES } }),
    Ride.countDocuments({ status: RIDE_STATUS.SEARCHING })
  ]);

  const [online, openComplaintCount] = await Promise.all([
    Rider.countDocuments({ isOnline: true }),
    Complaint.countDocuments({ status: { $nin: [COMPLAINT_STATUS.RESOLVED, COMPLAINT_STATUS.CLOSED] } })
  ]);

  return [
    'Platform snapshot right now (totals only, no personal data):',
    `- rides in progress: ${active}, of which ${searching} are still looking for a rider`,
    `- riders online: ${online}`,
    `- open complaints: ${openComplaintCount}`
  ].join('\n');
}

/**
 * Gather what may be told to the model about this account, for this role.
 *
 * `role` comes from the verified token. It is not a parameter a client can
 * reach.
 */
async function gather(role, actor) {
  try {
    if (role === ASSISTANT_ROLE.CUSTOMER) return await customerContext(actor);
    if (role === ASSISTANT_ROLE.RIDER) return await riderContext(actor);
    if (role === ASSISTANT_ROLE.ADMIN) return await adminContext();
    return NONE;
  } catch (err) {
    // An answer from platform knowledge alone beats an error page.
    logger.error(`Assistant context failed (${role}): ${err.message}`);
    return NONE;
  }
}

module.exports = { gather, ago, describeRide };
