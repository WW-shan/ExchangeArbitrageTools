import { Decimal, type OhlcvCandle } from '@arb/core';
import { describe, expect, it } from 'vitest';
import {
  analyzeHistoricalPair,
  bestHistoricalDirection,
  rankHistoricalPairs,
  type HistoricalBacktestOptions,
  type HistoricalDirectionResult,
  type HistoricalPairResult,
} from '../src/historical-backtest.js';

const start = 1_700_000_000_000;
const timeframeMs = 15 * 60_000;

function candle(timestamp: number, open: number, close: number, volume = 100): OhlcvCandle {
  return {
    timestamp,
    open: new Decimal(open),
    high: new Decimal(Math.max(open, close) + 0.0001),
    low: new Decimal(Math.min(open, close) - 0.0001),
    close: new Decimal(close),
    volume: new Decimal(volume),
    quoteVolume: new Decimal(volume).mul(close),
  };
}

function options(
  sellCandles: readonly OhlcvCandle[],
  buyCandles: readonly OhlcvCandle[],
  overrides: Partial<HistoricalBacktestOptions> = {},
): HistoricalBacktestOptions {
  return {
    base: 'TEST',
    quote: 'USDT',
    candlesByVenue: { gateio: buyCandles, hotcoin: sellCandles },
    feeBpsByVenue: { gateio: new Decimal('2.97'), hotcoin: new Decimal(4) },
    timeframeMs,
    notional: new Decimal(20),
    minProfitUsd: new Decimal('0.01'),
    minNetProfitBps: new Decimal(5),
    safetyBufferBps: new Decimal(2),
    extraSlippageBps: new Decimal(10),
    minCandleQuoteVolumeUsd: new Decimal(20),
    maxSaneSpreadBps: new Decimal(3000),
    ...overrides,
  };
}

function direction(overrides: Partial<HistoricalDirectionResult>): HistoricalDirectionResult {
  return {
    buyVenue: 'gateio',
    sellVenue: 'hotcoin',
    alignedSamples: 10,
    positiveSignalSamples: 2,
    positiveSignalShare: new Decimal('0.2'),
    outlierSamples: 0,
    volumeRejectedSamples: 0,
    eligibleSamples: 2,
    eligibleEpisodes: 1,
    observedMs: 900_000,
    episodesPerDay: new Decimal(1),
    totalEligibleMs: 30_000,
    longestEligibleMs: 15_000,
    medianEligibleEpisodeMs: 15_000,
    p90EligibleEpisodeMs: 15_000,
    stressEligibleSamples: 1,
    signalToExecutionReversals: 0,
    medianNetBps: new Decimal('20'),
    episodes: [],
    ...overrides,
  };
}

describe('historical cross-venue backtest', () => {
  it('uses the next candle open and groups eligible windows into episodes', () => {
    const buyOpens = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const buyCloses = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const sellOpens = [1.006, 1.006, 1.006, 1.001, 1, 1, 1.006, 1, 1, 1];
    const sellCloses = [1.006, 1.006, 1.001, 1, 1, 1.006, 1.006, 1, 1, 1];
    const buyCandles = buyOpens.map((open, index) =>
      candle(start + index * timeframeMs, open, buyCloses[index]!),
    );
    const sellCandles = sellOpens.map((open, index) =>
      candle(start + index * timeframeMs, open, sellCloses[index]!),
    );

    const result = analyzeHistoricalPair(options(sellCandles, buyCandles));
    const gateToHotcoin = result.directions.find(
      (entry) => entry.buyVenue === 'gateio' && entry.sellVenue === 'hotcoin',
    )!;
    expect(gateToHotcoin.alignedSamples).toBe(9);
    expect(gateToHotcoin.eligibleSamples).toBe(3);
    expect(gateToHotcoin.eligibleEpisodes).toBe(2);
    expect(gateToHotcoin.longestEligibleMs).toBe(30 * 60_000);
    expect(gateToHotcoin.medianEligibleEpisodeMs).toBe(15 * 60_000);
    expect(gateToHotcoin.p90EligibleEpisodeMs).toBe(30 * 60_000);
    expect(gateToHotcoin.totalEligibleMs).toBe(45 * 60_000);
    expect(gateToHotcoin.medianNetBps?.gt(40)).toBe(true);
  });

  it('rejects illiquid candles even when the price difference is large', () => {
    const buyCandles = Array.from({ length: 6 }, (_, index) =>
      candle(start + index * timeframeMs, 1, 1, 100),
    );
    const sellCandles = Array.from({ length: 6 }, (_, index) =>
      candle(start + index * timeframeMs, 1.01, 1.01, 1),
    );
    const result = analyzeHistoricalPair(options(sellCandles, buyCandles));
    const direction = result.directions.find((entry) => entry.buyVenue === 'gateio')!;
    expect(direction.eligibleSamples).toBe(0);
    expect(direction.volumeRejectedSamples).toBeGreaterThan(0);
  });

  it('rejects extreme cross-venue price outliers', () => {
    const buyCandles = Array.from({ length: 6 }, (_, index) =>
      candle(start + index * timeframeMs, 1, 1),
    );
    const sellCandles = Array.from({ length: 6 }, (_, index) =>
      candle(start + index * timeframeMs, 1.5, 1.5),
    );
    const result = analyzeHistoricalPair(options(sellCandles, buyCandles));
    const direction = result.directions.find((entry) => entry.buyVenue === 'gateio')!;
    expect(direction.eligibleSamples).toBe(0);
    expect(direction.outlierSamples).toBe(5);
  });

  it('ranks the pair with more recurring eligible episodes first', () => {
    const more: HistoricalPairResult = {
      base: 'AAA',
      quote: 'USDT',
      venues: ['gateio', 'hotcoin'],
      candleCounts: {},
      directions: [direction({ eligibleEpisodes: 4 })],
      twoSidedEligible: false,
      directionFlips: 0,
      overlappingDirectionEpisodes: 0,
    };
    const fewer: HistoricalPairResult = {
      base: 'BBB',
      quote: 'USDT',
      venues: ['gateio', 'hotcoin'],
      candleCounts: {},
      directions: [direction({ eligibleEpisodes: 1 })],
      twoSidedEligible: false,
      directionFlips: 0,
      overlappingDirectionEpisodes: 0,
    };
    expect(rankHistoricalPairs([fewer, more])[0]!.base).toBe('AAA');
    expect(bestHistoricalDirection(more)?.eligibleEpisodes).toBe(4);
  });

  it('counts non-overlapping alternation between both directions', () => {
    const aOpens = [1, 1, 1, 1, 1, 1.01, 1.01, 1.01, 1, 1];
    const aCloses = [1, 1, 1, 1, 1.01, 1.01, 1.01, 1, 1, 1];
    const bOpens = [1.01, 1.01, 1.01, 1.01, 1, 1, 1, 1, 1.01, 1.01];
    const bCloses = [1.01, 1.01, 1.01, 1, 1, 1, 1.01, 1, 1.01, 1.01];
    const aCandles = aOpens.map((open, index) =>
      candle(start + index * timeframeMs, open, aCloses[index]!),
    );
    const bCandles = bOpens.map((open, index) =>
      candle(start + index * timeframeMs, open, bCloses[index]!),
    );
    const result = analyzeHistoricalPair(options(bCandles, aCandles));
    expect(result.twoSidedEligible).toBe(true);
    expect(result.directionFlips).toBe(2);
    expect(result.overlappingDirectionEpisodes).toBe(0);
  });
});
