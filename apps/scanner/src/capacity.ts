import {
  Decimal,
  ZERO,
  alignAmountDown,
  bookReceivedAt,
  calculateBuyDepthByBase,
  calculateSafetyBuffer,
  calculateSellDepthByBase,
  evaluateS1Direction,
  validateOrderBook,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
  type RejectionReason,
} from '@arb/core';

export interface CapacityFeeScenario {
  label: string;
  buyTakerBps: Decimal;
  sellTakerBps: Decimal;
}

export interface CapacityPoint {
  requestedNotional: Decimal;
  executable: boolean;
  feeBreakEven: boolean;
  profitable: boolean;
  valid: boolean;
  grossSpread: Decimal;
  grossBps: Decimal;
  feeCost: Decimal;
  safetyBuffer: Decimal;
  netAfterFees: Decimal;
  netProfit: Decimal;
  netBps: Decimal;
  buyQuote: Decimal;
  sellQuote: Decimal;
  buyBase: Decimal;
  sellBase: Decimal;
  buyAveragePrice: Decimal;
  sellAveragePrice: Decimal;
  buyWorstPrice: Decimal;
  sellWorstPrice: Decimal;
  buyLevels: number;
  sellLevels: number;
  reasons: RejectionReason[];
}

export interface DepthCapacity {
  visibleBuyNotional: Decimal;
  visibleSellNotional: Decimal;
  visibleBuyBase: Decimal;
  visibleSellBase: Decimal;
  maxBaseAmount: Decimal;
  buyNotional: Decimal;
  sellNotional: Decimal;
}

export interface CapacityCurveSummary {
  feeScenario: CapacityFeeScenario;
  topGrossBps?: Decimal;
  feeBreakEvenBps: Decimal;
  eligibleThresholdBps: Decimal;
  minProfitUsd: Decimal;
  depth: DepthCapacity;
  minExecutableNotional?: Decimal;
  maxFeeBreakEvenNotional?: Decimal;
  maxProfitableNotional?: Decimal;
  maxEligibleNotional?: Decimal;
  bestNetBps: Decimal;
  bestNetProfit: Decimal;
  bindingReason: string;
  searchStep: Decimal;
  curve: CapacityPoint[];
}

export interface CapacityAnalysisInput {
  base: string;
  quote: string;
  buyMarket: MarketMetadata;
  sellMarket: MarketMetadata;
  buyBook: OrderBookSnapshot;
  sellBook: OrderBookSnapshot;
  settings: CostSettings;
  now: number;
  scenarios: readonly CapacityFeeScenario[];
  minNotional?: Decimal;
  maxNotional?: Decimal;
  step?: Decimal;
  probes?: readonly Decimal[];
}

export interface CapacityRouteAnalysis {
  base: string;
  quote: string;
  buyVenue: string;
  sellVenue: string;
  topGrossBps?: Decimal;
  buyFeeBps?: Decimal;
  sellFeeBps?: Decimal;
  buyBookAgeMs: number;
  sellBookAgeMs: number;
  pairSkewMs: number;
  flags: string[];
  scenarios: CapacityCurveSummary[];
}

const STRUCTURAL_REASONS = new Set<RejectionReason>([
  'invalid_orderbook',
  'crossed_orderbook',
  'stale_orderbook',
  'symbol_mismatch',
  'venue_mismatch',
  'fee_not_configured',
  'amount_precision_invalid',
  'price_precision_invalid',
  'insufficient_depth',
  'below_min_notional',
  'market_inactive',
  'quote_mismatch',
  'invalid_request',
]);

function sumSide(book: OrderBookSnapshot, side: 'bids' | 'asks'): Decimal {
  return (side === 'bids' ? book.bids : book.asks).reduce(
    (total, level) => total.plus(level.amount),
    ZERO,
  );
}

function sumNotional(book: OrderBookSnapshot, side: 'bids' | 'asks'): Decimal {
  return (side === 'bids' ? book.bids : book.asks).reduce(
    (total, level) => total.plus(level.price.mul(level.amount)),
    ZERO,
  );
}

