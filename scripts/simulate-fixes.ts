/**
 * What would each fix have been worth?
 *
 * Replays the recorded S1 batches and applies the two fixes we now have, then
 * estimates what a third (atomic two-leg submission) would add.
 *
 * The point is to decide where effort goes, not to promise a return.
 *
 *   npx tsx scripts/simulate-fixes.ts [--hours 48]
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const hours = Number(arg('--hours', '48'));

const db = new DatabaseSync(arg('--db', 'data/rotation.sqlite'), { readOnly: true });
const since = Date.now() - hours * 3600_000;
const num = (value) => (value === null || value === undefined ? null : Number(value));

const executions = db
  .prepare(
    `SELECT id, batch_id, realized_profit, safe_mode_reason, opened_at, preflight_json
     FROM executions WHERE strategy = 'S1' AND opened_at > ? ORDER BY opened_at`,
  )
  .all(since);

const FEES_BPS = 4.97;
const rows = [];
for (const execution of executions) {
  const preflight = execution.preflight_json ? JSON.parse(execution.preflight_json) : {};
  const refreshed = preflight.refreshed ?? {};
  const legs = db
    .prepare(
      `SELECT side, filled_amount, average_fill_price, venue_id, status
       FROM execution_legs WHERE execution_id = ? ORDER BY leg_number`,
    )
    .all(execution.id);
  const buy = legs.find((leg) => leg.side === 'buy');
  const plannedSell = legs.find((leg) => leg.side === 'sell');
  const hedge = db
    .prepare(
      `SELECT id FROM executions WHERE strategy='HEDGE' AND metadata_json LIKE ? ORDER BY id DESC LIMIT 1`,
    )
    .get(`%${execution.batch_id}%`);
  const hedgeLeg = hedge
    ? (db
        .prepare(
          `SELECT filled_amount, average_fill_price, venue_id FROM execution_legs
           WHERE execution_id = ? AND side = 'sell'`,
        )
        .all(hedge.id)
        .find((leg) => num(leg.filled_amount) > 0) as
        | { filled_amount: string; average_fill_price: string; venue_id: string }
        | undefined)
    : undefined;

  const buyFill = num(buy?.average_fill_price);
  const sellFill = num(hedgeLeg?.average_fill_price ?? plannedSell?.average_fill_price);
  const notional = num(execution.planned_notional) ?? 0;
  const preBps = num(refreshed.netProfitBps);
  const expectedBuy = num(refreshed.expectedBuyPrice);
  const expectedSell = num(refreshed.expectedSellPrice);
  const sellVenue = hedgeLeg?.venue_id ?? plannedSell?.venue_id;
  const plannedVenue = plannedSell?.venue_id;

  rows.push({
    id: execution.id,
    notional,
    preBps,
    realized: num(execution.realized_profit) ?? 0,
    venueMismatch: Boolean(sellVenue && plannedVenue && sellVenue !== plannedVenue),
    buyFill,
    sellFill,
    expectedBuy,
    expectedSell,
    actualGrossBps: buyFill && sellFill ? ((sellFill - buyFill) / buyFill) * 10_000 : null,
  });
}

// --- what already changed ---------------------------------------------------
// 1. counterparty hedge: sell on the planned venue instead of the residual one.
//    Approximate the outcome by charging the price the planned venue quoted at
//    preflight (expectedSell) rather than the residual venue's realised fill.
// 2. live post-fill book: the expected sell price is a live quote, so the
//    preflight expectation is the best available estimate.
// 3. correct fees: 4.97 bps instead of 12.97.
const before = rows.reduce((sum, row) => sum + row.realized, 0);
const afterFixes = rows.reduce((sum, row) => {
  if (row.venueMismatch && row.buyFill && row.expectedSell) {
    const gross = ((row.expectedSell - row.buyFill) / row.buyFill) * 10_000;
    return sum + (row.notional * (gross - FEES_BPS)) / 10_000;
  }
  return sum + row.realized;
}, 0);

console.log(`batches: ${rows.length}`);
console.log(`venue-mismatched: ${rows.filter((row) => row.venueMismatch).length}`);
console.log(`\nrecorded result:            ${before.toFixed(3)} USDT`);
console.log(
  `with venue + fee fixes:     ${afterFixes.toFixed(3)} USDT  ` +
    `(delta ${(afterFixes - before).toFixed(3)})`,
);

// --- what atomicity would add -----------------------------------------------
// Atomicity removes the gap between "we saw a price" and "we can act on it".
// The measured cost of that gap is the difference between the preflight price
// and the fill. For batches that already sold on the right venue we can read
// that gap directly.
const rightVenue = rows.filter((row) => !row.venueMismatch && row.actualGrossBps !== null);
if (rightVenue.length > 0) {
  const gaps = rightVenue
    .map((row) => {
      const expected =
        row.expectedSell && row.buyFill
          ? ((row.expectedSell - row.buyFill) / row.buyFill) * 10_000
          : null;
      return expected === null ? null : row.actualGrossBps - expected;
    })
    .filter((value) => value !== null);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(
    `\ncorrect-venue batches: ${rightVenue.length}, mean gap vs preflight ${meanGap.toFixed(0)} bps`,
  );
  const atomicGain = rows
    .filter((row) => row.buyFill && row.expectedSell && row.actualGrossBps !== null)
    .reduce((sum, row) => sum + (row.notional * Math.max(0, -meanGap)) / 10_000, 0);
  console.log(`upper bound if atomicity removed that gap entirely: +${atomicGain.toFixed(3)} USDT`);
  console.log(
    'Atomicity cannot recover the venue mismatch (that was a routing bug) or the fee error.',
  );
}

const positiveOnly = rows.filter((row) => (row.preBps ?? 0) > 0);
const lostOnPositives = positiveOnly.reduce((sum, row) => sum + row.realized, 0);
console.log(
  `\nbatches whose signal was positive at preflight: ${positiveOnly.length}, ` +
    `recorded ${lostOnPositives.toFixed(3)} USDT`,
);
