/**
 * What each side is asked about after a trip.
 *
 * The overall star is the number that matters and the only one that is
 * required; the categories are what make a low score useful to anybody trying
 * to act on it. "Three stars" tells support nothing — "three stars, driving 2"
 * tells them what to look at.
 *
 * The two sides are asked different things because they saw different things.
 */
const RIDER_CATEGORIES = ['driving', 'behaviour', 'vehicle'];
const CUSTOMER_CATEGORIES = ['behaviour', 'readiness', 'communication'];

module.exports = { RIDER_CATEGORIES, CUSTOMER_CATEGORIES };
