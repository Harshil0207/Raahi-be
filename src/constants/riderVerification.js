/**
 * Whether a rider is cleared to carry passengers.
 *
 * Google — or an email and a password — proves who somebody is. It says nothing
 * about whether they hold a licence, whether the vehicle exists, or whether
 * Raahi is willing to put a customer on the back of it. That is a separate
 * judgement, made by a person, and this is where it is recorded.
 *
 * GRANDFATHERED is not a status an admin can set. It exists so that riders who
 * were already working before any of this was introduced are not thrown off the
 * road by a deployment: they behave as approved, and they are visibly distinct
 * from the riders somebody actually looked at, so an operator can work through
 * them rather than being told everything is fine.
 */
const RIDER_VERIFICATION = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  GRANDFATHERED: 'GRANDFATHERED'
};

/** The statuses that let a rider go online. */
const CAN_GO_ONLINE = [RIDER_VERIFICATION.APPROVED, RIDER_VERIFICATION.GRANDFATHERED];

/** What an admin is allowed to set, which excludes the migration marker. */
const ADMIN_SETTABLE = [RIDER_VERIFICATION.APPROVED, RIDER_VERIFICATION.REJECTED, RIDER_VERIFICATION.PENDING];

const ALL_VERIFICATION_STATUSES = Object.values(RIDER_VERIFICATION);

module.exports = {
  RIDER_VERIFICATION,
  CAN_GO_ONLINE,
  ADMIN_SETTABLE,
  ALL_VERIFICATION_STATUSES
};
