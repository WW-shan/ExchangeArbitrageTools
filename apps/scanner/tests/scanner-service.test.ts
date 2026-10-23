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

function market(venueId: string, base = 'CAKE', quote = 'USDT'): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: `${base}/${quote}`,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
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

function book(
  venueId: string,
  ask: string,
  bid: string,
  fetchedAt = now,
  exchangeSymbol = 'CAKE/USDT',
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol,
    fetchedAt,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    source: 'replay',
  };
}

function adapter(venueId: string, ask: string, bid: string, fetchedAt = now): CexAdapter {
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
    fetchOrderBook: async () => book(venueId, ask, bid, fetchedAt),
    fetchCurrencies: async () => [
      {
        venueId,
        code: 'CAKE',
        networks: [
          {
            network: 'BSC',
            nativeName: 'BNB Smart Chain (BEP20)',
            withdrawEnabled: true,
            depositEnabled: true,
            withdrawFee: new Decimal('0.1'),
            minWithdrawAmount: new Decimal('1'),
            minDepositAmount: new Decimal('0.1'),
            canArriveQuickly: true,
          },
        ],
      },
    ],
  };
}

function setup(fresh = true) {
  const db = openDatabase(':memory:');
  const repo = new ArbitrageRepository(db);
  const venues: ScannerVenue[] = [
    {
      adapter: adapter('gateio', '2.500', '2.490', fresh ? now : now - 10_000),
      health: new VenueHealthTracker(),
      markets: [],
    },
    {
      adapter: adapter('mexc', '2.560', '2.550', fresh ? now : now - 10_000),
      health: new VenueHealthTracker(),
      markets: [],
    },
  ];
  const scanner = new ScannerService({
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
    persistSnapshots: true,
    episodeGapMs: 15_000,
    clock: () => now,
  });
  return { db, repo, scanner };
}

