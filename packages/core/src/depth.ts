import { Decimal, ZERO, minDecimal } from './money.js';
import type { DepthResult, OrderBookSnapshot } from './types.js';

export function calculateBuyDepthByQuote(
  book: OrderBookSnapshot,
  requestedQuote: Decimal,
): DepthResult {
  if (!requestedQuote.gt(0)) throw new Error('requestedQuote must be positive');
  let remainingQuote = requestedQuote;
  let base = ZERO;
  let quote = ZERO;
  let worst = ZERO;
  let consumed = 0;
  for (const level of book.asks) {
    if (remainingQuote.lte(0)) break;
    const levelQuote = level.price.mul(level.amount);
    const spend = minDecimal(remainingQuote, levelQuote);
    base = base.plus(spend.div(level.price));
    quote = quote.plus(spend);
    remainingQuote = remainingQuote.minus(spend);
    worst = level.price;
    consumed += 1;
  }
  return {
    side: 'buy',
    requestedNotional: requestedQuote,
    executableBaseAmount: base,
    executableQuoteAmount: quote,
    averagePrice: base.gt(0) ? quote.div(base) : ZERO,
    worstPrice: worst,
    levelsConsumed: consumed,
    insufficientDepth: remainingQuote.gt(0),
  };
}

export function calculateBuyDepthByBase(
  book: OrderBookSnapshot,
  requestedBase: Decimal,
): DepthResult {
  if (!requestedBase.gt(0)) throw new Error('requestedBase must be positive');
  let remainingBase = requestedBase;
  let base = ZERO;
  let quote = ZERO;
  let worst = ZERO;
  let consumed = 0;
  for (const level of book.asks) {
    if (remainingBase.lte(0)) break;
    const take = minDecimal(remainingBase, level.amount);
    base = base.plus(take);
    quote = quote.plus(take.mul(level.price));
    remainingBase = remainingBase.minus(take);
    worst = level.price;
    consumed += 1;
  }
  return {
    side: 'buy',
    requestedNotional: quote,
    executableBaseAmount: base,
    executableQuoteAmount: quote,
    averagePrice: base.gt(0) ? quote.div(base) : ZERO,
    worstPrice: worst,
    levelsConsumed: consumed,
    insufficientDepth: remainingBase.gt(0),
  };
}

export function calculateSellDepthByBase(
  book: OrderBookSnapshot,
  requestedBase: Decimal,
): DepthResult {
  if (!requestedBase.gt(0)) throw new Error('requestedBase must be positive');
  let remainingBase = requestedBase;
  let base = ZERO;
  let quote = ZERO;
  let worst = ZERO;
  let consumed = 0;
  for (const level of book.bids) {
    if (remainingBase.lte(0)) break;
    const take = minDecimal(remainingBase, level.amount);
    base = base.plus(take);
    quote = quote.plus(take.mul(level.price));
    remainingBase = remainingBase.minus(take);
    worst = level.price;
    consumed += 1;
  }
  return {
    side: 'sell',
    requestedNotional: quote,
    executableBaseAmount: base,
    executableQuoteAmount: quote,
    averagePrice: base.gt(0) ? quote.div(base) : ZERO,
    worstPrice: worst,
    levelsConsumed: consumed,
    insufficientDepth: remainingBase.gt(0),
  };
}

export function calculateSellDepthByQuote(
  book: OrderBookSnapshot,
  requestedQuote: Decimal,
): DepthResult {
  if (!requestedQuote.gt(0)) throw new Error('requestedQuote must be positive');
  let remainingQuote = requestedQuote;
  let base = ZERO;
  let quote = ZERO;
  let worst = ZERO;
  let consumed = 0;
  for (const level of book.bids) {
    if (remainingQuote.lte(0)) break;
    const levelQuote = level.price.mul(level.amount);
    const takeQuote = minDecimal(remainingQuote, levelQuote);
    base = base.plus(takeQuote.div(level.price));
    quote = quote.plus(takeQuote);
    remainingQuote = remainingQuote.minus(takeQuote);
    worst = level.price;
    consumed += 1;
  }
  return {
    side: 'sell',
    requestedNotional: requestedQuote,
    executableBaseAmount: base,
    executableQuoteAmount: quote,
    averagePrice: base.gt(0) ? quote.div(base) : ZERO,
    worstPrice: worst,
    levelsConsumed: consumed,
    insufficientDepth: remainingQuote.gt(0),
  };
}

export function simulateTwoLegBaseAmount(
  buyBook: OrderBookSnapshot,
  sellBook: OrderBookSnapshot,
  requestedQuote: Decimal,
): { buy: DepthResult; sell: DepthResult } {
  const buy = calculateBuyDepthByQuote(buyBook, requestedQuote);
  const sell = calculateSellDepthByBase(sellBook, buy.executableBaseAmount);
  return { buy, sell };
}
