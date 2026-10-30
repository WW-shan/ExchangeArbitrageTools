import { randomUUID } from 'node:crypto';
import {
  Decimal,
  ZERO,
  alignAmountDown,
  alignPriceDown,
  bookReceivedAt,
  canonicalAmountFromExchange,
  calculateSellDepthByQuote,
  ceilToStep,
  exchangeAmountFromCanonical,
  exchangePriceFromCanonical,
  marketBaseMultiplier,
  marketExchangeBase,
  normalizeBookForMarket,
  validateOrderBook,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';
import type { BalanceSnapshot, OrderState } from '@arb/venues-cex';
import type { RecoveryVenue } from './bootstrap.js';
import type { AutoInventoryConfig, ExecutorConfig, RotationPairConfig } from './config.js';
import { fetchOpenOrdersForSymbols } from './open-orders.js';
import { findMarket } from './runtime.js';

const REBALANCE_BOOK_MAX_AGE_MS = 5_000;
const REBALANCE_EXCHANGE_TIMESTAMP_MAX_AGE_MS = 60_000;
const REBALANCE_MAX_ATTEMPTS = 3;

export interface InventoryRebalanceBalanceView {
  venueId: string;
  baseFree: Decimal;
  quoteFree: Decimal;
  fetchedAt: number;
}

export interface InventoryRebalanceVenueSnapshot {
  venueId: string;
  market: MarketMetadata;
  book: OrderBookSnapshot;
  balance: InventoryRebalanceBalanceView;
}

export interface InventoryRebalanceTrigger {
  venueId: string;
  otherVenueId: string;
  edgeBps: Decimal;
  sampledAt: number;
  opportunityId?: number;
  fundingOnly?: boolean;
}

export interface AutomaticInventoryRebalancePlan {
  pair: RotationPairConfig;
  venueId: string;
  otherVenueId: string;
  base: string;
  exchangeBase: string;
  quote: string;
  exchangeSymbol: string;
  baseMultiplier: Decimal;
  reason: 'quote_short_with_base_surplus';
  edgeBps: Decimal;
  signalSampledAt: number;
  fundingOnly: boolean;
  currentBaseUsd: Decimal;
  currentQuoteUsd: Decimal;
  targetQuoteUsd: Decimal;
  baseSurplusUsd: Decimal;
  amount: Decimal;
  limitPrice: Decimal;
  expectedQuoteProceeds: Decimal;
  expectedRemainingBaseUsd: Decimal;
  expectedCostUsd: Decimal;
  ownBid: Decimal;
  otherBid: Decimal;
  bookFetchedAt: number;
  venueBalance: InventoryRebalanceBalanceView;
  otherBalance: InventoryRebalanceBalanceView;
}

export type AutomaticInventoryRebalanceDecision =
  | { action: 'SELL'; reasons: []; plan: AutomaticInventoryRebalancePlan }
  | { action: 'WAIT' | 'NOOP' | 'BLOCKED'; reasons: string[] };

export type AutomaticInventoryRebalanceStatus =
  | 'NOOP'
  | 'WAIT'
  | 'BLOCKED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'PARTIAL'
  | 'ACCOUNTING_UNKNOWN'
  | 'FILLED';

export interface AutomaticInventoryRebalanceResult {
  status: AutomaticInventoryRebalanceStatus;
  reasons: string[];
  plan?: AutomaticInventoryRebalancePlan;
  batchId?: string;
  executionId?: number;
  order?: OrderState;
  filled?: Decimal;
  killSwitch?: boolean;
}

function findBalance(
  rows: readonly BalanceSnapshot[],
  venueId: string,
  currency: string,
): BalanceSnapshot | undefined {
  return rows.find(
    (row) =>
      row.venueId.trim().toLowerCase() === venueId.trim().toLowerCase() &&
      row.currency.trim().toUpperCase() === currency.trim().toUpperCase(),
  );
}

function balanceView(
  rows: readonly BalanceSnapshot[],
  venueId: string,
  market: MarketMetadata,
): InventoryRebalanceBalanceView | undefined {
  const venueRows = rows.filter(
    (row) => row.venueId.trim().toLowerCase() === venueId.trim().toLowerCase(),
  );
  if (venueRows.length === 0) return undefined;
  const base = findBalance(rows, venueId, marketExchangeBase(market));
  const quote = findBalance(rows, venueId, market.quote);
  return {
    venueId,
    baseFree: base?.free ?? ZERO,
    quoteFree: quote?.free ?? ZERO,
    fetchedAt: Math.min(...venueRows.map((row) => row.fetchedAt)),
  };
}

function bestBid(venue: InventoryRebalanceVenueSnapshot): Decimal | undefined {
  return normalizeBookForMarket(venue.book, venue.market).bids[0]?.price;
}

function baseValueUsd(venue: InventoryRebalanceVenueSnapshot, bid: Decimal): Decimal {
  return venue.balance.baseFree.mul(bid);
}

function orderedVenues(
  pair: RotationPairConfig,
  venues: readonly InventoryRebalanceVenueSnapshot[],
): [InventoryRebalanceVenueSnapshot, InventoryRebalanceVenueSnapshot] | undefined {
  const first = venues.find((venue) => venue.venueId === pair.venues[0]);
  const second = venues.find((venue) => venue.venueId === pair.venues[1]);
  return first && second ? [first, second] : undefined;
}

export function planAutomaticInventoryRebalance(input: {
  pair: RotationPairConfig;
  venues: readonly InventoryRebalanceVenueSnapshot[];
  config: AutoInventoryConfig;
  trigger: InventoryRebalanceTrigger;
  now: number;
}): AutomaticInventoryRebalanceDecision {
  const { pair, config, trigger, now } = input;
  if (!config.rebalanceEnabled) {
    return { action: 'BLOCKED', reasons: ['inventory_rebalance_disabled'] };
  }
  const quote = pair.quote.trim().toUpperCase();
  if (!['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI'].includes(quote)) {
    return { action: 'BLOCKED', reasons: ['inventory_quote_not_usd_stable'] };
  }
  const ordered = orderedVenues(pair, input.venues);
  if (!ordered) return { action: 'BLOCKED', reasons: ['inventory_venue_snapshot_incomplete'] };
  const [first, second] = ordered;
  const target = [first, second].find((venue) => venue.venueId === trigger.venueId);
  const other = [first, second].find((venue) => venue.venueId === trigger.otherVenueId);
  if (!target || !other || target.venueId === other.venueId) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_trigger_route_invalid'] };
  }
  if (
    !trigger.edgeBps.isFinite() ||
    trigger.edgeBps.lt(config.minRebalanceEdgeBps) ||
    !Number.isFinite(trigger.sampledAt) ||
    now - trigger.sampledAt > config.rebalanceSignalMaxAgeMs
  ) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_signal_stale_or_weak'] };
  }
  const targetBid = bestBid(target);
  const otherBid = bestBid(other);
  if (!targetBid || !otherBid || targetBid.lte(0) || otherBid.lte(0)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_book_incomplete'] };
  }
  const targetBaseUsd = baseValueUsd(target, targetBid);
  const otherBaseUsd = baseValueUsd(other, otherBid);
  if (!trigger.fundingOnly && otherBaseUsd.lt(config.minUsefulNotionalUsd)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_sell_leg_unfunded'] };
  }
  const targetQuoteUsd = config.minQuoteReserveUsd.plus(config.minExecutableBuyUsd);
  const quoteDeficit = Decimal.max(0, targetQuoteUsd.minus(target.balance.quoteFree));
  if (!quoteDeficit.gt(0)) {
    return { action: 'NOOP', reasons: ['inventory_quote_sufficient'] };
  }
  const baseSurplusUsd = targetBaseUsd.minus(config.minUsefulNotionalUsd);
  if (!baseSurplusUsd.gt(0)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_no_base_surplus'] };
  }

  const amountStep = target.market.amountStep;
  const priceStep = target.market.priceStep;
  if (!amountStep || !priceStep) {
    return { action: 'BLOCKED', reasons: ['inventory_rebalance_market_precision_missing'] };
  }
  const feeBps = target.market.feeTakerBps ?? ZERO;
  const feeFactor = new Decimal(1).minus(feeBps.div(10_000));
  if (!feeFactor.gt(0)) {
    return { action: 'BLOCKED', reasons: ['inventory_rebalance_fee_invalid'] };
  }
  const maxSellableQuote = trigger.fundingOnly
    ? target.balance.baseFree.mul(targetBid).mul(feeFactor)
    : Decimal.min(
        baseSurplusUsd.mul(feeFactor),
        target.balance.baseFree.mul(targetBid).mul(feeFactor),
      );
  if (maxSellableQuote.lt(quoteDeficit)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_base_surplus_insufficient'] };
  }
  // Include a small amount-step buffer so fee rounding and lot alignment do
  // not leave the venue a few micro-USDT below the configured reserve.
  const requestedQuote = quoteDeficit.div(feeFactor).mul('1.001');
  if (!requestedQuote.gt(0)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_amount_below_minimum'] };
  }
  const normalizedBook = normalizeBookForMarket(target.book, target.market);
  const depth = calculateSellDepthByQuote(normalizedBook, requestedQuote);
  if (
    !depth.executableBaseAmount.gt(0) ||
    !depth.executableQuoteAmount.gt(0) ||
    depth.insufficientDepth
  ) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_bid_liquidity_missing'] };
  }
  const multiplier = marketBaseMultiplier(target.market);
  const canonicalWorst = depth.worstPrice;
  const exchangeLimit = alignPriceDown(
    exchangePriceFromCanonical(canonicalWorst, multiplier),
    priceStep,
  );
  if (!exchangeLimit.gt(0)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_limit_invalid'] };
  }
  let exchangeAmount = ceilToStep(
    exchangeAmountFromCanonical(depth.executableBaseAmount, multiplier),
    amountStep,
  );
  const maxExchangeBase = alignAmountDown(
    exchangeAmountFromCanonical(target.balance.baseFree, multiplier),
    amountStep,
  );
  exchangeAmount = Decimal.min(exchangeAmount, maxExchangeBase);
  if (trigger.fundingOnly && target.market.minNotional) {
    const minimumAmountByNotional = ceilToStep(
      target.market.minNotional.div(exchangeLimit),
      amountStep,
    );
    if (minimumAmountByNotional.gt(maxExchangeBase)) {
      return { action: 'WAIT', reasons: ['inventory_rebalance_base_surplus_insufficient'] };
    }
    exchangeAmount = Decimal.max(exchangeAmount, minimumAmountByNotional);
  }
  const amount = canonicalAmountFromExchange(exchangeAmount, multiplier);
  if (!amount.gt(0)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_amount_below_minimum'] };
  }
  const canonicalAmount = amount;
  const remainingBaseUsd = target.balance.baseFree.minus(canonicalAmount).mul(targetBid);
  if (remainingBaseUsd.lt(0)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_base_balance_insufficient'] };
  }
  if (!trigger.fundingOnly && remainingBaseUsd.lt(config.minUsefulNotionalUsd)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_would_break_sell_leg'] };
  }
  const expectedQuoteProceeds = canonicalAmount.mul(canonicalWorst).mul(feeFactor);
  if (target.balance.quoteFree.plus(expectedQuoteProceeds).lt(targetQuoteUsd)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_quote_restore_insufficient'] };
  }
  const ownQuote = canonicalAmount.mul(canonicalWorst);
  const alternativeQuote = canonicalAmount.mul(otherBid);
  const expectedCostUsd = Decimal.max(0, alternativeQuote.minus(ownQuote)).plus(
    ownQuote.mul(feeBps.div(10_000)),
  );
  if (expectedCostUsd.gt(config.maxRebalanceLossUsd)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_cost_above_limit'] };
  }
  if (target.market.minAmount && exchangeAmount.lt(target.market.minAmount)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_amount_below_minimum'] };
  }
  const plannedNotional = exchangeAmount.mul(exchangeLimit);
  if (target.market.minNotional && plannedNotional.lt(target.market.minNotional)) {
    return { action: 'WAIT', reasons: ['inventory_rebalance_notional_below_minimum'] };
  }

  return {
    action: 'SELL',
    reasons: [],
    plan: {
      pair,
      venueId: target.venueId,
      otherVenueId: other.venueId,
      base: pair.base.trim().toUpperCase(),
      exchangeBase: marketExchangeBase(target.market),
      quote,
      exchangeSymbol: target.market.exchangeSymbol,
      baseMultiplier: multiplier,
      reason: 'quote_short_with_base_surplus',
      edgeBps: trigger.edgeBps,
      signalSampledAt: trigger.sampledAt,
      fundingOnly: trigger.fundingOnly ?? false,
      currentBaseUsd: targetBaseUsd,
      currentQuoteUsd: target.balance.quoteFree,
      targetQuoteUsd,
      baseSurplusUsd,
      amount: exchangeAmount,
      limitPrice: exchangeLimit,
      expectedQuoteProceeds,
      expectedRemainingBaseUsd: remainingBaseUsd,
      expectedCostUsd,
      ownBid: targetBid,
      otherBid,
      bookFetchedAt: target.book.fetchedAt,
      venueBalance: target.balance,
      otherBalance: other.balance,
    },
  };
}

