import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import { planAssetLiquidation } from '../src/asset-liquidation.js';

function market(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    venueId: 'gateio',
    exchangeSymbol: 'ALT/USDT',
    unifiedSymbol: 'ALT/USDT',
    base: 'ALT',
    quote: 'USDT',
    active: true,
    pricePrecision: 4,
    amountPrecision: 2,
    amountStep: new Decimal('0.01'),
    priceStep: new Decimal('0.0001'),
    ...overrides,
  };
}

function book(bids: Array<[string, string]>): OrderBookSnapshot {
  return {
    venueId: 'gateio',
    exchangeSymbol: 'ALT/USDT',
    fetchedAt: 1,
    asks: [],
    bids: bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: 'rest',
  };
}

describe('asset liquidation planning', () => {
  it('plans a full sale at the executable bid depth', () => {
    const plan = planAssetLiquidation({
      free: new Decimal('10.509'),
      market: market(),
      book: book([
        ['2', '5'],
        ['1.99', '10'],
      ]),
      maxSlippageBps: new Decimal(100),
    });
    expect(plan.action).toBe('SELL');
    if (plan.action !== 'SELL') return;
    expect(plan.amount.toFixed()).toBe('10.5');
    expect(plan.limitPrice.toFixed()).toBe('1.99');
    expect(plan.expectedQuote.toFixed()).toBe('20.945');
    expect(Number(plan.expectedVwap.toFixed(8))).toBe(1.9947619);
    expect(plan.slippageBps.toFixed(2)).toBe('26.19');
    expect(plan.partial).toBe(false);
  });

  it('sells only the available depth and marks the plan partial', () => {
    const plan = planAssetLiquidation({
      free: new Decimal('100'),
      market: market(),
      book: book([['2', '40']]),
      maxSlippageBps: new Decimal(100),
    });
    expect(plan.action).toBe('SELL');
    if (plan.action !== 'SELL') return;
    expect(plan.amount.toFixed()).toBe('40');
    expect(plan.expectedQuote.toFixed()).toBe('80');
    expect(plan.partial).toBe(true);
  });

  it('rejects orders below the exchange min notional', () => {
    const plan = planAssetLiquidation({
      free: new Decimal('1'),
      market: market({ minNotional: new Decimal('3') }),
      book: book([['2', '1']]),
      maxSlippageBps: new Decimal(100),
    });
    expect(plan).toEqual({ action: 'SKIP', reason: 'below_min_notional' });
  });

  it('rejects depth that would exceed the slippage cap', () => {
    const plan = planAssetLiquidation({
      free: new Decimal('100'),
      market: market(),
      book: book([
        ['2', '50'],
        ['1', '50'],
      ]),
      maxSlippageBps: new Decimal(100),
    });
    expect(plan).toEqual({ action: 'SKIP', reason: 'slippage_above_limit' });
  });

  it('rejects empty bid books and dust below one amount step', () => {
    expect(
      planAssetLiquidation({
        free: new Decimal('1'),
        market: market(),
        book: book([]),
        maxSlippageBps: new Decimal(100),
      }),
    ).toEqual({ action: 'SKIP', reason: 'bid_side_empty' });
    expect(
      planAssetLiquidation({
        free: new Decimal('0.001'),
        market: market(),
        book: book([['2', '1']]),
        maxSlippageBps: new Decimal(100),
      }),
    ).toEqual({ action: 'SKIP', reason: 'amount_precision_invalid' });
  });
});
