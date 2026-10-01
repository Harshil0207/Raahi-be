const mapsService = require('../services/maps.service');
const fareService = require('../services/fare.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok } = require('../utils/response');

const search = asyncHandler(async (req, res) => {
  const { q, lat, lng } = req.query;
  const results = await mapsService.searchPlaces(q, { lat, lng });
  return ok(res, { results });
});

const geocode = asyncHandler(async (req, res) => {
  const result = await mapsService.geocode(req.query);
  return ok(res, result);
});

// Returns the route together with the fare it would produce, so the customer app
// never has to compute (or be trusted with) pricing.
const directions = asyncHandler(async (req, res) => {
  const { originLat, originLng, destLat, destLng } = req.query;

  const route = await mapsService.getRoute(
    { lat: originLat, lng: originLng },
    { lat: destLat, lng: destLng }
  );
  // Every bookable service quoted for this distance, so the selection screen
  // shows real prices rather than multiplying a rate in the browser. `fare`
  // stays for callers that only want the default quote.
  const services = fareService.quoteAll(route.distanceKm);
  const fare = fareService.estimateFare(route.distanceKm);

  return ok(res, { route, fare, services });
});

module.exports = { search, geocode, directions };
