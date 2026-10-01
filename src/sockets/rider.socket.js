const Rider = require('../models/Rider');
const locationService = require('../services/location.service');
const rideService = require('../services/ride.service');
const logger = require('../utils/logger');
const { rooms } = require('../config/socket');
const { SOCKET_EVENTS } = require('../constants/socketEvents');

// Socket handlers stay thin: they reload the rider so state is fresh, call the
// same service the REST endpoint uses, and reply through the ack callback.
const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

function registerRiderHandlers(io, socket) {
  socket.on(SOCKET_EVENTS.LOCATION_UPDATE, async (payload, ack) => {
    try {
      const rider = await Rider.findById(socket.rider._id);
      if (!rider) return reply(ack, { success: false, message: 'Rider profile not found' });

      const result = await locationService.updateRiderLocation(rider, payload || {});
      socket.rider = rider;
      return reply(ack, { success: true, data: result });
    } catch (err) {
      logger.warn('Socket location update failed', err.message);
      return reply(ack, { success: false, message: err.message });
    }
  });

  // Accept over the socket is the same code path as the REST endpoint, so the
  // 20-second deadline and single-winner rules apply identically.
  socket.on('ride:accept', async ({ requestId } = {}, ack) => {
    try {
      const rider = await Rider.findById(socket.rider._id);
      const result = await rideService.acceptRideRequest(rider, requestId);

      socket.rider = rider;
      socket.join(rooms.ride(result.ride._id));
      return reply(ack, { success: true, data: result });
    } catch (err) {
      return reply(ack, { success: false, message: err.message });
    }
  });

  socket.on('ride:reject', async ({ requestId } = {}, ack) => {
    try {
      const result = await rideService.rejectRideRequest(socket.rider, requestId);
      return reply(ack, { success: true, data: result });
    } catch (err) {
      return reply(ack, { success: false, message: err.message });
    }
  });
}

module.exports = registerRiderHandlers;
