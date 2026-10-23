import { Decimal, type OrderBookSnapshot } from '@arb/core';

/** Quote notional available in the top `levels` levels of one side. */
export function bookDepthNotional(
  book: OrderBookSnapshot,
  side: 'bids' | 'asks',
  levels: number,
): Decimal {
  const source = side === 'bids' ? book.bids : book.asks;
  let total = new Decimal(0);
  for (const level of source.slice(0, Math.max(1, Math.floor(levels)))) {
    total = total.plus(level.price.mul(level.amount));
  }
  return total;
}

/**
 * Cap the trade notional to a fraction of the weaker leg's visible depth.
 * A multiple of 1 means "use all visible depth"; 1.5 means "use at most 2/3".
 */
export function depthBoundNotional(
  buyBook: OrderBookSnapshot,
  sellBook: OrderBookSnapshot,
  levels: number,
  multiple: Decimal,
): Decimal {
  const buyDepth = bookDepthNotional(buyBook, 'asks', levels);
  const sellDepth = bookDepthNotional(sellBook, 'bids', levels);
  const weaker = Decimal.min(buyDepth, sellDepth);
  return multiple.gt(1) ? weaker.div(multiple) : weaker;
}
