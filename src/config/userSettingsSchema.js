const { ROLES } = require('../constants/userRoles');
const { ALL_SERVICE_TYPES, SERVICES, BOOKING_TYPE } = require('../constants/services');

/**
 * What a customer or a rider may set for themselves, and the limits on each.
 *
 * Same shape as the admin registry in `settingsSchema.js`, and for the same
 * reason: the description lives in code, the values live in MongoDB. A setting
 * that is not declared here cannot be written — which is what turns "reject
 * unknown keys" from a rule somebody has to remember into something the code
 * cannot do. There is no path that spreads a request body into a document.
 *
 * THIS IS NOT THE ADMIN REGISTRY. Nothing in here changes the platform: no
 * prices, no commission, no thresholds, no radius. A rider can ask not to hear
 * the request chime; a rider cannot make themselves eligible to go online. The
 * two systems share a pattern and nothing else — different collection,
 * different routes, different middleware.
 *
 * `role` decides who may write a key. A key with no role is shared by both.
 * `deliverable` marks the preferences that only govern things the platform can
 * actually do; there is a note at NOTIFICATION_SETTINGS about what that rules
 * out and why.
 */

const SETTING_GROUPS = ['appearance', 'accessibility', 'notifications', 'privacy', 'ride', 'riding', 'navigation', 'availability'];

/** Groups a customer may read and write. */
const CUSTOMER_GROUPS = ['appearance', 'accessibility', 'notifications', 'privacy', 'ride'];

/** Groups a rider may read and write. */
const RIDER_GROUPS = ['appearance', 'accessibility', 'notifications', 'privacy', 'riding', 'navigation', 'availability'];

/**
 * Which vehicle a customer gets offered first.
 *
 * Built from the service catalogue rather than typed out, so a service added to
 * `constants/services.js` becomes a valid choice with no edit here — and a
 * service removed stops being one, rather than leaving customers pinned to a
 * default the platform no longer sells. Parcel services are left out: a default
 * vehicle is about booking a ride, and a delivery is chosen a different way.
 */
const defaultVehicleChoices = () => [
  'none',
  ...ALL_SERVICE_TYPES.filter((type) => SERVICES[type].bookingType !== BOOKING_TYPE.PARCEL)
];

const APPEARANCE_SETTINGS = {
  'appearance.theme': {
    group: 'appearance',
    type: 'enum',
    values: ['system', 'light', 'dark'],
    default: 'system',
    label: 'Theme',
    description: 'System follows your phone.'
  }
};

const ACCESSIBILITY_SETTINGS = {
  'accessibility.reducedMotion': {
    group: 'accessibility',
    type: 'enum',
    // Three states, not a switch. "System" is the honest default because the
    // phone already knows — and somebody who turned motion down across their
    // whole device should not have to say so again here. The other two exist
    // because the OS setting is all-or-nothing and this app is not.
    values: ['system', 'on', 'off'],
    default: 'system',
    label: 'Reduce motion',
    description: 'Turns down animations. System follows your phone’s accessibility setting.'
  },
  'accessibility.largerText': {
    group: 'accessibility',
    type: 'boolean',
    default: false,
    label: 'Larger text',
    description: 'Increases text size across the app.'
  },
  'accessibility.highContrast': {
    group: 'accessibility',
    type: 'boolean',
    default: false,
    label: 'Higher contrast',
    description: 'Strengthens borders and dims decorative surfaces.'
  }
};

/**
 * NOTIFICATIONS — and what is deliberately not here.
 *
 * Raahi has no push provider, no mail sender and no SMS gateway. Nothing in the
 * dependency list can deliver a message to a phone that is not looking at the
 * app: notifications are a Socket.IO event and a row in the feed, read when the
 * app is open. So there are no Push, Email or SMS switches — four switches
 * where three do nothing is worse than three switches that all work, and a
 * person who turns "Email" off would reasonably believe they had been getting
 * emails.
 *
 * What these DO control is real and enforced on the server: a type switched off
 * is never recorded and never emitted, so it does not arrive and does not sit
 * in the feed waiting to be found later.
 *
 * `security` is absent on purpose and is not an oversight — see MANDATORY below.
 */
