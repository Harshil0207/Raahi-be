const RiderWallet = require('../models/RiderWallet');
const WalletLedger = require('../models/WalletLedger');
const Rider = require('../models/Rider');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const settings = require('./settings.service');
const notifications = require('./notification.service');
const { withTransaction } = require('../utils/withTransaction');
const { SOCKET_EVENTS } = require('../constants/socketEvents');
const { PAYMENT_METHOD } = require('../constants/paymentStatus');
const {
  LEDGER_TYPE,
  LEDGER_DIRECTION,
  SIGN,
  WALLET_STATUS,
  RIDER_BALANCE_LIMIT_REACHED,
  outstandingOf,
  availableOf,
  round2
} = require('../constants/finance');

/**
 * The rider's money: what they have earned, what they owe, and every movement
 * between the two.
 *
 * Three ideas hold this file together.
 *
 * ONE SIGNED BALANCE. Earnings payable and platform debt are the same axis read
 * from either end, so a cash ride and a UPI ride need no separate arithmetic.
 * The convention is written out in constants/finance.js.
 *
 * THE LEDGER IS THE TRUTH. RiderWallet is a running total kept for the sake of
 * fast reads. If the two ever disagree the ledger wins, and `reconcile` exists
 * to say so in code rather than in a comment.
 *
 * POSTING TWICE IS HARMLESS. Every entry carries a key derived from what caused
 * it, and a unique index refuses the second one. Nothing here asks "has this
 * already happened?" and then acts on the answer — that gap is precisely where
 * a webhook delivered twice would double a rider's debt.
 */

const LIFETIME_FIELD = {
  [LEDGER_TYPE.RIDE_EARNING]: 'lifetimeEarnings',
  [LEDGER_TYPE.PLATFORM_COMMISSION]: 'lifetimeCommission',
  [LEDGER_TYPE.CASH_COLLECTION]: 'lifetimeCashCollected',
  [LEDGER_TYPE.UPI_PAYMENT]: 'lifetimeUpiCollected',
  [LEDGER_TYPE.RIDER_RECHARGE]: 'lifetimeRecharged'
};

const DUPLICATE_KEY = 11000;

/**
 * Raised when a posting's key is already taken and we are inside a transaction.
 *
 * It has to travel out past the transaction before it can be handled: a
 * duplicate key aborts the transaction on the server, so every further write on
 * that session fails. `postGroup` catches this outside and re-drives the group,
 * which then finds the winner's rows and posts nothing.
 */
class DuplicatePosting extends Error {
  constructor(key) {
    super(`Ledger entry ${key} is already posted`);
    this.name = 'DuplicatePosting';
    this.idempotencyKey = key;
  }
}

// --------------------------------------------------------------- the account

