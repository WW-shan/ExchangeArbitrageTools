import { describe, expect, it } from 'vitest';
import { Decimal, type CostSettings, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import { analyzeS1Capacity, type CapacityFeeScenario } from '../src/capacity.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.01'),
  safetyBufferBps: new Decimal(2),
  minNetProfitBps: new Decimal(5),
  maxOrderbookAgeMs: 10_000,
  maxSlippageBps: new Decimal(30),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
  suspiciousSpreadBps: new Decimal(200),
  maxPriceDeviationBps: new Decimal(500),
  maxPairSkewMs: 5000,
};

function market(
  venueId: string,
  symbol: string,
  minNotional = '3',
  minAmount = '1',
): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: symbol,
    unifiedSymbol: 'TEST/USDT',
    base: 'TEST',
    quote: 'USDT',
    active: true,
    pricePrecision: 5,
    amountPrecision: 2,
    amountStep: new Decimal('0.01'),
    priceStep: new Decimal('0.00001'),
    minNotional: new Decimal(minNotional),
    minAmount: new Decimal(minAmount),
    feeTakerBps: new Decimal(10),
  };
}

function book(
  venueId: string,
  symbol: string,
  bids: Array<[string, string]>,
  asks: Array<[string, string]>,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: symbol,
    fetchedAt: now,
    bids: bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    asks: asks.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: 'rest',
  };
}

function scenario(buyTakerBps: string, sellTakerBps: string): CapacityFeeScenario {
  return {
    label: 'actual',
    buyTakerBps: new Decimal(buyTakerBps),
    sellTakerBps: new Decimal(sellTakerBps),
  };
}

