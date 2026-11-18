import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/money.js';
import { detectDislocation } from '../src/dislocation.js';
import { evaluateDislocationOpportunity } from '../src/dislocation-opportunity.js';
import type { CostSettings, MarketMetadata, OrderBookSnapshot } from '../src/types.js';

const now = 1_795_029_845_702;

function market(venueId: string, base = 'IR'): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: `${base}/USDT`,
    unifiedSymbol: `${base}/USDT`,
    base,
    quote: 'USDT',
    active: true,
    pricePrecision: 6,
    amountPrecision: 2,
    amountStep: new Decimal('0.01'),
    priceStep: new Decimal('0.000001'),
    minAmount: new Decimal('0.01'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal('2'),
    makerFeeBps: new Decimal('2'),
  };
}

function book(
  venueId: string,
  bid: string,
  ask: string,
  size = '100000',
  base = 'IR',
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: `${base}/USDT`,
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal(size) }],
    bids: [{ price: new Decimal(bid), amount: new Decimal(size) }],
    source: 'rest',
  };
}

const settings: CostSettings = {
  minProfitUsd: new Decimal('0.005'),
  safetyBufferBps: new Decimal(2),
  minNetProfitBps: new Decimal(5),
  maxOrderbookAgeMs: 20_000,
  maxSlippageBps: new Decimal(30),
  maxGasCostUsd: new Decimal('0.5'),
  maxTransferTaxBps: new Decimal(0),
  // These are the S1 guards that must NOT apply to a dislocation.
  suspiciousSpreadBps: new Decimal(1000),
  maxPriceDeviationBps: new Decimal(1000),
};

describe('evaluateDislocationOpportunity', () => {
  it('executes the real IR/USDT spike that S1 rejected', () => {
    // Bitget ask 0.002736 -> Gate bid 0.002724 is the calm state. The spike
    // printed Bitget cheap and Gate expensive by >1,200 bps.
    const buyBook = book('bitget', '0.002728', '0.002730');
    const sellBook = book('gateio', '0.003060', '0.003070');
    const signal = detectDislocation({
      left: { venueId: 'bitget', bid: new Decimal('0.002728'), ask: new Decimal('0.002730'), timestamp: now },
      right: { venueId: 'gateio', bid: new Decimal('0.003060'), ask: new Decimal('0.003070'), timestamp: now },
      leftBaseline: { median: new Decimal('0.002736'), samples: 30, ageMs: 1000 },
      rightBaseline: { median: new Decimal('0.002735'), samples: 30, ageMs: 1000 },
      now,
      settings: {
        minDislocationBps: new Decimal(500),
        minVenueDeviationBps: new Decimal(300),
        maxCounterDeviationBps: new Decimal(150),
        maxQuoteAgeMs: 30_000,
        maxBaselineAgeMs: 300_000,
        minBaselineSamples: 5,
        maxRepeatCount: 8,
      },
    });
    expect(signal.isDislocation).toBe(true);
    expect(signal.magnitudeBps.toNumber()).toBeGreaterThan(1000);

    const opportunity = evaluateDislocationOpportunity({
      base: 'IR',
      quote: 'USDT',
      buyMarket: market('bitget'),
      sellMarket: market('gateio'),
      buyBook,
      sellBook,
      signal,
      requestedNotional: new Decimal(10),
      settings,
      now,
    });

    expect(opportunity.strategy).toBe('DISLOCATION');
    expect(opportunity.rejectionReasons).not.toContain('suspicious_spread');
    expect(opportunity.rejectionReasons).not.toContain('price_outlier');
    expect(opportunity.valid).toBe(true);
    expect(opportunity.netProfitBps.toNumber()).toBeGreaterThan(1000);
    expect(opportunity.metadata?.dislocationKind).toBe('spike');
  });

  it('never admits a signal the detector rejected', () => {
    const buyBook = book('bitget', '0.002728', '0.002730');
    const sellBook = book('gateio', '0.003060', '0.003070');
    // Both venues are far from their own baseline: a repricing, not a spike.
    const signal = detectDislocation({
      left: { venueId: 'bitget', bid: new Decimal('0.002728'), ask: new Decimal('0.002730'), timestamp: now },
      right: { venueId: 'gateio', bid: new Decimal('0.003060'), ask: new Decimal('0.003070'), timestamp: now },
      leftBaseline: { median: new Decimal('0.002000'), samples: 30, ageMs: 1000 },
      rightBaseline: { median: new Decimal('0.002000'), samples: 30, ageMs: 1000 },
      now,
      settings: {
        minDislocationBps: new Decimal(500),
        minVenueDeviationBps: new Decimal(300),
        maxCounterDeviationBps: new Decimal(150),
        maxQuoteAgeMs: 30_000,
        maxBaselineAgeMs: 300_000,
        minBaselineSamples: 5,
        maxRepeatCount: 8,
      },
    });
    expect(signal.isDislocation).toBe(false);

    const opportunity = evaluateDislocationOpportunity({
      base: 'IR',
      quote: 'USDT',
      buyMarket: market('bitget'),
      sellMarket: market('gateio'),
      buyBook,
      sellBook,
      signal,
      requestedNotional: new Decimal(10),
      settings,
      now,
    });
    expect(opportunity.valid).toBe(false);
    expect(opportunity.rejectionReasons).toContain('suspicious_spread');
  });

  it('still enforces the normal profit floor', () => {
    const buyBook = book('bitget', '0.002728', '0.002730');
    const sellBook = book('gateio', '0.002731', '0.002735');
    const signal = detectDislocation({
      left: { venueId: 'bitget', bid: new Decimal('0.002728'), ask: new Decimal('0.002730'), timestamp: now },
      right: { venueId: 'gateio', bid: new Decimal('0.002731'), ask: new Decimal('0.002735'), timestamp: now },
      leftBaseline: { median: new Decimal('0.002736'), samples: 30, ageMs: 1000 },
      rightBaseline: { median: new Decimal('0.002735'), samples: 30, ageMs: 1000 },
      now,
      settings: {
        minDislocationBps: new Decimal(500),
        minVenueDeviationBps: new Decimal(300),
        maxCounterDeviationBps: new Decimal(150),
        maxQuoteAgeMs: 30_000,
        maxBaselineAgeMs: 300_000,
        minBaselineSamples: 5,
        maxRepeatCount: 8,
      },
    });
    expect(signal.isDislocation).toBe(false);

    const opportunity = evaluateDislocationOpportunity({
      base: 'IR',
      quote: 'USDT',
      buyMarket: market('bitget'),
      sellMarket: market('gateio'),
      buyBook,
      sellBook,
      signal,
      requestedNotional: new Decimal(10),
      settings,
      now,
    });
    expect(opportunity.valid).toBe(false);
  });
});