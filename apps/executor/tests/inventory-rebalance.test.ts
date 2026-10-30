import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type {
  ApiCredentials,
  BalanceSnapshot,
  CexAdapter,
  OrderRequest,
  OrderState,
} from '@arb/venues-cex';
import type { RecoveryVenue } from '../src/bootstrap.js';
import type { ExecutorConfig } from '../src/config.js';
import {
  attemptAutomaticInventoryRebalance,
  planAutomaticInventoryRebalance,
  type InventoryRebalanceVenueSnapshot,
} from '../src/inventory-rebalance.js';

const credentials: ApiCredentials = { apiKey: 'test', secret: 'test' };

function market(venueId: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: 'WARD/USDT',
    unifiedSymbol: 'WARD/USDT',
    base: 'WARD',
    quote: 'USDT',
    active: true,
    pricePrecision: 6,
    amountPrecision: 2,
    amountStep: new Decimal('0.01'),
    priceStep: new Decimal('0.000001'),
    minAmount: new Decimal('0.01'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal('10'),
    supportsIoc: true,
    supportsFok: true,
  };
}

function book(
  venueId: string,
  bid = '0.005',
  ask = '0.00501',
  fetchedAt = Date.now(),
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'WARD/USDT',
    fetchedAt,
    receivedAt: fetchedAt,
    bids: [{ price: new Decimal(bid), amount: new Decimal('100000') }],
    asks: [{ price: new Decimal(ask), amount: new Decimal('100000') }],
    source: 'rest',
  };
}

function balances(
  venueId: string,
  ward: string,
  usdt: string,
  fetchedAt = Date.now() - 1000,
): BalanceSnapshot[] {
  return [
    {
      venueId,
      accountId: 'default',
      currency: 'WARD',
      free: new Decimal(ward),
      used: new Decimal(0),
      total: new Decimal(ward),
      fetchedAt,
    },
    {
      venueId,
      accountId: 'default',
      currency: 'USDT',
      free: new Decimal(usdt),
      used: new Decimal(0),
      total: new Decimal(usdt),
      fetchedAt,
    },
  ];
}

function venue(
  venueId: string,
  ward: string,
  usdt: string,
  bid = '0.005',
  ask = '0.00501',
  fetchedAt = Date.now(),
): InventoryRebalanceVenueSnapshot {
  return {
    venueId,
    market: market(venueId),
    book: book(venueId, bid, ask, fetchedAt),
    balance: {
      venueId,
      baseFree: new Decimal(ward),
      quoteFree: new Decimal(usdt),
      fetchedAt,
    },
  };
}

function config(overrides: Partial<ExecutorConfig['autoRotation']['inventory']> = {}) {
  return {
    liveEnabled: true,
    orderbookDepth: 20,
    fokVenues: ['gateio', 'bitget'],
    settings: { maxOrderbookAgeMs: 60_000 },
    autoRotation: {
      balanceRefreshMs: 30_000,
      inventory: {
        enabled: true,
        seedNotionalUsd: new Decimal(5),
        minQuoteReserveUsd: new Decimal(2),
        minExecutableBuyUsd: new Decimal(3),
        minUsefulNotionalUsd: new Decimal(3),
        rebalanceEnabled: true,
        maxRebalanceLossUsd: new Decimal('0.25'),
        minRebalanceEdgeBps: new Decimal(50),
        rebalanceSignalMaxAgeMs: 15_000,
        requireSignalForSeed: true,
        minStableMs: 0,
        maxPairDeviationBps: new Decimal(15),
        maxPriceDriftBps: new Decimal(25),
        checkIntervalMs: 1000,
        retryCooldownMs: 60_000,
        ...overrides,
      },
      pairs: [
        {
          base: 'WARD',
          quote: 'USDT',
          maxNotional: new Decimal(10),
          venues: ['gateio', 'bitget'] as const,
        },
      ],
    },
  } as unknown as ExecutorConfig;
}

function trigger(now: number) {
  return {
    venueId: 'bitget',
    otherVenueId: 'gateio',
    edgeBps: new Decimal(220),
    sampledAt: now,
    opportunityId: 1,
  };
}

