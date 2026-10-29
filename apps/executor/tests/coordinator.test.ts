import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  ExecutionGate,
  evaluateS1Direction,
  evaluateS1Preparation,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
  type OpportunityResult,
  type RiskLimits,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, BalanceSnapshot, CexAdapter, OrderState } from '@arb/venues-cex';
import {
  CexLiveExecutor,
  type ExecutionVenue,
  type LiveExecutionRequest,
} from '../src/coordinator.js';

const now = 1_700_000_000_000;
const keys: ApiCredentials = { apiKey: 'test', secret: 'test' };
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};
const limits: RiskLimits = {
  maxOrderNotional: new Decimal(30),
  dailyMaxLoss: new Decimal(20),
  maxOpenBatches: 1,
  minNetProfitBps: new Decimal(20),
  maxStaleOrderbookMs: 3000,
  maxSlippageBps: new Decimal(50),
  killSwitchDefault: false,
};

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
    minAmount: new Decimal('0.01'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal('10'),
    supportsIoc: true,
  };
}

function fokMarket(venueId: string): MarketMetadata {
  return { ...market(venueId), supportsIoc: false, supportsFok: true };
}

function book(venueId: string, ask: string, bid: string, fetchedAt = now): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    source: 'replay',
  };
}

function opportunity(): OpportunityResult {
  return evaluateS1Direction({
    base: 'CAKE',
    quote: 'USDT',
    buyMarket: market('gateio'),
    sellMarket: market('mexc'),
    buyBook: book('gateio', '2.500', '2.490'),
    sellBook: book('mexc', '2.560', '2.550'),
    requestedNotional: new Decimal(30),
    settings,
    now,
    venueHealth: { gateio: 'A', mexc: 'A' },
  });
}

function balances(venueId: string, baseFree = new Decimal(100)): BalanceSnapshot[] {
  return [
    {
      venueId,
      accountId: 'default',
      currency: 'USDT',
      free: new Decimal(100),
      used: new Decimal(0),
      total: new Decimal(100),
      fetchedAt: now,
    },
    {
      venueId,
      accountId: 'default',
      currency: 'CAKE',
      free: baseFree,
      used: new Decimal(0),
      total: baseFree,
      fetchedAt: now,
    },
  ];
}

interface FakeOptions {
  createError?: Error;
  createErrorSide?: 'buy' | 'sell';
  leg1FillRatio?: Decimal;
  leg2FillRatio?: Decimal;
  leg1PartialOpen?: boolean;
  leg2PartialOpen?: boolean;
  cancelError?: Error;
  cancelStaysOpen?: boolean;
  queryUnknown?: boolean;
  queryUnknownSide?: 'buy' | 'sell';
  queryNotFound?: boolean;
  queryNotFoundSide?: 'buy' | 'sell';
  queryNotFoundError?: Error;
  balanceAfterCreate?: (venueId: string) => BalanceSnapshot[];
  baseFree?: Decimal;
  onFetchBook?: () => void;
  bookFetchedAt?: () => number;
  bookQuote?: (venueId: string, call: number) => { ask: string; bid: string };
  createDelayMs?: number;
  concurrency?: { active: number; max: number };
  orderFeeRate?: Decimal;
  openOrders?: OrderState[];
  openOrdersError?: Error;
  sellAmountTransform?: (amount: Decimal) => Decimal;
}

