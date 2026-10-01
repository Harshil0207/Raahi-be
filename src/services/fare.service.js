const settings = require('./settings.service');
const ApiError = require('../utils/ApiError');
const { buildFare, round2 } = require('../utils/calculateFare');
const { SERVICES, SERVICE_TYPE, ALL_SERVICE_TYPES, bookingTypeOf } = require('../constants/services');

/**
 * Pricing. Each service has its own rate, the rates live in platform settings
 * so an admin changes them without a deploy — but a ride is priced once, at
 * creation, and settles on that pricing.
 *
 * That is the whole point of `pricingOf`: the ride carries the numbers it was
 * quoted against, so raising the bike rate tomorrow cannot reprice a trip taken
 * today. Rides created before services existed fall back to the platform-wide
 * rate they have always had.
 */

/** The rate card as it stands right now, for one service. */
function currentPricing(serviceType = SERVICE_TYPE.CAR) {
  if (!SERVICES[serviceType]) {
    throw ApiError.badRequest(`Unknown service: ${serviceType}`);
  }

  return {
    serviceType,
    ratePerKm: settings.get(`services.${serviceType}.ratePerKm`),
    currency: settings.get('fare.currency'),
    // The base fare is charged once per trip whatever the vehicle, so it stays
    // a platform setting rather than being repeated six times.
    baseFare: settings.get('fare.baseFare'),
    minimumFare: settings.get(`services.${serviceType}.minimumFare`),
    maximumFare: settings.get(`services.${serviceType}.maximumFare`)
  };
}

const isEnabled = (serviceType) =>
  Boolean(SERVICES[serviceType]) && settings.get(`services.${serviceType}.enabled`) === true;

/**
 * The services a customer may actually book, with today's prices.
 *
 * A disabled service is absent rather than greyed out: the apps render whatever
 * comes back, so there is one decision about availability and the backend makes
 * it.
 */
function availableServices() {
  return ALL_SERVICE_TYPES.filter(isEnabled)
    .map((type) => {
      const service = SERVICES[type];
      const pricing = currentPricing(type);

      return {
        serviceType: type,
        bookingType: service.bookingType,
        label: service.label,
        description: service.description,
        vehicle: service.vehicle,
        order: service.order,
        ratePerKm: pricing.ratePerKm,
        currency: pricing.currency,
        baseFare: pricing.baseFare,
        minimumFare: pricing.minimumFare,
        maximumFare: pricing.maximumFare,
        // A rate of zero is a product decision, not a missing value, so it is
        // labelled rather than left for each app to guess at.
        free: pricing.ratePerKm === 0 && pricing.baseFare === 0
      };
    })
    .sort((a, b) => a.order - b.order);
}

/**
 * Refuses a service that does not exist or has been turned off.
 *
 * Called on the way into a booking. Hiding a card in the app is presentation;
 * this is the rule.
 */
function assertBookable(serviceType) {
  if (!SERVICES[serviceType]) {
    throw ApiError.badRequest('Pick a service', [{ field: 'serviceType', message: 'Not a service we offer' }]);
  }

  if (!isEnabled(serviceType)) {
    throw ApiError.badRequest(`${SERVICES[serviceType].label} is not available right now`, [
      { field: 'serviceType', message: 'This service has been turned off' }
    ]);
  }

  return { serviceType, bookingType: bookingTypeOf(serviceType) };
}

/**
 * What this particular ride is priced on, whatever the current settings say.
 *
 * The fallbacks matter: a ride created before per-service pricing carries only
 * the old flat rate, and it must still settle at that rate rather than at
 * whatever its vehicle costs today.
 */
function pricingOf(ride) {
  const snapshot = ride.pricing || {};

  return {
    serviceType: snapshot.serviceType ?? ride.serviceType ?? null,
    ratePerKm: snapshot.ratePerKm ?? ride.fareRatePerKm,
    currency: snapshot.currency ?? ride.currency,
    baseFare: snapshot.baseFare ?? 0,
    minimumFare: snapshot.minimumFare ?? 0,
    maximumFare: snapshot.maximumFare ?? 0
  };
}

/** Quote shown before booking, at today's rates for that service. */
function estimateFare(distanceKm, serviceType = SERVICE_TYPE.CAR) {
  const pricing = currentPricing(serviceType);
  return { ...buildFare({ distanceKm, ...pricing }), serviceType };
}

/** Every bookable service quoted for one distance, for the selection screen. */
function quoteAll(distanceKm) {
  return availableServices().map((service) => {
    const fare = buildFare({ distanceKm, ...service });

    return {
      ...service,
      estimatedFare: fare.amount,
      breakdown: fare.breakdown
    };
  });
}