function topGrossBps(buyBook: OrderBookSnapshot, sellBook: OrderBookSnapshot): Decimal | undefined {
  const ask = buyBook.asks[0]?.price;
  const bid = sellBook.bids[0]?.price;
  if (!ask || !ask.gt(0) || !bid || !bid.gt(0)) return undefined;
  return bid.div(ask).minus(1).mul(10_000);
}

function mid(book: OrderBookSnapshot): Decimal | undefined {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (!bid || !ask || !bid.gt(0) || !ask.gt(0)) return undefined;
  return bid.plus(ask).div(2);
}

function relaxedSettings(settings: CostSettings): CostSettings {
  return {
    ...settings,
    executionMode: 'taker_taker',
    suspiciousSpreadBps: new Decimal(0),
    maxPriceDeviationBps: new Decimal(0),
    maxPairSkewMs: 0,
    minReliabilityScore: new Decimal(0),
    minTopDepthQty: new Decimal(0),
  };
}

function depthCapacity(
  buyMarket: MarketMetadata,
  sellMarket: MarketMetadata,
  buyBook: OrderBookSnapshot,
  sellBook: OrderBookSnapshot,
): DepthCapacity {
  const visibleBuyBase = sumSide(buyBook, 'asks');
  const visibleSellBase = sumSide(sellBook, 'bids');
  let maxBaseAmount = Decimal.min(visibleBuyBase, visibleSellBase);
  for (const step of [buyMarket.amountStep, sellMarket.amountStep]) {
    if (step && step.gt(0)) maxBaseAmount = alignAmountDown(maxBaseAmount, step);
  }
  if (maxBaseAmount.lte(0)) {
    return {
      visibleBuyNotional: sumNotional(buyBook, 'asks'),
      visibleSellNotional: sumNotional(sellBook, 'bids'),
      visibleBuyBase,
      visibleSellBase,
      maxBaseAmount: ZERO,
      buyNotional: ZERO,
      sellNotional: ZERO,
    };
  }
  const buy = calculateBuyDepthByBase(buyBook, maxBaseAmount);
  const sell = calculateSellDepthByBase(sellBook, maxBaseAmount);
  return {
    visibleBuyNotional: sumNotional(buyBook, 'asks'),
    visibleSellNotional: sumNotional(sellBook, 'bids'),
    visibleBuyBase,
    visibleSellBase,
    maxBaseAmount,
    buyNotional: buy.executableQuoteAmount,
    sellNotional: sell.executableQuoteAmount,
  };
}

