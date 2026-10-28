import { Decimal, type OhlcvCandle } from '@arb/core';

export interface HistoricalBacktestOptions {
  base: string;
  quote: string;
  candlesByVenue: Readonly<Record<string, readonly OhlcvCandle[]>>;
  feeBpsByVenue: Readonly<Record<string, Decimal>>;
  timeframeMs: number;
  notional: Decimal;
  minProfitUsd: Decimal;
  minNetProfitBps: Decimal;
  safetyBufferBps: Decimal;
  extraSlippageBps: Decimal;
  minCandleQuoteVolumeUsd: Decimal;
  maxSaneSpreadBps: Decimal;
  episodeGapMs?: number;
}

export interface HistoricalDirectionResult {
  buyVenue: string;
  sellVenue: string;
  alignedSamples: number;
  positiveSignalSamples: number;
  positiveSignalShare: Decimal;
  outlierSamples: number;
  volumeRejectedSamples: number;
  eligibleSamples: number;
  eligibleEpisodes: number;
  observedMs: number;
  episodesPerDay: Decimal;
  totalEligibleMs: number;
  longestEligibleMs: number;
  medianEligibleEpisodeMs: number;
  p90EligibleEpisodeMs: number;
  stressEligibleSamples: number;
  signalToExecutionReversals: number;
  medianNetBps?: Decimal;
  p90NetBps?: Decimal;
  maxNetBps?: Decimal;
  maxNetProfitUsd?: Decimal;
  firstEligibleAt?: number;
  lastEligibleAt?: number;
  episodes: HistoricalEpisode[];
}

export interface HistoricalEpisode {
  start: number;
  end: number;
  samples: number;
  medianNetBps: Decimal;
  maxNetBps: Decimal;
  stressSamples: number;
}

export interface HistoricalPairResult {
  base: string;
  quote: string;
  venues: string[];
  candleCounts: Record<string, number>;
  startedAt?: number;
  endedAt?: number;
  directions: HistoricalDirectionResult[];
  twoSidedEligible: boolean;
  directionFlips: number;
  overlappingDirectionEpisodes: number;
}

function candleMap(candles: readonly OhlcvCandle[]): Map<number, OhlcvCandle> {
  const result = new Map<number, OhlcvCandle>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.timestamp) || candle.timestamp <= 0) continue;
    if (!candle.open.gt(0) || !candle.close.gt(0)) continue;
    result.set(candle.timestamp, candle);
  }
  return result;
}

function quoteTurnover(candle: OhlcvCandle): Decimal {
  return candle.quoteVolume ?? candle.volume.mul(candle.close);
}

function percentile(values: readonly Decimal[], percentileValue: number): Decimal | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function maxDecimal(values: readonly Decimal[]): Decimal | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((best, value) => (value.gt(best) ? value : best));
}

function numberPercentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

