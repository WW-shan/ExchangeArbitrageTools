import type { Decimal } from 'decimal.js';
import type { Level, OrderBookSnapshot } from './types.js';

export interface OrderBookValidationOptions {
  expectedVenueId?: string;
  expectedSymbol?: string;
  maxAgeMs: number;
  now?: number;
  maxFutureSkewMs?: number;
  maxFeedLatencyMs?: number;
  maxFreezeMs?: number;
  previousSequence?: number;
  strictSequence?: boolean;
  requireExchangeTimestamp?: boolean;
}

export type OrderBookValidation =
  { valid: true; book: OrderBookSnapshot; reasons: [] } | { valid: false; reasons: string[] };

export function bookReceivedAt(book: OrderBookSnapshot): number {
  return book.receivedAt ?? book.fetchedAt;
}

export function bookFeedLatencyMs(book: OrderBookSnapshot): number | undefined {
  if (book.exchangeTimestamp === undefined) return undefined;
  return Math.max(0, bookReceivedAt(book) - book.exchangeTimestamp);
}

function mergeLevels(levels: readonly Level[], side: 'bids' | 'asks'): Level[] {
  const merged = new Map<string, Level>();
  for (const level of levels) {
    const key = level.price.toFixed();
    const existing = merged.get(key);
    merged.set(key, {
      price: level.price,
      amount: existing ? existing.amount.plus(level.amount) : level.amount,
    });
  }
  return [...merged.values()].sort((a, b) =>
    side === 'bids' ? b.price.comparedTo(a.price) : a.price.comparedTo(b.price),
  );
}

function validateSide(levels: readonly Level[], side: 'bids' | 'asks', reasons: string[]): void {
  if (levels.length === 0) {
    reasons.push(`${side}_empty`);
    return;
  }
  let previous: Decimal | undefined;
  for (const level of levels) {
    if (!level.price.isFinite() || level.price.lte(0)) {
      reasons.push(`${side}_invalid_price`);
      return;
    }
    if (!level.amount.isFinite() || level.amount.lte(0)) {
      reasons.push(`${side}_invalid_amount`);
      return;
    }
    if (previous) {
      const sorted = side === 'bids' ? level.price.lte(previous) : level.price.gte(previous);
      if (!sorted) {
        reasons.push(`${side}_not_sorted`);
        return;
      }
    }
    previous = level.price;
  }
}

export function validateOrderBook(
  book: OrderBookSnapshot,
  options: OrderBookValidationOptions,
): OrderBookValidation {
  const reasons: string[] = [];
  const now = options.now ?? Date.now();
  const receivedAt = bookReceivedAt(book);
  if (options.expectedVenueId && book.venueId !== options.expectedVenueId) {
    reasons.push('venue_mismatch');
  }
  if (options.expectedSymbol && book.exchangeSymbol !== options.expectedSymbol) {
    reasons.push('symbol_mismatch');
  }
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) {
    reasons.push('fetched_at_invalid');
  } else {
    const age = now - receivedAt;
    if (age > options.maxAgeMs || age < -(options.maxFutureSkewMs ?? 250)) {
      reasons.push('stale_orderbook');
    }
    if (options.maxFreezeMs !== undefined && age > options.maxFreezeMs) {
      reasons.push('frozen_orderbook');
    }
  }
  if (options.requireExchangeTimestamp && book.exchangeTimestamp === undefined) {
    reasons.push('exchange_timestamp_missing');
  }
  if (book.exchangeTimestamp !== undefined) {
    if (!Number.isFinite(book.exchangeTimestamp) || book.exchangeTimestamp <= 0) {
      reasons.push('exchange_timestamp_invalid');
    } else {
      const exchangeAge = now - book.exchangeTimestamp;
      if (exchangeAge > options.maxAgeMs || exchangeAge < -(options.maxFutureSkewMs ?? 250)) {
        reasons.push('exchange_timestamp_stale');
      }
      const feedLatency = receivedAt - book.exchangeTimestamp;
      if (options.maxFeedLatencyMs !== undefined && feedLatency > options.maxFeedLatencyMs) {
        reasons.push('feed_latency_too_high');
      }
    }
  }
  if (book.sequence !== undefined) {
    if (!Number.isFinite(book.sequence) || book.sequence < 0) {
      reasons.push('sequence_invalid');
    } else if (options.previousSequence !== undefined) {
      if (book.sequence <= options.previousSequence) {
        reasons.push('sequence_not_increasing');
      } else if (options.strictSequence && book.sequence > options.previousSequence + 1) {
        reasons.push('sequence_gap');
      }
    }
  }

  validateSide(book.bids, 'bids', reasons);
  validateSide(book.asks, 'asks', reasons);
  if (reasons.length > 0) {
    return { valid: false, reasons };
  }

  const bids = mergeLevels(book.bids, 'bids');
  const asks = mergeLevels(book.asks, 'asks');
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (!bestBid || !bestAsk) {
    return { valid: false, reasons: ['orderbook_empty'] };
  }
  if (bestBid.price.gte(bestAsk.price)) {
    return { valid: false, reasons: ['crossed_orderbook'] };
  }

  return {
    valid: true,
    reasons: [],
    book: {
      ...book,
      bids,
      asks,
      source: book.source,
    },
  };
}
