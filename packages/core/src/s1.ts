import {
  Decimal,
  ZERO,
  calculateNetProfitBps,
  calculateSafetyBuffer,
  bps as toBps,
} from './money.js';
import {
  calculateBuyDepthByBase,
  calculateBuyDepthByQuote,
  calculateSellDepthByBase,
} from './depth.js';
import { alignAmountDown, commonAmountStep, isAligned } from './precision.js';
import { bookReceivedAt, validateOrderBook } from './orderbook.js';
import { searchOptimalNotional } from './optimal.js';
import type {
  CostSettings,
  HealthState,
  MarketMetadata,
  OpportunityResult,
  OrderBookSnapshot,
  RejectionReason,
} from './types.js';

export interface S1EvaluationInput {
  base: string;
  quote: string;
  buyMarket: MarketMetadata;
  sellMarket: MarketMetadata;
  buyBook: OrderBookSnapshot;
  sellBook: OrderBookSnapshot;
  requestedNotional: Decimal;
  settings: CostSettings;
  now: number;
  venueHealth?: Readonly<Record<string, HealthState>>;
  referenceMidPrice?: Decimal;
  venueReliability?: Readonly<Record<string, Decimal>>;
}

function healthRank(state: HealthState): number {
  return { A: 0, B: 1, C: 2, D: 3 }[state];
}

function meetsHealth(state: HealthState, minimum: HealthState = 'B'): boolean {
  return healthRank(state) <= healthRank(minimum);
}

function uniqueReasons(reasons: RejectionReason[]): RejectionReason[] {
  return [...new Set(reasons)];
}

function finiteNonNegative(value: Decimal): boolean {
  return value.isFinite() && value.gte(0);
}

function configuredFee(value: Decimal | undefined, allowRebate = false): value is Decimal {
  if (value === undefined || !value.isFinite()) return false;
  return allowRebate ? value.gt(-10_000) : value.gte(0);
}

function validateMarketRules(market: MarketMetadata, reasons: RejectionReason[]): void {
  if (!market.active) reasons.push('market_inactive');
  if (
    market.baseMultiplier &&
    (!market.baseMultiplier.isFinite() ||
      market.baseMultiplier.lte(0) ||
      !market.baseMultiplier.eq(1))
  ) {
    reasons.push('invalid_request');
  }
  if (market.amountStep && (!market.amountStep.isFinite() || market.amountStep.lte(0))) {
    reasons.push('amount_precision_invalid');
  }
  if (market.priceStep && (!market.priceStep.isFinite() || market.priceStep.lte(0))) {
    reasons.push('price_precision_invalid');
  }
  if (market.minAmount && (!finiteNonNegative(market.minAmount) || market.minAmount.lt(0))) {
    reasons.push('invalid_request');
  }
  if (market.minNotional && (!finiteNonNegative(market.minNotional) || market.minNotional.lt(0))) {
    reasons.push('invalid_request');
  }
}

