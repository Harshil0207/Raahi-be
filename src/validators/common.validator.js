const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

const coordinates = z.object({
  lat: latitude,
  lng: longitude
});

const place = z.object({
  address: z.string().trim().min(3, 'Address is required'),
  placeId: z.string().trim().optional(),
  lat: latitude,
  lng: longitude
});

module.exports = { objectId, latitude, longitude, coordinates, place };
