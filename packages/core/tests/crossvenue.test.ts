import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  buildCrossVenueGraph,
  enumerateCrossVenuePaths,
  evaluateCrossVenuePath,
  simulateCrossVenuePath,
  type CostSettings,
  type CrossVenuePath,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '../src/index.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};
const health = { gateio: 'A', mecx: 'A', weex: 'A' } as const;

function market(venueId: string, base: string, quote: string, fee = '10'): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: `${base}/${quote}`,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
    active: true,
    pricePrecision: 6,
    amountPrecision: 6,
    amountStep: new Decimal('0.000001'),
    priceStep: new Decimal('0.000001'),
    minAmount: new Decimal('0.000001'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal(fee),
    supportsIoc: true,
  };
}

function book(
  venueId: string,
  base: string,
  quote: string,
  ask: string,
  bid: string,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: `${base}/${quote}`,
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100000') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100000') }],
    source: 'replay',
  };
}

function twoVenueGraph(withDestinationInventory: boolean) {
  const gateioMarket = market('gateio', 'CAKE', 'USDT');
  const mecxMarket = market('mecx', 'CAKE', 'USDT');
  return buildCrossVenueGraph({
    markets: [
      {
        venueId: 'gateio',
        market: gateioMarket,
        book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
      },
      { venueId: 'mecx', market: mecxMarket, book: book('mecx', 'CAKE', 'USDT', '2.560', '2.550') },
    ],
    balances: [
      { venueId: 'gateio', currency: 'USDT', free: new Decimal('1000') },
      ...(withDestinationInventory
        ? [{ venueId: 'mecx', currency: 'CAKE', free: new Decimal('100') }]
        : []),
    ],
  });
}

const startAvailability = new Map([['gateio', new Decimal('1000')]]);