async function walletFor(riderId, session = null) {
  const currency = settings.get('fare.currency');

  // Upsert rather than find-then-create: two rides finishing at once would
  // otherwise race to create the same wallet and one would fail.
  return RiderWallet.findOneAndUpdate(
    { riderId },
    { $setOnInsert: { riderId, currency, balance: 0 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
}

/** Read-only view. Creates nothing, so a rider who has never earned reads zero. */
async function walletOf(riderId) {
  const wallet = await RiderWallet.findOne({ riderId });
  if (wallet) return wallet;

  return new RiderWallet({ riderId, currency: settings.get('fare.currency'), balance: 0 });
}

// ---------------------------------------------------------------- the rules

const threshold = () => settings.get('finance.maxOutstandingBalance');

/**
 * Whether this much debt blocks a rider.
 *
 * Strictly greater than. Owing exactly the ceiling is still allowed — the
 * setting is the most a rider may carry, not the first forbidden amount — so
 * ₹150 against a ₹150 limit goes online and ₹150.01 does not.
 */
const blockedAt = (outstanding, limit = threshold()) => round2(outstanding) > round2(limit);

/** What the wallet's status should be right now, from its balance alone. */
const statusFor = (balance, limit = threshold()) =>
  blockedAt(outstandingOf(balance), limit) ? WALLET_STATUS.PAYMENT_REQUIRED : WALLET_STATUS.ACTIVE;

/**
 * The go-online decision, as a value rather than a thrown error, so callers can
 * report it as well as enforce it.
 */
async function checkCanGoOnline(riderId) {
  const wallet = await walletOf(riderId);
  const limit = threshold();
  const outstanding = outstandingOf(wallet.balance);

  if (!blockedAt(outstanding, limit)) {
    return { allowed: true, outstanding, threshold: limit, currency: wallet.currency };
  }

  // What it would take to get back on the road: enough to reach the ceiling,
  // but never less than the platform's minimum payment.
  const toClear = round2(outstanding - limit);
  const minimum = settings.get('finance.minimumRecharge');

  return {
    allowed: false,
    code: RIDER_BALANCE_LIMIT_REACHED,
    outstanding,
    threshold: limit,
    currency: wallet.currency,
    requiredRecharge: round2(Math.max(toClear, minimum))
  };
}

/** The same decision, enforced. Used on the way into going online. */
async function assertCanGoOnline(riderId) {
  const check = await checkCanGoOnline(riderId);
  if (check.allowed) return check;

  throw new ApiError(
    403,
    `Your platform balance is ${check.currency} ${check.outstanding.toFixed(2)}. Please recharge at least ${check.currency} ${check.requiredRecharge.toFixed(2)} to go online.`,
    [{ field: 'balance', message: RIDER_BALANCE_LIMIT_REACHED }]
  );
}

// --------------------------------------------------------------- the posting

/**
 * Writes one entry and moves the balance.
 *
 * Order matters and is deliberate. The wallet is incremented first, atomically,
 * which is what hands back the sequence number and the resulting balance
 * without a read-modify-write that two concurrent posts could interleave. The
 * ledger row is written second.
 *
 * A repeat is recognised three ways, innermost last:
 *
 *   1. The read below, which catches the ordinary case — a retry, a webhook
 *      delivered twice, a rider double-tapping — for the cost of one query and
 *      without touching the balance at all.
 *   2. The unique index, which catches the two that arrive at the same
 *      instant, when neither read saw the other's row yet.
 *   3. `reconcile`, which recomputes from the rows when all else has failed.
 *
 * The read is a convenience, not the guarantee; (2) is the guarantee.
 *
 * Between the two writes there is a window where the wallet is ahead of the
 * ledger. Inside a transaction it does not exist. Without one — a standalone
 * mongod — a crash in that window leaves the balance moved and no row to show
 * it, and because the retry's pre-check finds no row it will increment a second
 * time. `reconcile` is the repair, and it is the reason the ledger rather than
 * the balance is the record of truth. A replica set closes the window outright,
 * which is why production should have one.
 */
/**
 * What one entry does to a wallet, as arithmetic and nothing else.
 *
 * Pulled out of `postEntry` so the money can be checked without a database.
 * Every number the ledger writes comes from here — the magnitude, the signed
 * delta, and which lifetime counters move — so a test that drives this is
 * driving the real arithmetic rather than a second copy of it that agrees with
 * itself.
 */
function effectOf({ type, direction, amount }) {
  const magnitude = round2(Math.abs(Number(amount) || 0));
  const delta = round2(magnitude * SIGN[direction]);

  const inc = { balance: delta, sequence: 1 };

  const field = LIFETIME_FIELD[type];
  if (field) inc[field] = magnitude;
  // Gross, like every other lifetime counter. Net would report a ₹100 credit and
  // a ₹100 debit as "nothing was ever adjusted by hand", which is the opposite
  // of what an audit figure is for.
  if (type === LEDGER_TYPE.ADMIN_ADJUSTMENT) inc.lifetimeAdjustments = magnitude;

  return { magnitude, delta, inc };
}

async function postEntry(entry, session) {
  const {
    riderId,
    type,
    direction,
    description,
    idempotencyKey,
    currency,
    rideId = null,
    paymentId = null,
    rechargeId = null,
    paymentMethod = null,
    adminId = null,
    reason = null
  } = entry;

  const { magnitude, delta, inc } = effectOf(entry);

  // Already posted. Checked before the increment so the ordinary repeat costs a
  // read and moves nothing, rather than moving the balance and taking it back.
  const settled = await WalletLedger.findOne({ riderId, idempotencyKey }).session(session || null);
  if (settled) {
    return { entry: settled, wallet: await walletFor(riderId, session), posted: false };
  }

  const wallet = await RiderWallet.findOneAndUpdate(
    { riderId },
    {
      $inc: inc,
      $set: { lastEntryAt: new Date() },
      $setOnInsert: { riderId, currency: currency || settings.get('fare.currency') }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );

  const balanceAfter = round2(wallet.balance);
  const balanceBefore = round2(balanceAfter - delta);

  try {
    const [row] = await WalletLedger.create(
      [
        {
          riderId,
          sequence: wallet.sequence,
          type,
          direction,
          amount: magnitude,
          currency: wallet.currency,
          balanceBefore,
          balanceAfter,
          description,
          rideId,
          paymentId,
          rechargeId,
          paymentMethod,
          adminId,
          reason,
          idempotencyKey
        }
      ],
      { session, ordered: true }
    );

    return { entry: row, wallet, posted: true };
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY) throw err;

    // Two posts of the same entry arrived together and the other one won.
    //
    // Inside a transaction there is nothing to undo: the duplicate has already
    // aborted it on the server, so this increment will be rolled back for us and
    // any write we attempt on this session fails. Compensating here is what
    // turned a harmless double-tap into a 500. It goes out to `postGroup`
    // instead, which re-drives the group once the transaction is gone.
    if (session) throw new DuplicatePosting(idempotencyKey);

    // No transaction, so the increment is real and has to be taken back by hand.
    const restored = await RiderWallet.findOneAndUpdate(
      { riderId },
      { $inc: negate(inc) },
      { new: true }
    );

    const existing = await WalletLedger.findOne({ riderId, idempotencyKey });
    return { entry: existing, wallet: restored, posted: false };
  }
}

const negate = (inc) =>
  Object.fromEntries(Object.entries(inc).map(([key, value]) => [key, key === 'sequence' ? 0 : -value]));

/**
 * Posts a group of entries that belong together — a ride's earning, its
 * commission and what happened to the customer's money — and settles the
 * wallet's status once at the end.
 */
async function postGroup(riderId, entries) {
  const attempt = () =>
    withTransaction(async (session) => {
      await walletFor(riderId, session);

      const posted = [];
      let wallet = null;

      for (const entry of entries) {
        const outcome = await postEntry({ ...entry, riderId }, session);
        wallet = outcome.wallet;
        if (outcome.posted) posted.push(outcome.entry);
      }

      return { wallet, posted };
    });

  let result;
  try {
    result = await attempt();
  } catch (err) {
    if (!(err instanceof DuplicatePosting)) throw err;

    // The transaction aborted and rolled back everything this attempt had
    // posted, so there is no half-written group to clean up. Running it again
    // finds the winner's rows in the pre-check and posts nothing, which is the
    // right answer for a duplicate: the same result the first caller got.
    logger.warn(`Ledger entry ${err.idempotencyKey} raced another posting; re-reading it.`);
    result = await attempt();
  }

  const wallet = await applyStatus(result.wallet);
  if (result.posted.length) announce(riderId, wallet);

  return { wallet, posted: result.posted, alreadyPosted: result.posted.length === 0 };
}

/**
 * Brings `status` into line with the balance, and records the ceiling that
 * decision was made against.
 *
 * Kept out of `postEntry` on purpose: a ride posts three rows, and flipping the
 * status after each one would announce a rider as blocked halfway through
 * posting a ride that ends up leaving them well inside the limit.
 */
async function applyStatus(wallet) {
  if (!wallet) return wallet;

  const limit = threshold();
  const next = statusFor(wallet.balance, limit);

  if (wallet.status === next && wallet.thresholdAtStatus === limit) return wallet;

  return RiderWallet.findOneAndUpdate(
    { _id: wallet._id },
    { $set: { status: next, thresholdAtStatus: limit, statusChangedAt: new Date() } },
    { new: true }
  );
}

/** Tells the rider's own app, and nobody else's, that their money moved. */
function announce(riderId, wallet) {
  if (!wallet) return;

  notifications.toRider(riderId, SOCKET_EVENTS.WALLET_UPDATED, {
    ...wallet.toPublic(),
    // Carried so the app can put up the block without a second round trip.
    canGoOnline: wallet.status === WALLET_STATUS.ACTIVE
  });
}

// ------------------------------------------------------------- what to post

/**
 * The three lines a settled ride produces.
 *
 * Read them as a sentence. The rider earned their share of the fare. The
 * platform's commission is noted against the ride. And then, the part that
 * differs: with cash the rider physically took the customer's money, so it
 * comes off what they are owed; with UPI the platform took it, so nothing
 * leaves the rider's balance and the collection is recorded as a fact.
 *
 * That single difference is the whole of why a cash ride creates a debt and a
 * UPI ride does not. It is one branch, in one place.
 */
function rideEntries({ ride, split, method, paymentId }) {
  const id = String(ride._id);
  const currency = split.currency || ride.currency;
  const shortRef = id.slice(-6).toUpperCase();

  // A free service settles at zero for real — the ambulance is priced at ₹0 by
  // default, not left unpriced. One row saying nothing was owed reads better in
  // an audit than three rows of ₹0.00, and the arithmetic is the same either
  // way. The key matches the earning row's, so a free ride and a paid one can
  // never both post against the same ride.
  if (round2(split.fareAmount) === 0) {
    return [
      {
        type: LEDGER_TYPE.RIDE_EARNING,
        direction: LEDGER_DIRECTION.MEMO,
        amount: 0,
        currency,
        description: `Ride ${shortRef} — free of charge, nothing to settle`,
        idempotencyKey: `ride:${id}:earning`,
        rideId: ride._id,
        paymentId,
        paymentMethod: method
      }
    ];
  }

  const entries = [
    {
      type: LEDGER_TYPE.RIDE_EARNING,
      direction: LEDGER_DIRECTION.CREDIT,
      amount: split.riderEarningAmount,
      currency,
      // "the", not "a": the currency code sits between the article and the
      // noun, and "a INR 38.34 fare" is what a rider was reading in their own
      // wallet. The code rather than a symbol, because the platform is not
      // promised to be rupees forever.
      description: `Ride ${shortRef} — your share of the ${currency} ${split.fareAmount.toFixed(2)} fare`,
      idempotencyKey: `ride:${id}:earning`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method
    },
    {
      type: LEDGER_TYPE.PLATFORM_COMMISSION,
      direction: LEDGER_DIRECTION.MEMO,
      amount: split.platformCommissionAmount,
      currency,
      description: `Ride ${shortRef} — platform commission at ${split.platformCommissionRate}%`,
      idempotencyKey: `ride:${id}:commission`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method
    }
  ];

  if (method === PAYMENT_METHOD.CASH) {
    entries.push({
      type: LEDGER_TYPE.CASH_COLLECTION,
      direction: LEDGER_DIRECTION.DEBIT,
      amount: split.fareAmount,
      currency,
      description: `Ride ${shortRef} — cash collected from the customer`,
      idempotencyKey: `ride:${id}:collection`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method
    });
  } else {
    entries.push({
      type: LEDGER_TYPE.UPI_PAYMENT,
      direction: LEDGER_DIRECTION.MEMO,
      amount: split.fareAmount,
      currency,
      description: `Ride ${shortRef} — paid online, collected by the platform`,
      idempotencyKey: `ride:${id}:collection`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method
    });
  }

  return entries;
}

/**
 * What a rider is charged for calling off a ride they had accepted.
 *
 * A DEBIT, not a MEMO: the fee is real money the rider owes the platform, and
 * it belongs in the same balance the commission moves — which also means it
 * counts towards the outstanding figure that stops them going online, exactly
 * as an unpaid commission does. Nothing separate to chase.
 *
 * Keyed on the ride, so a cancellation delivered twice charges once.
 */
function cancellationEntry({ ride, amount, currency }) {
  const id = String(ride._id);

  return {
    type: LEDGER_TYPE.CANCELLATION_FEE,
    direction: LEDGER_DIRECTION.DEBIT,
    amount: round2(amount),
    currency: currency || ride.currency,
    description: `Ride ${id.slice(-6).toUpperCase()} — cancellation fee`,
    idempotencyKey: `ride:${id}:cancellation`,
    rideId: ride._id
  };
}

/** Charges a rider the cancellation fee. Safe to call twice. */
async function chargeCancellation({ ride, amount }) {
  if (!ride.riderId) throw ApiError.badRequest('A ride with no rider cannot be charged a cancellation fee');
  if (!(round2(amount) > 0)) return null;

  return postGroup(ride.riderId, [cancellationEntry({ ride, amount, currency: ride.currency })]);
}

/** Called once a ride's payment is genuinely settled. Safe to call twice. */
async function settleRide({ ride, split, method, paymentId }) {
  if (!ride.riderId) throw ApiError.badRequest('A ride with no rider cannot be settled');

  return postGroup(ride.riderId, rideEntries({ ride, split, method, paymentId }));
}

/**
 * Reversing a settled ride, line for line.
 *
 * A chargeback, a disputed trip, a fare refunded after the fact. The entries are
 * the exact mirror of what settlement posted, so the pair always nets to zero
 * and the balance lands back where it was before the ride — whichever way the
 * fare was collected:
 *
 *   cash ₹100 at 15%   settled -15, reversed +15
 *   UPI  ₹100 at 15%   settled +85, reversed -85
 *
 * What this deliberately does NOT do is decide who is out of pocket. On a cash
 * ride the rider is holding the customer's money, and whether the platform
 * recovers it from them is a commercial question with no single right answer —
 * so the reversal restores the accounting and an admin makes that call
 * explicitly, with an adjustment that carries their name and their reason. A
 * refund that silently invented a debt would be a policy decision hidden in a
 * ledger.
 */
function refundEntries({ ride, split, method, paymentId, reason }) {
  const id = String(ride._id);
  const currency = split.currency || ride.currency;
  const shortRef = id.slice(-6).toUpperCase();
  const cash = method === PAYMENT_METHOD.CASH;

  return [
    {
      type: LEDGER_TYPE.REFUND,
      direction: LEDGER_DIRECTION.DEBIT,
      amount: split.riderEarningAmount,
      currency,
      description: `Ride ${shortRef} — refunded, your share reversed`,
      idempotencyKey: `ride:${id}:refund:earning`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method,
      reason
    },
    {
      type: LEDGER_TYPE.REFUND,
      direction: LEDGER_DIRECTION.MEMO,
      amount: split.platformCommissionAmount,
      currency,
      description: `Ride ${shortRef} — refunded, platform commission reversed`,
      idempotencyKey: `ride:${id}:refund:commission`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method,
      reason
    },
    {
      type: LEDGER_TYPE.REFUND,
      // A cash collection moved the balance, so reversing it moves it back. A
      // UPI collection never did, so reversing it does not either.
      direction: cash ? LEDGER_DIRECTION.CREDIT : LEDGER_DIRECTION.MEMO,
      amount: split.fareAmount,
      currency,
      description: cash
        ? `Ride ${shortRef} — refunded, cash collection reversed`
        : `Ride ${shortRef} — refunded to the customer by the platform`,
      idempotencyKey: `ride:${id}:refund:collection`,
      rideId: ride._id,
      paymentId,
      paymentMethod: method,
      reason
    }
  ];
}

/** Posts a ride's reversal. Safe to call twice; the keys see to that. */
async function refundRide({ ride, split, method, paymentId, reason }) {
  if (!ride.riderId) throw ApiError.badRequest('A ride with no rider cannot be refunded');

  const trimmed = String(reason || '').trim();
  if (trimmed.length < 4) {
    throw ApiError.badRequest('Give a reason for the refund', [
      { field: 'reason', message: 'A reason of at least 4 characters is required' }
    ]);
  }

  if (round2(split.fareAmount) === 0) {
    throw ApiError.badRequest('There is nothing to refund on a free ride');
  }

  return postGroup(ride.riderId, refundEntries({ ride, split, method, paymentId, reason: trimmed }));
}

/** Called once a recharge is genuinely collected. Safe to call twice. */
async function applyRecharge(recharge) {
  return postGroup(recharge.riderId, [
    {
      type: LEDGER_TYPE.RIDER_RECHARGE,
      direction: LEDGER_DIRECTION.CREDIT,
      amount: recharge.amount,
      currency: recharge.currency,
      description: `Recharge of ${recharge.currency} ${round2(recharge.amount).toFixed(2)}`,
      idempotencyKey: `recharge:${recharge._id}`,
      rechargeId: recharge._id
    }
  ]);
}

/**
 * An admin moving a rider's balance by hand.
 *
 * Deliberately awkward to do: it needs a direction, an amount, a reason and the
 * admin's identity, and it posts a ledger row like everything else. There is no
 * path anywhere in this service that sets a balance directly, which is what
 * makes "do not allow silent financial modifications" a property of the code
 * rather than a promise in a document.
 */
async function adjust({ riderId, direction, amount, reason, admin, note, idempotencyKey = null }) {
  if (direction !== LEDGER_DIRECTION.CREDIT && direction !== LEDGER_DIRECTION.DEBIT) {
    throw ApiError.badRequest('An adjustment must be a credit or a debit');
  }

  const magnitude = round2(Number(amount));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    throw ApiError.badRequest('An adjustment must be a positive amount');
  }

  const trimmed = String(reason || '').trim();
  if (trimmed.length < 4) {
    throw ApiError.badRequest('Give a reason for the adjustment', [
      { field: 'reason', message: 'A reason of at least 4 characters is required' }
    ]);
  }

  const rider = await Rider.exists({ _id: riderId });
  if (!rider) throw ApiError.notFound('Rider not found');

  const wallet = await walletFor(riderId);

  return postGroup(riderId, [
    {
      type: LEDGER_TYPE.ADMIN_ADJUSTMENT,
      direction,
      amount: magnitude,
      currency: wallet.currency,
      description: note?.trim()
        ? `Adjustment — ${note.trim().slice(0, 160)}`
        : `Adjustment by ${admin?.email || 'an administrator'}`,
      /**
       * The console supplies a key per submission, so a retried request — a
       * proxy giving up on a slow response, an admin clicking twice on the same
       * dialog — collapses into one movement, while a deliberate second
       * correction opens a new dialog, gets a new key and posts again.
       *
       * Without one this falls back to a per-attempt key, which the unique index
       * cannot protect at all. That is the honest default for a caller that
       * cannot tell us which of the two it means.
       */
      idempotencyKey: idempotencyKey
        ? `adjust:${riderId}:${String(idempotencyKey).slice(0, 80)}`
        : `adjust:${riderId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      adminId: admin?._id || null,
      reason: trimmed
    }
  ]);
}

// ------------------------------------------------------------- the reading

async function ledgerFor(riderId, { page = 1, limit = 25, type = null, rideId = null } = {}) {
  const filter = { riderId };
  if (type) filter.type = type;
  if (rideId) filter.rideId = rideId;

  const [entries, total] = await Promise.all([
    WalletLedger.find(filter)
      .sort({ sequence: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WalletLedger.countDocuments(filter)
  ]);

  return { entries, total, page, limit };
}

/**
 * Everything the wallet screen shows, in one call.
 *
 * The earnings figures come from the earnings service, which computes them from
 * completed rides, while the balances come from the ledger. They answer
 * different questions and are deliberately not derived from each other — that
 * separation is the point of section 13 of the brief, and keeping the two
 * sources apart is how it stays true.
 */
async function summary(riderId) {
  const wallet = await walletOf(riderId);
  const limit = threshold();
  const outstanding = outstandingOf(wallet.balance);
  const warnAt = round2((limit * settings.get('finance.walletWarningPercent')) / 100);

  return {
    ...wallet.toPublic(),
    available: availableOf(wallet.balance),
    outstanding,
    threshold: limit,
    minimumRecharge: settings.get('finance.minimumRecharge'),
    canGoOnline: !blockedAt(outstanding, limit),
    // Warned before blocked, so being taken off the road is never the first the
    // rider hears about it.
    nearingLimit: outstanding > 0 && outstanding >= warnAt && !blockedAt(outstanding, limit),
    warnAt,
    requiredRecharge: blockedAt(outstanding, limit)
      ? round2(Math.max(round2(outstanding - limit), settings.get('finance.minimumRecharge')))
      : 0
  };
}

/**
 * Recomputes the wallet from its ledger.
 *
 * The repair for the one window `postEntry` cannot close without a transaction,
 * and the check that says the cache is honest. Returns what changed, so calling
 * it on a healthy wallet is a no-op that proves it was healthy.
 */
async function reconcile(riderId) {
  // Three passes at most. The aggregate and the write are separate reads, so a
  // posting landing between them would be erased by a blind overwrite — the
  // repair tool introducing the very drift it exists to remove. The write is
  // conditional on the balance still being the one that was read, and losing
  // that condition just means reading again.
  for (let pass = 0; pass < 3; pass += 1) {
    const totals = await ledgerTotals(riderId);
    const wallet = await walletFor(riderId);

    const before = round2(wallet.balance);
    const after = round2(totals.balance);

    const applied = await RiderWallet.updateOne(
      { _id: wallet._id, balance: wallet.balance },
      {
        $set: {
          balance: after,
          lifetimeEarnings: round2(totals.lifetimeEarnings),
          lifetimeCommission: round2(totals.lifetimeCommission),
          lifetimeCashCollected: round2(totals.lifetimeCashCollected),
          lifetimeUpiCollected: round2(totals.lifetimeUpiCollected),
          lifetimeRecharged: round2(totals.lifetimeRecharged),
          lifetimeAdjustments: round2(totals.lifetimeAdjustments)
        }
      }
    );

    if (!applied.matchedCount) continue;

    if (before !== after) {
      logger.warn(
        `Wallet for rider ${riderId} was ${before}, ledger says ${after}. Repaired from the ledger.`
      );
    }

    // A repaired balance can cross the ceiling in either direction, so the
    // status has to be worked out again — otherwise a wallet just found to be
    // ₹500 in debt keeps reading ACTIVE on the finance queue until the rider's
    // next posting happens to recompute it.
    const settledWallet = await applyStatus(await RiderWallet.findById(wallet._id));
    if (before !== after) announce(riderId, settledWallet);

    return { riderId, before, after, drift: round2(after - before), entries: totals.entries };
  }

  throw ApiError.conflict('This wallet is being written to right now. Try again in a moment.');
}

/** What the rows add up to. The only place the ledger is replayed. */
async function ledgerTotals(riderId) {
  const [totals] = await WalletLedger.aggregate([
    { $match: { riderId: toObjectId(riderId) } },
    {
      $group: {
        _id: null,
        balance: {
          $sum: {
            $switch: {
              branches: [
                { case: { $eq: ['$direction', LEDGER_DIRECTION.CREDIT] }, then: '$amount' },
                { case: { $eq: ['$direction', LEDGER_DIRECTION.DEBIT] }, then: { $multiply: ['$amount', -1] } }
              ],
              default: 0
            }
          }
        },
        lifetimeEarnings: { $sum: sumOf(LEDGER_TYPE.RIDE_EARNING) },
        lifetimeCommission: { $sum: sumOf(LEDGER_TYPE.PLATFORM_COMMISSION) },
        lifetimeCashCollected: { $sum: sumOf(LEDGER_TYPE.CASH_COLLECTION) },
        lifetimeUpiCollected: { $sum: sumOf(LEDGER_TYPE.UPI_PAYMENT) },
        lifetimeRecharged: { $sum: sumOf(LEDGER_TYPE.RIDER_RECHARGE) },
        lifetimeAdjustments: { $sum: sumOf(LEDGER_TYPE.ADMIN_ADJUSTMENT) },
        entries: { $sum: 1 }
      }
    }
  ]);

  return {
    balance: totals?.balance || 0,
    lifetimeEarnings: totals?.lifetimeEarnings || 0,
    lifetimeCommission: totals?.lifetimeCommission || 0,
    lifetimeCashCollected: totals?.lifetimeCashCollected || 0,
    lifetimeUpiCollected: totals?.lifetimeUpiCollected || 0,
    lifetimeRecharged: totals?.lifetimeRecharged || 0,
    lifetimeAdjustments: totals?.lifetimeAdjustments || 0,
    entries: totals?.entries || 0
  };
}

const sumOf = (type) => ({ $cond: [{ $eq: ['$type', type] }, '$amount', 0] });

const toObjectId = (value) => {
  // eslint-disable-next-line global-require
  const mongoose = require('mongoose');
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
};

module.exports = {
  walletFor,
  walletOf,
  summary,
  ledgerFor,
  settleRide,
  refundRide,
  chargeCancellation,
  applyRecharge,
  adjust,
  reconcile,
  checkCanGoOnline,
  assertCanGoOnline,
  announce,
  // Exported for tests: these are the decisions worth checking, and none of
  // them needs a database to be right.
  rideEntries,
  refundEntries,
  cancellationEntry,
  effectOf,
  statusFor,
  blockedAt,
  threshold
};
