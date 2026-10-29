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
import {
  attemptAutomaticInventorySeed,
  planAutomaticInventorySeed,
  reconcileAutomaticInventoryNoFill,
  type InventoryVenueSnapshot,
} from '../src/auto-inventory.js';
import type { RecoveryVenue } from '../src/bootstrap.js';
import type { ExecutorConfig } from '../src/config.js';

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
  ask: string,
  bid: string,
  fetchedAt = Date.now(),
  exchangeTimestamp?: number,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'WARD/USDT',
    fetchedAt,
    receivedAt: fetchedAt,
    ...(exchangeTimestamp ? { exchangeTimestamp } : {}),
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

function inventoryVenue(
  venueId: string,
  ask: string,
  bid: string,
  ward: string,
  usdt: string,
  fetchedAt = Date.now(),
): InventoryVenueSnapshot {
  return {
    venueId,
    market: market(venueId),
    book: book(venueId, ask, bid, fetchedAt),
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
        minQuoteReserveUsd: new Decimal(5),
        minUsefulNotionalUsd: new Decimal(3),
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

function fakeVenue(input: {
  venueId: string;
  ask: string;
  bid: string;
  before: BalanceSnapshot[];
  after?: BalanceSnapshot[];
  createError?: Error;
  fetchOrderError?: Error;
  partial?: boolean;
  exchangeTimestamp?: number;
}) {
  const requests: OrderRequest[] = [];
  let currentBalances = input.before;
  const orderFor = (request: OrderRequest): OrderState => {
    const filled = input.partial ? request.amount.div(2) : request.amount;
    return {
      venueOrderId: `${input.venueId}-1`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      ...(request.price ? { price: request.price } : {}),
      amount: request.amount,
      filled,
      remaining: request.amount.minus(filled),
      ...(request.price ? { averagePrice: request.price } : {}),
      ...(request.price ? { fee: request.price.mul(filled).mul('0.001') } : {}),
      status: input.partial ? 'canceled' : 'closed',
      raw: { fake: true },
    };
  };
  const adapter: CexAdapter = {
    venueId: input.venueId,
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: true,
      createOrder: true,
      fetchOrder: true,
      openOrders: true,
      cancelOrder: true,
      websocket: false,
      ioc: true,
      fok: true,
    },
    loadMarkets: async () => [market(input.venueId)],
    fetchOrderBook: async () =>
      book(input.venueId, input.ask, input.bid, Date.now(), input.exchangeTimestamp),
    fetchBalances: async () => currentBalances.map((row) => ({ ...row, fetchedAt: Date.now() })),
    fetchOpenOrders: async () => [],
    createOrder: async (request) => {
      requests.push(request);
      if (input.createError) throw input.createError;
      currentBalances = input.after ?? currentBalances;
      return orderFor(request);
    },
    fetchOrder: async (query) => {
      if (input.fetchOrderError) throw input.fetchOrderError;
      const request = requests.find((row) => row.clientOrderId === query.clientOrderId);
      if (!request) throw new Error('unknown fake order');
      return orderFor(request);
    },
    cancelOrder: async (query) => {
      const request = requests.find((row) => row.clientOrderId === query.clientOrderId);
      if (!request) throw new Error('unknown fake order');
      return orderFor(request);
    },
  };
  return { adapter, requests };
}

function setup(
  options: {
    gateAsk?: string;
    gateBid?: string;
    bitgetAsk?: string;
    bitgetBid?: string;
    gateWard?: string;
    gateUsdt?: string;
    bitgetWard?: string;
    bitgetUsdt?: string;
    createError?: Error;
    fetchOrderError?: Error;
    partial?: boolean;
    exchangeTimestamp?: number;
    inventory?: Partial<ExecutorConfig['autoRotation']['inventory']>;
  } = {},
) {
  const now = Date.now();
  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  for (const venueId of ['gateio', 'bitget']) {
    repository.upsertVenue({
      id: venueId,
      type: 'cex',
      name: venueId,
      tier: 'S',
      executionEnabled: true,
      now,
    });
  }
  repository.setSetting('live_enabled', 'true', now);
  repository.setSetting('auto_execution_enabled', 'true', now);
  repository.setSetting('kill_switch', 'false', now);
  const gateBefore = balances('gateio', options.gateWard ?? '0', options.gateUsdt ?? '20');
  const bitgetBefore = balances('bitget', options.bitgetWard ?? '0', options.bitgetUsdt ?? '20');
  for (const row of [...gateBefore, ...bitgetBefore]) repository.recordBalance(row);
  const gateAfter = balances('gateio', '1000', '14.995', Date.now());
  const bitgetAfter = balances('bitget', options.bitgetWard ?? '0', options.bitgetUsdt ?? '20');
  const gate = fakeVenue({
    venueId: 'gateio',
    ask: options.gateAsk ?? '0.0050',
    bid: options.gateBid ?? '0.00499',
    before: gateBefore,
    after: gateAfter,
    ...(options.createError ? { createError: options.createError } : {}),
    ...(options.fetchOrderError ? { fetchOrderError: options.fetchOrderError } : {}),
    ...(options.partial ? { partial: true } : {}),
    ...(options.exchangeTimestamp ? { exchangeTimestamp: options.exchangeTimestamp } : {}),
  });
  const bitget = fakeVenue({
    venueId: 'bitget',
    ask: options.bitgetAsk ?? '0.0051',
    bid: options.bitgetBid ?? '0.00509',
    before: bitgetBefore,
    after: bitgetAfter,
    ...(options.createError ? { createError: options.createError } : {}),
    ...(options.fetchOrderError ? { fetchOrderError: options.fetchOrderError } : {}),
  });
  const adapters: Record<string, RecoveryVenue> = {
    gateio: { adapter: gate.adapter, credentials },
    bitget: { adapter: bitget.adapter, credentials },
  };
  const markets = {
    gateio: [market('gateio')],
    bitget: [market('bitget')],
  };
  return {
    repository,
    adapters,
    markets,
    config: config(options.inventory),
    gate,
    bitget,
    now,
  };
}

describe('automatic inventory planning', () => {
  it('buys the cheaper venue when both sides are missing', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '0', '20'),
        inventoryVenue('bitget', '0.0051', '0.00509', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
    });
    expect(decision.action).toBe('SEED');
    if (decision.action !== 'SEED') return;
    expect(decision.plan.venueId).toBe('gateio');
    expect(decision.plan.reason).toBe('both_sides_missing_cheaper_side');
    expect(decision.plan.amount.toFixed()).toBe('1000');
    expect(decision.plan.limitPrice.toFixed()).toBe('0.005');
  });

  it('does not buy the expensive side outside the pair band', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '1000', '20'),
        inventoryVenue('bitget', '0.0052', '0.00519', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
    });
    expect(decision).toEqual({ action: 'WAIT', reasons: ['missing_side_above_pair_band'] });
  });

  it('buys the missing side when it is at or below the other side', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '1000', '20'),
        inventoryVenue('bitget', '0.00499', '0.00498', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
    });
    expect(decision.action).toBe('SEED');
    if (decision.action !== 'SEED') return;
    expect(decision.plan.venueId).toBe('bitget');
    expect(decision.plan.reason).toBe('missing_side_cheaper');
  });

  it('tops up only the missing base value instead of buying a full seed again', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '500', '20'),
        inventoryVenue('bitget', '0.0051', '0.00509', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
    });
    expect(decision.action).toBe('SEED');
    if (decision.action !== 'SEED') return;
    expect(decision.plan.venueId).toBe('gateio');
    expect(decision.plan.plannedNotional.lt(5)).toBe(true);
    expect(decision.plan.plannedNotional.gt('2.4')).toBe(true);
  });

  it('does not spend the quote reserve', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '0', '5'),
        inventoryVenue('bitget', '0.0051', '0.00509', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
    });
    expect(decision).toMatchObject({
      action: 'WAIT',
      reasons: ['inventory_quote_reserve_exhausted'],
    });
  });

  it('waits for the price to remain stable', () => {
    const now = Date.now();
    const pair = config().autoRotation.pairs[0]!;
    const venues = [
      inventoryVenue('gateio', '0.0050', '0.00499', '0', '20', now),
      inventoryVenue('bitget', '0.0051', '0.00509', '0', '20', now),
    ];
    const first = planAutomaticInventorySeed({
      pair,
      venues,
      config: config({ minStableMs: 3000 }).autoRotation.inventory,
      now,
    });
    expect(first.action).toBe('WAIT');
    if (first.action !== 'WAIT' || !first.observation) return;
    expect(first.reasons).toContain('inventory_price_not_stable');
    const second = planAutomaticInventorySeed({
      pair,
      venues,
      config: config({ minStableMs: 3000 }).autoRotation.inventory,
      now: now + 3000,
      previousObservation: first.observation,
    });
    expect(second.action).toBe('SEED');
  });
});

