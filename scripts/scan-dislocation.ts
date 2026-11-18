/**
 * Read-only dislocation scanner.
 *
 * Every round it:
 *   1. pulls one ticker snapshot per venue (one request each, no rate pressure);
 *   2. pairs markets that list the same base against USDT on two or more venues;
 *   3. records how often each venue's top of book repeats (frozen detection);
 *   4. keeps a trailing median per venue+symbol as that venue's own baseline;
 *   5. classifies any large spread as spike / structural / repricing;
 *   6. confirms candidates on the real order book and reports executable size.
 *
 * It never touches credentials and never creates an order.
 *
 *   npx tsx scripts/scan-dislocation.ts --config config/dislocation.toml
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BookLivenessTracker,
  Decimal,
  RollingMedian,
  assessTransferability,
  detectDislocation,
  type DislocationKind,
  type DislocationSignal,
} from '@arb/core';
import { createCexAdapter, createPublicRuntime } from '@arb/venues-cex';
import type { CurrencyMetadata } from '@arb/core';
import { loadDislocationConfig, type DislocationConfig } from '../apps/scanner/src/dislocation-config.js';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const configPath = arg('--config', 'config/dislocation.toml');
const rounds = Number(arg('--rounds', '0')) || Number.POSITIVE_INFINITY;
const config = loadDislocationConfig(resolve(configPath));

interface VenueMarket {
  symbol: string;
  base: string;
  quoteVolume: Decimal;
}

interface VenueState {
  venueId: string;
  markets: Map<string, VenueMarket>;
  baselines: Map<string, RollingMedian>;
  currencies: CurrencyMetadata[];
}

/**
 * Cached transferability per symbol+venue pair. Currency metadata changes on
 * the order of days, so a slow refresh is enough.
 */
const transferCache = new Map<string, { verdict: string; reasons: string[]; at: number }>();
const TRANSFER_CACHE_MS = 10 * 60_000;

function transferability(leftVenue: string, rightVenue: string, symbol: string) {
  const base = symbol.split('/')[0] ?? symbol;
  const key = `${leftVenue}|${rightVenue}|${base}`;
  const cached = transferCache.get(key);
  if (cached && Date.now() - cached.at < TRANSFER_CACHE_MS) return cached;
  const left = states.get(leftVenue);
  const right = states.get(rightVenue);
  if (!left || !right) return undefined;
  const result = assessTransferability({
    symbol: base,
    leftVenue,
    rightVenue,
    left: left.currencies,
    right: right.currencies,
  });
  const row = { verdict: result.verdict, reasons: result.reasons, at: Date.now() };
  transferCache.set(key, row);
  return row;
}

interface Observation {
  venueId: string;
  symbol: string;
  bid: Decimal;
  ask: Decimal;
  /** Venue-provided timestamp, already clamped to our clock. */
  at: number;
  /** Venue-reported feed delay for this snapshot. */
  lagMs: number;
}

/** Per-venue feed delay. A venue that lags by minutes cannot be arbitraged. */
const feedDelay = new Map<string, { lastLagMs: number; p50: number; samples: number[] }>();

