/**
 * How riders are ranked for an offer.
 *
 * Distance is the largest part and deliberately so: a customer waiting at the
 * kerb is helped most by the rider who can actually get there, and a ranking
 * that sends a job across town to somebody with a better record is a worse
 * service dressed up as a fairer one. Reliability adjusts that order; it does
 * not replace it.
 *
 * WHY THE PRIOR. A rider with one offer and one acceptance has a perfect
 * acceptance rate, and a rider with one cancellation out of one ride has the
 * worst possible record. Neither figure means anything yet. So each rate is
 * computed as though everyone started with a handful of ordinary rides already
 * behind them: early results move the number a little, and it takes a real
 * pattern to move it a lot. A new rider therefore starts mid-table rather than
 * at the top or the bottom, and earns their position from there.
 */

// How much of the reliability half of the score each part accounts for. They
// sum to 1; the split between reliability and distance is a setting.
const RELIABILITY_WEIGHTS = {
  acceptance: 0.45,
  completion: 0.35,
  rating: 0.2
};

// The imaginary history every rider is judged against until they have one of
// their own: this many rides, at these rates.
const PRIOR = {
  offers: 5,
  acceptanceRate: 0.8,
  // Heavier than the offers prior on purpose. Turning down a ring is ordinary
  // and happens constantly, so acceptance evidence piles up quickly; calling
  // off a ride you accepted is rare, and one of them says much less about a
  // rider than one ignored ring does. At 5, a rider whose very first ride fell
  // through read as cancelling one in five.
  rides: 10,
  cancellationRate: 0.05,
  ratings: 3,
  rating: 4.2
};

// Ranking looks at more riders than it offers to, or the sort has nothing to
// sort: taking the nearest N and then reordering them is still the nearest N.
const POOL_MULTIPLIER = 3;

module.exports = { RELIABILITY_WEIGHTS, PRIOR, POOL_MULTIPLIER };
