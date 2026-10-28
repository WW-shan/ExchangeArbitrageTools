import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  Decimal,
  marketBaseMultiplier,
  marketExchangeBase,
  type OrderBookSnapshot,
  type TickerSnapshot,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  applyFeeOverride,
  createCexAdapter,
  createPublicRuntime,
  feeAfterRebate,
  mergeAccountFeeFile,
} from '@arb/venues-cex';
import { costSettings, loadConfig } from '../apps/scanner/src/config.js';
import {
  analyzeS1Capacity,
  type CapacityFeeScenario,
  type CapacityRouteAnalysis,
} from '../apps/scanner/src/capacity.js';
import {
  buildLongTailUniverse,
  type LongTailCandidate,
  type LongTailVenueInput,
} from '../apps/scanner/src/universe.js';

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

function decimalList(name: string, fallback: string): Decimal[] {
  return listArg(name, fallback).map((value) => new Decimal(value));
}

function watchlistBases(path: string): string[] {
  if (!existsSync(path)) throw new Error(`watchlist not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bases?: unknown };
  if (!Array.isArray(parsed.bases) || parsed.bases.some((value) => typeof value !== 'string')) {
    throw new Error('watchlist must contain a string bases array');
  }
  return parsed.bases.map((value) => value.trim().toUpperCase()).filter(Boolean);
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

function routeKey(base: string, quote: string, buyVenue: string, sellVenue: string): string {
  return base + '/' + quote + '|' + buyVenue + '->' + sellVenue;
}

function actualScenario(route: CapacityRouteAnalysis): CapacityRouteAnalysis['scenarios'][number] {
  return (
    route.scenarios.find((scenario) => scenario.feeScenario.label === 'actual') ??
    route.scenarios[0]!
  );
}

const CRITICAL_FLAGS = new Set([
  'price_outlier',
  'stale_book',
  'invalid_book',
  'one_sided_book',
  'no_depth',
  'min_notional_above_cap',
  'balance_missing',
  'balance_zero',
]);

function routeClassification(
  route: CapacityRouteAnalysis,
): 'clean' | 'review' | 'near_miss' | 'rejected' | 'no_edge' {
  const actual = actualScenario(route);
  if (actual.maxEligibleNotional === undefined) {
    return actual.maxFeeBreakEvenNotional !== undefined ? 'near_miss' : 'no_edge';
  }
  if (route.flags.some((flag) => CRITICAL_FLAGS.has(flag))) return 'rejected';
  if (route.flags.includes('extreme_spread')) return 'review';
  return 'clean';
}

function classificationRank(route: CapacityRouteAnalysis): number {
  return { clean: 0, review: 1, near_miss: 2, rejected: 3, no_edge: 4 }[routeClassification(route)];
}

function routeVolumes(candidate: LongTailCandidate | undefined): Record<string, string> {
  if (!candidate) return {};
  const result: Record<string, string> = {};
  for (const venue of candidate.venues) result[venue.venueId] = venue.quoteVolume24h.toFixed(2);
  return result;
}

function freeBalance(
  balances: ReadonlyArray<{ venueId: string; currency: string; free: Decimal }>,
  venueId: string,
  currency: string,
): Decimal | undefined {
  const target = currency.trim().toUpperCase();
  const rows = balances.filter(
    (balance) => balance.venueId === venueId && balance.currency.trim().toUpperCase() === target,
  );
  if (rows.length === 0) return undefined;
  return rows.reduce((total, balance) => total.plus(balance.free), new Decimal(0));
}

async function main(): Promise<void> {
  const configPath = arg('--config', process.env.ARB_CONFIG ?? 'config/longtail.toml');
  const config = loadConfig(configPath);
  const venues = listArg('--venues', config.scanner.enabledVenues.join(','));
  if (venues.length < 2) throw new Error('--venues must contain at least two venues');
  const quotes = listArg('--quote', config.scanner.quoteCurrency);
  if (quotes.length === 0) throw new Error('--quote must not be empty');
  const minVolume = new Decimal(arg('--min-volume', config.scanner.min24hQuoteVolumeUsd.toFixed()));
  const maxVolume = new Decimal(
    arg('--max-volume', config.scanner.max24hQuoteVolumeUsd?.toFixed() ?? '500000'),
  );
  const maxCandidates = Math.max(1, Number(arg('--max-bases', arg('--max-candidates', '200'))));
  const maxBookCandidates = Math.max(0, Number(arg('--max-book-candidates', '60')));
  const watchlistPath = arg('--watchlist', '');
  const bases = new Set(
    [...listArg('--bases', ''), ...(watchlistPath ? watchlistBases(watchlistPath) : [])].map(
      (value) => value.toUpperCase(),
    ),
  );
  const depth = Math.max(1, Number(arg('--depth', String(config.scanner.orderBookDepth))));
  const rps = Math.max(1, Number(arg('--rps', '4')));
  const timeoutMs = Math.max(1000, Number(arg('--timeout-ms', '30000')));
  const concurrency = Math.max(1, Number(arg('--concurrency', '4')));
  const minNotional = new Decimal(arg('--min-notional', '0.5'));
  const maxNotional = new Decimal(arg('--max-notional', '100'));
  const step = new Decimal(arg('--step', '0.5'));
  const probes = decimalList('--probes', '1,2,5,10,15,20,30,50,100');
  const scenarioBps = decimalList('--fee-scenarios', '0,2,5,10,20');
  const maxTickerAgeMs = Math.max(1000, Number(arg('--max-ticker-age-ms', '900000')));
  const balanceMaxAgeMs = Math.max(
    0,
    Number(arg('--balance-max-age-ms', String(config.scanner.balanceMaxAgeMs))),
  );
  const requireBalances =
    process.argv.includes('--require-balances') || config.scanner.requireBalancesForS1;
  const output = resolve(arg('--out', 'data/longtail-scan.json'));
  const topCount = Math.max(1, Number(arg('--top', '20')));
  const detailCount = Math.max(0, Number(arg('--detail', '5')));
  const takerBpsArg = arg('--taker-bps', '');

  const feeOverrides = mergeAccountFeeFile(config.fees, config.scanner.feeFile);
  if (takerBpsArg) {
    for (const venueId of venues) {
      const existing = feeOverrides[venueId] ?? {};
      const existingMaker = feeAfterRebate(existing.makerBps, existing.rebatePct);
      feeOverrides[venueId] = {
        ...(existingMaker !== undefined ? { makerBps: existingMaker } : {}),
        takerBps: new Decimal(takerBpsArg),
        rebatePct: new Decimal(0),
        source: 'config',
      };
    }
  }

  const venueInputs: LongTailVenueInput[] = [];
  const adapters = new Map<string, ReturnType<typeof createCexAdapter>>();
  const marketCounts: Record<string, number> = {};
  const tickerCounts: Record<string, number> = {};
  const loadErrors: Record<string, string> = {};
  let balanceRepository: ArbitrageRepository | undefined;
  let balances: ReturnType<ArbitrageRepository['latestBalances']> = [];
  try {
    if (existsSync(config.database.path)) {
      balanceRepository = new ArbitrageRepository(openDatabase(config.database.path));
      balances = balanceRepository.latestBalances({
        maxAgeMs: balanceMaxAgeMs,
        now: Date.now(),
      });
    }
  } catch (error) {
    loadErrors.balances = String(error);
  }
  if (requireBalances && balances.length === 0) {
    balanceRepository?.close();
    throw new Error(
      'fresh stored balances are required; run npm run executor:balances with ARB_CONFIG=' +
        configPath,
    );
  }
  try {
    for (const venueId of venues) {
      const runtime = createPublicRuntime(rps);
      const adapter = createCexAdapter(venueId, runtime, { readOnly: true });
      adapters.set(venueId, adapter);
      try {
        const markets = await withTimeout(adapter.loadMarkets(), timeoutMs, venueId + ' markets');
        const priced = markets.map((market) => applyFeeOverride(market, feeOverrides));
        let tickers: TickerSnapshot[] = [];
        if (adapter.fetchTickers) {
          tickers = await withTimeout(adapter.fetchTickers(), timeoutMs, venueId + ' tickers');
        }
        venueInputs.push({ venueId, markets: priced, tickers });
        marketCounts[venueId] = priced.length;
        tickerCounts[venueId] = tickers.length;
      } catch (error) {
        loadErrors[venueId] = String(error);
      }
    }
    if (venueInputs.length < 2) {
      throw new Error('fewer than two venues loaded: ' + JSON.stringify(loadErrors));
    }
    const now = Date.now();
    let candidates = buildLongTailUniverse({
      venues: venueInputs,
      quoteCurrencies: quotes,
      minQuoteVolumeUsd: minVolume,
      maxQuoteVolumeUsd: maxVolume,
      maxCandidates: bases.size > 0 ? 100000 : maxCandidates,
      maxTickerAgeMs,
      now,
    });
    if (bases.size > 0) {
      candidates = candidates
        .filter((candidate) => bases.has(candidate.base.toUpperCase()))
        .slice(0, maxCandidates);
    }
    const bookCandidates =
      bases.size > 0 || maxBookCandidates === 0
        ? candidates
        : candidates.slice(0, Math.min(maxBookCandidates, candidates.length));
    console.log(
      JSON.stringify({
        configPath,
        venues,
        quotes,
        marketCounts,
        tickerCounts,
        loadErrors,
        minVolume: minVolume.toFixed(),
        maxVolume: maxVolume.toFixed(),
        balanceRows: balances.length,
        requireBalances,
        balanceMaxAgeMs,
        candidates: candidates.length,
        bookCandidates: bookCandidates.length,
        bases: bases.size > 0 ? [...bases] : null,
      }),
    );

    const settings = costSettings(config.scanner);
    const routes: CapacityRouteAnalysis[] = [];
    const routeVolumesByKey: Record<string, Record<string, string>> = {};
    const analyzeCandidate = (candidate: LongTailCandidate, analysisNow: number): void => {
      const candidateBooks = new Map<string, OrderBookSnapshot>();
      for (const venue of candidate.venues) {
        const book = books.get(candidate.base + '/' + candidate.quote + '|' + venue.venueId);
        if (book) candidateBooks.set(venue.venueId, book);
      }
      if (candidateBooks.size < 2) return;
      for (const buy of candidate.venues) {
        for (const sell of candidate.venues) {
          if (buy.venueId === sell.venueId) continue;
          const buyBook = candidateBooks.get(buy.venueId);
          const sellBook = candidateBooks.get(sell.venueId);
          if (!buyBook || !sellBook) continue;
          const actualBuyFee = buy.market.feeTakerBps ?? new Decimal(0);
          const actualSellFee = sell.market.feeTakerBps ?? new Decimal(0);
          const scenarios: CapacityFeeScenario[] = [
            { label: 'actual', buyTakerBps: actualBuyFee, sellTakerBps: actualSellFee },
          ];
          const buyQuoteFree = freeBalance(balances, buy.venueId, candidate.quote);
          const sellBaseFree = freeBalance(
            balances,
            sell.venueId,
            marketExchangeBase(sell.market),
          )?.mul(marketBaseMultiplier(sell.market));
          const seen = new Set<string>([actualBuyFee.toFixed() + '|' + actualSellFee.toFixed()]);
          for (const fee of scenarioBps) {
            const key = fee.toFixed() + '|' + fee.toFixed();
            if (seen.has(key)) continue;
            seen.add(key);
            scenarios.push({
              label: fee.toFixed() + 'bps',
              buyTakerBps: fee,
              sellTakerBps: fee,
            });
          }
          const route = analyzeS1Capacity({
            base: candidate.base,
            quote: candidate.quote,
            buyMarket: buy.market,
            sellMarket: sell.market,
            buyBook,
            sellBook,
            settings,
            now: analysisNow,
            scenarios,
            minNotional,
            maxNotional,
            step,
            probes,
            ...(buyQuoteFree !== undefined ? { buyQuoteFree } : {}),
            ...(sellBaseFree !== undefined ? { sellBaseFree } : {}),
          });
          if (requireBalances && (buyQuoteFree === undefined || sellBaseFree === undefined)) {
            route.flags.push('balance_missing');
          }
          if (buyQuoteFree?.lte(0) || sellBaseFree?.lte(0)) {
            route.flags.push('balance_zero');
          }
          routes.push(route);
          routeVolumesByKey[routeKey(candidate.base, candidate.quote, buy.venueId, sell.venueId)] =
            routeVolumes(candidate);
        }
      }
    };
    const books = new Map<string, OrderBookSnapshot>();
    const bookErrors: Array<{ base: string; venueId: string; error: string }> = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, bookCandidates.length) },
      async () => {
        while (true) {
          const current = cursor;
          cursor += 1;
          if (current >= bookCandidates.length) return;
          const candidate = bookCandidates[current]!;
          await Promise.all(
            candidate.venues.map(async (venue) => {
              const adapter = adapters.get(venue.venueId);
              if (!adapter) {
                bookErrors.push({
                  base: candidate.base,
                  venueId: venue.venueId,
                  error: 'adapter_missing',
                });
                return;
              }
              try {
                const book = await fetchBookWithRetry(
                  adapter,
                  venue.market.exchangeSymbol,
                  depth,
                  timeoutMs,
                );
                books.set(candidate.base + '/' + candidate.quote + '|' + venue.venueId, book);
              } catch (error) {
                bookErrors.push({
                  base: candidate.base,
                  venueId: venue.venueId,
                  error: String(error),
                });
              }
            }),
          );
          analyzeCandidate(candidate, Date.now());
        }
      },
    );
    await Promise.all(workers);

    const nowAfterBooks = Date.now();

    routes.sort((left, right) => {
      const risk = classificationRank(left) - classificationRank(right);
      if (risk !== 0) return risk;
      const leftActual = actualScenario(left);
      const rightActual = actualScenario(right);
      const leftEligible = leftActual.maxEligibleNotional ?? new Decimal(0);
      const rightEligible = rightActual.maxEligibleNotional ?? new Decimal(0);
      const eligible = rightEligible.comparedTo(leftEligible);
      if (eligible !== 0) return eligible;
      const leftFee = leftActual.maxFeeBreakEvenNotional ?? new Decimal(0);
      const rightFee = rightActual.maxFeeBreakEvenNotional ?? new Decimal(0);
      const fee = rightFee.comparedTo(leftFee);
      if (fee !== 0) return fee;
      return (right.topGrossBps ?? new Decimal(0)).comparedTo(left.topGrossBps ?? new Decimal(0));
    });

    const cleanRoutes = routes.filter((route) => routeClassification(route) === 'clean');
    const reviewRoutes = routes.filter((route) => routeClassification(route) === 'review');
    const eligibleRoutes = [...cleanRoutes, ...reviewRoutes];
    const feeRoutes = routes.filter(
      (route) => actualScenario(route).maxFeeBreakEvenNotional !== undefined,
    );
    console.log(
      JSON.stringify({
        booksOk: books.size,
        routes: routes.length,
        feeBreakEvenRoutes: feeRoutes.length,
        eligibleRoutes: eligibleRoutes.length,
        cleanRoutes: cleanRoutes.length,
        reviewRoutes: reviewRoutes.length,
        bookErrors: bookErrors.length,
      }),
    );
    console.log(
      'class pair direction topGross feeBE maxFeeBE maxProfit maxEligible bestNet binding flags',
    );
    for (const route of routes.slice(0, topCount)) {
      const actual = actualScenario(route);
      const volumes =
        routeVolumesByKey[routeKey(route.base, route.quote, route.buyVenue, route.sellVenue)];
      console.log(
        [
          'class=' + routeClassification(route),
          route.base + '/' + route.quote,
          route.buyVenue + '->' + route.sellVenue,
          'vol=' +
            Object.entries(volumes ?? {})
              .map(([venue, value]) => venue + ':' + value)
              .join(','),
          'gross=' + fmt(route.topGrossBps),
          'feeBE=' + fmt(actual.feeBreakEvenBps),
          'maxFeeBE=' + fmt(actual.maxFeeBreakEvenNotional),
          'maxProfit=' + fmt(actual.maxProfitableNotional),
          'maxEligible=' + fmt(actual.maxEligibleNotional),
          'maxBalance=' + fmt(actual.maxBalanceNotional),
          'balBinding=' + (actual.balanceBinding ?? '-'),
          'bestNet=' + fmt(actual.bestNetBps),
          'binding=' + actual.bindingReason,
          'flags=' + route.flags.join('|'),
        ].join(' '),
      );
    }
    for (const route of routes.slice(0, detailCount)) {
      const actual = actualScenario(route);
      console.log(
        'curve ' +
          route.base +
          '/' +
          route.quote +
          ' ' +
          route.buyVenue +
          '->' +
          route.sellVenue +
          ' fees=' +
          actual.feeScenario.buyTakerBps.toFixed() +
          '/' +
          actual.feeScenario.sellTakerBps.toFixed() +
          'bps',
      );
      for (const point of actual.curve) {
        console.log(
          [
            '  n=' + point.requestedNotional.toFixed(2),
            'gross=' + point.grossBps.toFixed(2),
            'net=' + point.netBps.toFixed(2),
            'pnl=' + point.netProfit.toFixed(4),
            'valid=' + point.valid,
            'reasons=' + point.reasons.join('|'),
          ].join(' '),
        );
      }
    }

    const payload = {
      generatedAt: new Date(nowAfterBooks).toISOString(),
      configPath,
      parameters: {
        venues,
        quotes,
        watchlist: watchlistPath || null,
        bases: [...bases],
        minVolume: minVolume.toFixed(),
        maxVolume: maxVolume.toFixed(),
        maxBookCandidates,
        minNotional: minNotional.toFixed(),
        maxNotional: maxNotional.toFixed(),
        step: step.toFixed(),
        probes: probes.map((probe) => probe.toFixed()),
        feeScenarios: scenarioBps.map((fee) => fee.toFixed()),
        balanceRows: balances.length,
        requireBalances,
        balanceMaxAgeMs,
        depth,
      },
      marketCounts,
      tickerCounts,
      loadErrors,
      candidates: candidates.map((candidate) => ({
        base: candidate.base,
        quote: candidate.quote,
        minQuoteVolume24h: candidate.minQuoteVolume24h,
        maxQuoteVolume24h: candidate.maxQuoteVolume24h,
        topTickerGrossBps: candidate.topTickerGrossBps,
        venues: candidate.venues.map((venue) => ({
          venueId: venue.venueId,
          exchangeSymbol: venue.market.exchangeSymbol,
          quoteVolume24h: venue.quoteVolume24h,
          minAmount: venue.market.minAmount,
          minNotional: venue.market.minNotional,
          amountStep: venue.market.amountStep,
          priceStep: venue.market.priceStep,
          feeTakerBps: venue.market.feeTakerBps,
        })),
      })),
      booksOk: books.size,
      bookErrors,
      routes: routes.map((route) => ({
        ...route,
        classification: routeClassification(route),
        volumes:
          routeVolumesByKey[routeKey(route.base, route.quote, route.buyVenue, route.sellVenue)],
      })),
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      JSON.stringify(jsonSafe(payload), null, 2) + String.fromCharCode(10),
      'utf8',
    );
    console.log('wrote ' + output);
  } finally {
    balanceRepository?.close();
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
