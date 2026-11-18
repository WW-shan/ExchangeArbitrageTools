/**
 * Rank pairs by how long a *tradeable* spread persists.
 *
 * The naive ranking puts WEEX/BREV at the top because WEEX serves snapshots
 * that are minutes old; a "window" built from stale data is not a window.
 * This version only counts pairs where:
 *   1. the asset can round-trip between the venues (withdraw + deposit both
 *      ways on a shared chain), and
 *   2. neither venue's feed lags the other by more than --max-feed-lag-ms.
 *
 *   npx tsx scripts/rank-tradeable-spreads.ts
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
const maxFeedLagMs = Number(arg('--max-feed-lag-ms', '5000'));

const FEES = { gateio: 2.97, bitget: 2.0, weex: 10 };
const db = new DatabaseSync(arg('--db', 'data/rotation.sqlite'), { readOnly: true });

// --- transferability from the recorded currency metadata -------------------
const currencyRows = db
  .prepare(
    `SELECT venue_id, currency, network, withdraw_enabled, deposit_enabled
     FROM exchange_currencies`,
  )
  .all();
const CHAIN_ALIASES = { BASE: 'base', BASEEVM: 'base', ERC20: 'ethereum', ETH: 'ethereum', BSC: 'bsc', BEP20: 'bsc' };
const normChain = (c) => CHAIN_ALIASES[c.toUpperCase()] ?? c.toLowerCase();
const byVenueCurrency = new Map();
for (const row of currencyRows) {
  const list = byVenueCurrency.get(row.venue_id) ?? new Map();
  const code = row.currency.toUpperCase();
  const networks = list.get(code) ?? [];
  networks.push({
    network: row.network,
    withdrawEnabled: Boolean(row.withdraw_enabled),
    depositEnabled: Boolean(row.deposit_enabled),
  });
  list.set(code, networks);
  byVenueCurrency.set(row.venue_id, list);
}

function transferable(symbol, a, b) {
  const base = symbol.split('/')[0];
  const left = byVenueCurrency.get(a)?.get(base);
  const right = byVenueCurrency.get(b)?.get(base);
  if (!left || !right) return false;
  for (const l of left) {
    for (const r of right) {
      if (normChain(l.network) !== normChain(r.network)) continue;

      if (l.withdrawEnabled && r.depositEnabled && r.withdrawEnabled && l.depositEnabled) return true;
    }
  }
  return false;
}

// --- feed lag per venue, from ticker timestamps -----------------------------
// exchange_currencies has no timestamps, so measure lag from orderbook
// fetched_at density: a venue whose books arrive in bursts minutes apart is
// not a live source. We approximate with the observed maximum inter-arrival.
const lagByVenue = new Map();
for (const venue of ['gateio', 'bitget', 'weex']) {
  const rows = db.prepare('SELECT fetched_at FROM orderbooks WHERE venue_id = ? ORDER BY fetched_at').all(venue);
  if (rows.length < 2) continue;
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) gaps.push(Number(rows[i].fetched_at) - Number(rows[i - 1].fetched_at));
  gaps.sort((x, y) => x - y);
  lagByVenue.set(venue, gaps[Math.floor(gaps.length * 0.5)] ?? 0);
}
console.log('median book inter-arrival per venue (ms):', Object.fromEntries(lagByVenue));

const symbols = db.prepare('SELECT DISTINCT exchange_symbol FROM orderbooks WHERE valid=1').all().map((r) => r.exchange_symbol);
const results = [];

for (const symbol of symbols) {
  const rows = db.prepare('SELECT venue_id, fetched_at, bids_json, asks_json FROM orderbooks WHERE exchange_symbol = ? AND valid = 1 ORDER BY fetched_at').all(symbol);
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
  for (let i = 0; i < venues.length; i += 1) {
    for (let j = i + 1; j < venues.length; j += 1) {
      const a = venues[i], b = venues[j];
      if (!transferable(symbol, a, b)) continue;
      const lagA = lagByVenue.get(a) ?? 0, lagB = lagByVenue.get(b) ?? 0;
      if (Math.max(lagA, lagB) > maxFeedLagMs) continue;
      const rowsA = byVenue.get(a), rowsB = byVenue.get(b);
      let p = 0, q = 0;
      const windows = { [`${a}->${b}`]: [], [`${b}->${a}`]: [] };
      const open = {};
      while (p < rowsA.length && q < rowsB.length) {
        const gap = Math.abs(rowsA[p].at - rowsB[q].at);
        if (gap > maxGapMs) { if (rowsA[p].at < rowsB[q].at) p += 1; else q += 1; continue; }
        const at = Math.max(rowsA[p].at, rowsB[q].at);
        for (const [buyV, sellV, buyRow, sellRow] of [[a,b,rowsA[p],rowsB[q]],[b,a,rowsB[q],rowsA[p]]]) {
          if (!(buyRow.ask > 0) || !(sellRow.bid > 0)) continue;
          const net = ((sellRow.bid - buyRow.ask) / buyRow.ask) * 10_000 - (FEES[buyV] ?? 10) - (FEES[sellV] ?? 10);
          const key = `${buyV}->${sellV}`;
          if (net >= minNetBps) {
            const cur = open[key];
            if (cur && at - cur.end <= endGapMs) { cur.end = at; cur.samples += 1; cur.best = Math.max(cur.best, net); }
            else { if (cur) windows[key].push(cur); open[key] = { start: at, end: at, samples: 1, best: net }; }
          }
        }
        p += 1; q += 1;
      }
      for (const k of Object.keys(open)) if (open[k]) windows[k].push(open[k]);
      for (const [direction, list] of Object.entries(windows)) {
        if (!list.length) continue;
        const durations = list.map((w) => w.end - w.start).sort((x, y) => x - y);
        const viable = list.filter((w) => w.end - w.start >= latencyMs);
        results.push({
          symbol, direction, windows: list.length,
          medianMs: durations[Math.floor(durations.length / 2)],
          p90Ms: durations[Math.floor(durations.length * 0.9)],
          maxMs: durations[durations.length - 1],
          viable: viable.length,
          bestBps: Math.max(...list.map((w) => w.best)),
          totalViableMs: viable.reduce((s, w) => s + (w.end - w.start), 0),
        });
      }
    }
  }
}

results.sort((x, y) => y.totalViableMs - x.totalViableMs || y.viable - x.viable);
console.log(`\nlatency ${latencyMs}ms, minNet ${minNetBps}bps, transferable + feed lag <= ${maxFeedLagMs}ms\n`);
console.log('symbol          direction            wins  medS  p90S  maxS  viable  viableSec  bestBps');
for (const r of results.slice(0, 15)) {
  console.log(`${r.symbol.padEnd(15)} ${r.direction.padEnd(20)} ${String(r.windows).padStart(4)} ${(r.medianMs/1000).toFixed(1).padStart(5)} ${(r.p90Ms/1000).toFixed(1).padStart(5)} ${(r.maxMs/1000).toFixed(1).padStart(5)} ${String(r.viable).padStart(7)} ${(r.totalViableMs/1000).toFixed(0).padStart(10)} ${r.bestBps.toFixed(0).padStart(8)}`);
}
console.log(`\n${results.filter((r) => r.viable > 0).length} tradeable pairs have a window longer than our latency`);

