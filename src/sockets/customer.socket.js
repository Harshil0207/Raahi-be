const locationService = require('../services/location.service');
const { SOCKET_EVENTS } = require('../constants/socketEvents');

const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

function registerCustomerHandlers(io, socket) {
  // Customers push their device position too, so the app can pre-fill pickup.
  socket.on(SOCKET_EVENTS.LOCATION_UPDATE, async (payload, ack) => {
    try {
      const location = await locationService.saveDeviceLocation(socket.user._id, payload || {});
      return reply(ack, { success: true, data: location });
    } catch (err) {
      return reply(ack, { success: false, message: err.message });
    }
  });

}

module.exports = registerCustomerHandlers;
