const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { haversineKm } = require('../utils/calculateDistance');
const googleProvider = require('./maps/google.provider');
const osmProvider = require('./maps/osm.provider');

/**
 * One seam for every map lookup. `auto` uses Google when a key is configured and
 * falls back to the free OSM stack otherwise, so the app works out of the box and
 * upgrades by adding a key rather than by changing code.
 */
function pickProvider() {
  if (env.maps.provider === 'google') return googleProvider;
  if (env.maps.provider === 'osm') return osmProvider;
  return env.googleMapsApiKey ? googleProvider : osmProvider;
}

const provider = pickProvider();

if (env.maps.provider === 'google' && !env.googleMapsApiKey) {
  logger.warn('MAPS_PROVIDER is google but GOOGLE_MAPS_API_KEY is empty — map lookups will fail');
}

async function searchPlaces(query, bias) {
  try {
    return await provider.searchPlaces(query, bias);
  } catch (err) {
    throw wrap(err, 'Place search is unavailable right now');
  }
}

async function geocode(input) {
  try {
    return await provider.geocode(input);
  } catch (err) {
    throw wrap(err, 'Could not resolve that location');
  }
}

/**
 * Road distance between two points. A provider outage must not block a booking,
 * so this degrades to straight-line distance and reports which source was used.
 */
async function getRoute(origin, destination) {
  try {
    return await provider.getRoute(origin, destination);
  } catch (err) {
    logger.warn(`Route lookup failed via ${provider.name}, using straight-line distance:`, err.message);
    return { distanceKm: haversineKm(origin, destination), durationMin: null, source: 'haversine' };
  }
}

function wrap(err, message) {
  if (err instanceof ApiError) return err;
  logger.warn(`${provider.name} maps request failed:`, err.message);
  return new ApiError(503, message);
}

module.exports = { searchPlaces, geocode, getRoute, providerName: provider.name };
