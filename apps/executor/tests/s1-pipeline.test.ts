import { describe, expect, it } from 'vitest';
import {
  Decimal,
  ExecutionGate,
  VenueHealthTracker,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
  type RiskLimits,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type {
  ApiCredentials,
  BalanceSnapshot,
  CexAdapter,
  OrderRequest,
  OrderState,
} from '@arb/venues-cex';
import { ScannerService, type ScannerVenue } from '../../scanner/src/scanner-service.js';
import { CexLiveExecutor } from '../src/coordinator.js';
import { buildS1ExecutionRequest, runS1Handoff, selectS1Handoff } from '../src/handoff.js';

const now = 1_700_000_000_000;
const keys: ApiCredentials = { apiKey: 'test', secret: 'test' };
const settings: CostSettings = {
  minProfitUsd: new Decimal(0),
  safetyBufferBps: new Decimal(0),
  minNetProfitBps: new Decimal(0),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal(0),
  maxTransferTaxBps: new Decimal(0),
  liquidityTopLevels: 5,
};
const limits: RiskLimits = {
  maxOrderNotional: new Decimal(30),
  dailyMaxLoss: new Decimal(20),
  maxOpenBatches: 1,
  minNetProfitBps: new Decimal(0),
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
    feeTakerBps: new Decimal(0),
    feeProvenance: 'config',
    supportsIoc: true,
  };
}

function book(venueId: string, ask: string, bid: string): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: now,
    receivedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    source: 'rest',
  };
}

function balances(venueId: string): BalanceSnapshot[] {
  return [
    {
      venueId,
      accountId: 'default',
      currency: 'USDT',
      free: new Decimal(1000),
      used: new Decimal(0),
      total: new Decimal(1000),
      fetchedAt: now,
    },
    {
      venueId,
      accountId: 'default',
      currency: 'CAKE',
      free: new Decimal(100),
      used: new Decimal(0),
      total: new Decimal(100),
      fetchedAt: now,
    },
  ];
}

