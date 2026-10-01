const env = require('../config/env');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');

function notFound(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// Translates the errors Mongoose/JWT throw into the same shape controllers use.
function normalise(err) {
  if (err instanceof ApiError) return err;

  if (err.name === 'ValidationError') {
    const fields = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    return ApiError.badRequest('Validation failed', fields);
  }

  if (err.name === 'CastError') {
    return ApiError.badRequest(`Invalid value for ${err.path}`);
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    return ApiError.conflict(`Duplicate value for ${field}`);
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return ApiError.unauthorized('Token is invalid or expired');
  }

  return null;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const known = normalise(err);

  if (!known) {
    logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong',
      ...(env.isProduction ? {} : { stack: err.stack })
    });
  }

  if (known.status >= 500) logger.error(known.message, err);

  return res.status(known.status).json({
    success: false,
    message: known.message,
    ...(known.details ? { errors: known.details } : {})
  });
}

module.exports = { notFound, errorHandler };