function evaluatePoint(
  input: CapacityAnalysisInput,
  scenario: CapacityFeeScenario,
  requestedNotional: Decimal,
): CapacityPoint {
  const buyMarket: MarketMetadata = {
    ...input.buyMarket,
    feeTakerBps: scenario.buyTakerBps,
  };
  const sellMarket: MarketMetadata = {
    ...input.sellMarket,
    feeTakerBps: scenario.sellTakerBps,
  };
  const venueHealth: Record<string, 'A'> = {};
  venueHealth[input.buyMarket.venueId] = 'A';
  venueHealth[input.sellMarket.venueId] = 'A';
  const settings = relaxedSettings(input.settings);
  const result = evaluateS1Direction({
    base: input.base,
    quote: input.quote,
    buyMarket,
    sellMarket,
    buyBook: input.buyBook,
    sellBook: input.sellBook,
    requestedNotional,
    settings,
    now: input.now,
    venueHealth,
  });
  const buyDepth = result.buyDepth;
  const sellDepth = result.sellDepth;
  const buyQuote = buyDepth?.executableQuoteAmount ?? ZERO;
  const sellQuote = sellDepth?.executableQuoteAmount ?? ZERO;
  const buyBase = buyDepth?.executableBaseAmount ?? ZERO;
  const sellBase = sellDepth?.executableBaseAmount ?? ZERO;
  const feeCost = buyQuote
    .mul(scenario.buyTakerBps.div(10_000))
    .plus(sellQuote.mul(scenario.sellTakerBps.div(10_000)));
  const rebalanceCost =
    settings.rebalanceCostBps && settings.rebalanceCostBps.gt(0)
      ? requestedNotional.mul(settings.rebalanceCostBps.div(10_000))
      : ZERO;
  const safetyBuffer = calculateSafetyBuffer(
    requestedNotional,
    settings.safetyBufferBps,
    settings.minProfitUsd,
  );
  const netAfterFees = result.grossSpread.minus(feeCost).minus(rebalanceCost);
  const netProfit = netAfterFees.minus(safetyBuffer);
  const reasons = result.rejectionReasons;
  const executable = !reasons.some((reason) => STRUCTURAL_REASONS.has(reason));
  return {
    requestedNotional,
    executable,
    feeBreakEven: executable && netAfterFees.gt(0),
    profitable: executable && netProfit.gt(0),
    valid: result.valid,
    grossSpread: result.grossSpread,
    grossBps: requestedNotional.gt(0)
      ? result.grossSpread.div(requestedNotional).mul(10_000)
      : ZERO,
    feeCost,
    safetyBuffer,
    netAfterFees,
    netProfit,
    netBps: requestedNotional.gt(0) ? netProfit.div(requestedNotional).mul(10_000) : ZERO,
    buyQuote,
    sellQuote,
    buyBase,
    sellBase,
    buyAveragePrice: buyDepth?.averagePrice ?? ZERO,
    sellAveragePrice: sellDepth?.averagePrice ?? ZERO,
    buyWorstPrice: buyDepth?.worstPrice ?? ZERO,
    sellWorstPrice: sellDepth?.worstPrice ?? ZERO,
    buyLevels: buyDepth?.levelsConsumed ?? 0,
    sellLevels: sellDepth?.levelsConsumed ?? 0,
    reasons,
  };
}

function searchValues(
  input: CapacityAnalysisInput,
  depth: DepthCapacity,
  step: Decimal,
): Decimal[] {
  const values = new Map<string, Decimal>();
  const add = (value: Decimal): void => {
    if (value.isFinite() && value.gt(0)) values.set(value.toFixed(), value);
  };
  for (const probe of input.probes ?? []) add(probe);
  const maxNotional = input.maxNotional ?? new Decimal(100);
  const minNotional = input.minNotional ?? new Decimal('0.5');
  const cap = Decimal.min(maxNotional, depth.buyNotional.gt(0) ? depth.buyNotional : maxNotional);
  if (minNotional.lte(cap)) {
    let current = minNotional;
    let count = 0;
    while (current.lte(cap) && count < 4000) {
      add(current);
      current = current.plus(step);
      count += 1;
    }
  }
  add(cap);
  add(depth.buyNotional);
  add(maxNotional);
  return [...values.values()].sort((left, right) => left.comparedTo(right));
}

function refineMax(
  input: CapacityAnalysisInput,
  scenario: CapacityFeeScenario,
  points: readonly CapacityPoint[],
  predicate: (point: CapacityPoint) => boolean,
): Decimal | undefined {
  let lastTrue = -1;
  for (let index = 0; index < points.length; index += 1) {
    if (predicate(points[index]!)) lastTrue = index;
  }
  if (lastTrue < 0) return undefined;
  const last = points[lastTrue]!;
  if (lastTrue >= points.length - 1) return last.requestedNotional;
  let low = last.requestedNotional;
  let high = points[lastTrue + 1]!.requestedNotional;
  if (!high.gt(low)) return low;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const midNotional = low.plus(high).div(2);
    if (predicate(evaluatePoint(input, scenario, midNotional))) {
      low = midNotional;
    } else {
      high = midNotional;
    }
  }
  return low;
}

function selectedCurve(
  input: CapacityAnalysisInput,
  scenario: CapacityFeeScenario,
  maxFee: Decimal | undefined,
  maxProfit: Decimal | undefined,
  maxEligible: Decimal | undefined,
): CapacityPoint[] {
  const values = new Map<string, Decimal>();
  const add = (value: Decimal | undefined): void => {
    if (value && value.isFinite() && value.gt(0)) values.set(value.toFixed(), value);
  };
  for (const probe of input.probes ?? []) add(probe);
  add(maxFee);
  add(maxProfit);
  add(maxEligible);
  return [...values.values()]
    .sort((left, right) => left.comparedTo(right))
    .map((value) => evaluatePoint(input, scenario, value));
}

