const express = require('express');
const locationController = require('../controllers/location.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { locationLimiter } = require('../middleware/rateLimit.middleware');
const { locationSchema } = require('../validators/location.validator');

const router = express.Router();

router.use(authenticate);

router.post('/', locationLimiter, validate({ body: locationSchema }), locationController.save);
router.get('/current', locationController.current);

module.exports = router;