/** Settlement at drop-off, at the rates the ride was created with. */
function finalFare(ride, actualDistanceKm) {
  return buildFare({ distanceKm: actualDistanceKm, ...pricingOf(ride) });
}

/**
 * How a settled fare divides between the platform and the rider, at today's
 * commission.
 *
 * The rider's share is derived by subtraction rather than by its own percentage
 * calculation. Rounding each side independently is how ₹100 at 15% becomes
 * ₹15 + ₹84.99: the two halves must add back up to the fare exactly, every
 * time, or the ledger drifts a paisa per ride until it stops balancing.
 *
 * Called with an explicit `rate` when settling a ride that has already been
 * priced — a ride keeps the commission it settled at, so an admin moving the
 * rate cannot reach backwards and change what a rider was told they earned.
 */
function split(amount, rate = settings.get('finance.platformCommissionPercent')) {
  const fareAmount = round2(Math.max(Number(amount) || 0, 0));
  const platformCommissionRate = Number(rate) || 0;
  const platformCommissionAmount = round2((fareAmount * platformCommissionRate) / 100);

  return {
    fareAmount,
    platformCommissionRate,
    platformCommissionAmount,
    riderEarningAmount: round2(fareAmount - platformCommissionAmount)
  };
}

/**
 * The split a ride actually settled at, from its own snapshot.
 *
 * Rides completed before commission existed carry no snapshot. They are read
 * back as a 0% commission rather than as today's rate, because that is what
 * genuinely happened to them: the rider kept the whole fare, and recomputing
 * them now would invent a debt nobody ever owed.
 */
function splitOf(ride) {
  const snapshot = ride?.finance || {};

  if (snapshot.riderEarningAmount == null) {
    const fareAmount = round2(ride?.finalFare || 0);
    return {
      fareAmount,
      platformCommissionRate: 0,
      platformCommissionAmount: 0,
      riderEarningAmount: fareAmount,
      currency: ride?.currency || null,
      legacy: true
    };
  }

  return {
    fareAmount: snapshot.fareAmount,
    platformCommissionRate: snapshot.platformCommissionRate,
    platformCommissionAmount: snapshot.platformCommissionAmount,
    riderEarningAmount: snapshot.riderEarningAmount,
    currency: snapshot.currency || ride?.currency || null,
    legacy: false
  };
}

/**
 * Re-derives what the customer owes and how it divides, after waiting changed.
 *
 * WHY THIS EXISTS. A fare is frozen when the journey ends, but payment waiting
 * carries on accruing after that — so the total can legitimately grow between
 * the fare being fixed and the money being taken. Everything else about the
 * settled ride must stay exactly as it was: the distance, the ride fare, and
 * above all the COMMISSION RATE, which is read from the ride's own snapshot
 * rather than from today's settings. An operator moving the rate must never be
 * able to reach back into a ride that has already ended.
 *
 * The waiting charge is added ON TOP of the ride fare, after the minimum and
 * maximum have been applied to it. A cap is a limit on what a journey costs;
 * folding waiting inside it would mean a rider who sat outside a capped fare
 * for twenty minutes was compensated with nothing.
 *
 * Returns the amounts rather than saving: the caller owns the write, and on
 * the settlement path that write has to be part of a larger one.
 */
function repriceWithWaiting(ride) {
  const rideFare = round2(ride.rideFare ?? ride.finalFare ?? 0);
  const waitingCharge = round2((ride.waiting?.pickup?.charge || 0) + (ride.waiting?.payment?.charge || 0));
  const finalFare = round2(rideFare + waitingCharge);

  // The rate this ride settled at. `split` recomputes both halves from it, so
  // the two still add back up to the fare exactly.
  const rate = ride.finance?.platformCommissionRate ?? currentCommissionRate();

  return {
    rideFare,
    waitingCharge,
    finalFare,
    finance: {
      ...split(finalFare, rate),
      currency: ride.finance?.currency || ride.currency,
      postedAt: ride.finance?.postedAt || null
    }
  };
}

/** The commission percentage in force for a ride completed right now. */
const currentCommissionRate = () => settings.get('finance.platformCommissionPercent');

const currentRate = (serviceType = SERVICE_TYPE.CAR) => currentPricing(serviceType).ratePerKm;

module.exports = {
  estimateFare,
  repriceWithWaiting,
  quoteAll,
  finalFare,
  currentPricing,
  availableServices,
  assertBookable,
  isEnabled,
  pricingOf,
  split,
  splitOf,
  currentCommissionRate,
  currentRate
};