function fakeAdapter(venueId: string, options: FakeOptions = {}) {
  const state = {
    createCalls: 0,
    fetchBookCalls: 0,
    cancelCalls: 0,
    canceled: false,
    createSides: [] as Array<'buy' | 'sell'>,
    createdAmounts: { buy: new Decimal(12), sell: new Decimal(12) },
  };
  const orderFor = (
    isBuy: boolean,
    amount: Decimal,
    clientOrderId: string | undefined,
    status: OrderState['status'],
  ): OrderState => {
    const ratio = isBuy
      ? (options.leg1FillRatio ?? new Decimal(1))
      : (options.leg2FillRatio ?? new Decimal(1));
    const price = isBuy ? new Decimal('2.5') : new Decimal('2.55');
    const filled = amount.mul(ratio);
    return {
      venueOrderId: isBuy ? 'order-1' : 'order-2',
      ...(clientOrderId ? { clientOrderId } : {}),
      symbol: 'CAKE/USDT',
      side: isBuy ? 'buy' : 'sell',
      type: 'limit',
      price,
      amount,
      filled,
      remaining: amount.minus(filled),
      averagePrice: price,
      fee: filled.mul(price).mul(options.orderFeeRate ?? new Decimal('0.001')),
      status,
      raw: { fake: true },
    };
  };
  const adapter: CexAdapter = {
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
      state.fetchBookCalls += 1;
      options.onFetchBook?.();
      const fetchedAt = options.bookFetchedAt?.() ?? now;
      const quote = options.bookQuote?.(venueId, state.fetchBookCalls);
      if (quote) return book(venueId, quote.ask, quote.bid, fetchedAt);
      return venueId === 'gateio'
        ? book(venueId, '2.500', '2.490', fetchedAt)
        : book(venueId, '2.560', '2.550', fetchedAt);
    },
    fetchBalances: async () =>
      options.balanceAfterCreate && state.createCalls > 0
        ? options.balanceAfterCreate(venueId)
        : balances(venueId, options.baseFree),
    createOrder: async (request) => {
      state.createCalls += 1;
      state.createSides.push(request.side);
      const orderAmount =
        request.side === 'sell' && options.sellAmountTransform
          ? options.sellAmountTransform(request.amount)
          : request.amount;
      state.createdAmounts[request.side] = orderAmount;
      if (options.concurrency) {
        options.concurrency.active += 1;
        options.concurrency.max = Math.max(options.concurrency.max, options.concurrency.active);
      }
      try {
        if (options.createDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.createDelayMs));
        }
      } finally {
        if (options.concurrency) options.concurrency.active -= 1;
      }
      if (
        options.createError &&
        (!options.createErrorSide ||
          (options.createErrorSide === 'buy') === (request.side === 'buy'))
      ) {
        throw options.createError;
      }
      const ratio =
        request.side === 'buy'
          ? (options.leg1FillRatio ?? new Decimal(1))
          : (options.leg2FillRatio ?? new Decimal(1));
      const partialOpen =
        request.side === 'buy' ? options.leg1PartialOpen : options.leg2PartialOpen;
      return orderFor(
        request.side === 'buy',
        orderAmount,
        request.clientOrderId,
        ratio.eq(1) ? 'closed' : partialOpen ? 'open' : 'canceled',
      );
    },
    fetchOrder: async (request) => {
      const isBuy = request.clientOrderId?.endsWith('-L1') ?? true;
      if (
        options.queryNotFound &&
        options.queryNotFoundError &&
        (!options.queryNotFoundSide || (options.queryNotFoundSide === 'buy') === isBuy)
      ) {
        throw options.queryNotFoundError;
      }
      if (
        options.queryNotFound &&
        (!options.queryNotFoundSide || (options.queryNotFoundSide === 'buy') === isBuy)
      ) {
        throw new Error('Hotcoin API 40010: 委单不存在，请确认AccessKeyId或id是否正确');
      }
      if (
        options.queryUnknown &&
        (!options.queryUnknownSide || (options.queryUnknownSide === 'buy') === isBuy)
      ) {
        throw new Error('query timeout');
      }
      const ratio = isBuy
        ? (options.leg1FillRatio ?? new Decimal(1))
        : (options.leg2FillRatio ?? new Decimal(1));
      const partialOpen = isBuy ? options.leg1PartialOpen : options.leg2PartialOpen;
      return orderFor(
        isBuy,
        state.createdAmounts[isBuy ? 'buy' : 'sell'],
        request.clientOrderId,
        ratio.eq(1) ? 'closed' : state.canceled || !partialOpen ? 'canceled' : 'open',
      );
    },
    fetchOpenOrders: async () => {
      if (options.openOrdersError) throw options.openOrdersError;
      return options.openOrders ?? [];
    },
    cancelOrder: async (request) => {
      state.cancelCalls += 1;
      if (options.cancelError) throw options.cancelError;
      if (!options.cancelStaysOpen) state.canceled = true;
      const isBuy = request.clientOrderId?.endsWith('-L1') ?? true;
      return orderFor(
        isBuy,
        state.createdAmounts[isBuy ? 'buy' : 'sell'],
        request.clientOrderId,
        options.cancelStaysOpen ? 'open' : 'canceled',
      );
    },
  };
  return { adapter, state };
}

