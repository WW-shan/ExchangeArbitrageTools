/**
 * Honest backtest: join books on a strict time gap instead of bucketing.
 *
 * The earlier 30 s bucketing mixed snapshots taken tens of seconds apart, and
 * on a fast-moving pair that manufactures spread that never existed. This one
 * only pairs books whose *actual* timestamps are within --max-gap-ms.
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const maxGapMs = Number(arg('--max-gap-ms', '1000'));
const minNetBps = Number(arg('--min-net-bps', '10'));
const db = new DatabaseSync(arg('--db', 'data/rotation.sqlite'), { readOnly: true });

const symbols = db.prepare(`SELECT DISTINCT exchange_symbol FROM orderbooks WHERE valid=1`).all();
const FEES = { gateio: 2.97, bitget: 10 };

function walkBuy(asks, quote) {
  let spend = quote, base = 0;
  for (const [p, a] of asks) {
    if (spend <= 0) break;
    const take = Math.min(spend, p * a);
    base += take / p;
    spend -= take;
  }
  return { base, spent: quote - spend };
}
function walkSell(bids, base) {
  let rem = base, quote = 0;
  for (const [p, a] of bids) {
    if (rem <= 0) break;
    const take = Math.min(rem, a);
    quote += take * p;
    rem -= take;
  }
  return { quote, sold: base - rem };
}

let totalSamples = 0;
const all = [];
for (const { exchange_symbol: symbol } of symbols) {
  const rows = db.prepare(
    `SELECT venue_id, fetched_at, bids_json, asks_json FROM orderbooks
     WHERE exchange_symbol = ? AND valid = 1 ORDER BY fetched_at`
  ).all(symbol);
  const byVenue = new Map();
  for (const r of rows) {
    const arr = byVenue.get(r.venue_id) ?? [];
    arr.push({
      at: Number(r.fetched_at),
      bids: JSON.parse(r.bids_json).map(([p, a]) => [Number(p), Number(a)]),
      asks: JSON.parse(r.asks_json).map(([p, a]) => [Number(p), Number(a)]),
    });
    byVenue.set(r.venue_id, arr);
  }
  const venues = [...byVenue.keys()];
  if (venues.length < 2) continue;
  for (let i = 0; i < venues.length; i++) {
    for (let j = i + 1; j < venues.length; j++) {
      const a = venues[i], b = venues[j];
      const rowsA = byVenue.get(a), rowsB = byVenue.get(b);
      let p = 0, q = 0;
      while (p < rowsA.length && q < rowsB.length) {
        const gap = Math.abs(rowsA[p].at - rowsB[q].at);
        if (gap > maxGapMs) {
          if (rowsA[p].at < rowsB[q].at) p++; else q++;
          continue;
        }
        for (const [buyV, sellV, buyRow, sellRow] of [[a,b,rowsA[p],rowsB[q]],[b,a,rowsB[q],rowsA[p]]]) {
          if (!buyRow.asks.length || !sellRow.bids.length) continue;
          const gross = ((sellRow.bids[0][0] - buyRow.asks[0][0]) / buyRow.asks[0][0]) * 10000;
          const net = gross - (FEES[buyV] ?? 10) - (FEES[sellV] ?? 10);
          totalSamples++;
          if (net < minNetBps) continue;
          for (const quote of [3, 5, 10]) {
            const bought = walkBuy(buyRow.asks, quote);
            const sold = walkSell(sellRow.bids, bought.base);
            const pnl = sold.quote - bought.spent;
            all.push({ symbol, dir: `${buyV}->${sellV}`, quote, notional: bought.spent, pnl, gap, at: buyRow.at });
          }
        }
        p++; q++;
      }
    }
  }
}

console.log(`strict joins (gap<=${maxGapMs}ms): ${totalSamples} cross-venue pairs evaluated`);
if (!all.length) { console.log('no spread cleared fees'); process.exit(0); }
console.log(`qualifying book walks: ${all.length}\n`);
for (const quote of [3, 5, 10]) {
  const rows = all.filter(r => r.quote === quote);
  if (!rows.length) continue;
  const win = rows.filter(r => r.pnl > 0);
  const total = rows.reduce((s, r) => s + r.pnl, 0);
  console.log(`size ${quote}U: n=${rows.length} win=${win.length} (${(win.length/rows.length*100).toFixed(0)}%) total=${total.toFixed(3)}U avg=${(total/rows.length).toFixed(4)}U`);
}
const byDir = new Map();
for (const r of all.filter(x => x.quote === 5)) {
  const s = byDir.get(r.dir) ?? { n: 0, pnl: 0, win: 0 };
  s.n++; s.pnl += r.pnl; if (r.pnl > 0) s.win++;
  byDir.set(r.dir, s);
}
console.log('\nat 5U:');
for (const [dir, s] of [...byDir].sort((x,y)=>y[1].pnl-x[1].pnl)) {
  console.log(`  ${dir.padEnd(20)} n=${String(s.n).padStart(3)} win=${String(s.win).padStart(3)} pnl=${s.pnl.toFixed(3)}U`);
}
const bySymbol = new Map();
for (const r of all.filter(x => x.quote === 5)) {
  const s = bySymbol.get(r.symbol) ?? { n: 0, pnl: 0 };
  s.n++; s.pnl += r.pnl;
  bySymbol.set(r.symbol, s);
}
console.log('\nby symbol at 5U:');
for (const [sym, s] of [...bySymbol].sort((x,y)=>y[1].pnl-x[1].pnl).slice(0,8)) {
  console.log(`  ${sym.padEnd(14)} n=${String(s.n).padStart(3)} pnl=${s.pnl.toFixed(3)}U`);
}
