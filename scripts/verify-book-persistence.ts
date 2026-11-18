/**
 * Ground-truth check: does the recorded book actually predict the price one
 * second later? If a snapshot says "sell here at X", we can verify against the
 * next real snapshot whether X was ever fillable.
 *
 * This is the test that kills a backtest: replaying stale or frozen snapshots
 * produces infinite profit that never existed.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/rotation.sqlite', { readOnly: true });
const rows = db.prepare(
  `SELECT venue_id, fetched_at, bids_json, asks_json FROM orderbooks
   WHERE exchange_symbol='WARD/USDT' AND valid=1 ORDER BY fetched_at`
).all();

const byVenue = new Map();
for (const r of rows) {
  const arr = byVenue.get(r.venue_id) ?? [];
  arr.push({
    at: Number(r.fetched_at),
    bid: Number(JSON.parse(r.bids_json)[0][0]),
    ask: Number(JSON.parse(r.asks_json)[0][0]),
  });
  byVenue.set(r.venue_id, arr);
}

console.log('Does a quoted price survive to the next snapshot?\n');
for (const [venue, list] of byVenue) {
  let quotedAskStillThere = 0, quotedBidStillThere = 0, total = 0;
  const horizons = [1000, 3000, 10000, 30000];
  const stats = new Map(horizons.map(h => [h, { ask: 0, bid: 0, n: 0 }]));
  for (let i = 0; i < list.length; i++) {
    for (const h of horizons) {
      const target = list[i].at + h;
      const next = list.find((row, idx) => idx > i && row.at >= target);
      if (!next) continue;
      const s = stats.get(h);
      s.n++;
      // Would a buy limit at the quoted ask have filled? i.e. did price trade there
      if (next.ask <= list[i].ask) s.ask++;
      if (next.bid >= list[i].bid) s.bid++;
    }
  }
  console.log(venue);
  for (const h of horizons) {
    const s = stats.get(h);
    if (!s.n) continue;
    console.log(`  +${String(h/1000).padStart(2)}s: ask still reachable ${(s.ask/s.n*100).toFixed(0)}%  bid still reachable ${(s.bid/s.n*100).toFixed(0)}%  (n=${s.n})`);
  }
}
