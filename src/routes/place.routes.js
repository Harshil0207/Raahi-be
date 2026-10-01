const express = require('express');
const { z } = require('zod');
const placeController = require('../controllers/place.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { objectId, latitude, longitude } = require('../validators/common.validator');

const router = express.Router();

const placeSchema = z.object({
  label: z.enum(['home', 'work', 'custom']).default('custom'),
  name: z.string().trim().min(1, 'Give this place a name').max(40),
  address: z.string().trim().min(3, 'Address is required'),
  placeId: z.string().trim().optional(),
  lat: latitude,
  lng: longitude
});

const paramsSchema = z.object({ placeId: objectId });

router.use(authenticate);

router.get('/', placeController.list);
router.post('/', validate({ body: placeSchema }), placeController.create);
router.patch('/:placeId', validate({ params: paramsSchema, body: placeSchema }), placeController.update);
router.delete('/:placeId', validate({ params: paramsSchema }), placeController.remove);

module.exports = router;
