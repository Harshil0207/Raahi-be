const axios = require('axios');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');

/**
 * Nominatim for search/geocoding, OSRM for driving routes. Both are free and
 * need no key, which is why this is the default when no Google key is set.
 *
 * The public Nominatim instance asks for an identifying User-Agent and at most
 * one request per second, so calls are serialised through a small gate and
 * repeated lookups are cached. Point NOMINATIM_URL at your own instance to lift
 * both restrictions.
 */

const nominatim = axios.create({
  baseURL: env.maps.nominatimUrl,
  timeout: 8000,
  headers: { 'User-Agent': env.maps.userAgent, 'Accept-Language': 'en' }
});

const osrm = axios.create({ baseURL: env.maps.osrmUrl, timeout: 8000 });

const MIN_GAP_MS = 1100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 300;

let queue = Promise.resolve();
let lastCallAt = 0;

// Serialises Nominatim calls and keeps them at least MIN_GAP_MS apart.
function throttle(fn) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    return fn();
  });

  queue = run.catch(() => {});
  return run;
}

const cache = new Map();

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);

  return fn().then((value) => {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { value, at: Date.now() });
    return value;
  });
}

// "12 Main Street, Andheri, Mumbai" -> main "12 Main Street", secondary the rest.
function splitLabel(displayName, name) {
  const parts = String(displayName || '').split(',').map((p) => p.trim());
  const main = name || parts[0] || displayName;
  const secondary = parts.slice(name && parts[0] !== name ? 0 : 1).join(', ');
  return { main, secondary };
}

const toPlace = (row) => {
  const { main, secondary } = splitLabel(row.display_name, row.name);
  return {
    placeId: `osm:${row.osm_type?.[0]?.toUpperCase() || 'N'}:${row.osm_id}`,
    description: row.display_name,
    mainText: main,
    secondaryText: secondary,
    lat: Number(row.lat),
    lng: Number(row.lon)
  };
};

async function searchPlaces(query, { lat, lng } = {}) {
  const params = { q: query, format: 'jsonv2', addressdetails: 1, limit: 8 };

  // Bias towards the user without excluding everything else.
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const d = 0.5;
    params.viewbox = [lng - d, lat + d, lng + d, lat - d].join(',');
    params.bounded = 0;
  }

  const key = `search:${query}:${params.viewbox || ''}`;
  const rows = await cached(key, () => throttle(() => nominatim.get('/search', { params })).then((r) => r.data));

  return (rows || []).map(toPlace);
}

async function geocode({ address, placeId, lat, lng }) {
  if (placeId) {
    const [, type, id] = String(placeId).split(':');
    if (!id) throw ApiError.badRequest('placeId is not a valid OSM reference');

    const rows = await cached(`lookup:${placeId}`, () =>
      throttle(() =>
        nominatim.get('/lookup', { params: { osm_ids: `${type}${id}`, format: 'jsonv2', addressdetails: 1 } })
      ).then((r) => r.data)
    );

    const row = rows?.[0];
    if (!row) throw ApiError.notFound('No matching location found');
    return { address: row.display_name, placeId, lat: Number(row.lat), lng: Number(row.lon) };
  }

  if (address) {
    const [first] = await searchPlaces(address);
    if (!first) throw ApiError.notFound('No matching location found');
    return { address: first.description, placeId: first.placeId, lat: first.lat, lng: first.lng };
  }

  const row = await cached(`reverse:${lat},${lng}`, () =>
    throttle(() =>
      nominatim.get('/reverse', { params: { lat, lon: lng, format: 'jsonv2', addressdetails: 1 } })
    ).then((r) => r.data)
  );

  if (!row || row.error) throw ApiError.notFound('No address found for those coordinates');

  return {
    address: row.display_name,
    placeId: row.osm_id ? `osm:${row.osm_type?.[0]?.toUpperCase()}:${row.osm_id}` : null,
    lat: Number(row.lat),
    lng: Number(row.lon)
  };
}

async function getRoute(origin, destination) {
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;

  const { data } = await osrm.get(`/route/v1/driving/${coords}`, {
    params: { overview: 'full', geometries: 'polyline' }
  });

  if (data.code !== 'Ok' || !data.routes?.length) {
    throw ApiError.badRequest('No route found between those points');
  }

  const route = data.routes[0];
  return {
    distanceKm: route.distance / 1000,
    durationMin: Math.round(route.duration / 60),
    polyline: route.geometry, // same encoding Google uses, precision 5
    source: 'osrm'
  };
}

module.exports = { name: 'osm', searchPlaces, geocode, getRoute };
