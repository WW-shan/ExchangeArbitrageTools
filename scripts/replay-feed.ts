import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  runReplay,
  type ReplayBook,
  type ReplayFixture,
  type ReplayMarket,
} from '../apps/scanner/src/replay.js';

interface FeedRecord {
  venueId: string;
  exchangeSymbol: string;
  fetchedAt: number;
  receivedAt: number;
  exchangeTimestamp?: number;
  sequence?: number;
  asks: Array<[string, string]>;
  bids: Array<[string, string]>;
  source: 'rest' | 'websocket' | 'replay';
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function normalizeSymbol(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function loadRecords(directory: string, pair: string): FeedRecord[] {
  const target = normalizeSymbol(pair);
  const records: FeedRecord[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = readFileSync(join(directory, name), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      const record = JSON.parse(clean) as FeedRecord;
      if (normalizeSymbol(record.exchangeSymbol) !== target) continue;
      records.push(record);
    }
  }
  return records.sort((left, right) => left.receivedAt - right.receivedAt);
}

function bookFor(record: FeedRecord): ReplayBook {
  return {
    venueId: record.venueId,
    exchangeSymbol: record.exchangeSymbol,
    fetchedAt: record.fetchedAt,
    receivedAt: record.receivedAt,
    ...(record.exchangeTimestamp !== undefined
      ? { exchangeTimestamp: record.exchangeTimestamp }
      : {}),
    ...(record.sequence !== undefined ? { sequence: record.sequence } : {}),
    asks: record.asks,
    bids: record.bids,
    source: record.source,
  };
}

function marketFor(
  venueId: string,
  record: FeedRecord,
  base: string,
  quote: string,
  feeBps: string,
): ReplayMarket {
  return {
    venueId,
    exchangeSymbol: record.exchangeSymbol,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
    active: true,
    pricePrecision: 8,
    amountPrecision: 8,
    amountStep: '0.00000001',
    priceStep: '0.00000001',
    minNotional: '1',
    feeTakerBps: feeBps,
    supportsIoc: true,
    supportsFok: false,
  };
}

function latestAtOrBefore(records: readonly FeedRecord[], at: number): FeedRecord | undefined {
  let low = 0;
  let high = records.length - 1;
  let found: FeedRecord | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (records[mid]!.receivedAt <= at) {
      found = records[mid]!;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

async function main(): Promise<void> {
  const directory = resolve(arg('--dir', 'data/feed'));
  const pair = arg('--pair', 'CAKE/USDT');
  const [base, quote] = pair.split('/');
  if (!base || !quote) throw new Error('pair must look like BASE/QUOTE');
  const feeBps = arg('--fee-bps', '10');
  const minNetBps = arg('--min-net-bps', '20');
  const maxAgeMs = Number(arg('--max-age-ms', '2000'));
  const stepMs = Math.max(50, Number(arg('--step-ms', '500')));
  const maxSamples = Math.max(1, Number(arg('--max-samples', '20000')));
  const paperSimulation = process.argv.includes('--paper');

  const records = loadRecords(directory, pair);
  if (records.length === 0) throw new Error(`no feed records for ${pair} in ${directory}`);
  const byVenue = new Map<string, FeedRecord[]>();
  for (const record of records) {
    const rows = byVenue.get(record.venueId) ?? [];
    rows.push(record);
    byVenue.set(record.venueId, rows);
  }
  const venues = [...byVenue.keys()].sort();
  if (venues.length < 2) throw new Error('replay requires at least two recorded venues');
  const markets: Record<string, ReplayMarket> = {};
  for (const venueId of venues) {
    markets[venueId] = marketFor(venueId, byVenue.get(venueId)![0]!, base, quote, feeBps);
  }
  const start = records[0]!.receivedAt;
  const end = records.at(-1)!.receivedAt;
  const samples: Array<Record<string, unknown>> = [];
  for (let at = start; at <= end && samples.length < maxSamples; at += stepMs) {
    const sample: Record<string, unknown> = { sampledAt: at };
    let count = 0;
    for (const venueId of venues) {
      const record = latestAtOrBefore(byVenue.get(venueId)!, at);
      if (!record || at - record.receivedAt > maxAgeMs) continue;
      sample[venueId] = bookFor(record);
      count += 1;
    }
    if (count >= 2) samples.push(sample);
  }
  if (samples.length === 0) throw new Error('no samples with at least two fresh venues');
  const fixture: ReplayFixture = {
    name: `Recorded ${pair}`,
    kind: 'recorded-feed',
    base,
    quote,
    requestedNotional: arg('--notional', '30'),
    settings: {
      minProfitUsd: '0',
      safetyBufferBps: '0',
      minNetProfitBps: minNetBps,
      maxOrderbookAgeMs: String(maxAgeMs),
      maxSlippageBps: '50',
      maxGasCostUsd: '0',
      maxTransferTaxBps: '0',
    },
    markets,
    samples,
  };
  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  const report = await runReplay(fixture, { repository, paperSimulation });
  const safePair = pair.replace('/', '-');
  const output = resolve(arg('--out', `data/feed-replay-${safePair}.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  repository.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