function analyzeDirection(
  options: HistoricalBacktestOptions,
  buyVenue: string,
  sellVenue: string,
): HistoricalDirectionResult {
  const buy = candleMap(options.candlesByVenue[buyVenue] ?? []);
  const sell = candleMap(options.candlesByVenue[sellVenue] ?? []);
  const buyFee = options.feeBpsByVenue[buyVenue] ?? new Decimal(0);
  const sellFee = options.feeBpsByVenue[sellVenue] ?? new Decimal(0);
  const roundTripCostBps = buyFee
    .plus(sellFee)
    .plus(options.extraSlippageBps)
    .plus(options.safetyBufferBps);
  const timestamps = [...buy.keys()]
    .filter((timestamp) => sell.has(timestamp))
    .sort((a, b) => a - b);
  const eligible: Array<{ timestamp: number; netBps: Decimal; stress: boolean }> = [];
  let evaluatedSamples = 0;
  let positiveSignalSamples = 0;
  let outlierSamples = 0;
  let volumeRejectedSamples = 0;
  let signalToExecutionReversals = 0;

  for (const timestamp of timestamps) {
    const currentBuy = buy.get(timestamp)!;
    const currentSell = sell.get(timestamp)!;
    const nextBuy = buy.get(timestamp + options.timeframeMs);
    const nextSell = sell.get(timestamp + options.timeframeMs);
    if (!nextBuy || !nextSell) continue;
    evaluatedSamples += 1;

    const signalGrossBps = currentSell.close.div(currentBuy.close).minus(1).mul(10_000);
    if (
      signalGrossBps.gt(options.maxSaneSpreadBps) ||
      signalGrossBps.lt(options.maxSaneSpreadBps.neg())
    ) {
      outlierSamples += 1;
      continue;
    }
    if (signalGrossBps.gt(0)) positiveSignalSamples += 1;

    const buyVolume = Decimal.min(quoteTurnover(currentBuy), quoteTurnover(nextBuy));
    const sellVolume = Decimal.min(quoteTurnover(currentSell), quoteTurnover(nextSell));
    if (
      buyVolume.lt(options.minCandleQuoteVolumeUsd) ||
      sellVolume.lt(options.minCandleQuoteVolumeUsd)
    ) {
      volumeRejectedSamples += 1;
      continue;
    }

    const executionGrossBps = nextSell.open.div(nextBuy.open).minus(1).mul(10_000);
    if (executionGrossBps.lte(0) && signalGrossBps.gt(0)) signalToExecutionReversals += 1;
    const netBps = executionGrossBps.minus(roundTripCostBps);
    const netProfitUsd = options.notional.mul(netBps).div(10_000);
    if (netBps.lt(options.minNetProfitBps) || netProfitUsd.lt(options.minProfitUsd)) continue;

    const stressGrossBps = nextSell.low.div(nextBuy.high).minus(1).mul(10_000);
    const stressNetBps = stressGrossBps.minus(roundTripCostBps);
    eligible.push({
      timestamp,
      netBps,
      stress: stressNetBps.gte(options.minNetProfitBps),
    });
  }

  const netValues = eligible.map((entry) => entry.netBps);
  const episodeGapMs = options.episodeGapMs ?? options.timeframeMs * 1.5;
  const episodes: HistoricalEpisode[] = [];
  const episodeDurationsMs: number[] = [];
  let longestEligibleMs = 0;
  let currentEpisode: typeof eligible = [];

  const finishEpisode = (): void => {
    if (currentEpisode.length === 0) return;
    const values = currentEpisode.map((entry) => entry.netBps);
    const start = currentEpisode[0]!.timestamp;
    const end = currentEpisode.at(-1)!.timestamp;
    const duration = end - start + options.timeframeMs;
    episodeDurationsMs.push(duration);
    longestEligibleMs = Math.max(longestEligibleMs, duration);
    episodes.push({
      start,
      end,
      samples: currentEpisode.length,
      medianNetBps: percentile(values, 50)!,
      maxNetBps: maxDecimal(values)!,
      stressSamples: currentEpisode.filter((entry) => entry.stress).length,
    });
    currentEpisode = [];
  };

  for (const entry of eligible) {
    if (
      currentEpisode.length > 0 &&
      entry.timestamp - currentEpisode.at(-1)!.timestamp > episodeGapMs
    ) {
      finishEpisode();
    }
    currentEpisode.push(entry);
  }
  finishEpisode();

  const maxNet = maxDecimal(netValues);
  const observedMs = evaluatedSamples * options.timeframeMs;
  return {
    buyVenue,
    sellVenue,
    alignedSamples: evaluatedSamples,
    positiveSignalSamples,
    positiveSignalShare:
      evaluatedSamples > 0
        ? new Decimal(positiveSignalSamples).div(evaluatedSamples)
        : new Decimal(0),
    outlierSamples,
    volumeRejectedSamples,
    eligibleSamples: eligible.length,
    eligibleEpisodes: episodes.length,
    observedMs,
    episodesPerDay:
      observedMs > 0
        ? new Decimal(episodes.length).mul(86_400_000).div(observedMs)
        : new Decimal(0),
    totalEligibleMs: eligible.length * options.timeframeMs,
    longestEligibleMs,
    medianEligibleEpisodeMs: numberPercentile(episodeDurationsMs, 50),
    p90EligibleEpisodeMs: numberPercentile(episodeDurationsMs, 90),
    stressEligibleSamples: eligible.filter((entry) => entry.stress).length,
    signalToExecutionReversals,
    ...(percentile(netValues, 50) ? { medianNetBps: percentile(netValues, 50)! } : {}),
    ...(percentile(netValues, 90) ? { p90NetBps: percentile(netValues, 90)! } : {}),
    ...(maxNet ? { maxNetBps: maxNet } : {}),
    ...(maxNet ? { maxNetProfitUsd: options.notional.mul(maxNet).div(10_000) } : {}),
    ...(eligible[0] ? { firstEligibleAt: eligible[0].timestamp } : {}),
    ...(eligible.at(-1) ? { lastEligibleAt: eligible.at(-1)!.timestamp } : {}),
    episodes,
  };
}

