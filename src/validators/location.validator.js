const { z } = require('zod');
const { latitude, longitude } = require('./common.validator');

const locationSchema = z.object({
  lat: latitude,
  lng: longitude,
  accuracy: z.coerce.number().nonnegative().optional(),
  heading: z.coerce.number().min(0).max(360).optional(),
  speed: z.coerce.number().nonnegative().optional()
});

module.exports = { locationSchema };