export function evaluateS1Direction(input: S1EvaluationInput): OpportunityResult {
  const reasons: RejectionReason[] = [];
  const { buyMarket, sellMarket, buyBook, sellBook, requestedNotional, settings, now } = input;
  if (!requestedNotional.isFinite() || requestedNotional.lte(0)) reasons.push('invalid_request');
  if (!Number.isFinite(now) || now <= 0) reasons.push('invalid_request');
  if (
    !Number.isFinite(settings.maxOrderbookAgeMs) ||
    settings.maxOrderbookAgeMs < 0 ||
    !finiteNonNegative(settings.safetyBufferBps) ||
    !finiteNonNegative(settings.minProfitUsd) ||
    !settings.minNetProfitBps.isFinite() ||
    settings.minNetProfitBps.lt(0)
  ) {
    reasons.push('invalid_request');
  }
  if (
    settings.makerFillProbability &&
    (!settings.makerFillProbability.isFinite() ||
      settings.makerFillProbability.lt(0) ||
      settings.makerFillProbability.gt(1))
  ) {
    reasons.push('invalid_request');
  }
  validateMarketRules(buyMarket, reasons);
  validateMarketRules(sellMarket, reasons);
  const expectedBase = input.base.trim().toUpperCase();
  const expectedQuote = input.quote.trim().toUpperCase();
  for (const market of [buyMarket, sellMarket]) {
    if (
      market.base.trim().toUpperCase() !== expectedBase ||
      market.quote.trim().toUpperCase() !== expectedQuote
    ) {
      reasons.push('quote_mismatch');
    }
  }
  const buyValidation = validateOrderBook(buyBook, {
    expectedVenueId: buyMarket.venueId,
    expectedSymbol: buyMarket.exchangeSymbol,
    maxAgeMs: settings.maxOrderbookAgeMs,
    now,
  });
  const sellValidation = validateOrderBook(sellBook, {
    expectedVenueId: sellMarket.venueId,
    expectedSymbol: sellMarket.exchangeSymbol,
    maxAgeMs: settings.maxOrderbookAgeMs,
    now,
  });
  if (!buyValidation.valid) reasons.push('invalid_orderbook');
  if (!sellValidation.valid) reasons.push('invalid_orderbook');
  if (
    !buyValidation.valid &&
    buyValidation.reasons.some(
      (reason) => reason === 'stale_orderbook' || reason === 'exchange_timestamp_stale',
    )
  ) {
    reasons.push('stale_orderbook');
  }
  if (
    !sellValidation.valid &&
    sellValidation.reasons.some(
      (reason) => reason === 'stale_orderbook' || reason === 'exchange_timestamp_stale',
    )
  ) {
    reasons.push('stale_orderbook');
  }
  if (!buyValidation.valid && buyValidation.reasons.includes('crossed_orderbook')) {
    reasons.push('crossed_orderbook');
  }
  if (!sellValidation.valid && sellValidation.reasons.includes('crossed_orderbook')) {
    reasons.push('crossed_orderbook');
  }

  const executionMode = settings.executionMode ?? 'taker_taker';
  const buyIsMaker = executionMode === 'maker_buy_taker_sell';
  const sellIsMaker = executionMode === 'taker_buy_maker_sell';
  const buyFeeBps = buyIsMaker ? buyMarket.makerFeeBps : buyMarket.feeTakerBps;
  const sellFeeBps = sellIsMaker ? sellMarket.makerFeeBps : sellMarket.feeTakerBps;
  if (!configuredFee(buyFeeBps, buyIsMaker) || !configuredFee(sellFeeBps, sellIsMaker)) {
    reasons.push('fee_not_configured');
  }

  const health = input.venueHealth ?? {};
  for (const venueId of [buyMarket.venueId, sellMarket.venueId]) {
    const state = health[venueId] ?? 'B';
    if (!meetsHealth(state, 'B')) reasons.push('venue_health_below_threshold');
  }

  if (
    settings.maxPairSkewMs !== undefined &&
    settings.maxPairSkewMs > 0 &&
    buyValidation.valid &&
    sellValidation.valid
  ) {
    const skew = Math.abs(bookReceivedAt(buyValidation.book) - bookReceivedAt(sellValidation.book));
    if (skew > settings.maxPairSkewMs) reasons.push('pair_skew_too_high');
  }
  if (
    settings.maxPriceDeviationBps &&
    settings.maxPriceDeviationBps.gt(0) &&
    input.referenceMidPrice &&
    input.referenceMidPrice.gt(0) &&
    buyValidation.valid &&
    sellValidation.valid
  ) {
    const buyMid = buyValidation.book.bids[0]!.price.plus(buyValidation.book.asks[0]!.price).div(2);
    const sellMid = sellValidation.book.bids[0]!.price.plus(sellValidation.book.asks[0]!.price).div(
      2,
    );
    const limit = input.referenceMidPrice.mul(toBps(settings.maxPriceDeviationBps));
    if (
      buyMid.minus(input.referenceMidPrice).abs().gt(limit) ||
      sellMid.minus(input.referenceMidPrice).abs().gt(limit)
    ) {
      reasons.push('price_outlier');
    }
  }
  if (
    settings.suspiciousSpreadBps &&
    settings.suspiciousSpreadBps.gt(0) &&
    buyValidation.valid &&
    sellValidation.valid
  ) {
    const bestAsk = buyValidation.book.asks[0]!.price;
    const bestBid = sellValidation.book.bids[0]!.price;
    const topSpreadBps = bestBid.minus(bestAsk).div(bestAsk).mul(10_000);
    if (topSpreadBps.gt(settings.suspiciousSpreadBps)) reasons.push('suspicious_spread');
  }
  if (
    settings.minReliabilityScore &&
    settings.minReliabilityScore.gt(0) &&
    input.venueReliability
  ) {
    for (const venueId of [buyMarket.venueId, sellMarket.venueId]) {
      const score = input.venueReliability[venueId];
      if (score !== undefined && score.isFinite() && score.lt(settings.minReliabilityScore)) {
        reasons.push('venue_reliability_low');
      }
    }
  }

  const minTopDepthQty = settings.minTopDepthQty;
  if (
    buyValidation.valid &&
    sellValidation.valid &&
    minTopDepthQty &&
    minTopDepthQty.isFinite() &&
    minTopDepthQty.gt(0)
  ) {
    const topLevels = Math.max(1, settings.liquidityTopLevels ?? 5);
    const buyDepthQty = buyValidation.book.asks
      .slice(0, topLevels)
      .reduce((sum, level) => sum.plus(level.amount), ZERO);
    const sellDepthQty = sellValidation.book.bids
      .slice(0, topLevels)
      .reduce((sum, level) => sum.plus(level.amount), ZERO);
    if (buyDepthQty.lt(minTopDepthQty) || sellDepthQty.lt(minTopDepthQty)) {
      reasons.push('liquidity_below_minimum');
    }
  }

  const dataAgeMs = Number.isFinite(now)
    ? Math.max(Math.max(0, now - buyBook.fetchedAt), Math.max(0, now - sellBook.fetchedAt))
    : 0;
  const baseResult: OpportunityResult = {
    strategy: 'S1',
    opportunityKey: `S1|${input.base}/${input.quote}|${buyMarket.venueId}|${sellMarket.venueId}`,
    instrumentKey: `${input.base}/${input.quote}`,
    direction: `${buyMarket.venueId}->${sellMarket.venueId}`,
    venueBuy: buyMarket.venueId,
    venueSell: sellMarket.venueId,
    instrumentBuy: buyMarket.unifiedSymbol,
    instrumentSell: sellMarket.unifiedSymbol,
    requestedNotional,
    grossSpread: new Decimal(0),
    totalCost: new Decimal(0),
    depthNetProfit: new Decimal(0),
    conservativeNetProfit: new Decimal(0),
    netProfitBps: new Decimal(0),
    dataAgeMs,
    valid: false,
    rejectionReasons: uniqueReasons(reasons),
    sampledAt: now,
    metadata: { buySymbol: buyMarket.exchangeSymbol, sellSymbol: sellMarket.exchangeSymbol },
  };
  if (!buyValidation.valid || !sellValidation.valid || reasons.length > 0) return baseResult;

  const amountSteps = [buyMarket.amountStep, sellMarket.amountStep].filter(
    (step): step is Decimal => step !== undefined,
  );
  const step = amountSteps.length > 0 ? commonAmountStep(...amountSteps) : new Decimal('1e-8');
  const initialBuy = calculateBuyDepthByQuote(buyValidation.book, requestedNotional);
  if (initialBuy.insufficientDepth) {
    baseResult.rejectionReasons = uniqueReasons([...reasons, 'insufficient_depth']);
    return baseResult;
  }
  const amount = alignAmountDown(initialBuy.executableBaseAmount, step);
  if (!amount.gt(0)) {
    baseResult.rejectionReasons = uniqueReasons([...reasons, 'amount_precision_invalid']);
    return baseResult;
  }

  const buy = calculateBuyDepthByBase(buyValidation.book, amount);
  const sell = calculateSellDepthByBase(sellValidation.book, amount);
  if (buy.insufficientDepth || sell.insufficientDepth) {
    baseResult.rejectionReasons = uniqueReasons([...reasons, 'insufficient_depth']);
    baseResult.buyDepth = buy;
    baseResult.sellDepth = sell;
    return baseResult;
  }
  if (buy.executableQuoteAmount.gt(requestedNotional)) {
    baseResult.rejectionReasons = uniqueReasons([...reasons, 'insufficient_depth']);
    return baseResult;
  }

  // The execution layer submits the worst executable price as the limit
  // price. If that price is not on the venue tick grid, the venue will reject
  // the order; fail here rather than silently submitting an invalid price.
  if (buyMarket.priceStep && !isAligned(buy.worstPrice, buyMarket.priceStep)) {
    reasons.push('price_precision_invalid');
  }
  if (sellMarket.priceStep && !isAligned(sell.worstPrice, sellMarket.priceStep)) {
    reasons.push('price_precision_invalid');
  }

  if (buyMarket.minAmount && amount.lt(buyMarket.minAmount)) {
    reasons.push('below_min_notional');
  }
  if (sellMarket.minAmount && amount.lt(sellMarket.minAmount)) {
    reasons.push('below_min_notional');
  }
  if (buyMarket.minNotional && buy.executableQuoteAmount.lt(buyMarket.minNotional)) {
    reasons.push('below_min_notional');
  }
  if (sellMarket.minNotional && sell.executableQuoteAmount.lt(sellMarket.minNotional)) {
    reasons.push('below_min_notional');
  }

  const buyFee = buy.executableQuoteAmount.mul(toBps(buyFeeBps!));
  const sellFee = sell.executableQuoteAmount.mul(toBps(sellFeeBps!));
  const grossSpread = sell.executableQuoteAmount.minus(buy.executableQuoteAmount);
  const totalFees = buyFee.plus(sellFee);
  const rebalanceCost =
    settings.rebalanceCostBps && settings.rebalanceCostBps.gt(0)
      ? requestedNotional.mul(toBps(settings.rebalanceCostBps))
      : ZERO;
  const depthNetProfit = grossSpread.minus(totalFees).minus(rebalanceCost);
  const safetyBuffer = calculateSafetyBuffer(
    requestedNotional,
    settings.safetyBufferBps,
    settings.minProfitUsd,
  );
  const makerLeg = buyIsMaker ? 'buy' : sellIsMaker ? 'sell' : 'none';
  const fillProbability =
    makerLeg === 'none' ? new Decimal(1) : (settings.makerFillProbability ?? new Decimal('0.5'));
  const conservativeNetProfit = depthNetProfit.minus(safetyBuffer).mul(fillProbability);
  const netProfitBps = calculateNetProfitBps(conservativeNetProfit, requestedNotional);
  if (conservativeNetProfit.lte(0)) reasons.push('gross_profit_below_threshold');
  else if (netProfitBps.lt(settings.minNetProfitBps)) {
    reasons.push('conservative_profit_below_threshold');
  }

  return {
    ...baseResult,
    grossSpread,
    totalCost: totalFees.plus(safetyBuffer).plus(rebalanceCost),
    depthNetProfit,
    conservativeNetProfit,
    netProfitBps,
    valid: reasons.length === 0,
    rejectionReasons: uniqueReasons(reasons),
    metadata: {
      ...(baseResult.metadata ?? {}),
      rebalanceCostUsd: rebalanceCost.toFixed(),
      executionMode,
      makerLeg,
      fillProbability: fillProbability.toFixed(),
    },
    buyDepth: buy,
    sellDepth: sell,
    expectedBuyPrice: buy.worstPrice,
    expectedSellPrice: sell.worstPrice,
  };
}

