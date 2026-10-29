import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { Decimal, type MarketMetadata, type OhlcvCandle, type TickerSnapshot } from '@arb/core';
import {
  applyFeeOverride,
  createCexAdapter,
  createPublicRuntime,
  mergeAccountFeeFile,
  type CexAdapter,
} from '@arb/venues-cex';
import { loadConfig } from '../apps/scanner/src/config.js';
import {
  analyzeHistoricalPair,
  bestHistoricalDirection,
  rankHistoricalPairs,
} from '../apps/scanner/src/historical-backtest.js';
import {
  analyzePreparationPair,
  bestPreparationHorizon,
  type PreparationPairResult,
} from '../apps/scanner/src/preparation-backtest.js';
import {
  collectHistoricalCandles,
  historicalMaxLookbackDays,
  historicalTimeframeMs,
} from '../apps/scanner/src/historical-data.js';
import { buildLongTailUniverse } from '../apps/scanner/src/universe.js';

const EXCLUDED_BASES = new Set([
  'USDT',
  'USDC',
  'DAI',
  'FDUSD',
  'TUSD',
  'USDP',
  'BUSD',
  'EUR',
  'GBP',
]);

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

function baseListArg(name: string, fallback: string): string[] {
  return listArg(name, fallback).map((value) => value.toUpperCase());
}

