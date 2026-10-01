const Ride = require('../models/Ride');
const Rider = require('../models/Rider');
const { rooms } = require('../config/socket');
const locationService = require('../services/location.service');
const { ROLES } = require('../constants/userRoles');

const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

// Membership of a ride room is checked against the database, not trusted from
// the client, otherwise anyone could listen in on someone else's trip.
async function canJoin(socket, rideId) {
  const ride = await Ride.findById(rideId).select('customerId riderId');
  if (!ride) return false;

  if (socket.user.role === ROLES.RIDER) {
    const rider = await Rider.findOne({ userId: socket.user._id }).select('_id');
    return Boolean(rider && ride.riderId && String(ride.riderId) === String(rider._id));
  }

  return String(ride.customerId) === String(socket.user._id);
}

function registerRideHandlers(io, socket) {
  socket.on('ride:join', async ({ rideId } = {}, ack) => {
    if (!rideId) return reply(ack, { success: false, message: 'rideId is required' });

    if (!(await canJoin(socket, rideId))) {
      return reply(ack, { success: false, message: 'You are not part of this ride' });
    }

    socket.join(rooms.ride(rideId));
    return reply(ack, { success: true });
  });

  /**
   * The latest rider position, on demand.
   *
   * Here rather than in the customer handlers because both sides of a ride want
   * it: the customer to see the approach, the rider to see the same distance
   * and ETA for the leg they are driving. The service checks membership against
   * the ride document, so this handler carries no permission logic of its own.
   *
   * This is what a client calls after a reconnect, rather than sitting silent
   * until the next position happens to arrive.
   */
  socket.on('rider:location:request', async ({ rideId } = {}, ack) => {
    try {
      const rider = socket.user.role === ROLES.RIDER
        ? await Rider.findOne({ userId: socket.user._id }).select('_id')
        : null;

      const tracking = await locationService.getRideTracking(rideId, {
        userId: socket.user._id,
        riderId: rider?._id || null
      });
      return reply(ack, { success: true, data: tracking });
    } catch (err) {
      return reply(ack, { success: false, message: err.message });
    }
  });

  socket.on('ride:leave', ({ rideId } = {}, ack) => {
    if (rideId) socket.leave(rooms.ride(rideId));
    return reply(ack, { success: true });
  });
}

module.exports = registerRideHandlers;
