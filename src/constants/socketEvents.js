const SOCKET_EVENTS = {
  RIDE_NEW: 'ride:new',
  RIDE_ACCEPTED: 'ride:accepted',
  RIDE_REJECTED: 'ride:rejected',
  RIDE_EXPIRED: 'ride:expired',
  RIDE_NO_RIDERS: 'ride:no_riders',
  RIDE_ARRIVING: 'ride:arriving',
  // The rider crossed the nearby threshold. Sent once per trip; see the latch
  // on `ride.tracking.nearbyNotifiedAt`.
  RIDE_RIDER_NEARBY: 'ride:rider_nearby',
  RIDE_ARRIVED: 'ride:arrived',
  RIDE_STARTED: 'ride:started',
  RIDE_COMPLETED: 'ride:completed',
  RIDE_CANCELLED: 'ride:cancelled',
  // The journey is over and the fare is fixed; the money has not landed yet.
  RIDE_AWAITING_PAYMENT: 'ride:awaiting_payment',
  RIDER_LOCATION: 'rider:location',
  LOCATION_UPDATE: 'location:update',
  PAYMENT_UPDATED: 'payment:updated',
  // The rider's balance moved, or the block on going online came or went. Sent
  // to the rider alone; a customer never learns what their driver owes.
  WALLET_UPDATED: 'wallet:updated',
  NOTIFICATION_NEW: 'notification:new'
};

module.exports = { SOCKET_EVENTS };
