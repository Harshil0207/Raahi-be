const User = require('../models/User');
const Rider = require('../models/Rider');
const logger = require('../utils/logger');
const { createSocketServer, rooms } = require('../config/socket');
const { verifyAccessToken } = require('../utils/generateToken');
const { verifyAdminToken } = require('../utils/adminToken');
const Admin = require('../models/Admin');
const { PERMISSIONS } = require('../constants/adminRoles');
const { ROLES } = require('../constants/userRoles');
const registerRiderHandlers = require('./rider.socket');
const registerCustomerHandlers = require('./customer.socket');
const registerRideHandlers = require('./ride.socket');
const registerChatHandlers = require('./chat.socket');

/**
 * The same access token the REST API uses; an unauthenticated socket never
 * connects.
 *
 * A connection declares which kind of token it carries. Admin tokens are signed
 * with a different key, so the two can never be confused — but the client says
 * which it is rather than the server trying both, because attempting a customer
 * verification on an admin token and vice versa would turn every admin
 * connection into two failed signature checks.
 */
async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication token is required'));

  if (socket.handshake.auth?.scope === 'admin') return authenticateAdminSocket(socket, token, next);

  try {
    const decoded = verifyAccessToken(token);
    const user = await User.findById(decoded.sub);
    if (!user || !user.isActive) return next(new Error('Account is no longer active'));

    socket.user = user;

    if (user.role === ROLES.RIDER) {
      const rider = await Rider.findOne({ userId: user._id });
      if (!rider) return next(new Error('Rider profile not found'));
      socket.rider = rider;
    }

    return next();
  } catch {
    return next(new Error('Authentication failed'));
  }
}

/**
 * An admin console watching the live board.
 *
 * Read-only: an admin socket registers no handlers and joins one room. It cannot
 * reach the chat or ride handlers, which resolve their caller from `socket.user`
 * — an admin socket has none, so those handlers are simply not registered for it.
 */
async function authenticateAdminSocket(socket, token, next) {
  try {
    const decoded = verifyAdminToken(token);
    const admin = await Admin.findById(decoded.sub);

    if (!admin || !admin.isActive) return next(new Error('This admin account is not active'));
    if ((decoded.ver ?? 0) !== admin.tokenVersion) return next(new Error('Admin session has ended'));

    socket.admin = admin;
    return next();
  } catch {
    return next(new Error('Authentication failed'));
  }
}

function initSocketServer(httpServer) {
  const io = createSocketServer(httpServer);

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const { user, rider, admin } = socket;

    // An admin console only watches. It joins the live-board room when it is
    // allowed to see rides at all, registers no handlers, and is done.
    if (admin) {
      if (admin.can(PERMISSIONS.RIDES_READ)) socket.join(rooms.adminRides());

      logger.info(`Admin socket connected: ${admin.email}`);
      socket.on('disconnect', () => logger.info(`Admin socket disconnected: ${admin.email}`));
      return;
    }

    // Addressable as a person regardless of role.
    socket.join(rooms.user(user._id));

    if (rider) {
      socket.join(rooms.rider(rider._id));
      if (rider.activeRideId) socket.join(rooms.ride(rider.activeRideId));
      registerRiderHandlers(io, socket);
    } else {
      socket.join(rooms.customer(user._id));
      registerCustomerHandlers(io, socket);
    }

    registerRideHandlers(io, socket);
    registerChatHandlers(io, socket);

    logger.info(`Socket connected: ${user.role} ${user._id}`);

    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${user.role} ${user._id} (${reason})`);
    });
  });

  return io;
}

module.exports = { initSocketServer };
