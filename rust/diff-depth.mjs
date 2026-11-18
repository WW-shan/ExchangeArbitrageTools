/**
 * Differential test: replay recorded production order books through the
 * TypeScript reference and through the Rust worker, then compare results.
 *
 *   node rust/diff-depth.mjs [--limit N] [--cases path] [--worker path]
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
const casesPath = arg('--cases', resolve(here, 'depth-rs/cases.jsonl'));
const limit = Number(arg('--limit', '0')) || Number.POSITIVE_INFINITY;
const workerPath = arg('--worker', resolve(here, 'depth-rs/target/release/depth-worker.exe'));

function rehydrate(value) {
  if (Array.isArray(value)) return value.map(rehydrate);
  if (value && typeof value === 'object') {
    if (value.constructor?.$function === 'Decimal') {
      return new Decimal(`${value.s < 0 ? '-' : ''}${value.d.join('')}e${value.e}`);
    }
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = rehydrate(inner);
    return out;
  }
  return value;
}

function asPlain(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(asPlain);
  if (value instanceof Decimal) return value.toString();
  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = asPlain(inner);
    return out;
  }
  return value;
}

const plainBook = (value) => ({
  asks: (value.asks ?? []).map((l) => ({ price: String(l.price), amount: String(l.amount) })),
  bids: (value.bids ?? []).map((l) => ({ price: String(l.price), amount: String(l.amount) })),
});

const decBook = (value) => ({
  ...value,
  asks: (value.asks ?? []).map((l) => ({ price: new Decimal(String(l.price)), amount: new Decimal(String(l.amount)) })),
  bids: (value.bids ?? []).map((l) => ({ price: new Decimal(String(l.price)), amount: new Decimal(String(l.amount)) })),
});

const dec = (value) => new Decimal(String(value));

function toWorkerRequest(name, argv) {
  switch (name) {
    case 'calculateBuyDepthByQuote':
      return { op: 'buyByQuote', book: plainBook(argv[0]), amount: String(argv[1]) };
    case 'calculateBuyDepthByBase':
      return { op: 'buyByBase', book: plainBook(argv[0]), amount: String(argv[1]) };
    case 'calculateSellDepthByBase':
      return { op: 'sellByBase', book: plainBook(argv[0]), amount: String(argv[1]) };
    case 'calculateSellDepthByQuote':
      return { op: 'sellByQuote', book: plainBook(argv[0]), amount: String(argv[1]) };
    case 'simulateTwoLegBaseAmount':
      return {
        op: 'simulate',
        buyBook: plainBook(argv[0]),
        sellBook: plainBook(argv[1]),
        amount: String(argv[2]),
      };
    default:
      throw new Error(`unknown fn ${name}`);
  }
}

function reference(name, argv) {
  switch (name) {
    case 'calculateBuyDepthByQuote':
      return depth.calculateBuyDepthByQuote(decBook(argv[0]), dec(argv[1]));
    case 'calculateBuyDepthByBase':
      return depth.calculateBuyDepthByBase(decBook(argv[0]), dec(argv[1]));
    case 'calculateSellDepthByBase':
      return depth.calculateSellDepthByBase(decBook(argv[0]), dec(argv[1]));
    case 'calculateSellDepthByQuote':
      return depth.calculateSellDepthByQuote(decBook(argv[0]), dec(argv[1]));
    case 'simulateTwoLegBaseAmount':
      return depth.simulateTwoLegBaseAmount(decBook(argv[0]), decBook(argv[1]), dec(argv[2]));
    default:
      throw new Error(`unknown fn ${name}`);
  }
}

const cases = [];
for await (const line of createInterface({ input: createReadStream(casesPath) })) {
  if (!line.trim()) continue;
  if (cases.length >= limit) break;
  const record = JSON.parse(line);
  const argv = rehydrate(record.args);
  cases.push({ fn: record.fn, argv, request: toWorkerRequest(record.fn, argv) });
}
console.log(`loaded ${cases.length} cases`);

const worker = spawn(workerPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: worker.stdout });
const responses = [];
const reader = (async () => {
  for await (const line of lines) {
    if (line.trim()) responses.push(JSON.parse(line));
  }
})();

const started = process.hrtime.bigint();
const payload = cases.map((c) => JSON.stringify(c.request)).join('\n') + '\n';
worker.stdin.end(payload);
await reader;
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

let mismatches = 0;
const byFn = new Map();
for (let i = 0; i < cases.length; i += 1) {
  const { fn, argv } = cases[i];
  const expected = JSON.stringify(asPlain(reference(fn, argv)));
  const response = responses[i];
  const actual = response?.error ? `ERROR ${response.error}` : JSON.stringify(response?.ok);
  const stat = byFn.get(fn) ?? { total: 0, bad: 0 };
  stat.total += 1;
  if (expected !== actual) {
    stat.bad += 1;
    mismatches += 1;
    if (mismatches <= 5) {
      console.error(`\nMISMATCH #${i} ${fn}`);
      console.error('  ts:', expected.slice(0, 500));
      console.error('  rs:', actual.slice(0, 500));
    }
  }
  byFn.set(fn, stat);
}

for (const [fn, stat] of byFn) {
  console.log(`  ${fn}: ${stat.total - stat.bad}/${stat.total} identical`);
}
console.log(`\n${cases.length} cases in ${elapsedMs.toFixed(0)} ms (${(elapsedMs / cases.length * 1000).toFixed(1)} us/case)`);
console.log(mismatches === 0 ? 'RESULT: identical' : `RESULT: ${mismatches} mismatches`);
process.exitCode = mismatches === 0 ? 0 : 1;



