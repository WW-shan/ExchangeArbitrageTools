import { Decimal, type OhlcvCandle } from '@arb/core';
import { describe, expect, it } from 'vitest';
import {
  analyzePreparationPair,
  bestPreparationHorizon,
  type PreparationBacktestOptions,
} from '../src/preparation-backtest.js';

const start = 1_700_000_000_000;
const timeframeMs = 60_000;

function candle(
  timestamp: number,
  open: number,
  close: number,
  low = Math.min(open, close) - 0.0001,
  high = Math.max(open, close) + 0.0001,
): OhlcvCandle {
  return {
    timestamp,
    open: new Decimal(open),
    high: new Decimal(high),
    low: new Decimal(low),
    close: new Decimal(close),
    volume: new Decimal(1000),
    quoteVolume: new Decimal(1000),
  };
}

function options(
  gate: readonly OhlcvCandle[],
  hotcoin: readonly OhlcvCandle[],
): PreparationBacktestOptions {
  return {
    base: 'TEST',
    quote: 'USDT',
    candlesByVenue: { gateio: gate, hotcoin },
    feeBpsByVenue: { gateio: new Decimal(1), hotcoin: new Decimal(1) },
    timeframeMs,
    notional: new Decimal(10),
    safetyBufferBps: new Decimal(0),
    extraSlippageBps: new Decimal(0),
    minCandleQuoteVolumeUsd: new Decimal(20),
    maxSaneSpreadBps: new Decimal(1000),
    prepBandBps: new Decimal(5),
    reverseTargetBps: new Decimal(5),
    stopBps: new Decimal(50),
    horizonsMs: [5 * timeframeMs, 10 * timeframeMs],
  };
}

function flatCandles(count: number): OhlcvCandle[] {
  return Array.from({ length: count }, (_, index) => candle(start + index * timeframeMs, 1, 1));
}

describe('reversion preparation backtest', () => {
  it('counts a reverse hit after a near-breakeven preparation', () => {
    const gate = flatCandles(12);
    const hotcoin = flatCandles(12);
    gate[1] = candle(start + timeframeMs, 1, 1);
    hotcoin[1] = candle(start + timeframeMs, 0.9998, 1);
    gate[2] = candle(start + 2 * timeframeMs, 1.001, 1.001, 0.999);
    hotcoin[2] = candle(start + 2 * timeframeMs, 1, 1);
    for (let index = 5; index < hotcoin.length; index += 1) {
      hotcoin[index] = candle(start + index * timeframeMs, 1.01, 1.01);
    }

    const result = analyzePreparationPair(options(gate, hotcoin));
    const direction = result.directions.find(
      (entry) => entry.buyVenue === 'gateio' && entry.sellVenue === 'hotcoin',
    )!;
    const horizon = direction.horizons.find((entry) => entry.horizonMs === 5 * timeframeMs)!;
    expect(horizon.candidateSamples).toBe(1);
    expect(horizon.reverseHits).toBe(1);
    expect(horizon.reverseHitRate.toFixed()).toBe('1');
    expect(horizon.expectedValueBps.gt(0)).toBe(true);
  });

  it('does not assume reversion and records an adverse stop', () => {
    const gate = flatCandles(12);
    const hotcoin = flatCandles(12);
    hotcoin[1] = candle(start + timeframeMs, 0.9998, 1);
    gate[2] = candle(start + 2 * timeframeMs, 0.99, 0.99, 0.99, 1);
    for (let index = 5; index < hotcoin.length; index += 1) {
      hotcoin[index] = candle(start + index * timeframeMs, 1.01, 1.01);
    }

    const result = analyzePreparationPair(options(gate, hotcoin));
    const direction = result.directions.find(
      (entry) => entry.buyVenue === 'gateio' && entry.sellVenue === 'hotcoin',
    )!;
    const horizon = direction.horizons.find((entry) => entry.horizonMs === 5 * timeframeMs)!;
    expect(horizon.candidateSamples).toBe(1);
    expect(horizon.stopped).toBe(1);
    expect(horizon.reverseHits).toBe(0);
    expect(horizon.expectedValueBps.lt(0)).toBe(true);
  });

  it('selects a horizon only when it has enough samples', () => {
    const gate = flatCandles(12);
    const hotcoin = flatCandles(12);
    hotcoin[1] = candle(start + timeframeMs, 0.9998, 1);
    gate[2] = candle(start + 2 * timeframeMs, 1.001, 1.001, 0.999);
    for (let index = 5; index < hotcoin.length; index += 1) {
      hotcoin[index] = candle(start + index * timeframeMs, 1.01, 1.01);
    }
    const result = analyzePreparationPair(options(gate, hotcoin));
    const direction = result.directions.find(
      (entry) => entry.buyVenue === 'gateio' && entry.sellVenue === 'hotcoin',
    )!;
    expect(bestPreparationHorizon(direction, 1)).toBeDefined();
    expect(bestPreparationHorizon(direction, 2)).toBeUndefined();
  });
});
