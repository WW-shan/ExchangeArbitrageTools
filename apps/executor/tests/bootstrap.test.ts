import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import type { MarketMetadata } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, CexAdapter, OrderState } from '@arb/venues-cex';
import { recoverExecutorStartup, type RecoveryVenue } from '../src/bootstrap.js';

const now = 1_700_000_000_000;
const keys: ApiCredentials = { apiKey: 'test', secret: 'test' };

function market(venueId: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 3,
    amountPrecision: 3,
    amountStep: new Decimal('0.001'),
    priceStep: new Decimal('0.001'),
    feeTakerBps: new Decimal(10),
    supportsIoc: true,
  };
}

function adapter(
  venueId: string,
  result: () => Promise<OrderState>,
  openOrders: OrderState[] | (() => Promise<OrderState[]>) = [],
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
    loadMarkets: async () => [market(venueId)],
    fetchOrderBook: async () => {
      throw new Error('not used');
    },
    fetchBalances: async () => [
      {
        venueId,
        accountId: 'default',
        currency: 'USDT',
        free: new Decimal(100),
        used: new Decimal(0),
        total: new Decimal(100),
        fetchedAt: now,
      },
    ],
    fetchOrder: result,
    fetchOpenOrders: typeof openOrders === 'function' ? openOrders : async () => openOrders,
  };
}

