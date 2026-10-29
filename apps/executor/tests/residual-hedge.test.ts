import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import {
  evaluateResidualHedgeCandidate,
  evaluateShortResidualHedgeCandidate,
} from '../src/residual-hedge.js';

const market: MarketMetadata = {
  venueId: 'bitget',
  exchangeSymbol: 'WARD/USDT',
  unifiedSymbol: 'WARD/USDT',
  base: 'WARD',
  quote: 'USDT',
  active: true,
  pricePrecision: 6,
  amountPrecision: 2,
  amountStep: new Decimal('0.01'),
  priceStep: new Decimal('0.000001'),
  minAmount: new Decimal('0.01'),
  minNotional: new Decimal('1'),
  feeTakerBps: new Decimal('10'),
};

function book(): OrderBookSnapshot {
  return {
    venueId: 'bitget',
    exchangeSymbol: 'WARD/USDT',
    fetchedAt: 1_700_000_000_000,
    bids: [
      { price: new Decimal('0.0055'), amount: new Decimal('100') },
      { price: new Decimal('0.0054'), amount: new Decimal('1000') },
    ],
    asks: [{ price: new Decimal('0.0056'), amount: new Decimal('1000') }],
    source: 'rest',
  };
}

describe('residual hedge planning', () => {
  it('uses the worst consumed bid and charges the gross fee', () => {
    const candidate = evaluateResidualHedgeCandidate({
      venueId: 'bitget',
      market,
      book: book(),
      residualCanonical: new Decimal('500'),
      costPerCanonical: new Decimal('0.004'),
      freeBase: new Decimal('1000'),
      grossFeeBps: new Decimal('10'),
      minProfitUsd: new Decimal('0.01'),
    });
    expect(candidate).toBeDefined();
    expect(candidate!.exchangeAmount.toFixed()).toBe('500');
    expect(candidate!.exchangePrice.toFixed()).toBe('0.0054');
    expect(candidate!.executableQuote.toFixed()).toBe('2.71');
    expect(candidate!.grossFeeQuote.toFixed()).toBe('0.00271');
    expect(candidate!.projectedProfit.toFixed()).toBe('0.70729');
  });

  it('aligns down to the venue amount step and caps at free base', () => {
    const candidate = evaluateResidualHedgeCandidate({
      venueId: 'bitget',
      market,
      book: book(),
      residualCanonical: new Decimal('500.019'),
      costPerCanonical: new Decimal('0.004'),
      freeBase: new Decimal('500.009'),
      grossFeeBps: new Decimal('10'),
      minProfitUsd: new Decimal('0.01'),
    });
    expect(candidate).toBeDefined();
    expect(candidate!.exchangeAmount.toFixed()).toBe('500');
    expect(candidate!.canonicalAmount.toFixed()).toBe('500');
  });

  it('fails closed when the projected profit is below the rescue floor', () => {
    expect(
      evaluateResidualHedgeCandidate({
        venueId: 'bitget',
        market,
        book: book(),
        residualCanonical: new Decimal('500'),
        costPerCanonical: new Decimal('0.0056'),
        freeBase: new Decimal('1000'),
        grossFeeBps: new Decimal('10'),
        minProfitUsd: new Decimal('0.01'),
      }),
    ).toBeUndefined();
  });

  it('fails closed instead of closing a residual it cannot fully sell', () => {
    expect(
      evaluateResidualHedgeCandidate({
        venueId: 'bitget',
        market,
        book: book(),
        residualCanonical: new Decimal('500'),
        costPerCanonical: new Decimal('0.004'),
        freeBase: new Decimal('400'),
        grossFeeBps: new Decimal('10'),
        minProfitUsd: new Decimal('0.01'),
      }),
    ).toBeUndefined();
  });

  it('buys back a short residual using the worst consumed ask and quote cash', () => {
    const candidate = evaluateShortResidualHedgeCandidate({
      venueId: 'bitget',
      market,
      book: book(),
      residualCanonical: new Decimal('500'),
      proceedsPerCanonical: new Decimal('0.006'),
      freeQuote: new Decimal('1000'),
      grossFeeBps: new Decimal('10'),
      minProfitUsd: new Decimal('0.01'),
    });
    expect(candidate).toBeDefined();
    expect(candidate!.direction).toBe('short');
    expect(candidate!.exchangeAmount.toFixed()).toBe('500.51');
    expect(candidate!.exchangePrice.toFixed()).toBe('0.0056');
    expect(candidate!.executableQuote.toFixed()).toBe('2.802856');
    expect(candidate!.grossFeeQuote.toFixed()).toBe('0.002802856');
    expect(candidate!.netHedgeQuote.toFixed()).toBe('2.805658856');
    expect(candidate!.projectedProfit.toFixed()).toBe('0.194398084');
  });

  it('fails closed when quote cash cannot cover the short buyback', () => {
    expect(
      evaluateShortResidualHedgeCandidate({
        venueId: 'bitget',
        market,
        book: book(),
        residualCanonical: new Decimal('500'),
        proceedsPerCanonical: new Decimal('0.006'),
        freeQuote: new Decimal('2'),
        grossFeeBps: new Decimal('10'),
        minProfitUsd: new Decimal('0.01'),
      }),
    ).toBeUndefined();
  });
});
