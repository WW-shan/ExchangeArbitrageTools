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
    makerFeeBps: new Decimal('8'),
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
      privateBalances: false,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      websocket: false,
      ioc: true,
      fok: false,
    },
    loadMarkets: async () => [market(venueId)],
    fetchOrderBook: async () => book(venueId, '2.5', '2.49'),
  };
}

describe('scanner fee overrides', () => {
  it('applies configured taker and maker fees per venue', async () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    const venues: ScannerVenue[] = [
      { adapter: adapter('gateio'), health: new VenueHealthTracker(), markets: [] },
      { adapter: adapter('mexc'), health: new VenueHealthTracker(), markets: [] },
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
      feeOverrides: {
        gateio: { takerBps: new Decimal('2'), makerBps: new Decimal('-1') },
      },
      clock: () => now,
    });
    await scanner.initialize();
    expect(venues[0]!.markets[0]!.feeTakerBps?.toFixed()).toBe('2');
    expect(venues[0]!.markets[0]!.makerFeeBps?.toFixed()).toBe('-1');
    expect(venues[1]!.markets[0]!.feeTakerBps?.toFixed()).toBe('10');
    repo.close();
  });
});
