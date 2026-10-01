/**
 * Why a ride was called off.
 *
 * Stored as a code rather than free text so the reasons can be counted: "how
 * often are riders cancelling because the pickup was unsafe" is a question an
 * operator will ask, and it cannot be answered against a text box. `other`
 * carries a note instead, which is the honest way to leave room for the case
 * nobody listed.
 */
const CUSTOMER_CANCEL_REASONS = {
  changed_plans: 'Changed plans',
  rider_too_long: 'Rider taking too long',
  wrong_pickup: 'Wrong pickup location',
  other: 'Other'
};

const RIDER_CANCEL_REASONS = {
  customer_unreachable: 'Customer unreachable',
  unsafe_pickup: 'Unsafe pickup',
  wrong_location: 'Wrong location',
  other: 'Other'
};

const reasonsFor = (side) => (side === 'rider' ? RIDER_CANCEL_REASONS : CUSTOMER_CANCEL_REASONS);

module.exports = { CUSTOMER_CANCEL_REASONS, RIDER_CANCEL_REASONS, reasonsFor };
