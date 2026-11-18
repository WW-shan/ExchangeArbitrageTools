/**
 * How long does a spread actually last?
 *
 * This is the number that decides whether S1 can work at all. If the median
 * spread half-life is shorter than our round-trip latency, no amount of
 * execution tuning fixes it.
 *
 *   npx tsx scripts/analyze-spread-half-life.ts [--min-bps 10]
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const minBps = Number(arg('--min-bps', '10'));
const gapMs = Number(arg('--sample-gap', '5000'));

const db = new DatabaseSync(arg('--db', 'data/rotation.sqlite'), { readOnly: true });
const rows = db
  .prepare(
    `SELECT venue_id, exchange_symbol, fetched_at, bids_json, asks_json
     FROM orderbooks WHERE valid = 1 ORDER BY exchange_symbol, fetched_at`,
  )
  .all();

const grouped = new Map();
for (const row of rows) {
  const bids = JSON.parse(row.bids_json);
  const asks = JSON.parse(row.asks_json);
  if (!bids.length || !asks.length) continue;
  const list = grouped.get(row.exchange_symbol) ?? [];
  list.push({
    venueId: row.venue_id,
    at: Number(row.fetched_at),
    bid: Number(bids[0][0]),
    ask: Number(asks[0][0]),
  });
  grouped.set(row.exchange_symbol, list);
}

const runs = [];
for (const [symbol, list] of grouped) {
  const venues = [...new Set(list.map((row) => row.venueId))];
  if (venues.length < 2) continue;
  const perVenue = new Map();
  for (const row of list) {
    const arr = perVenue.get(row.venueId) ?? [];
    arr.push(row);
    perVenue.set(row.venueId, arr);
  }
  const grid = new Map();
  for (const row of list) {
    const slot = Math.round(row.at / gapMs) * gapMs;
    const entry = grid.get(slot) ?? {};
    entry[row.venueId] = row;
    grid.set(slot, entry);
  }
  const slots = [...grid.keys()].sort((a, b) => a - b);
  let run = 0;
  let best = 0;
  let prev = -Infinity;
  for (const slot of slots) {
    const entry = grid.get(slot);
    let spread = -Infinity;
    for (const a of venues) {
      for (const b of venues) {
        if (a === b) continue;
        if (!entry[a] || !entry[b]) continue;
        const value = ((entry[b].bid - entry[a].ask) / entry[a].ask) * 10_000;
        if (value > spread) spread = value;
      }
    }
    if (spread >= minBps) {
      run = slot - prev <= gapMs * 2 ? run + (slot - prev) : gapMs;
      prev = slot;
      best = Math.max(best, spread);
    } else if (run > 0) {
      runs.push({ symbol, durationMs: run, bestBps: best });
      run = 0;
      best = 0;
      prev = -Infinity;
    }
  }
  if (run > 0) runs.push({ symbol, durationMs: run, bestBps: best });
}

if (runs.length === 0) {
  console.log(`no cross-venue runs >= ${minBps} bps`);
  process.exit(0);
}
runs.sort((a, b) => a.durationMs - b.durationMs);
const pct = (q) => runs[Math.min(runs.length - 1, Math.floor(runs.length * q))];
console.log(`runs >= ${minBps} bps: ${runs.length}`);
for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
  const row = pct(q);
  console.log(`  p${String(Math.round(q * 100)).padStart(2)} duration ${(row.durationMs / 1000).toFixed(1)}s best ${row.bestBps.toFixed(0)}bpt`);
}
const bySymbol = new Map();
for (const run of runs) {
  const state = bySymbol.get(run.symbol) ?? { n: 0, total: 0, best: 0 };
  state.n += 1;
  state.total += run.durationMs;
  state.best = Math.max(state.best, run.bestBps);
  bySymbol.set(run.symbol, state);
}
console.log('\ntop symbols by total time in spread:');
for (const [symbol, state] of [...bySymbol.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10)) {
  console.log(`  ${symbol.padEnd(14)} runs=${String(state.n).padStart(3)} total=${(state.total / 1000).toFixed(0)}s best=${state.best.toFixed(0)}bps`);
}
const above = (ms) => runs.filter((run) => run.durationMs >= ms).length;
console.log(`\nruns lasting >= 2.6s (our p50 round trip): ${above(2600)} / ${runs.length}`);
console.log(`runs lasting >= 5.4s (our p90 round trip): ${above(5400)} / ${runs.length}`);
console.log(`runs lasting >= 15s: ${above(15000)} / ${runs.length}`);
