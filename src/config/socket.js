const { Server } = require('socket.io');
const env = require('./env');

let io = null;

function createSocketServer(httpServer) {
  io = new Server(httpServer, {
    cors: {
      // The same origins the REST API allows — all of them, not just the
      // first. See the note in app.js.
      origin: [...new Set([...env.frontendUrls, env.admin.url].filter(Boolean))],
      credentials: true
    },
    pingTimeout: 30000
  });

  return io;
}

// Services emit through this rather than importing the socket layer, which keeps
// the dependency one-way and lets REST handlers run in tests without a server.
function getIo() {
  return io;
}

const rooms = {
  customer: (userId) => `customer:${userId}`,
  rider: (riderId) => `rider:${riderId}`,
  ride: (rideId) => `ride:${rideId}`,
  // Every connected socket joins this, whichever role it is. Anything addressed
  // to a person rather than to their part in a ride — notifications, support
  // replies — goes here, so a rider is reachable without knowing their rider id.
  user: (userId) => `user:${userId}`,

  // Admin consoles watching the live board. Joined only by an admin who holds
  // rides.read, so the room's contents are already authorised by membership.
  adminRides: () => 'admins:rides'
};

module.exports = { createSocketServer, getIo, rooms };
