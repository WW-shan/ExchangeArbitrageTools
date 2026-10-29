import { Decimal, type OhlcvCandle } from '@arb/core';

export interface PreparationBacktestOptions {
  base: string;
  quote: string;
  candlesByVenue: Readonly<Record<string, readonly OhlcvCandle[]>>;
  feeBpsByVenue: Readonly<Record<string, Decimal>>;
  timeframeMs: number;
  notional: Decimal;
  safetyBufferBps: Decimal;
  extraSlippageBps: Decimal;
  minCandleQuoteVolumeUsd: Decimal;
  maxSaneSpreadBps: Decimal;
  /** The maximum cost, in bps, at which a reversion trade may be prepared. */
  prepBandBps: Decimal;
  /** The reverse direction must reach this net edge before it is counted. */
  reverseTargetBps: Decimal;
  /** Adverse move in the held base that invalidates the preparation. */
  stopBps: Decimal;
  /** Candidate preparation windows to evaluate. */
  horizonsMs: readonly number[];
}

export interface PreparationHorizonResult {
  horizonMs: number;
  candidateSamples: number;
  reverseHits: number;
  stopped: number;
  noReverse: number;
  reverseHitRate: Decimal;
  medianTimeToReverseMs?: number;
  p90TimeToReverseMs?: number;
  medianReverseNetBps?: Decimal;
  p90ReverseNetBps?: Decimal;
  medianPrepCostBps: Decimal;
  meanNoReverseLossBps: Decimal;
  expectedValueBps: Decimal;
  expectedValueUsd: Decimal;
  firstCandidateAt?: number;
  lastCandidateAt?: number;
}

export interface PreparationDirectionResult {
  buyVenue: string;
  sellVenue: string;
  reverseBuyVenue: string;
  reverseSellVenue: string;
  horizons: PreparationHorizonResult[];
}

export interface PreparationPairResult {
  base: string;
  quote: string;
  venues: string[];
  directions: PreparationDirectionResult[];
}