function bindingReason(
  input: CapacityAnalysisInput,
  depth: DepthCapacity,
  top: Decimal | undefined,
  minExecutable: Decimal | undefined,
  maxFee: Decimal | undefined,
  maxProfit: Decimal | undefined,
  maxEligible: Decimal | undefined,
  firstPoint: CapacityPoint | undefined,
): string {
  if (!top) return 'one_sided_book';
  if (depth.maxBaseAmount.lte(0)) return 'no_depth';
  if (firstPoint?.reasons.includes('stale_orderbook')) return 'stale_book';
  if (!minExecutable) {
    if (depth.buyNotional.lte(input.minNotional ?? new Decimal('0.5'))) return 'depth';
    return 'min_notional';
  }
  if (!maxFee) return 'fee_floor';
  if (!maxProfit) return 'profit_threshold';
  if (!maxEligible) return 'profit_threshold';
  const cap = Decimal.min(
    input.maxNotional ?? new Decimal(100),
    depth.buyNotional.gt(0) ? depth.buyNotional : (input.maxNotional ?? new Decimal(100)),
  );
  const step = input.step ?? new Decimal('0.5');
  if (maxEligible.gte(cap.minus(step))) {
    return cap.lt(input.maxNotional ?? new Decimal(100)) ? 'depth' : 'notional_cap';
  }
  return 'spread_decay';
}

function routeFlags(
  input: CapacityAnalysisInput,
  top: Decimal | undefined,
  depth: DepthCapacity,
): string[] {
  const flags = new Set<string>();
  if (!top) flags.add('one_sided_book');
  const buyValidation = validateOrderBook(input.buyBook, {
    expectedVenueId: input.buyMarket.venueId,
    expectedSymbol: input.buyMarket.exchangeSymbol,
    maxAgeMs: input.settings.maxOrderbookAgeMs,
    now: input.now,
  });
  const sellValidation = validateOrderBook(input.sellBook, {
    expectedVenueId: input.sellMarket.venueId,
    expectedSymbol: input.sellMarket.exchangeSymbol,
    maxAgeMs: input.settings.maxOrderbookAgeMs,
    now: input.now,
  });
  for (const validation of [buyValidation, sellValidation]) {
    if (validation.valid) continue;
    if (
      validation.reasons.some(
        (reason) => reason === 'stale_orderbook' || reason === 'exchange_timestamp_stale',
      )
    ) {
      flags.add('stale_book');
    }
    if (
      validation.reasons.some(
        (reason) =>
          reason !== 'stale_orderbook' &&
          reason !== 'exchange_timestamp_stale' &&
          reason !== 'frozen_orderbook' &&
          reason !== 'feed_latency_too_high',
      )
    ) {
      flags.add('invalid_book');
    }
  }
  const suspiciousSpreadBps = input.settings.suspiciousSpreadBps;
  if (top && suspiciousSpreadBps && suspiciousSpreadBps.gt(0) && top.gt(suspiciousSpreadBps)) {
    flags.add('extreme_spread');
  }
  const buyMid = mid(input.buyBook);
  const sellMid = mid(input.sellBook);
  if (buyMid && sellMid) {
    const reference = buyMid.plus(sellMid).div(2);
    const deviation = buyMid.minus(sellMid).abs().div(reference).mul(10_000);
    const maxPriceDeviationBps = input.settings.maxPriceDeviationBps;
    if (maxPriceDeviationBps && maxPriceDeviationBps.gt(0) && deviation.gt(maxPriceDeviationBps)) {
      flags.add('price_outlier');
    }
  }
  if (
    input.settings.maxPairSkewMs &&
    input.settings.maxPairSkewMs > 0 &&
    Math.abs(bookReceivedAt(input.buyBook) - bookReceivedAt(input.sellBook)) >
      input.settings.maxPairSkewMs
  ) {
    flags.add('pair_skew');
  }
  const maxNotional = input.maxNotional ?? new Decimal(100);
  const buyAsk = input.buyBook.asks[0]?.price;
  const sellBid = input.sellBook.bids[0]?.price;
  const buyMin = Decimal.max(
    input.buyMarket.minNotional ?? ZERO,
    buyAsk && input.buyMarket.minAmount ? input.buyMarket.minAmount.mul(buyAsk) : ZERO,
  );
  const sellMin = Decimal.max(
    input.sellMarket.minNotional ?? ZERO,
    sellBid && input.sellMarket.minAmount ? input.sellMarket.minAmount.mul(sellBid) : ZERO,
  );
  if (buyMin.gt(maxNotional) || sellMin.gt(maxNotional)) flags.add('min_notional_above_cap');
  if (depth.buyNotional.lte(0)) flags.add('no_depth');
  return [...flags];
}