function jsonSafe(value: unknown): unknown {
  if (Decimal.isDecimal(value)) return value.toFixed();
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

function fmt(value: Decimal | null | undefined, digits = 2): string {
  return value ? value.toFixed(digits) : '-';
}

function executionDirection(venue: string): string {
  return venue === 'gateio' ? 'gate' : venue;
}

async function withRetry<T>(operation: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 750 * attempt));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${String(lastError)}`);
}

async function fetchHistoricalCandles(
  adapter: CexAdapter,
  exchangeSymbol: string,
  timeframe: string,
  since: number,
  until: number,
): Promise<OhlcvCandle[]> {
  if (!adapter.fetchOHLCV) throw new Error(`${adapter.venueId} does not expose OHLCV`);
  const timeframeMs = historicalTimeframeMs(timeframe);
  const limit = adapter.venueId === 'hotcoin' ? 500 : 1000;
  return collectHistoricalCandles(
    {
      fetchPage: (cursor, pageLimit) =>
        withRetry(
          () => adapter.fetchOHLCV!(exchangeSymbol, timeframe, cursor, pageLimit),
          `${adapter.venueId} ${exchangeSymbol} ${timeframe}`,
        ),
    },
    timeframeMs,
    since,
    until,
    limit,
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => run()));
  return results;
}

async function main(): Promise<void> {
  const configPath = arg('--config', process.env.ARB_CONFIG ?? 'config/longtail.toml');
  const config = loadConfig(configPath);
  const venues = listArg('--venues', config.scanner.enabledVenues.join(','));
  if (venues.length < 2) throw new Error('at least two venues are required');
  const quote = arg('--quote', config.scanner.quoteCurrency).toUpperCase();
  const timeframe = arg('--timeframe', '15m');
  const timeframeMs = historicalTimeframeMs(timeframe);
  const days = Math.max(1, Number(arg('--days', '30')));
  const maxLookbackDays = historicalMaxLookbackDays(timeframe);
  if (days > maxLookbackDays) {
    throw new Error(
      `${timeframe} history is limited to ${maxLookbackDays} days by Gate's 10000-candle window; pass --days ${maxLookbackDays} or less`,
    );
  }
  const until = Date.parse(arg('--until', new Date().toISOString()));
  if (!Number.isFinite(until)) throw new Error('--until must be an ISO timestamp');
  const since = until - days * 24 * 60 * 60_000;
  const minVolume = new Decimal(arg('--min-volume', '1000'));
  const maxVolume = new Decimal(arg('--max-volume', '500000'));
  const maxCandidates = Math.max(1, Number(arg('--max-bases', '80')));
  const maxTickerAgeMs = Math.max(60_000, Number(arg('--max-ticker-age-ms', '900000')));
  const requestedBases = new Set(baseListArg('--bases', ''));
  const minNetProfitBps = new Decimal(arg('--min-net-profit-bps', '5'));
  const minProfitUsd = new Decimal(arg('--min-profit-usd', '0.01'));
  const safetyBufferBps = new Decimal(arg('--safety-buffer-bps', '2'));
  const extraSlippageBps = new Decimal(arg('--extra-slippage-bps', '10'));
  const minCandleQuoteVolumeUsd = new Decimal(arg('--min-candle-volume-usd', '20'));
  const maxSaneSpreadBps = new Decimal(arg('--max-sane-spread-bps', '3000'));
  const prepEnabled = process.argv.includes('--prep');
  const prepHorizonsMs = listArg('--prep-horizons-ms', '900000,1800000,3600000')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const prepBandBps = new Decimal(arg('--prep-band-bps', '5'));
  const prepTargetBps = new Decimal(arg('--prep-target-bps', '5'));
  const prepStopBps = new Decimal(arg('--prep-stop-bps', '50'));
  const prepMinSamples = Math.max(1, Number(arg('--prep-min-samples', '20')));
  const prepOutputPath = resolve(arg('--prep-out', 'config/s1-prep-calibration.json'));
  if (prepEnabled && prepHorizonsMs.length === 0) {
    throw new Error('--prep-horizons-ms must contain at least one positive horizon');
  }
  const notional = new Decimal(arg('--notional', config.scanner.requestedNotional.toFixed()));
  const concurrency = Math.max(1, Number(arg('--concurrency', '3')));
  const rps = Math.max(1, Number(arg('--rps', '4')));
  const discoverOnly = process.argv.includes('--discover-only');
  const outputPath = resolve(arg('--out', `data/historical-${timeframe}.json`));

  const feeOverrides = mergeAccountFeeFile(config.fees, config.scanner.feeFile);
  const adapters = new Map<string, CexAdapter>();
  const marketsByVenue = new Map<string, MarketMetadata[]>();
  const tickersByVenue = new Map<string, TickerSnapshot[]>();
  const loadErrors: string[] = [];

  try {
    for (const venueId of venues) {
      const adapter = createCexAdapter(venueId, createPublicRuntime(rps), { readOnly: true });
      adapters.set(venueId, adapter);
      try {
        const markets = (await adapter.loadMarkets()).map((market) =>
          applyFeeOverride(market, feeOverrides),
        );
        const tickers = adapter.fetchTickers ? await adapter.fetchTickers() : [];
        marketsByVenue.set(venueId, markets);
        tickersByVenue.set(venueId, tickers);
      } catch (error) {
        loadErrors.push(`${venueId}: ${String(error)}`);
      }
    }

    const discovered = buildLongTailUniverse({
      venues: venues.flatMap((venueId) => {
        const markets = marketsByVenue.get(venueId);
        const tickers = tickersByVenue.get(venueId);
        return markets && tickers ? [{ venueId, markets, tickers }] : [];
      }),
      quoteCurrencies: [quote],
      minQuoteVolumeUsd: minVolume,
      maxQuoteVolumeUsd: maxVolume,
      maxCandidates: requestedBases.size > 0 ? 1000 : maxCandidates,
      maxTickerAgeMs,
      now: Date.now(),
    }).filter(
      (candidate) =>
        (requestedBases.size === 0 || requestedBases.has(candidate.base)) &&
        !EXCLUDED_BASES.has(candidate.base) &&
        !/(?:3L|3S|5L|5S)$/.test(candidate.base),
    );
    const universe = requestedBases.size > 0 ? discovered : discovered.slice(0, maxCandidates);

    if (discoverOnly) {
      console.log(
        JSON.stringify(
          universe.map((candidate) => ({
            base: candidate.base,
            quote: candidate.quote,
            venues: candidate.venues.map((venue) => ({
              venueId: venue.venueId,
              volume24h: venue.quoteVolume24h.toFixed(2),
            })),
            topTickerGrossBps: candidate.topTickerGrossBps?.toFixed(2),
          })),
          null,
          2,
        ),
      );
      return;
    }

    console.error(
      JSON.stringify({
        configPath,
        venues,
        timeframe,
        days,
        candidates: universe.length,
        loadErrors,
      }),
    );

    const marketByVenue = new Map<string, Map<string, MarketMetadata>>();
    for (const [venueId, markets] of marketsByVenue) {
      const byBase = new Map<string, MarketMetadata>();
      for (const market of markets) {
        if (market.active && market.quote.toUpperCase() === quote) {
          byBase.set(market.base.toUpperCase(), market);
        }
      }
      marketByVenue.set(venueId, byBase);
    }

    let completed = 0;
    const pairs = await mapWithConcurrency(universe, concurrency, async (candidate) => {
      const candlesByVenue: Record<string, OhlcvCandle[]> = {};
      const feeBpsByVenue: Record<string, Decimal> = {};
      const pairErrors: string[] = [];
      for (const venueId of venues) {
        const market = marketByVenue.get(venueId)?.get(candidate.base);
        const adapter = adapters.get(venueId);
        if (!market || !adapter) {
          pairErrors.push(`${venueId}: market missing`);
          continue;
        }
        if (market.feeTakerBps === undefined) {
          pairErrors.push(`${venueId}: taker fee missing`);
          continue;
        }
        try {
          const candles = await fetchHistoricalCandles(
            adapter,
            market.exchangeSymbol,
            timeframe,
            since,
            until,
          );
          candlesByVenue[venueId] = candles;
          feeBpsByVenue[venueId] = market.feeTakerBps;
        } catch (error) {
          pairErrors.push(`${venueId}: ${String(error)}`);
        }
      }
      completed += 1;
      if (completed % 10 === 0 || completed === universe.length) {
        console.error(`progress ${completed}/${universe.length}`);
      }
      if (pairErrors.length > 0 || Object.keys(candlesByVenue).length < 2) {
        return { pair: undefined, error: `${candidate.base}/${quote}: ${pairErrors.join('; ')}` };
      }
      const pair = analyzeHistoricalPair({
        base: candidate.base,
        quote,
        candlesByVenue,
        feeBpsByVenue,
        timeframeMs,
        notional,
        minProfitUsd,
        minNetProfitBps,
        safetyBufferBps,
        extraSlippageBps,
        minCandleQuoteVolumeUsd,
        maxSaneSpreadBps,
        episodeGapMs: timeframeMs * 1.5,
      });
      const preparation = prepEnabled
        ? analyzePreparationPair({
            base: candidate.base,
            quote,
            candlesByVenue,
            feeBpsByVenue,
            timeframeMs,
            notional,
            safetyBufferBps,
            extraSlippageBps,
            minCandleQuoteVolumeUsd,
            maxSaneSpreadBps,
            prepBandBps,
            reverseTargetBps: prepTargetBps,
            stopBps: prepStopBps,
            horizonsMs: prepHorizonsMs,
          })
        : undefined;
      return {
        pair,
        preparation,
        error:
          pairErrors.length > 0
            ? `${candidate.base}/${quote}: ${pairErrors.join('; ')}`
            : undefined,
      };
    });

    const ranked = rankHistoricalPairs(pairs.flatMap((entry) => (entry.pair ? [entry.pair] : [])));
    const preparationByPair = new Map<string, PreparationPairResult>();
    for (const entry of pairs) {
      if (entry.pair && entry.preparation) {
        preparationByPair.set(`${entry.pair.base}/${entry.pair.quote}`, entry.preparation);
      }
    }
    const preparationRanking = ranked
      .map((pair) => preparationByPair.get(`${pair.base}/${pair.quote}`))
      .filter((entry): entry is PreparationPairResult => entry !== undefined);
    const calibrationEntries = ranked.flatMap((pair) => {
      const preparation = preparationByPair.get(`${pair.base}/${pair.quote}`);
      if (!preparation) return [];
      return preparation.directions.flatMap((direction) => {
        const best = bestPreparationHorizon(direction, prepMinSamples);
        if (!best) return [];
        return [
          {
            pair: `${pair.base}/${pair.quote}`,
            direction: `${executionDirection(direction.buyVenue)}->${executionDirection(direction.sellVenue)}`,
            horizonMs: best.horizonMs,
            candidateSamples: best.candidateSamples,
            reverseProbability: best.reverseHitRate,
            medianTimeToReverseMs: best.medianTimeToReverseMs ?? null,
            medianReverseNetBps: best.medianReverseNetBps ?? null,
            medianPrepCostBps: best.medianPrepCostBps,
            meanNoReverseLossBps: best.meanNoReverseLossBps,
            expectedValueBps: best.expectedValueBps,
            expectedValueUsd: best.expectedValueUsd,
          },
        ];
      });
    });
    const report = {
      generatedAt: new Date().toISOString(),
      configPath,
      parameters: {
        venues,
        quote,
        timeframe,
        days,
        since,
        until,
        minVolume: minVolume.toFixed(),
        maxVolume: maxVolume.toFixed(),
        maxCandidates,
        maxTickerAgeMs,
        requestedBases: [...requestedBases],
        notional: notional.toFixed(),
        minNetProfitBps: minNetProfitBps.toFixed(),
        minProfitUsd: minProfitUsd.toFixed(),
        safetyBufferBps: safetyBufferBps.toFixed(),
        extraSlippageBps: extraSlippageBps.toFixed(),
        minCandleQuoteVolumeUsd: minCandleQuoteVolumeUsd.toFixed(),
        maxSaneSpreadBps: maxSaneSpreadBps.toFixed(),
        ...(prepEnabled
          ? {
              prepHorizonsMs,
              prepBandBps: prepBandBps.toFixed(),
              prepTargetBps: prepTargetBps.toFixed(),
              prepStopBps: prepStopBps.toFixed(),
              prepMinSamples,
            }
          : {}),
      },
      candidateCount: universe.length,
      analyzedPairs: ranked.length,
      loadErrors,
      pairErrors: pairs.flatMap((entry) => (entry.error ? [entry.error] : [])),
      ranking: ranked,
      ...(prepEnabled ? { preparation: preparationRanking } : {}),
    };

    console.log(
      'pair direction episodes episodesPerDay twoSided flips eligible eval eligibleRatio totalMin longestMin medianWindowMin medianNet p90Net maxNet stressSamples',
    );
    for (const pair of ranked.slice(0, 30)) {
      const best = bestHistoricalDirection(pair);
      if (!best) continue;
      console.log(
        [
          `${pair.base}/${pair.quote}`,
          `${best.buyVenue}->${best.sellVenue}`,
          `episodes=${best.eligibleEpisodes}`,
          `episodesPerDay=${best.episodesPerDay.toFixed(2)}`,
          `twoSided=${pair.twoSidedEligible}`,
          `flips=${pair.directionFlips}`,
          `eligible=${best.eligibleSamples}`,
          `eval=${best.alignedSamples}`,
          `eligibleRatio=${(best.alignedSamples > 0 ? best.eligibleSamples / best.alignedSamples : 0).toFixed(3)}`,
          `totalMin=${(best.totalEligibleMs / 60_000).toFixed(1)}`,
          `longestMin=${(best.longestEligibleMs / 60_000).toFixed(1)}`,
          `medianWindowMin=${(best.medianEligibleEpisodeMs / 60_000).toFixed(1)}`,
          `medianNet=${fmt(best.medianNetBps)}`,
          `p90Net=${fmt(best.p90NetBps)}`,
          `maxNet=${fmt(best.maxNetBps)}`,
          `stressSamples=${best.stressEligibleSamples}`,
        ].join(' '),
      );
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(jsonSafe(report), null, 2)}\n`, 'utf8');
    console.log(`wrote ${outputPath}`);
    if (prepEnabled) {
      const calibration = {
        generatedAt: new Date().toISOString(),
        source: relative(process.cwd(), outputPath).replaceAll('\\', '/'),
        referenceNotional: notional.toFixed(),
        parameters: {
          timeframe,
          days,
          prepHorizonsMs,
          prepBandBps: prepBandBps.toFixed(),
          prepTargetBps: prepTargetBps.toFixed(),
          prepStopBps: prepStopBps.toFixed(),
          prepMinSamples,
        },
        entries: calibrationEntries.map((entry) => ({
          pair: entry.pair,
          direction: entry.direction,
          horizon_ms: entry.horizonMs,
          candidate_samples: entry.candidateSamples,
          reverse_probability: entry.reverseProbability,
          median_time_to_reverse_ms: entry.medianTimeToReverseMs,
          median_reverse_net_bps: entry.medianReverseNetBps,
          median_prep_cost_bps: entry.medianPrepCostBps,
          mean_no_reverse_loss_bps: entry.meanNoReverseLossBps,
          expected_value_bps: entry.expectedValueBps,
          expected_value_usd: entry.expectedValueUsd,
        })),
      };
      mkdirSync(dirname(prepOutputPath), { recursive: true });
      writeFileSync(prepOutputPath, `${JSON.stringify(jsonSafe(calibration), null, 2)}\n`, 'utf8');
      console.log(`wrote ${prepOutputPath}`);
      for (const entry of calibrationEntries) {
        console.log(
          [
            entry.pair,
            entry.direction,
            `horizonMin=${(entry.horizonMs / 60_000).toFixed(0)}`,
            `samples=${entry.candidateSamples}`,
            `pReverse=${entry.reverseProbability.toFixed(4)}`,
            `medianTimeMin=${entry.medianTimeToReverseMs === null ? '-' : (entry.medianTimeToReverseMs / 60_000).toFixed(1)}`,
            `medianReverseBps=${fmt(entry.medianReverseNetBps)}`,
            `prepCostBps=${fmt(entry.medianPrepCostBps)}`,
            `noReverseLossBps=${fmt(entry.meanNoReverseLossBps)}`,
            `evBps=${fmt(entry.expectedValueBps)}`,
            `evUsd=${fmt(entry.expectedValueUsd, 4)}`,
          ].join(' '),
        );
      }
    }
  } finally {
    for (const adapter of adapters.values()) {
      try {
        await adapter.close?.();
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
