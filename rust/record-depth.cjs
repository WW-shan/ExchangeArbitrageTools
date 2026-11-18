/**
 * Records real order-book cases for the depth port.
 *
 * rust-anything's generator produces JSON shapes the source cannot consume
 * (`Decimal` has no `gt` on a plain object), so this script replays the
 * production order books instead: those are the inputs that actually matter.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('data/rotation.sqlite', { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000');

const rows = db
  .prepare(
    `SELECT venue_id, exchange_symbol, fetched_at, bids_json, asks_json
     FROM orderbooks WHERE valid = 1 ORDER BY id DESC LIMIT 1200`,
  )
  .all();

console.log('books from db:', rows.length);

const books = rows.map((row) => ({
  venueId: row.venue_id,
  exchangeSymbol: row.exchange_symbol,
  fetchedAt: Number(row.fetched_at),
  receivedAt: Number(row.fetched_at),
  asks: JSON.parse(row.asks_json).map(([price, amount]) => ({ price, amount })),
  bids: JSON.parse(row.bids_json).map(([price, amount]) => ({ price, amount })),
  source: 'rest',
}));

writeFileSync = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, 'utf8');
};

const notionals = ['3', '6.6', '10', '25', '100', '0.5'];
const bases = ['100', '1888', '3040', '50000', '0.01'];

const cases = [];
for (const book of books) {
  for (const n of notionals) {
    cases.push({ fn: 'calculateBuyDepthByQuote', args: [book, n] });
    cases.push({ fn: 'calculateSellDepthByQuote', args: [book, n] });
  }
  for (const a of bases) {
    cases.push({ fn: 'calculateBuyDepthByBase', args: [book, a] });
    cases.push({ fn: 'calculateSellDepthByBase', args: [book, a] });
  }
}

for (let i = 0; i + 1 < books.length; i += 2) {
  for (const n of ['3', '6.6', '10']) {
    cases.push({ fn: 'simulateTwoLegBaseAmount', args: [books[i], books[i + 1], n] });
  }
}

const out = path.join('rust', 'depth-cases.jsonl');
fs.writeFileSync(out, cases.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
console.log('cases written:', cases.length, '->', out);
