/**
 * Latency benchmark: TypeScript reference vs Rust worker on real books.
 *
 *   node rust/bench-depth.mjs [--rounds 2000]
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import Decimal from 'decimal.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
const depth = await import(pathToFileURL(resolve(root, 'packages/core/dist/depth.js')).href);

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const rounds = Number(arg('--rounds', '2000'));

const books = [];
for await (const line of createInterface({ input: createReadStream(resolve(here, 'depth-rs/cases.jsonl')) })) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  if (record.fn !== 'calculateSellDepthByBase') continue;
  books.push(record.args[0]);
  if (books.length >= 40) break;
}

const decBook = (value) => ({
  ...value,
  asks: value.asks.map((l) => ({ price: new Decimal(l.price), amount: new Decimal(l.amount) })),
  bids: value.bids.map((l) => ({ price: new Decimal(l.price), amount: new Decimal(l.amount) })),
});
const plainBook = (value) => ({
  asks: value.asks.map((l) => ({ price: String(l.price), amount: String(l.amount) })),
  bids: value.bids.map((l) => ({ price: String(l.price), amount: String(l.amount) })),
});

const amounts = ['3', '5', '10', '20'];

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// --- TypeScript ---
const tsSamples = [];
for (let i = 0; i < rounds; i += 1) {
  const book = decBook(books[i % books.length]);
  const amount = new Decimal(amounts[i % amounts.length]);
  const start = process.hrtime.bigint();
  depth.calculateSellDepthByBase(book, amount);
  tsSamples.push(Number(process.hrtime.bigint() - start) / 1e3);
}

// --- Rust worker (serial request/response, as the hot path will use it) ---
const worker = spawn(resolve(here, 'depth-rs/target/release/depth-worker.exe'), [], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = createInterface({ input: worker.stdout });
const pending = [];
lines.on('line', (line) => {
  const waiter = pending.shift();
  if (waiter) waiter(line);
});
const call = (payload) =>
  new Promise((resolveCall) => {
    pending.push(resolveCall);
    worker.stdin.write(`${payload}\n`);
  });

const rsSamples = [];
for (let i = 0; i < rounds; i += 1) {
  const book = plainBook(books[i % books.length]);
  const amount = amounts[i % amounts.length];
  const start = process.hrtime.bigint();
  await call(JSON.stringify({ op: 'sellByBase', book, amount }));
  rsSamples.push(Number(process.hrtime.bigint() - start) / 1e3);
}
worker.stdin.end();

const report = (label, samples) => {
  console.log(
    `${label.padEnd(10)} p50 ${percentile(samples, 50).toFixed(1).padStart(7)} us  ` +
      `p90 ${percentile(samples, 90).toFixed(1).padStart(7)} us  ` +
      `p99 ${percentile(samples, 99).toFixed(1).padStart(7)} us`,
  );
};
console.log(`rounds=${rounds} books=${books.length}`);
report('TypeScript', tsSamples);
report('Rust', rsSamples);
