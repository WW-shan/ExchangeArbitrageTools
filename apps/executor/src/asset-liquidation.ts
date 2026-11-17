import { Decimal, alignAmountDown, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';

export interface AssetLiquidationPlan {
  action: 'SELL';
  amount: Decimal;
  limitPrice: Decimal;
  expectedQuote: Decimal;
  expectedVwap: Decimal;
  bestBid: Decimal;
  slippageBps: Decimal;
  partial: boolean;
}

export interface AssetLiquidationRejection {
  action: 'SKIP';
  reason: string;
}

export type AssetLiquidationDecision = AssetLiquidationPlan | AssetLiquidationRejection;

interface DepthWalk {
  filled: Decimal;
  quote: Decimal;
  worstPrice?: Decimal;
  exhausted: boolean;
}

function walkBids(bids: OrderBookSnapshot['bids'], requested: Decimal): DepthWalk {
  let remaining = requested;
  let filled = new Decimal(0);
  let quote = new Decimal(0);
  let worstPrice: Decimal | undefined;
  for (const level of bids) {
    if (!remaining.gt(0)) break;
    const take = Decimal.min(remaining, level.amount);
    if (!take.gt(0)) continue;
    filled = filled.plus(take);
    quote = quote.plus(take.mul(level.price));
    worstPrice = level.price;
    remaining = remaining.minus(take);
  }
  return { filled, quote, ...(worstPrice ? { worstPrice } : {}), exhausted: !remaining.gt(0) };
}

export function planAssetLiquidation(input: {
  free: Decimal;
  market: MarketMetadata;
  book: OrderBookSnapshot;
  maxSlippageBps: Decimal;
}): AssetLiquidationDecision {
  const { free, market, book, maxSlippageBps } = input;
  const amountStep = market.amountStep ?? new Decimal(1);
  const desiredAmount = alignAmountDown(free, amountStep);
  if (!desiredAmount.gt(0)) return { action: 'SKIP', reason: 'amount_precision_invalid' };
  const bestBid = book.bids[0]?.price;
  if (!bestBid || !bestBid.gt(0)) return { action: 'SKIP', reason: 'bid_side_empty' };

  const initial = walkBids(book.bids, desiredAmount);
  const amount = initial.exhausted ? desiredAmount : alignAmountDown(initial.filled, amountStep);
  if (!amount.gt(0)) return { action: 'SKIP', reason: 'insufficient_depth' };
  if (market.minAmount && amount.lt(market.minAmount)) {
    return { action: 'SKIP', reason: 'below_min_amount' };
  }

  const fill = amount.eq(desiredAmount) ? initial : walkBids(book.bids, amount);
  if (!fill.worstPrice || !fill.exhausted) return { action: 'SKIP', reason: 'insufficient_depth' };
  if (market.minNotional && fill.quote.lt(market.minNotional)) {
    return { action: 'SKIP', reason: 'below_min_notional' };
  }
  const vwap = fill.quote.div(amount);
  const slippageBps = bestBid.minus(vwap).div(bestBid).mul(10_000);
  if (slippageBps.gt(maxSlippageBps)) {
    return { action: 'SKIP', reason: 'slippage_above_limit' };
  }
  return {
    action: 'SELL',
    amount,
    limitPrice: fill.worstPrice,
    expectedQuote: fill.quote,
    expectedVwap: vwap,
    bestBid,
    slippageBps,
    partial: amount.lt(desiredAmount),
  };
}