const NOTIFICATION_SETTINGS = {
  'notifications.rideUpdates': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    label: 'Ride updates',
    description: 'Accepted, on the way, arrived, started and completed.'
  },
  'notifications.rideCancelled': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    label: 'Cancellations',
    description: 'When a ride is called off by either side.'
  },
  'notifications.payment': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    label: 'Payments',
    description: 'Fares, receipts and payment problems.'
  },
  'notifications.chat': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    // Governed in the app, not on the server: chat is a live socket event and
    // is never written to the feed, so there is nothing here to filter. What
    // this turns off is the alert — the toast and the sound. The message still
    // arrives and the conversation still shows it, the same way a rider with
    // the chime off still sees the request.
    clientGoverned: true,
    label: 'Message alerts',
    description: 'Alerts you to new messages during a ride. Messages still appear in the chat.'
  },
  'notifications.support': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    label: 'Support replies',
    description: 'Updates on complaints you have raised.'
  },
  'notifications.sound': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    clientGoverned: true,
    label: 'Sound',
    description: 'Play a sound for alerts while the app is open. The two below are inside this one.'
  },
  /**
   * The two ride moments a customer may want to hear, separately.
   *
   * Both sit UNDER `notifications.sound`: turning the master off silences
   * everything, and these choose between the two when it is on. They are
   * `clientGoverned` for the same reason the master is — what they switch is
   * whether the app makes a noise, not whether the event is delivered. The
   * toast still appears, the ride state still updates, and the entry is still
   * written to the feed. Nothing about a ride is ever withheld because somebody
   * wanted quiet.
   */
  'notifications.rideAcceptedSound': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    role: ROLES.CUSTOMER,
    clientGoverned: true,
    label: 'Ride accepted sound',
    description: 'A short sound when a rider accepts your ride. The alert still appears either way.'
  },
  'notifications.riderArrivedSound': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    role: ROLES.CUSTOMER,
    clientGoverned: true,
    label: 'Rider arrived sound',
    description: 'A short sound when your rider reaches the pickup point. The alert still appears either way.'
  },
  'notifications.vibration': {
    group: 'notifications',
    type: 'boolean',
    default: true,
    clientGoverned: true,
    label: 'Vibration',
    description: 'Vibrate for alerts, where your device supports it.'
  }
};

/**
 * What arrives whatever the switches say, described for the screen.
 *
 * Security and account alerts are how somebody finds out their account was
 * touched. A settings screen that lets an attacker who already has the password
 * silence the warning is a settings screen that helped. In the code this is
 * enforced by absence — the SYSTEM notification type has no key mapped to it in
 * `userSettings.service`, so there is nothing to turn off. This list exists so
 * the screen can say so out loud rather than leaving a gap where a switch would
 * be.
 *
 * There is deliberately no "Offers and promotions" switch: Raahi has no
 * promotional notifications, so it would be a control that governs nothing.
 * When promotions are built, the switch goes in beside them.
 */
const MANDATORY_NOTIFICATIONS = [
  {
    label: 'Security and account alerts',
    description: 'Changes to your account always reach you. These cannot be switched off.'
  }
];

const PRIVACY_SETTINGS = {
  'privacy.shareRideStatus': {
    group: 'privacy',
    type: 'boolean',
    default: true,
    label: 'Share my ride status',
    description: 'Lets the other person on the trip see progress and arrival.'
  },
  'privacy.showProfilePhoto': {
    group: 'privacy',
    type: 'boolean',
    default: true,
    label: 'Show my photo',
    description: 'Shows your photo to the other person on a trip. Your name is always shown.'
  },
  'privacy.showRating': {
    group: 'privacy',
    type: 'boolean',
    default: true,
    label: 'Show my rating',
    description: 'Shows your average rating to the other person on a trip.'
  },
  'privacy.personalisation': {
    group: 'privacy',
    type: 'boolean',
    default: true,
    label: 'Personalised suggestions',
    description: 'Uses your recent trips to suggest places when you book.'
  }
};

const RIDE_SETTINGS = {
  'ride.defaultVehicle': {
    group: 'ride',
    type: 'enum',
    values: defaultVehicleChoices(),
    default: 'none',
    role: ROLES.CUSTOMER,
    label: 'Default vehicle',
    description: 'Selected first when you book. Prices are set by Raahi and do not change with this.'
  },
  'ride.showFareBreakdown': {
    group: 'ride',
    type: 'boolean',
    default: true,
    role: ROLES.CUSTOMER,
    label: 'Show fare breakdown',
    description: 'Expands the fare into distance, waiting and charges.'
  },
  'ride.showRoutePreview': {
    group: 'ride',
    type: 'boolean',
    default: true,
    role: ROLES.CUSTOMER,
    label: 'Show route preview',
    description: 'Draws the route before you confirm a booking.'
  },
  'ride.autoCentreMap': {
    group: 'ride',
    type: 'boolean',
    default: true,
    role: ROLES.CUSTOMER,
    label: 'Follow the map automatically',
    description: 'Keeps your rider centred while you track a trip. Turn off to pan freely.'
  },
  'ride.confirmBeforeBooking': {
    group: 'ride',
    type: 'boolean',
    default: true,
    role: ROLES.CUSTOMER,
    label: 'Confirm before booking',
    description: 'Asks once more before a ride is requested.'
  }
};

