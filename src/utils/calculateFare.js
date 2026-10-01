const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Single place where money is derived from distance.
 *
 * Every component is passed in rather than read from configuration here, because
 * a ride settles on the pricing it was created with — see fare.service. That is
 * also why the breakdown is returned in full: it is stored on the ride, so a
 * fare can be explained months later even after the rates have moved.
 */
function buildFare({ distanceKm, ratePerKm, currency, baseFare = 0, minimumFare = 0, maximumFare = 0, extras = 0 }) {
  const distance = round2(Math.max(distanceKm, 0));
  const distanceFare = round2(distance * ratePerKm);

  let amount = round2(baseFare + distanceFare + extras);

  // A floor and a cap are both optional; 0 means "not set" for either.
  const floored = minimumFare > 0 && amount < minimumFare;
  if (floored) amount = round2(minimumFare);

  const capped = maximumFare > 0 && amount > maximumFare;
  if (capped) amount = round2(maximumFare);

  return {
    distanceKm: distance,
    ratePerKm,
    currency,
    breakdown: {
      baseFare: round2(baseFare),
      distanceFare,
      extras: round2(extras),
      minimumApplied: floored,
      maximumApplied: capped
    },
    amount
  };
}

module.exports = { buildFare, round2 };