describe('automatic inventory rebalance planning', () => {
  it('sells only enough excess base to restore the buy-side quote reserve', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '1000', '20', '0.005', '0.00501', now),
        venue('bitget', '4000', '0.09', '0.005', '0.00501', now),
      ],
      config: config().autoRotation.inventory,
      trigger: trigger(now),
      now,
    });
    expect(decision, JSON.stringify(decision)).toMatchObject({ action: 'SELL' });
    if (decision.action !== 'SELL') return;
    expect(decision.plan.venueId).toBe('bitget');
    expect(decision.plan.currentQuoteUsd.toFixed()).toBe('0.09');
    expect(decision.plan.expectedRemainingBaseUsd.gte(3)).toBe(true);
    expect(decision.plan.expectedQuoteProceeds.gte('4.9')).toBe(true);
    expect(decision.plan.expectedQuoteProceeds.lte('5.1')).toBe(true);
    expect(decision.plan.amount.lt(1100)).toBe(true);
  });

  it('does not sell when the buy-side quote reserve is already funded', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '1000', '20', '0.005', '0.00501', now),
        venue('bitget', '4000', '5', '0.005', '0.00501', now),
      ],
      config: config().autoRotation.inventory,
      trigger: trigger(now),
      now,
    });
    expect(decision).toMatchObject({ action: 'NOOP', reasons: ['inventory_quote_sufficient'] });
  });

  it('does not sell when base surplus cannot fully restore the reserve', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '1000', '20', '0.005', '0.00501', now),
        venue('bitget', '650', '0.09', '0.005', '0.00501', now),
      ],
      config: config().autoRotation.inventory,
      trigger: trigger(now),
      now,
    });
    expect(decision).toMatchObject({
      action: 'WAIT',
      reasons: ['inventory_rebalance_base_surplus_insufficient'],
    });
  });

  it('does not convert base when the opposite sell leg has no inventory', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '0', '2.05', '0.005', '0.00501', now),
        venue('bitget', '4000', '0.09', '0.005', '0.00501', now),
      ],
      config: config().autoRotation.inventory,
      trigger: trigger(now),
      now,
    });
    expect(decision).toMatchObject({
      action: 'WAIT',
      reasons: ['inventory_rebalance_sell_leg_unfunded'],
    });
  });

  it('can sell surplus base from a funding pair even when that pair is not the target trade', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '0', '2.05', '0.005', '0.00501', now),
        venue('bitget', '4000', '0.09', '0.005', '0.00501', now),
      ],
      config: config().autoRotation.inventory,
      trigger: { ...trigger(now), fundingOnly: true },
      now,
    });
    expect(decision.action).toBe('SELL');
    if (decision.action !== 'SELL') return;
    expect(decision.plan.venueId).toBe('bitget');
    expect(decision.plan.fundingOnly).toBe(true);
  });

  it('meets the venue minimum notional when funding another pair', () => {
    const now = Date.now();
    const fundingMarket: MarketMetadata = {
      ...market('gateio'),
      amountStep: new Decimal('1'),
      minNotional: new Decimal('3'),
    };
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        {
          venueId: 'gateio',
          market: fundingMarket,
          book: book('gateio', '0.25', '0.251', now),
          balance: {
            venueId: 'gateio',
            baseFree: new Decimal('20'),
            quoteFree: new Decimal('2.05'),
            fetchedAt: now,
          },
        },
        venue('bitget', '0', '0.5', '0.25', '0.251', now),
      ],
      config: config({ minQuoteReserveUsd: new Decimal('0.5') }).autoRotation.inventory,
      trigger: {
        ...trigger(now),
        venueId: 'gateio',
        otherVenueId: 'bitget',
        fundingOnly: true,
      },
      now,
    });
    expect(decision, JSON.stringify(decision)).toMatchObject({ action: 'SELL' });
    if (decision.action !== 'SELL') return;
    expect(decision.plan.amount.gte(12)).toBe(true);
    expect(decision.plan.amount.mul(decision.plan.limitPrice).gte(3)).toBe(true);
    expect(decision.plan.expectedRemainingBaseUsd.lt(3)).toBe(true);
  });

  it('respects the one-time rebalance cost ceiling', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '1000', '20', '0.0053', '0.00531', now),
        venue('bitget', '4000', '0.09', '0.005', '0.00501', now),
      ],
      config: config({ maxRebalanceLossUsd: new Decimal('0.1') }).autoRotation.inventory,
      trigger: trigger(now),
      now,
    });
    expect(decision).toMatchObject({
      action: 'WAIT',
      reasons: ['inventory_rebalance_cost_above_limit'],
    });
  });

  it('ignores stale rebalance signals', () => {
    const now = Date.now();
    const decision = planAutomaticInventoryRebalance({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        venue('gateio', '1000', '20', '0.005', '0.00501', now),
        venue('bitget', '4000', '0.09', '0.005', '0.00501', now),
      ],
      config: config().autoRotation.inventory,
      trigger: { ...trigger(now), sampledAt: now - 16_000 },
      now,
    });
    expect(decision).toMatchObject({
      action: 'WAIT',
      reasons: ['inventory_rebalance_signal_stale_or_weak'],
    });
  });
});