function setup(options: FakeOptions = {}, legMode: 'serial' | 'parallel_fok' = 'serial') {
  const db = openDatabase(':memory:');
  const repo = new ArbitrageRepository(db);
  repo.upsertVenue({
    id: 'gateio',
    type: 'cex',
    name: 'Gate.io',
    tier: 'S',
    executionEnabled: true,
    now,
  });
  repo.upsertVenue({
    id: 'mexc',
    type: 'cex',
    name: 'MEXC',
    tier: 'S',
    executionEnabled: true,
    now,
  });
  repo.setSetting('kill_switch', 'false', now);
  const buy = fakeAdapter('gateio', options);
  const sell = fakeAdapter('mexc', options);
  const gate = new ExecutionGate(limits);
  const executor = new CexLiveExecutor({
    repository: repo,
    gate,
    limits,
    liveEnabled: true,
    legMode,
    settings,
    sleep: async () => {},
    clock: () => now,
  });
  return { db, repo, buy, sell, gate, executor };
}

function request(
  buy: ExecutionVenue,
  sell: ExecutionVenue,
  batchId = 'exec-batch',
): LiveExecutionRequest {
  return {
    batchId,
    opportunity: opportunity(),
    buy,
    sell,
    confirmedBatchId: batchId,
  };
}

