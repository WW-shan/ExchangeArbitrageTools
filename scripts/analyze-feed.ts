import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Decimal } from 'decimal.js';
import {
  evaluateS1Direction,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';

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

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index]!;
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

function toSnapshot(record: FeedRecord): OrderBookSnapshot {
  return {
    venueId: record.venueId,
    exchangeSymbol: record.exchangeSymbol,
    fetchedAt: record.fetchedAt,
    receivedAt: record.receivedAt,
    ...(record.exchangeTimestamp !== undefined
      ? { exchangeTimestamp: record.exchangeTimestamp }
      : {}),
    ...(record.sequence !== undefined ? { sequence: record.sequence } : {}),
    asks: record.asks.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    bids: record.bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: record.source,
  };
}

function marketFor(
  venueId: string,
  record: FeedRecord,
  base: string,
  quote: string,
  feeBps: string,
  makerBps: string | undefined,
): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: record.exchangeSymbol,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
    active: true,
    pricePrecision: 8,
    amountPrecision: 8,
    amountStep: new Decimal('0.00000001'),
    priceStep: new Decimal('0.00000001'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal(feeBps),
    ...(makerBps !== undefined ? { makerFeeBps: new Decimal(makerBps) } : {}),
    supportsIoc: true,
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
  const notional = new Decimal(arg('--notional', '30'));
  const feeBps = arg('--fee-bps', '10');
  const makerBps = process.argv.includes('--maker-bps') ? arg('--maker-bps', '0') : undefined;
  const executionMode = arg('--execution-mode', 'taker_taker') as
    'taker_taker' | 'maker_buy_taker_sell' | 'taker_buy_maker_sell';
  const makerFillProbability = new Decimal(arg('--maker-fill-probability', '0.5'));
  const minNetBps = new Decimal(arg('--min-net-bps', '20'));
  const maxAgeMs = Number(arg('--max-age-ms', '2000'));
  const stepMs = Math.max(50, Number(arg('--step-ms', '500')));
  const maxSamples = Math.max(1, Number(arg('--max-samples', '20000')));
  const arrivalLatencyMs = Math.max(0, Number(arg('--arrival-latency-ms', '0')));
  const windowGapMs = Math.max(0, Number(arg('--window-gap-ms', '2000')));

  const records = loadRecords(directory, pair);
  if (records.length === 0) throw new Error(`no feed records for ${pair} in ${directory}`);
  const byVenue = new Map<string, FeedRecord[]>();
  for (const record of records) {
    const rows = byVenue.get(record.venueId) ?? [];
    rows.push(record);
    byVenue.set(record.venueId, rows);
  }
  const venues = [...byVenue.keys()].sort();
  const start = records[0]!.receivedAt;
  const end = records.at(-1)!.receivedAt;
  const settings: CostSettings = {
    minProfitUsd: new Decimal(0),
    safetyBufferBps: new Decimal(0),
    minNetProfitBps: minNetBps,
    maxOrderbookAgeMs: maxAgeMs,
    maxSlippageBps: new Decimal(50),
    maxGasCostUsd: new Decimal(0),
    maxTransferTaxBps: new Decimal(0),
    executionMode,
    makerFillProbability,
  };

  let samples = 0;
  let samplesWithAllVenues = 0;
  let rawEdgeFrames = 0;
  let netOpportunityFrames = 0;
  let bestNetBps = new Decimal(0);
  let bestGrossBps = new Decimal(0);
  let bestRoute = '';
  let arrivalChecked = 0;
  let arrivalSurvived = 0;
  let arrivalBestNetBps = new Decimal(0);
  const openWindows = new Map<string, { start: number; last: number }>();
  const windowDurations: number[] = [];
  const routeCounts = new Map<string, number>();
  const rejectionCounts = new Map<string, number>();
  const ages: number[] = [];
  for (let at = start; at <= end && samples < maxSamples; at += stepMs) {
    samples += 1;
    const books = new Map<string, { record: FeedRecord; snapshot: OrderBookSnapshot }>();
    for (const venueId of venues) {
      const record = latestAtOrBefore(byVenue.get(venueId)!, at);
      if (!record || at - record.receivedAt > maxAgeMs) continue;
      ages.push(at - record.receivedAt);
      books.set(venueId, { record, snapshot: toSnapshot(record) });
    }
    if (books.size < 2) continue;
    samplesWithAllVenues += 1;
    let raw = false;
    let net = false;
    for (let i = 0; i < venues.length; i += 1) {
      for (let j = i + 1; j < venues.length; j += 1) {
        const first = books.get(venues[i]!);
        const second = books.get(venues[j]!);
        if (!first || !second) continue;
        for (const [buy, sell] of [
          [first, second],
          [second, first],
        ] as const) {
          const ask = buy.snapshot.asks[0]?.price;
          const bid = sell.snapshot.bids[0]?.price;
          const rawEdge = Boolean(ask && bid && bid.gt(ask));
          if (ask && bid && rawEdge) {
            raw = true;
            const grossBps = bid.minus(ask).div(ask).mul(10_000);
            if (grossBps.gt(bestGrossBps)) bestGrossBps = grossBps;
          }
          const result = evaluateS1Direction({
            base,
            quote,
            buyMarket: marketFor(buy.record.venueId, buy.record, base, quote, feeBps, makerBps),
            sellMarket: marketFor(sell.record.venueId, sell.record, base, quote, feeBps, makerBps),
            buyBook: buy.snapshot,
            sellBook: sell.snapshot,
            requestedNotional: notional,
            settings,
            now: at,
            venueHealth: { [buy.record.venueId]: 'B', [sell.record.venueId]: 'B' },
          });
          if (rawEdge) {
            for (const reason of result.rejectionReasons) {
              rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
            }
          }
          if (result.valid) {
            net = true;
            const route = `${buy.record.venueId}->${sell.record.venueId}`;
            routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
            const open = openWindows.get(route);
            if (!open || at - open.last > windowGapMs) {
              if (open) windowDurations.push(open.last - open.start);
              openWindows.set(route, { start: at, last: at });
            } else {
              open.last = at;
            }
            if (result.netProfitBps.gt(bestNetBps)) {
              bestNetBps = result.netProfitBps;
              bestRoute = route;
            }
            if (arrivalLatencyMs > 0) {
              const arrivalAt = at + arrivalLatencyMs;
              const arrivalBuy = latestAtOrBefore(byVenue.get(buy.record.venueId)!, arrivalAt);
              const arrivalSell = latestAtOrBefore(byVenue.get(sell.record.venueId)!, arrivalAt);
              if (
                arrivalBuy &&
                arrivalSell &&
                arrivalAt - arrivalBuy.receivedAt <= maxAgeMs &&
                arrivalAt - arrivalSell.receivedAt <= maxAgeMs
              ) {
                arrivalChecked += 1;
                const arrival = evaluateS1Direction({
                  base,
                  quote,
                  buyMarket: marketFor(
                    arrivalBuy.venueId,
                    arrivalBuy,
                    base,
                    quote,
                    feeBps,
                    makerBps,
                  ),
                  sellMarket: marketFor(
                    arrivalSell.venueId,
                    arrivalSell,
                    base,
                    quote,
                    feeBps,
                    makerBps,
                  ),
                  buyBook: toSnapshot(arrivalBuy),
                  sellBook: toSnapshot(arrivalSell),
                  requestedNotional: notional,
                  settings,
                  now: arrivalAt,
                  venueHealth: { [arrivalBuy.venueId]: 'B', [arrivalSell.venueId]: 'B' },
                });
                if (arrival.valid) {
                  arrivalSurvived += 1;
                  if (arrival.netProfitBps.gt(arrivalBestNetBps)) {
                    arrivalBestNetBps = arrival.netProfitBps;
                  }
                }
              }
            }
          }
        }
      }
    }
    if (raw) rawEdgeFrames += 1;
    if (net) netOpportunityFrames += 1;
  }

  ages.sort((left, right) => left - right);
  for (const open of openWindows.values()) windowDurations.push(open.last - open.start);
  windowDurations.sort((left, right) => left - right);
  const report = {
    pair,
    directory,
    records: records.length,
    venues: venues.map((venueId) => ({ venueId, updates: byVenue.get(venueId)!.length })),
    spanMs: end - start,
    stepMs,
    arrivalLatencyMs,
    windowGapMs,
    samples,
    samplesWithAllVenues,
    rawEdgeFrames,
    netOpportunityFrames,
    falsePositiveRate:
      rawEdgeFrames > 0 ? (rawEdgeFrames - netOpportunityFrames) / rawEdgeFrames : 0,
    bestNetBps: bestNetBps.toFixed(),
    bestGrossBps: bestGrossBps.toFixed(),
    bestRoute,
    opportunityWindows: {
      count: windowDurations.length,
      medianMs: percentile(windowDurations, 0.5),
      p90Ms: percentile(windowDurations, 0.9),
      maxMs: windowDurations.length > 0 ? windowDurations[windowDurations.length - 1]! : 0,
    },
    arrival: {
      checked: arrivalChecked,
      survived: arrivalSurvived,
      survivalRate: arrivalChecked > 0 ? arrivalSurvived / arrivalChecked : 0,
      bestNetBps: arrivalBestNetBps.toFixed(),
    },
    routeCounts: [...routeCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([route, count]) => ({ route, count })),
    rejectionCounts: [...rejectionCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([reason, count]) => ({ reason, count })),
    bookAgeMs: {
      p50: percentile(ages, 0.5),
      p95: percentile(ages, 0.95),
      max: ages.length > 0 ? ages[ages.length - 1]! : 0,
    },
  };
  const safePair = pair.replace('/', '-');
  const output = resolve(arg('--out', `data/feed-analysis-${safePair}.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
