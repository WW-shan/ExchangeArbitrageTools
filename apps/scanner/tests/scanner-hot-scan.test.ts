import { describe, expect, it } from 'vitest';
import {
  Decimal,
  VenueHealthTracker,
  type MarketMetadata,
  type OpportunityResult,
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

interface ControllableAdapter {
  adapter: CexAdapter;
  setPrices: (bid: string, ask: string) => void;
  emitNearDepthChange: () => void;
  emitDeepChange: () => void;
}

function controllableAdapter(venueId: string, bid: string, ask: string): ControllableAdapter {
  let currentBid = bid;
  let currentAsk = ask;
  let nearAmount = '100';
  let farAmount = '100';
  let emit: ((book: OrderBookSnapshot) => void) | undefined;
  const snapshot = (): OrderBookSnapshot => ({
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: now,
    receivedAt: now,
    bids: [
      { price: new Decimal(currentBid), amount: new Decimal('100') },
      { price: new Decimal(currentBid).minus('0.1'), amount: new Decimal(nearAmount) },
      { price: new Decimal(currentBid).minus('0.2'), amount: new Decimal('100') },
      { price: new Decimal(currentBid).minus('0.3'), amount: new Decimal(farAmount) },
    ],
    asks: [{ price: new Decimal(currentAsk), amount: new Decimal('100') }],
    source: 'websocket',
  });
  return {
    adapter: {
      venueId,
      tier: 'S',
      capabilities: capabilities(),
      loadMarkets: async () => [market(venueId)],
      fetchOrderBook: async () => {
        throw new Error('REST must not be used by the hot path');
      },
      watchOrderBook: async (_symbol, _depth, onBook, signal) => {
        emit = onBook;
        onBook(snapshot());
        await waitAbort(signal);
      },
    },
    setPrices: (nextBid, nextAsk) => {
      currentBid = nextBid;
      currentAsk = nextAsk;
      emit?.(snapshot());
    },
    emitNearDepthChange: () => {
      nearAmount = String(Number(nearAmount) + 1);
      emit?.(snapshot());
    },
    emitDeepChange: () => {
      farAmount = String(Number(farAmount) + 1);
      emit?.(snapshot());
    },
  };
}

describe('scanner event-driven hot path', () => {
  it('evaluates only books that changed and wakes on a WebSocket update', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const gateio = controllableAdapter('gateio', '2.49', '2.50');
    const mexc = controllableAdapter('mexc', '2.59', '2.60');
    const venues: ScannerVenue[] = [
      { adapter: gateio.adapter, health: new VenueHealthTracker(), markets: [] },
      { adapter: mexc.adapter, health: new VenueHealthTracker(), markets: [] },
    ];
    const scanner = new ScannerService({
      venues,
      repository: repo,
      settings: {
        minProfitUsd: new Decimal(0),
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
      assetUniverseMode: 'explicit',
      requestedNotional: new Decimal(10),
      orderBookDepth: 50,
      maxTriangularPaths: 0,
      persistSnapshots: false,
      paperSimulation: false,
      feedMode: 'websocket',
      wsMaxBookAgeMs: 5000,
      wsMaxSubscriptions: 10,
      hotScanDebounceMs: 0,
      clock: () => now,
    });
    await scanner.initialize();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const first = await scanner.scanUpdates({ maxWaitMs: 50, debounceMs: 0 });
    expect(first).toBeDefined();
    expect(first!.dirtyBooks).toBeGreaterThanOrEqual(1);
    expect(first!.booksFetched).toBe(2);
    expect(first!.s1Count).toBeGreaterThanOrEqual(1);
    expect(first!.validOpportunities).toBeGreaterThanOrEqual(1);

    const idle = await scanner.scanUpdates({ maxWaitMs: 5, debounceMs: 0 });
    expect(idle).toBeUndefined();

    gateio.emitDeepChange();
    const unchangedBbo = await scanner.scanUpdates({ maxWaitMs: 5, debounceMs: 0 });
    expect(unchangedBbo).toBeUndefined();

    gateio.emitNearDepthChange();
    const depthChanged = await scanner.scanUpdates({ maxWaitMs: 5, debounceMs: 0 });
    expect(depthChanged).toBeDefined();
    expect(depthChanged!.dirtyBooks).toBe(1);

    mexc.setPrices('2.70', '2.71');
    const second = await scanner.scanUpdates({ maxWaitMs: 50, debounceMs: 0 });
    expect(second).toBeDefined();
    expect(second!.dirtyBooks).toBe(1);
    expect(second!.dirtyGroups).toBe(1);
    expect(second!.booksFetched).toBe(2);
    expect(second!.s1Count).toBeGreaterThanOrEqual(1);
    expect(second!.validOpportunities).toBeGreaterThanOrEqual(1);

    await scanner.close();
    repo.close();
  });

  it('seeds hot subscriptions from recent valid route stats', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const seeded: OpportunityResult = {
      strategy: 'S1',
      opportunityKey: 'S1|CAKE/USDT|gateio|mexc',
      instrumentKey: 'CAKE/USDT',
      direction: 'gateio->mexc',
      venueBuy: 'gateio',
      venueSell: 'mexc',
      instrumentBuy: 'CAKE/USDT',
      instrumentSell: 'CAKE/USDT',
      requestedNotional: new Decimal(10),
      grossSpread: new Decimal(0.1),
      totalCost: new Decimal(0.01),
      depthNetProfit: new Decimal(0.09),
      conservativeNetProfit: new Decimal(0.08),
      netProfitBps: new Decimal(10),
      dataAgeMs: 10,
      valid: true,
      rejectionReasons: [],
      sampledAt: now,
    };
    repo.recordOpportunity(seeded, 15_000);
    const gateio = controllableAdapter('gateio', '2.49', '2.50');
    const mexc = controllableAdapter('mexc', '2.59', '2.60');
    const venues: ScannerVenue[] = [
      { adapter: gateio.adapter, health: new VenueHealthTracker(), markets: [] },
      { adapter: mexc.adapter, health: new VenueHealthTracker(), markets: [] },
    ];
    const scanner = new ScannerService({
      venues,
      repository: repo,
      settings: {
        minProfitUsd: new Decimal(0),
        safetyBufferBps: new Decimal(0),
        minNetProfitBps: new Decimal(0),
        maxOrderbookAgeMs: 3000,
        maxSlippageBps: new Decimal(50),
        maxGasCostUsd: new Decimal('0.50'),
        maxTransferTaxBps: new Decimal(0),
      },
      quoteCurrency: 'USDT',
      baseAssets: ['CAKE'],
      assetUniverseMode: 'explicit',
      requestedNotional: new Decimal(10),
      orderBookDepth: 50,
      maxTriangularPaths: 0,
      persistSnapshots: false,
      paperSimulation: false,
      feedMode: 'websocket',
      wsMaxBookAgeMs: 5000,
      wsMaxSubscriptions: 10,
      hotSeedEnabled: true,
      hotSeedLookbackMs: 60_000,
      hotSeedLimit: 10,
      hotSeedTtlMs: 60_000,
      clock: () => now,
    });
    await scanner.initialize();
    expect(scanner.hotSymbols()).toEqual(['gateio|CAKE/USDT', 'mexc|CAKE/USDT']);
    await scanner.close();
    repo.close();
  });
});
