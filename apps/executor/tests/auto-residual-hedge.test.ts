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
import { attemptAutomaticResidualHedge } from '../src/auto-residual-hedge.js';
import type { RecoveryVenue } from '../src/bootstrap.js';
import type { ExecutorConfig } from '../src/config.js';

const credentials: ApiCredentials = { apiKey: 'test', secret: 'test' };
const batchId = 'S1-SAFE-1';

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

function book(venueId: string, bid: string, ask = '0.006'): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'WARD/USDT',
    fetchedAt: Date.now(),
    receivedAt: Date.now(),
    bids: [{ price: new Decimal(bid), amount: new Decimal('5000') }],
    asks: [{ price: new Decimal(ask), amount: new Decimal('5000') }],
    source: 'rest',
  };
}

function balances(venueId: string, ward: string, usdt: string, freeWard = ward): BalanceSnapshot[] {
  return [
    {
      venueId,
      accountId: 'default',
      currency: 'WARD',
      free: new Decimal(freeWard),
      used: new Decimal(0),
      total: new Decimal(ward),
      fetchedAt: 0,
    },
    {
      venueId,
      accountId: 'default',
      currency: 'USDT',
      free: new Decimal(usdt),
      used: new Decimal(0),
      total: new Decimal(usdt),
      fetchedAt: 0,
    },
  ];
}

