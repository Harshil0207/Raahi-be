const express = require('express');
const { z } = require('zod');
const mapController = require('../controllers/map.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { latitude, longitude } = require('../validators/common.validator');

const router = express.Router();

const searchSchema = z.object({
  q: z.string().trim().min(2, 'Search text is too short'),
  lat: latitude.optional(),
  lng: longitude.optional()
});

const geocodeSchema = z
  .object({
    address: z.string().trim().min(3).optional(),
    placeId: z.string().trim().optional(),
    lat: latitude.optional(),
    lng: longitude.optional()
  })
  .refine(
    (d) => d.address || d.placeId || (d.lat !== undefined && d.lng !== undefined),
    { message: 'Provide address, placeId, or lat and lng' }
  );

const directionsSchema = z.object({
  originLat: latitude,
  originLng: longitude,
  destLat: latitude,
  destLng: longitude
});

router.use(authenticate);

router.get('/search', validate({ query: searchSchema }), mapController.search);
router.get('/geocode', validate({ query: geocodeSchema }), mapController.geocode);
router.get('/directions', validate({ query: directionsSchema }), mapController.directions);

module.exports = router;
