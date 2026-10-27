import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Decimal, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import {
  applyFeeOverride,
  createCexAdapter,
  createPublicRuntime,
  mergeAccountFeeFile,
} from '@arb/venues-cex';
import { costSettings, loadConfig } from '../apps/scanner/src/config.js';
import { analyzeS1Capacity, type CapacityFeeScenario } from '../apps/scanner/src/capacity.js';
import { summarizeSpreadSamples, type SpreadSample } from '../apps/scanner/src/spread-tracking.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function listArg(name: string, fallback: string): string[] {
  return arg(name, fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms);
      timer.unref?.();
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchBookWithRetry(
  adapter: { fetchOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> },
  symbol: string,
  depth: number,
  timeoutMs: number,
): Promise<OrderBookSnapshot> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await withTimeout(adapter.fetchOrderBook(symbol, depth), timeoutMs, symbol);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(500);
    }
  }
  throw lastError;
}

function jsonSafe(value: unknown): unknown {
  if (Decimal.isDecimal(value)) return value.toFixed();
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = jsonSafe(entry);
    return result;
  }
  return value;
}

function fmt(value: Decimal | undefined, digits = 2): string {
  return value ? value.toFixed(digits) : '-';
}

function findMarket(
  markets: readonly MarketMetadata[],
  base: string,
  quote: string,
): MarketMetadata | undefined {
  return markets.find(
    (market) =>
      market.active &&
      market.base.trim().toUpperCase() === base &&
      market.quote.trim().toUpperCase() === quote,
  );
}

