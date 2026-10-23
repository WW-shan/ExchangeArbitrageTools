import { describe, expect, it } from 'vitest';
import { HotcoinReadOnlyAdapter, type HotcoinFetch } from '../src/index.js';

const fetchImpl: HotcoinFetch = async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      code: 200,
      msg: 'ok',
      data: [
        {
          baseCurrency: 'cake',
          quoteCurrency: 'usdt',
          symbol: 'cake_usdt',
          pricePrecision: 4,
          amountPrecision: 2,
          minOrderAmount: '15',
          minOrderCount: '0',
          state: 'enable',
        },
      ],
    }),
});

describe('Hotcoin custom read-only adapter', () => {
  it('normalizes the verified symbols endpoint and fails closed without a verified depth feed', async () => {
    const adapter = new HotcoinReadOnlyAdapter({ fetch: fetchImpl });
    const markets = await adapter.loadMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0]?.unifiedSymbol).toBe('CAKE/USDT');
    expect(markets[0]?.minNotional?.toFixed()).toBe('15');
    expect(adapter.capabilities.orderBook).toBe(false);
    await expect(adapter.fetchOrderBook('cake_usdt')).rejects.toThrow(/WebSocket feed required/);
  });
});
