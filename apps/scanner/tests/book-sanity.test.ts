import { describe, expect, it } from 'vitest';
import { Decimal, type OrderBookSnapshot } from '@arb/core';
import { BookSanityMonitor, bookDeviationBps } from '../src/book-sanity.js';

function book(bid: string, ask: string): OrderBookSnapshot {
  return {
    venueId: 'gateio',
    exchangeSymbol: 'BTC/USDT',
    fetchedAt: 0,
    bids: [{ price: new Decimal(bid), amount: new Decimal(1) }],
    asks: [{ price: new Decimal(ask), amount: new Decimal(1) }],
    source: 'websocket',
  };
}

describe('bookDeviationBps', () => {
  it('returns the larger of bid and ask deviation', () => {
    const deviation = bookDeviationBps(book('100', '101'), book('99', '100.5'));
    expect(deviation?.bidBps.toFixed(2)).toBe('101.01');
    expect(deviation?.askBps.toFixed(2)).toBe('49.75');
    expect(deviation?.maxBps.toFixed(2)).toBe('101.01');
  });

  it('returns undefined for an empty side', () => {
    const empty: OrderBookSnapshot = {
      venueId: 'gateio',
      exchangeSymbol: 'BTC/USDT',
      fetchedAt: 0,
      bids: [],
      asks: [],
      source: 'websocket',
    };
    expect(bookDeviationBps(empty, book('100', '101'))).toBeUndefined();
  });
});

describe('BookSanityMonitor', () => {
  it('blocks after repeated failures and only unblocks after cooldown + successes', () => {
    let now = 1_000;
    const monitor = new BookSanityMonitor({
      enabled: true,
      intervalMs: 0,
      requiredFailures: 2,
      requiredSuccesses: 2,
      cooldownMs: 1_000,
      clock: () => now,
    });
    monitor.failure('gateio|BTC/USDT', 'deviation', now);
    expect(monitor.isBlocked('gateio|BTC/USDT')).toBe(false);
    monitor.failure('gateio|BTC/USDT', 'deviation', now);
    expect(monitor.isBlocked('gateio|BTC/USDT')).toBe(true);

    monitor.success('gateio|BTC/USDT', now);
    monitor.success('gateio|BTC/USDT', now);
    expect(monitor.isBlocked('gateio|BTC/USDT')).toBe(true);

    now += 1_000;
    monitor.success('gateio|BTC/USDT', now);
    monitor.success('gateio|BTC/USDT', now);
    expect(monitor.isBlocked('gateio|BTC/USDT')).toBe(false);
  });

  it('gates checks by interval', () => {
    let now = 0;
    const monitor = new BookSanityMonitor({ enabled: true, intervalMs: 100, clock: () => now });
    expect(monitor.due('k')).toBe(true);
    monitor.success('k', now);
    expect(monitor.due('k')).toBe(false);
    now = 100;
    expect(monitor.due('k')).toBe(true);
  });
});
