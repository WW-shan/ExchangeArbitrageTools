import { describe, expect, it, vi } from 'vitest';
import { Decimal, type OrderBookSnapshot } from '@arb/core';
import { BookStore } from '../src/book-store.js';
import type { CexAdapter } from '../src/types.js';

function capabilities() {
  return {
    publicMarketData: true,
    orderBook: true,
    privateBalances: false,
    createOrder: false,
    fetchOrder: false,
    cancelOrder: false,
    websocket: true,
    ioc: true,
    fok: false,
  };
}

function snapshot(venueId: string, ask: string, at: number): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: at,
    receivedAt: at,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal('2.49'), amount: new Decimal('100') }],
    source: 'websocket',
  };
}

function waitAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}

describe('BookStore', () => {
  it('stores the latest websocket book and reports freshness', async () => {
    let emit: ((book: OrderBookSnapshot) => void) | undefined;
    const received: OrderBookSnapshot[] = [];
    const adapter: CexAdapter = {
      venueId: 'gateio',
      tier: 'S',
      capabilities: capabilities(),
      loadMarkets: async () => [],
      fetchOrderBook: async () => {
        throw new Error('rest unused');
      },
      watchOrderBook: async (_symbol, _depth, onBook, signal) => {
        emit = onBook;
        await waitAbort(signal);
      },
    };
    const store = new BookStore({
      depth: 5,
      maxBookAgeMs: 1000,
      reconnectMinMs: 10,
      clock: () => 1000,
      onBook: (book) => received.push(book),
    });
    store.setSubscriptions([{ venueId: 'gateio', adapter, symbol: 'CAKE/USDT' }]);
    await vi.waitFor(() => expect(emit).toBeDefined());
    emit!(snapshot('gateio', '2.500', 1000));
    expect(received).toHaveLength(1);
    expect(store.get('gateio', 'CAKE/USDT')?.asks[0]?.price.toFixed()).toBe('2.5');
    expect(store.version('gateio', 'CAKE/USDT')).toBe(1);
    expect(store.isFresh('gateio', 'CAKE/USDT', 1500)).toBe(true);
    expect(store.isFresh('gateio', 'CAKE/USDT', 2500)).toBe(false);
    store.close();
  });

  it('reconnects after a watch failure', async () => {
    let attempts = 0;
    let emit: ((book: OrderBookSnapshot) => void) | undefined;
    const errors: string[] = [];
    const adapter: CexAdapter = {
      venueId: 'mexc',
      tier: 'S',
      capabilities: capabilities(),
      loadMarkets: async () => [],
      fetchOrderBook: async () => {
        throw new Error('rest unused');
      },
      watchOrderBook: async (_symbol, _depth, onBook, signal) => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket closed');
        emit = onBook;
        await waitAbort(signal);
      },
    };
    const store = new BookStore({
      reconnectMinMs: 5,
      reconnectMaxMs: 20,
      clock: () => 1000,
      onError: (_venue, _symbol, error) => errors.push(String(error)),
    });
    store.setSubscriptions([{ venueId: 'mexc', adapter, symbol: 'CAKE/USDT' }]);
    await vi.waitFor(() => expect(emit).toBeDefined(), { timeout: 2000 });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it('keeps retrying and recovers after the reconnect burst limit', async () => {
    let attempts = 0;
    let emit: ((book: OrderBookSnapshot) => void) | undefined;
    const adapter: CexAdapter = {
      venueId: 'mexc',
      tier: 'S',
      capabilities: capabilities(),
      loadMarkets: async () => [],
      fetchOrderBook: async () => {
        throw new Error('rest unused');
      },
      watchOrderBook: async (_symbol, _depth, onBook, signal) => {
        attempts += 1;
        if (attempts < 4) throw new Error('socket unavailable');
        emit = onBook;
        await waitAbort(signal);
      },
    };
    const store = new BookStore({
      reconnectMinMs: 5,
      reconnectMaxMs: 10,
      maxReconnectAttempts: 2,
    });
    store.setSubscriptions([{ venueId: 'mexc', adapter, symbol: 'CAKE/USDT' }]);
    await vi.waitFor(() => expect(emit).toBeDefined(), { timeout: 2000 });
    expect(attempts).toBeGreaterThanOrEqual(4);
    store.close();
  });
});
