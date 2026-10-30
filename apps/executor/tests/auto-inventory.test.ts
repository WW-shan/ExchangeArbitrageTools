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
  accountSeedFill,
  attemptAutomaticInventorySeed,
  planAutomaticInventorySeed,
  reconcileAutomaticInventoryNoFill,
  resolveSeedAccounting,
  usableSeedAccounting,
  type InventoryVenueSnapshot,
} from '../src/auto-inventory.js';
import type { RecoveryVenue } from '../src/bootstrap.js';
import type { ExecutorConfig } from '../src/config.js';
import { repairClosedSeedAccounting } from '../src/seed-accounting-repair.js';

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
  omitZero = false,
): BalanceSnapshot[] {
  const rows: BalanceSnapshot[] = [
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
  return omitZero ? rows.filter((row) => row.free.gt(0)) : rows;
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
  feeCurrency?: string | null;
  orderFee?: string;
}) {
  const requests: OrderRequest[] = [];
  let currentBalances = input.before;
  const orderFor = (request: OrderRequest): OrderState => {
    const filled = input.partial ? request.amount.div(2) : request.amount;
    const fee = input.orderFee ? new Decimal(input.orderFee) : filled.mul('0.001');
    const feeCurrency = input.feeCurrency === null ? undefined : (input.feeCurrency ?? 'WARD');
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
      ...(request.price ? { fee, ...(feeCurrency ? { feeCurrency } : {}) } : {}),
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
    feeCurrency?: string | null;
    orderFee?: string;
    gateAfterWard?: string;
    gateAfterUsdt?: string;
    omitZeroBalances?: boolean;
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
  const gateBefore = balances(
    'gateio',
    options.gateWard ?? '0',
    options.gateUsdt ?? '20',
    Date.now() - 1000,
    options.omitZeroBalances,
  );
  const bitgetBefore = balances(
    'bitget',
    options.bitgetWard ?? '0',
    options.bitgetUsdt ?? '20',
    Date.now() - 1000,
    options.omitZeroBalances,
  );
  for (const row of [...gateBefore, ...bitgetBefore]) repository.recordBalance(row);
  const gateAfter = balances(
    'gateio',
    options.gateAfterWard ?? '999',
    options.gateAfterUsdt ?? '15',
    Date.now(),
  );
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
    ...(options.feeCurrency !== undefined ? { feeCurrency: options.feeCurrency } : {}),
    ...(options.orderFee ? { orderFee: options.orderFee } : {}),
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

  it('does not buy the funded side when it is outside the pair band', () => {
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
      reasons: ['funded_side_above_pair_band'],
    });
  });

  it('seeds the funded side when both sides are missing and the price is near parity', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '0', '5'),
        inventoryVenue('bitget', '0.005004', '0.004994', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
    });
    expect(decision.action).toBe('SEED');
    if (decision.action !== 'SEED') return;
    expect(decision.plan.venueId).toBe('bitget');
    expect(decision.plan.reason).toBe('both_sides_missing_funded_side');
  });

  it('seeds the signal sell venue even when the other venue is cheaper', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '0', '20'),
        inventoryVenue('bitget', '0.005004', '0.004994', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
      preferredVenueId: 'bitget',
    });
    expect(decision.action).toBe('SEED');
    if (decision.action !== 'SEED') return;
    expect(decision.plan.venueId).toBe('bitget');
    expect(decision.plan.reason).toBe('missing_side_near_parity');
  });

  it('does not seed the preferred side when that side is already useful', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '0', '20'),
        inventoryVenue('bitget', '0.0051', '0.00509', '1000', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
      preferredVenueId: 'bitget',
    });
    expect(decision).toMatchObject({
      action: 'NOOP',
      reasons: ['inventory_preferred_side_sufficient'],
    });
  });

  it('does not seed the preferred side outside the pair price band', () => {
    const decision = planAutomaticInventorySeed({
      pair: config().autoRotation.pairs[0]!,
      venues: [
        inventoryVenue('gateio', '0.0050', '0.00499', '0', '20'),
        inventoryVenue('bitget', '0.0052', '0.00519', '0', '20'),
      ],
      config: config().autoRotation.inventory,
      now: Date.now(),
      preferredVenueId: 'bitget',
    });
    expect(decision).toMatchObject({
      action: 'WAIT',
      reasons: ['missing_side_above_pair_band'],
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

describe('automatic inventory fee accounting', () => {
  it('deducts a base-asset fee from the net base received', () => {
    const accounting = accountSeedFill({
      base: 'WARD',
      exchangeBase: 'WARD',
      quote: 'USDT',
      baseMultiplier: new Decimal(1),
      filled: new Decimal('1127'),
      averagePrice: new Decimal('0.004423'),
      limitPrice: new Decimal('0.00443'),
      fee: new Decimal('1.11573'),
      feeCurrency: 'WARD',
    });
    expect(accounting).toMatchObject({
      known: true,
      feeTreatment: 'base',
      feeCurrency: 'WARD',
    });
    expect(accounting.baseDeltaCanonical.toFixed()).toBe('1125.88427');
    expect(accounting.quoteDelta.toFixed()).toBe('-4.984721');
  });

  it('adds a quote-asset fee to the quote outflow', () => {
    const accounting = accountSeedFill({
      base: 'WARD',
      exchangeBase: 'WARD',
      quote: 'USDT',
      baseMultiplier: new Decimal(1),
      filled: new Decimal('1000'),
      averagePrice: new Decimal('0.005'),
      limitPrice: new Decimal('0.005'),
      fee: new Decimal('0.005'),
      feeCurrency: 'USDT',
    });
    expect(accounting).toMatchObject({ known: true, feeTreatment: 'quote' });
    expect(accounting.baseDeltaCanonical.toFixed()).toBe('1000');
    expect(accounting.quoteDelta.toFixed()).toBe('-5.005');
  });

  it('falls back to actual balance deltas when the fee asset is missing', () => {
    const order = accountSeedFill({
      base: 'WARD',
      exchangeBase: 'WARD',
      quote: 'USDT',
      baseMultiplier: new Decimal(1),
      filled: new Decimal('1000'),
      averagePrice: new Decimal('0.005'),
      limitPrice: new Decimal('0.005'),
      fee: new Decimal('1'),
    });
    expect(order).toMatchObject({ known: false, feeTreatment: 'missing_currency' });
    const resolved = resolveSeedAccounting({
      order,
      filledCanonical: new Decimal('1000'),
      balanceDelta: {
        baseDeltaCanonical: new Decimal('999'),
        quoteDelta: new Decimal('-5'),
      },
    });
    expect(resolved).toMatchObject({ source: 'balance_delta' });
    expect(resolved.accounting.known).toBe(true);
    expect(resolved.accounting.baseDeltaCanonical.toFixed()).toBe('999');
    expect(resolved.accounting.quoteDelta.toFixed()).toBe('-5');
  });

  it('rejects a net base delta that is zero or negative', () => {
    const accounting = accountSeedFill({
      base: 'WARD',
      exchangeBase: 'WARD',
      quote: 'USDT',
      baseMultiplier: new Decimal(1),
      filled: new Decimal('1000'),
      averagePrice: new Decimal('0.005'),
      limitPrice: new Decimal('0.005'),
      fee: new Decimal('1000'),
      feeCurrency: 'WARD',
    });
    expect(accounting.known).toBe(true);
    expect(accounting.baseDeltaCanonical.toFixed()).toBe('0');
    expect(usableSeedAccounting(accounting)).toBe(false);
  });
});

describe('automatic inventory execution', () => {
  it('treats omitted zero-balance assets as zero instead of a missing snapshot', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      gate,
      now,
    } = setup({
      omitZeroBalances: true,
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
    expect(gate.requests[0]).toMatchObject({ side: 'buy', timeInForce: 'FOK' });
  });

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
    const recorded = repository.db
      .prepare(
        `SELECT o.fee, o.fee_currency, e.inventory_delta_json, e.metadata_json
         FROM orders o JOIN executions e ON e.id = o.execution_id
         WHERE e.batch_id = ?`,
      )
      .get(result.batchId!) as {
      fee: string;
      fee_currency: string;
      inventory_delta_json: string;
      metadata_json: string;
    };
    expect(recorded.fee).toBe('1');
    expect(recorded.fee_currency).toBe('WARD');
    expect(JSON.parse(recorded.inventory_delta_json)).toMatchObject({
      baseAsset: 'WARD',
      baseDelta: '999',
      quoteAsset: 'USDT',
      quoteDelta: '-5',
    });
    expect(JSON.parse(recorded.metadata_json)).toMatchObject({
      feeAmount: '1',
      feeCurrency: 'WARD',
      feeTreatment: 'base',
      netBaseCanonical: '999',
    });
  });

  it('uses actual balances when the venue omits the fee asset', async () => {
    const {
      repository,
      adapters,
      markets,
      config: executorConfig,
      now,
    } = setup({
      feeCurrency: null,
      orderFee: '1',
      gateAfterWard: '999',
      gateAfterUsdt: '15',
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
    const execution = repository.db
      .prepare('SELECT inventory_delta_json, metadata_json FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { inventory_delta_json: string; metadata_json: string };
    expect(JSON.parse(execution.inventory_delta_json)).toMatchObject({
      baseDelta: '999',
      quoteDelta: '-5',
    });
    expect(JSON.parse(execution.metadata_json)).toMatchObject({
      accountingSource: 'balance_delta',
      feeTreatment: 'missing_currency',
    });
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

  it('does not call inventory sufficient when one venue has base but no buy-side USDT', async () => {
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
      gateUsdt: '20',
      bitgetUsdt: '0.09',
    });
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('WAIT');
    expect(result.reasons).toContain('inventory_quote_rebalance_required');
    expect(result.reasons).toContain('bitget_quote_reserve_short');
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

  it('repairs a closed seed fee attribution without changing the order or kill switch', async () => {
    const { repository, adapters, markets, config: executorConfig, now } = setup();
    const result = await attemptAutomaticInventorySeed({
      repository,
      config: executorConfig,
      adapters,
      markets,
      pair: executorConfig.autoRotation.pairs[0]!,
      now,
    });
    expect(result.status).toBe('FILLED');
    const execution = repository.db
      .prepare('SELECT id FROM executions WHERE batch_id = ?')
      .get(result.batchId!) as { id: number };
    repository.updateExecutionStatus(execution.id, 'CLOSED', {
      inventoryDelta: {
        baseAsset: 'WARD',
        baseDelta: '1000',
        quoteAsset: 'USDT',
        quoteDelta: '-5',
      },
    });
    const repaired = repairClosedSeedAccounting({
      repository,
      batchId: result.batchId!,
      now: now + 1,
    });
    expect(repaired.status).toBe('REPAIRED');
    expect(repaired.inventoryDelta).toEqual({
      baseAsset: 'WARD',
      baseDelta: '999',
      quoteAsset: 'USDT',
      quoteDelta: '-5',
    });
    expect(repository.getSetting('kill_switch')).toBe('false');
    const audit = repository.db
      .prepare("SELECT action FROM audit_logs WHERE action = 'inventory_seed_accounting_repaired'")
      .get() as { action: string };
    expect(audit.action).toBe('inventory_seed_accounting_repaired');
    const second = repairClosedSeedAccounting({
      repository,
      batchId: result.batchId!,
      now: now + 2,
    });
    expect(second.status).toBe('ALREADY_CORRECT');
  });
});
