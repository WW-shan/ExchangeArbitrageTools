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

function pepeMarket(venueId: string, alias: boolean): MarketMetadata {
  const exchangeBase = alias ? '1000PEPE' : 'PEPE';
  return {
    venueId,
    exchangeSymbol: `${exchangeBase}/USDT`,
    unifiedSymbol: 'PEPE/USDT',
    base: 'PEPE',
    ...(alias ? { exchangeBase, baseMultiplier: new Decimal(1000) } : {}),
    quote: 'USDT',
    active: true,
    pricePrecision: 9,
    amountPrecision: 1,
    amountStep: new Decimal(1),
    priceStep: alias ? new Decimal('0.0000001') : new Decimal('0.000000001'),
    minAmount: new Decimal(1000),
    minNotional: new Decimal(1),
    feeTakerBps: new Decimal(0),
    supportsIoc: true,
  };
}

function book(
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
    source: 'replay',
  };
}

function adapter(
  venueId: string,
  market: MarketMetadata,
  quotes: { ask: string; bid: string; amount: string },
): CexAdapter {
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
    loadMarkets: async () => [market],
    fetchOrderBook: async () =>
      book(venueId, market.exchangeSymbol, quotes.ask, quotes.bid, quotes.amount),
  };
}

describe('scanner denomination aliases', () => {
  it('discovers and paper-simulates a 1000PEPE -> PEPE route in canonical units', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const gateMarket = pepeMarket('gateio', false);
    const weexMarket = pepeMarket('weex', true);
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', gateMarket, {
          ask: '0.00001010',
          bid: '0.00001005',
          amount: '2000000',
        }),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('weex', weexMarket, {
          ask: '0.00995',
          bid: '0.00990',
          amount: '2000',
        }),
        health: new VenueHealthTracker(),
        markets: [],
      },
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
        maxGasCostUsd: new Decimal(0),
        maxTransferTaxBps: new Decimal(0),
      },
      quoteCurrency: 'USDT',
      quoteCurrencies: ['USDT'],
      assetUniverseMode: 'explicit',
      baseAssets: ['PEPE'],
      maxBaseAssets: 1,
      min24hQuoteVolumeUsd: new Decimal(0),
      requestedNotional: new Decimal(10),
      orderBookDepth: 20,
      maxTriangularPaths: 0,
      maxCandidatesPerCycle: 0,
      paperSimulation: true,
      persistSnapshots: false,
      clock: () => now,
    });

    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBeGreaterThan(0);
    expect(summary.aliasMismatches).toBe(0);

    const loaded = repo.latestValidS1Opportunity();
    expect(loaded).toBeDefined();
    const opportunity = loaded!.opportunity;
    expect(opportunity.venueBuy).toBe('weex');
    expect(opportunity.venueSell).toBe('gateio');
    expect(opportunity.instrumentKey).toBe('PEPE/USDT');
    expect(opportunity.metadata).toMatchObject({
      buyExchangeBase: '1000PEPE',
      sellExchangeBase: 'PEPE',
      buyBaseMultiplier: '1000',
      sellBaseMultiplier: '1',
      buySymbol: '1000PEPE/USDT',
      sellSymbol: 'PEPE/USDT',
    });
    expect(opportunity.netProfitBps.gt(0)).toBe(true);

    const paper = db
      .prepare('SELECT simulated_base_amount, result FROM paper_trades ORDER BY id DESC LIMIT 1')
      .get() as { simulated_base_amount: string; result: string } | undefined;
    expect(paper).toBeDefined();
    expect(new Decimal(paper!.simulated_base_amount).gte('1000000')).toBe(true);
    expect(paper!.result).toBe('CLOSED');
    repo.close();
  });

  it('does not pair alias venues whose normalized prices differ by more than 2%', async () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const gateMarket = pepeMarket('gateio', false);
    const weexMarket = pepeMarket('weex', true);
    const venues: ScannerVenue[] = [
      {
        adapter: adapter('gateio', gateMarket, {
          ask: '0.00001010',
          bid: '0.00001005',
          amount: '2000000',
        }),
        health: new VenueHealthTracker(),
        markets: [],
      },
      {
        adapter: adapter('weex', weexMarket, {
          ask: '0.0199',
          bid: '0.0198',
          amount: '2000',
        }),
        health: new VenueHealthTracker(),
        markets: [],
      },
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
        maxGasCostUsd: new Decimal(0),
        maxTransferTaxBps: new Decimal(0),
      },
      quoteCurrency: 'USDT',
      quoteCurrencies: ['USDT'],
      assetUniverseMode: 'explicit',
      baseAssets: ['PEPE'],
      maxBaseAssets: 1,
      min24hQuoteVolumeUsd: new Decimal(0),
      requestedNotional: new Decimal(10),
      orderBookDepth: 20,
      maxTriangularPaths: 0,
      maxCandidatesPerCycle: 0,
      persistSnapshots: false,
      clock: () => now,
    });
    await scanner.initialize();
    const summary = await scanner.scanOnce();
    expect(summary.validOpportunities).toBe(0);
    expect(summary.s1Count).toBe(0);
    expect(summary.aliasMismatches).toBe(1);
    repo.close();
  });
});
