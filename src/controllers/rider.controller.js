const riderService = require('../services/rider.service');
const earningsService = require('../services/earnings.service');
const rideService = require('../services/ride.service');
const locationService = require('../services/location.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/response');

const getProfile = asyncHandler(async (req, res) => {
  const profile = await riderService.getProfile(req.rider);
  return ok(res, profile);
});

const updateProfile = asyncHandler(async (req, res) => {
  const profile = await riderService.updateProfile(req.rider, req.body);
  return ok(res, profile, 'Profile updated');
});

const setStatus = asyncHandler(async (req, res) => {
  const profile = await riderService.setStatus(req.rider, req.body.isOnline);
  return ok(res, profile, req.body.isOnline ? 'You are online' : 'You are offline');
});

const updateLocation = asyncHandler(async (req, res) => {
  const result = await locationService.updateRiderLocation(req.rider, req.body);
  return ok(res, result, 'Location updated');
});

const listRideRequests = asyncHandler(async (req, res) => {
  const requests = await rideService.listRideRequests(req.rider);
  return ok(res, { requests });
});

const acceptRideRequest = asyncHandler(async (req, res) => {
  const result = await rideService.acceptRideRequest(req.rider, req.params.requestId);
  return ok(res, result, 'Ride accepted');
});

const rejectRideRequest = asyncHandler(async (req, res) => {
  const result = await rideService.rejectRideRequest(req.rider, req.params.requestId);
  return ok(res, result, 'Ride request rejected');
});

const earnings = asyncHandler(async (req, res) => {
  const result = await earningsService.getEarnings(req.rider._id, req.query);
  return ok(res, result);
});

const stats = asyncHandler(async (req, res) => {
  const result = await earningsService.getStats(req.rider);
  return ok(res, result);
});

const activeRide = asyncHandler(async (req, res) => {
  const ride = await riderService.getActiveRide(req.rider);
  return ok(res, ride ? rideService.serialiseRide(ride) : null);
});

/**
 * Creating the rider profile after a Google sign-up.
 *
 * Mounted above the rider-only block, because the whole point is that there is
 * no rider profile yet — `loadRider` would refuse it with "rider profile not
 * found", which is precisely the state this fixes.
 */
const createProfile = asyncHandler(async (req, res) => {
  const rider = await riderService.createProfile(req.user, req.body);
  return created(res, { rider }, 'Rider profile created. It is now waiting for approval.');
});

module.exports = {
  createProfile,
  getProfile,
  updateProfile,
  setStatus,
  updateLocation,
  listRideRequests,
  acceptRideRequest,
  rejectRideRequest,
  earnings,
  stats,
  activeRide
};
