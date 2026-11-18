/**
 * Ground truth check: replay every recorded cross-venue book pair and classify
 * the large spreads into spike / structural / repricing.
 *
 *   npx tsx scripts/analyze-dislocation-history.ts [--min-bps 500] [--window-ms 300000]
 */
import { DatabaseSync } from 'node:sqlite';
import { Decimal, detectDislocation } from '../packages/core/dist/index.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const minBps = new Decimal(arg('--min-bps', '500'));
const windowMs = Number(arg('--window-ms', '300000'));
const dbPath = arg('--db', 'data/rotation.sqlite');

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare(
    `SELECT venue_id, exchange_symbol, fetched_at, bids_json, asks_json
     FROM orderbooks WHERE valid = 1 ORDER BY exchange_symbol, fetched_at`,
  )
  .all();

const bySymbol = new Map();
for (const row of rows) {
  const bids = JSON.parse(row.bids_json);
  const asks = JSON.parse(row.asks_json);
  if (!bids.length || !asks.length) continue;
  const list = bySymbol.get(row.exchange_symbol) ?? [];
  list.push({
    venueId: row.venue_id,
    at: Number(row.fetched_at),
    bid: new Decimal(bids[0][0]),
    ask: new Decimal(asks[0][0]),
  });
  bySymbol.set(row.exchange_symbol, list);
}

const settings = {
  minDislocationBps: minBps,
  minVenueDeviationBps: new Decimal(300),
  maxCounterDeviationBps: new Decimal(150),
  maxQuoteAgeMs: 30_000,
  maxBaselineAgeMs: windowMs,
  minBaselineSamples: 5,
  maxRepeatCount: 20,
};

const results = [];
for (const [symbol, list] of bySymbol) {
  const venues = [...new Set(list.map((row) => row.venueId))];
  if (venues.length < 2) continue;
  const perVenue = new Map();
  for (const row of list) {
    const arr = perVenue.get(row.venueId) ?? [];
    arr.push(row);
    perVenue.set(row.venueId, arr);
  }
  const history = new Map();
  const lastTop = new Map();
  const repeat = new Map();
  const push = (venueId, price, at) => {
    const arr = history.get(venueId) ?? [];
    arr.push({ price, at });
    while (arr.length > 200) arr.shift();
    history.set(venueId, arr);
  };
  const trackRepeat = (venueId, key) => {
    if (lastTop.get(venueId) === key) {
      repeat.set(venueId, (repeat.get(venueId) ?? 1) + 1);
    } else {
      lastTop.set(venueId, key);
      repeat.set(venueId, 1);
    }
    return repeat.get(venueId);
  };
  const medianOf = (venueId, now) => {
    const arr = (history.get(venueId) ?? []).filter((row) => now - row.at <= windowMs);
    if (arr.length < 5) return undefined;
    const sorted = arr.map((row) => row.price).sort((a, b) => a.comparedTo(b));
    const mid = Math.floor(sorted.length / 2);
    return {
      median: sorted.length % 2 ? sorted[mid] : sorted[mid - 1].plus(sorted[mid]).div(2),
      samples: arr.length,
      ageMs: now - arr[arr.length - 1].at,
    };
  };

  const merged = [...list].sort((a, b) => a.at - b.at);
  for (const row of merged) {
    const other = venues.find((v) => v !== row.venueId);
    const otherRows = perVenue.get(other) ?? [];
    let best;
    for (const candidate of otherRows) {
      if (Math.abs(candidate.at - row.at) > 10_000) continue;
      if (!best || Math.abs(candidate.at - row.at) < Math.abs(best.at - row.at)) best = candidate;
    }
    if (best) {
      const left = [row, best].sort((a, b) => (a.venueId < b.venueId ? -1 : 1))[0];
      const right = left === row ? best : row;
      const signal = detectDislocation({
        left: {
          venueId: left.venueId,
          bid: left.bid,
          ask: left.ask,
          timestamp: left.at,
          repeatCount: repeat.get(left.venueId) ?? 1,
        },
        right: {
          venueId: right.venueId,
          bid: right.bid,
          ask: right.ask,
          timestamp: right.at,
          repeatCount: repeat.get(right.venueId) ?? 1,
        },
        leftBaseline: medianOf(left.venueId, row.at),
        rightBaseline: medianOf(right.venueId, row.at),
        now: Math.max(left.at, right.at),
        settings,
      });
      if (signal.magnitudeBps.gte(minBps)) {
        results.push({ symbol, ...signal, left: left.venueId, right: right.venueId });
      }
    }
    trackRepeat(row.venueId, `${row.bid}|${row.ask}`);
    push(row.venueId, row.bid.plus(row.ask).div(2), row.at);
  }
}

const byKind = new Map();
for (const r of results) {
  const state = byKind.get(r.kind) ?? { n: 0, best: new Decimal(0), symbols: new Map() };
  state.n += 1;
  if (r.magnitudeBps.gt(state.best)) state.best = r.magnitudeBps;
  state.symbols.set(r.symbol, (state.symbols.get(r.symbol) ?? 0) + 1);
  byKind.set(r.kind, state);
}
console.log(`pairs scanned: ${bySymbol.size}, large-spread samples: ${results.length}`);
for (const [kind, state] of byKind) {
  const top = [...state.symbols.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  ${kind}: n=${state.n} best=${state.best.toFixed(0)}bps symbols=${top.map(([s, n]) => `${s}(${n})`).join(' ')}`);
}
const tradeable = results.filter((r) => r.isDislocation);
console.log(`\nTRADEABLE spikes: ${tradeable.length}`);
for (const r of tradeable.slice(0, 12)) {
  console.log(
    `  ${new Date(r.sampledAt).toISOString()} ${r.symbol} buy=${r.venueBuy} sell=${r.venueSell} ` +
      `mag=${r.magnitudeBps.toFixed(0)}bps spikeDev=${r.spikeDeviationBps.toFixed(0)} counterDev=${r.counterDeviationBps.toFixed(0)}`,
  );
}

