const { getIo, rooms } = require('../config/socket');

// Emitting is best-effort: a disconnected client catches up over REST, so a
// missing socket server (tests, workers) must never break a business flow.
function emit(room, event, payload) {
  const io = getIo();
  if (!io) return;
  io.to(room).emit(event, payload);
}

const toCustomer = (userId, event, payload) => emit(rooms.customer(userId), event, payload);
// Reaches a person whichever role they signed in as.
const toUser = (userId, event, payload) => emit(rooms.user(userId), event, payload);
const toRider = (riderId, event, payload) => emit(rooms.rider(riderId), event, payload);
const toRide = (rideId, event, payload) => emit(rooms.ride(rideId), event, payload);

/**
 * Tells any watching admin console that a ride moved.
 *
 * Deliberately just the id and the new status: the console re-reads the board
 * over REST, where the permission check lives. Pushing the whole ride here would
 * mean duplicating that check in the socket layer.
 */
const toAdminBoard = (rideId, status) =>
  emit(rooms.adminRides(), 'admin:ride:moved', { rideId, status, at: new Date() });

module.exports = { emit, toCustomer, toUser, toRider, toRide, toAdminBoard };
