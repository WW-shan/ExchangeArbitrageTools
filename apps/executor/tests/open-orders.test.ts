import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import type { CexAdapter, OrderState } from '@arb/venues-cex';
import { checkNoOpenOrders, fetchOpenOrdersForSymbols } from '../src/open-orders.js';

const credentials = { apiKey: 'key', secret: 'secret' };

function order(id: string, status: OrderState['status']): OrderState {
  return {
    venueOrderId: id,
    clientOrderId: id,
    symbol: 'CAKE/USDT',
    side: 'buy',
    type: 'limit',
    price: new Decimal('2.5'),
    amount: new Decimal(1),
    filled: new Decimal(0),
    remaining: new Decimal(1),
    status,
    raw: {},
  };
}

function adapter(
  fetchOpenOrders?: (symbol: string) => Promise<OrderState[]>,
  venueId = 'gateio',
): CexAdapter {
  return {
    venueId,
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: true,
      createOrder: true,
      fetchOrder: true,
      cancelOrder: true,
      websocket: false,
      ioc: true,
      fok: false,
    },
    loadMarkets: async () => [],
    fetchOrderBook: async () => {
      throw new Error('not used');
    },
    ...(fetchOpenOrders
      ? {
          fetchOpenOrders: async (request: { symbol?: string }) =>
            fetchOpenOrders(request.symbol ?? ''),
        }
      : {}),
  };
}

describe('open-order reconciliation helpers', () => {
  it('deduplicates open orders and ignores terminal rows', async () => {
    const result = await fetchOpenOrdersForSymbols(
      adapter(async () => [order('1', 'open'), order('1', 'open'), order('2', 'closed')]),
      credentials,
      ['CAKE/USDT', 'CAKE/USDT'],
    );
    expect(result.errors).toEqual([]);
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]?.venueOrderId).toBe('1');
  });

  it('fails closed when an order query throws', async () => {
    const result = await fetchOpenOrdersForSymbols(
      adapter(async () => {
        throw new Error('timeout');
      }),
      credentials,
      ['CAKE/USDT'],
    );
    expect(result.orders).toEqual([]);
    expect(result.errors[0]).toContain('open_orders_fetch_failed');
  });

  it('requires support when the caller needs exchange-wide verification', async () => {
    const result = await checkNoOpenOrders(
      [{ adapter: adapter(), credentials, symbol: 'CAKE/USDT' }],
      { requireSupported: true },
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('open_orders_query_unsupported:gateio');
  });

  it('reports an external open order', async () => {
    const result = await checkNoOpenOrders([
      { adapter: adapter(async () => [order('1', 'open')]), credentials, symbol: 'CAKE/USDT' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.orders).toHaveLength(1);
    expect(result.errors).toContain('open_orders_present');
  });

  it('checks venues concurrently', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = (venueId: string) =>
      adapter(async () => {
        started += 1;
        if (started === 2) release();
        await gate;
        return [];
      }, venueId);
    const check = checkNoOpenOrders([
      { adapter: delayed('gateio'), credentials, symbol: 'CAKE/USDT' },
      { adapter: delayed('bitget'), credentials, symbol: 'CAKE/USDT' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBe(2);
    release();
    const result = await check;
    expect(result).toEqual({ ok: true, orders: [], errors: [] });
  });
});
