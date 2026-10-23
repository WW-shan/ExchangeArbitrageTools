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

function wsAdapter(venueId: string, ask: string, bid: string, onRest: () => void): CexAdapter {
  return {
    venueId,
    tier: 'S',
    capabilities: capabilities(),
    loadMarkets: async () => [market(venueId)],
    fetchOrderBook: async () => {
      onRest();
      throw new Error('rest should not be used');
    },
    watchOrderBook: async (_symbol, _depth, onBook, signal) => {
      const book: OrderBookSnapshot = {
        venueId,
        exchangeSymbol: 'CAKE/USDT',
        fetchedAt: now,
        receivedAt: now,
        asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
        bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
        source: 'websocket',
      };
      onBook(book);
      await waitAbort(signal);
    },
  };
}

describe('scanner websocket feed', () => {
  it('uses fresh websocket books instead of REST', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    let restCalls = 0;
    const venues: ScannerVenue[] = [
      {
        adapter: wsAdapter('gateio', '2.500', '2.490', () => {
          restCalls += 1;
        }),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: wsAdapter('mexc', '2.560', '2.550', () => {
          restCalls += 1;
        }),
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
      paperSimulation: false,
      feedMode: 'websocket',
      wsMaxBookAgeMs: 5000,
      clock: () => now,
    });
    await scanner.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBeGreaterThanOrEqual(1);
    expect(restCalls).toBe(0);
    await scanner.close();
    repo.close();
  });

  it('subscribes only to bases shared by at least two venues', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const watched: Record<string, string[]> = { gateio: [], mexc: [] };
    const makeMarket = (venueId: string, base: string): MarketMetadata => ({
      ...market(venueId),
      exchangeSymbol: `${base}/USDT`,
      unifiedSymbol: `${base}/USDT`,
      base,
    });
    const adapter = (venueId: string, bases: string[]): CexAdapter => ({
      venueId,
      tier: 'S',
      capabilities: capabilities(),
      loadMarkets: async () => bases.map((base) => makeMarket(venueId, base)),
      fetchOrderBook: async () => {
        throw new Error('rest should not be used during subscription setup');
      },
      watchOrderBook: async (symbol, _depth, _onBook, signal) => {
        watched[venueId]!.push(symbol);
        await waitAbort(signal);
      },
    });
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', ['CAKE', 'AAA']),
        health: new VenueHealthTracker(),
        markets: [],
      },
      { adapter: adapter('mexc', ['CAKE', 'BBB']), health: new VenueHealthTracker(), markets: [] },
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
      baseAssets: ['CAKE', 'AAA', 'BBB'],
      assetUniverseMode: 'explicit',
      requestedNotional: new Decimal(30),
      orderBookDepth: 50,
      maxTriangularPaths: 0,
      persistSnapshots: false,
      paperSimulation: false,
      feedMode: 'websocket',
      wsMaxBookAgeMs: 5000,
      clock: () => now,
    });
    await scanner.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(watched.gateio).toContain('CAKE/USDT');
    expect(watched.mexc).toContain('CAKE/USDT');
    expect(watched.gateio).not.toContain('AAA/USDT');
    expect(watched.mexc).not.toContain('BBB/USDT');
    await scanner.close();
    repo.close();
  });
});