async function main(): Promise<void> {
  const configPath = arg('--config', process.env.ARB_CONFIG ?? 'config/longtail.toml');
  const config = loadConfig(configPath);
  const base = arg('--base', '').trim().toUpperCase();
  if (!base) throw new Error('--base is required');
  const quote = arg('--quote', config.scanner.quoteCurrency).trim().toUpperCase();
  const venues = listArg('--venues', config.scanner.enabledVenues.join(','));
  if (venues.length < 2) throw new Error('--venues must contain at least two venues');
  const durationMs = Math.max(1, Number(arg('--duration-ms', '180000')));
  const intervalMs = Math.max(100, Number(arg('--interval-ms', '3000')));
  const depth = Math.max(1, Number(arg('--depth', String(config.scanner.orderBookDepth))));
  const rps = Math.max(1, Number(arg('--rps', '4')));
  const timeoutMs = Math.max(1000, Number(arg('--timeout-ms', '30000')));
  const minNotional = new Decimal(arg('--min-notional', '0.5'));
  const maxNotional = new Decimal(arg('--max-notional', '100'));
  const step = new Decimal(arg('--step', '0.5'));
  const probes = listArg('--probes', '5,10,20,50,100').map((value) => new Decimal(value));
  const output = resolve(arg('--out', 'data/spread-track-' + base + '.json'));
  const takerBpsArg = arg('--taker-bps', '');

  const feeOverrides = mergeAccountFeeFile(config.fees, config.scanner.feeFile);
  if (takerBpsArg) {
    for (const venueId of venues) {
      feeOverrides[venueId] = {
        ...(feeOverrides[venueId] ?? {}),
        takerBps: new Decimal(takerBpsArg),
      };
    }
  }

  const adapters = new Map<string, ReturnType<typeof createCexAdapter>>();
  const venueMarkets = new Map<string, MarketMetadata>();
  const errors: Array<{ at: number; venueId?: string; error: string }> = [];
  try {
    for (const venueId of venues) {
      const adapter = createCexAdapter(venueId, createPublicRuntime(rps), { readOnly: true });
      adapters.set(venueId, adapter);
      const markets = await withTimeout(adapter.loadMarkets(), timeoutMs, venueId + ' markets');
      const priced = markets.map((market) => applyFeeOverride(market, feeOverrides));
      const market = findMarket(priced, base, quote);
      if (!market) throw new Error('no active ' + base + '/' + quote + ' market on ' + venueId);
      venueMarkets.set(venueId, market);
    }

    const settings = costSettings(config.scanner);
    const samples: SpreadSample[] = [];
    const startedAt = Date.now();
    let cycle = 0;
    while (Date.now() - startedAt < durationMs) {
      cycle += 1;
      const cycleStartedAt = Date.now();
      const books = new Map<string, OrderBookSnapshot>();
      await Promise.all(
        venues.map(async (venueId) => {
          const adapter = adapters.get(venueId);
          const market = venueMarkets.get(venueId);
          if (!adapter || !market) return;
          try {
            const book = await fetchBookWithRetry(adapter, market.exchangeSymbol, depth, timeoutMs);
            books.set(venueId, book);
          } catch (error) {
            errors.push({ at: Date.now(), venueId, error: String(error) });
          }
        }),
      );
      if (books.size < 2) {
        console.log('cycle ' + cycle + ' skipped: ' + (books.size < 2 ? 'missing_book' : ''));
        await sleep(intervalMs);
        continue;
      }
      const analyzedAt = Date.now();
      for (const buyVenue of venues) {
        for (const sellVenue of venues) {
          if (buyVenue === sellVenue) continue;
          const buyMarket = venueMarkets.get(buyVenue);
          const sellMarket = venueMarkets.get(sellVenue);
          const buyBook = books.get(buyVenue);
          const sellBook = books.get(sellVenue);
          if (!buyMarket || !sellMarket || !buyBook || !sellBook) continue;
          const actualBuyFee = buyMarket.feeTakerBps ?? new Decimal(0);
          const actualSellFee = sellMarket.feeTakerBps ?? new Decimal(0);
          const scenario: CapacityFeeScenario = {
            label: 'actual',
            buyTakerBps: actualBuyFee,
            sellTakerBps: actualSellFee,
          };
          const route = analyzeS1Capacity({
            base,
            quote,
            buyMarket,
            sellMarket,
            buyBook,
            sellBook,
            settings,
            now: analyzedAt,
            scenarios: [scenario],
            minNotional,
            maxNotional,
            step,
            probes,
          });
          const actual = route.scenarios[0]!;
          const sample: SpreadSample = {
            direction: buyVenue + '->' + sellVenue,
            timestamp: analyzedAt,
            ...(route.topGrossBps ? { grossBps: route.topGrossBps } : {}),
            netBps: actual.bestNetBps,
            ...(actual.maxFeeBreakEvenNotional
              ? { maxFeeBreakEvenNotional: actual.maxFeeBreakEvenNotional }
              : {}),
            ...(actual.maxEligibleNotional
              ? { maxEligibleNotional: actual.maxEligibleNotional }
              : {}),
            bindingReason: actual.bindingReason,
            flags: route.flags,
          };
          samples.push(sample);
          console.log(
            [
              new Date(analyzedAt).toISOString(),
              base + '/' + quote,
              sample.direction,
              'gross=' + fmt(sample.grossBps),
              'net=' + fmt(sample.netBps),
              'maxFee=' + fmt(sample.maxFeeBreakEvenNotional),
              'maxEligible=' + fmt(sample.maxEligibleNotional),
              'binding=' + sample.bindingReason,
              'flags=' + sample.flags.join('|'),
            ].join(' '),
          );
        }
      }
      const elapsed = Date.now() - cycleStartedAt;
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    }
    const summaries = summarizeSpreadSamples(samples, intervalMs);
    console.log('summary');
    for (const summary of summaries) {
      console.log(
        [
          summary.direction,
          'samples=' + summary.samples,
          'eligible=' + summary.eligibleSamples,
          'eligibleRatio=' + summary.eligibleRatio.toFixed(4),
          'maxGross=' + fmt(summary.maxGrossBps),
          'p50Gross=' + fmt(summary.p50GrossBps),
          'p95Gross=' + fmt(summary.p95GrossBps),
          'maxEligible=' + fmt(summary.maxEligibleNotional),
          'longestEligibleMs=' + summary.longestEligibleStreakMs,
          'timeToFirstLossMs=' + (summary.timeToFirstLossAfterEligibleMs ?? '-'),
        ].join(' '),
      );
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      base,
      quote,
      venues,
      durationMs,
      intervalMs,
      sampleCount: samples.length,
      errors,
      samples,
      summaries,
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      JSON.stringify(jsonSafe(payload), null, 2) + String.fromCharCode(10),
      'utf8',
    );
    console.log('wrote ' + output);
  } finally {
    for (const adapter of adapters.values()) {
      try {
        await withTimeout(Promise.resolve(adapter.close?.()), 5000, 'close');
      } catch {
        // best-effort shutdown
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
