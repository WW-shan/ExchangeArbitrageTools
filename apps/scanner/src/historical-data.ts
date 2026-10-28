import type { OhlcvCandle } from '@arb/core';

export const HISTORICAL_TIMEFRAME_MS: Readonly<Record<string, number>> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

export interface HistoricalCandlePageSource {
  fetchPage(since: number, limit: number): Promise<readonly OhlcvCandle[]>;
}

export function historicalTimeframeMs(timeframe: string): number {
  const timeframeMs = HISTORICAL_TIMEFRAME_MS[timeframe];
  if (timeframeMs === undefined) throw new Error(`unsupported timeframe: ${timeframe}`);
  return timeframeMs;
}

export function historicalMaxLookbackDays(timeframe: string): number {
  return Math.floor((10_000 * historicalTimeframeMs(timeframe)) / 86_400_000);
}

/**
 * Collect OHLCV pages until the requested window is covered. Some venues return
 * a short first page even when older candles are still available, so a short
 * page is not treated as end-of-data. A page that does not reach the cursor is
 * treated as stale to avoid an unbounded loop when a venue ignores `since`.
 */
export async function collectHistoricalCandles(
  source: HistoricalCandlePageSource,
  timeframeMs: number,
  since: number,
  until: number,
  limit: number,
): Promise<OhlcvCandle[]> {
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) {
    throw new Error('historical timeframe must be positive');
  }
  if (!Number.isFinite(since) || since <= 0) throw new Error('historical since must be positive');
  if (!Number.isFinite(until) || until <= since) return [];
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('historical limit must be positive');
  const result = new Map<number, OhlcvCandle>();
  let cursor = since;

  while (cursor < until) {
    const rows = await source.fetchPage(cursor, limit);
    if (rows.length === 0) break;
    let furthestTimestamp = cursor - timeframeMs;
    for (const candle of rows) {
      if (candle.timestamp >= since && candle.timestamp < until) {
        result.set(candle.timestamp, candle);
      }
      furthestTimestamp = Math.max(furthestTimestamp, candle.timestamp);
    }
    if (furthestTimestamp < cursor) break;
    const nextCursor = Math.max(cursor + timeframeMs, furthestTimestamp + timeframeMs);
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }

  return [...result.values()].sort((left, right) => left.timestamp - right.timestamp);
}
