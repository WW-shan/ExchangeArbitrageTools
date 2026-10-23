import { describe, expect, it } from 'vitest';
import {
  Decimal,
  ExecutionGate,
  canonicalMarketForEvaluation,
  evaluateS1Direction,
  normalizeBookForMarket,
  type CostSettings,
  type MarketMetadata,
  type OpportunityResult,
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
import { CexLiveExecutor, type ExecutionVenue } from '../src/coordinator.js';

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

function aliasBuyMarket(): MarketMetadata {
  return {
    venueId: 'gateio',
    exchangeSymbol: '1000PEPE/USDT',
    unifiedSymbol: 'PEPE/USDT',
    base: 'PEPE',
    exchangeBase: '1000PEPE',
    baseMultiplier: new Decimal(1000),
    quote: 'USDT',
    active: true,
    pricePrecision: 7,
    amountPrecision: 0,
    amountStep: new Decimal(1),
    priceStep: new Decimal('0.0000001'),
    minAmount: new Decimal(1000),
    minNotional: new Decimal(1),
    feeTakerBps: new Decimal(0),
    supportsIoc: true,
  };
}

function sellMarket(): MarketMetadata {
  return {
    venueId: 'mexc',
    exchangeSymbol: 'PEPE/USDT',
    unifiedSymbol: 'PEPE/USDT',
    base: 'PEPE',
    quote: 'USDT',
    active: true,
    pricePrecision: 9,
    amountPrecision: 0,
    amountStep: new Decimal(1),
    priceStep: new Decimal('0.000000001'),
    minAmount: new Decimal(1000),
    minNotional: new Decimal(1),
    feeTakerBps: new Decimal(0),
    supportsIoc: true,
  };
}

function rawBook(
  venueId: string,
  exchangeSymbol: string,
  ask: string,
  bid: string,
  amount: string,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol,
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal(amount) }],
    bids: [{ price: new Decimal(bid), amount: new Decimal(amount) }],
    source: 'rest',
  };
}

function opportunity(buyMarket: MarketMetadata, sellMarket: MarketMetadata): OpportunityResult {
  const result = evaluateS1Direction({
    base: 'PEPE',
    quote: 'USDT',
    buyMarket: canonicalMarketForEvaluation(buyMarket),
    sellMarket: canonicalMarketForEvaluation(sellMarket),
    buyBook: normalizeBookForMarket(
      rawBook('gateio', '1000PEPE/USDT', '0.00995', '0.00990', '2000'),
      buyMarket,
    ),
    sellBook: normalizeBookForMarket(
      rawBook('mexc', 'PEPE/USDT', '0.00001010', '0.00001005', '2000000'),
      sellMarket,
    ),
    requestedNotional: new Decimal(10),
    settings,
    now,
  });
  result.metadata = {
    ...(result.metadata ?? {}),
    buySymbol: buyMarket.exchangeSymbol,
    sellSymbol: sellMarket.exchangeSymbol,
    buyExchangeBase: '1000PEPE',
    sellExchangeBase: 'PEPE',
    buyBaseMultiplier: '1000',
    sellBaseMultiplier: '1',
  };
  return result;
}

function balances(
  venueId: string,
  currency: string,
  free: string,
  quote: string,
): BalanceSnapshot[] {
  return [
    {
      venueId,
      accountId: 'default',
      currency: quote,
      free: new Decimal(100),
      used: new Decimal(0),
      total: new Decimal(100),
      fetchedAt: now,
    },
    {
      venueId,
      accountId: 'default',
      currency,
      free: new Decimal(free),
      used: new Decimal(0),
      total: new Decimal(free),
      fetchedAt: now,
    },
  ];
}