describe('S1 capacity analysis', () => {
  it('finds break-even and eligible notional from the visible depth', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: book(
        'gateio',
        'TEST/USDT',
        [['0.99', '100']],
        [
          ['1.00', '100'],
          ['1.01', '100'],
        ],
      ),
      sellBook: book(
        'hotcoin',
        'TEST/USDT',
        [
          ['1.05', '50'],
          ['1.04', '100'],
        ],
        [['1.06', '100']],
      ),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(200),
      step: new Decimal(1),
      probes: [new Decimal(1), new Decimal(3), new Decimal(5), new Decimal(50), new Decimal(150)],
    });
    const actual = result.scenarios[0]!;
    expect(result.topGrossBps?.toFixed()).toBe('500');
    expect(actual.feeBreakEvenBps.toFixed()).toBe('20');
    expect(actual.eligibleThresholdBps.toFixed()).toBe('27');
    expect(actual.maxFeeBreakEvenNotional?.toFixed()).toBe('150.5');
    expect(actual.maxProfitableNotional?.toFixed()).toBe('150.5');
    expect(actual.maxEligibleNotional?.toFixed()).toBe('150.5');
    expect(actual.bindingReason).toBe('depth');
    const five = actual.curve.find((point) => point.requestedNotional.eq(5));
    expect(five?.valid).toBe(true);
    expect(five?.grossBps.toFixed()).toBe('500');
  });

  it('keeps below-minimum sizes visible but marks them non-executable', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: book('gateio', 'TEST/USDT', [['0.99', '100']], [['1.00', '100']]),
      sellBook: book('hotcoin', 'TEST/USDT', [['1.05', '100']], [['1.06', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal('0.5'),
      maxNotional: new Decimal(20),
      step: new Decimal(1),
      probes: [new Decimal(1), new Decimal(5)],
    });
    const actual = result.scenarios[0]!;
    const one = actual.curve.find((point) => point.requestedNotional.eq(1));
    expect(one?.executable).toBe(false);
    expect(one?.reasons).toContain('below_min_notional');
    expect(actual.minExecutableNotional?.toFixed()).toBe('3.5');
  });

  it('reports fee_floor when the gross spread cannot cover both taker fees', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: book('gateio', 'TEST/USDT', [['0.999', '100']], [['1.00', '100']]),
      sellBook: book('hotcoin', 'TEST/USDT', [['1.001', '100']], [['1.002', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(20),
      step: new Decimal(1),
      probes: [new Decimal(5)],
    });
    const actual = result.scenarios[0]!;
    expect(actual.maxFeeBreakEvenNotional).toBeUndefined();
    expect(actual.maxEligibleNotional).toBeUndefined();
    expect(actual.bindingReason).toBe('fee_floor');
  });

  it('marks an exchange-timestamp-stale book and refuses capacity', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: {
        ...book('gateio', 'TEST/USDT', [['0.99', '100']], [['1.00', '100']]),
        exchangeTimestamp: now - 20_000,
      },
      sellBook: book('hotcoin', 'TEST/USDT', [['1.05', '100']], [['1.06', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(20),
      step: new Decimal(1),
      probes: [new Decimal(5)],
    });
    const actual = result.scenarios[0]!;
    expect(result.flags).toContain('stale_book');
    expect(actual.maxEligibleNotional).toBeUndefined();
    expect(actual.bindingReason).toBe('stale_book');
  });

  it('does not invent capacity when the sell book is too shallow', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT', '5', '0'),
      sellMarket: market('hotcoin', 'TEST/USDT', '5', '0'),
      buyBook: book('gateio', 'TEST/USDT', [['0.99', '100']], [['1.00', '100']]),
      sellBook: book('hotcoin', 'TEST/USDT', [['1.05', '1']], [['1.06', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(20),
      step: new Decimal(1),
      probes: [new Decimal(5)],
    });
    const actual = result.scenarios[0]!;
    expect(actual.depth.maxBaseAmount.toFixed()).toBe('1');
    expect(actual.maxFeeBreakEvenNotional).toBeUndefined();
    expect(actual.bindingReason).toBe('depth');
  });

  it('caps eligible notional by the buy-venue quote balance after fees', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: book('gateio', 'TEST/USDT', [['0.99', '100']], [['1.00', '100']]),
      sellBook: book('hotcoin', 'TEST/USDT', [['1.05', '100']], [['1.06', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(200),
      step: new Decimal(1),
      probes: [new Decimal(5), new Decimal(50), new Decimal(150)],
      buyQuoteFree: new Decimal(50),
      sellBaseFree: new Decimal(1000),
    });
    const actual = result.scenarios[0]!;
    expect(actual.balanceInputsComplete).toBe(true);
    expect(actual.maxBalanceNotional?.lte(50)).toBe(true);
    expect(actual.maxEligibleNotional?.lte(50)).toBe(true);
    expect(actual.balanceBinding).toBe('buy_quote');
    expect(actual.bindingReason).toBe('balance');
  });

  it('caps eligible notional by sell-venue base inventory at the buy ask', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: book('gateio', 'TEST/USDT', [['0.99', '100']], [['1.00', '100']]),
      sellBook: book('hotcoin', 'TEST/USDT', [['1.05', '100']], [['1.06', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(200),
      step: new Decimal(1),
      probes: [new Decimal(5), new Decimal(30), new Decimal(150)],
      buyQuoteFree: new Decimal(1000),
      sellBaseFree: new Decimal(30),
    });
    const actual = result.scenarios[0]!;
    expect(actual.maxBalanceNotional?.toFixed()).toBe('30');
    expect(actual.maxEligibleNotional?.lte(30)).toBe(true);
    expect(actual.balanceBinding).toBe('sell_base');
    expect(actual.bindingReason).toBe('balance');
  });

  it('marks capacity as financially incomplete when one balance is missing', () => {
    const result = analyzeS1Capacity({
      base: 'TEST',
      quote: 'USDT',
      buyMarket: market('gateio', 'TEST/USDT'),
      sellMarket: market('hotcoin', 'TEST/USDT'),
      buyBook: book('gateio', 'TEST/USDT', [['0.99', '100']], [['1.00', '100']]),
      sellBook: book('hotcoin', 'TEST/USDT', [['1.05', '100']], [['1.06', '100']]),
      settings,
      now,
      scenarios: [scenario('10', '10')],
      minNotional: new Decimal(1),
      maxNotional: new Decimal(20),
      step: new Decimal(1),
      probes: [new Decimal(5)],
      buyQuoteFree: new Decimal(10),
    });
    const actual = result.scenarios[0]!;
    expect(actual.balanceInputsComplete).toBe(false);
    expect(result.flags).toContain('balance_incomplete');
    expect(actual.maxEligibleNotional?.lte(10)).toBe(true);
  });
});
