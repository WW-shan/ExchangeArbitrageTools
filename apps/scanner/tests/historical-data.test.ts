import { Decimal, type OhlcvCandle } from '@arb/core';
import { describe, expect, it } from 'vitest';
import { collectHistoricalCandles, historicalMaxLookbackDays } from '../src/historical-data.js';

const start = 1_700_000_000_000;
const timeframeMs = 60_000;

function candle(timestamp: number): OhlcvCandle {
  return {
    timestamp,
    open: new Decimal(1),
    high: new Decimal(1),
    low: new Decimal(1),
    close: new Decimal(1),
    volume: new Decimal(100),
  };
}

describe('historical candle pagination', () => {
  it('caps the lookback at the exchange candle-window limit', () => {
    expect(historicalMaxLookbackDays('1m')).toBe(6);
    expect(historicalMaxLookbackDays('5m')).toBe(34);
    expect(historicalMaxLookbackDays('15m')).toBe(104);
  });

  it('continues after a short page instead of treating it as end-of-data', async () => {
    const pages = [
      Array.from({ length: 999 }, (_, index) => candle(start + index * timeframeMs)),
      Array.from({ length: 999 }, (_, index) => candle(start + (999 + index) * timeframeMs)),
      Array.from({ length: 2 }, (_, index) => candle(start + (1998 + index) * timeframeMs)),
    ];
    const calls: Array<{ since: number; limit: number }> = [];

    const rows = await collectHistoricalCandles(
      {
        fetchPage: async (since, limit) => {
          calls.push({ since, limit });
          return pages.shift() ?? [];
        },
      },
      timeframeMs,
      start,
      start + 2000 * timeframeMs,
      1000,
    );

    expect(rows).toHaveLength(2000);
    expect(rows[0]?.timestamp).toBe(start);
    expect(rows.at(-1)?.timestamp).toBe(start + 1999 * timeframeMs);
    expect(calls).toHaveLength(3);
  });

  it('stops when a venue returns only candles before the requested cursor', async () => {
    let calls = 0;
    const rows = await collectHistoricalCandles(
      {
        fetchPage: async () => {
          calls += 1;
          return [candle(start - timeframeMs)];
        },
      },
      timeframeMs,
      start,
      start + 100 * timeframeMs,
      1000,
    );

    expect(rows).toHaveLength(0);
    expect(calls).toBe(1);
  });
});