function adapter(
  venueId: string,
  marketMetadata: MarketMetadata,
  ask: string,
  bid: string,
  leg2FillRatio = new Decimal(1),
) {
  const requests: OrderRequest[] = [];
  const orderFor = (request: OrderRequest): OrderState => {
    const ratio = request.side === 'sell' ? leg2FillRatio : new Decimal(1);
    const filled = request.amount.mul(ratio);
    return {
      venueOrderId: `${venueId}-${request.clientOrderId ?? request.side}`,
      ...(request.clientOrderId ? { clientOrderId: request.clientOrderId } : {}),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      ...(request.price ? { price: request.price } : {}),
      amount: request.amount,
      filled,
      remaining: request.amount.minus(filled),
      ...(request.price ? { averagePrice: request.price } : {}),
      fee: new Decimal(0),
      status: ratio.eq(1) ? 'closed' : 'canceled',
      raw: { fake: true },
    };
  };
  const cexAdapter: CexAdapter = {
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
    loadMarkets: async () => [marketMetadata],
    fetchOrderBook: async () => book(venueId, ask, bid),
    fetchBalances: async () => balances(venueId),
    createOrder: async (request) => {
      requests.push(request);
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
  return { adapter: cexAdapter, requests };
}

async function discoverAndExecute(leg2FillRatio = new Decimal(1)) {
  const db = openDatabase(':memory:');
  const repository = new ArbitrageRepository(db);
  for (const venueId of ['gateio', 'mexc']) {
    repository.upsertVenue({
      id: venueId,
      type: 'cex',
      name: venueId,
      tier: 'S',
      executionEnabled: true,
      now,
    });
  }
  repository.setSetting('kill_switch', 'false', now);
  repository.setSetting('live_enabled', 'true', now);

  const gateMarket = market('gateio');
  const mexcMarket = market('mexc');
  const gate = adapter('gateio', gateMarket, '2.500', '2.490');
  const mexc = adapter('mexc', mexcMarket, '2.560', '2.550', leg2FillRatio);
  const venues: ScannerVenue[] = [
    { adapter: gate.adapter, health: new VenueHealthTracker(), markets: [] },
    { adapter: mexc.adapter, health: new VenueHealthTracker(), markets: [] },
  ];
  const scanner = new ScannerService({
    venues,
    repository,
    settings,
    quoteCurrency: 'USDT',
    quoteCurrencies: ['USDT'],
    assetUniverseMode: 'explicit',
    baseAssets: ['CAKE'],
    maxBaseAssets: 1,
    min24hQuoteVolumeUsd: new Decimal(0),
    requestedNotional: new Decimal(10),
    orderBookDepth: 50,
    maxTriangularPaths: 0,
    maxCandidatesPerCycle: 0,
    persistSnapshots: false,
    paperSimulation: false,
    clock: () => now,
  });
  await scanner.initialize();
  const summary = await scanner.scanOnce();
  expect(summary.validOpportunities).toBeGreaterThan(0);

  const selected = selectS1Handoff(repository, { maxAgeMs: 15_000, now });
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw new Error('expected fresh S1 handoff');
  const built = buildS1ExecutionRequest({
    selection: selected.selection,
    buy: {
      adapter: gate.adapter,
      market: gateMarket,
      credentials: keys,
      healthState: 'A',
    },
    sell: {
      adapter: mexc.adapter,
      market: mexcMarket,
      credentials: keys,
      healthState: 'A',
    },
    confirmedBatchId: selected.selection.batchId,
  });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(`expected valid execution request: ${built.reasons.join(',')}`);

  const executor = new CexLiveExecutor({
    repository,
    gate: new ExecutionGate(limits),
    limits,
    liveEnabled: true,
    settings,
    sleep: async () => {},
    clock: () => now,
  });
  const result = await runS1Handoff({
    repository,
    request: built.request,
    batchId: selected.selection.batchId,
    liveEnabled: true,
    executeRequested: true,
    confirmedBatchId: selected.selection.batchId,
    engine: executor,
    now: () => now,
  });
  return { db, repository, result, gate, mexc };
}

describe('S1 scanner-to-executor pipeline', () => {
  it('executes a discovered opportunity end to end and persists the closed execution', async () => {
    const { db, repository, result, gate, mexc } = await discoverAndExecute();
    expect(result.status).toBe('EXECUTED');
    expect(result.execution?.outcome).toBe('CLOSED');
    expect(gate.requests).toHaveLength(1);
    expect(mexc.requests).toHaveLength(1);
    expect(gate.requests[0]?.amount.toFixed()).toBe('4');
    expect(mexc.requests[0]?.amount.toFixed()).toBe('4');
    expect(gate.requests[0]?.side).toBe('buy');
    expect(mexc.requests[0]?.side).toBe('sell');

    const execution = db
      .prepare('SELECT status, realized_profit, opportunity_id FROM executions WHERE batch_id = ?')
      .get(result.batchId) as {
      status: string;
      realized_profit: string;
      opportunity_id: number;
    };
    expect(execution.status).toBe('CLOSED');
    expect(new Decimal(execution.realized_profit).toFixed()).toBe('0.2');
    expect(execution.opportunity_id).toBeGreaterThan(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number }).count,
    ).toBe(2);
    expect(repository.openUnhedgedInventory()).toHaveLength(0);
    repository.close();
  });

  it('stops safely and records the unhedged remainder when leg 2 partially fills', async () => {
    const { db, repository, result, mexc } = await discoverAndExecute(new Decimal('0.5'));
    expect(result.status).toBe('EXECUTED');
    expect(result.execution?.outcome).toBe('SAFE_STOP');
    expect(result.execution?.states).toContain('LEG2_PARTIAL');
    expect(mexc.requests).toHaveLength(1);
    const open = repository.openUnhedgedInventory();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ asset: 'CAKE', amount: '2', status: 'open' });
    expect(repository.riskSnapshot(now).unhedgedInventoryRisk.gt(0)).toBe(true);
    expect(repository.getSetting('kill_switch')).toBe('true');
    const execution = db
      .prepare('SELECT status, safe_mode_reason FROM executions WHERE batch_id = ?')
      .get(result.batchId) as { status: string; safe_mode_reason: string };
    expect(execution.status).toBe('SAFE_STOP');
    expect(execution.safe_mode_reason).toBe('leg2_partial_fill');
    repository.close();
  });
});
