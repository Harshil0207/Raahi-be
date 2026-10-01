const env = require('./env');
const { SERVICES, ALL_SERVICE_TYPES, BOOKING_TYPE } = require('../constants/services');

/**
 * What the platform lets an admin configure, and the limits on each value.
 *
 * The values live in MongoDB; this file describes them. Keeping the description
 * in code rather than the database means a deploy can add a setting, a bad value
 * can never be stored, and the admin UI gets its labels, ranges and help text
 * from the same place the backend validates against.
 *
 * `default` seeds the database on first boot. Where an existing environment
 * variable covers the same ground it supplies the default, so an installation
 * that already tuned its .env keeps behaving the way it does today.
 *
 * `highImpact` marks the settings the admin UI confirms before saving.
 */

const SETTING_GROUPS = [
  'services',
  'fare',
  'finance',
  'ride',
  'customer',
  'rider',
  'tracking',
  'waiting',
  'cancellation',
  'payment',
  'chat',
  'notification',
  'support',
  'system'
];

/**
 * Four settings per service, generated from the catalogue rather than typed out
 * six times over. Adding a service to `constants/services.js` gives it a rate,
 * an on/off switch and its own floor and cap, with the same validation, audit
 * trail and caching every other setting gets.
 */
function serviceSettings() {
  const out = {};

  for (const type of ALL_SERVICE_TYPES) {
    const service = SERVICES[type];
    const parcel = service.bookingType === BOOKING_TYPE.PARCEL;
    const noun = parcel ? 'delivery' : 'ride';

    out[`services.${type}.ratePerKm`] = {
      group: 'services',
      type: 'number',
      default: service.defaultRatePerKm,
      // Zero is a legitimate rate: it is how a free service is expressed.
      min: 0,
      max: 500,
      label: `${service.label} — price per kilometre`,
      description: `Charged for every kilometre of a ${service.label} ${noun}. A ${noun} already booked keeps the rate it was quoted at.`,
      highImpact: true
    };

    out[`services.${type}.enabled`] = {
      group: 'services',
      type: 'boolean',
      default: true,
      label: `${service.label} — available`,
      description: `Turned off, customers are not offered ${service.label} and the backend refuses new bookings for it. ${noun === 'ride' ? 'Rides' : 'Deliveries'} already running are unaffected.`,
      highImpact: true
    };

    out[`services.${type}.minimumFare`] = {
      group: 'services',
      type: 'number',
      default: 0,
      min: 0,
      max: 5000,
      label: `${service.label} — minimum fare`,
      description: 'Short trips are lifted to this amount. Zero means no minimum.'
    };

    out[`services.${type}.maximumFare`] = {
      group: 'services',
      type: 'number',
      default: 0,
      min: 0,
      max: 100000,
      label: `${service.label} — maximum fare`,
      description: 'Long trips are held at this amount. Zero means no cap.'
    };
  }

  return out;
}

