import { describe, expect, it } from 'vitest';
import { Decimal, type OrderBookSnapshot } from '@arb/core';
import { bookDepthNotional, depthBoundNotional } from '../src/depth.js';

function book(bids: Array<[string, string]>, asks: Array<[string, string]>): OrderBookSnapshot {
  return {
    venueId: 'gateio',
    exchangeSymbol: 'X/USDT',
    fetchedAt: 0,
    bids: bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    asks: asks.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: 'websocket',
  };
}

describe('depth helpers', () => {
  it('sums quote notional over the requested levels', () => {
    const snapshot = book(
      [['99', '2']],
      [
        ['100', '1'],
        ['101', '2'],
      ],
    );
    expect(bookDepthNotional(snapshot, 'asks', 5).toFixed()).toBe('302');
    expect(bookDepthNotional(snapshot, 'asks', 1).toFixed()).toBe('100');
    expect(bookDepthNotional(snapshot, 'bids', 5).toFixed()).toBe('198');
  });

  it('caps notional to the weaker leg divided by the liquidity multiple', () => {
    const buy = book([['99', '100']], [['100', '10']]);
    const sell = book([['99', '1']], [['100', '100']]);
    expect(depthBoundNotional(buy, sell, 5, new Decimal(1)).toFixed()).toBe('99');
    expect(depthBoundNotional(buy, sell, 5, new Decimal(1.5)).toFixed()).toBe('66');
  });
});
