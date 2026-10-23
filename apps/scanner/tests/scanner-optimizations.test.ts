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
    feeTakerBps: new Decimal('2'),
    feeProvenance: 'config',
    supportsIoc: true,
    supportsFok: false,
  };
}

function capabilities() {
  return {
    publicMarketData: true,
    orderBook: true,
    privateBalances: false,
    createOrder: false,
    fetchOrder: false,
    cancelOrder: false,
    websocket: true,
    ioc: true,
    fok: false,
  };
}

function waitAbort(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer);
        resolve();
      }
    }, 5);
  });
}

function book(venueId: string, bid: string, ask: string): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: now,
    receivedAt: now,
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    source: 'websocket',
  };
}

function adapter(
  venueId: string,
  wsBid: string,
  wsAsk: string,
  restBid: string,
  restAsk: string,
): CexAdapter {
  return {
    venueId,
    tier: 'S',
    capabilities: capabilities(),
    loadMarkets: async () => [market(venueId)],
    fetchOrderBook: async () => ({
      ...book(venueId, restBid, restAsk),
      source: 'rest',
    }),
    watchOrderBook: async (_symbol, _depth, onBook, signal) => {
      onBook(book(venueId, wsBid, wsAsk));
      await waitAbort(signal);
    },
  };
}

function scannerOptions(venues: ScannerVenue[], repository: ArbitrageRepository) {
  return {
    venues,
    repository,
    settings: {
      minProfitUsd: new Decimal('0.01'),
      safetyBufferBps: new Decimal(0),
      minNetProfitBps: new Decimal(0),
      maxOrderbookAgeMs: 3000,
      maxSlippageBps: new Decimal(50),
      maxGasCostUsd: new Decimal('0.50'),
      maxTransferTaxBps: new Decimal(0),
      liquidityTopLevels: 5,
    },
    quoteCurrency: 'USDT',
    baseAssets: ['CAKE'],
    requestedNotional: new Decimal(100),
    orderBookDepth: 50,
    maxTriangularPaths: 0,
    persistSnapshots: false,
    paperSimulation: false,
    feedMode: 'websocket' as const,
    wsMaxBookAgeMs: 5000,
    clock: () => now,
  };
}

describe('scanner optimizations', () => {
  it('blocks a venue/symbol after a WS-vs-REST book sanity failure', async () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.49', '2.50', '2.40', '2.41'),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('mexc', '2.50', '2.51', '2.50', '2.51'),
        health: new VenueHealthTracker(),
        markets: [],
      },
    ];
    const scanner = new ScannerService({
      ...scannerOptions(venues, repo),
      bookSanityEnabled: true,
      bookSanityIntervalMs: 0,
      bookSanityMaxDeviationBps: new Decimal(1),
      bookSanityRequiredFailures: 1,
      bookSanityRequiredSuccesses: 1,
      bookSanityCooldownMs: 60_000,
      bookSanitySampleSize: 2,
    });
    await scanner.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await scanner.scanOnce();
    let events = repo.listRiskEvents(50).filter((event) => event.rule === 'book_sanity_failure');
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events = repo.listRiskEvents(50).filter((event) => event.rule === 'book_sanity_failure');
    }
    expect(events.length).toBeGreaterThanOrEqual(1);
    const blockedSummary = await scanner.scanOnce();
    expect(blockedSummary.s1Count).toBe(0);
    await scanner.close();
    repo.close();
  });

  it('prefilters low top-of-book edges before the Decimal depth walk', async () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.49', '2.50', '2.49', '2.50'),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('mexc', '2.60', '2.61', '2.60', '2.61'),
        health: new VenueHealthTracker(),
        markets: [],
      },
    ];
    const scanner = new ScannerService({
      ...scannerOptions(venues, repo),
      prefilterEnabled: true,
      prefilterFloorBps: 100_000,
    });
    await scanner.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const summary = await scanner.scanOnce();
    expect(summary.s1Count).toBe(0);
    expect(summary.prefiltered).toBeGreaterThan(0);
    await scanner.close();
    repo.close();
  });

  it('skips unchanged bases with no valid edge on the next cycle', async () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.50', '2.51', '2.50', '2.51'),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('mexc', '2.51', '2.52', '2.51', '2.52'),
        health: new VenueHealthTracker(),
        markets: [],
      },
    ];
    const scanner = new ScannerService({
      ...scannerOptions(venues, repo),
      incrementalEvaluation: true,
    });
    await scanner.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await scanner.scanOnce();
    const second = await scanner.scanOnce();
    expect(second.skippedUnchanged).toBeGreaterThan(0);
    await scanner.close();
    repo.close();
  });

  it('suppresses duplicate paper batches for the same route during cooldown', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.49', '2.50', '2.49', '2.50'),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('mexc', '2.60', '2.61', '2.60', '2.61'),
        health: new VenueHealthTracker(),
        markets: [],
      },
    ];
    const scanner = new ScannerService({
      ...scannerOptions(venues, repo),
      routeCooldownMs: 60_000,
      paperSimulation: true,
    });
    await scanner.initialize();
    await scanner.scanOnce();
    await scanner.scanOnce();
    const count = db.prepare('SELECT COUNT(*) AS count FROM paper_trades').get() as {
      count: number;
    };
    expect(Number(count.count)).toBe(1);
    const row = db
      .prepare(
        "SELECT metadata_json FROM opportunities WHERE strategy = 'S1' AND direction = 'gateio->mexc' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).duplicateRoute).toBe('true');
    await scanner.close();
    repo.close();
  });

  it('records the fee provenance of account overrides', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.49', '2.50', '2.49', '2.50'),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('mexc', '2.60', '2.61', '2.60', '2.61'),
        health: new VenueHealthTracker(),
        markets: [],
      },
    ];
    const scanner = new ScannerService({
      ...scannerOptions(venues, repo),
      feeOverrides: {
        gateio: { takerBps: new Decimal('1'), source: 'account' },
      },
    });
    await scanner.initialize();
    await scanner.scanOnce();
    const row = db
      .prepare(
        "SELECT metadata_json FROM opportunities WHERE strategy = 'S1' AND direction = 'gateio->mexc' ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata_json: string };
    const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
    expect(metadata.buyFeeProvenance).toBe('account');
    expect(metadata.sellFeeProvenance).toBe('config');
    await scanner.close();
    repo.close();
  });
});
