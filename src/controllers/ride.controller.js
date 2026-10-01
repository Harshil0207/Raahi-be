const rideService = require('../services/ride.service');
const locationService = require('../services/location.service');
const asyncHandler = require('../utils/asyncHandler');
const { ok, created } = require('../utils/response');

const create = asyncHandler(async (req, res) => {
  const result = await rideService.createRide(req.user._id, req.body);
  return created(res, result, 'Looking for a rider');
});

const list = asyncHandler(async (req, res) => {
  const result = await rideService.listRides(req.user, req.query);
  return ok(res, result);
});

const detail = asyncHandler(async (req, res) => {
  const ride = await rideService.getRide(req.params.rideId, req.user);
  return ok(res, ride);
});

/**
 * Asking again after nobody accepted, optionally on a different vehicle.
 *
 * The service type is the only thing the client may influence, and the backend
 * validates and reprices it — no fare, distance or rate crosses the wire in.
 */
const requestAgain = asyncHandler(async (req, res) => {
  const result = await rideService.requestAgain(req.params.rideId, req.user._id, {
    serviceType: req.body?.serviceType || null
  });
  return ok(res, result, result.dispatch.requested > 0 ? 'Asking riders again' : 'No riders nearby right now');
});

/** What the customer may switch to, priced for this ride's distance. */
const changeOptions = asyncHandler(async (req, res) => {
  const result = await rideService.changeOptions(req.params.rideId, req.user._id);
  return ok(res, result);
});

const cancel = asyncHandler(async (req, res) => {
  const ride = await rideService.cancelRide(req.params.rideId, req.user, {
    reasonCode: req.body.reasonCode,
    // The older clients' free-text field, read as the note it always was.
    note: req.body.note ?? req.body.reason
  });
  return ok(res, ride, 'Ride cancelled');
});

const arriving = asyncHandler(async (req, res) => {
  const ride = await rideService.markArriving(req.params.rideId, req.rider);
  return ok(res, ride, 'On the way to pickup');
});

const arrived = asyncHandler(async (req, res) => {
  const ride = await rideService.markArrived(req.params.rideId, req.rider);
  return ok(res, ride, 'Arrived at pickup');
});

const verifyOtp = asyncHandler(async (req, res) => {
  const ride = await rideService.verifyOtp(req.params.rideId, req.rider, req.body.otp);
  return ok(res, ride, 'OTP verified');
});

const start = asyncHandler(async (req, res) => {
  const ride = await rideService.startRide(req.params.rideId, req.rider);
  return ok(res, ride, 'Trip started');
});

const complete = asyncHandler(async (req, res) => {
  const result = await rideService.completeRide(req.params.rideId, req.rider, req.body);
  return ok(res, result, 'Trip completed');
});

const otp = asyncHandler(async (req, res) => {
  const result = await rideService.getOtpForCustomer(req.params.rideId, req.user._id);
  return ok(res, result);
});

const rate = asyncHandler(async (req, res) => {
  const result = await rideService.rateRide(req.params.rideId, req.user._id, req.body);
  return ok(res, result, 'Thanks for the feedback');
});

const rateCustomer = asyncHandler(async (req, res) => {
  const result = await rideService.rateCustomer(req.params.rideId, req.rider, req.body);
  return ok(res, result, 'Thanks for the feedback');
});

/**
 * Where the assigned rider is, how far off, and the ETA.
 *
 * Reachable by both sides of the ride: the customer watching the approach, and
 * the rider whose own screen shows the same figures for the leg they are
 * driving. `attachRider` has already loaded the rider profile when the caller
 * is one, so the service is handed both ids and decides for itself.
 */
const riderLocation = asyncHandler(async (req, res) => {
  const tracking = await locationService.getRideTracking(req.params.rideId, {
    userId: req.user._id,
    riderId: req.rider?._id || null
  });
  return ok(res, tracking);
});

module.exports = {
  requestAgain,
  changeOptions,
  create,
  list,
  detail,
  cancel,
  arriving,
  arrived,
  verifyOtp,
  start,
  complete,
  otp,
  rate,
  rateCustomer,
  riderLocation
};
