import { randomUUID } from 'node:crypto';
import {
  Decimal,
  ZERO,
  alignAmountDown,
  calculateBuyDepthByQuote,
  canonicalAmountFromExchange,
  canonicalPriceFromExchange,
  ceilToStep,
  marketBaseMultiplier,
  marketExchangeBase,
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

const USD_QUOTES = new Set(['USD', 'USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI']);
const SEED_BOOK_MAX_AGE_MS = 5_000;
const SEED_MAX_ATTEMPTS = 3;

export interface InventoryBalanceView {
  venueId: string;
  baseFree: Decimal;
  quoteFree: Decimal;
  fetchedAt: number;
}

export interface InventoryVenueSnapshot {
  venueId: string;
  market: MarketMetadata;
  book: OrderBookSnapshot;
  balance: InventoryBalanceView;
}

export interface InventoryStabilityObservation {
  venueId: string;
  referenceCanonicalAsk: Decimal;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type InventorySeedReason =
  'both_sides_missing_cheaper_side' | 'missing_side_cheaper' | 'missing_side_near_parity';

export interface AutomaticInventoryPlan {
  pair: RotationPairConfig;
  venueId: string;
  otherVenueId: string;
  base: string;
  quote: string;
  exchangeSymbol: string;
  baseMultiplier: Decimal;
  canonicalAsk: Decimal;
  canonicalBid: Decimal;
  pairDeviationBps: Decimal;
  reason: InventorySeedReason;
  currentBaseUsd: Decimal;
  otherBaseUsd: Decimal;
  spendQuote: Decimal;
  amount: Decimal;
  limitPrice: Decimal;
  plannedNotional: Decimal;
  expectedBaseValueUsd: Decimal;
  grossFeeBps: Decimal;
  bookFetchedAt: number;
  observation: InventoryStabilityObservation;
  venueBalance: InventoryBalanceView;
  otherBalance: InventoryBalanceView;
}

export type AutomaticInventoryDecision =
  | { action: 'SEED'; reasons: []; plan: AutomaticInventoryPlan }
  | {
      action: 'WAIT' | 'NOOP' | 'BLOCKED';
      reasons: string[];
      observation?: InventoryStabilityObservation;
    };

export type AutomaticInventoryStatus =
  'NOOP' | 'WAIT' | 'BLOCKED' | 'REJECTED' | 'UNKNOWN' | 'PARTIAL' | 'FILLED';

export interface AutomaticInventoryResult {
  status: AutomaticInventoryStatus;
  reasons: string[];
  observation?: InventoryStabilityObservation;
  plan?: AutomaticInventoryPlan;
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
): InventoryBalanceView | undefined {
  const base = findBalance(rows, venueId, marketExchangeBase(market));
  const quote = findBalance(rows, venueId, market.quote);
  if (!base || !quote) return undefined;
  return {
    venueId,
    baseFree: base.free,
    quoteFree: quote.free,
    fetchedAt: Math.min(base.fetchedAt, quote.fetchedAt),
  };
}

function updateObservation(
  previous: InventoryStabilityObservation | undefined,
  venueId: string,
  canonicalAskValue: Decimal,
  maxPriceDriftBps: Decimal,
  now: number,
): InventoryStabilityObservation {
  if (!previous || previous.venueId !== venueId || previous.referenceCanonicalAsk.lte(0)) {
    return {
      venueId,
      referenceCanonicalAsk: canonicalAskValue,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }
  const driftBps = canonicalAskValue
    .minus(previous.referenceCanonicalAsk)
    .abs()
    .div(previous.referenceCanonicalAsk)
    .mul(10_000);
  if (driftBps.gt(maxPriceDriftBps)) {
    return {
      venueId,
      referenceCanonicalAsk: canonicalAskValue,
      firstSeenAt: now,
      lastSeenAt: now,
    };
  }
  return { ...previous, lastSeenAt: now };
}

function bestLevel(book: OrderBookSnapshot, side: 'asks' | 'bids') {
  return side === 'asks' ? book.asks[0] : book.bids[0];
}

function canonicalAsk(venue: InventoryVenueSnapshot): Decimal | undefined {
  const level = bestLevel(venue.book, 'asks');
  if (!level) return undefined;
  return canonicalPriceFromExchange(level.price, marketBaseMultiplier(venue.market));
}

function canonicalBid(venue: InventoryVenueSnapshot): Decimal | undefined {
  const level = bestLevel(venue.book, 'bids');
  if (!level) return undefined;
  return canonicalPriceFromExchange(level.price, marketBaseMultiplier(venue.market));
}

function baseUsd(venue: InventoryVenueSnapshot): Decimal | undefined {
  const bid = bestLevel(venue.book, 'bids');
  if (!bid) return undefined;
  return venue.balance.baseFree.mul(bid.price);
}

function sortVenues(
  pair: RotationPairConfig,
  venues: readonly InventoryVenueSnapshot[],
): [InventoryVenueSnapshot, InventoryVenueSnapshot] | undefined {
  const first = venues.find((venue) => venue.venueId === pair.venues[0]);
  const second = venues.find((venue) => venue.venueId === pair.venues[1]);
  return first && second ? [first, second] : undefined;
}

export function planAutomaticInventorySeed(input: {
  pair: RotationPairConfig;
  venues: readonly InventoryVenueSnapshot[];
  config: AutoInventoryConfig;
  now: number;
  previousObservation?: InventoryStabilityObservation;
}): AutomaticInventoryDecision {
  const { pair, config, now, previousObservation } = input;
  const quote = pair.quote.trim().toUpperCase();
  if (!USD_QUOTES.has(quote)) {
    return { action: 'BLOCKED', reasons: ['inventory_quote_not_usd_stable'] };
  }
  const ordered = sortVenues(pair, input.venues);
  if (!ordered) return { action: 'BLOCKED', reasons: ['inventory_venue_snapshot_incomplete'] };
  const [first, second] = ordered;
  const firstAsk = canonicalAsk(first);
  const secondAsk = canonicalAsk(second);
  const firstBid = canonicalBid(first);
  const secondBid = canonicalBid(second);
  const firstBaseUsd = baseUsd(first);
  const secondBaseUsd = baseUsd(second);
  if (!firstAsk || !secondAsk || !firstBid || !secondBid || !firstBaseUsd || !secondBaseUsd) {
    return { action: 'WAIT', reasons: ['inventory_book_incomplete'] };
  }
  if (!firstAsk.isFinite() || !secondAsk.isFinite() || firstAsk.lte(0) || secondAsk.lte(0)) {
    return { action: 'WAIT', reasons: ['inventory_ask_invalid'] };
  }
  const firstUseful = firstBaseUsd.gte(config.minUsefulNotionalUsd);
  const secondUseful = secondBaseUsd.gte(config.minUsefulNotionalUsd);
  if (firstUseful && secondUseful) {
    return { action: 'NOOP', reasons: ['inventory_sufficient'] };
  }

  let seed: InventoryVenueSnapshot;
  let other: InventoryVenueSnapshot;
  let seedAsk: Decimal;
  let otherAsk: Decimal;
  let seedBaseUsd: Decimal;
  let otherBaseUsd: Decimal;
  let reason: InventorySeedReason;
  if (!firstUseful && !secondUseful) {
    const firstCheaper = firstAsk.lte(secondAsk);
    seed = firstCheaper ? first : second;
    other = firstCheaper ? second : first;
    seedAsk = firstCheaper ? firstAsk : secondAsk;
    otherAsk = firstCheaper ? secondAsk : firstAsk;
    seedBaseUsd = firstCheaper ? firstBaseUsd : secondBaseUsd;
    otherBaseUsd = firstCheaper ? secondBaseUsd : firstBaseUsd;
    reason = 'both_sides_missing_cheaper_side';
  } else {
    seed = firstUseful ? second : first;
    other = firstUseful ? first : second;
    seedAsk = firstUseful ? secondAsk : firstAsk;
    otherAsk = firstUseful ? firstAsk : secondAsk;
    seedBaseUsd = firstUseful ? secondBaseUsd : firstBaseUsd;
    otherBaseUsd = firstUseful ? firstBaseUsd : secondBaseUsd;
    const deviationBps = seedAsk.minus(otherAsk).div(otherAsk).mul(10_000);
    if (seedAsk.gt(otherAsk) && deviationBps.gt(config.maxPairDeviationBps)) {
      return { action: 'WAIT', reasons: ['missing_side_above_pair_band'] };
    }
    reason = seedAsk.lte(otherAsk) ? 'missing_side_cheaper' : 'missing_side_near_parity';
  }

  const observation = updateObservation(
    previousObservation,
    seed.venueId,
    seedAsk,
    config.maxPriceDriftBps,
    now,
  );
  if (now - observation.firstSeenAt < config.minStableMs) {
    return { action: 'WAIT', reasons: ['inventory_price_not_stable'], observation };
  }

  const amountStep = seed.market.amountStep;
  const priceStep = seed.market.priceStep;
  if (!amountStep || !priceStep) {
    return { action: 'BLOCKED', reasons: ['inventory_market_precision_missing'] };
  }
  const feeBps = seed.market.feeTakerBps ?? ZERO;
  const availableQuote = seed.balance.quoteFree.minus(config.minQuoteReserveUsd);
  if (availableQuote.lte(0)) {
    return { action: 'WAIT', reasons: ['inventory_quote_reserve_exhausted'], observation };
  }
  const targetSpend = Decimal.max(0, config.seedNotionalUsd.minus(seedBaseUsd));
  const maxSpend = Decimal.min(
    targetSpend,
    pair.maxNotional,
    availableQuote.div(new Decimal(1).plus(feeBps.div(10_000))),
  );
  if (maxSpend.lte(0)) {
    return { action: 'WAIT', reasons: ['inventory_quote_insufficient'], observation };
  }
  const depth = calculateBuyDepthByQuote(seed.book, maxSpend);
  if (!depth.executableBaseAmount.gt(0) || !depth.executableQuoteAmount.gt(0)) {
    return { action: 'WAIT', reasons: ['inventory_ask_liquidity_missing'], observation };
  }
  let amount = alignAmountDown(depth.executableBaseAmount, amountStep);
  const limitPrice = ceilToStep(depth.worstPrice, priceStep);
  const maxAmountByBalance = alignAmountDown(
    availableQuote.div(limitPrice.mul(new Decimal(1).plus(feeBps.div(10_000)))),
    amountStep,
  );
  amount = Decimal.min(amount, maxAmountByBalance);
  if (!amount.gt(0)) {
    return { action: 'WAIT', reasons: ['inventory_amount_below_minimum'], observation };
  }
  const plannedNotional = amount.mul(limitPrice);
  if (seed.market.minAmount && amount.lt(seed.market.minAmount)) {
    return { action: 'WAIT', reasons: ['inventory_amount_below_minimum'], observation };
  }
  if (seed.market.minNotional && plannedNotional.lt(seed.market.minNotional)) {
    return { action: 'WAIT', reasons: ['inventory_notional_below_minimum'], observation };
  }
  if (plannedNotional.gt(pair.maxNotional)) {
    return { action: 'WAIT', reasons: ['inventory_pair_notional_exceeded'], observation };
  }
  const seedBestBid = bestLevel(seed.book, 'bids');
  if (!seedBestBid) {
    return { action: 'WAIT', reasons: ['inventory_book_incomplete'], observation };
  }
  const expectedBaseValueUsd = amount.mul(seedBestBid.price);
  if (seedBaseUsd.plus(expectedBaseValueUsd).lt(config.minUsefulNotionalUsd)) {
    return { action: 'WAIT', reasons: ['inventory_seed_below_useful_notional'], observation };
  }
  return {
    action: 'SEED',
    reasons: [],
    plan: {
      pair,
      venueId: seed.venueId,
      otherVenueId: other.venueId,
      base: pair.base.trim().toUpperCase(),
      quote,
      exchangeSymbol: seed.market.exchangeSymbol,
      baseMultiplier: marketBaseMultiplier(seed.market),
      canonicalAsk: seedAsk,
      canonicalBid: canonicalBid(seed) ?? ZERO,
      pairDeviationBps: seedAsk.minus(otherAsk).div(otherAsk).mul(10_000),
      reason,
      currentBaseUsd: seedBaseUsd,
      otherBaseUsd,
      spendQuote: plannedNotional,
      amount,
      limitPrice,
      plannedNotional,
      expectedBaseValueUsd,
      grossFeeBps: feeBps,
      bookFetchedAt: seed.book.fetchedAt,
      observation,
      venueBalance: seed.balance,
      otherBalance: other.balance,
    },
  };
}

function isDefinitiveNoFill(error: unknown): boolean {
  return /FOK_NOT_FILL|cannot be filled completely|ioc[^\n]*not[^\n]*fill/i.test(String(error));
}

function recordBalances(
  repository: ArbitrageRepository,
  rows: readonly BalanceSnapshot[],
  now: number,
): void {
  for (const row of rows) {
    const fetchedAt = row.fetchedAt > 0 ? row.fetchedAt : now;
    repository.recordBalance({ ...row, fetchedAt });
    repository.recordInventorySnapshot({
      venueId: row.venueId,
      accountId: row.accountId,
      asset: row.currency,
      free: row.free,
      used: row.used,
      total: row.total,
      capturedAt: fetchedAt,
    });
  }
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
  recordBalances(repository, normalized, now);
  return normalized;
}

function seedMetadata(plan: AutomaticInventoryPlan, extra: Record<string, unknown> = {}) {
  return {
    seed: true,
    origin: 'automatic',
    base: plan.base,
    quote: plan.quote,
    venueId: plan.venueId,
    otherVenueId: plan.otherVenueId,
    exchangeSymbol: plan.exchangeSymbol,
    reason: plan.reason,
    canonicalAsk: plan.canonicalAsk.toFixed(),
    canonicalBid: plan.canonicalBid.toFixed(),
    pairDeviationBps: plan.pairDeviationBps.toFixed(),
    currentBaseUsd: plan.currentBaseUsd.toFixed(),
    otherBaseUsd: plan.otherBaseUsd.toFixed(),
    spendQuote: plan.spendQuote.toFixed(),
    plannedNotional: plan.plannedNotional.toFixed(),
    amount: plan.amount.toFixed(),
    limitPrice: plan.limitPrice.toFixed(),
    expectedBaseValueUsd: plan.expectedBaseValueUsd.toFixed(),
    grossFeeBps: plan.grossFeeBps.toFixed(),
    bookFetchedAt: plan.bookFetchedAt,
    observationFirstSeenAt: plan.observation.firstSeenAt,
    quoteBalanceBefore: plan.venueBalance.quoteFree.toFixed(),
    baseBalanceBefore: plan.venueBalance.baseFree.toFixed(),
    ...extra,
  };
}

async function reconcileSeedOrder(input: {
  repository: ArbitrageRepository;
  bundle: RecoveryVenue;
  executionId: number;
  clientOrderId: string;
  symbol: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<OrderState | undefined> {
  let order: OrderState | undefined;
  for (let attempt = 0; attempt < SEED_MAX_ATTEMPTS; attempt += 1) {
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
        status: order.status,
        now: Date.now(),
      });
      input.repository.recordOrderEvent(
        input.clientOrderId,
        'seed_reconcile_query',
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
      // A failed lookup does not make the submission safe to retry.
    }
    if (attempt < SEED_MAX_ATTEMPTS - 1) {
      await input.sleep(200 * (attempt + 1));
    }
  }
  return order;
}

function markUnknown(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryPlan;
  reason: string;
  now: number;
}): AutomaticInventoryResult {
  input.repository.updateExecutionLeg(input.clientOrderId, { status: 'unknown' });
  input.repository.updateExecutionStatus(input.executionId, 'SEED_UNKNOWN', {
    safeModeReason: input.reason,
    metadata: seedMetadata(input.plan, { orderStatus: 'unknown', error: input.reason }),
  });
  input.repository.setSetting('kill_switch', 'true', input.now);
  input.repository.recordRiskEvent(
    'critical',
    'inventory_seed_unknown',
    'automatic inventory seed order state is unknown; do not retry',
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

function markPartial(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryPlan;
  order: OrderState;
  now: number;
}): AutomaticInventoryResult {
  const filledCanonical = canonicalAmountFromExchange(
    input.order.filled,
    input.plan.baseMultiplier,
  );
  input.repository.updateExecutionLeg(input.clientOrderId, {
    status: 'partial',
    filledAmount: input.order.filled,
    averageFillPrice: input.order.averagePrice,
    feePaid: input.order.fee,
    orderId: input.order.venueOrderId,
  });
  input.repository.updateExecutionStatus(input.executionId, 'SEED_PARTIAL', {
    safeModeReason: 'inventory_seed_partial_fill',
    inventoryDelta: {
      baseAsset: input.plan.base,
      baseDelta: filledCanonical.toFixed(),
      quoteAsset: input.plan.quote,
      quoteDelta: ZERO.minus(
        (input.order.averagePrice ?? input.plan.limitPrice)
          .mul(input.order.filled)
          .plus(input.order.fee ?? ZERO),
      ).toFixed(),
    },
    metadata: seedMetadata(input.plan, {
      orderStatus: input.order.status,
      filled: input.order.filled.toFixed(),
      remaining: input.order.remaining.toFixed(),
    }),
  });
  input.repository.setSetting('kill_switch', 'true', input.now);
  input.repository.recordRiskEvent(
    'critical',
    'inventory_seed_partial_fill',
    'automatic inventory seed did not fill completely; manual review required',
    {
      batchId: input.batchId,
      clientOrderId: input.clientOrderId,
      venueId: input.plan.venueId,
      filled: input.order.filled.toFixed(),
      remaining: input.order.remaining.toFixed(),
    },
    input.now,
  );
  return {
    status: 'PARTIAL',
    reasons: ['inventory_seed_partial_fill'],
    batchId: input.batchId,
    executionId: input.executionId,
    order: input.order,
    filled: input.order.filled,
    killSwitch: true,
  };
}

function markRejected(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryPlan;
  now: number;
  order?: OrderState;
}): AutomaticInventoryResult {
  input.repository.updateExecutionLeg(input.clientOrderId, {
    status: 'canceled',
    filledAmount: ZERO,
    ...(input.order?.averagePrice ? { averageFillPrice: input.order.averagePrice } : {}),
    ...(input.order?.fee ? { feePaid: input.order.fee } : {}),
    ...(input.order?.venueOrderId ? { orderId: input.order.venueOrderId } : {}),
  });
  input.repository.updateExecutionStatus(input.executionId, 'SEED_REJECTED', {
    realizedProfit: ZERO,
    closedAt: input.now,
    metadata: seedMetadata(input.plan, { orderStatus: input.order?.status ?? 'canceled' }),
  });
  input.repository.recordAudit(
    'executor',
    'inventory_seed_rejected',
    { batchId: input.batchId, venueId: input.plan.venueId, plan: seedMetadata(input.plan) },
    input.now,
  );
  return {
    status: 'REJECTED',
    reasons: ['inventory_seed_not_filled'],
    batchId: input.batchId,
    executionId: input.executionId,
    ...(input.order ? { order: input.order } : {}),
  };
}

async function finalizeSeed(input: {
  repository: ArbitrageRepository;
  bundle: RecoveryVenue;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryPlan;
  order: OrderState;
  now: number;
}): Promise<AutomaticInventoryResult> {
  const { repository, bundle, plan, order } = input;
  try {
    await freshBalances(repository, bundle, input.now);
  } catch (error) {
    repository.recordRiskEvent(
      'warning',
      'inventory_seed_post_balance_failed',
      String(error),
      { batchId: input.batchId, venueId: plan.venueId },
      input.now,
    );
  }
  const filledCanonical = canonicalAmountFromExchange(order.filled, plan.baseMultiplier);
  const quoteSpent = (order.averagePrice ?? plan.limitPrice)
    .mul(order.filled)
    .plus(order.fee ?? ZERO);
  const closedAt = input.now;
  repository.updateExecutionLeg(input.clientOrderId, {
    status: 'filled',
    filledAmount: order.filled,
    averageFillPrice: order.averagePrice,
    feePaid: order.fee,
    orderId: order.venueOrderId,
  });
  repository.updateExecutionStatus(input.executionId, 'CLOSED', {
    realizedProfit: ZERO,
    closedAt,
    grossSpread: ZERO,
    fees: order.fee ?? ZERO,
    latencyMs: Math.max(0, closedAt - plan.observation.firstSeenAt),
    inventoryDelta: {
      baseAsset: plan.base,
      baseDelta: filledCanonical.toFixed(),
      quoteAsset: plan.quote,
      quoteDelta: quoteSpent.negated().toFixed(),
    },
    metadata: seedMetadata(plan, {
      orderStatus: order.status,
      orderId: order.venueOrderId,
      filled: order.filled.toFixed(),
      filledCanonical: filledCanonical.toFixed(),
      averagePrice: order.averagePrice?.toFixed() ?? null,
      quoteSpent: quoteSpent.toFixed(),
    }),
  });
  repository.recordAudit(
    'executor',
    'inventory_seed_filled',
    {
      batchId: input.batchId,
      executionId: input.executionId,
      venueId: plan.venueId,
      base: plan.base,
      amount: order.filled.toFixed(),
      filledCanonical: filledCanonical.toFixed(),
      averagePrice: order.averagePrice?.toFixed() ?? null,
      quoteSpent: quoteSpent.toFixed(),
      reason: plan.reason,
    },
    closedAt,
  );
  repository.recordRiskEvent(
    'info',
    'inventory_seeded',
    'automatic inventory seed filled',
    {
      batchId: input.batchId,
      executionId: input.executionId,
      venueId: plan.venueId,
      base: plan.base,
      amount: order.filled.toFixed(),
      reason: plan.reason,
    },
    closedAt,
  );
  return {
    status: 'FILLED',
    reasons: [],
    batchId: input.batchId,
    executionId: input.executionId,
    order,
    filled: order.filled,
  };
}

export async function attemptAutomaticInventorySeed(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  markets: Readonly<Record<string, MarketMetadata[]>>;
  pair: RotationPairConfig;
  now?: number;
  previousObservation?: InventoryStabilityObservation;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AutomaticInventoryResult> {
  const { repository, config, adapters, markets, pair } = input;
  const settings = config.autoRotation.inventory;
  const now = input.now ?? Date.now();
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (!settings.enabled) return { status: 'BLOCKED', reasons: ['inventory_disabled'] };
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
  const snapshots: InventoryVenueSnapshot[] = [];
  for (let index = 0; index < venueData.length; index += 1) {
    const row = venueData[index]!;
    const result = books[index];
    if (!result || 'error' in result) {
      return { status: 'WAIT', reasons: [`inventory_book_unavailable:${row.market.venueId}`] };
    }
    const validation = validateOrderBook(result, {
      expectedVenueId: row.market.venueId,
      expectedSymbol: row.market.exchangeSymbol,
      maxAgeMs: Math.min(config.settings.maxOrderbookAgeMs, SEED_BOOK_MAX_AGE_MS),
      now,
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

  const balanceMaxAgeMs = Math.max(config.autoRotation.balanceRefreshMs * 2, 30_000);
  const cachedRows = repository.latestBalances({ maxAgeMs: balanceMaxAgeMs, now });
  for (const snapshot of snapshots) {
    const view = balanceView(cachedRows, snapshot.venueId, snapshot.market);
    if (!view) {
      return {
        status: 'WAIT',
        reasons: [`inventory_balance_snapshot_missing:${snapshot.venueId}`],
      };
    }
    if (view.fetchedAt < now - balanceMaxAgeMs) {
      return { status: 'WAIT', reasons: [`inventory_balance_snapshot_stale:${snapshot.venueId}`] };
    }
    snapshot.balance = view;
  }

  const initial = planAutomaticInventorySeed({
    pair,
    venues: snapshots,
    config: settings,
    now,
    ...(input.previousObservation ? { previousObservation: input.previousObservation } : {}),
  });
  if (initial.action !== 'SEED') {
    return {
      status: initial.action,
      reasons: initial.reasons,
      ...(initial.observation ? { observation: initial.observation } : {}),
    };
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
  const freshSnapshots: InventoryVenueSnapshot[] = [];
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index]!;
    const rows = freshRows[index];
    if (!rows || 'error' in rows) {
      return {
        status: 'WAIT',
        reasons: [`inventory_balance_refresh_failed:${snapshot.venueId}`],
        observation: initial.plan.observation,
      };
    }
    const view = balanceView(rows, snapshot.venueId, snapshot.market);
    if (!view) {
      return {
        status: 'WAIT',
        reasons: [`inventory_balance_missing:${snapshot.venueId}`],
        observation: initial.plan.observation,
      };
    }
    freshSnapshots.push({ ...snapshot, balance: view });
  }
  const finalDecision = planAutomaticInventorySeed({
    pair,
    venues: freshSnapshots,
    config: settings,
    now,
    previousObservation: initial.plan.observation,
  });
  if (finalDecision.action !== 'SEED') {
    return {
      status: finalDecision.action,
      reasons: finalDecision.reasons,
      ...(finalDecision.observation ? { observation: finalDecision.observation } : {}),
    };
  }
  const plan = finalDecision.plan;
  const bundle = adapters[plan.venueId];
  if (!bundle) return { status: 'BLOCKED', reasons: ['inventory_adapter_missing'], plan };
  if (
    !bundle.adapter.capabilities.createOrder ||
    !bundle.adapter.capabilities.fetchOrder ||
    !bundle.adapter.capabilities.openOrders
  ) {
    return { status: 'BLOCKED', reasons: ['inventory_seed_capability_missing'], plan };
  }
  if (!config.fokVenues.includes(plan.venueId)) {
    return { status: 'BLOCKED', reasons: [`inventory_fok_not_enabled:${plan.venueId}`], plan };
  }
  const openOrders = await fetchOpenOrdersForSymbols(bundle.adapter, bundle.credentials, [
    plan.exchangeSymbol,
  ]);
  if (openOrders.errors.length > 0) {
    return { status: 'WAIT', reasons: openOrders.errors, plan, observation: plan.observation };
  }
  if (openOrders.orders.length > 0) {
    return {
      status: 'WAIT',
      reasons: ['open_orders_present'],
      plan,
      observation: plan.observation,
    };
  }
  if (Date.now() - plan.bookFetchedAt > SEED_BOOK_MAX_AGE_MS) {
    return {
      status: 'WAIT',
      reasons: ['inventory_book_expired_before_submit'],
      plan,
      observation: plan.observation,
    };
  }

  const batchId = `SEED-${plan.base}-${now}-${plan.venueId}-${randomUUID().slice(0, 8)}`;
  const clientOrderId = `${batchId}-B1`;
  const executionId = repository.createExecution({
    strategy: 'SEED',
    batchId,
    status: 'SEED_SUBMITTING',
    plannedNotional: plan.plannedNotional,
    expectedProfit: ZERO,
    openedAt: now,
    metadata: seedMetadata(plan),
  });
  repository.addExecutionLeg({
    executionId,
    legNumber: 1,
    venueId: plan.venueId,
    side: 'buy',
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
    side: 'buy',
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
      side: 'buy',
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
    'inventory_seed_attempt',
    { batchId, executionId, plan: seedMetadata(plan) },
    now,
  );

  let order: OrderState;
  try {
    order = await bundle.adapter.createOrder!(
      {
        symbol: plan.exchangeSymbol,
        side: 'buy',
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
      side: 'buy',
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
    const reconciled = await reconcileSeedOrder({
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
          reason: 'inventory_seed_submission_unknown',
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
        'inventory_seed_submission_ambiguous_resolved',
        'ambiguous inventory seed submission was resolved by order lookup; manual review required',
        { batchId, clientOrderId, venueId: plan.venueId },
        Date.now(),
      );
      return finalizeSeed({
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
    return markUnknown({
      repository,
      executionId,
      batchId,
      clientOrderId,
      plan,
      reason: 'inventory_seed_submission_unknown',
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
        reason: 'inventory_seed_open_without_cancel',
        now: Date.now(),
      });
    }
    try {
      const canceled = await bundle.adapter.cancelOrder(
        { clientOrderId, symbol: plan.exchangeSymbol },
        bundle.credentials,
      );
      repository.recordOrder({
        venueId: plan.venueId,
        venueOrderId: canceled.venueOrderId,
        clientOrderId,
        executionId,
        symbol: canceled.symbol,
        side: canceled.side,
        type: canceled.type,
        price: canceled.price ?? plan.limitPrice,
        amount: canceled.amount,
        filledAmount: canceled.filled,
        ...(canceled.averagePrice ? { averagePrice: canceled.averagePrice } : {}),
        ...(canceled.fee ? { fee: canceled.fee } : {}),
        status: canceled.status,
        now: Date.now(),
      });
      order = canceled;
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
        reason: 'inventory_seed_cancel_unknown',
        now: Date.now(),
      });
    }
  }

  if (order.status === 'unknown' || order.status === 'open') {
    const reconciled = await reconcileSeedOrder({
      repository,
      bundle,
      executionId,
      clientOrderId,
      symbol: plan.exchangeSymbol,
      sleep,
    });
    if (!reconciled) {
      return markUnknown({
        repository,
        executionId,
        batchId,
        clientOrderId,
        plan,
        reason: 'inventory_seed_reconcile_unavailable',
        now: Date.now(),
      });
    }
    order = reconciled;
  }

  if (order.status === 'unknown' || order.status === 'open') {
    return markUnknown({
      repository,
      executionId,
      batchId,
      clientOrderId,
      plan,
      reason: 'inventory_seed_order_unresolved',
      now: Date.now(),
    });
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
  if (order.status === 'rejected') {
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
  return finalizeSeed({
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