function analyzeScenario(
  input: CapacityAnalysisInput,
  scenario: CapacityFeeScenario,
  depth: DepthCapacity,
  top: Decimal | undefined,
): CapacityCurveSummary {
  const step = input.step ?? new Decimal('0.5');
  const values = searchValues(input, depth, step);
  const points = values.map((value) => evaluatePoint(input, scenario, value));
  const minExecutable = points.find((point) => point.executable)?.requestedNotional;
  const maxFee = refineMax(input, scenario, points, (point) => point.feeBreakEven);
  const maxProfit = refineMax(input, scenario, points, (point) => point.profitable);
  const maxEligible = refineMax(input, scenario, points, (point) => point.valid);
  const executablePoints = points.filter((point) => point.executable);
  const best = [...executablePoints].sort((left, right) =>
    right.netProfit.comparedTo(left.netProfit),
  )[0];
  const feeBreakEvenBps = scenario.buyTakerBps.plus(scenario.sellTakerBps);
  return {
    feeScenario: scenario,
    ...(top ? { topGrossBps: top } : {}),
    feeBreakEvenBps,
    eligibleThresholdBps: feeBreakEvenBps
      .plus(input.settings.safetyBufferBps)
      .plus(input.settings.minNetProfitBps),
    minProfitUsd: input.settings.minProfitUsd,
    depth,
    ...(minExecutable ? { minExecutableNotional: minExecutable } : {}),
    ...(maxFee ? { maxFeeBreakEvenNotional: maxFee } : {}),
    ...(maxProfit ? { maxProfitableNotional: maxProfit } : {}),
    ...(maxEligible ? { maxEligibleNotional: maxEligible } : {}),
    bestNetBps: best?.netBps ?? ZERO,
    bestNetProfit: best?.netProfit ?? ZERO,
    bindingReason: bindingReason(
      input,
      depth,
      top,
      minExecutable,
      maxFee,
      maxProfit,
      maxEligible,
      points[0],
    ),
    searchStep: step,
    curve: selectedCurve(input, scenario, maxFee, maxProfit, maxEligible),
  };
}

export function analyzeS1Capacity(input: CapacityAnalysisInput): CapacityRouteAnalysis {
  const top = topGrossBps(input.buyBook, input.sellBook);
  const depth = depthCapacity(input.buyMarket, input.sellMarket, input.buyBook, input.sellBook);
  const scenarios = input.scenarios.map((scenario) => analyzeScenario(input, scenario, depth, top));
  return {
    base: input.base,
    quote: input.quote,
    buyVenue: input.buyMarket.venueId,
    sellVenue: input.sellMarket.venueId,
    ...(top ? { topGrossBps: top } : {}),
    ...(input.buyMarket.feeTakerBps ? { buyFeeBps: input.buyMarket.feeTakerBps } : {}),
    ...(input.sellMarket.feeTakerBps ? { sellFeeBps: input.sellMarket.feeTakerBps } : {}),
    buyBookAgeMs: Math.max(0, input.now - bookReceivedAt(input.buyBook)),
    sellBookAgeMs: Math.max(0, input.now - bookReceivedAt(input.sellBook)),
    pairSkewMs: Math.abs(bookReceivedAt(input.buyBook) - bookReceivedAt(input.sellBook)),
    flags: routeFlags(input, top, depth),
    scenarios,
  };
}