function metadata(plan: AutomaticInventoryRebalancePlan, extra: Record<string, unknown> = {}) {
  return {
    rebalance: true,
    origin: 'automatic',
    base: plan.base,
    exchangeBase: plan.exchangeBase,
    baseMultiplier: plan.baseMultiplier.toFixed(),
    quote: plan.quote,
    venueId: plan.venueId,
    otherVenueId: plan.otherVenueId,
    exchangeSymbol: plan.exchangeSymbol,
    reason: plan.reason,
    edgeBps: plan.edgeBps.toFixed(),
    signalSampledAt: plan.signalSampledAt,
    fundingOnly: plan.fundingOnly,
    currentBaseUsd: plan.currentBaseUsd.toFixed(),
    currentQuoteUsd: plan.currentQuoteUsd.toFixed(),
    targetQuoteUsd: plan.targetQuoteUsd.toFixed(),
    baseSurplusUsd: plan.baseSurplusUsd.toFixed(),
    amount: plan.amount.toFixed(),
    limitPrice: plan.limitPrice.toFixed(),
    expectedQuoteProceeds: plan.expectedQuoteProceeds.toFixed(),
    expectedRemainingBaseUsd: plan.expectedRemainingBaseUsd.toFixed(),
    expectedCostUsd: plan.expectedCostUsd.toFixed(),
    ownBid: plan.ownBid.toFixed(),
    otherBid: plan.otherBid.toFixed(),
    bookFetchedAt: plan.bookFetchedAt,
    quoteBalanceBefore: plan.venueBalance.quoteFree.toFixed(),
    baseBalanceBefore: plan.venueBalance.baseFree.toFixed(),
    ...extra,
  };
}