describe('scanner service', () => {
  it('isolates market discovery failures to the failing venue', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const failingVenue: ScannerVenue = {
      adapter: {
        ...adapter('weex', '0', '0'),
        loadMarkets: async () => {
          throw new Error('Connect Timeout Error');
        },
      },
      health: new VenueHealthTracker(),
      markets: [],
    };
    const scanner = new ScannerService({
      venues: [
        {
          adapter: adapter('gateio', '2.500', '2.490'),
          health: new VenueHealthTracker(),
          markets: [],
        },
        {
          adapter: adapter('mexc', '2.560', '2.550'),
          health: new VenueHealthTracker(),
          markets: [],
        },
        failingVenue,
      ],
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
      clock: () => now,
    });
    const counts = await scanner.initialize();
    expect(counts).toEqual({ gateio: 1, mexc: 1, weex: 0 });
    expect(failingVenue.health.snapshot(now).healthState).toBe('D');
    expect(
      repo
        .listRiskEvents()
        .some((event) => event.rule === 'market_discovery_failed' && event.severity === 'critical'),
    ).toBe(true);
    const summary = await scanner.scanOnce();
    expect(summary.errors).toBe(0);
    expect(summary.validOpportunities).toBeGreaterThanOrEqual(1);
    repo.close();
  });

  it('persists a valid S1 opportunity and only its snapshots', async () => {
    const { db, repo, scanner } = setup();
    const counts = await scanner.initialize();
    expect(counts).toEqual({ gateio: 1, mexc: 1 });
    const summary = await scanner.scanOnce();
    expect(summary.s1Count).toBe(2);
    expect(summary.validOpportunities).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toBe(0);
    const opportunities = repo.listOpportunities({ validOnly: true });
    expect(opportunities.length).toBeGreaterThanOrEqual(1);
    const snapshots = db.prepare('SELECT COUNT(*) AS count FROM orderbooks').get() as {
      count: number;
    };
    expect(snapshots.count).toBe(2);
    const health = db.prepare('SELECT COUNT(*) AS count FROM venue_health').get() as {
      count: number;
    };
    expect(health.count).toBe(2);
    const currencies = db.prepare('SELECT COUNT(*) AS count FROM exchange_currencies').get() as {
      count: number;
    };
    expect(currencies.count).toBe(2);
    const papers = db.prepare('SELECT COUNT(*) AS count FROM paper_trades').get() as {
      count: number;
    };
    expect(papers.count).toBeGreaterThanOrEqual(1);
    repo.close();
  });

  it('records stale-book errors without crashing the scan loop', async () => {
    const { db, repo, scanner } = setup(false);
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBe(0);
    expect(summary.errors).toBe(2);
    expect(summary.rejectedOpportunities).toBe(0);
    const riskEvents = db.prepare('SELECT COUNT(*) AS count FROM risk_events').get() as {
      count: number;
    };
    expect(riskEvents.count).toBeGreaterThanOrEqual(2);
    repo.close();
  });

  it('restores a persisted venue backoff before loading markets', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'gateio', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'mexc', tier: 'S', now });
    repo.upsertVenueBackoff({
      venueId: 'gateio',
      backoffUntil: now + 10_000,
      reason: 'rate_limited',
      consecutiveFailures: 2,
      updatedAt: now,
    });
    let applied = 0;
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.500', '2.490'),
        health: new VenueHealthTracker(),
        markets: [],
        applyBackoff: (retryAfterMs) => {
          applied = retryAfterMs;
        },
      },
      {
        adapter: adapter('mexc', '2.560', '2.550'),
        health: new VenueHealthTracker(),
        markets: [],
      },
    ];
    const scanner = new ScannerService({
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
      clock: () => now,
    });
    await scanner.initialize();
    expect(applied).toBe(10_000);
    const restored = db
      .prepare("SELECT COUNT(*) AS count FROM risk_events WHERE rule = 'venue_backoff_restored'")
      .get() as { count: number };
    expect(restored.count).toBe(1);
    repo.close();
  });

  it('persists a valid S2 triangular paper simulation end to end', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const triangularMarkets = [
      market('gateio', 'CAKE', 'USDT'),
      market('gateio', 'BNB', 'USDT'),
      market('gateio', 'CAKE', 'BNB'),
    ];
    const prices: Record<string, { ask: string; bid: string }> = {
      'CAKE/USDT': { ask: '3001', bid: '3000' },
      'BNB/USDT': { ask: '500', bid: '499' },
      'CAKE/BNB': { ask: '5', bid: '4.9' },
    };
    const venue = (venueId: string, markets: MarketMetadata[]): ScannerVenue => ({
      adapter: {
        ...adapter(venueId, '0', '0'),
        loadMarkets: async () => markets,
        fetchOrderBook: async (symbol) => {
          const price = prices[symbol]!;
          return book(venueId, price.ask, price.bid, now, symbol);
        },
      },
      health: new VenueHealthTracker(),
      markets: [],
    });
    const scanner = new ScannerService({
      venues: [venue('gateio', triangularMarkets), venue('mexc', [market('mexc', 'CAKE', 'USDT')])],
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
      baseAssets: ['CAKE', 'BNB'],
      requestedNotional: new Decimal(1000),
      orderBookDepth: 50,
      maxTriangularPaths: 10,
      persistSnapshots: false,
      clock: () => now,
    });
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.s2Count).toBeGreaterThan(0);
    const papers = db
      .prepare(
        "SELECT result, fill_quality_json FROM paper_trades WHERE fill_quality_json LIKE '%S2%'",
      )
      .all() as Array<{ result: string; fill_quality_json: string }>;
    expect(papers.length).toBeGreaterThan(0);
    expect(papers[0]!.result).toBe('SIMULATED');
    expect(JSON.parse(papers[0]!.fill_quality_json)).toMatchObject({
      strategy: 'S2',
      inputAsset: 'USDT',
      outputAsset: 'USDT',
    });
    repo.close();
  });

  it('builds a volume-ranked universe and scans every selected base and quote', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const venue = (venueId: string, ask: string): ScannerVenue => ({
      adapter: {
        ...adapter(venueId, '0', '0'),
        loadMarkets: async () => [market(venueId, 'CAKE', 'USDT'), market(venueId, 'ETH', 'USDT')],
        fetchTickers: async () => [
          {
            venueId,
            exchangeSymbol: 'CAKE/USDT',
            quoteVolume: new Decimal('5000000'),
            timestamp: now,
          },
          {
            venueId,
            exchangeSymbol: 'ETH/USDT',
            quoteVolume: new Decimal('20000000'),
            timestamp: now,
          },
        ],
        fetchOrderBook: async (symbol) =>
          book(venueId, ask, (Number(ask) - 0.01).toFixed(2), now, symbol),
      },
      health: new VenueHealthTracker(),
      markets: [],
    });
    const scanner = new ScannerService({
      venues: [venue('gateio', '2.50'), venue('mexc', '2.60')],
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
      assetUniverseMode: 'top_volume',
      maxBaseAssets: 2,
      quoteCurrencies: ['USDT'],
      min24hQuoteVolumeUsd: new Decimal(0),
      scanIntervalHotMs: 0,
      scanIntervalTop100Ms: 0,
      scanIntervalTop500Ms: 0,
      requestedNotional: new Decimal(30),
      orderBookDepth: 50,
      maxTriangularPaths: 10,
      persistSnapshots: false,
      paperSimulation: false,
      clock: () => now,
    });
    await scanner.initialize();
    expect(repo.listMarketUniverse('gateio')).toHaveLength(2);
    const summary = await scanner.scanOnce();
    expect(summary.s1Count).toBeGreaterThanOrEqual(4);
    repo.close();
  });

  it('ranks triangular candidates and only exact-simulates the top N', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const triangularMarkets = [
      market('gateio', 'CAKE', 'USDT'),
      market('gateio', 'BNB', 'USDT'),
      market('gateio', 'CAKE', 'BNB'),
    ];
    const prices: Record<string, { ask: string; bid: string }> = {
      'CAKE/USDT': { ask: '3001', bid: '3000' },
      'BNB/USDT': { ask: '500', bid: '499' },
      'CAKE/BNB': { ask: '5', bid: '4.9' },
    };
    const venue = (venueId: string, markets: MarketMetadata[]): ScannerVenue => ({
      adapter: {
        ...adapter(venueId, '0', '0'),
        loadMarkets: async () => markets,
        fetchOrderBook: async (symbol) => {
          const price = prices[symbol]!;
          return book(venueId, price.ask, price.bid, now, symbol);
        },
      },
      health: new VenueHealthTracker(),
      markets: [],
    });
    const scanner = new ScannerService({
      venues: [venue('gateio', triangularMarkets), venue('mexc', [market('mexc', 'CAKE', 'USDT')])],
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
      baseAssets: ['CAKE', 'BNB'],
      requestedNotional: new Decimal(1000),
      orderBookDepth: 50,
      maxTriangularPaths: 10,
      maxCandidatesPerCycle: 1,
      persistSnapshots: false,
      paperSimulation: false,
      clock: () => now,
    });
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.s2Candidates).toBeGreaterThanOrEqual(2);
    expect(summary.s2Evaluated).toBe(1);
    expect(summary.s2Count).toBe(1);
    repo.close();
  });

  it('applies the triangular path budget across all venues', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const triangularVenue = (venueId: string, ask: string, bid: string): ScannerVenue => {
      const markets = [
        market(venueId, 'BNB', 'USDT'),
        market(venueId, 'CAKE', 'BNB'),
        market(venueId, 'CAKE', 'USDT'),
      ];
      return {
        adapter: {
          ...adapter(venueId, ask, bid),
          loadMarkets: async () => markets,
          fetchOrderBook: async (symbol) => book(venueId, ask, bid, now, symbol),
        },
        health: new VenueHealthTracker(),
        markets: [],
      };
    };
    const scanner = new ScannerService({
      venues: [
        triangularVenue('gateio', '2.500', '2.490'),
        triangularVenue('mexc', '2.560', '2.550'),
      ],
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
      baseAssets: ['CAKE', 'BNB'],
      requestedNotional: new Decimal(30),
      orderBookDepth: 50,
      maxTriangularPaths: 1,
      persistSnapshots: false,
      paperSimulation: false,
      clock: () => now,
    });
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.s2Count).toBe(1);
    repo.close();
  });

  it('evaluates delayed books with the completion clock, not the cycle start', async () => {
    let current = now;
    const delayedVenue = (venueId: string, ask: string, bid: string): ScannerVenue => ({
      adapter: {
        ...adapter(venueId, ask, bid),
        fetchOrderBook: async () => {
          current += 1000;
          return book(venueId, ask, bid, current);
        },
      },
      health: new VenueHealthTracker(),
      markets: [],
    });
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = new ScannerService({
      venues: [delayedVenue('gateio', '2.500', '2.490'), delayedVenue('mexc', '2.560', '2.550')],
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
      clock: () => current,
    });
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.scannedAt).toBe(now);
    expect(summary.errors).toBe(0);
    expect(summary.validOpportunities).toBeGreaterThanOrEqual(1);
    expect(repo.listOpportunities({ validOnly: true })[0]?.sampled_at).toBe(now + 2000);
    repo.close();
  });
});

