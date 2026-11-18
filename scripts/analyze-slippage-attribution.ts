/**
 * Where did the edge go?
 *
 * For every S1 batch we know four prices:
 *   1. the quote that produced the signal      (opportunity snapshot)
 *   2. the quote the executor re-evaluated on  (preflight, fresh books)
 *   3. what leg 1 actually filled at
 *   4. what leg 2 actually filled at
 *
 * The difference between 1 and 4 is the whole story, and it decomposes into
 * independent losses that need different fixes:
 *
 *   decay      signal -> preflight. Caused by latency. Fixed by acting sooner.
 *   leg1 slip  preflight buy price -> real buy fill. Book moved or we crossed.
 *   leg2 slip  preflight sell price -> real sell fill. Book moved between the
 *              buy fill and the sell submission. THIS is what atomic execution
 *              would remove, and nothing else would.
 *   venue      the sell ran on the wrong exchange entirely.
 *
 *   npx tsx scripts/analyze-slippage-attribution.ts [--hours 48]
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

const executions = db
  .prepare(
    `SELECT id, batch_id, status, realized_profit, safe_mode_reason, opened_at,
            preflight_json, opportunity_id, planned_notional
     FROM executions
     WHERE strategy = 'S1' AND opened_at > ? ORDER BY opened_at`,
  )
  .all(since);

const num = (value) => (value === null || value === undefined ? null : Number(value));
const bps = (from, to) => (from && to && from > 0 ? ((to - from) / from) * 10_000 : null);

const rows = [];
for (const execution of executions) {
  const preflight = execution.preflight_json ? JSON.parse(execution.preflight_json) : {};
  const refreshed = preflight.refreshed ?? {};
  const books = preflight.orderbooks ?? {};
  const signal = execution.opportunity_id
    ? db.prepare('SELECT net_profit_bps, metadata_json FROM opportunities WHERE id = ?').get(execution.opportunity_id)
    : undefined;
  const signalMeta = signal?.metadata_json ? JSON.parse(signal.metadata_json) : {};

  const legs = db
    .prepare(
      `SELECT leg_number, venue_id, side, filled_amount, average_fill_price, status, requested_price
       FROM execution_legs WHERE execution_id = ? ORDER BY leg_number`,
    )
    .all(execution.id);
  const buyLeg = legs.find((leg) => leg.side === 'buy');
  const plannedSell = legs.find((leg) => leg.side === 'sell');

  // The hedge that actually closed the trade, if leg 2 did not.
  const hedge = db
    .prepare(
      `SELECT id, realized_profit FROM executions
       WHERE strategy = 'HEDGE' AND metadata_json LIKE ? ORDER BY id DESC LIMIT 1`,
    )
    .get(`%${execution.batch_id}%`);
  const hedgeLegs = hedge
    ? db
        .prepare(
          `SELECT venue_id, side, filled_amount, average_fill_price, status
           FROM execution_legs WHERE execution_id = ? ORDER BY leg_number`,
        )
        .all(hedge.id)
    : [];
  const hedgeSell = hedgeLegs.find((leg) => leg.side === 'sell' && num(leg.filled_amount) > 0);

  const signalBps = num(signal?.net_profit_bps);
  const signalBuyAsk = num(signalMeta.buyBestAsk);
  const signalSellBid = num(signalMeta.sellBestBid);
  const preBuy = num(refreshed.expectedBuyPrice);
  const preSell = num(refreshed.expectedSellPrice);
  const preBps = num(refreshed.netProfitBps);
  const buyFill = num(buyLeg?.average_fill_price);
  const sellFill = num(hedgeSell?.average_fill_price ?? plannedSell?.average_fill_price);
  const sellVenue = hedgeSell?.venue_id ?? plannedSell?.venue_id;
  const plannedSellVenue = plannedSell?.venue_id;
  const buyVenue = books.buy?.venueId ?? buyLeg?.venue_id;

  const venueMismatch = Boolean(sellVenue && plannedSellVenue && sellVenue !== plannedSellVenue);

  rows.push({
    id: execution.id,
    status: execution.status,
    reason: execution.safe_mode_reason,
    realized: num(execution.realized_profit),
    signalBps,
    signalGrossBps: bps(signalBuyAsk, signalSellBid),
    decayBps: bps(signalBuyAsk, preBuy) === null ? null : (preBps ?? 0) - (signalBps ?? 0),
    preBps,
    buySlipBps: bps(preBuy, buyFill),
    sellSlipBps: bps(preSell, sellFill),
    realizedGrossBps: bps(buyFill, sellFill),
    venueMismatch,
    buyVenue,
    sellVenue,
    plannedSellVenue,
    signalAgeMs: num(preflight.signalAgeMs),
    notional: num(execution.planned_notional),
    sellStatus: hedgeSell?.status ?? plannedSell?.status,
  });
}

const withPrices = rows.filter((row) => row.buySlipBps !== null && row.sellSlipBps !== null);
const pct = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};
const summary = (label, values) => {
  if (values.length === 0) return;
  console.log(
    `  ${label.padEnd(22)} n=${String(values.length).padStart(3)} ` +
      `p10=${String(Math.round(pct(values, 0.1))).padStart(6)} ` +
      `p50=${String(Math.round(pct(values, 0.5))).padStart(6)} ` +
      `p90=${String(Math.round(pct(values, 0.9))).padStart(6)} ` +
      `mean=${String(Math.round(values.reduce((a, b) => a + b, 0) / values.length)).padStart(6)} bps`,
  );
};

console.log(`S1 batches in the last ${hours}h: ${rows.length} (${withPrices.length} with both fills)`);
console.log(`\nloss attribution (bps; negative = lost edge)\n`);

summary('signal edge', rows.map((r) => r.signalBps).filter((v) => v !== null));
summary('edge at preflight', rows.map((r) => r.preBps).filter((v) => v !== null));
summary('leg1 buy slippage', withPrices.map((r) => r.buySlipBps));
summary('leg2 sell slippage', withPrices.map((r) => r.sellSlipBps));
summary('realized gross', withPrices.map((r) => r.realizedGrossBps));
summary('signal age (ms)', rows.map((r) => r.signalAgeMs).filter((v) => v !== null));

const mismatched = rows.filter((row) => row.venueMismatch);
console.log(`\nvenue mismatch (sell ran on a different exchange than planned): ${mismatched.length}/${rows.length}`);
if (mismatched.length > 0) {
  summary('  mismatched sell slip', mismatched.map((r) => r.sellSlipBps).filter((v) => v !== null));
  const correct = rows.filter((row) => !row.venueMismatch && row.sellSlipBps !== null);
  summary('  correct-venue sell slip', correct.map((r) => r.sellSlipBps));
}

console.log('\nper-batch detail:');
console.log('  id  signal  pre   buySlip sellSlip  realGross  venue              ageMs');
for (const row of rows.slice(-20)) {
  const fmt = (value) => (value === null ? '    -' : String(Math.round(value)).padStart(5));
  console.log(
    `  ${String(row.id).padStart(3)} ${fmt(row.signalBps)} ${fmt(row.preBps)} ` +
      `${fmt(row.buySlipBps)}   ${fmt(row.sellSlipBps)}    ${fmt(row.realizedGrossBps)}     ` +
      `${String(row.sellVenue ?? '-').padEnd(8)}${row.venueMismatch ? ' (!)' : '    '} ${String(row.signalAgeMs ?? '-').padStart(6)}`,
  );
}

const totalRealized = rows.reduce((sum, row) => sum + (row.realized ?? 0), 0);
console.log(`\ntotal realized PnL: ${totalRealized.toFixed(4)} USDT over ${rows.length} batches`);
