import { describe, expect, it } from 'vitest';
import {
  Decimal,
  VenueHealthTracker,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { CexAdapter } from '@arb/venues-cex';
import { ScannerService, type ScannerVenue } from '../src/scanner-service.js';

const now = 1_700_000_000_000;

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
    supportsFok: false,
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

function adapter(venueId: string, ask: string, bid: string): CexAdapter {
  return {
    venueId,
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: false,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      websocket: false,
      ioc: true,
      fok: false,
    },
    loadMarkets: async () => [market(venueId)],
    fetchOrderBook: async () => book(venueId, ask, bid),
  };
}

function buildScanner(repo: ArbitrageRepository, requireBalancesForS1: boolean): ScannerService {
  const venues: ScannerVenue[] = [
    { adapter: adapter('gateio', '2.500', '2.490'), health: new VenueHealthTracker(), markets: [] },
    { adapter: adapter('mexc', '2.560', '2.550'), health: new VenueHealthTracker(), markets: [] },
  ];
  return new ScannerService({
    venues,
    repository: repo,
    settings: {
      minProfitUsd: new Decimal('0.25'),
      safetyBufferBps: new Decimal(15),
      minNetProfitBps: new Decimal(20),
      maxOrderbookAgeMs: 3000,
      maxSlippageBps: new Decimal(50),
      maxGasCostUsd: new Decimal('0.50'),
      maxTransferTaxBps: new Decimal(0),
    },
    quoteCurrency: 'USDT',
    baseAssets: ['CAKE'],
    requestedNotional: new Decimal(30),
    orderBookDepth: 50,
    maxTriangularPaths: 10,
    persistSnapshots: false,
    paperSimulation: false,
    requireBalancesForS1,
    clock: () => now,
  });
}

function recordBalance(repo: ArbitrageRepository, venueId: string, currency: string, free: string) {
  const amount = new Decimal(free);
  repo.recordBalance({
    venueId,
    accountId: 'test',
    currency,
    free: amount,
    used: new Decimal(0),
    total: amount,
    fetchedAt: now,
  });
}

describe('scanner balance-aware S1 sizing', () => {
  it('caps the notional to the available balances', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildScanner(repo, false);
    await scanner.initialize();
    recordBalance(repo, 'gateio', 'USDT', '20');
    recordBalance(repo, 'mexc', 'CAKE', '100');
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare(
        `SELECT requested_notional, metadata_json FROM opportunities WHERE strategy = 'S1' AND valid = 1`,
      )
      .get() as { requested_notional: string; metadata_json: string };
    expect(new Decimal(row.requested_notional).lte(20)).toBe(true);
    expect(JSON.parse(row.metadata_json).balanceLimited).toBe('true');
    repo.close();
  });

  it('rejects S1 when the balance is below the minimum notional', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildScanner(repo, false);
    await scanner.initialize();
    recordBalance(repo, 'gateio', 'USDT', '0.5');
    recordBalance(repo, 'mexc', 'CAKE', '100');
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBe(0);
    const rows = db
      .prepare(`SELECT rejection_reasons FROM opportunities WHERE strategy = 'S1'`)
      .all() as Array<{ rejection_reasons: string }>;
    expect(
      rows.some((row) => JSON.parse(row.rejection_reasons).includes('insufficient_balance')),
    ).toBe(true);
    repo.close();
  });

  it('fails closed when balances are required but missing', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildScanner(repo, true);
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBe(0);
    const rows = db
      .prepare(`SELECT rejection_reasons FROM opportunities WHERE strategy = 'S1'`)
      .all() as Array<{ rejection_reasons: string }>;
    expect(
      rows.some((row) => JSON.parse(row.rejection_reasons).includes('insufficient_balance')),
    ).toBe(true);
    repo.close();
  });
});
