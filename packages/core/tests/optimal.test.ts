import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  evaluateCrossVenuePathOptimal,
  evaluateS1Direction,
  evaluateS1DirectionOptimal,
  evaluateTriangularPath,
  evaluateTriangularPathOptimal,
  searchOptimalNotional,
  type CostSettings,
  type CrossVenuePath,
  type MarketMetadata,
  type OrderBookSnapshot,
  type TriangularEdge,
  type TriangularPath,
} from '../src/index.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.05'),
  safetyBufferBps: new Decimal(10),
  minNetProfitBps: new Decimal(5),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};

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
  asks: Array<[string, string]>,
  bids: Array<[string, string]>,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: `${base}/${quote}`,
    fetchedAt: now,
    asks: asks.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    bids: bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: 'replay',
  };
}

describe('optimal notional search', () => {
  it('finds the interior maximum of a concave profit curve', () => {
    const result = searchOptimalNotional({
      minNotional: new Decimal(1),
      maxNotional: new Decimal(30),
      step: new Decimal('0.1'),
      samples: 16,
      refineLevels: 3,
      refineSamples: 10,
      evaluate: (notional) => {
        const distance = notional.minus(10);
        return {
          conservativeNetProfit: distance.mul(distance).neg().plus(5),
          valid: true,
          rejectionReasons: [],
        };
      },
    });
    expect(result.notional.minus(10).abs().lte(new Decimal('0.3'))).toBe(true);
    expect(result.boundary).toBe('interior');
    expect(result.evaluated).toBeGreaterThan(10);
  });

  it('respects min and max boundaries', () => {
    const decreasing = searchOptimalNotional({
      minNotional: new Decimal(2),
      maxNotional: new Decimal(20),
      step: new Decimal('0.01'),
      evaluate: (notional) => ({
        conservativeNetProfit: notional.neg(),
        valid: true,
        rejectionReasons: [],
      }),
    });
    expect(decreasing.notional.toFixed()).toBe('2');
    expect(decreasing.boundary).toBe('min');

    const increasing = searchOptimalNotional({
      minNotional: new Decimal(2),
      maxNotional: new Decimal(20),
      step: new Decimal('0.01'),
      evaluate: (notional) => ({
        conservativeNetProfit: notional,
        valid: true,
        rejectionReasons: [],
      }),
    });
    expect(increasing.notional.toFixed()).toBe('20');
    expect(increasing.boundary).toBe('max');
  });

  it('treats depth failures as hard rejections', () => {
    const result = searchOptimalNotional({
      minNotional: new Decimal(1),
      maxNotional: new Decimal(20),
      step: new Decimal('0.01'),
      evaluate: (notional) => ({
        conservativeNetProfit: notional,
        valid: notional.lte(5),
        rejectionReasons: notional.lte(5) ? [] : ['insufficient_depth'],
      }),
    });
    expect(result.feasible).toBe(true);
    expect(result.notional.lte(new Decimal('5.01'))).toBe(true);
  });
});

describe('strategy optimal sizing', () => {
  it('sizes an S1 direction below the depth cliff', () => {
    const buyMarket = market('gateio', 'CAKE', 'USDT');
    const sellMarket = market('mexc', 'CAKE', 'USDT');
    const buyBook = book(
      'gateio',
      'CAKE',
      'USDT',
      [
        ['2.5', '4'],
        ['2.6', '100'],
      ],
      [['2.49', '100']],
    );
    const sellBook = book(
      'mexc',
      'CAKE',
      'USDT',
      [['2.57', '100']],
      [
        ['2.55', '4'],
        ['2.50', '100'],
      ],
    );
    const fixed = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket,
      sellMarket,
      buyBook,
      sellBook,
      requestedNotional: new Decimal(30),
      settings,
      now,
      venueHealth: { gateio: 'A', mexc: 'A' },
    });
    const optimal = evaluateS1DirectionOptimal({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket,
      sellMarket,
      buyBook,
      sellBook,
      maxNotional: new Decimal(30),
      minNotional: new Decimal(1),
      step: new Decimal('0.01'),
      settings,
      now,
      venueHealth: { gateio: 'A', mexc: 'A' },
    });
    expect(optimal.valid).toBe(true);
    expect(optimal.requestedNotional.gt(new Decimal(8))).toBe(true);
    expect(optimal.requestedNotional.lt(new Decimal(11))).toBe(true);
    expect(optimal.conservativeNetProfit.gt(fixed.conservativeNetProfit)).toBe(true);
    expect(optimal.metadata?.sizing).toBe('optimal');
  });

  it('sizes an S2 path before the bid level drops', () => {
    const bnbUsdt = market('gateio', 'BNB', 'USDT');
    const cakeBnb = market('gateio', 'CAKE', 'BNB');
    const cakeUsdt = market('gateio', 'CAKE', 'USDT');
    const edges: TriangularEdge[] = [
      { market: bnbUsdt, book: book('gateio', 'BNB', 'USDT', [['500', '100']], [['499', '100']]) },
      { market: cakeBnb, book: book('gateio', 'CAKE', 'BNB', [['5', '100']], [['4.9', '100']]) },
      {
        market: cakeUsdt,
        book: book(
          'gateio',
          'CAKE',
          'USDT',
          [['3010', '100']],
          [
            ['3001', '0.001'],
            ['2500', '100'],
          ],
        ),
      },
    ];
    const path: TriangularPath = {
      currencies: ['USDT', 'BNB', 'CAKE', 'USDT'],
      edges,
    };
    const fixed = evaluateTriangularPath(path, new Decimal(30), settings, now, 'A');
    const optimal = evaluateTriangularPathOptimal(path, new Decimal(30), settings, now, 'A', {
      minNotional: new Decimal(1),
      step: new Decimal('0.01'),
    });
    expect(optimal.requestedNotional.lt(new Decimal(10))).toBe(true);
    expect(optimal.conservativeNetProfit.gt(fixed.conservativeNetProfit)).toBe(true);
  });

  it('caps cross-venue sizing at the start-venue inventory', () => {
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
          book: book('gateio', 'CAKE', 'USDT', [['2.5', '100']], [['2.49', '100']]),
          side: 'buy',
          rate: new Decimal('0.4'),
        },
        {
          kind: 'inventory',
          from: { venueId: 'gateio', currency: 'CAKE' },
          to: { venueId: 'mecx', currency: 'CAKE' },
          available: new Decimal('100'),
        },
        {
          kind: 'trade',
          from: { venueId: 'mecx', currency: 'CAKE' },
          to: { venueId: 'mecx', currency: 'USDT' },
          market: mecxMarket,
          book: book('mecx', 'CAKE', 'USDT', [['2.57', '100']], [['2.55', '100']]),
          side: 'sell',
          rate: new Decimal('2.55'),
        },
      ],
      estimatedReturn: new Decimal('0.01'),
      venueSwitches: 1,
      startAvailable: new Decimal(12),
    };
    const optimal = evaluateCrossVenuePathOptimal(
      path,
      new Decimal(30),
      settings,
      now,
      {
        gateio: 'A',
        mecx: 'A',
      },
      { minNotional: new Decimal(1), step: new Decimal('0.01') },
    );
    expect(optimal.valid).toBe(true);
    expect(optimal.requestedNotional.lte(new Decimal('12.01'))).toBe(true);
    expect(optimal.metadata?.sizing).toBe('optimal');
  });
});
