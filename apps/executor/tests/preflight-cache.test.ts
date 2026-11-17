import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { BalanceSnapshot, OrderState } from '@arb/venues-cex';
import { PreflightCache } from '../src/preflight-cache.js';

const now = 1_700_000_000_000;

function balance(venueId: string, currency: string, fetchedAt = now): BalanceSnapshot {
  return {
    venueId,
    accountId: 'default',
    currency,
    free: new Decimal(10),
    used: new Decimal(0),
    total: new Decimal(10),
    fetchedAt,
  };
}

function order(venueOrderId: string): OrderState {
  return {
    venueOrderId,
    clientOrderId: `client-${venueOrderId}`,
    symbol: 'WARD/USDT',
    side: 'buy',
    type: 'limit',
    price: new Decimal('0.0016'),
    amount: new Decimal(100),
    filled: new Decimal(0),
    remaining: new Decimal(100),
    status: 'open',
    raw: {},
  };
}

describe('preflight cache', () => {
  it('only serves balance snapshots inside the freshness window', () => {
    const cache = new PreflightCache();
    cache.recordBalances([balance('gateio', 'USDT'), balance('gateio', 'WARD')]);

    expect(cache.balancesForVenue('gateio', { maxAgeMs: 1000, now })).toHaveLength(2);
    expect(cache.balancesForVenue('gateio', { maxAgeMs: 1000, now: now + 2000 })).toBeUndefined();
    expect(cache.balancesForVenue('bitget', { maxAgeMs: 1000, now })).toBeUndefined();
  });

  it('deduplicates cached open orders and expires stale checks', () => {
    const cache = new PreflightCache();
    const keys = ['gateio|WARD/USDT', 'bitget|WARD/USDT'];
    cache.recordOpenOrders(keys, { ok: true, orders: [order('1'), order('1')], errors: [] }, now);

    const fresh = cache.openOrdersFor(keys, { maxAgeMs: 2000, now });
    expect(fresh?.orders).toHaveLength(1);
    expect(cache.openOrdersFor(keys, { maxAgeMs: 2000, now: now + 3000 })).toBeUndefined();
  });

  it('can invalidate a single venue without dropping the other venue', () => {
    const cache = new PreflightCache();
    const gate = 'gateio|WARD/USDT';
    const bitget = 'bitget|WARD/USDT';
    cache.recordOpenOrders([gate], { ok: true, orders: [], errors: [] }, now);
    cache.recordOpenOrders([bitget], { ok: true, orders: [], errors: [] }, now);

    cache.invalidateOpenOrders([gate]);
    expect(cache.openOrdersFor([gate], { maxAgeMs: 1000, now })).toBeUndefined();
    expect(cache.openOrdersFor([bitget], { maxAgeMs: 1000, now })).toBeDefined();
  });
});
