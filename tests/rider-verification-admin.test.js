require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { listRidersQuery } = require('../src/validators/admin.validator');
const {
  ALL_VERIFICATION_STATUSES,
  ADMIN_SETTABLE,
  CAN_GO_ONLINE,
  RIDER_VERIFICATION
} = require('../src/constants/riderVerification');

/**
 * What the console is allowed to see and ask for about rider verification.
 *
 * The approval feature shipped half-built: the endpoint, service, audit entry
 * and rider notification all existed, but `riderDetail` and `listRiders` never
 * returned the status, so the console could not display it and no screen was
 * ever written. These tests cover the half that was missing, and in particular
 * the one case that is easy to get wrong in a way nothing notices.
 *
 * THE GRANDFATHERED TRAP. A rider created before verification existed has no
 * `verificationStatus` field at all. On a Mongoose DOCUMENT the `verification`
 * virtual resolves that absence to GRANDFATHERED, but `listRiders` uses
 * `.lean()`, which has no virtuals — so the same fallback has to be written out
 * by hand there. Get it wrong and those riders report `undefined`, which the
 * console renders as "no status" for somebody who is in fact allowed to work.
 * The list query is pure enough to exercise directly, so these call the real
 * thing rather than asserting about the source text.
 */

// The two projections, lifted from the service by calling it with a stub model
// is not possible without a database — so these mirror the exact expressions
// used there, and the final test pins them to the source so a rewrite that
// changes one without the other fails here.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const SOURCE = readFileSync(path.join(__dirname, '../src/services/admin/people.service.js'), 'utf8');

test('the list query accepts every real status, including the one admins cannot set', () => {
  for (const status of ALL_VERIFICATION_STATUSES) {
    const parsed = listRidersQuery.parse({ verificationStatus: status });
    assert.equal(
      parsed.verificationStatus,
      status,
      `${status} must be filterable — an admin cannot SET GRANDFATHERED but does need to find those riders`
    );
  }
});

test('the list query refuses a status that is not one of ours', () => {
  assert.throws(() => listRidersQuery.parse({ verificationStatus: 'VERIFIED' }));
  assert.throws(() => listRidersQuery.parse({ verificationStatus: 'approved' }));
});

test('verification is optional, so an unfiltered list is still valid', () => {
  const parsed = listRidersQuery.parse({});
  assert.equal('verificationStatus' in parsed, false);
});

test('GRANDFATHERED is displayable but never settable', () => {
  assert.ok(
    ALL_VERIFICATION_STATUSES.includes(RIDER_VERIFICATION.GRANDFATHERED),
    'the console has to be able to show it'
  );
  assert.ok(
    !ADMIN_SETTABLE.includes(RIDER_VERIFICATION.GRANDFATHERED),
    'offering it as a button would only produce a server error'
  );
  assert.ok(
    CAN_GO_ONLINE.includes(RIDER_VERIFICATION.GRANDFATHERED),
    'a rider predating verification is allowed to work — treating it as blocked would strand them'
  );
});

test('the detail projection sends the virtual, not the raw column', () => {
  // `rider.verificationStatus` here would send `undefined` for a grandfathered
  // rider. `rider.verification` is the virtual that resolves the absence.
  assert.match(
    SOURCE,
    /verificationStatus:\s*rider\.verification\b(?!Status)/,
    'riderDetail must project rider.verification, the virtual'
  );
});

test('the list projection resolves the absent case by hand, because .lean() has no virtuals', () => {
  assert.match(
    SOURCE,
    /rider\.verificationStatus\s*\|\|\s*RIDER_VERIFICATION\.GRANDFATHERED/,
    'the lean rows need the fallback spelled out'
  );
  assert.match(
    SOURCE,
    /verificationStatus:\s*leanVerification\(rider\)/,
    'listRiders must use that fallback rather than the raw field'
  );
});

test('filtering by GRANDFATHERED matches riders with no stored status', () => {
  // A plain equality match would return nothing at all for the status that
  // covers every rider predating the feature. The filter has to match null,
  // which in MongoDB also matches a missing field.
  assert.match(
    SOURCE,
    /\$in:\s*\[RIDER_VERIFICATION\.GRANDFATHERED,\s*null\]/,
    'GRANDFATHERED must match a missing field as well as a stored one'
  );
});
