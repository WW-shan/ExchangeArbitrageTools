import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  calculateBuyDepthByQuote,
  calculateSellDepthByBase,
  alignAmountDown,
  alignToCommonAmountStep,
  ceilToStep,
  isAligned,
  resolveStep,
  validateOrderBook,
  bookFeedLatencyMs,
  type OrderBookSnapshot,
} from '../src/index.js';

const now = 1_700_000_000_000;

function book(asks: Array<[string, string]>, bids: Array<[string, string]>): OrderBookSnapshot {
  return {
    venueId: 'test',
    exchangeSymbol: 'CAKE/USDT',
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

describe('depth', () => {
  it('walks multiple ask levels without floating point drift', () => {
    const result = calculateBuyDepthByQuote(
      book(
        [
          ['2.5', '2'],
          ['3', '10'],
        ],
        [['2.4', '10']],
      ),
      new Decimal('9'),
    );
    expect(result.insufficientDepth).toBe(false);
    expect(result.executableBaseAmount.toFixed()).toBe('3.333333333333333333333333333333333333333');
    expect(result.executableQuoteAmount.toFixed()).toBe('9');
    expect(result.worstPrice.toFixed()).toBe('3');
    expect(result.levelsConsumed).toBe(2);
  });

  it('reports insufficient depth rather than inventing liquidity', () => {
    const result = calculateSellDepthByBase(
      book([['2.5', '10']], [['2.4', '1']]),
      new Decimal('2'),
    );
    expect(result.insufficientDepth).toBe(true);
    expect(result.executableBaseAmount.toFixed()).toBe('1');
  });
});

describe('precision', () => {
  it('never rounds an amount up', () => {
    expect(alignAmountDown(new Decimal('1.239999'), new Decimal('0.01')).toFixed()).toBe('1.23');
  });

  it('converts precision digits to steps and rejects invalid rules', () => {
    expect(resolveStep({ amountPrecision: 3 }).amountStep.toFixed()).toBe('0.001');
    expect(resolveStep({ pricePrecision: 2 }).priceStep.toFixed()).toBe('0.01');
    expect(() => resolveStep({ amountPrecision: -1 })).toThrow(/invalid precision/);
    expect(() => resolveStep({ pricePrecision: 31 })).toThrow(/invalid precision/);
    expect(() => resolveStep({ amountStep: new Decimal(0) })).toThrow(/positive and finite/);
    expect(() => resolveStep({ priceStep: new Decimal(Number.POSITIVE_INFINITY) })).toThrow(
      /positive and finite/,
    );
  });

  it('aligns prices and amounts without exceeding the requested value', () => {
    expect(ceilToStep(new Decimal('1.231'), new Decimal('0.01')).toFixed()).toBe('1.24');
    expect(alignAmountDown(new Decimal('1.239'), new Decimal('0.01')).toFixed()).toBe('1.23');
    expect(
      alignToCommonAmountStep(
        new Decimal('1.2399'),
        new Decimal('0.01'),
        new Decimal('0.005'),
      ).toFixed(),
    ).toBe('1.23');
    expect(isAligned(new Decimal('1.23'), new Decimal('0.01'))).toBe(true);
    expect(isAligned(new Decimal('1.231'), new Decimal('0.01'))).toBe(false);
    expect(() => alignAmountDown(new Decimal(1), new Decimal(0))).toThrow(/step must be positive/);
  });
});

describe('order book validation', () => {
  it('merges duplicate levels and accepts a fresh, sorted book', () => {
    const result = validateOrderBook(
      book(
        [
          ['2.5', '1'],
          ['2.5', '2'],
          ['2.6', '1'],
        ],
        [['2.4', '3']],
      ),
      { maxAgeMs: 3000, now },
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.book.asks[0]?.amount.toFixed()).toBe('3');
  });

  it('rejects stale and crossed books', () => {
    const stale = validateOrderBook(
      { ...book([['2.5', '1']], [['2.4', '1']]), fetchedAt: now - 5000 },
      { maxAgeMs: 3000, now },
    );
    const crossed = validateOrderBook(book([['2.5', '1']], [['2.6', '1']]), {
      maxAgeMs: 3000,
      now,
    });
    expect(stale.valid).toBe(false);
    expect(crossed.valid).toBe(false);
    if (!crossed.valid) expect(crossed.reasons).toContain('crossed_orderbook');
  });

  it('rejects a book returned by a different venue', () => {
    const mismatch = validateOrderBook(book([['2.5', '1']], [['2.4', '1']]), {
      expectedVenueId: 'gateio',
      maxAgeMs: 3000,
      now,
    });
    expect(mismatch.valid).toBe(false);
    if (!mismatch.valid) expect(mismatch.reasons).toContain('venue_mismatch');
  });

  it('rejects high feed latency, frozen books, and sequence gaps', () => {
    const base = book([['2.5', '1']], [['2.4', '1']]);
    const highLatency = validateOrderBook(
      { ...base, receivedAt: now, exchangeTimestamp: now - 2000 },
      { maxAgeMs: 10_000, now, maxFeedLatencyMs: 500 },
    );
    expect(highLatency.valid).toBe(false);
    if (!highLatency.valid) expect(highLatency.reasons).toContain('feed_latency_too_high');

    const frozen = validateOrderBook(
      { ...base, receivedAt: now - 6000, exchangeTimestamp: now - 6000 },
      { maxAgeMs: 10_000, now, maxFreezeMs: 5000 },
    );
    expect(frozen.valid).toBe(false);
    if (!frozen.valid) expect(frozen.reasons).toContain('frozen_orderbook');

    const gap = validateOrderBook(
      { ...base, sequence: 10 },
      { maxAgeMs: 3000, now, previousSequence: 5, strictSequence: true },
    );
    expect(gap.valid).toBe(false);
    if (!gap.valid) expect(gap.reasons).toContain('sequence_gap');

    const duplicate = validateOrderBook(
      { ...base, sequence: 5 },
      { maxAgeMs: 3000, now, previousSequence: 5 },
    );
    expect(duplicate.valid).toBe(false);
    if (!duplicate.valid) expect(duplicate.reasons).toContain('sequence_not_increasing');

    const missing = validateOrderBook(base, {
      maxAgeMs: 3000,
      now,
      requireExchangeTimestamp: true,
    });
    expect(missing.valid).toBe(false);
    if (!missing.valid) expect(missing.reasons).toContain('exchange_timestamp_missing');
  });

  it('exposes feed latency from exchange and receive timestamps', () => {
    const latency = bookFeedLatencyMs({
      ...book([['2.5', '1']], [['2.4', '1']]),
      receivedAt: now,
      exchangeTimestamp: now - 120,
    });
    expect(latency).toBe(120);
  });
});
