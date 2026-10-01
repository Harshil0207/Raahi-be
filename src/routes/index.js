const express = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const riderRoutes = require('./rider.routes');
const rideRoutes = require('./ride.routes');
const locationRoutes = require('./location.routes');
const mapRoutes = require('./map.routes');
const paymentRoutes = require('./payment.routes');
const placeRoutes = require('./place.routes');
const notificationRoutes = require('./notification.routes');
const chatRoutes = require('./chat.routes');
const assistantRoutes = require('./assistant.routes');
const complaintRoutes = require('./complaint.routes');
const settingsRoutes = require('./settings.routes');
const adminRoutes = require('./admin');
const { authenticate } = require('../middleware/auth.middleware');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/riders', riderRoutes);
router.use('/rides', rideRoutes);
router.use('/location', locationRoutes);
router.use('/maps', mapRoutes);
router.use('/payments', paymentRoutes);
router.use('/places', placeRoutes);
router.use('/notifications', notificationRoutes);
router.use('/chats', chatRoutes);
router.use('/complaints', complaintRoutes);

/**
 * The AI assistant, for customers and riders.
 *
 * `/assistant`, not `/chats`: `/chats` is the customer-to-rider conversation on
 * a live ride. Authentication is applied here rather than inside the router,
 * because the same router is mounted again under the admin console's own
 * authentication — see `routes/admin/index.js`.
 */
router.use('/assistant', authenticate, assistantRoutes);

// What the customer and rider apps are allowed to know about configuration.
router.use('/settings', settingsRoutes);

// The admin console. Its own authentication, so it is mounted as a whole.
router.use('/admin', adminRoutes);

module.exports = router;
