import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  evaluateS1Direction,
  evaluateS1Preparation,
  type CostSettings,
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

function market(venueId: string, symbol: string, feeBps = '10', makerBps?: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: symbol,
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
    feeTakerBps: new Decimal(feeBps),
    ...(makerBps ? { makerFeeBps: new Decimal(makerBps) } : {}),
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

describe('S1 opportunity evaluation', () => {
  it('accepts a profitable trade only after fees and the safety buffer', () => {
    const result = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: book('gateio', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B' as const, mexc: 'B' as const },
    });
    expect(result.valid).toBe(true);
    expect(result.conservativeNetProfit.gt(0)).toBe(true);
    expect(result.netProfitBps.gte(20)).toBe(true);
    expect(result.buyDepth?.insufficientDepth).toBe(false);
  });

  it('allows a bounded negative-edge inventory preparation', () => {
    const preparationSettings: CostSettings = {
      ...settings,
      minProfitUsd: new Decimal(0),
      safetyBufferBps: new Decimal(0),
      minNetProfitBps: new Decimal(0),
    };
    const buyMarket = {
      ...market('gateio', 'CAKE/USDT', '1'),
      pricePrecision: 5,
      priceStep: new Decimal('0.00001'),
    };
    const sellMarket = {
      ...market('mexc', 'CAKE/USDT', '1'),
      pricePrecision: 5,
      priceStep: new Decimal('0.00001'),
    };
    const input = {
      base: 'CAKE',
      quote: 'USDT',
      buyMarket,
      sellMarket,
      buyBook: book('gateio', '2.50000', '2.49000'),
      sellBook: book('mexc', '2.51000', '2.49950'),
      requestedNotional: new Decimal('10'),
      settings: preparationSettings,
      now,
      venueHealth: { gateio: 'B' as const, mexc: 'B' as const },
    };
    const allowed = evaluateS1Preparation(input, {
      maxCostBps: new Decimal(5),
      maxCostUsd: new Decimal('0.01'),
    });
    expect(allowed.valid).toBe(true);
    expect(allowed.metadata?.intent).toBe('inventory_preparation');
    expect(new Decimal(allowed.metadata?.preparationCostBps ?? '999').lte(5)).toBe(true);

    const rejected = evaluateS1Preparation(input, {
      maxCostBps: new Decimal(1),
      maxCostUsd: new Decimal('0.01'),
    });
    expect(rejected.valid).toBe(false);
    expect(rejected.rejectionReasons).toContain('preparation_cost_above_limit');
  });

  it('rejects stale data and insufficient depth', () => {
    const staleBook = book('gateio', '2.500', '2.490');
    staleBook.fetchedAt = now - 10_000;
    const stale = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: staleBook,
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(stale.valid).toBe(false);
    expect(stale.rejectionReasons).toContain('stale_orderbook');

    const shallow = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: {
        ...book('gateio', '2.500', '2.490'),
        asks: [{ price: new Decimal('2.500'), amount: new Decimal('1') }],
      },
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(shallow.valid).toBe(false);
    expect(shallow.rejectionReasons).toContain('insufficient_depth');
  });

  it('rejects an order book whose venue does not match the market', () => {
    const result = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: book('binance', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('invalid_orderbook');
  });

  it('rejects markets whose base or quote identity differs from the requested pair', () => {
    const wrongBase = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: { ...market('gateio', 'CAKE/USDT'), base: 'ETH' },
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: book('gateio', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(wrongBase.valid).toBe(false);
    expect(wrongBase.rejectionReasons).toContain('quote_mismatch');

    const wrongQuote = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: { ...market('mexc', 'CAKE/USDT'), quote: 'USDC' },
      buyBook: book('gateio', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(wrongQuote.valid).toBe(false);
    expect(wrongQuote.rejectionReasons).toContain('quote_mismatch');
  });

  it('marks a fresh fetch with an old exchange timestamp as stale', () => {
    const result = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: {
        ...book('gateio', '2.500', '2.490'),
        exchangeTimestamp: now - 10_000,
      },
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('stale_orderbook');
  });

  it('rejects an executable price that is off the venue tick grid', () => {
    const result = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: book('gateio', '2.5001', '2.490'),
      sellBook: book('mexc', '2.560', '2.5501'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('price_precision_invalid');
  });

  it('fails closed on inactive markets, invalid notionals, and invalid fees', () => {
    const base = {
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: market('gateio', 'CAKE/USDT'),
      sellMarket: market('mexc', 'CAKE/USDT'),
      buyBook: book('gateio', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B' as const, mexc: 'B' as const },
    };
    const inactive = evaluateS1Direction({
      ...base,
      buyMarket: { ...base.buyMarket, active: false },
    });
    expect(inactive.valid).toBe(false);
    expect(inactive.rejectionReasons).toContain('market_inactive');

    const badNotional = evaluateS1Direction({
      ...base,
      requestedNotional: new Decimal(Number.NaN),
    });
    expect(badNotional.valid).toBe(false);
    expect(badNotional.rejectionReasons).toContain('invalid_request');

    const badFee = evaluateS1Direction({
      ...base,
      buyMarket: { ...base.buyMarket, feeTakerBps: new Decimal(Number.POSITIVE_INFINITY) },
    });
    expect(badFee.valid).toBe(false);
    expect(badFee.rejectionReasons).toContain('fee_not_configured');

    const zeroFees = evaluateS1Direction({
      ...base,
      buyMarket: { ...base.buyMarket, feeTakerBps: new Decimal(0) },
      sellMarket: { ...base.sellMarket, feeTakerBps: new Decimal(0) },
    });
    expect(zeroFees.valid).toBe(true);

    const badPriceStep = evaluateS1Direction({
      ...base,
      buyMarket: { ...base.buyMarket, priceStep: new Decimal(0) },
    });
    expect(badPriceStep.valid).toBe(false);
    expect(badPriceStep.rejectionReasons).toContain('price_precision_invalid');

    const negativeThreshold = evaluateS1Direction({
      ...base,
      settings: { ...settings, minNetProfitBps: new Decimal(-1) },
    });
    expect(negativeThreshold.valid).toBe(false);
    expect(negativeThreshold.rejectionReasons).toContain('invalid_request');
  });
});

describe('S1 liquidity and rebalance costs', () => {
  const base = {
    base: 'CAKE',
    quote: 'USDT',
    buyMarket: market('gateio', 'CAKE/USDT'),
    sellMarket: market('mexc', 'CAKE/USDT'),
    buyBook: book('gateio', '2.500', '2.490'),
    sellBook: book('mexc', '2.560', '2.550'),
    requestedNotional: new Decimal('30'),
    settings,
    now,
    venueHealth: { gateio: 'B' as const, mexc: 'B' as const },
  };

  it('rejects a book that lacks the configured top-depth quantity', () => {
    const thin = evaluateS1Direction({
      ...base,
      requestedNotional: new Decimal('10'),
      buyBook: {
        ...book('gateio', '2.500', '2.490'),
        asks: [{ price: new Decimal('2.500'), amount: new Decimal('10') }],
      },
      sellBook: {
        ...book('mexc', '2.560', '2.550'),
        bids: [{ price: new Decimal('2.550'), amount: new Decimal('10') }],
      },
      settings: { ...settings, minTopDepthQty: new Decimal('50'), liquidityTopLevels: 5 },
    });
    expect(thin.valid).toBe(false);
    expect(thin.rejectionReasons).toContain('liquidity_below_minimum');
  });

  it('subtracts the rebalance cost from S1 net profit', () => {
    const withoutRebalance = evaluateS1Direction(base);
    const withRebalance = evaluateS1Direction({
      ...base,
      settings: { ...settings, rebalanceCostBps: new Decimal('200') },
    });
    expect(withoutRebalance.valid).toBe(true);
    expect(withoutRebalance.metadata?.rebalanceCostUsd).toBe('0');
    expect(withRebalance.valid).toBe(false);
    expect(withRebalance.rejectionReasons).toContain('gross_profit_below_threshold');
    expect(withRebalance.metadata?.rebalanceCostUsd).toBe('0.6');
    expect(withRebalance.conservativeNetProfit.lt(withoutRebalance.conservativeNetProfit)).toBe(
      true,
    );
  });
});

describe('S1 fee modes', () => {
  const tightSettings: CostSettings = {
    minProfitUsd: new Decimal('0.01'),
    safetyBufferBps: new Decimal(0),
    minNetProfitBps: new Decimal(1),
    maxOrderbookAgeMs: 3000,
    maxSlippageBps: new Decimal(50),
    maxGasCostUsd: new Decimal('0.50'),
    maxTransferTaxBps: new Decimal(0),
  };
  const input = {
    base: 'CAKE',
    quote: 'USDT',
    buyMarket: market('gateio', 'CAKE/USDT', '10', '-2'),
    sellMarket: market('mexc', 'CAKE/USDT', '10', '5'),
    buyBook: book('gateio', '2.500', '2.490'),
    sellBook: book('mexc', '2.510', '2.504'),
    requestedNotional: new Decimal('30'),
    now,
    venueHealth: { gateio: 'B' as const, mexc: 'B' as const },
  };

  it('turns a taker-negative route positive with a maker rebate', () => {
    const taker = evaluateS1Direction({ ...input, settings: tightSettings });
    expect(taker.valid).toBe(false);
    expect(taker.rejectionReasons).toContain('gross_profit_below_threshold');
    const maker = evaluateS1Direction({
      ...input,
      settings: { ...tightSettings, executionMode: 'maker_buy_taker_sell' },
    });
    expect(maker.valid).toBe(true);
    expect(maker.metadata?.makerLeg).toBe('buy');
    expect(maker.metadata?.executionMode).toBe('maker_buy_taker_sell');
  });

  it('fails closed when the maker fee is not configured', () => {
    const missingMaker = evaluateS1Direction({
      ...input,
      buyMarket: market('gateio', 'CAKE/USDT', '10'),
      settings: { ...tightSettings, executionMode: 'maker_buy_taker_sell' },
    });
    expect(missingMaker.valid).toBe(false);
    expect(missingMaker.rejectionReasons).toContain('fee_not_configured');
  });

  it('scales expected profit by maker fill probability', () => {
    const full = evaluateS1Direction({
      ...input,
      settings: { ...tightSettings, executionMode: 'maker_buy_taker_sell' },
    });
    const partial = evaluateS1Direction({
      ...input,
      settings: {
        ...tightSettings,
        executionMode: 'maker_buy_taker_sell',
        makerFillProbability: new Decimal('0.2'),
      },
    });
    expect(full.valid).toBe(true);
    expect(partial.conservativeNetProfit.lt(full.conservativeNetProfit)).toBe(true);
    expect(partial.metadata?.fillProbability).toBe('0.2');
  });
});

describe('S1 real-opportunity filters', () => {
  const base = {
    base: 'CAKE',
    quote: 'USDT',
    buyMarket: market('gateio', 'CAKE/USDT'),
    sellMarket: market('mexc', 'CAKE/USDT'),
    buyBook: book('gateio', '2.500', '2.490'),
    sellBook: book('mexc', '2.560', '2.550'),
    requestedNotional: new Decimal('30'),
    now,
    venueHealth: { gateio: 'B' as const, mexc: 'B' as const },
  };

  it('rejects a price that is far from the cross-venue median', () => {
    const result = evaluateS1Direction({
      ...base,
      settings: { ...settings, maxPriceDeviationBps: new Decimal(100) },
      referenceMidPrice: new Decimal('2.0'),
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('price_outlier');
  });

  it('rejects an implausibly wide spread', () => {
    const result = evaluateS1Direction({
      ...base,
      settings: { ...settings, suspiciousSpreadBps: new Decimal(50) },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('suspicious_spread');
  });

  it('rejects legs whose timestamps are too far apart', () => {
    const buyBook = book('gateio', '2.500', '2.490');
    buyBook.receivedAt = now - 2000;
    const sellBook = book('mexc', '2.560', '2.550');
    sellBook.receivedAt = now;
    const result = evaluateS1Direction({
      ...base,
      buyBook,
      sellBook,
      settings: { ...settings, maxPairSkewMs: 1000 },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('pair_skew_too_high');
  });

  it('rejects a venue below the reliability floor', () => {
    const result = evaluateS1Direction({
      ...base,
      settings: { ...settings, minReliabilityScore: new Decimal('0.3') },
      venueReliability: { gateio: new Decimal('0.2'), mexc: new Decimal('0.9') },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('venue_reliability_low');
  });

  it('treats zero minimum amount and notional as unset', () => {
    const zeroMarket = (venueId: string): MarketMetadata => ({
      ...market(venueId, 'CAKE/USDT'),
      minAmount: new Decimal(0),
      minNotional: new Decimal(0),
    });
    const result = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: zeroMarket('gateio'),
      sellMarket: zeroMarket('mexc'),
      buyBook: book('gateio', '2.500', '2.490'),
      sellBook: book('mexc', '2.560', '2.550'),
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(result.valid).toBe(true);
    expect(result.rejectionReasons).not.toContain('invalid_request');
  });
});