export interface S1PreparationBudget {
  maxCostBps: Decimal;
  maxCostUsd: Decimal;
}

/**
 * Evaluate a small negative-edge inventory preparation trade. The ordinary
 * S1 evaluator still owns depth, balance-independent market, fee, and freshness
 * checks. This wrapper only replaces the profit rejection with a bounded
 * preparation cost budget.
 */
export function evaluateS1Preparation(
  input: S1EvaluationInput,
  budget: S1PreparationBudget,
): OpportunityResult {
  const evaluated = evaluateS1Direction(input);
  const profitOnly = new Set<RejectionReason>([
    'gross_profit_below_threshold',
    'conservative_profit_below_threshold',
  ]);
  const blocking = evaluated.rejectionReasons.filter((reason) => !profitOnly.has(reason));
  if (blocking.length > 0) return evaluated;
  const validBudget =
    budget.maxCostBps.isFinite() &&
    budget.maxCostBps.gte(0) &&
    budget.maxCostUsd.isFinite() &&
    budget.maxCostUsd.gte(0);
  if (!validBudget) {
    return {
      ...evaluated,
      valid: false,
      rejectionReasons: uniqueReasons([...blocking, 'preparation_cost_above_limit']),
    };
  }
  const costUsd = evaluated.conservativeNetProfit.lt(0)
    ? evaluated.conservativeNetProfit.abs()
    : ZERO;
  const costBps = evaluated.requestedNotional.gt(0)
    ? costUsd.div(evaluated.requestedNotional).mul(10_000)
    : new Decimal(Number.POSITIVE_INFINITY);
  if (costUsd.gt(budget.maxCostUsd) || costBps.gt(budget.maxCostBps)) {
    return {
      ...evaluated,
      valid: false,
      rejectionReasons: uniqueReasons([...blocking, 'preparation_cost_above_limit']),
    };
  }
  return {
    ...evaluated,
    valid: true,
    rejectionReasons: [],
    metadata: {
      ...(evaluated.metadata ?? {}),
      intent: 'inventory_preparation',
      preparationCostUsd: costUsd.toFixed(),
      preparationCostBps: costBps.toFixed(),
      preparationMaxCostUsd: budget.maxCostUsd.toFixed(),
      preparationMaxCostBps: budget.maxCostBps.toFixed(),
    },
  };
}