describe('scanner cross-venue inventory discovery', () => {
  function buildScanner(repo: ArbitrageRepository, balanceMaxAgeMs = 60_000): ScannerService {
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', '2.500', '2.490'),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('mecx', '2.560', '2.550'),
        health: new VenueHealthTracker(),
        markets: [],
      },
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
      crossVenueMode: 'inventory',
      maxVenueSwitches: 1,
      balanceMaxAgeMs,
      persistSnapshots: false,
      paperSimulation: false,
      clock: () => now,
    });
  }

  function recordBalance(
    repo: ArbitrageRepository,
    venueId: string,
    currency: string,
    free: string,
    fetchedAt = now,
  ): void {
    repo.recordBalance({
      venueId,
      accountId: 'main',
      currency,
      free: new Decimal(free),
      used: new Decimal(0),
      total: new Decimal(free),
      fetchedAt,
    });
  }

  it('emits a cross-venue inventory opportunity when balances are present', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildScanner(repo);
    await scanner.initialize();
    recordBalance(repo, 'gateio', 'USDT', '1000');
    recordBalance(repo, 'mecx', 'CAKE', '100');
    const summary = await scanner.scanOnce();
    expect(summary.crossVenueCandidates).toBeGreaterThanOrEqual(1);
    expect(summary.s2CrossVenueCount).toBeGreaterThanOrEqual(1);
    const rows = db
      .prepare("SELECT metadata_json FROM opportunities WHERE strategy = 'S2' AND valid = 1")
      .all() as Array<{ metadata_json: string }>;
    expect(
      rows.some((row) => JSON.parse(row.metadata_json).variant === 'cross_venue_inventory'),
    ).toBe(true);
    repo.close();
  });

  it('does not emit cross-venue opportunities without balances', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildScanner(repo);
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.crossVenueCandidates).toBe(0);
    expect(summary.s2CrossVenueCount).toBe(0);
    repo.close();
  });

  it('ignores stale balance snapshots', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildScanner(repo, 5_000);
    await scanner.initialize();
    recordBalance(repo, 'gateio', 'USDT', '1000', now - 10_000);
    recordBalance(repo, 'mecx', 'CAKE', '100', now - 10_000);
    const summary = await scanner.scanOnce();
    expect(summary.s2CrossVenueCount).toBe(0);
    repo.close();
  });
});

