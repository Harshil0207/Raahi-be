/**
 * What the platform will carry, and how each service is priced.
 *
 * Two axes, kept apart on purpose. `bookingType` is what the job *is* — moving
 * a person or moving a package — and it decides which fields a booking needs
 * and how the rider's screen reads. `serviceType` is what turns up to do it,
 * and it decides the rate.
 *
 * They are not the same axis: a bike carries both people and parcels, at
 * different prices, and folding the two into one enum would mean either losing
 * the price difference or inventing a vehicle that does not exist.
 *
 * The rates here are only the values a fresh installation starts with. They
 * live in platform settings from then on, and a ride keeps whatever it was
 * quoted at — see `fare.service.js`.
 */

const BOOKING_TYPE = {
  RIDE: 'RIDE',
  PARCEL: 'PARCEL'
};

const SERVICE_TYPE = {
  BIKE: 'BIKE',
  AUTO: 'AUTO',
  CAR: 'CAR',
  AMBULANCE: 'AMBULANCE',
  BIKE_PARCEL: 'BIKE_PARCEL',
  AUTO_PARCEL: 'AUTO_PARCEL'
};

/**
 * The catalogue. `vehicle` is the rider vehicle that can serve the job, which
 * is how a request is matched to the riders who can actually take it — a bike
 * rider gets bike work and bike parcels, and nothing else.
 */
const SERVICES = {
  [SERVICE_TYPE.BIKE]: {
    bookingType: BOOKING_TYPE.RIDE,
    vehicle: 'bike',
    label: 'Bike',
    description: 'One passenger, quickest through traffic',
    defaultRatePerKm: 6,
    order: 1
  },
  [SERVICE_TYPE.AUTO]: {
    bookingType: BOOKING_TYPE.RIDE,
    vehicle: 'auto',
    label: 'Auto',
    description: 'Up to three passengers',
    defaultRatePerKm: 7,
    order: 2
  },
  [SERVICE_TYPE.CAR]: {
    bookingType: BOOKING_TYPE.RIDE,
    vehicle: 'car',
    label: 'Car',
    description: 'Up to four passengers, air conditioned',
    defaultRatePerKm: 8,
    order: 3
  },
  [SERVICE_TYPE.AMBULANCE]: {
    bookingType: BOOKING_TYPE.RIDE,
    vehicle: 'car',
    label: 'Ambulance',
    description: 'Medical transport',
    // Free at the point of use. It is a real rate of zero, not a missing one,
    // so the fare still calculates and the trip still settles — at nothing.
    defaultRatePerKm: 0,
    order: 4
  },
  [SERVICE_TYPE.BIKE_PARCEL]: {
    bookingType: BOOKING_TYPE.PARCEL,
    vehicle: 'bike',
    label: 'Bike Parcel',
    description: 'Small packages, fastest',
    defaultRatePerKm: 9,
    order: 5
  },
  [SERVICE_TYPE.AUTO_PARCEL]: {
    bookingType: BOOKING_TYPE.PARCEL,
    vehicle: 'auto',
    label: 'Auto Parcel',
    description: 'Larger or heavier packages',
    defaultRatePerKm: 10,
    order: 6
  }
};

const ALL_SERVICE_TYPES = Object.keys(SERVICES);

const servicesOfBookingType = (bookingType) =>
  ALL_SERVICE_TYPES.filter((type) => SERVICES[type].bookingType === bookingType);

/** Which rider vehicles can serve this job. */
const vehicleFor = (serviceType) => SERVICES[serviceType]?.vehicle || null;

const isParcel = (serviceType) => SERVICES[serviceType]?.bookingType === BOOKING_TYPE.PARCEL;

/**
 * The booking type a service implies. Taking it from the catalogue rather than
 * from the request means a client cannot book a parcel at passenger prices by
 * sending a mismatched pair.
 */
const bookingTypeOf = (serviceType) => SERVICES[serviceType]?.bookingType || null;

/** Package sizes a parcel can declare. Deliberately coarse. */
const PACKAGE_SIZE = {
  SMALL: 'SMALL',
  MEDIUM: 'MEDIUM',
  LARGE: 'LARGE'
};

const PACKAGE_SIZE_LABEL = {
  [PACKAGE_SIZE.SMALL]: 'Small — fits in a backpack',
  [PACKAGE_SIZE.MEDIUM]: 'Medium — a carton or two',
  [PACKAGE_SIZE.LARGE]: 'Large — needs the footwell'
};

module.exports = {
  BOOKING_TYPE,
  ALL_BOOKING_TYPES: Object.values(BOOKING_TYPE),
  SERVICE_TYPE,
  ALL_SERVICE_TYPES,
  SERVICES,
  servicesOfBookingType,
  vehicleFor,
  isParcel,
  bookingTypeOf,
  PACKAGE_SIZE,
  ALL_PACKAGE_SIZES: Object.values(PACKAGE_SIZE),
  PACKAGE_SIZE_LABEL
};