describe('automatic inventory rebalance execution', () => {
  it('submits one FOK sell and closes only after balance deltas prove the fill', async () => {
    const now = Date.now();
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    for (const venueId of ['gateio', 'bitget']) {
      repository.upsertVenue({ id: venueId, type: 'cex', name: venueId, tier: 'S', now });
    }
    repository.setSetting('live_enabled', 'true', now);
    repository.setSetting('auto_execution_enabled', 'true', now);
    repository.setSetting('kill_switch', 'false', now);

    let bitgetBalances = balances('bitget', '4000', '0.09', now - 1000);
    const requests: OrderRequest[] = [];
    const adapterFor = (venueId: string): CexAdapter => ({
      venueId,
      tier: 'S',
      capabilities: {
        publicMarketData: true,
        orderBook: true,
        privateBalances: true,
        createOrder: venueId === 'bitget',
        fetchOrder: venueId === 'bitget',
        openOrders: true,
        cancelOrder: true,
        websocket: false,
        ioc: true,
        fok: true,
      },
      loadMarkets: async () => [market(venueId)],
      fetchOrderBook: async () => book(venueId, '0.005', '0.00501', Date.now()),
      fetchBalances: async () =>
        venueId === 'bitget'
          ? bitgetBalances.map((row) => ({ ...row, fetchedAt: Date.now() }))
          : balances('gateio', '1000', '20'),
      fetchOpenOrders: async () => [],
      createOrder: async (request) => {
        requests.push(request);
        const proceeds = request.amount.mul(request.price!);
        bitgetBalances = balances(
          'bitget',
          new Decimal('4000').minus(request.amount).toFixed(),
          new Decimal('0.09').plus(proceeds).toFixed(),
          Date.now(),
        );
        const order: OrderState = {
          venueOrderId: 'bitget-rebalance-1',
          clientOrderId: request.clientOrderId,
          symbol: request.symbol,
          side: request.side,
          type: request.type,
          ...(request.price ? { price: request.price } : {}),
          amount: request.amount,
          filled: request.amount,
          remaining: new Decimal(0),
          ...(request.price ? { averagePrice: request.price } : {}),
          status: 'closed',
          raw: { fake: true },
        };
        return order;
      },
      fetchOrder: async () => {
        throw new Error('not used');
      },
      cancelOrder: async () => {
        throw new Error('not used');
      },
    });
    const adapters: Record<string, RecoveryVenue> = {
      gateio: { adapter: adapterFor('gateio'), credentials },
      bitget: { adapter: adapterFor('bitget'), credentials },
    };
    const markets = { gateio: [market('gateio')], bitget: [market('bitget')] };
    const executorConfig = config();
    const result = await attemptAutomaticInventoryRebalance({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      trigger: trigger(now),
      now,
    });
    expect(result.status).toBe('FILLED');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.side).toBe('sell');
    expect(requests[0]!.timeInForce).toBe('FOK');
    const execution = repository.db
      .prepare('SELECT status, inventory_delta_json FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { status: string; inventory_delta_json: string };
    expect(execution.status).toBe('CLOSED');
    const delta = JSON.parse(execution.inventory_delta_json) as {
      baseDelta: string;
      quoteDelta: string;
    };
    expect(new Decimal(delta.baseDelta).lt(0)).toBe(true);
    expect(new Decimal(delta.quoteDelta).gt(0)).toBe(true);
    expect(repository.getSetting('kill_switch')).toBe('false');
    repository.close();
  });
});
