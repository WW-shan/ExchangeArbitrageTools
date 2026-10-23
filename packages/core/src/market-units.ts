import { Decimal, ONE } from './money.js';
import type { MarketMetadata, OrderBookSnapshot } from './types.js';

/**
 * Hyperliquid-style k-contracts that are quoted in units of 1000 underlying
 * tokens. Keep this list explicit: stripping an arbitrary leading "k" would
 * mis-map real assets such as KAITO.
 */
const EXPLICIT_K_ALIASES = new Set(['KPEPE', 'KSHIB', 'KBONK', 'KLUNC', 'KFLOKI', 'KNEIRO']);

export const ALIAS_PRICE_TOLERANCE_BPS = new Decimal(200);

export interface BaseUnits {
  /** Canonical underlying asset, e.g. PEPE. */
  base: string;
  /** Canonical units represented by one venue base unit. */
  multiplier: Decimal;
  /** True when the venue base is a known denomination alias. */
  alias: boolean;
}

function checkedMultiplier(value: Decimal | undefined, label: string): Decimal {
  if (value === undefined) return ONE;
  if (!value.isFinite() || value.lte(0)) {
    throw new Error(`invalid base multiplier for ${label}`);
  }
  return value;
}

/** Resolve a venue base asset to the canonical S1 unit. */
export function resolveBaseUnits(exchangeBase: string): BaseUnits {
  const raw = exchangeBase.trim();
  if (raw === '') throw new Error('base asset is required');
  const upper = raw.toUpperCase();
  if (EXPLICIT_K_ALIASES.has(upper)) {
    return { base: upper.slice(1), multiplier: new Decimal(1000), alias: true };
  }
  if (upper.startsWith('1000') && upper.length > 4) {
    return { base: upper.slice(4), multiplier: new Decimal(1000), alias: true };
  }
  return { base: upper, multiplier: ONE, alias: false };
}

/** Venue currency code used by balances and order endpoints. */
export function marketExchangeBase(market: Pick<MarketMetadata, 'base' | 'exchangeBase'>): string {
  return market.exchangeBase ?? market.base;
}

export function marketBaseMultiplier(
  market: Pick<MarketMetadata, 'base' | 'exchangeBase' | 'baseMultiplier' | 'exchangeSymbol'>,
): Decimal {
  return checkedMultiplier(
    market.baseMultiplier,
    `${market.exchangeSymbol}${market.exchangeBase ?? market.base}`,
  );
}

export function marketUsesBaseMultiplier(market: MarketMetadata): boolean {
  return !marketBaseMultiplier(market).eq(1);
}

/**
 * Produce a market view whose prices are quote/canonical-base and whose sizes
 * are canonical-base units. The returned object is safe to pass to S1 and
 * paper evaluation; keep the original market for order formatting and balance
 * lookup.
 */
export function canonicalMarketForEvaluation(market: MarketMetadata): MarketMetadata {
  const multiplier = marketBaseMultiplier(market);
  if (multiplier.eq(1)) return market;
  return {
    ...market,
    ...(market.amountStep ? { amountStep: market.amountStep.mul(multiplier) } : {}),
    ...(market.minAmount ? { minAmount: market.minAmount.mul(multiplier) } : {}),
    ...(market.priceStep ? { priceStep: market.priceStep.div(multiplier) } : {}),
    exchangeBase: marketExchangeBase(market),
    baseMultiplier: ONE,
  };
}

/** Convert a venue order book into canonical base units. */
export function normalizeBookForMarket(
  book: OrderBookSnapshot,
  market: MarketMetadata,
): OrderBookSnapshot {
  const multiplier = marketBaseMultiplier(market);
  if (multiplier.eq(1)) return book;
  const levels = (rows: OrderBookSnapshot['asks']) =>
    rows.map((level) => ({
      price: level.price.div(multiplier),
      amount: level.amount.mul(multiplier),
    }));
  return {
    ...book,
    asks: levels(book.asks),
    bids: levels(book.bids),
  };
}

export function exchangeAmountFromCanonical(amount: Decimal, multiplier: Decimal): Decimal {
  if (!multiplier.isFinite() || multiplier.lte(0)) throw new Error('invalid base multiplier');
  return amount.div(multiplier);
}

export function canonicalAmountFromExchange(amount: Decimal, multiplier: Decimal): Decimal {
  if (!multiplier.isFinite() || multiplier.lte(0)) throw new Error('invalid base multiplier');
  return amount.mul(multiplier);
}

export function exchangePriceFromCanonical(price: Decimal, multiplier: Decimal): Decimal {
  if (!multiplier.isFinite() || multiplier.lte(0)) throw new Error('invalid base multiplier');
  return price.mul(multiplier);
}

export function canonicalPriceFromExchange(price: Decimal, multiplier: Decimal): Decimal {
  if (!multiplier.isFinite() || multiplier.lte(0)) throw new Error('invalid base multiplier');
  return price.div(multiplier);
}

function midPrice(book: OrderBookSnapshot): Decimal | undefined {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (!bid || !ask || !bid.gt(0) || !ask.gt(0)) return undefined;
  return bid.plus(ask).div(2);
}

/**
 * Alias pairs (one venue uses 1000PEPE and the other PEPE) are only allowed
 * when their independently normalized mids agree. If both markets use the
 * same unit, the normal S1 spread is not capped by this guard.
 */
export function marketsShareUnderlying(
  firstMarket: MarketMetadata,
  firstBook: OrderBookSnapshot,
  secondMarket: MarketMetadata,
  secondBook: OrderBookSnapshot,
  toleranceBps: Decimal = ALIAS_PRICE_TOLERANCE_BPS,
): boolean {
  if (
    firstMarket.base.trim().toUpperCase() !== secondMarket.base.trim().toUpperCase() ||
    firstMarket.quote.trim().toUpperCase() !== secondMarket.quote.trim().toUpperCase()
  ) {
    return false;
  }
  const firstMultiplier = marketBaseMultiplier(firstMarket);
  const secondMultiplier = marketBaseMultiplier(secondMarket);
  if (firstMultiplier.eq(secondMultiplier)) return true;
  const firstMid = midPrice(firstBook);
  const secondMid = midPrice(secondBook);
  if (!firstMid || !secondMid) return false;
  const firstCanonical = firstMid.div(firstMultiplier);
  const secondCanonical = secondMid.div(secondMultiplier);
  if (!firstCanonical.gt(0) || !secondCanonical.gt(0)) return false;
  const denominator = Decimal.min(firstCanonical, secondCanonical);
  const deviationBps = firstCanonical.minus(secondCanonical).abs().div(denominator).mul(10_000);
  return deviationBps.lte(toleranceBps);
}