interface CandidateOutcome {
  timestamp: number;
  prepCostBps: Decimal;
  reverseNetBps?: Decimal;
  reverseAt?: number;
  noReverseLossBps?: Decimal;
  stopped: boolean;
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

function numberPercentile(values: readonly number[], percentileValue: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function mean(values: readonly Decimal[]): Decimal {
  if (values.length === 0) return new Decimal(0);
  return values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
}

function roundTripCostBps(
  options: PreparationBacktestOptions,
  buyVenue: string,
  sellVenue: string,
): Decimal {
  return (options.feeBpsByVenue[buyVenue] ?? new Decimal(0))
    .plus(options.feeBpsByVenue[sellVenue] ?? new Decimal(0))
    .plus(options.extraSlippageBps)
    .plus(options.safetyBufferBps);
}

function validCandlePair(
  buy: OhlcvCandle | undefined,
  sell: OhlcvCandle | undefined,
  options: PreparationBacktestOptions,
): boolean {
  if (!buy || !sell) return false;
  return (
    quoteTurnover(buy).gte(options.minCandleQuoteVolumeUsd) &&
    quoteTurnover(sell).gte(options.minCandleQuoteVolumeUsd)
  );
}

function candidateOutcome(input: {
  timestamp: number;
  prepCostBps: Decimal;
  buy: Map<number, OhlcvCandle>;
  sell: Map<number, OhlcvCandle>;
  prepExecutionPrice: Decimal;
  horizonMs: number;
  timeframeMs: number;
  costBps: Decimal;
  options: PreparationBacktestOptions;
}): CandidateOutcome {
  const {
    timestamp,
    prepCostBps,
    buy,
    sell,
    prepExecutionPrice,
    horizonMs,
    timeframeMs,
    costBps,
    options,
  } = input;
  const horizonEnd = timestamp + horizonMs;
  let stopped = false;
  let reverseNetBps: Decimal | undefined;
  let reverseAt: number | undefined;

  // A preparation leaves the base on the buy venue. Check the adverse stop
  // before accepting a reverse fill in the same candle. That is deliberately
  // conservative because OHLCV cannot tell us which price was touched first.
  for (let signalAt = timestamp + timeframeMs; signalAt <= horizonEnd; signalAt += timeframeMs) {
    const executionAt = signalAt + timeframeMs;
    if (executionAt > horizonEnd) break;
    const futureBuy = buy.get(executionAt);
    const futureSell = sell.get(executionAt);
    if (!futureBuy || !futureSell) continue;

    const adverseBps = futureBuy.low.div(prepExecutionPrice).minus(1).mul(10_000);
    if (adverseBps.lte(options.stopBps.neg())) {
      stopped = true;
      break;
    }
    if (!validCandlePair(futureBuy, futureSell, options)) continue;

    const reverseGrossBps = futureBuy.open.div(futureSell.open).minus(1).mul(10_000);
    const candidateReverseNet = reverseGrossBps.minus(costBps);
    if (candidateReverseNet.gte(options.reverseTargetBps)) {
      reverseNetBps = candidateReverseNet;
      reverseAt = executionAt;
      break;
    }
  }

  if (stopped || reverseNetBps) {
    return {
      timestamp,
      prepCostBps,
      ...(reverseNetBps !== undefined && reverseAt !== undefined
        ? { reverseNetBps, reverseAt }
        : {}),
      stopped,
    };
  }

  const endBuy =
    buy.get(horizonEnd) ??
    [...buy.values()].filter((candle) => candle.timestamp <= horizonEnd).at(-1);
  const endMarkBps = endBuy
    ? endBuy.close.div(prepExecutionPrice).minus(1).mul(10_000)
    : new Decimal(0);
  return {
    timestamp,
    prepCostBps,
    noReverseLossBps: Decimal.max(0, endMarkBps.neg()),
    stopped: false,
  };
}

export function analyzePreparationDirection(
  options: PreparationBacktestOptions,
  buyVenue: string,
  sellVenue: string,
): PreparationDirectionResult {
  const buy = candleMap(options.candlesByVenue[buyVenue] ?? []);
  const sell = candleMap(options.candlesByVenue[sellVenue] ?? []);
  const costBps = roundTripCostBps(options, buyVenue, sellVenue);
  const timestamps = [...buy.keys()]
    .filter((timestamp) => sell.has(timestamp))
    .sort((left, right) => left - right);
  const horizons = options.horizonsMs.map((horizonMs) => {
    if (!Number.isFinite(horizonMs) || horizonMs <= 0) {
      throw new Error('preparation horizon must be a positive integer');
    }
    const outcomes: CandidateOutcome[] = [];
    let nextEligibleAt = Number.NEGATIVE_INFINITY;

    for (const timestamp of timestamps) {
      if (timestamp < nextEligibleAt) continue;
      const signalBuy = buy.get(timestamp);
      const signalSell = sell.get(timestamp);
      const executionBuy = buy.get(timestamp + options.timeframeMs);
      const executionSell = sell.get(timestamp + options.timeframeMs);
      if (
        !signalBuy ||
        !signalSell ||
        !executionBuy ||
        !executionSell ||
        !validCandlePair(signalBuy, signalSell, options) ||
        !validCandlePair(executionBuy, executionSell, options)
      ) {
        continue;
      }

      const signalGrossBps = signalSell.close.div(signalBuy.close).minus(1).mul(10_000);
      if (signalGrossBps.abs().gt(options.maxSaneSpreadBps)) continue;

      const executionGrossBps = executionSell.open.div(executionBuy.open).minus(1).mul(10_000);
      const netBps = executionGrossBps.minus(costBps);
      if (netBps.gt(0) || netBps.lt(options.prepBandBps.neg())) continue;

      outcomes.push(
        candidateOutcome({
          timestamp,
          prepCostBps: netBps.lt(0) ? netBps.abs() : new Decimal(0),
          buy,
          sell,
          prepExecutionPrice: executionBuy.open,
          horizonMs,
          timeframeMs: options.timeframeMs,
          costBps,
          options,
        }),
      );
      nextEligibleAt = timestamp + horizonMs + options.timeframeMs;
    }

    const reverseHits = outcomes.filter((outcome) => outcome.reverseNetBps !== undefined);
    const stopped = outcomes.filter((outcome) => outcome.stopped).length;
    const noReverse = outcomes.length - reverseHits.length - stopped;
    const reverseHitRate =
      outcomes.length > 0 ? new Decimal(reverseHits.length).div(outcomes.length) : new Decimal(0);
    const reverseValues = reverseHits.map((outcome) => outcome.reverseNetBps!);
    const timeValues = reverseHits.map((outcome) => outcome.reverseAt! - outcome.timestamp);
    const noReverseLossValues = outcomes
      .filter((outcome) => !outcome.stopped && outcome.reverseNetBps === undefined)
      .map((outcome) => outcome.noReverseLossBps ?? new Decimal(0));
    const stoppedLossValues = outcomes
      .filter((outcome) => outcome.stopped)
      .map(() => options.stopBps);
    const lossValues = [...noReverseLossValues, ...stoppedLossValues];
    const meanNoReverseLossBps = mean(lossValues);
    const medianPrepCostBps =
      percentile(
        outcomes.map((outcome) => outcome.prepCostBps),
        50,
      ) ?? new Decimal(0);
    const medianReverseNetBps = percentile(reverseValues, 50);
    const expectedValueBps = (medianReverseNetBps ?? new Decimal(0))
      .mul(reverseHitRate)
      .minus(meanNoReverseLossBps.mul(new Decimal(1).minus(reverseHitRate)))
      .minus(medianPrepCostBps);

    return {
      horizonMs,
      candidateSamples: outcomes.length,
      reverseHits: reverseHits.length,
      stopped,
      noReverse,
      reverseHitRate,
      ...(numberPercentile(timeValues, 50) !== undefined
        ? { medianTimeToReverseMs: numberPercentile(timeValues, 50)! }
        : {}),
      ...(numberPercentile(timeValues, 90) !== undefined
        ? { p90TimeToReverseMs: numberPercentile(timeValues, 90)! }
        : {}),
      ...(medianReverseNetBps ? { medianReverseNetBps } : {}),
      ...(percentile(reverseValues, 90)
        ? { p90ReverseNetBps: percentile(reverseValues, 90)! }
        : {}),
      medianPrepCostBps,
      meanNoReverseLossBps,
      expectedValueBps,
      expectedValueUsd: options.notional.mul(expectedValueBps).div(10_000),
      ...(outcomes[0] ? { firstCandidateAt: outcomes[0].timestamp } : {}),
      ...(outcomes.at(-1) ? { lastCandidateAt: outcomes.at(-1)!.timestamp } : {}),
    };
  });

  return {
    buyVenue,
    sellVenue,
    reverseBuyVenue: sellVenue,
    reverseSellVenue: buyVenue,
    horizons,
  };
}

export function analyzePreparationPair(options: PreparationBacktestOptions): PreparationPairResult {
  const venues = Object.keys(options.candlesByVenue).sort();
  const directions: PreparationDirectionResult[] = [];
  for (const buyVenue of venues) {
    for (const sellVenue of venues) {
      if (buyVenue === sellVenue) continue;
      directions.push(analyzePreparationDirection(options, buyVenue, sellVenue));
    }
  }
  return {
    base: options.base,
    quote: options.quote,
    venues,
    directions,
  };
}

export function bestPreparationHorizon(
  direction: PreparationDirectionResult,
  minSamples: number,
): PreparationHorizonResult | undefined {
  return [...direction.horizons]
    .filter((horizon) => horizon.candidateSamples >= minSamples)
    .sort((left, right) => {
      const byValue = right.expectedValueBps.comparedTo(left.expectedValueBps);
      if (byValue !== 0) return byValue;
      const byHitRate = right.reverseHitRate.comparedTo(left.reverseHitRate);
      if (byHitRate !== 0) return byHitRate;
      return left.horizonMs - right.horizonMs;
    })[0];
}
