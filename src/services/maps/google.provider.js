const { googleMaps } = require('../../config/googleMaps');
const ApiError = require('../../utils/ApiError');

// Google reports its failures in the body with HTTP 200, so status has to be read.
function unwrap(data) {
  if (data.status === 'OK' || data.status === 'ZERO_RESULTS') return data;
  throw ApiError.badRequest(data.error_message || `Google Maps error: ${data.status}`);
}

async function searchPlaces(query, { lat, lng } = {}) {
  const params = { input: query, types: 'geocode' };
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    params.location = `${lat},${lng}`;
    params.radius = 50000;
  }

  const { data } = await googleMaps.get('/place/autocomplete/json', { params });
  unwrap(data);

  // Autocomplete has no coordinates; the caller geocodes the chosen placeId.
  return (data.predictions || []).map((p) => ({
    placeId: p.place_id,
    description: p.description,
    mainText: p.structured_formatting?.main_text,
    secondaryText: p.structured_formatting?.secondary_text,
    lat: null,
    lng: null
  }));
}

async function geocode({ address, placeId, lat, lng }) {
  const params = {};
  if (placeId) params.place_id = placeId;
  else if (address) params.address = address;
  else params.latlng = `${lat},${lng}`;

  const { data } = await googleMaps.get('/geocode/json', { params });
  unwrap(data);

  const result = data.results?.[0];
  if (!result) throw ApiError.notFound('No matching location found');

  return {
    address: result.formatted_address,
    placeId: result.place_id,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng
  };
}

async function getRoute(origin, destination) {
  const { data } = await googleMaps.get('/directions/json', {
    params: {
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      mode: 'driving'
    }
  });
  unwrap(data);

  const leg = data.routes?.[0]?.legs?.[0];
  if (!leg) throw ApiError.badRequest('No route found between those points');

  return {
    distanceKm: leg.distance.value / 1000,
    durationMin: Math.round(leg.duration.value / 60),
    polyline: data.routes[0].overview_polyline?.points,
    source: 'google'
  };
}

module.exports = { name: 'google', searchPlaces, geocode, getRoute };
