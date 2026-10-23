import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  evaluateS1Direction,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, CexAdapter } from '@arb/venues-cex';
import type { ExecutionVenue, LiveExecutionResult } from '../src/coordinator.js';
import { buildS1ExecutionRequest, runS1Handoff, selectS1Handoff } from '../src/handoff.js';

const now = 1_700_000_000_000;
const credentials: ApiCredentials = { apiKey: 'test-key', secret: 'test-secret' };
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
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

function book(venueId: string, ask: string, bid: string): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    source: 'replay',
  };
}

function adapter(venueId: string): CexAdapter {
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
    fetchOrderBook: async () => book(venueId, '2.5', '2.49'),
    fetchBalances: async () => [],
    createOrder: async () => {
      throw new Error('not used');
    },
    fetchOrder: async () => {
      throw new Error('not used');
    },
    cancelOrder: async () => {
      throw new Error('not used');
    },
  };
}

function venue(venueId: string): ExecutionVenue {
  return {
    adapter: adapter(venueId),
    market: market(venueId),
    credentials,
    healthState: 'A',
  };
}

function setup() {
  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
  repository.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });
  const opportunity = evaluateS1Direction({
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
  const stored = repository.recordOpportunity(opportunity);
  return { repository, stored, opportunity };
}

function successfulEngine() {
  let calls = 0;
  return {
    calls: () => calls,
    execute: async (_request: unknown): Promise<LiveExecutionResult> => {
      calls += 1;
      return {
        batchId: 'S1-1-1700000000000',
        outcome: 'CLOSED',
        state: 'CLOSED',
        states: ['IDLE', 'CLOSED'],
        reasons: [],
        ordersSubmitted: 2,
        realizedProfit: new Decimal('0.3'),
      };
    },
  };
}

describe('S1 scanner-to-executor handoff', () => {
  it('loads the persisted S1 opportunity and prepares an exact batch confirmation id', () => {
    const { repository, stored } = setup();
    const selected = selectS1Handoff(repository, { maxAgeMs: 15_000, now });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.selection.loaded.id).toBe(stored.id);
    expect(selected.selection.batchId).toBe(`S1-${stored.id}-${now}`);
    const built = buildS1ExecutionRequest({
      selection: selected.selection,
      buy: venue('gateio'),
      sell: venue('mexc'),
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.request.opportunityId).toBe(stored.id);
      expect(built.request.confirmedBatchId).toBe('');
    }
    repository.close();
  });

  it('fails closed for stale opportunities and refuses a second execution', () => {
    const { repository, stored } = setup();
    const stale = selectS1Handoff(repository, { maxAgeMs: 1000, now: now + 2000 });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_s1_opportunity' });
    repository.createExecution({
      strategy: 'S1',
      batchId: `S1-${stored.id}-${now}`,
      status: 'LEG1_UNKNOWN',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.3'),
      openedAt: now,
      opportunityId: stored.id,
    });
    const duplicate = selectS1Handoff(repository, { maxAgeMs: 15_000, now });
    expect(duplicate).toMatchObject({ ok: false, reason: 'opportunity_already_executed' });
    repository.close();
  });

  it('rejects a handoff whose loaded market no longer matches the stored route', () => {
    const { repository } = setup();
    const selected = selectS1Handoff(repository, { maxAgeMs: 15_000, now });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const mismatched = venue('gateio');
    mismatched.market = { ...mismatched.market, venueId: 'other' };
    const built = buildS1ExecutionRequest({
      selection: selected.selection,
      buy: mismatched,
      sell: venue('mexc'),
    });
    expect(built).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['buy_market_mismatch']),
    });
    repository.close();
  });

  it('rejects a handoff when the stored denomination multiplier has drifted', () => {
    const { repository } = setup();
    const selected = selectS1Handoff(repository, { maxAgeMs: 15_000, now });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    selected.selection.loaded.opportunity.metadata = {
      buyBaseMultiplier: '1000',
      sellBaseMultiplier: '1',
    };
    const built = buildS1ExecutionRequest({
      selection: selected.selection,
      buy: venue('gateio'),
      sell: venue('mexc'),
    });
    expect(built).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['stored_buy_multiplier_mismatch']),
    });
    repository.close();
  });

  it('never calls the engine unless live execution and exact manual confirmation are both present', async () => {
    const { repository } = setup();
    const selected = selectS1Handoff(repository, { maxAgeMs: 15_000, now });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const built = buildS1ExecutionRequest({
      selection: selected.selection,
      buy: venue('gateio'),
      sell: venue('mexc'),
      confirmedBatchId: selected.selection.batchId,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const engine = successfulEngine();

    const disabled = await runS1Handoff({
      repository,
      request: built.request,
      batchId: selected.selection.batchId,
      liveEnabled: false,
      executeRequested: true,
      confirmedBatchId: selected.selection.batchId,
      engine,
    });
    expect(disabled.status).toBe('LIVE_DISABLED');
    expect(engine.calls()).toBe(0);

    repository.setSetting('live_enabled', 'true', now);
    const awaiting = await runS1Handoff({
      repository,
      request: built.request,
      batchId: selected.selection.batchId,
      liveEnabled: true,
      executeRequested: false,
      engine,
    });
    expect(awaiting.status).toBe('AWAITING_CONFIRMATION');
    expect(engine.calls()).toBe(0);

    const mismatch = await runS1Handoff({
      repository,
      request: built.request,
      batchId: selected.selection.batchId,
      liveEnabled: true,
      executeRequested: true,
      confirmedBatchId: 'wrong-batch',
      engine,
    });
    expect(mismatch.status).toBe('CONFIRMATION_MISMATCH');
    expect(engine.calls()).toBe(0);

    const executed = await runS1Handoff({
      repository,
      request: built.request,
      batchId: selected.selection.batchId,
      liveEnabled: true,
      executeRequested: true,
      confirmedBatchId: selected.selection.batchId,
      engine,
    });
    expect(executed.status).toBe('EXECUTED');
    expect(executed.execution?.outcome).toBe('CLOSED');
    expect(engine.calls()).toBe(1);
    repository.close();
  });

  it('selects the best fresh opportunity rather than the newest', () => {
    const { repository, opportunity, stored } = setup();
    const weak = {
      ...opportunity,
      sampledAt: now + 1000,
      netProfitBps: new Decimal('30'),
      conservativeNetProfit: new Decimal('0.09'),
    };
    const weakStored = repository.recordOpportunity(weak);
    const selected = selectS1Handoff(repository, { maxAgeMs: 15_000, now: now + 1000 });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.selection.loaded.id).toBe(stored.id);
    expect(selected.selection.loaded.id).not.toBe(weakStored.id);
    repository.close();
  });
});