describe('live executor safety gates', () => {
  it('does not touch an adapter when live execution is disabled', async () => {
    const { repo, buy, sell } = setup();
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: false,
      settings,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('BLOCKED');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('blocks before venue APIs when the persisted kill switch is on', async () => {
    const { repo, buy, sell } = setup();
    repo.setSetting('kill_switch', 'true', now);
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('persisted_kill_switch_on');
    expect(buy.state.fetchBookCalls).toBe(0);
    expect(sell.state.fetchBookCalls).toBe(0);
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('requires execution_enabled for both venues before any venue request', async () => {
    const { repo, buy, sell } = setup();
    repo.upsertVenue({
      id: 'mexc',
      type: 'cex',
      name: 'MEXC',
      tier: 'S',
      executionEnabled: false,
      now,
    });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('venue_execution_disabled');
    expect(buy.state.fetchBookCalls).toBe(0);
    expect(sell.state.fetchBookCalls).toBe(0);
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('closes a fully reconciled two-leg batch exactly once', async () => {
    const { repo, buy, sell } = setup();
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(result.ordersSubmitted).toBe(2);
    expect(result.realizedProfit?.gt(0)).toBe(true);
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(1);
    expect(repo.countOpenExecutions()).toBe(0);
    repo.close();
  });

  it('safe-stops before submission when the exchange reports an external open order', async () => {
    const external: OrderState = {
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
      raw: { source: 'manual' },
    };
    const { repo, buy, sell } = setup({ openOrders: [external] });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons).toContain('open_orders_present');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });

  it('fails preflight when open-order verification fails', async () => {
    const { repo, buy, sell } = setup({ openOrdersError: new Error('query timeout') });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('PREFLIGHT_FAILED');
    expect(result.reasons.some((reason) => reason.startsWith('open_orders_fetch_failed'))).toBe(
      true,
    );
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('executes a bounded negative-edge preparation as PREP', async () => {
    const { db, repo, buy, sell } = setup({
      bookQuote: (venueId) =>
        venueId === 'gateio' ? { ask: '2.500', bid: '2.490' } : { ask: '2.510', bid: '2.4995' },
      orderFeeRate: new Decimal('0.0001'),
    });
    const prepBuyMarket = {
      ...market('gateio'),
      feeTakerBps: new Decimal('1'),
      priceStep: new Decimal('0.0001'),
    };
    const prepSellMarket = {
      ...market('mexc'),
      feeTakerBps: new Decimal('1'),
      priceStep: new Decimal('0.0001'),
    };
    const prepSettings = {
      ...settings,
      minProfitUsd: new Decimal(0),
      safetyBufferBps: new Decimal(0),
      minNetProfitBps: new Decimal(0),
    };
    const opportunity = evaluateS1Preparation(
      {
        base: 'CAKE',
        quote: 'USDT',
        buyMarket: prepBuyMarket,
        sellMarket: prepSellMarket,
        buyBook: book('gateio', '2.500', '2.490'),
        sellBook: book('mexc', '2.510', '2.4995'),
        requestedNotional: new Decimal('10'),
        settings: prepSettings,
        now,
        venueHealth: { gateio: 'A', mexc: 'A' },
      },
      { maxCostBps: new Decimal('5'), maxCostUsd: new Decimal('0.01') },
    );
    expect(opportunity.valid).toBe(true);
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute({
      batchId: 'prep-batch',
      opportunity,
      buy: { adapter: buy.adapter, market: prepBuyMarket, credentials: keys, healthState: 'A' },
      sell: { adapter: sell.adapter, market: prepSellMarket, credentials: keys, healthState: 'A' },
      confirmedBatchId: 'prep-batch',
      intent: 'inventory_preparation',
      preparation: { maxCostBps: new Decimal('5'), maxCostUsd: new Decimal('0.01') },
    });
    expect(result.outcome).toBe('CLOSED');
    const row = db
      .prepare('SELECT strategy, status FROM executions WHERE batch_id = ?')
      .get('prep-batch') as { strategy: string; status: string };
    expect(row).toMatchObject({ strategy: 'PREP', status: 'CLOSED' });
    repo.close();
  });

  it('treats explicitly configured zero taker fees as configured', async () => {
    const zeroBuyMarket = { ...market('gateio'), feeTakerBps: new Decimal(0) };
    const zeroSellMarket = { ...market('mexc'), feeTakerBps: new Decimal(0) };
    const zeroOpportunity = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: zeroBuyMarket,
      sellMarket: zeroSellMarket,
      buyBook: book('gateio', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal(30),
      settings,
      now,
      venueHealth: { gateio: 'A', mexc: 'A' },
    });
    expect(zeroOpportunity.valid).toBe(true);

    const { repo, buy, sell } = setup();
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute({
      ...request(
        {
          adapter: buy.adapter,
          market: zeroBuyMarket,
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: zeroSellMarket,
          credentials: keys,
          healthState: 'A',
        },
        'exec-zero-fee',
      ),
      opportunity: zeroOpportunity,
    });
    expect(result.outcome).toBe('CLOSED');
    expect(result.ordersSubmitted).toBe(2);
    repo.close();
  });

  it('enters safe mode on an unknown submission and never retries', async () => {
    const { db, repo, buy, sell } = setup({
      createError: new Error('socket hang up'),
      queryUnknown: true,
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.states).toContain('SAFE_STOP');
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(0);
    const execution = db
      .prepare('SELECT status, metadata_json FROM executions WHERE batch_id = ?')
      .get('exec-batch') as { status: string; metadata_json: string };
    expect(execution.status).toBe('SAFE_STOP');
    const metadata = JSON.parse(execution.metadata_json) as { states: string[] };
    expect(metadata.states).toContain('LEG1_UNKNOWN');
    expect(metadata.states).not.toContain('LEG1_RECONCILING');
    const legs = db
      .prepare('SELECT leg_number, status FROM execution_legs ORDER BY leg_number')
      .all() as Array<{ leg_number: number; status: string }>;
    expect(legs).toEqual([
      { leg_number: 1, status: 'unknown' },
      { leg_number: 2, status: 'planned' },
    ]);
    const events = db.prepare('SELECT event_type FROM order_events ORDER BY id').all() as Array<{
      event_type: string;
    }>;
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['submission_request', 'submission_error', 'reconcile_query_1_error']),
    );
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });

  it('persists an unknown second-leg submission without retrying or resubmitting', async () => {
    const { db, repo, buy, sell } = setup({
      createError: new Error('socket hang up'),
      createErrorSide: 'sell',
      queryUnknown: true,
      queryUnknownSide: 'sell',
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.ordersSubmitted).toBe(2);
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(1);

    const execution = db
      .prepare('SELECT status, metadata_json FROM executions WHERE batch_id = ?')
      .get('exec-batch') as { status: string; metadata_json: string };
    expect(execution.status).toBe('SAFE_STOP');
    const metadata = JSON.parse(execution.metadata_json) as { states: string[] };
    expect(metadata.states).toContain('LEG2_UNKNOWN');
    expect(metadata.states).not.toContain('LEG2_RECONCILING');
    expect(metadata.states.indexOf('LEG2_UNKNOWN')).toBeGreaterThan(
      metadata.states.indexOf('LEG2_SUBMITTING'),
    );

    const legs = db
      .prepare('SELECT leg_number, status FROM execution_legs ORDER BY leg_number')
      .all() as Array<{ leg_number: number; status: string }>;
    expect(legs).toEqual([
      { leg_number: 1, status: 'filled' },
      { leg_number: 2, status: 'unknown' },
    ]);
    const riskEvents = db.prepare('SELECT rule FROM risk_events ORDER BY id').all() as Array<{
      rule: string;
    }>;
    expect(riskEvents.map((event) => event.rule)).toEqual(
      expect.arrayContaining(['unhedged_inventory', 'execution_safe_stop']),
    );
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });

  it('closes cleanly when Gate explicitly rejects an unfilled FOK order', async () => {
    const { repo, buy, sell } = setup({
      createError: new Error('gate FOK_NOT_FILL: Order cannot be filled completely'),
    });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(result.reasons).not.toContain('ambiguous_leg1_submission');
    expect(repo.getSetting('kill_switch')).toBe('false');
    repo.close();
  });

  it('closes cleanly when Hotcoin omits an unfilled FOK order and balances are unchanged', async () => {
    const { repo, buy, sell } = setup({
      leg1FillRatio: new Decimal(0),
      leg1PartialOpen: true,
      queryNotFound: true,
    });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(repo.getSetting('kill_switch')).toBe('false');
    repo.close();
  });

  it('safe-stops when a missing IOC/FOK order cannot be confirmed as zero-fill', async () => {
    const { repo, buy, sell } = setup({
      leg1FillRatio: new Decimal(0),
      leg1PartialOpen: true,
      queryNotFound: true,
      balanceAfterCreate: (venueId) => balances(venueId, new Decimal(101)),
    });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons).toContain('leg1_not_found_balance_changed');
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });

  it('cancels the remaining first-leg quantity and hedges only the actual fill', async () => {
    const { repo, buy, sell } = setup({
      leg1FillRatio: new Decimal('0.5'),
      leg1PartialOpen: true,
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(result.states).toContain('LEG1_PARTIAL');
    expect(buy.state.cancelCalls).toBe(1);
    expect(sell.state.createCalls).toBe(1);
    expect(repo.openUnhedgedInventory()).toHaveLength(0);
    repo.close();
  });

  it('records inventory left behind by second-leg precision rounding', async () => {
    const { repo, buy, sell } = setup({ leg1FillRatio: new Decimal('0.9999') });
    const result = await new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    }).execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
        'exec-precision-residual',
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(repo.openUnhedgedInventory()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          batch_id: 'exec-precision-residual',
          reason: 'leg2_precision_residual',
        }),
      ]),
    );
    repo.close();
  });

  it('blocks mismatched instruments before touching venue APIs', async () => {
    const { repo, buy, sell } = setup();
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: {
            ...market('gateio'),
            base: 'ETH',
            exchangeSymbol: 'ETH/USDT',
            unifiedSymbol: 'ETH/USDT',
          },
          credentials: keys,
          healthState: 'A',
        },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('route_mismatch');
    expect(buy.state.fetchBookCalls).toBe(0);
    expect(buy.state.createCalls).toBe(0);
    repo.close();
  });

  it('rejects refreshed books whose worst price is off the venue tick grid', async () => {
    const { repo, buy, sell } = setup({
      bookQuote: (venueId) =>
        venueId === 'gateio' ? { ask: '2.5001', bid: '2.490' } : { ask: '2.560', bid: '2.550' },
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('PREFLIGHT_FAILED');
    expect(result.reasons).toContain('price_precision_invalid');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('stops safely when the hedge book price is off-grid after leg one fills', async () => {
    const { repo, buy, sell } = setup({
      bookQuote: (venueId, call) =>
        venueId === 'gateio'
          ? { ask: '2.500', bid: '2.490' }
          : call === 1
            ? { ask: '2.560', bid: '2.550' }
            : { ask: '2.560', bid: '2.5501' },
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons).toContain('leg2_price_precision_invalid');
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(0);
    expect(repo.openUnhedgedInventory()).toHaveLength(1);
    repo.close();
  });

  it('rejects preflight when either venue cannot use IOC or FOK', async () => {
    const { repo, buy, sell } = setup();
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        {
          adapter: sell.adapter,
          market: { ...market('mexc'), supportsIoc: false, supportsFok: false },
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('PREFLIGHT_FAILED');
    expect(result.reasons).toContain('ioc_or_fok_unsupported');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('accepts delayed fresh books using the post-fetch clock', async () => {
    let current = now;
    const { repo, buy, sell } = setup({
      onFetchBook: () => {
        current += 1000;
      },
      bookFetchedAt: () => current,
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => current,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(result.reasons).toEqual([]);
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(1);
    repo.close();
  });

  it('checks balances against refreshed depth rather than the stale opportunity', async () => {
    const { repo, buy, sell } = setup({ baseFree: new Decimal(5) });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const stale = request(
      { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
      { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
    );
    const staleDepth = stale.opportunity.buyDepth!;
    expect(staleDepth.executableBaseAmount.gt(5)).toBe(true);
    stale.opportunity = {
      ...stale.opportunity,
      buyDepth: { ...staleDepth, executableBaseAmount: new Decimal(1) },
    };
    const result = await executor.execute(stale);
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons).toContain('sell_base_balance_insufficient');
    expect(result.states).toContain('BALANCE_MISMATCH');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('blocks before venue APIs when cancel capability is not verified', async () => {
    const { repo, buy, sell } = setup();
    buy.adapter.capabilities.cancelOrder = false;
    delete buy.adapter.cancelOrder;
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('venue_execution_capability_missing');
    expect(buy.state.fetchBookCalls).toBe(0);
    expect(buy.state.createCalls).toBe(0);
    repo.close();
  });

  it('records unhedged inventory when the first-leg cancel cannot be confirmed', async () => {
    const { repo, buy, sell } = setup({
      leg1FillRatio: new Decimal('0.5'),
      leg1PartialOpen: true,
      cancelError: new Error('cancel timeout'),
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.states).toContain('LEG1_PARTIAL');
    expect(buy.state.cancelCalls).toBe(1);
    expect(sell.state.createCalls).toBe(0);
    const open = repo.openUnhedgedInventory();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ asset: 'CAKE', amount: '6', status: 'open' });
    expect(repo.riskSnapshot(now).unhedgedInventoryRisk.gt(0)).toBe(true);
    repo.close();
  });

  it('cancels a partial second leg and records the unhedged remainder without rebuilding it', async () => {
    const { repo, buy, sell } = setup({
      leg2FillRatio: new Decimal('0.5'),
      leg2PartialOpen: true,
    });
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.states).toContain('LEG2_PARTIAL');
    expect(sell.state.cancelCalls).toBe(1);
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(1);
    const open = repo.openUnhedgedInventory();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ asset: 'CAKE', amount: '6', status: 'open' });
    repo.close();
  });

  it('persists order requests, live query responses and reconciliation events', async () => {
    const { db, repo, buy, sell } = setup();
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    const events = db
      .prepare(
        `SELECT o.client_order_id AS client_order_id, e.event_type AS event_type,
                e.raw_response AS raw_response
         FROM order_events e JOIN orders o ON o.id = e.order_id
         ORDER BY e.id`,
      )
      .all() as Array<{ client_order_id: string; event_type: string; raw_response: string }>;
    for (const clientOrderId of ['exec-batch-L1', 'exec-batch-L2']) {
      const types = events
        .filter((event) => event.client_order_id === clientOrderId)
        .map((event) => event.event_type);
      expect(types).toEqual(
        expect.arrayContaining(['submission_request', 'submission_response', 'reconcile_query_1']),
      );
    }
    expect(events.some((event) => event.raw_response.includes('"fake":true'))).toBe(true);
    repo.close();
  });

  it('persists the execution audit chain and links every order to its execution', async () => {
    const { db, repo, buy, sell } = setup();
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const executionRequest = {
      ...request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
      opportunityId: 42,
    };
    const result = await executor.execute(executionRequest);
    expect(result.outcome).toBe('CLOSED');
    const execution = db
      .prepare(
        `SELECT id, opportunity_id, status, preflight_json, gross_spread, fees,
                latency_ms, inventory_delta_json, metadata_json
         FROM executions WHERE batch_id = ?`,
      )
      .get('exec-batch') as Record<string, string | number | null>;
    expect(execution.opportunity_id).toBe(42);
    expect(execution.status).toBe('CLOSED');
    expect(execution.gross_spread).not.toBeNull();
    expect(execution.fees).not.toBeNull();
    expect(execution.latency_ms).not.toBeNull();
    expect(JSON.parse(String(execution.preflight_json))).toMatchObject({
      strategy: 'S1',
      orderbooks: { buy: { venueId: 'gateio' }, sell: { venueId: 'mexc' } },
    });
    expect(JSON.parse(String(execution.inventory_delta_json))).toMatchObject({
      baseAsset: 'CAKE',
      baseDelta: '0',
      quoteAsset: 'USDT',
    });
    expect(JSON.parse(String(execution.metadata_json))).toMatchObject({
      outcome: 'CLOSED',
      states: expect.arrayContaining(['LEG1_SUBMITTING', 'LEG2_SUBMITTING', 'CLOSED']),
    });
    const confirmation = db
      .prepare("SELECT context_json FROM audit_logs WHERE action = 'manual_batch_confirmation'")
      .get() as { context_json: string } | undefined;
    expect(confirmation).toBeDefined();
    expect(JSON.parse(confirmation!.context_json)).toMatchObject({
      batchId: 'exec-batch',
      confirmedBatchId: 'exec-batch',
      opportunityId: 42,
    });
    const orders = db
      .prepare('SELECT execution_id FROM orders WHERE client_order_id LIKE ?')
      .all('exec-batch-%') as Array<{ execution_id: number }>;
    expect(orders).toHaveLength(2);
    expect(orders.every((order) => order.execution_id === execution.id)).toBe(true);
    repo.close();
  });

  it('restores persisted risk counters and blocks a new batch', async () => {
    const { repo, buy, sell } = setup();
    repo.addRealizedLoss(new Decimal(20), now);
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('PREFLIGHT_FAILED');
    expect(result.reasons).toContain('daily_loss_limit_reached');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('turns a persisted balance mismatch into safe mode', async () => {
    const { repo, buy, sell } = setup();
    repo.setSetting('balance_mismatch', 'true', now);
    const executor = new CexLiveExecutor({
      repository: repo,
      gate: new ExecutionGate(limits),
      limits,
      liveEnabled: true,
      settings,
      sleep: async () => {},
      clock: () => now,
    });
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.states).toContain('BALANCE_MISMATCH');
    expect(buy.state.fetchBookCalls).toBe(0);
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });
});

describe('parallel FOK two-leg execution', () => {
  it('fails preflight unless both venues explicitly support FOK', async () => {
    const { repo, executor, buy, sell } = setup({}, 'parallel_fok');
    const result = await executor.execute(
      request(
        { adapter: buy.adapter, market: market('gateio'), credentials: keys, healthState: 'A' },
        { adapter: sell.adapter, market: market('mexc'), credentials: keys, healthState: 'A' },
      ),
    );
    expect(result.outcome).toBe('PREFLIGHT_FAILED');
    expect(result.reasons).toContain('parallel_fok_unsupported');
    expect(buy.state.createCalls).toBe(0);
    expect(sell.state.createCalls).toBe(0);
    repo.close();
  });

  it('submits both FOK legs concurrently and closes when quantities match', async () => {
    const concurrency = { active: 0, max: 0 };
    const { db, repo, executor, buy, sell } = setup(
      { createDelayMs: 5, concurrency },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(result.ordersSubmitted).toBe(2);
    expect(result.states).toEqual(
      expect.arrayContaining(['PARALLEL_SUBMITTING', 'PARALLEL_RECONCILING', 'CLOSED']),
    );
    expect(concurrency.max).toBe(2);
    expect(buy.state.createSides).toEqual(['buy']);
    expect(sell.state.createSides).toEqual(['sell']);
    expect(repo.openUnhedgedInventory()).toHaveLength(0);
    expect(repo.getSetting('kill_switch')).toBe('false');
    const execution = db
      .prepare('SELECT status, metadata_json FROM executions WHERE batch_id = ?')
      .get('exec-batch') as { status: string; metadata_json: string };
    expect(execution.status).toBe('CLOSED');
    expect(JSON.parse(execution.metadata_json)).toMatchObject({
      mode: 'parallel_fok',
      outcome: 'CLOSED',
    });
    repo.close();
  });

  it('treats a dust fill mismatch within one venue step / 10 bps as closed', async () => {
    const { db, repo, executor, buy, sell } = setup(
      { sellAmountTransform: (amount) => amount.minus('0.01') },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('CLOSED');
    expect(repo.openUnhedgedInventory()).toHaveLength(0);
    expect(repo.getSetting('kill_switch')).toBe('false');
    expect(repo.listRiskEvents(10).some((event) => event.rule === 'parallel_fill_dust')).toBe(true);
    const execution = db
      .prepare('SELECT metadata_json FROM executions WHERE batch_id = ?')
      .get('exec-batch') as { metadata_json: string };
    expect(JSON.parse(execution.metadata_json)).toMatchObject({
      fillMismatchCanonical: '0.01',
      fillMismatchToleranceCanonical: '0.012',
    });
    repo.close();
  });

  it('treats Gate CLIENT_ID_NOT_FOUND as a confirmed zero-fill rejection', async () => {
    const { repo, executor, buy, sell } = setup(
      {
        leg1FillRatio: new Decimal(0),
        leg2FillRatio: new Decimal(0),
        queryNotFound: true,
        queryNotFoundSide: 'buy',
        queryNotFoundError: new Error('OrderNotFound: gate CLIENT_ID_NOT_FOUND'),
      },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('PARALLEL_REJECTED');
    expect(repo.getSetting('kill_switch')).toBe('false');
    expect(repo.openUnhedgedInventory()).toHaveLength(0);
    repo.close();
  });

  it('still sends the other leg when one submission throws and records the inventory shortfall', async () => {
    const concurrency = { active: 0, max: 0 };
    const { repo, executor, buy, sell } = setup(
      {
        createDelayMs: 5,
        concurrency,
        createError: new Error('buy submit timeout'),
        createErrorSide: 'buy',
        leg1FillRatio: new Decimal(0),
      },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons).toContain('parallel_leg_not_fully_filled');
    expect(concurrency.max).toBe(2);
    expect(buy.state.createCalls).toBe(1);
    expect(sell.state.createCalls).toBe(1);
    expect(repo.openUnhedgedInventory()).toHaveLength(1);
    expect(repo.openUnhedgedInventory()[0]).toMatchObject({
      venue_id: 'mexc',
      asset: 'CAKE',
      amount: '12',
      direction: 'short',
      reason: 'parallel_incomplete_fill_inventory_shortfall',
    });
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });

  it('cancels an open partial parallel leg and records the long residual', async () => {
    const { repo, executor, buy, sell } = setup(
      {
        leg1FillRatio: new Decimal('0.75'),
        leg1PartialOpen: true,
        leg2FillRatio: new Decimal('0.5'),
      },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons).toContain('parallel_leg_not_fully_filled');
    expect(buy.state.cancelCalls).toBe(1);
    expect(sell.state.cancelCalls).toBe(0);
    expect(repo.openUnhedgedInventory()[0]).toMatchObject({
      venue_id: 'gateio',
      asset: 'CAKE',
      amount: '3',
      direction: 'long',
      reason: 'parallel_incomplete_fill_long',
    });
    repo.close();
  });

  it('records a terminal rejection when neither FOK leg fills', async () => {
    const { repo, executor, buy, sell } = setup(
      {
        leg1FillRatio: new Decimal(0),
        leg2FillRatio: new Decimal(0),
      },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('PARALLEL_REJECTED');
    expect(result.states).toContain('PARALLEL_REJECTED');
    expect(repo.countOpenExecutions()).toBe(0);
    expect(repo.openUnhedgedInventory()).toHaveLength(0);
    expect(repo.getSetting('kill_switch')).toBe('false');
    repo.close();
  });

  it('treats definitive FOK rejection on both parallel legs as terminal rejection', async () => {
    const { repo, executor, buy, sell } = setup(
      {
        createError: new Error('FOK_NOT_FILL'),
        leg1FillRatio: new Decimal(0),
        leg2FillRatio: new Decimal(0),
      },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('PARALLEL_REJECTED');
    expect(repo.getSetting('kill_switch')).toBe('false');
    repo.close();
  });

  it('safe-stops when one leg cannot be reconciled and records the known other fill', async () => {
    const { repo, executor, buy, sell } = setup(
      { queryUnknown: true, queryUnknownSide: 'buy' },
      'parallel_fok',
    );
    const result = await executor.execute(
      request(
        {
          adapter: buy.adapter,
          market: fokMarket('gateio'),
          credentials: keys,
          healthState: 'A',
        },
        {
          adapter: sell.adapter,
          market: fokMarket('mexc'),
          credentials: keys,
          healthState: 'A',
        },
      ),
    );
    expect(result.outcome).toBe('SAFE_STOP');
    expect(result.reasons.some((reason) => reason.startsWith('leg1_reconcile_failed'))).toBe(true);
    expect(repo.openUnhedgedInventory()[0]).toMatchObject({
      venue_id: 'mexc',
      amount: '12',
      direction: 'short',
      reason: 'parallel_unresolved_fill_inventory_shortfall',
    });
    expect(repo.getSetting('kill_switch')).toBe('true');
    repo.close();
  });
});