const runtime = createPublicRuntime(8);
const adapters = new Map(
  config.venues.map((venueId) => [
    venueId,
    createCexAdapter(venueId, runtime, config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
  ]),
);
const states = new Map<string, VenueState>();
const liveness = new BookLivenessTracker({
  maxRepeatCount: config.liveness.maxRepeatCount,
  staleMs: config.liveness.staleMs,
});

interface Episode {
  symbol: string;
  kind: DislocationKind;
  venueBuy: string;
  venueSell: string;
  start: number;
  end: number;
  samples: number;
  bestBps: Decimal;
  bestExecutableUsd: Decimal;
}

const episodes = new Map<string, Episode>();
const counts = new Map<string, number>();
const deepSeen = new Set<string>();

function bump(key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

async function loadUniverse(): Promise<void> {
  await Promise.all(
    [...adapters].map(async ([venueId, adapter]) => {
      const [markets, tickers, currencies] = await Promise.all([
        adapter.loadMarkets(),
        adapter.fetchTickers ? adapter.fetchTickers() : Promise.resolve([]),
        adapter.fetchCurrencies ? adapter.fetchCurrencies() : Promise.resolve([]),
      ]);
      const bySymbol = new Map(tickers.map((ticker) => [ticker.exchangeSymbol, ticker]));
      const rows = new Map<string, VenueMarket>();
      for (const market of markets) {
        if (!market.active) continue;
        if (market.quote.trim().toUpperCase() !== config.quoteCurrency) continue;
        const ticker = bySymbol.get(market.exchangeSymbol);
        const quoteVolume =
          ticker?.quoteVolume ??
          (ticker?.baseVolume && ticker?.last ? ticker.baseVolume.mul(ticker.last) : new Decimal(0));
        if (!Number.isFinite(quoteVolume.toNumber())) continue;
        if (quoteVolume.lt(config.minLegQuoteVolumeUsd)) continue;
        if (quoteVolume.gt(config.maxLegQuoteVolumeUsd)) continue;
        rows.set(market.exchangeSymbol, {
          symbol: market.exchangeSymbol,
          base: market.base.trim().toUpperCase(),
          quoteVolume,
        });
      }
      states.set(venueId, {
        venueId,
        markets: rows,
        baselines: new Map(),
        currencies,
      });
      const withdrawable = currencies.filter((row) =>
        row.networks.some((network) => network.withdrawEnabled),
      ).length;
      console.log(
        `${venueId}: ${rows.size} ${config.quoteCurrency} markets in band, ` +
          `${currencies.length} currencies (${withdrawable} withdrawable)`,
      );
    }),
  );
}

/** Bases listed on at least two venues, ranked by the quieter leg's volume. */
function candidateBases(): string[] {
  const byBase = new Map<string, { venues: number; minVolume: Decimal }>();
  for (const state of states.values()) {
    const seen = new Set<string>();
    for (const market of state.markets.values()) {
      if (seen.has(market.base)) continue;
      seen.add(market.base);
      const row = byBase.get(market.base);
      if (!row) {
        byBase.set(market.base, { venues: 1, minVolume: market.quoteVolume });
      } else {
        row.venues += 1;
        if (market.quoteVolume.lt(row.minVolume)) row.minVolume = market.quoteVolume;
      }
    }
  }
  return [...byBase.entries()]
    .filter(([, row]) => row.venues >= 2)
    .sort((left, right) => left[1].minVolume.comparedTo(right[1].minVolume))
    .slice(0, config.maxBases)
    .map(([base]) => base);
}

function baselineFor(state: VenueState, symbol: string, now: number) {
  return state.baselines.get(symbol)?.baseline(now, config.detection.baselineWindowMs);
}

function recordEpisode(
  signal: DislocationSignal,
  symbol: string,
  executableUsd: Decimal,
  now: number,
): void {
  if (!signal.isDislocation || !signal.kind) return;
  const key = `${symbol}|${signal.kind}|${signal.venueBuy}|${signal.venueSell}`;
  const existing = episodes.get(key);
  if (existing && now - existing.end <= 60_000) {
    existing.end = now;
    existing.samples += 1;
    if (signal.magnitudeBps.gt(existing.bestBps)) existing.bestBps = signal.magnitudeBps;
    if (executableUsd.gt(existing.bestExecutableUsd)) existing.bestExecutableUsd = executableUsd;
    return;
  }
  episodes.set(key, {
    symbol,
    kind: signal.kind,
    venueBuy: signal.venueBuy!,
    venueSell: signal.venueSell!,
    start: now,
    end: now,
    samples: 1,
    bestBps: signal.magnitudeBps,
    bestExecutableUsd: executableUsd,
  });
}

async function scanRound(round: number, bases: readonly string[]): Promise<void> {
  const now = Date.now();
  const tickerRows = await Promise.all(
    [...adapters].map(async ([venueId, adapter]) => {
      try {
        const tickers = adapter.fetchTickers ? await adapter.fetchTickers() : [];
        return { venueId, tickers };
      } catch (error) {
        console.error(`${venueId} tickers failed: ${String(error)}`);
        return { venueId, tickers: [] };
      }
    }),
  );

  const observations = new Map<string, Observation[]>();
  for (const { venueId, tickers } of tickerRows) {
    const state = states.get(venueId);
    if (!state) continue;
    for (const ticker of tickers) {
      if (!ticker.bid?.gt(0) || !ticker.ask?.gt(0)) continue;
      if (ticker.bid.gt(ticker.ask)) continue;
      const market = state.markets.get(ticker.exchangeSymbol);
      if (!market) continue;
      const rawAge = now - ticker.timestamp;
      const lagMs = Number.isFinite(rawAge) ? Math.max(0, rawAge) : Number.POSITIVE_INFINITY;
      const delay = feedDelay.get(venueId) ?? { lastLagMs: 0, p50: 0, samples: [] as number[] };
      delay.samples.push(lagMs);
      if (delay.samples.length > 5000) delay.samples.shift();
      feedDelay.set(venueId, delay);
      const key = market.base;
      const rows = observations.get(key) ?? [];
      rows.push({
        venueId,
        symbol: ticker.exchangeSymbol,
        bid: ticker.bid,
        ask: ticker.ask,
        at: Number.isFinite(ticker.timestamp) ? Math.min(ticker.timestamp, now) : now,
        lagMs,
      });
      observations.set(key, rows);
      liveness.observe(venueId, ticker.exchangeSymbol, ticker.bid.toString(), ticker.ask.toString(), now);
      const baselines = state.baselines.get(ticker.exchangeSymbol) ?? new RollingMedian(config.detection.baselineCapacity);
      baselines.push(ticker.bid.plus(ticker.ask).div(2), now);
      state.baselines.set(ticker.exchangeSymbol, baselines);
    }
  }

  const candidates: { symbol: string; left: Observation; right: Observation; signal: DislocationSignal }[] = [];
  for (const base of bases) {
    const rows = (observations.get(base) ?? []).filter((row) => {
      const state = states.get(row.venueId);
      return state && baselineFor(state, row.symbol, now) !== undefined;
    });
    if (rows.length < 2) continue;
    const live = rows.filter((row) => row.lagMs <= config.detection.maxQuoteAgeMs);
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const left = live[i]!;
        const right = live[j]!;
        const leftState = states.get(left.venueId)!;
        const rightState = states.get(right.venueId)!;
          // A venue whose feed lags by minutes is not a price source. Skip the
        // pair, but keep evaluating the other venues for this base.
        if (left.lagMs > config.detection.maxQuoteAgeMs || right.lagMs > config.detection.maxQuoteAgeMs) {
          bump('rejected_venue_lag');
          continue;
        }
        const transfer = transferability(left.venueId, right.venueId, left.symbol);
        if (transfer && transfer.verdict !== 'transferable') {
          bump(`rejected_transfer_${transfer.verdict}`);
          continue;
        }
        if (liveness.isFrozen(left.venueId, left.symbol)) {
          bump('rejected_frozen');
          continue;
        }
        if (liveness.isFrozen(right.venueId, right.symbol)) {
          bump('rejected_frozen');
          continue;
        }
        const signal = detectDislocation({
          left: {
            venueId: left.venueId,
            bid: left.bid,
            ask: left.ask,
            timestamp: left.at,
            repeatCount: liveness.repeatCount(left.venueId, left.symbol),
          },
          right: {
            venueId: right.venueId,
            bid: right.bid,
            ask: right.ask,
            timestamp: right.at,
            repeatCount: liveness.repeatCount(right.venueId, right.symbol),
          },
          leftBaseline: baselineFor(leftState, left.symbol, now),
          rightBaseline: baselineFor(rightState, right.symbol, now),
          now,
          settings: {
            minDislocationBps: config.detection.minDislocationBps,
            minVenueDeviationBps: config.detection.minVenueDeviationBps,
            maxCounterDeviationBps: config.detection.maxCounterDeviationBps,
            maxQuoteAgeMs: config.detection.maxQuoteAgeMs,
            maxBaselineAgeMs: config.detection.baselineWindowMs,
            minBaselineSamples: config.detection.minBaselineSamples,
            maxRepeatCount: config.liveness.maxRepeatCount,
          },
        });
        for (const reason of signal.reasons) bump(reason);
        if (signal.magnitudeBps.gt(0)) bump('spread_above_zero');
        if (signal.isDislocation) {
          bump('spike_signal');
          candidates.push({ symbol: left.symbol, left, right, signal });
        } else if (signal.kind) {
          bump(`kind_${signal.kind}`);
        }
      }
    }
  }

  // Depth confirmation, strongest first.
  candidates.sort((a, b) => b.signal.magnitudeBps.comparedTo(a.signal.magnitudeBps));
  for (const candidate of candidates.slice(0, config.sampling.maxDeepChecks)) {
    const buy = adapters.get(candidate.signal.venueBuy!);
    const sell = adapters.get(candidate.signal.venueSell!);
    if (!buy || !sell) continue;
    try {
      const [buyBook, sellBook] = await Promise.all([
        buy.fetchOrderBook(candidate.left.venueId === candidate.signal.venueBuy ? candidate.left.symbol : candidate.right.symbol, config.sampling.orderbookDepth),
        sell.fetchOrderBook(candidate.left.venueId === candidate.signal.venueSell ? candidate.left.symbol : candidate.right.symbol, config.sampling.orderbookDepth),
      ]);
      const requested = new Decimal(20);
      let spend = requested;
      let base = new Decimal(0);
      for (const level of buyBook.asks) {
        if (spend.lte(0)) break;
        const levelQuote = level.price.mul(level.amount);
        const take = Decimal.min(spend, levelQuote);
        base = base.plus(take.div(level.price));
        spend = spend.minus(take);
      }
      let receive = new Decimal(0);
      let remaining = base;
      for (const level of sellBook.bids) {
        if (remaining.lte(0)) break;
        const take = Decimal.min(remaining, level.amount);
        receive = receive.plus(take.mul(level.price));
        remaining = remaining.minus(take);
      }
      const executableUsd = receive;
      const spreadBps = executableUsd.minus(requested).div(requested).mul(10_000);
      if (executableUsd.lt(config.sampling.minExecutableNotionalUsd)) {
        bump('rejected_thin_depth');
        continue;
      }
      bump('confirmed');
      const key = candidate.symbol;
      if (!deepSeen.has(key)) {
        deepSeen.add(key);
        console.log(
          `CONFIRMED ${candidate.symbol} buy=${candidate.signal.venueBuy} sell=${candidate.signal.venueSell} ` +
            `signal=${candidate.signal.magnitudeBps.toFixed(0)}bps depth=${spreadBps.toFixed(0)}bps size=${executableUsd.toFixed(2)}U`,
        );
      }
      recordEpisode(candidate.signal, candidate.symbol, executableUsd, now);
    } catch (error) {
      bump('rejected_depth_error');
      console.error(`depth ${candidate.symbol}: ${String(error)}`);
    }
  }

  if (round % 10 === 0) {
    liveness.prune(now);
    for (const [venueId, delay] of feedDelay) {
      const sorted = [...delay.samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      delay.p50 = median;
      delay.lastLagMs = sorted[sorted.length - 1] ?? 0;
      const frozen = [...states.get(venueId)?.markets.values() ?? []].filter((market) =>
        liveness.isFrozen(venueId, market.symbol),
      ).length;
      console.log(
        `feed ${venueId.padEnd(7)} lagP50=${median}ms lagMax=${delay.lastLagMs}ms frozenBooks=${frozen}/${states.get(venueId)?.markets.size ?? 0}`,
      );
    }
    const top = [...episodes.values()]
      .filter((episode) => now - episode.end <= 3600_000)
      .sort((a, b) => b.bestBps.comparedTo(a.bestBps))
      .slice(0, 8);
    if (top.length > 0) {
      console.log(
        `round ${round}: ${top
          .map((ep) => `${ep.symbol} ${ep.kind} ${ep.venueBuy}->${ep.venueSell} ${ep.bestBps.toFixed(0)}bps/${ep.bestExecutableUsd.toFixed(0)}U`)
          .join(' | ')}`,
      );
    }
  }
}

function persist(summary: boolean): void {
  mkdirSync(config.output.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    generatedAt: new Date().toISOString(),
    config: {
      venues: config.venues,
      minDislocationBps: config.detection.minDislocationBps.toString(),
      minExecutableNotionalUsd: config.sampling.minExecutableNotionalUsd.toString(),
    },
    counters: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    episodes: [...episodes.values()].map((episode) => ({
      ...episode,
      bestBps: episode.bestBps.toString(),
      bestExecutableUsd: episode.bestExecutableUsd.toString(),
    })),
    liveness: liveness.snapshot(),
  };
  writeFileSync(resolve(config.output.dir, `round-${stamp}.json`), JSON.stringify(payload, null, 2));
  if (summary) {
    writeFileSync(resolve(config.output.dir, 'latest.json'), JSON.stringify(payload, null, 2));
  }
}

async function main(): Promise<void> {
  console.log(`dislocation scanner: venues=${config.venues.join(',')} min=${config.detection.minDislocationBps}bps`);
  await loadUniverse();
  const bases = candidateBases();
  console.log(`${bases.length} bases listed on at least two venues: ${bases.slice(0, 20).join(', ')}...`);
  if (bases.length === 0) throw new Error('no cross-venue bases after filtering');

  for (let round = 1; round <= rounds; round += 1) {
    const started = Date.now();
    await scanRound(round, bases);
    persist(round % config.output.summaryEveryRounds === 0);
    const elapsed = Date.now() - started;
    if (round % 10 === 0) console.log(`round ${round} done in ${elapsed}ms`);
    const wait = config.sampling.tickerIntervalMs - elapsed;
    if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  }
  persist(true);
}

try {
  await main();
} finally {
  await Promise.all([...adapters.values()].map((adapter) => adapter.close?.().catch(() => undefined)));
}




