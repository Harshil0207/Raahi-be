const ApiError = require('../utils/ApiError');

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(ApiError.forbidden(`This endpoint is restricted to: ${roles.join(', ')}`));
  }
  next();
};

module.exports = { authorize };