// type: number | boolean | string | string[]
const SETTINGS = {
  ...serviceSettings(),

  // ---------------------------------------------------------------- fare
  'fare.ratePerKm': {
    group: 'fare',
    type: 'number',
    default: env.fare.perKm,
    min: 1,
    max: 500,
    label: 'Price per kilometre',
    description: 'Charged for every kilometre travelled. Rides already created keep the rate they were quoted at.',
    highImpact: true
  },
  'fare.baseFare': {
    group: 'fare',
    type: 'number',
    default: 0,
    min: 0,
    max: 5000,
    label: 'Base fare',
    description: 'Added to every ride before distance is charged.',
    highImpact: true
  },
  'fare.minimumFare': {
    group: 'fare',
    type: 'number',
    default: 0,
    min: 0,
    max: 5000,
    label: 'Minimum fare',
    description: 'A ride never settles below this amount. 0 disables the floor.',
    highImpact: true
  },
  'fare.maximumFare': {
    group: 'fare',
    type: 'number',
    default: 0,
    min: 0,
    max: 100000,
    label: 'Maximum fare',
    description: 'Caps a single ride. 0 means no cap.',
    highImpact: true
  },
  'fare.waitingChargePerMinute': {
    group: 'fare',
    type: 'number',
    default: 0,
    min: 0,
    max: 100,
    label: 'Waiting charge per minute',
    description: 'Charged for waiting time once the rider has arrived. Recorded on the ride; not yet metered automatically.'
  },
  'fare.cancellationCharge': {
    group: 'fare',
    type: 'number',
    default: 0,
    min: 0,
    max: 1000,
    label: 'Cancellation charge',
    description: 'Charged to the customer for cancelling after a rider accepted.',
    highImpact: true
  },
  // `fare.riderCommissionPercent` used to live here, expressing the same split
  // from the other end. It was never read by anything, and two settings for one
  // decision is how a platform ends up taking 20% in one screen and 15% in
  // another — so the split is now stated once, as the platform's share, in
  // `finance.platformCommissionPercent` below.
  'fare.currency': {
    group: 'fare',
    type: 'string',
    default: env.fare.currency,
    maxLength: 8,
    label: 'Currency',
    description: 'ISO currency code used for new rides.',
    highImpact: true
  },

  // ------------------------------------------------------------- finance
  //
  // The money split and the rules around what a rider may owe. Separate from
  // `fare` on purpose: fare settings decide what the customer is charged,
  // these decide how that charge is divided and what happens when a rider
  // falls behind. Changing one should never feel like changing the other.
  'finance.platformCommissionPercent': {
    group: 'finance',
    type: 'number',
    default: 15,
    min: 0,
    // The safe ceiling. A commission above half the fare is almost certainly a
    // typo, and the damage from one — every ride for the rest of the day split
    // wrongly — is not worth the flexibility of allowing it by accident. An
    // operator who genuinely needs more can raise this line in a deploy, which
    // is a decision with a reviewer attached.
    max: 50,
    label: 'Platform commission (%)',
    description:
      'The platform’s share of every fare. The rider keeps the rest. A ride already driven keeps the rate it settled at — changing this only affects rides completed from now on.',
    highImpact: true
  },
  'finance.maxOutstandingBalance': {
    group: 'finance',
    type: 'number',
    default: 150,
    min: 0,
    max: 100000,
    label: 'Maximum rider outstanding balance',
    description:
      'A rider owing more than this cannot go online until they pay some of it down. Exactly this amount is still allowed; only more than it blocks. A trip already running is never interrupted.',
    highImpact: true
  },
  'finance.minimumRecharge': {
    group: 'finance',
    type: 'number',
    default: 30,
    min: 1,
    max: 10000,
    label: 'Minimum recharge',
    description: 'The smallest amount a rider may pay towards what they owe. Enforced by the backend, not just the app.',
    highImpact: true
  },
  'finance.walletWarningPercent': {
    group: 'finance',
    type: 'number',
    default: 70,
    min: 0,
    max: 100,
    label: 'Warn at (% of the maximum)',
    description:
      'The rider’s wallet starts warning once they owe this share of the maximum, so being blocked is never a surprise at the start of a shift. 100 warns only at the limit itself.'
  },
  'finance.paymentProvider': {
    group: 'finance',
    type: 'string',
    default: 'none',
    maxLength: 40,
    label: 'Payment provider',
    description:
      'Which provider collects UPI payments. “none” means no gateway is connected and UPI is refused rather than faked. “sandbox” is a test provider for development and must never be used in production.',
    highImpact: true
  },

  // ---------------------------------------------------------------- ride
  'ride.requestTimeoutSeconds': {
    group: 'ride',
    type: 'number',
    default: env.matching.requestTimeoutSeconds,
    min: 5,
    max: 120,
    label: 'Rider request timeout (seconds)',
    description: 'How long a rider has to accept before the request expires. The server enforces this; the app only displays it.',
    highImpact: true
  },
  /**
   * How many times a customer may ask again for the same ride.
   *
   * Not unlimited: a request nobody takes is usually a request nobody is going
   * to take, and a customer tapping through twenty rounds is a customer who
   * should be told to try a different service or a different time. Three rounds
   * of the configured timeout is about a minute of trying, which is long enough
   * to catch a rider coming free and short enough not to feel abandoned.
   */
  'ride.maxReRequests': {
    group: 'ride',
    type: 'number',
    default: 3,
    min: 0,
    max: 10,
    label: 'Re-requests per ride',
    description:
      'How many times a customer may ask again after a request expires with nobody accepting. Zero means they must book afresh.'
  },
  'ride.matchingRadiusKm': {
    group: 'ride',
    type: 'number',
    default: env.matching.radiusKm,
    min: 1,
    max: 50,
    label: 'Matching radius (km)',
    description: 'How far from the pickup point the platform looks for available riders.'
  },
  'ride.maxRidersPerRequest': {
    group: 'ride',
    type: 'number',
    default: env.matching.maxRiders,
    min: 1,
    max: 50,
    label: 'Riders notified per request',
    description: 'How many nearby riders a single request is offered to.'
  },
  'ride.otpLength': {
    group: 'ride',
    type: 'number',
    default: 4,
    min: 4,
    max: 6,
    label: 'Pickup code length',
    description: 'Number of digits in the pickup code. Changing this does not alter codes already issued.'
  },
  'ride.otpMaxAttempts': {
    group: 'ride',
    type: 'number',
    default: env.otp.maxAttempts,
    min: 1,
    max: 10,
    label: 'Pickup code attempts',
    description: 'Wrong entries allowed before the code is locked and the ride needs support.'
  },
  'ride.otpExpiryMinutes': {
    group: 'ride',
    type: 'number',
    default: 60,
    min: 5,
    max: 1440,
    label: 'Pickup code validity (minutes)',
    description: 'How long a pickup code stays usable after the ride is accepted.'
  },

  // ------------------------------------------------------------ customer
  'customer.maxActiveRides': {
    group: 'customer',
    type: 'number',
    default: 1,
    min: 1,
    max: 5,
    label: 'Active rides per customer',
    description: 'How many rides one customer may have running at once.'
  },
  'customer.cancellationsPerDay': {
    group: 'customer',
    type: 'number',
    default: 5,
    min: 1,
    max: 50,
    label: 'Cancellations per day',
    description: 'Cancellations a customer may make in a rolling 24 hours before booking is blocked.'
  },
  'customer.chargeCancellationAfterAccept': {
    group: 'customer',
    type: 'boolean',
    default: false,
    label: 'Charge for late cancellation',
    description: 'Apply the cancellation charge when the customer cancels after a rider has accepted.',
    highImpact: true
  },

  // --------------------------------------------------------------- rider
  'rider.locationUpdateIntervalMs': {
    group: 'rider',
    type: 'number',
    default: env.location.minUpdateIntervalMs,
    min: 1000,
    max: 60000,
    label: 'Location write interval (ms)',
    description: 'Minimum gap between stored location updates for an idle rider. Riders on a trip always write through.'
  },
  'rider.onlineRequiresLocation': {
    group: 'rider',
    type: 'boolean',
    default: true,
    label: 'Require location to go online',
    description: 'A rider cannot go online until the platform knows where they are.'
  },
  'rider.requireVerification': {
    group: 'rider',
    type: 'boolean',
    default: true,
    label: 'Require approval before a rider can go online',
    description:
      'New riders wait for a person to approve them. Turning this off lets anyone who registers start taking trips immediately — appropriate for a local or staging environment, and not for a live one.'
  },
  'rider.cancellationsPerDay': {
    group: 'rider',
    type: 'number',
    default: 5,
    min: 1,
    max: 50,
    label: 'Cancellations per day',
    description: 'Cancellations a rider may make in a rolling 24 hours before they are taken offline.'
  },
  'ride.reliabilityWeight': {
    group: 'ride',
    type: 'number',
    default: 0.35,
    min: 0,
    max: 1,
    label: 'How much a rider\u2019s record affects matching',
    description:
      'The share of the matching score that comes from acceptance rate, cancellations and rating rather than distance. 0 ranks purely by distance; 1 all but ignores it.',
    highImpact: true
  },

  'rider.minimumRating': {
    group: 'rider',
    type: 'number',
    default: 0,
    min: 0,
    max: 5,
    label: 'Minimum rating to receive rides',
    description: 'Riders below this rating stop being matched. 0 disables the check.',
    highImpact: true
  },

  // ------------------------------------------------------------- payment
  /**
   * Live rider tracking.
   *
   * The two distances are what decide, on the server, when a customer is told
   * their rider is close and when the ride is marked arrived. They are settings
   * rather than constants because "nearby" means something different in a dense
   * city and on a highway, and because the right number is found by watching
   * real trips rather than by guessing once.
   */
  'tracking.enabled': {
    group: 'tracking',
    type: 'boolean',
    default: true,
    label: 'Live rider tracking',
    description:
      'Turned off, riders stop streaming their position and customers see a static map. Trips already running keep working; only the moving marker and the automatic arrival stop.',
    highImpact: true
  },

  'tracking.nearbyMeters': {
    group: 'tracking',
    type: 'number',
    default: 500,
    min: 50,
    max: 5000,
    label: 'Rider nearby distance (metres)',
    description:
      'How close the rider must get before the customer is told they are nearby. Sent once per trip, never repeated.'
  },

  'tracking.arrivedMeters': {
    group: 'tracking',
    type: 'number',
    default: 200,
    min: 20,
    max: 1000,
    label: 'Pickup arrival radius (metres)',
    description:
      'How close the rider must get before the trip is marked as arrived automatically — which is also when pickup waiting starts. Must be smaller than the nearby distance.',
    highImpact: true
  },

  /**
   * The accuracy floor.
   *
   * A phone indoors can report a position a kilometre out with complete
   * confidence. Acting on that would tell a customer their rider had arrived
   * while the rider was still two streets away, so a fix worse than this is
   * still shown on the map — it is the best anyone has — but is not allowed to
   * decide anything.
   */
  'tracking.maxAccuracyMeters': {
    group: 'tracking',
    type: 'number',
    default: 150,
    min: 20,
    max: 2000,
    label: 'Worst GPS accuracy that may trigger arrival (metres)',
    description:
      'A position reported less accurately than this still moves the marker, but cannot mark a rider nearby or arrived. Raise it if arrivals are being missed; lower it if they fire too early.'
  },

  /**
   * When a customer should be told the position is going stale.
   *
   * Deliberately not "the rider is offline": a phone in a lift or a tunnel is
   * not a rider who has abandoned the trip, and saying so would start a support
   * ticket over a thirty-second gap.
   */
  'tracking.staleAfterSeconds': {
    group: 'tracking',
    type: 'number',
    default: 30,
    min: 10,
    max: 300,
    label: 'Location considered stale after (seconds)',
    description:
      'How long without a position before the customer is told the location is updating. It never says the rider is offline — a tunnel is not a disappearance.'
  },

  // ------------------------------------------------------------------ waiting
  //
  // A rider's time is the thing being sold, and waiting is the part of it the
  // distance fare does not cover. Both phases are configured separately
  // because they are different situations: a customer walking down from a flat
  // is not the same as a customer hunting for cash at the drop-off, and an
  // operator may well want to be more generous about one than the other.
  //
  // Nothing in the code carries these numbers. The ride stores the ones in
  // force when it happened, so changing them here never reprices a past trip.

  'waiting.freePickupMinutes': {
    group: 'waiting',
    type: 'number',
    default: 3,
    min: 0,
    max: 60,
    label: 'Free pickup waiting (minutes)',
    description:
      'How long the rider waits at the pickup before the customer is charged for it. The clock starts when the ride is marked arrived and stops when the pickup code is verified.',
    highImpact: true
  },

  'waiting.pickupChargePerMinute': {
    group: 'waiting',
    type: 'number',
    default: 2,
    min: 0,
    max: 100,
    label: 'Pickup waiting charge (per minute)',
    description:
      'Charged for each started minute after the free period. 3:01 costs one minute, 4:00 still costs one, 4:01 costs two.',
    highImpact: true
  },

  'waiting.freePaymentMinutes': {
    group: 'waiting',
    type: 'number',
    default: 3,
    min: 0,
    max: 60,
    label: 'Free payment waiting (minutes)',
    description:
      'How long the customer has to pay at the drop-off before waiting is charged. The clock starts when the trip ends and stops when the fare is settled.',
    highImpact: true
  },

  'waiting.paymentChargePerMinute': {
    group: 'waiting',
    type: 'number',
    default: 2,
    min: 0,
    max: 100,
    label: 'Payment waiting charge (per minute)',
    description: 'Charged for each started minute after the free payment period.',
    highImpact: true
  },

  // ------------------------------------------------------------- cancellation
  //
  // A fee here is money taken from somebody for a ride that never happened, so
  // both default to ZERO. The feature is present and configurable; whether it
  // is charged at all is an operator's decision, not a default nobody chose.

  'cancellation.freeWindowSeconds': {
    group: 'cancellation',
    type: 'number',
    default: 60,
    min: 0,
    max: 600,
    label: 'Free cancellation window (seconds)',
    description:
      'How long after a rider accepts the ride can still be called off for nothing. A ride nobody accepted is always free to cancel, whatever this says.'
  },

  'cancellation.customerFee': {
    group: 'cancellation',
    type: 'number',
    default: 0,
    min: 0,
    max: 1000,
    label: 'Customer cancellation fee',
    description:
      'Charged when a customer cancels after the free window, once a rider is already on the way. Zero means no fee is charged at all.',
    highImpact: true
  },

  'cancellation.riderFee': {
    group: 'cancellation',
    type: 'number',
    default: 0,
    min: 0,
    max: 1000,
    label: 'Rider cancellation fee',
    description:
      'Charged to a rider who calls off a ride they accepted, after the free window. Posted to their wallet as a debit and counts towards the balance that blocks going online.',
    highImpact: true
  },

  'payment.cashEnabled': {
    group: 'payment',
    type: 'boolean',
    default: true,
    label: 'Cash enabled',
    description: 'Customers may settle a ride in cash.',
    highImpact: true
  },
  'payment.upiEnabled': {
    group: 'payment',
    type: 'boolean',
    default: false,
    label: 'UPI enabled',
    description: 'Turn on once a payment gateway is connected. With no gateway configured, selecting UPI is refused rather than faked.',
    highImpact: true
  },
  'payment.timeoutMinutes': {
    group: 'payment',
    type: 'number',
    default: 30,
    min: 1,
    max: 1440,
    label: 'Payment timeout (minutes)',
    description: 'How long an unsettled payment stays pending before support is alerted.'
  },
  'payment.retryLimit': {
    group: 'payment',
    type: 'number',
    default: 3,
    min: 1,
    max: 10,
    label: 'Payment retries',
    description: 'Failed gateway attempts allowed on one ride.'
  },

  // ---------------------------------------------------------------- chat
  'chat.rideChatEnabled': {
    group: 'chat',
    type: 'boolean',
    default: true,
    label: 'Ride chat enabled',
    description: 'Customer and rider can message each other once the ride is accepted.'
  },
  'chat.openAfterCompletionMinutes': {
    group: 'chat',
    type: 'number',
    default: 120,
    min: 0,
    max: 10080,
    label: 'Chat stays open after drop-off (minutes)',
    description: 'Messaging is read-only after this window. 0 closes the chat the moment the ride ends.'
  },
  'chat.maxMessageLength': {
    group: 'chat',
    type: 'number',
    default: 1000,
    min: 50,
    max: 4000,
    label: 'Maximum message length',
    description: 'Characters allowed in one chat message.'
  },

  // -------------------------------------------------------- notification
  'notification.customerEnabled': {
    group: 'notification',
    type: 'boolean',
    default: true,
    label: 'Customer notifications',
    description: 'Record ride events in the customer notification feed.'
  },
  'notification.riderEnabled': {
    group: 'notification',
    type: 'boolean',
    default: true,
    label: 'Rider notifications',
    description: 'Record ride events in the rider notification feed.'
  },
  'notification.pushEnabled': {
    group: 'notification',
    type: 'boolean',
    default: false,
    label: 'Push notifications',
    description: 'Send to devices as well as the in-app feed. Requires a push provider, which is not yet connected.'
  },

  // ------------------------------------------------------------- support
  'support.customerComplaintCategories': {
    group: 'support',
    type: 'string[]',
    default: [
      'RIDE_ISSUE',
      'PAYMENT_ISSUE',
      'RIDER_BEHAVIOUR',
      'PICKUP_ISSUE',
      'DESTINATION_ISSUE',
      'FARE_ISSUE',
      'LOST_ITEM',
      'APP_ISSUE',
      'SAFETY_ISSUE',
      'OTHER'
    ],
    maxItems: 30,
    label: 'Customer complaint categories',
    description: 'Categories a customer may file under. Removing one does not change complaints already filed.'
  },
  'support.riderComplaintCategories': {
    group: 'support',
    type: 'string[]',
    default: [
      'RIDE_ISSUE',
      'CUSTOMER_BEHAVIOUR',
      'FARE_ISSUE',
      'PAYMENT_ISSUE',
      'PICKUP_ISSUE',
      'DESTINATION_ISSUE',
      'CUSTOMER_NO_SHOW',
      'APP_ISSUE',
      'SAFETY_ISSUE',
      'OTHER'
    ],
    maxItems: 30,
    label: 'Rider complaint categories',
    description: 'Categories a rider may file under.'
  },
  'support.slaHoursLow': {
    group: 'support',
    type: 'number',
    default: 72,
    min: 1,
    max: 720,
    label: 'SLA — low priority (hours)',
    description: 'Target time to resolve a low-priority complaint.'
  },
  'support.slaHoursMedium': {
    group: 'support',
    type: 'number',
    default: 48,
    min: 1,
    max: 720,
    label: 'SLA — medium priority (hours)',
    description: 'Target time to resolve a medium-priority complaint.'
  },
  'support.slaHoursHigh': {
    group: 'support',
    type: 'number',
    default: 12,
    min: 1,
    max: 720,
    label: 'SLA — high priority (hours)',
    description: 'Target time to resolve a high-priority complaint.'
  },
  'support.slaHoursUrgent': {
    group: 'support',
    type: 'number',
    default: 2,
    min: 1,
    max: 720,
    label: 'SLA — urgent (hours)',
    description: 'Target time to resolve an urgent complaint.'
  },
  'support.autoUrgentCategories': {
    group: 'support',
    type: 'string[]',
    default: ['SAFETY_ISSUE'],
    maxItems: 20,
    label: 'Always urgent',
    description: 'Complaints in these categories are filed as urgent whatever the reporter chose.'
  },

  // -------------------------------------------------------------- system
  'system.maintenanceMode': {
    group: 'system',
    type: 'boolean',
    default: false,
    label: 'Maintenance mode',
    description: 'Customers and riders cannot start new rides. Rides already running are left alone and admins keep working.',
    highImpact: true
  },
  'system.maintenanceMessage': {
    group: 'system',
    type: 'string',
    default: 'Raahi is briefly unavailable for maintenance. Please try again shortly.',
    maxLength: 300,
    label: 'Maintenance message',
    description: 'Shown to customers and riders while maintenance mode is on.'
  },
  'system.platformName': {
    group: 'system',
    type: 'string',
    default: 'Raahi',
    maxLength: 60,
    label: 'Platform name',
    description: 'Used in notifications and support replies.'
  },
  'system.supportPhone': {
    group: 'system',
    type: 'string',
    default: '',
    maxLength: 20,
    label: 'Support phone',
    description: 'Shown on the in-app help screen. Leave empty to hide it.'
  },
  'system.supportEmail': {
    group: 'system',
    type: 'string',
    default: '',
    maxLength: 120,
    label: 'Support email',
    description: 'Shown on the in-app help screen. Leave empty to hide it.'
  }
};

const KEYS = Object.keys(SETTINGS);

const keysInGroup = (group) => KEYS.filter((key) => SETTINGS[key].group === group);

const defaults = () =>
  KEYS.reduce((acc, key) => {
    const { default: value } = SETTINGS[key];
    acc[key] = Array.isArray(value) ? [...value] : value;
    return acc;
  }, {});

module.exports = { SETTINGS, SETTING_GROUPS, KEYS, keysInGroup, defaults };
