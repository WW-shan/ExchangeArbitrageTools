import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { BalanceSnapshot, CexAdapter } from '@arb/venues-cex';
import { refreshBalances } from '../src/balance-service.js';

const now = 1_700_000_000_000;

function adapter(venueId: string, balances: BalanceSnapshot[] | Error): CexAdapter {
  return {
    venueId,
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: true,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      websocket: false,
      ioc: false,
      fok: false,
    },
    loadMarkets: async () => [],
    fetchOrderBook: async () => ({
      venueId,
      exchangeSymbol: 'CAKE/USDT',
      fetchedAt: now,
      asks: [],
      bids: [],
      source: 'rest',
    }),
    fetchBalances: async () => {
      if (balances instanceof Error) throw balances;
      return balances;
    },
  };
}

function balance(venueId: string, currency: string, free: string): BalanceSnapshot {
  return {
    venueId,
    accountId: 'default',
    currency,
    free: new Decimal(free),
    used: new Decimal(0),
    total: new Decimal(free),
    fetchedAt: now,
  };
}

describe('automatic balance refresh', () => {
  it('persists fetched balances and exposes the latest value with an age limit', async () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    const result = await refreshBalances(
      repository,
      [
        {
          adapter: adapter('gateio', [
            balance('gateio', 'USDT', '100'),
            balance('gateio', 'CAKE', '10'),
          ]),
          credentials: { apiKey: 'key', secret: 'secret' },
        },
      ],
      now,
    );
    expect(result).toEqual({ refreshed: 2, errors: [] });
    const latest = repository.latestBalances({ now });
    expect(latest).toHaveLength(2);
    expect(repository.balanceFor('gateio', 'USDT', { now })?.toFixed()).toBe('100');
    expect(repository.balanceFor('gateio', 'CAKE', { now })?.toFixed()).toBe('10');
    expect(
      repository.balanceFor('gateio', 'USDT', { now: now + 1000, maxAgeMs: 100 }),
    ).toBeUndefined();
    repository.close();
  });

  it('isolates a failing venue and records a risk event', async () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    const result = await refreshBalances(
      repository,
      [
        {
          adapter: adapter('gateio', new Error('private endpoint unavailable')),
          credentials: { apiKey: 'key', secret: 'secret' },
        },
      ],
      now,
    );
    expect(result.refreshed).toBe(0);
    expect(result.errors[0]).toContain('private endpoint unavailable');
    expect(
      repository.listRiskEvents(10).some((event) => event.rule === 'balance_refresh_failed'),
    ).toBe(true);
    repository.close();
  });
});