export function evaluateS1BothDirections(
  first: S1EvaluationInput,
  second: S1EvaluationInput,
): [OpportunityResult, OpportunityResult] {
  return [evaluateS1Direction(first), evaluateS1Direction(second)];
}

export function estimateS1Return(
  buyBook: OrderBookSnapshot,
  sellBook: OrderBookSnapshot,
  buyMarket: MarketMetadata,
  sellMarket: MarketMetadata,
): Decimal {
  const ask = buyBook.asks[0]?.price;
  const bid = sellBook.bids[0]?.price;
  if (!ask || !ask.gt(0) || !bid || !bid.gt(0)) return ZERO;
  const buyFee = buyMarket.feeTakerBps ?? ZERO;
  const sellFee = sellMarket.feeTakerBps ?? ZERO;
  const feeFactor = new Decimal(1)
    .minus(buyFee.div(10_000))
    .mul(new Decimal(1).minus(sellFee.div(10_000)));
  return bid.div(ask).mul(feeFactor).minus(1);
}

export interface S1OptimizationInput extends Omit<S1EvaluationInput, 'requestedNotional'> {
  maxNotional: Decimal;
  minNotional?: Decimal;
  step?: Decimal;
  samples?: number;
  refineLevels?: number;
  refineSamples?: number;
}

export function evaluateS1DirectionOptimal(input: S1OptimizationInput): OpportunityResult {
  const { maxNotional, minNotional, step, samples, refineLevels, refineSamples, ...base } = input;
  const search = searchOptimalNotional({
    minNotional: minNotional ?? new Decimal(1),
    maxNotional,
    ...(step ? { step } : {}),
    ...(samples !== undefined ? { samples } : {}),
    ...(refineLevels !== undefined ? { refineLevels } : {}),
    ...(refineSamples !== undefined ? { refineSamples } : {}),
    evaluate: (notional) => {
      const result = evaluateS1Direction({ ...base, requestedNotional: notional });
      return {
        conservativeNetProfit: result.conservativeNetProfit,
        valid: result.valid,
        rejectionReasons: result.rejectionReasons,
      };
    },
  });
  const final = evaluateS1Direction({ ...base, requestedNotional: search.notional });
  return {
    ...final,
    metadata: {
      ...(final.metadata ?? {}),
      sizing: 'optimal',
      sizingEvaluated: String(search.evaluated),
      sizingBoundary: search.boundary,
    },
  };
}