function openOrder(venueId: string): OrderState {
  return {
    venueOrderId: 'external-1',
    clientOrderId: 'external-1',
    symbol: 'CAKE/USDT',
    side: 'buy',
    type: 'limit',
    price: new Decimal('2.4'),
    amount: new Decimal(1),
    filled: new Decimal(0),
    remaining: new Decimal(1),
    status: 'open',
    raw: { venueId },
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const repository = new ArbitrageRepository(db);
  repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
  const executionId = repository.createExecution({
    strategy: 'S1',
    batchId: 'recover-batch',
    status: 'LEG1_UNKNOWN',
    plannedNotional: new Decimal(30),
    expectedProfit: new Decimal('0.25'),
    openedAt: now,
  });
  repository.addExecutionLeg({
    executionId,
    legNumber: 1,
    venueId: 'gateio',
    side: 'buy',
    requestedAmount: new Decimal(12),
    requestedPrice: new Decimal('2.5'),
    status: 'unknown',
    submittedAt: now,
    clientOrderId: 'recover-batch-L1',
  });
  repository.recordOrder({
    venueId: 'gateio',
    clientOrderId: 'recover-batch-L1',
    executionId,
    symbol: 'CAKE/USDT',
    side: 'buy',
    type: 'limit',
    price: new Decimal('2.5'),
    amount: new Decimal(12),
    filledAmount: new Decimal(0),
    status: 'unknown',
    now,
  });
  return { db, repository, executionId };
}

describe('executor startup recovery', () => {
  it('queries a pending order even when its execution leg has not been marked submitted', async () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    const executionId = repository.createExecution({
      strategy: 'S1',
      batchId: 'pending-batch',
      status: 'LEG1_SUBMITTING',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.25'),
      openedAt: now,
    });
    repository.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: 'gateio',
      side: 'buy',
      requestedAmount: new Decimal(12),
      requestedPrice: new Decimal('2.5'),
      status: 'planned',
      clientOrderId: 'pending-batch-L1',
    });
    repository.recordOrder({
      venueId: 'gateio',
      clientOrderId: 'pending-batch-L1',
      executionId,
      symbol: 'CAKE/USDT',
      side: 'buy',
      type: 'limit',
      price: new Decimal('2.5'),
      amount: new Decimal(12),
      filledAmount: new Decimal(0),
      status: 'pending',
      now,
    });
    const result = await recoverExecutorStartup({
      repository,
      venues: {
        gateio: {
          adapter: adapter('gateio', async () => ({
            venueOrderId: 'venue-pending',
            clientOrderId: 'pending-batch-L1',
            symbol: 'CAKE/USDT',
            side: 'buy',
            type: 'limit',
            price: new Decimal('2.5'),
            amount: new Decimal(12),
            filled: new Decimal(0),
            remaining: new Decimal(12),
            status: 'open',
            raw: { status: 'open' },
          })),
          credentials: keys,
        },
      },
      now: () => now,
    });
    expect(result.queriedOrders).toBe(1);
    expect(repository.getOrder('pending-batch-L1')?.status).toBe('open');
    expect(repository.recoveryCounts().unresolvedLegs).toBe(1);
    expect(result.decision.blockExecution).toBe(true);
    repository.close();
  });

  it('queries unresolved orders, persists the result, restores backoff and keeps execution blocked', async () => {
    const { db, repository } = setup();
    repository.setSetting('kill_switch', 'false', now);
    repository.upsertVenueBackoff({
      venueId: 'gateio',
      backoffUntil: now + 10_000,
      reason: 'rate_limited',
      consecutiveFailures: 1,
      updatedAt: now,
    });
    let appliedBackoff = 0;
    const venues: Record<string, RecoveryVenue> = {
      gateio: {
        adapter: adapter('gateio', async () => ({
          venueOrderId: 'venue-1',
          clientOrderId: 'recover-batch-L1',
          symbol: 'CAKE/USDT',
          side: 'buy',
          type: 'limit',
          price: new Decimal('2.5'),
          amount: new Decimal(12),
          filled: new Decimal(12),
          remaining: new Decimal(0),
          averagePrice: new Decimal('2.49'),
          fee: new Decimal('0.03'),
          status: 'closed',
          raw: { status: 'closed' },
        })),
        credentials: keys,
        applyBackoff: (retryAfterMs) => {
          appliedBackoff = retryAfterMs;
        },
      },
    };
    const result = await recoverExecutorStartup({
      repository,
      venues,
      now: () => now,
    });
    expect(result.queriedOrders).toBe(1);
    expect(result.resolvedOrders).toBe(1);
    expect(result.unresolvedOrders).toBe(0);
    expect(result.openExecutions).toBe(1);
    expect(result.backoffs).toBe(1);
    expect(appliedBackoff).toBe(10_000);
    expect(result.decision.blockExecution).toBe(true);
    expect(repository.getSetting('kill_switch')).toBe('true');
    expect(repository.getOrder('recover-batch-L1')?.status).toBe('closed');
    const events = db
      .prepare(
        'SELECT COUNT(*) AS n FROM order_events WHERE order_id = (SELECT id FROM orders LIMIT 1)',
      )
      .get() as { n: number };
    expect(events.n).toBe(1);
    repository.close();
  });

  it('blocks when an unresolved query fails', async () => {
    const { repository } = setup();
    const result = await recoverExecutorStartup({
      repository,
      venues: {
        gateio: {
          adapter: adapter('gateio', async () => {
            throw new Error('venue unavailable');
          }),
          credentials: keys,
        },
      },
      now: () => now,
    });
    expect(result.failedQueries).toBe(1);
    expect(result.unresolvedOrders).toBe(1);
    expect(result.decision.blockExecution).toBe(true);
    expect(result.decision.killSwitch).toBe(true);
    repository.close();
  });

  it('allows enabling execution only after clean reconciliation and balance confirmation', async () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repository.setSetting('kill_switch', 'false', now);
    const result = await recoverExecutorStartup({
      repository,
      venues: {
        gateio: {
          adapter: adapter('gateio', async () => {
            throw new Error('not used');
          }),
          credentials: keys,
        },
      },
      now: () => now,
    });
    expect(result.queriedOrders).toBe(0);
    expect(result.balancesConfirmed).toBe(true);
    expect(result.decision.blockExecution).toBe(false);
    expect(result.decision.killSwitch).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM balances').get() as { n: number }).n).toBe(1);
    repository.close();
  });

  it('blocks startup when an exchange-wide open order exists', async () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repository.setSetting('kill_switch', 'false', now);
    const result = await recoverExecutorStartup({
      repository,
      venues: {
        gateio: {
          adapter: adapter(
            'gateio',
            async () => {
              throw new Error('not used');
            },
            [openOrder('gateio')],
          ),
          credentials: keys,
        },
      },
      pairs: [{ base: 'CAKE', quote: 'USDT' }],
      now: () => now,
    });
    expect(result.openOrdersQueried).toBe(1);
    expect(result.openOrdersFound).toBe(1);
    expect(result.decision.reasons).toContain('open_orders_require_reconciliation');
    expect(result.decision.blockExecution).toBe(true);
    expect(result.decision.killSwitch).toBe(true);
    repository.close();
  });

  it('blocks startup when the open-order query fails', async () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repository.setSetting('kill_switch', 'false', now);
    const result = await recoverExecutorStartup({
      repository,
      venues: {
        gateio: {
          adapter: adapter(
            'gateio',
            async () => {
              throw new Error('not used');
            },
            async () => {
              throw new Error('query timeout');
            },
          ),
          credentials: keys,
        },
      },
      pairs: [{ base: 'CAKE', quote: 'USDT' }],
      now: () => now,
    });
    expect(result.openOrderQueryFailures).toBeGreaterThan(0);
    expect(result.decision.reasons).toContain('open_orders_query_failed');
    expect(result.decision.blockExecution).toBe(true);
    expect(result.decision.killSwitch).toBe(true);
    repository.close();
  });
});