describe('cross-venue inventory discovery', () => {
  it('finds and validates a two-venue inventory path', () => {
    const graph = twoVenueGraph(true);
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 1,
      maxLegsPerNode: 4,
      maxPaths: 50,
    });
    expect(paths.length).toBeGreaterThan(0);
    const target = paths.find(
      (path) =>
        path.nodes.map((node) => node.venueId).join('>') === 'gateio>gateio>mecx>mecx' &&
        path.nodes.map((node) => node.currency).join('>') === 'USDT>CAKE>CAKE>USDT',
    );
    expect(target).toBeDefined();
    const result = evaluateCrossVenuePath(target!, new Decimal(30), settings, now, health);
    expect({ valid: result.valid, reasons: result.rejectionReasons }).toEqual({
      valid: true,
      reasons: [],
    });
    expect(result.conservativeNetProfit.gt(0)).toBe(true);
    expect(result.metadata?.variant).toBe('cross_venue_inventory');
    expect(result.metadata?.venueSwitches).toBe('1');
    expect(result.metadata?.pathClass).toBe('two_venue_bridge');
    for (const path of paths) {
      const marketKeys = path.legs
        .filter((leg) => leg.kind === 'trade')
        .map((leg) => `${leg.market.venueId}|${leg.market.exchangeSymbol}`);
      expect(new Set(marketKeys).size).toBe(marketKeys.length);
      expect(path.legs.some((leg) => leg.kind === 'inventory')).toBe(true);
    }
  });

  it('does not invent a path without destination inventory', () => {
    const graph = twoVenueGraph(false);
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 1,
      maxPaths: 50,
    });
    expect(paths).toEqual([]);
  });

  it('rejects a path whose destination inventory is too small', () => {
    const gateioMarket = market('gateio', 'CAKE', 'USDT');
    const mecxMarket = market('mecx', 'CAKE', 'USDT');
    const path: CrossVenuePath = {
      nodes: [
        { venueId: 'gateio', currency: 'USDT' },
        { venueId: 'gateio', currency: 'CAKE' },
        { venueId: 'mecx', currency: 'CAKE' },
        { venueId: 'mecx', currency: 'USDT' },
      ],
      legs: [
        {
          kind: 'trade',
          from: { venueId: 'gateio', currency: 'USDT' },
          to: { venueId: 'gateio', currency: 'CAKE' },
          market: gateioMarket,
          book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
          side: 'buy',
          rate: new Decimal('0.4'),
        },
        {
          kind: 'inventory',
          from: { venueId: 'gateio', currency: 'CAKE' },
          to: { venueId: 'mecx', currency: 'CAKE' },
          available: new Decimal('1'),
        },
        {
          kind: 'trade',
          from: { venueId: 'mecx', currency: 'CAKE' },
          to: { venueId: 'mecx', currency: 'USDT' },
          market: mecxMarket,
          book: book('mecx', 'CAKE', 'USDT', '2.560', '2.550'),
          side: 'sell',
          rate: new Decimal('2.55'),
        },
      ],
      estimatedReturn: new Decimal('0.01'),
      venueSwitches: 1,
      startAvailable: new Decimal('1000'),
    };
    const result = evaluateCrossVenuePath(path, new Decimal(30), settings, now, health);
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('insufficient_inventory');
  });

  it('honours the venue-switch limit and requires a funded start venue', () => {
    const graph = twoVenueGraph(true);
    const noSwitch = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 0,
      maxPaths: 50,
    });
    expect(noSwitch).toEqual([]);

    const unfunded = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['mecx'],
      startAvailableByVenue: new Map([['mecx', new Decimal('0')]]),
      maxHops: 5,
      maxVenueSwitches: 1,
      maxPaths: 50,
    });
    expect(unfunded).toEqual([]);
  });

  it('does not emit single-venue triangular loops as cross-venue paths', () => {
    const cakeUsdt = market('gateio', 'CAKE', 'USDT');
    const bnbUsdt = market('gateio', 'BNB', 'USDT');
    const cakeBnb = market('gateio', 'CAKE', 'BNB');
    const graph = buildCrossVenueGraph({
      markets: [
        {
          venueId: 'gateio',
          market: cakeUsdt,
          book: book('gateio', 'CAKE', 'USDT', '3001', '3000'),
        },
        { venueId: 'gateio', market: bnbUsdt, book: book('gateio', 'BNB', 'USDT', '500', '499') },
        { venueId: 'gateio', market: cakeBnb, book: book('gateio', 'CAKE', 'BNB', '5', '4.9') },
      ],
      balances: [{ venueId: 'gateio', currency: 'USDT', free: new Decimal('1000') }],
    });
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 2,
      maxPaths: 50,
    });
    expect(paths).toEqual([]);
  });

  it('enumerates a three-venue, two-switch inventory chain', () => {
    const graph = buildCrossVenueGraph({
      markets: [
        {
          venueId: 'gateio',
          market: market('gateio', 'CAKE', 'USDT'),
          book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
        },
        {
          venueId: 'mecx',
          market: market('mecx', 'CAKE', 'BNB'),
          book: book('mecx', 'CAKE', 'BNB', '0.100', '0.099'),
        },
        {
          venueId: 'weex',
          market: market('weex', 'BNB', 'USDT'),
          book: book('weex', 'BNB', 'USDT', '500', '499'),
        },
      ],
      balances: [
        { venueId: 'gateio', currency: 'USDT', free: new Decimal('1000') },
        { venueId: 'mecx', currency: 'CAKE', free: new Decimal('100') },
        { venueId: 'weex', currency: 'BNB', free: new Decimal('100') },
      ],
    });
    const paths = enumerateCrossVenuePaths(graph, {
      startCurrency: 'USDT',
      startVenues: ['gateio'],
      startAvailableByVenue: startAvailability,
      maxHops: 5,
      maxVenueSwitches: 2,
      maxLegsPerNode: 4,
      maxPaths: 50,
    });
    const chain = paths.find(
      (path) =>
        path.venueSwitches === 2 &&
        path.nodes.map((node) => node.currency).join('>') === 'USDT>CAKE>CAKE>BNB>BNB>USDT',
    );
    expect(chain).toBeDefined();
    const result = evaluateCrossVenuePath(chain!, new Decimal(30), settings, now, health);
    expect(result.valid).toBe(true);
    expect(result.conservativeNetProfit.gt(0)).toBe(true);
    expect(result.metadata?.tradeVenues).toBe('gateio>mecx>weex');
    expect(result.metadata?.pathClass).toBe('multi_hop');
  });

  it('rejects malformed paths that reuse a market or lack a venue switch', () => {
    const gateioMarket = market('gateio', 'CAKE', 'USDT');
    const trade = {
      kind: 'trade' as const,
      from: { venueId: 'gateio', currency: 'USDT' },
      to: { venueId: 'gateio', currency: 'CAKE' },
      market: gateioMarket,
      book: book('gateio', 'CAKE', 'USDT', '2.500', '2.490'),
      side: 'buy' as const,
      rate: new Decimal('0.4'),
    };
    const path: CrossVenuePath = {
      nodes: [
        { venueId: 'gateio', currency: 'USDT' },
        { venueId: 'gateio', currency: 'CAKE' },
        { venueId: 'gateio', currency: 'USDT' },
      ],
      legs: [trade, { ...trade, side: 'sell', from: trade.to, to: trade.from }],
      estimatedReturn: new Decimal('0.01'),
      venueSwitches: 0,
      startAvailable: new Decimal('1000'),
    };
    const simulation = simulateCrossVenuePath(path, new Decimal(30), settings, now, true);
    expect(simulation.reasons).toContain('quote_mismatch');
  });
});