function fakeVenue(input: {
  venueId: string;
  bid: string;
  ask?: string;
  before: BalanceSnapshot[];
  after?: BalanceSnapshot[];
  createError?: Error;
}) {
  const requests: OrderRequest[] = [];
  let currentBalances = input.before;
  let nextTimestamp = Date.now();
  const orderFor = (request: OrderRequest): OrderState => {
    const fee = request.price?.mul(request.amount).mul('0.001');
    return {
      venueOrderId: `${input.venueId}-1`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      ...(request.price ? { price: request.price } : {}),
      amount: request.amount,
      filled: request.amount,
      remaining: new Decimal(0),
      ...(request.price ? { averagePrice: request.price } : {}),
      ...(fee ? { fee } : {}),
      status: 'closed',
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
      fok: input.venueId === 'bitget',
    },
    loadMarkets: async () => [market(input.venueId)],
    fetchOrderBook: async () => ({
      ...book(input.venueId, input.bid, input.ask),
      fetchedAt: nextTimestamp++,
    }),
    fetchBalances: async () => {
      const fetchedAt = nextTimestamp++;
      return currentBalances.map((row) => ({ ...row, fetchedAt }));
    },
    fetchOpenOrders: async () => [],
    createOrder: async (request) => {
      requests.push(request);
      if (input.createError) throw input.createError;
      currentBalances = input.after ?? currentBalances;
      nextTimestamp = Date.now() + 10_000;
      return orderFor(request);
    },
    fetchOrder: async (query) => {
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
    currentQuote?: string;
    createError?: Error;
    bitgetFreeWard?: string;
    gateWard?: string;
    direction?: 'long' | 'short';
    baselineWard?: string;
    baselineQuote?: string;
    currentWard?: string;
    afterWard?: string;
    afterQuote?: string;
    ask?: string;
    bid?: string;
  } = {},
) {
  const now = Date.now();
  const baselineAt = now - 10_000;
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
  repository.recordBalance({
    venueId: 'gateio',
    accountId: 'default',
    currency: 'WARD',
    free: new Decimal(0),
    used: new Decimal(0),
    total: new Decimal(0),
    fetchedAt: baselineAt,
  });
  repository.recordBalance({
    venueId: 'gateio',
    accountId: 'default',
    currency: 'USDT',
    free: new Decimal(1000),
    used: new Decimal(0),
    total: new Decimal(1000),
    fetchedAt: baselineAt,
  });
  repository.recordBalance({
    venueId: 'bitget',
    accountId: 'default',
    currency: 'WARD',
    free: new Decimal(options.baselineWard ?? '1000'),
    used: new Decimal(0),
    total: new Decimal(options.baselineWard ?? '1000'),
    fetchedAt: baselineAt,
  });
  repository.recordBalance({
    venueId: 'bitget',
    accountId: 'default',
    currency: 'USDT',
    free: new Decimal(options.baselineQuote ?? '1000'),
    used: new Decimal(0),
    total: new Decimal(options.baselineQuote ?? '1000'),
    fetchedAt: baselineAt,
  });
  const executionId = repository.createExecution({
    strategy: 'S1',
    batchId,
    status: 'SAFE_STOP',
    plannedNotional: new Decimal(5),
    expectedProfit: new Decimal('0.01'),
    openedAt: baselineAt + 1000,
  });
  repository.recordUnhedgedInventory({
    executionId,
    batchId,
    venueId: 'bitget',
    asset: 'WARD',
    amount: new Decimal(1000),
    usdValue: new Decimal(4),
    direction: options.direction ?? 'long',
    reason: 'leg2_partial_fill',
    createdAt: now - 1000,
  });
  repository.setSetting('kill_switch', 'true', now);
  repository.setSetting('live_enabled', 'true', now);
  repository.setSetting('auto_execution_enabled', 'true', now);
  const gate = fakeVenue({
    venueId: 'gateio',
    bid: '0.0050',
    before: balances('gateio', options.gateWard ?? '0', '1000'),
  });
  const bitget = fakeVenue({
    venueId: 'bitget',
    bid: options.bid ?? '0.0055',
    ...(options.ask ? { ask: options.ask } : {}),
    before: balances(
      'bitget',
      options.currentWard ?? '2000',
      options.currentQuote ?? '996',
      options.bitgetFreeWard,
    ),
    after: balances('bitget', options.afterWard ?? '1000', options.afterQuote ?? '1001.4945'),
    ...(options.createError ? { createError: options.createError } : {}),
  });
  const adapters: Record<string, RecoveryVenue> = {
    gateio: { adapter: gate.adapter, credentials },
    bitget: { adapter: bitget.adapter, credentials },
  };
  const config = {
    liveEnabled: true,
    orderbookDepth: 20,
    fokVenues: ['bitget'],
    feeOverrides: {},
    settings: { maxOrderbookAgeMs: 60_000 },
    autoRotation: {
      pairs: [
        { base: 'WARD', quote: 'USDT', maxNotional: new Decimal(10), venues: ['gateio', 'bitget'] },
      ],
      residualHedge: {
        enabled: true,
        maxLossUsd: new Decimal('0.05'),
        maxBaselineAgeMs: 60_000,
      },
    },
  } as unknown as ExecutorConfig;
  return { repository, adapters, config, bitget, gate };
}

describe('automatic residual hedge', () => {
  it('flattens a confirmed long residual and leaves the kill switch on', async () => {
    const { repository, adapters, config, bitget } = setup();
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result.status).toBe('HEDGED');
    expect(result.attempted).toBe(true);
    expect(result.realizedProfit?.toFixed()).toBe('1.4945');
    expect(bitget.requests).toHaveLength(1);
    expect(bitget.requests[0]).toMatchObject({ side: 'sell', timeInForce: 'FOK' });
    expect(repository.openUnhedgedInventory()).toEqual([]);
    expect(repository.getSetting('kill_switch')).toBe('true');
    const original = repository.db
      .prepare('SELECT status, closed_at FROM executions WHERE batch_id = ?')
      .get(batchId) as { status: string; closed_at: number | null };
    expect(original).toMatchObject({ status: 'RECONCILED' });
    expect(original.closed_at).not.toBeNull();
    const audit = repository.db
      .prepare(
        `SELECT actor FROM audit_logs WHERE action = 'residual_hedged' ORDER BY id DESC LIMIT 1`,
      )
      .get() as { actor: string };
    expect(audit.actor).toBe('executor');
  });

  it('does not submit when the projected loss exceeds the configured cap', async () => {
    const { repository, adapters, config, bitget } = setup({ currentQuote: '980' });
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result).toMatchObject({
      status: 'BLOCKED',
      attempted: false,
      reasons: ['no_fok_hedge_candidate_within_limits'],
    });
    expect(bitget.requests).toEqual([]);
    expect(repository.openUnhedgedInventory()).toHaveLength(1);
    expect(repository.getSetting('kill_switch')).toBe('true');
  });

  it('buys back a confirmed short residual and reconciles the original execution', async () => {
    const { repository, adapters, config, bitget } = setup({
      direction: 'short',
      baselineWard: '1000',
      baselineQuote: '1000',
      currentWard: '0',
      currentQuote: '1005',
      afterWard: '1000.00899',
      afterQuote: '1000.095051',
      ask: '0.0049',
      bid: '0.0048',
    });
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result.status).toBe('HEDGED');
    expect(result.attempted).toBe(true);
    expect(result.realizedProfit?.toFixed()).toBe('0.09509595');
    expect(bitget.requests).toHaveLength(1);
    expect(bitget.requests[0]).toMatchObject({ side: 'buy', timeInForce: 'FOK' });
    expect(repository.openUnhedgedInventory()).toEqual([]);
    const original = repository.db
      .prepare('SELECT status, closed_at FROM executions WHERE batch_id = ?')
      .get(batchId) as { status: string; closed_at: number | null };
    expect(original).toMatchObject({ status: 'RECONCILED' });
    expect(original.closed_at).not.toBeNull();
    const hedge = repository.db
      .prepare(
        "SELECT inventory_delta_json, metadata_json FROM executions WHERE strategy='HEDGE' ORDER BY id DESC LIMIT 1",
      )
      .get() as { inventory_delta_json: string; metadata_json: string };
    expect(JSON.parse(hedge.inventory_delta_json)).toMatchObject({
      baseDelta: '1000.00899',
      quoteDelta: '-4.904949',
    });
    expect(JSON.parse(hedge.metadata_json)).toMatchObject({ direction: 'short' });
  });

  it('does not buy back a short when the projected loss exceeds the cap', async () => {
    const { repository, adapters, config, bitget } = setup({
      direction: 'short',
      baselineWard: '1000',
      baselineQuote: '1000',
      currentWard: '0',
      currentQuote: '1005',
      ask: '0.006',
    });
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result).toMatchObject({
      status: 'BLOCKED',
      attempted: false,
      reasons: ['no_fok_hedge_candidate_within_limits'],
    });
    expect(bitget.requests).toEqual([]);
    expect(repository.openUnhedgedInventory()).toHaveLength(1);
  });

  it('never sells unrelated inventory on the other venue', async () => {
    const { repository, adapters, config, bitget, gate } = setup({
      bitgetFreeWard: '0',
      gateWard: '5000',
    });
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result).toMatchObject({
      status: 'BLOCKED',
      attempted: false,
      reasons: ['residual_base_not_available'],
    });
    expect(bitget.requests).toEqual([]);
    expect(gate.requests).toEqual([]);
    expect(repository.openUnhedgedInventory()).toHaveLength(1);
  });

  it('does not submit when persisted automatic execution is disabled', async () => {
    const { repository, adapters, config, bitget } = setup();
    repository.setSetting('auto_execution_enabled', 'false', Date.now());
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result).toMatchObject({
      status: 'BLOCKED',
      attempted: false,
      reasons: ['persisted_automatic_execution_disabled'],
    });
    expect(bitget.requests).toEqual([]);
  });

  it('never retries an ambiguous hedge submission', async () => {
    const { repository, adapters, config, bitget } = setup({
      createError: new Error('network timeout'),
    });
    const result = await attemptAutomaticResidualHedge({
      repository,
      config,
      adapters,
      batchId,
    });
    expect(result).toMatchObject({
      status: 'BLOCKED',
      attempted: true,
      reasons: ['hedge_submission_unknown'],
    });
    expect(bitget.requests).toHaveLength(1);
    expect(repository.openUnhedgedInventory()).toHaveLength(1);
    expect(repository.getSetting('kill_switch')).toBe('true');
    expect(repository.countUnresolvedOrders()).toBe(1);
  });
});