function aliasAdapter(
  venueId: string,
  market: MarketMetadata,
  rawQuotes: { ask: string; bid: string; amount: string },
  balanceCurrency: string,
  balanceFree: string,
) {
  const requests: OrderRequest[] = [];
  const orderFor = (request: OrderRequest): OrderState => ({
    venueOrderId: `${venueId}-order`,
    ...(request.clientOrderId ? { clientOrderId: request.clientOrderId } : {}),
    symbol: request.symbol,
    side: request.side,
    type: request.type,
    ...(request.price ? { price: request.price } : {}),
    amount: request.amount,
    filled: request.amount,
    remaining: new Decimal(0),
    ...(request.price ? { averagePrice: request.price } : {}),
    fee: new Decimal(0),
    status: 'closed',
    raw: { fake: true },
  });
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
    loadMarkets: async () => [market],
    fetchOrderBook: async () =>
      rawBook(venueId, market.exchangeSymbol, rawQuotes.ask, rawQuotes.bid, rawQuotes.amount),
    fetchBalances: async () => balances(venueId, balanceCurrency, balanceFree, 'USDT'),
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
  return { adapter, requests };
}

function setup() {
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
  const buyMarket = aliasBuyMarket();
  const sell = sellMarket();
  const buy = aliasAdapter(
    'gateio',
    buyMarket,
    { ask: '0.00995', bid: '0.00990', amount: '2000' },
    '1000PEPE',
    '100000',
  );
  const sellVenue = aliasAdapter(
    'mexc',
    sell,
    { ask: '0.00001010', bid: '0.00001005', amount: '2000000' },
    'PEPE',
    '2000000',
  );
  const executor = new CexLiveExecutor({
    repository: repo,
    gate: new ExecutionGate(limits),
    limits,
    liveEnabled: true,
    settings,
    sleep: async () => {},
    clock: () => now,
  });
  return { db, repo, executor, buyMarket, sell, buy, sellVenue };
}

function executionVenue(adapter: CexAdapter, market: MarketMetadata): ExecutionVenue {
  return { adapter, market, credentials: keys, healthState: 'A' };
}

describe('live executor denomination aliases', () => {
  it('converts canonical PEPE quantities and prices back to 1000PEPE exchange units', async () => {
    const { db, repo, executor, buyMarket, sell, buy, sellVenue } = setup();
    const result = await executor.execute({
      batchId: 'alias-batch',
      opportunity: opportunity(buyMarket, sell),
      buy: executionVenue(buy.adapter, buyMarket),
      sell: executionVenue(sellVenue.adapter, sell),
      confirmedBatchId: 'alias-batch',
    });
    expect(result.outcome).toBe('CLOSED');
    expect(buy.requests).toHaveLength(1);
    expect(sellVenue.requests).toHaveLength(1);
    expect(buy.requests[0]?.amount.toFixed()).toBe('1005');
    expect(buy.requests[0]?.price?.toFixed()).toBe('0.00995');
    expect(sellVenue.requests[0]?.amount.toFixed()).toBe('1005000');
    expect(sellVenue.requests[0]?.price?.toFixed()).toBe('0.00001005');
    const row = db
      .prepare(
        'SELECT status, inventory_delta_json, metadata_json FROM executions WHERE batch_id = ?',
      )
      .get('alias-batch') as {
      status: string;
      inventory_delta_json: string;
      metadata_json: string;
    };
    expect(row.status).toBe('CLOSED');
    expect(JSON.parse(row.inventory_delta_json)).toMatchObject({
      baseAsset: 'PEPE',
      baseDelta: '0',
    });
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      buyExchangeBase: '1000PEPE',
      sellExchangeBase: 'PEPE',
      buyBaseMultiplier: '1000',
      sellBaseMultiplier: '1',
      leg1CanonicalFilled: '1005000',
      leg2CanonicalFilled: '1005000',
    });
    repo.close();
  });

  it('blocks a stored opportunity whose multiplier no longer matches the venue market', async () => {
    const { repo, executor, buyMarket, sell, buy, sellVenue } = setup();
    const stale = opportunity(buyMarket, sell);
    stale.metadata = { ...(stale.metadata ?? {}), buyBaseMultiplier: '1' };
    const result = await executor.execute({
      batchId: 'alias-stale',
      opportunity: stale,
      buy: executionVenue(buy.adapter, buyMarket),
      sell: executionVenue(sellVenue.adapter, sell),
      confirmedBatchId: 'alias-stale',
    });
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('route_mismatch');
    expect(buy.requests).toHaveLength(0);
    expect(sellVenue.requests).toHaveLength(0);
    repo.close();
  });
});
