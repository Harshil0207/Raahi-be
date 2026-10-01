const User = require('../models/User');
const Rider = require('../models/Rider');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../utils/generateToken');
const { ROLES } = require('../constants/userRoles');

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.accessToken || null;
}

const authenticate = asyncHandler(async (req, res, next) => {
  const token = readToken(req);
  if (!token) throw ApiError.unauthorized();

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    throw ApiError.unauthorized('Access token is invalid or expired');
  }

  const user = await User.findById(decoded.sub);
  if (!user || !user.isActive) throw ApiError.unauthorized('Account is no longer active');

  req.user = user;
  next();
});

// Loads the rider profile for rider-only routes so controllers don't repeat the lookup.
const loadRider = asyncHandler(async (req, res, next) => {
  if (req.user.role !== ROLES.RIDER) throw ApiError.forbidden('This endpoint is for riders only');

  const rider = await Rider.findOne({ userId: req.user._id });
  if (!rider) throw ApiError.notFound('Rider profile not found');

  req.rider = rider;
  next();
});

/**
 * Attaches the rider profile when the caller is one, and does nothing when they
 * are not.
 *
 * For endpoints both sides of a ride may call. `loadRider` refuses a customer
 * outright, which is right for rider-only routes and wrong for shared ones: the
 * payment read and the payment poll are owned by a customer *or* a rider, and
 * without this a rider reached them with no profile attached and was turned away
 * from their own ride.
 */
const attachRider = asyncHandler(async (req, res, next) => {
  if (req.user?.role === ROLES.RIDER) {
    req.rider = await Rider.findOne({ userId: req.user._id });
  }
  next();
});

module.exports = { authenticate, loadRider, attachRider };