export function analyzeHistoricalPair(options: HistoricalBacktestOptions): HistoricalPairResult {
  const venues = Object.keys(options.candlesByVenue).sort();
  const directions: HistoricalDirectionResult[] = [];
  for (const buyVenue of venues) {
    for (const sellVenue of venues) {
      if (buyVenue === sellVenue) continue;
      directions.push(analyzeDirection(options, buyVenue, sellVenue));
    }
  }
  const allTimestamps = venues.flatMap((venue) =>
    (options.candlesByVenue[venue] ?? []).map((candle) => candle.timestamp),
  );
  const episodeEvents = directions
    .flatMap((direction) =>
      direction.episodes.map((episode) => ({
        ...episode,
        direction: `${direction.buyVenue}->${direction.sellVenue}`,
      })),
    )
    .sort((left, right) => left.start - right.start);
  let directionFlips = 0;
  let overlappingDirectionEpisodes = 0;
  for (let index = 1; index < episodeEvents.length; index += 1) {
    const previous = episodeEvents[index - 1]!;
    const current = episodeEvents[index]!;
    if (current.direction === previous.direction) continue;
    if (current.start >= previous.end) directionFlips += 1;
    else overlappingDirectionEpisodes += 1;
  }
  return {
    base: options.base,
    quote: options.quote,
    venues,
    candleCounts: Object.fromEntries(
      venues.map((venue) => [venue, options.candlesByVenue[venue]?.length ?? 0]),
    ),
    ...(allTimestamps.length > 0 ? { startedAt: Math.min(...allTimestamps) } : {}),
    ...(allTimestamps.length > 0 ? { endedAt: Math.max(...allTimestamps) } : {}),
    directions,
    twoSidedEligible: directions.filter((direction) => direction.eligibleEpisodes > 0).length > 1,
    directionFlips,
    overlappingDirectionEpisodes,
  };
}

function decimalOrZero(value: Decimal | undefined): Decimal {
  return value ?? new Decimal(0);
}

export function compareDirections(
  left: HistoricalDirectionResult,
  right: HistoricalDirectionResult,
): number {
  if (left.eligibleEpisodes !== right.eligibleEpisodes) {
    return right.eligibleEpisodes - left.eligibleEpisodes;
  }
  if (left.stressEligibleSamples !== right.stressEligibleSamples) {
    return right.stressEligibleSamples - left.stressEligibleSamples;
  }
  if (left.totalEligibleMs !== right.totalEligibleMs) {
    return right.totalEligibleMs - left.totalEligibleMs;
  }
  const median = decimalOrZero(right.medianNetBps).comparedTo(decimalOrZero(left.medianNetBps));
  if (median !== 0) return median;
  const max = decimalOrZero(right.maxNetBps).comparedTo(decimalOrZero(left.maxNetBps));
  if (max !== 0) return max;
  return decimalOrZero(right.positiveSignalShare).comparedTo(
    decimalOrZero(left.positiveSignalShare),
  );
}

export function bestHistoricalDirection(
  pair: HistoricalPairResult,
): HistoricalDirectionResult | undefined {
  return [...pair.directions].sort(compareDirections)[0];
}

export function rankHistoricalPairs(
  pairs: readonly HistoricalPairResult[],
): HistoricalPairResult[] {
  return [...pairs].sort((left, right) => {
    const leftBest = bestHistoricalDirection(left);
    const rightBest = bestHistoricalDirection(right);
    if (!leftBest && !rightBest) return left.base.localeCompare(right.base);
    if (!leftBest) return 1;
    if (!rightBest) return -1;
    const compared = compareDirections(leftBest, rightBest);
    if (compared !== 0) return compared;
    return left.base.localeCompare(right.base);
  });
}