describe('automatic inventory execution', () => {
  it('submits one FOK buy and records a SEED execution', async () => {
    const { repository, adapters, markets, config: executorConfig, gate, now } = setup();
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('FILLED');
    expect(result.killSwitch).toBeUndefined();
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0]).toMatchObject({ side: 'buy', timeInForce: 'FOK' });
    expect(gate.requests[0]!.clientOrderId.length).toBeLessThanOrEqual(28);
    const execution = repository.db
      .prepare('SELECT strategy, status, closed_at FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { strategy: string; status: string; closed_at: number | null };
    expect(execution).toMatchObject({ strategy: 'SEED', status: 'CLOSED' });
    expect(execution.closed_at).not.toBeNull();
    const audit = repository.db
      .prepare(`SELECT action FROM audit_logs WHERE action = 'inventory_seed_filled' LIMIT 1`)
      .get() as { action: string };
    expect(audit.action).toBe('inventory_seed_filled');
  });

  it('accepts a fresh REST book when the exchange timestamp is old on a thin market', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      gate,
      now,
    } = setup({
      exchangeTimestamp: Date.now() - 45_000,
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('FILLED');
    expect(gate.requests).toHaveLength(1);
  });

  it('does not submit when both sides already have useful inventory', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      gate,
      bitget,
      now,
    } = setup({
      gateWard: '1000',
      bitgetWard: '1000',
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result).toMatchObject({ status: 'NOOP', reasons: ['inventory_sufficient'] });
    expect(gate.requests).toEqual([]);
    expect(bitget.requests).toEqual([]);
  });

  it('does not retry an ambiguous order and leaves the kill switch on', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      gate,
      now,
    } = setup({
      createError: new Error('network timeout'),
      fetchOrderError: new Error('order not found'),
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.killSwitch).toBe(true);
    expect(gate.requests).toHaveLength(1);
    expect(repository.getSetting('kill_switch')).toBe('true');
    const execution = repository.db
      .prepare('SELECT status FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { status: string };
    expect(execution.status).toBe('SEED_UNKNOWN');
  });

  it('resolves an ambiguous submission by order lookup without resubmitting', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      gate,
      now,
    } = setup({
      createError: new Error('network timeout'),
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('FILLED');
    expect(gate.requests).toHaveLength(1);
    expect(repository.getSetting('kill_switch')).toBe('true');
    const execution = repository.db
      .prepare('SELECT status FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { status: string };
    expect(execution.status).toBe('CLOSED');
  });

  it('reconciles an unknown seed as no-fill only with unchanged balances', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      now,
    } = setup({
      createError: new Error('network timeout'),
      fetchOrderError: new Error('order not found'),
    });
    const attempted = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(attempted.status).toBe('UNKNOWN');
    const reconciled = await reconcileAutomaticInventoryNoFill({
      repository,
      adapters,
      batchId: attempted.batchId!,
    });
    expect(reconciled.status).toBe('RECONCILED');
    expect(repository.countOpenExecutions()).toBe(0);
    expect(repository.countUnresolvedOrders()).toBe(0);
    expect(repository.getSetting('kill_switch')).toBe('true');
    const execution = repository.db
      .prepare('SELECT status FROM executions WHERE batch_id = ?')
      .get(attempted.batchId!) as { status: string };
    expect(execution.status).toBe('SEED_REJECTED');
  });

  it('records a definitive no-fill as rejected without opening the kill switch', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      now,
    } = setup({
      createError: new Error('FOK_NOT_FILL'),
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('REJECTED');
    expect(repository.getSetting('kill_switch')).toBe('false');
    const execution = repository.db
      .prepare('SELECT status FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { status: string };
    expect(execution.status).toBe('SEED_REJECTED');
  });

  it('treats an invalid client order id as a definitive rejection', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      now,
    } = setup({
      createError: new Error('BadRequest: clientOrderId or text param must be up to 28 characters'),
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('REJECTED');
    expect(repository.getSetting('kill_switch')).toBe('false');
  });

  it('stops on a partial seed fill', async () => {
    const { repository, adapters, markets, config: executorConfig, now } = setup({ partial: true });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('PARTIAL');
    expect(result.killSwitch).toBe(true);
    expect(repository.getSetting('kill_switch')).toBe('true');
    const execution = repository.db
      .prepare('SELECT status FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { status: string };
    expect(execution.status).toBe('SEED_PARTIAL');
  });
});
