/**
 * Find pairs whose spread persists long enough to trade.
 *
 * The 2026-11-19 WARD analysis showed the median profitable episode lasts 2.6 s
 * while our round trip is also 2.6 s (p50) and 5.4 s (p90). The metric that
 * matters is therefore not "how big is the spread" but "how long does it stay
 * profitable".
 *
 * This walks every recorded cross-venue pair with strict timestamp joins and
 * reports, per symbol and direction:
 *   - how many separate profitable windows exist
 *   - their median / p90 duration
 *   - how many of them outlast a configurable latency
 *
 *   npx tsx scripts/rank-persistent-spreads.ts --max-gap-ms 2000 --min-net-bps 20
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const maxGapMs = Number(arg('--max-gap-ms', '2000'));
const minNetBps = Number(arg('--min-net-bps', '20'));
const latencyMs = Number(arg('--latency-ms', '2600'));
const endGapMs = Number(arg('--end-gap-ms', '15000'));

// Effective fees after the confirmed rebates.
const FEES = { gateio: 2.97, bitget: 2.0, weex: 10 };

const db = new DatabaseSync(arg('--db', 'data/rotation.sqlite'), { readOnly: true });
const symbols = db
  .prepare("SELECT DISTINCT exchange_symbol FROM orderbooks WHERE valid=1")
  .all()
  .map((row) => row.exchange_symbol);

const results = [];
for (const symbol of symbols) {
  const rows = db
    .prepare(
      `SELECT venue_id, fetched_at, bids_json, asks_json FROM orderbooks
       WHERE exchange_symbol = ? AND valid = 1 ORDER BY fetched_at`,
    )
    .all(symbol);
  const byVenue = new Map();
  for (const row of rows) {
    const arr = byVenue.get(row.venue_id) ?? [];
    arr.push({
      at: Number(row.fetched_at),
      bid: Number(JSON.parse(row.bids_json)[0]?.[0]),
      ask: Number(JSON.parse(row.asks_json)[0]?.[0]),
    });
    byVenue.set(row.venue_id, arr);
  }
  const venues = [...byVenue.keys()];
  if (venues.length < 2) continue;

  for (let i = 0; i < venues.length; i += 1) {
    for (let j = i + 1; j < venues.length; j += 1) {
      const a = venues[i];
      const b = venues[j];
      const rowsA = byVenue.get(a);
      const rowsB = byVenue.get(b);
      let p = 0;
      let q = 0;
      const windows = { [`${a}->${b}`]: [], [`${b}->${a}`]: [] };
      const open = {};
      while (p < rowsA.length && q < rowsB.length) {
        const gap = Math.abs(rowsA[p].at - rowsB[q].at);
        if (gap > maxGapMs) {
          if (rowsA[p].at < rowsB[q].at) p += 1;
          else q += 1;
          continue;
        }
        const at = Math.max(rowsA[p].at, rowsB[q].at);
        for (const [buyV, sellV, buyRow, sellRow] of [
          [a, b, rowsA[p], rowsB[q]],
          [b, a, rowsB[q], rowsA[p]],
        ]) {
          if (!(buyRow.ask > 0) || !(sellRow.bid > 0)) continue;
          const gross = ((sellRow.bid - buyRow.ask) / buyRow.ask) * 10_000;
          const net = gross - (FEES[buyV] ?? 10) - (FEES[sellV] ?? 10);
          const key = `${buyV}->${sellV}`;
          if (net >= minNetBps) {
            const current = open[key];
            if (current && at - current.end <= endGapMs) {
              current.end = at;
              current.samples += 1;
              current.best = Math.max(current.best, net);
            } else {
              if (current) windows[key].push(current);
              open[key] = { start: at, end: at, samples: 1, best: net };
            }
          }
        }
        p += 1;
        q += 1;
      }
      for (const key of Object.keys(open)) {
        if (open[key]) windows[key].push(open[key]);
      }
      for (const [direction, list] of Object.entries(windows)) {
        if (list.length === 0) continue;
        const durations = list.map((w) => w.end - w.start).sort((x, y) => x - y);
        const viable = list.filter((w) => w.end - w.start >= latencyMs);
        results.push({
          symbol,
          direction,
          windows: list.length,
          medianMs: durations[Math.floor(durations.length / 2)],
          p90Ms: durations[Math.floor(durations.length * 0.9)],
          maxMs: durations[durations.length - 1],
          viable: viable.length,
          bestBps: Math.max(...list.map((w) => w.best)),
          totalViableMs: viable.reduce((sum, w) => sum + (w.end - w.start), 0),
        });
      }
    }
  }
}

results.sort((x, y) => y.totalViableMs - x.totalViableMs || y.viable - x.viable);
console.log(`latency threshold: ${latencyMs} ms, min net: ${minNetBps} bps, joins within ${maxGapMs} ms\n`);
console.log('symbol          direction            wins  medS  p90S  maxS  viable  viableSec  bestBps');
for (const r of results.slice(0, 20)) {
  console.log(
    `${r.symbol.padEnd(15)} ${r.direction.padEnd(20)} ${String(r.windows).padStart(4)} ` +
      `${(r.medianMs / 1000).toFixed(1).padStart(5)} ${(r.p90Ms / 1000).toFixed(1).padStart(5)} ` +
      `${(r.maxMs / 1000).toFixed(1).padStart(5)} ${String(r.viable).padStart(7)} ` +
      `${(r.totalViableMs / 1000).toFixed(0).padStart(10)} ${r.bestBps.toFixed(0).padStart(8)}`,
  );
}
const total = results.filter((r) => r.viable > 0);
console.log(`\n${total.length} symbol/direction pairs have at least one window longer than our latency`);
