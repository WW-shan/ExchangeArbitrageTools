/**
 * Can we actually harvest the WARD spread?
 *
 * The half-life analysis shows WARD spreads persist for minutes, not
 * milliseconds, so slow execution is not the blocker. What matters is:
 *   1. after fees, is the spread still positive?
 *   2. how much notional can the book absorb?
 *
 *   npx tsx scripts/backtest-ward-persistence.ts
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/rotation.sqlite', { readOnly: true });
const rows = db
  .prepare(
    `SELECT venue_id, fetched_at, bids_json, asks_json
     FROM orderbooks WHERE exchange_symbol = 'WARD/USDT' AND valid = 1
     ORDER BY fetched_at`,
  )
  .all();

// Gate taker 2.97 bps, Bitget taker 10 bps (from exchange_markets).
const FEES = { gateio: 2.97, bitget: 10 };

const grid = new Map();
for (const row of rows) {
  const slot = Math.round(Number(row.fetched_at) / 30_000) * 30_000;
  const entry = grid.get(slot) ?? {};
  entry[row.venue_id] = {
    bids: JSON.parse(row.bids_json).map(([p, a]) => [Number(p), Number(a)]),
    asks: JSON.parse(row.asks_json).map(([p, a]) => [Number(p), Number(a)]),
  };
  grid.set(slot, entry);
}

function fillBuy(asks, quote) {
  let spend = quote;
  let base = 0;
  for (const [price, amount] of asks) {
    if (spend <= 0) break;
    const levelQuote = price * amount;
    const take = Math.min(spend, levelQuote);
    base += take / price;
    spend -= take;
  }
  return { base, spent: quote - spend };
}

function fillSell(bids, base) {
  let remaining = base;
  let quote = 0;
  for (const [price, amount] of bids) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, amount);
    quote += take * price;
    remaining -= take;
  }
  return { quote, soldBase: base - remaining };
}

const results = [];
for (const [slot, entry] of grid) {
  const gate = entry.gateio;
  const bitget = entry.bitget;
  if (!gate || !bitget) continue;
  for (const [buyVenue, sellVenue] of [
    ['bitget', 'gateio'],
    ['gateio', 'bitget'],
  ]) {
    const buy = entry[buyVenue];
    const sell = entry[sellVenue];
    if (!buy.asks.length || !sell.bids.length) continue;
    const bestAsk = buy.asks[0][0];
    const bestBid = sell.bids[0][0];
    const grossBps = ((bestBid - bestAsk) / bestAsk) * 10_000;
    if (grossBps < 20) continue;
    const feeBps = FEES[buyVenue] + FEES[sellVenue];
    const netBps = grossBps - feeBps;
    if (netBps <= 0) continue;
    // Walk the book at a fixed quote size, matching the live sizing.
    for (const quote of [3, 5, 10, 20, 50]) {
      const bought = fillBuy(buy.asks, quote);
      const sold = fillSell(sell.bids, bought.base);
      const pnl = sold.quote - bought.spent;
      const notional = bought.spent;
      const netBpsActual = notional > 0 ? (pnl / notional) * 10_000 - feeBps : 0;
      results.push({
        slot,
        dir: `${buyVenue}->${sellVenue}`,
        quote,
        notional,
        pnl,
        netBpsActual,
        fillRatio: bought.base > 0 ? sold.soldBase / bought.base : 0,
      });
    }
  }
}

if (results.length === 0) {
  console.log('no WARD spread cleared fees at any size');
  process.exit(0);
}

console.log(`samples clearing both fees: ${results.length}\n`);
for (const quote of [3, 5, 10, 20, 50]) {
  const rows = results.filter((row) => row.quote === quote);
  if (!rows.length) continue;
  const profitable = rows.filter((row) => row.pnl > 0);
  const totalPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  const worst = rows.reduce((min, row) => Math.min(min, row.pnl), Infinity);
  const best = rows.reduce((max, row) => Math.max(max, row.pnl), -Infinity);
  const avgBps = rows.reduce((sum, row) => sum + row.netBpsActual, 0) / rows.length;
  console.log(
    `size ${String(quote).padStart(2)} USDT: n=${String(rows.length).padStart(3)} ` +
      `profitable=${String(profitable.length).padStart(3)} avgNet=${avgBps.toFixed(0)}bps ` +
      `total=${totalPnl.toFixed(2)}U worst=${worst.toFixed(3)} best=${best.toFixed(3)}`,
  );
}
const byDir = new Map();
for (const row of results) {
  if (row.quote !== 5) continue;
  const state = byDir.get(row.dir) ?? { n: 0, pnl: 0 };
  state.n += 1;
  state.pnl += row.pnl;
  byDir.set(row.dir, state);
}
console.log('\nat 5 USDT per trade:');
for (const [dir, state] of byDir) {
  console.log(`  ${dir}: n=${state.n} total=${state.pnl.toFixed(3)}U`);
}