const RIDING_SETTINGS = {
  'riding.requestSound': {
    group: 'riding',
    type: 'boolean',
    default: true,
    role: ROLES.RIDER,
    label: 'Ride request sound',
    description: 'Plays a chime when a new request arrives. The request is shown either way.'
  },
  'riding.requestVibration': {
    group: 'riding',
    type: 'boolean',
    default: true,
    role: ROLES.RIDER,
    label: 'Ride request vibration',
    description: 'Vibrates for a new request, where your device supports it.'
  },
  'riding.autoOpenRequests': {
    group: 'riding',
    type: 'boolean',
    default: false,
    role: ROLES.RIDER,
    label: 'Open requests automatically',
    description: 'Brings a new request to full screen instead of showing a card.'
  },
  'riding.distanceUnit': {
    group: 'riding',
    type: 'enum',
    values: ['km'],
    default: 'km',
    role: ROLES.RIDER,
    label: 'Distance unit',
    description: 'Raahi works in kilometres.'
  }
};

const NAVIGATION_SETTINGS = {
  'navigation.autoCentreMap': {
    group: 'navigation',
    type: 'boolean',
    default: true,
    role: ROLES.RIDER,
    label: 'Follow the map automatically',
    description: 'Keeps you centred while navigating. Turn off to pan freely.'
  },
  'navigation.trafficLayer': {
    group: 'navigation',
    type: 'boolean',
    default: false,
    role: ROLES.RIDER,
    label: 'Show traffic',
    description: 'Shades busy roads on the map where the map data provides it.'
  },
  'navigation.routeAnimation': {
    group: 'navigation',
    type: 'boolean',
    default: true,
    role: ROLES.RIDER,
    label: 'Animate the route',
    description: 'Draws the route with motion rather than all at once.'
  }
};

const AVAILABILITY_SETTINGS = {
  'availability.onlineReminders': {
    group: 'availability',
    type: 'boolean',
    default: true,
    role: ROLES.RIDER,
    label: 'Remind me I am online',
    description: 'A reminder after a long stretch online with no trips.'
  },
  'availability.autoOfflineMinutes': {
    group: 'availability',
    type: 'number',
    default: 0,
    min: 0,
    max: 240,
    role: ROLES.RIDER,
    label: 'Go offline when idle',
    description: 'Minutes of no activity before you are taken offline. 0 keeps you online until you say otherwise.'
  }
};

const SETTINGS = {
  ...APPEARANCE_SETTINGS,
  ...ACCESSIBILITY_SETTINGS,
  ...NOTIFICATION_SETTINGS,
  ...PRIVACY_SETTINGS,
  ...RIDE_SETTINGS,
  ...RIDING_SETTINGS,
  ...NAVIGATION_SETTINGS,
  ...AVAILABILITY_SETTINGS
};

const KEYS = Object.keys(SETTINGS);

/** The groups a role may touch. Anything else is not theirs to read or write. */
const groupsFor = (role) => (role === ROLES.RIDER ? RIDER_GROUPS : CUSTOMER_GROUPS);

/** Keys in a group that this role may set. */
const keysInGroup = (group, role) =>
  KEYS.filter((key) => SETTINGS[key].group === group && (!SETTINGS[key].role || SETTINGS[key].role === role));

/** Every key this role may set, across their groups. */
const keysFor = (role) => groupsFor(role).flatMap((group) => keysInGroup(group, role));

/** The shipped defaults for a role, as a flat key/value map. */
const defaultsFor = (role) => Object.fromEntries(keysFor(role).map((key) => [key, SETTINGS[key].default]));

module.exports = {
  SETTINGS,
  SETTING_GROUPS,
  CUSTOMER_GROUPS,
  RIDER_GROUPS,
  MANDATORY_NOTIFICATIONS,
  KEYS,
  groupsFor,
  keysInGroup,
  keysFor,
  defaultsFor
};
