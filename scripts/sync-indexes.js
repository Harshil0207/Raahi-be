/**
 * Brings the database's indexes in line with the models.
 *
 * Mongoose creates indexes it finds in a schema, but it never removes one that
 * has been taken out — so changing the definition of a unique index leaves the
 * OLD one in place, still enforcing the old rule. That is not a tidiness
 * problem; it is a live bug, because the stale constraint keeps rejecting the
 * writes the new definition was meant to allow.
 *
 * The case this was written for: ride offers were uniquely keyed on
 * `{rideId, riderId}`, meaning a rider could be offered a given ride exactly
 * once, ever. "Request again" dispatches a second round to the same nearby
 * riders, so every insert in that round collided — the request failed and the
 * rider's phone never rang. The model now keys on `{rideId, riderId, round}`,
 * but until the old index is dropped the old rule still applies.
 *
 * Usage:
 *   node scripts/sync-indexes.js          # report what would change
 *   node scripts/sync-indexes.js --apply  # drop superseded indexes, build new
 *
 * Safe to run repeatedly. It only ever drops an index that the models no
 * longer declare, and never touches `_id_`.
 */
const mongoose = require('mongoose');
const env = require('../src/config/env');

// Every model that owns indexes. Required for their side effects: registering
// the schema is what makes `syncIndexes` able to compare.
const MODELS = [
  '../src/models/Ride',
  '../src/models/RideRequest',
  '../src/models/Rider',
  '../src/models/User',
  '../src/models/Payment',
  '../src/models/Recharge',
  '../src/models/RiderWallet',
  '../src/models/WalletLedger',
  '../src/models/Complaint',
  '../src/models/Notification',
  '../src/models/Admin'
];

const APPLY = process.argv.includes('--apply');

/**
 * The rules an index enforces, in a form the two sides can be compared in.
 *
 * MongoDB reports an index's options as present-or-absent; a schema declares
 * them as flags. Normalising both to the same three fields is what lets a
 * changed rule be seen at all — comparing the raw objects would report drift on
 * every index, because the collection's copy also carries `v`, `name` and `key`.
 */
const shape = (options = {}) => ({
  unique: Boolean(options.unique),
  sparse: Boolean(options.sparse),
  partial: options.partialFilterExpression ? JSON.stringify(options.partialFilterExpression) : null
});

async function main() {
  for (const path of MODELS) {
    try {
      require(path);
    } catch {
      // A model that is not present in this checkout is simply skipped.
    }
  }

  await mongoose.connect(env.mongoUri);
  console.log(`\n  Connected to ${mongoose.connection.name}\n`);

  let changed = 0;

  for (const name of mongoose.modelNames()) {
    const Model = mongoose.model(name);

    // What the collection has now, and what the schema asks for.
    let existing = [];
    try {
      existing = await Model.collection.indexes();
    } catch {
      // No collection yet: nothing to reconcile.
      continue;
    }

    const wanted = new Map(
      Model.schema.indexes().map(([fields, options]) => [JSON.stringify(fields), shape(options)])
    );

    const superseded = existing.filter((idx) => idx.name !== '_id_' && !wanted.has(JSON.stringify(idx.key)));

    /**
     * Indexes whose KEY still matches but whose rules have changed.
     *
     * This used to be invisible here, and it is the more dangerous of the two.
     * Changing `sparse: true` to a partial filter, or adding `unique`, leaves
     * the key untouched — so nothing was reported, `syncIndexes` below was
     * skipped by the early `continue`, and the old rule went on being enforced
     * against writes the new definition was written to allow. It cost a live
     * bug once: every payment after the first was refused by a unique index
     * that was meant to apply only to refunded ones.
     */
    const drifted = existing.filter((idx) => {
      if (idx.name === '_id_') return false;
      const target = wanted.get(JSON.stringify(idx.key));
      return target && JSON.stringify(shape(idx)) !== JSON.stringify(target);
    });

    if (!superseded.length && !drifted.length) {
      console.log(`  ${name}: up to date (${existing.length} indexes)`);
      // Still reconciled under --apply, because an index the schema declares
      // and the collection has never had would otherwise never be built here.
      if (APPLY) await Model.syncIndexes();
      continue;
    }

    changed += superseded.length + drifted.length;

    for (const idx of superseded) {
      const label = `${name}.${idx.name} ${JSON.stringify(idx.key)}${idx.unique ? ' UNIQUE' : ''}`;

      if (!APPLY) {
        console.log(`  would drop  ${label}`);
        continue;
      }

      await Model.collection.dropIndex(idx.name);
      console.log(`  dropped     ${label}`);
    }

    for (const idx of drifted) {
      const was = JSON.stringify(shape(idx));
      const now = JSON.stringify(wanted.get(JSON.stringify(idx.key)));
      console.log(`  ${APPLY ? 'rebuilding  ' : 'would rebuild '}${name}.${idx.name}  ${was} → ${now}`);
    }

    if (APPLY) {
      // Drops and recreates anything whose options no longer match, which is
      // what repairs the drifted ones above.
      await Model.syncIndexes();
      console.log(`  rebuilt     ${name} from the schema`);
    }
  }

  if (!changed) {
    console.log('\n  Nothing to do — every index matches its model.\n');
  } else if (APPLY) {
    console.log(`\n  Done. ${changed} superseded index(es) removed.\n`);
  } else {
    console.log(
      `\n  ${changed} superseded index(es) found. Re-run with --apply to remove them:\n` +
        '    node scripts/sync-indexes.js --apply\n'
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`\n  Failed: ${err.message}\n`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