describe('scanner optimal sizing', () => {
  function levels(values: Array<[string, string]>) {
    return values.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    }));
  }

  function cliffAdapter(
    venueId: string,
    asks: Array<[string, string]>,
    bids: Array<[string, string]>,
  ): CexAdapter {
    return {
      ...adapter(venueId, '2.5', '2.49'),
      fetchOrderBook: async () => ({
        venueId,
        exchangeSymbol: 'CAKE/USDT',
        fetchedAt: now,
        asks: levels(asks),
        bids: levels(bids),
        source: 'replay',
      }),
    };
  }

  function buildCliffScanner(repo: ArbitrageRepository, optimalSizing: boolean): ScannerService {
    return new ScannerService({
      venues: [
        {
          adapter: cliffAdapter(
            'gateio',
            [
              ['2.5', '4'],
              ['2.6', '100'],
            ],
            [['2.49', '100']],
          ),
          health: new VenueHealthTracker(),
          markets: [],
        },
        {
          adapter: cliffAdapter(
            'mexc',
            [['2.57', '100']],
            [
              ['2.55', '4'],
              ['2.50', '100'],
            ],
          ),
          health: new VenueHealthTracker(),
          markets: [],
        },
      ],
      repository: repo,
      settings: {
        minProfitUsd: new Decimal('0.05'),
        safetyBufferBps: new Decimal(10),
        minNetProfitBps: new Decimal(5),
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
      optimalSizing,
      minSizingNotional: new Decimal(1),
      sizingStep: new Decimal('0.01'),
      persistSnapshots: false,
      paperSimulation: false,
      clock: () => now,
    });
  }

  it('sizes down below the depth cliff and records the chosen notional', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildCliffScanner(repo, true);
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBeGreaterThanOrEqual(1);
    expect(summary.sizingCandidates).toBeGreaterThanOrEqual(1);
    const rows = db
      .prepare(
        "SELECT requested_notional, metadata_json FROM opportunities WHERE strategy = 'S1' AND valid = 1",
      )
      .all() as Array<{ requested_notional: string; metadata_json: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(new Decimal(rows[0]!.requested_notional).lt(15)).toBe(true);
    expect(JSON.parse(rows[0]!.metadata_json).sizing).toBe('optimal');
    repo.close();
  });

  it('rejects the same books when optimal sizing is disabled', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const scanner = buildCliffScanner(repo, false);
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBe(0);
    expect(summary.sizingCandidates).toBe(0);
    repo.close();
  });
});