function isDefinitiveNoFill(error: unknown): boolean {
  return /FOK_NOT_FILL|cannot be filled completely|ioc[^\n]*not[^\n]*fill/i.test(String(error));
}

function isOrderNotFoundOrInvalidId(error: unknown): boolean {
  return /ordernotfound|client_id_not_found|order not found|clientOrderId[^\n]*invalid/i.test(
    String(error),
  );
}

function rebalanceClientOrderId(now: number): string {
  return `RB-${now.toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

async function freshBalances(
  repository: ArbitrageRepository,
  venue: RecoveryVenue,
  now: number,
): Promise<BalanceSnapshot[]> {
  if (typeof venue.adapter.fetchBalances !== 'function') {
    throw new Error(`balances_unsupported:${venue.adapter.venueId}`);
  }
  const rows = await venue.adapter.fetchBalances(venue.credentials);
  const normalized = rows.map((row) => ({
    ...row,
    fetchedAt: row.fetchedAt > 0 ? row.fetchedAt : now,
  }));
  for (const row of normalized) {
    repository.recordBalance(row);
    repository.recordInventorySnapshot({
      venueId: row.venueId,
      accountId: row.accountId,
      asset: row.currency,
      free: row.free,
      used: row.used,
      total: row.total,
      capturedAt: row.fetchedAt,
    });
  }
  return normalized;
}

function markUnknown(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryRebalancePlan;
  reason: string;
  now: number;
}): AutomaticInventoryRebalanceResult {
  input.repository.updateExecutionLeg(input.clientOrderId, { status: 'unknown' });
  input.repository.updateExecutionStatus(input.executionId, 'REBALANCE_UNKNOWN', {
    safeModeReason: input.reason,
    metadata: metadata(input.plan, { orderStatus: 'unknown', error: input.reason }),
  });
  input.repository.setSetting('kill_switch', 'true', input.now);
  input.repository.recordRiskEvent(
    'critical',
    'inventory_rebalance_unknown',
    'automatic inventory rebalance order state is unknown; do not retry',
    { batchId: input.batchId, clientOrderId: input.clientOrderId, venueId: input.plan.venueId },
    input.now,
  );
  return {
    status: 'UNKNOWN',
    reasons: [input.reason],
    batchId: input.batchId,
    executionId: input.executionId,
    killSwitch: true,
  };
}

function markRejected(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryRebalancePlan;
  now: number;
  order?: OrderState;
}): AutomaticInventoryRebalanceResult {
  input.repository.updateExecutionLeg(input.clientOrderId, {
    status: 'canceled',
    filledAmount: ZERO,
    ...(input.order?.venueOrderId ? { orderId: input.order.venueOrderId } : {}),
  });
  input.repository.updateExecutionStatus(input.executionId, 'REBALANCE_REJECTED', {
    realizedProfit: ZERO,
    closedAt: input.now,
    metadata: metadata(input.plan, { orderStatus: input.order?.status ?? 'canceled' }),
  });
  input.repository.recordAudit(
    'executor',
    'inventory_rebalance_rejected',
    { batchId: input.batchId, venueId: input.plan.venueId, plan: metadata(input.plan) },
    input.now,
  );
  return {
    status: 'REJECTED',
    reasons: ['inventory_rebalance_not_filled'],
    batchId: input.batchId,
    executionId: input.executionId,
    ...(input.order ? { order: input.order } : {}),
  };
}

function markPartial(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryRebalancePlan;
  order: OrderState;
  now: number;
}): AutomaticInventoryRebalanceResult {
  input.repository.updateExecutionLeg(input.clientOrderId, {
    status: 'partial',
    filledAmount: input.order.filled,
    averageFillPrice: input.order.averagePrice,
    feePaid: input.order.fee,
    orderId: input.order.venueOrderId,
  });
  input.repository.updateExecutionStatus(input.executionId, 'REBALANCE_PARTIAL', {
    safeModeReason: 'inventory_rebalance_partial_fill',
    metadata: metadata(input.plan, {
      orderStatus: input.order.status,
      filled: input.order.filled.toFixed(),
      remaining: input.order.remaining.toFixed(),
    }),
  });
  input.repository.setSetting('kill_switch', 'true', input.now);
  input.repository.recordRiskEvent(
    'critical',
    'inventory_rebalance_partial_fill',
    'automatic inventory rebalance did not fill completely; manual review required',
    { batchId: input.batchId, clientOrderId: input.clientOrderId, venueId: input.plan.venueId },
    input.now,
  );
  return {
    status: 'PARTIAL',
    reasons: ['inventory_rebalance_partial_fill'],
    batchId: input.batchId,
    executionId: input.executionId,
    order: input.order,
    filled: input.order.filled,
    killSwitch: true,
  };
}

async function reconcileOrder(input: {
  repository: ArbitrageRepository;
  bundle: RecoveryVenue;
  executionId: number;
  clientOrderId: string;
  symbol: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<OrderState | undefined> {
  let order: OrderState | undefined;
  for (let attempt = 0; attempt < REBALANCE_MAX_ATTEMPTS; attempt += 1) {
    if (typeof input.bundle.adapter.fetchOrder !== 'function') return undefined;
    try {
      order = await input.bundle.adapter.fetchOrder(
        { clientOrderId: input.clientOrderId, symbol: input.symbol },
        input.bundle.credentials,
      );
      input.repository.recordOrder({
        venueId: input.bundle.adapter.venueId,
        venueOrderId: order.venueOrderId,
        clientOrderId: input.clientOrderId,
        executionId: input.executionId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        price: order.price ?? ZERO,
        amount: order.amount,
        filledAmount: order.filled,
        ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
        ...(order.fee ? { fee: order.fee } : {}),
        ...(order.feeCurrency ? { feeCurrency: order.feeCurrency } : {}),
        status: order.status,
        now: Date.now(),
      });
      input.repository.recordOrderEvent(
        input.clientOrderId,
        'rebalance_reconcile_query',
        {
          at: Date.now(),
          attempt: attempt + 1,
          status: order.status,
          filled: order.filled.toFixed(),
          remaining: order.remaining.toFixed(),
        },
        Date.now(),
      );
      if (order.status !== 'unknown' && order.status !== 'open') return order;
    } catch {
      // A failed lookup never makes submission safe to retry.
    }
    if (attempt < REBALANCE_MAX_ATTEMPTS - 1) {
      await input.sleep(200 * (attempt + 1));
    }
  }
  return order;
}

async function finalizeRebalance(input: {
  repository: ArbitrageRepository;
  bundle: RecoveryVenue;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryRebalancePlan;
  order: OrderState;
  now: number;
}): Promise<AutomaticInventoryRebalanceResult> {
  const { repository, bundle, executionId, batchId, clientOrderId, plan, order } = input;
  const filledCanonical = canonicalAmountFromExchange(order.filled, plan.baseMultiplier);
  let baseDeltaExchange = ZERO;
  let baseDelta = ZERO;
  let quoteDelta = ZERO;
  try {
    const rows = await freshBalances(repository, bundle, input.now);
    const base = findBalance(rows, plan.venueId, plan.exchangeBase);
    const quote = findBalance(rows, plan.venueId, plan.quote);
    if (!base || !quote) throw new Error('post-rebalance base/quote balance missing');
    baseDeltaExchange = base.free.minus(plan.venueBalance.baseFree);
    baseDelta = baseDeltaExchange.mul(plan.baseMultiplier);
    quoteDelta = quote.free.minus(plan.venueBalance.quoteFree);
  } catch (error) {
    repository.updateExecutionLeg(clientOrderId, {
      status: 'filled',
      filledAmount: order.filled,
      averageFillPrice: order.averagePrice,
      feePaid: order.fee,
      orderId: order.venueOrderId,
    });
    repository.updateExecutionStatus(executionId, 'REBALANCE_ACCOUNTING_UNKNOWN', {
      safeModeReason: 'inventory_rebalance_balance_delta_unavailable',
      metadata: metadata(plan, { orderStatus: order.status, error: String(error) }),
    });
    repository.setSetting('kill_switch', 'true', input.now);
    repository.recordRiskEvent(
      'critical',
      'inventory_rebalance_accounting_unknown',
      'automatic inventory rebalance filled but post-fill balances are unavailable',
      { batchId, venueId: plan.venueId },
      input.now,
    );
    return {
      status: 'ACCOUNTING_UNKNOWN',
      reasons: ['inventory_rebalance_balance_delta_unavailable'],
      batchId,
      executionId,
      order,
      killSwitch: true,
    };
  }
  if (baseDelta.gte(0) || quoteDelta.lte(0)) {
    repository.updateExecutionLeg(clientOrderId, {
      status: 'filled',
      filledAmount: order.filled,
      averageFillPrice: order.averagePrice,
      feePaid: order.fee,
      orderId: order.venueOrderId,
    });
    repository.updateExecutionStatus(executionId, 'REBALANCE_ACCOUNTING_UNKNOWN', {
      safeModeReason: 'inventory_rebalance_balance_delta_implausible',
      metadata: metadata(plan, {
        orderStatus: order.status,
        baseDeltaExchange: baseDeltaExchange.toFixed(),
        baseDelta: baseDelta.toFixed(),
        quoteDelta: quoteDelta.toFixed(),
      }),
    });
    repository.setSetting('kill_switch', 'true', input.now);
    repository.recordRiskEvent(
      'critical',
      'inventory_rebalance_accounting_unknown',
      'automatic inventory rebalance fill does not match base/quote deltas',
      {
        batchId,
        venueId: plan.venueId,
        baseDelta: baseDelta.toFixed(),
        quoteDelta: quoteDelta.toFixed(),
      },
      input.now,
    );
    return {
      status: 'ACCOUNTING_UNKNOWN',
      reasons: ['inventory_rebalance_balance_delta_implausible'],
      batchId,
      executionId,
      order,
      killSwitch: true,
    };
  }
  repository.recordOrder({
    venueId: plan.venueId,
    venueOrderId: order.venueOrderId,
    clientOrderId,
    executionId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    price: order.price ?? plan.limitPrice,
    amount: order.amount,
    filledAmount: order.filled,
    ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
    ...(order.fee ? { fee: order.fee } : {}),
    ...(order.feeCurrency ? { feeCurrency: order.feeCurrency } : {}),
    status: order.status,
    now: input.now,
  });
  repository.updateExecutionLeg(clientOrderId, {
    status: 'filled',
    filledAmount: order.filled,
    averageFillPrice: order.averagePrice,
    feePaid: order.fee,
    orderId: order.venueOrderId,
  });
  repository.updateExecutionStatus(executionId, 'CLOSED', {
    realizedProfit: ZERO,
    closedAt: input.now,
    grossSpread: ZERO,
    fees: order.fee ?? ZERO,
    latencyMs: Math.max(0, input.now - plan.signalSampledAt),
    inventoryDelta: {
      baseAsset: plan.base,
      baseDelta: baseDelta.toFixed(),
      quoteAsset: plan.quote,
      quoteDelta: quoteDelta.toFixed(),
    },
    metadata: metadata(plan, {
      orderStatus: order.status,
      orderId: order.venueOrderId,
      filled: order.filled.toFixed(),
      filledCanonical: filledCanonical.toFixed(),
      averagePrice: order.averagePrice?.toFixed() ?? null,
      baseDeltaExchange: baseDeltaExchange.toFixed(),
      baseDelta: baseDelta.toFixed(),
      quoteDelta: quoteDelta.toFixed(),
      rebalanceCostUsd: plan.expectedCostUsd.toFixed(),
    }),
  });
  repository.recordAudit(
    'executor',
    'inventory_rebalance_filled',
    {
      batchId,
      executionId,
      venueId: plan.venueId,
      base: plan.base,
      amount: order.filled.toFixed(),
      quoteProceeds: quoteDelta.toFixed(),
      expectedCostUsd: plan.expectedCostUsd.toFixed(),
      edgeBps: plan.edgeBps.toFixed(),
    },
    input.now,
  );
  repository.recordRiskEvent(
    'info',
    'inventory_rebalanced',
    'automatic inventory rebalance restored the buy-side quote reserve',
    {
      batchId,
      executionId,
      venueId: plan.venueId,
      base: plan.base,
      amount: order.filled.toFixed(),
      quoteProceeds: quoteDelta.toFixed(),
      expectedCostUsd: plan.expectedCostUsd.toFixed(),
    },
    input.now,
  );
  return {
    status: 'FILLED',
    reasons: [],
    batchId,
    executionId,
    order,
    filled: order.filled,
  };
}

export async function attemptAutomaticInventoryRebalance(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  markets: Readonly<Record<string, MarketMetadata[]>>;
  pair: RotationPairConfig;
  trigger: InventoryRebalanceTrigger;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AutomaticInventoryRebalanceResult> {
  const { repository, config, adapters, markets, pair, trigger } = input;
  const settings = config.autoRotation.inventory;
  const now = input.now ?? Date.now();
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!settings.enabled || !settings.rebalanceEnabled) {
    return { status: 'BLOCKED', reasons: ['inventory_rebalance_disabled'] };
  }
  if (!config.liveEnabled || repository.getSetting('live_enabled') !== 'true') {
    return { status: 'BLOCKED', reasons: ['live_execution_disabled'] };
  }
  if (repository.getSetting('auto_execution_enabled') !== 'true') {
    return { status: 'BLOCKED', reasons: ['persisted_automatic_execution_disabled'] };
  }
  if (repository.getSetting('kill_switch') !== 'false') {
    return { status: 'BLOCKED', reasons: ['kill_switch_on'] };
  }
  if (repository.countOpenExecutions() > 0) {
    return { status: 'WAIT', reasons: ['open_execution'] };
  }
  if (repository.countUnresolvedOrders() > 0) {
    return { status: 'WAIT', reasons: ['unresolved_order'] };
  }

  const venueData: Array<{ bundle: RecoveryVenue; market: MarketMetadata }> = [];
  for (const venueId of pair.venues) {
    const bundle = adapters[venueId];
    if (!bundle) return { status: 'BLOCKED', reasons: [`inventory_adapter_missing:${venueId}`] };
    const market = findMarket(markets[venueId] ?? [], venueId, pair.base, pair.quote);
    if (!market) return { status: 'WAIT', reasons: [`inventory_market_missing:${venueId}`] };
    if (!bundle.adapter.capabilities.privateBalances) {
      return { status: 'BLOCKED', reasons: [`inventory_capability_missing:${venueId}`] };
    }
    venueData.push({ bundle, market });
  }
  const books = await Promise.all(
    venueData.map(async ({ bundle, market }) => {
      try {
        return await bundle.adapter.fetchOrderBook(market.exchangeSymbol, config.orderbookDepth);
      } catch (error) {
        return { error: String(error) };
      }
    }),
  );
  const snapshots: InventoryRebalanceVenueSnapshot[] = [];
  for (let index = 0; index < venueData.length; index += 1) {
    const row = venueData[index]!;
    const result = books[index];
    if (!result || 'error' in result) {
      return { status: 'WAIT', reasons: [`inventory_book_unavailable:${row.market.venueId}`] };
    }
    const observedAt = Date.now();
    if (observedAt - bookReceivedAt(result) > REBALANCE_BOOK_MAX_AGE_MS) {
      return {
        status: 'WAIT',
        reasons: [`inventory_book_received_stale:${row.market.venueId}`],
      };
    }
    const validation = validateOrderBook(result, {
      expectedVenueId: row.market.venueId,
      expectedSymbol: row.market.exchangeSymbol,
      maxAgeMs: Math.max(
        config.settings.maxOrderbookAgeMs,
        REBALANCE_EXCHANGE_TIMESTAMP_MAX_AGE_MS,
      ),
      now: observedAt,
    });
    if (!validation.valid) {
      return {
        status: 'WAIT',
        reasons: validation.reasons.map((reason) => `inventory_book_${reason}`),
      };
    }
    snapshots.push({
      venueId: row.market.venueId,
      market: row.market,
      book: validation.book,
      balance: { venueId: row.market.venueId, baseFree: ZERO, quoteFree: ZERO, fetchedAt: 0 },
    });
  }
  const freshRows = await Promise.all(
    venueData.map(async ({ bundle }) => {
      try {
        return await freshBalances(repository, bundle, now);
      } catch (error) {
        return { error: String(error) };
      }
    }),
  );
  const freshSnapshots: InventoryRebalanceVenueSnapshot[] = [];
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]!;
    const rows = freshRows[index];
    if (!rows || 'error' in rows) {
      return {
        status: 'WAIT',
        reasons: [`inventory_balance_refresh_failed:${snapshot.venueId}`],
      };
    }
    const view = balanceView(rows, snapshot.venueId, snapshot.market);
    if (!view) {
      return { status: 'WAIT', reasons: [`inventory_balance_missing:${snapshot.venueId}`] };
    }
    freshSnapshots.push({ ...snapshot, balance: view });
  }
  const decision = planAutomaticInventoryRebalance({
    pair,
    venues: freshSnapshots,
    config: settings,
    trigger,
    now,
  });
  if (decision.action !== 'SELL') {
    return { status: decision.action, reasons: decision.reasons };
  }
  const plan = decision.plan;
  const bundle = adapters[plan.venueId];
  if (!bundle) return { status: 'BLOCKED', reasons: ['inventory_adapter_missing'], plan };
  if (
    !bundle.adapter.capabilities.createOrder ||
    !bundle.adapter.capabilities.fetchOrder ||
    !bundle.adapter.capabilities.openOrders
  ) {
    return { status: 'BLOCKED', reasons: ['inventory_rebalance_capability_missing'], plan };
  }
  if (!config.fokVenues.includes(plan.venueId)) {
    return { status: 'BLOCKED', reasons: [`inventory_fok_not_enabled:${plan.venueId}`], plan };
  }
  const openOrders = await fetchOpenOrdersForSymbols(bundle.adapter, bundle.credentials, [
    plan.exchangeSymbol,
  ]);
  if (openOrders.errors.length > 0) {
    return { status: 'WAIT', reasons: openOrders.errors, plan };
  }
  if (openOrders.orders.length > 0) {
    return { status: 'WAIT', reasons: ['open_orders_present'], plan };
  }
  if (Date.now() - plan.bookFetchedAt > REBALANCE_BOOK_MAX_AGE_MS) {
    return { status: 'WAIT', reasons: ['inventory_book_expired_before_submit'], plan };
  }

  const batchId = `REBAL-${plan.base}-${now}-${plan.venueId}-${randomUUID().slice(0, 8)}`;
  const clientOrderId = rebalanceClientOrderId(now);
  const executionId = repository.createExecution({
    strategy: 'REBALANCE',
    batchId,
    status: 'REBALANCE_SUBMITTING',
    plannedNotional: plan.amount.mul(plan.limitPrice),
    expectedProfit: ZERO,
    openedAt: now,
    metadata: metadata(plan),
  });
  repository.addExecutionLeg({
    executionId,
    legNumber: 1,
    venueId: plan.venueId,
    side: 'sell',
    requestedAmount: plan.amount,
    requestedPrice: plan.limitPrice,
    status: 'submitting',
    submittedAt: now,
    clientOrderId,
  });
  repository.recordOrder({
    venueId: plan.venueId,
    clientOrderId,
    executionId,
    symbol: plan.exchangeSymbol,
    side: 'sell',
    type: 'limit',
    price: plan.limitPrice,
    amount: plan.amount,
    filledAmount: ZERO,
    status: 'pending',
    now,
  });
  repository.recordOrderEvent(
    clientOrderId,
    'submission_request',
    {
      at: now,
      symbol: plan.exchangeSymbol,
      side: 'sell',
      type: 'limit',
      amount: plan.amount.toFixed(),
      price: plan.limitPrice.toFixed(),
      timeInForce: 'FOK',
      clientOrderId,
    },
    now,
  );
  repository.recordAudit(
    'executor',
    'inventory_rebalance_attempt',
    { batchId, executionId, plan: metadata(plan) },
    now,
  );

  let order: OrderState;
  try {
    order = await bundle.adapter.createOrder!(
      {
        symbol: plan.exchangeSymbol,
        side: 'sell',
        type: 'limit',
        amount: plan.amount,
        price: plan.limitPrice,
        timeInForce: 'FOK',
        clientOrderId,
      },
      bundle.credentials,
    );
  } catch (error) {
    const definitive = isDefinitiveNoFill(error);
    repository.recordOrder({
      venueId: plan.venueId,
      clientOrderId,
      executionId,
      symbol: plan.exchangeSymbol,
      side: 'sell',
      type: 'limit',
      price: plan.limitPrice,
      amount: plan.amount,
      filledAmount: ZERO,
      status: definitive ? 'canceled' : 'unknown',
      now: Date.now(),
    });
    repository.recordOrderEvent(
      clientOrderId,
      definitive ? 'definitive_no_fill' : 'submission_error',
      { at: Date.now(), error: String(error) },
      Date.now(),
    );
    if (definitive) {
      return markRejected({
        repository,
        executionId,
        batchId,
        clientOrderId,
        plan,
        now: Date.now(),
      });
    }
    const reconciled = await reconcileOrder({
      repository,
      bundle,
      executionId,
      clientOrderId,
      symbol: plan.exchangeSymbol,
      sleep,
    });
    if (reconciled) {
      if (reconciled.status === 'unknown' || reconciled.status === 'open') {
        return markUnknown({
          repository,
          executionId,
          batchId,
          clientOrderId,
          plan,
          reason: 'inventory_rebalance_submission_unknown',
          now: Date.now(),
        });
      }
      if (reconciled.filled.lte(0)) {
        return markRejected({
          repository,
          executionId,
          batchId,
          clientOrderId,
          plan,
          now: Date.now(),
          order: reconciled,
        });
      }
      if (reconciled.filled.lt(reconciled.amount)) {
        return markPartial({
          repository,
          executionId,
          batchId,
          clientOrderId,
          plan,
          order: reconciled,
          now: Date.now(),
        });
      }
      repository.setSetting('kill_switch', 'true', Date.now());
      repository.recordRiskEvent(
        'critical',
        'inventory_rebalance_submission_ambiguous_resolved',
        'ambiguous inventory rebalance submission was resolved by order lookup; manual review required',
        { batchId, clientOrderId, venueId: plan.venueId },
        Date.now(),
      );
      return finalizeRebalance({
        repository,
        bundle,
        executionId,
        batchId,
        clientOrderId,
        plan,
        order: reconciled,
        now: Date.now(),
      });
    }
    if (isOrderNotFoundOrInvalidId(error)) {
      try {
        const rows = await freshBalances(repository, bundle, Date.now());
        const base = findBalance(rows, plan.venueId, plan.exchangeBase);
        const quote = findBalance(rows, plan.venueId, plan.quote);
        if (
          base &&
          quote &&
          base.free.eq(plan.venueBalance.baseFree) &&
          quote.free.eq(plan.venueBalance.quoteFree)
        ) {
          return markRejected({
            repository,
            executionId,
            batchId,
            clientOrderId,
            plan,
            now: Date.now(),
          });
        }
      } catch {
        // Fall through to unknown; unchanged balances are the only safe no-fill proof.
      }
    }
    return markUnknown({
      repository,
      executionId,
      batchId,
      clientOrderId,
      plan,
      reason: 'inventory_rebalance_submission_unknown',
      now: Date.now(),
    });
  }

  const responseAt = Date.now();
  repository.recordOrder({
    venueId: plan.venueId,
    venueOrderId: order.venueOrderId,
    clientOrderId,
    executionId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    price: order.price ?? plan.limitPrice,
    amount: order.amount,
    filledAmount: order.filled,
    ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
    ...(order.fee ? { fee: order.fee } : {}),
    ...(order.feeCurrency ? { feeCurrency: order.feeCurrency } : {}),
    status: order.status,
    now: responseAt,
  });
  repository.recordOrderEvent(
    clientOrderId,
    'submission_response',
    {
      at: responseAt,
      status: order.status,
      filled: order.filled.toFixed(),
      remaining: order.remaining.toFixed(),
      raw: order.raw,
    },
    responseAt,
  );
  if (order.status === 'open' && order.remaining.gt(0)) {
    if (typeof bundle.adapter.cancelOrder !== 'function') {
      return markUnknown({
        repository,
        executionId,
        batchId,
        clientOrderId,
        plan,
        reason: 'inventory_rebalance_open_without_cancel',
        now: Date.now(),
      });
    }
    try {
      order = await bundle.adapter.cancelOrder(
        { clientOrderId, symbol: plan.exchangeSymbol },
        bundle.credentials,
      );
    } catch (error) {
      repository.recordOrderEvent(
        clientOrderId,
        'cancel_error',
        { at: Date.now(), error: String(error) },
        Date.now(),
      );
      return markUnknown({
        repository,
        executionId,
        batchId,
        clientOrderId,
        plan,
        reason: 'inventory_rebalance_cancel_unknown',
        now: Date.now(),
      });
    }
  }
  if (order.status === 'unknown' || order.status === 'open') {
    const reconciled = await reconcileOrder({
      repository,
      bundle,
      executionId,
      clientOrderId,
      symbol: plan.exchangeSymbol,
      sleep,
    });
    if (!reconciled || reconciled.status === 'unknown' || reconciled.status === 'open') {
      return markUnknown({
        repository,
        executionId,
        batchId,
        clientOrderId,
        plan,
        reason: 'inventory_rebalance_reconcile_unavailable',
        now: Date.now(),
      });
    }
    order = reconciled;
  }
  if (order.filled.lte(0)) {
    return markRejected({
      repository,
      executionId,
      batchId,
      clientOrderId,
      plan,
      now: Date.now(),
      order,
    });
  }
  if (order.filled.lt(order.amount)) {
    return markPartial({
      repository,
      executionId,
      batchId,
      clientOrderId,
      plan,
      order,
      now: Date.now(),
    });
  }
  return finalizeRebalance({
    repository,
    bundle,
    executionId,
    batchId,
    clientOrderId,
    plan,
    order,
    now: Date.now(),
  });
}
