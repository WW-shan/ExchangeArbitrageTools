import { randomUUID } from 'node:crypto';
import {
  Decimal,
  ZERO,
  alignAmountDown,
  bookReceivedAt,
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
const SEED_EXCHANGE_TIMESTAMP_MAX_AGE_MS = 60_000;
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
  | 'both_sides_missing_cheaper_side'
  | 'both_sides_missing_funded_side'
  | 'missing_side_cheaper'
  | 'missing_side_near_parity';

export interface AutomaticInventoryPlan {
  pair: RotationPairConfig;
  venueId: string;
  otherVenueId: string;
  base: string;
  exchangeBase: string;
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
  | 'NOOP'
  | 'WAIT'
  | 'BLOCKED'
  | 'REJECTED'
  | 'UNKNOWN'
  | 'PARTIAL'
  | 'ACCOUNTING_UNKNOWN'
  | 'FILLED';

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

export interface AutomaticInventoryNoFillReconciliation {
  status: 'RECONCILED';
  batchId: string;
  executionId: number;
  previousStatus: string;
  venueId: string;
  baseFree: string;
  quoteFree: string;
  reconciledAt: string;
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

export interface SeedFillAccountingInput {
  base: string;
  exchangeBase: string;
  quote: string;
  baseMultiplier: Decimal;
  filled: Decimal;
  averagePrice?: Decimal | undefined;
  limitPrice: Decimal;
  fee?: Decimal | undefined;
  feeCurrency?: string | undefined;
}

export interface SeedFillAccounting {
  known: boolean;
  feeTreatment: 'no_fee' | 'base' | 'quote' | 'missing_currency' | 'unmapped_asset';
  feeAmount: Decimal;
  feeCurrency?: string;
  grossQuote: Decimal;
  feeValueQuote: Decimal;
  baseDeltaCanonical: Decimal;
  quoteDelta: Decimal;
}

export function usableSeedAccounting(accounting: SeedFillAccounting): boolean {
  return accounting.known && accounting.baseDeltaCanonical.gt(0) && accounting.quoteDelta.lt(0);
}

/**
 * Attribute an order fill to inventory using the fee asset. A buy charges the
 * quote asset for the fill; a fee charged in base reduces the received base,
 * while a fee charged in quote increases the quote outflow. If the venue does
 * not expose the fee asset, callers must fall back to actual balance deltas.
 */
export function accountSeedFill(input: SeedFillAccountingInput): SeedFillAccounting {
  const grossQuote = (input.averagePrice ?? input.limitPrice).mul(input.filled);
  const feeAmount = input.fee?.abs() ?? ZERO;
  if (!feeAmount.gt(0)) {
    return {
      known: true,
      feeTreatment: 'no_fee',
      feeAmount: ZERO,
      grossQuote,
      feeValueQuote: ZERO,
      baseDeltaCanonical: input.filled,
      quoteDelta: grossQuote.negated(),
    };
  }

  const feeCurrency = input.feeCurrency?.trim().toUpperCase();
  if (!feeCurrency) {
    return {
      known: false,
      feeTreatment: 'missing_currency',
      feeAmount,
      grossQuote,
      feeValueQuote: ZERO,
      baseDeltaCanonical: input.filled,
      quoteDelta: grossQuote.negated(),
    };
  }
  if (
    feeCurrency === input.exchangeBase.trim().toUpperCase() ||
    feeCurrency === input.base.trim().toUpperCase()
  ) {
    const feeCanonical = feeAmount.mul(input.baseMultiplier);
    return {
      known: true,
      feeTreatment: 'base',
      feeAmount,
      feeCurrency,
      grossQuote,
      feeValueQuote: feeCanonical.mul(input.averagePrice ?? input.limitPrice),
      baseDeltaCanonical: input.filled.minus(feeCanonical),
      quoteDelta: grossQuote.negated(),
    };
  }
  if (feeCurrency === input.quote.trim().toUpperCase()) {
    return {
      known: true,
      feeTreatment: 'quote',
      feeAmount,
      feeCurrency,
      grossQuote,
      feeValueQuote: feeAmount,
      baseDeltaCanonical: input.filled,
      quoteDelta: grossQuote.plus(feeAmount).negated(),
    };
  }
  return {
    known: false,
    feeTreatment: 'unmapped_asset',
    feeAmount,
    feeCurrency,
    grossQuote,
    feeValueQuote: ZERO,
    baseDeltaCanonical: input.filled,
    quoteDelta: grossQuote.negated(),
  };
}

export interface SeedBalanceDelta {
  baseDeltaCanonical: Decimal;
  quoteDelta: Decimal;
}

export function seedBalanceDelta(input: {
  baseBeforeExchange: Decimal;
  quoteBefore: Decimal;
  baseAfterExchange: Decimal;
  quoteAfter: Decimal;
  baseMultiplier: Decimal;
}): SeedBalanceDelta {
  return {
    baseDeltaCanonical: input.baseAfterExchange
      .minus(input.baseBeforeExchange)
      .mul(input.baseMultiplier),
    quoteDelta: input.quoteAfter.minus(input.quoteBefore),
  };
}

export interface ResolvedSeedAccounting {
  accounting: SeedFillAccounting;
  source: 'order_fee' | 'balance_delta';
  balanceDelta?: SeedBalanceDelta;
  balanceMismatch?: string;
}

function plausibleSeedBalanceDelta(
  actual: SeedBalanceDelta,
  order: SeedFillAccounting,
  filledCanonical: Decimal,
): boolean {
  if (!actual.baseDeltaCanonical.gt(0)) return false;
  if (actual.baseDeltaCanonical.gt(filledCanonical.mul('1.01'))) return false;
  if (actual.baseDeltaCanonical.lt(filledCanonical.mul('0.95'))) return false;
  if (actual.quoteDelta.gt('0.01')) return false;
  const gross = order.grossQuote.abs();
  if (actual.quoteDelta.abs().gt(gross.mul('1.05').plus('0.01'))) return false;
  if (actual.quoteDelta.abs().lt(gross.mul('0.95'))) return false;
  return true;
}

export function resolveSeedAccounting(input: {
  order: SeedFillAccounting;
  filledCanonical: Decimal;
  balanceDelta?: SeedBalanceDelta | undefined;
}): ResolvedSeedAccounting {
  const actual = input.balanceDelta;
  if (input.order.known) {
    if (!actual) return { accounting: input.order, source: 'order_fee' };
    const baseTolerance = Decimal.max(input.filledCanonical.mul('0.005'), '0.00000001');
    const quoteTolerance = Decimal.max(input.order.grossQuote.abs().mul('0.005'), '0.01');
    const mismatch =
      actual.baseDeltaCanonical.minus(input.order.baseDeltaCanonical).abs().gt(baseTolerance) ||
      actual.quoteDelta.minus(input.order.quoteDelta).abs().gt(quoteTolerance);
    return {
      accounting: input.order,
      source: 'order_fee',
      balanceDelta: actual,
      ...(mismatch ? { balanceMismatch: 'balance_delta_differs_from_order_fee' } : {}),
    };
  }
  if (actual && plausibleSeedBalanceDelta(actual, input.order, input.filledCanonical)) {
    const price = input.order.grossQuote.div(input.filledCanonical);
    const baseFeeValue = input.filledCanonical.minus(actual.baseDeltaCanonical).mul(price);
    const quoteFeeValue = actual.quoteDelta.abs().minus(input.order.grossQuote);
    return {
      accounting: {
        ...input.order,
        known: true,
        feeTreatment:
          input.order.feeTreatment === 'no_fee' ? 'unmapped_asset' : input.order.feeTreatment,
        baseDeltaCanonical: actual.baseDeltaCanonical,
        quoteDelta: actual.quoteDelta,
        feeValueQuote: baseFeeValue.plus(quoteFeeValue),
      },
      source: 'balance_delta',
      balanceDelta: actual,
    };
  }
  return {
    accounting: input.order,
    source: 'order_fee',
    ...(actual ? { balanceDelta: actual } : {}),
  };
}

function balanceView(
  rows: readonly BalanceSnapshot[],
  venueId: string,
  market: MarketMetadata,
): InventoryBalanceView | undefined {
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
    const requiredSpend = Decimal.min(
      config.seedNotionalUsd,
      config.minUsefulNotionalUsd,
      pair.maxNotional,
    );
    const firstFunded = first.balance.quoteFree.minus(config.minQuoteReserveUsd).gte(requiredSpend);
    const secondFunded = second.balance.quoteFree
      .minus(config.minQuoteReserveUsd)
      .gte(requiredSpend);
    if (!firstFunded && !secondFunded) {
      return { action: 'WAIT', reasons: ['inventory_quote_insufficient'] };
    }
    const cheaper = firstCheaper ? first : second;
    const cheaperFunded = firstCheaper ? firstFunded : secondFunded;
    seed = cheaperFunded ? cheaper : firstCheaper ? second : first;
    other = seed.venueId === first.venueId ? second : first;
    seedAsk = seed.venueId === first.venueId ? firstAsk : secondAsk;
    otherAsk = seed.venueId === first.venueId ? secondAsk : firstAsk;
    seedBaseUsd = seed.venueId === first.venueId ? firstBaseUsd : secondBaseUsd;
    otherBaseUsd = seed.venueId === first.venueId ? secondBaseUsd : firstBaseUsd;
    if (cheaperFunded) {
      reason = 'both_sides_missing_cheaper_side';
    } else {
      const deviationBps = seedAsk.minus(otherAsk).div(otherAsk).mul(10_000);
      if (deviationBps.gt(config.maxPairDeviationBps)) {
        return { action: 'WAIT', reasons: ['funded_side_above_pair_band'] };
      }
      reason = 'both_sides_missing_funded_side';
    }
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
  const expectedNetBase = amount.mul(new Decimal(1).minus(feeBps.div(10_000)));
  const expectedBaseValueUsd = expectedNetBase.mul(seedBestBid.price);
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
      exchangeBase: marketExchangeBase(seed.market),
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
  return /FOK_NOT_FILL|cannot be filled completely|ioc[^\n]*not[^\n]*fill|clientOrderId or text param must be up to 28 characters/i.test(
    String(error),
  );
}

function isOrderNotFoundOrInvalidId(error: unknown): boolean {
  return /ordernotfound|client_id_not_found|order not found|clientOrderId or text param must be up to 28 characters|clientOrderId[^\n]*invalid/i.test(
    String(error),
  );
}

function metadataObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('execution metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function seedClientOrderId(now: number): string {
  return `SD-${now.toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
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
    exchangeBase: plan.exchangeBase,
    baseMultiplier: plan.baseMultiplier.toFixed(),
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
        ...(order.feeCurrency ? { feeCurrency: order.feeCurrency } : {}),
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

async function markPartial(input: {
  repository: ArbitrageRepository;
  bundle: RecoveryVenue;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryPlan;
  order: OrderState;
  now: number;
}): Promise<AutomaticInventoryResult> {
  const filledCanonical = canonicalAmountFromExchange(
    input.order.filled,
    input.plan.baseMultiplier,
  );
  const orderAccounting = accountSeedFill({
    base: input.plan.base,
    exchangeBase: input.plan.exchangeBase,
    quote: input.plan.quote,
    baseMultiplier: input.plan.baseMultiplier,
    filled: filledCanonical,
    averagePrice: input.order.averagePrice,
    limitPrice: input.plan.limitPrice,
    fee: input.order.fee,
    feeCurrency: input.order.feeCurrency,
  });
  let balanceDelta: SeedBalanceDelta | undefined;
  try {
    const rows = await freshBalances(input.repository, input.bundle, input.now);
    const base = findBalance(rows, input.plan.venueId, input.plan.exchangeBase);
    const quote = findBalance(rows, input.plan.venueId, input.plan.quote);
    if (base && quote) {
      balanceDelta = seedBalanceDelta({
        baseBeforeExchange: input.plan.venueBalance.baseFree,
        quoteBefore: input.plan.venueBalance.quoteFree,
        baseAfterExchange: base.free,
        quoteAfter: quote.free,
        baseMultiplier: input.plan.baseMultiplier,
      });
    }
  } catch {
    // The partial-fill execution remains open for manual review either way.
  }
  const resolved = resolveSeedAccounting({
    order: orderAccounting,
    filledCanonical,
    balanceDelta,
  });
  input.repository.updateExecutionLeg(input.clientOrderId, {
    status: 'partial',
    filledAmount: input.order.filled,
    averageFillPrice: input.order.averagePrice,
    feePaid: input.order.fee,
    orderId: input.order.venueOrderId,
  });
  input.repository.updateExecutionStatus(input.executionId, 'SEED_PARTIAL', {
    safeModeReason: 'inventory_seed_partial_fill',
    fees: resolved.accounting.feeValueQuote,
    ...(usableSeedAccounting(resolved.accounting)
      ? {
          inventoryDelta: {
            baseAsset: input.plan.base,
            baseDelta: resolved.accounting.baseDeltaCanonical.toFixed(),
            quoteAsset: input.plan.quote,
            quoteDelta: resolved.accounting.quoteDelta.toFixed(),
          },
        }
      : {}),
    metadata: seedMetadata(input.plan, {
      orderStatus: input.order.status,
      filled: input.order.filled.toFixed(),
      remaining: input.order.remaining.toFixed(),
      feeAmount: input.order.fee?.toFixed() ?? null,
      feeCurrency: input.order.feeCurrency ?? null,
      feeAccounting: resolved.accounting.feeTreatment,
      feeAccountingSource: resolved.source,
      feeValueQuote: resolved.accounting.feeValueQuote.toFixed(),
      ...(resolved.balanceDelta
        ? {
            balanceBaseDeltaCanonical: resolved.balanceDelta.baseDeltaCanonical.toFixed(),
            balanceQuoteDelta: resolved.balanceDelta.quoteDelta.toFixed(),
          }
        : {}),
      ...(resolved.balanceMismatch ? { balanceMismatch: resolved.balanceMismatch } : {}),
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
      feeAmount: input.order.fee?.toFixed() ?? null,
      feeCurrency: input.order.feeCurrency ?? null,
      feeAccounting: resolved.accounting.feeTreatment,
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

function markAccountingUnknown(input: {
  repository: ArbitrageRepository;
  executionId: number;
  batchId: string;
  clientOrderId: string;
  plan: AutomaticInventoryPlan;
  order: OrderState;
  reason: string;
  now: number;
}): AutomaticInventoryResult {
  input.repository.updateExecutionLeg(input.clientOrderId, {
    status: 'filled',
    filledAmount: input.order.filled,
    averageFillPrice: input.order.averagePrice,
    feePaid: input.order.fee,
    orderId: input.order.venueOrderId,
  });
  input.repository.updateExecutionStatus(input.executionId, 'SEED_ACCOUNTING_UNKNOWN', {
    safeModeReason: input.reason,
    metadata: seedMetadata(input.plan, {
      orderStatus: input.order.status,
      orderId: input.order.venueOrderId,
      filled: input.order.filled.toFixed(),
      averagePrice: input.order.averagePrice?.toFixed() ?? null,
      feeAmount: input.order.fee?.toFixed() ?? null,
      feeCurrency: input.order.feeCurrency ?? null,
      accountingStatus: 'unknown',
    }),
  });
  input.repository.setSetting('kill_switch', 'true', input.now);
  input.repository.recordRiskEvent(
    'critical',
    'inventory_seed_accounting_unknown',
    'automatic inventory seed filled but net inventory could not be attributed safely',
    {
      batchId: input.batchId,
      clientOrderId: input.clientOrderId,
      venueId: input.plan.venueId,
      reason: input.reason,
      feeAmount: input.order.fee?.toFixed() ?? null,
      feeCurrency: input.order.feeCurrency ?? null,
    },
    input.now,
  );
  return {
    status: 'ACCOUNTING_UNKNOWN',
    reasons: [input.reason],
    batchId: input.batchId,
    executionId: input.executionId,
    order: input.order,
    filled: input.order.filled,
    killSwitch: true,
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
  const filledCanonical = canonicalAmountFromExchange(order.filled, plan.baseMultiplier);
  const orderAccounting = accountSeedFill({
    base: plan.base,
    exchangeBase: plan.exchangeBase,
    quote: plan.quote,
    baseMultiplier: plan.baseMultiplier,
    filled: filledCanonical,
    averagePrice: order.averagePrice,
    limitPrice: plan.limitPrice,
    fee: order.fee,
    feeCurrency: order.feeCurrency,
  });
  let balanceDelta: SeedBalanceDelta | undefined;
  let balanceError: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const rows = await freshBalances(repository, bundle, Date.now());
      const base = findBalance(rows, plan.venueId, plan.exchangeBase);
      const quote = findBalance(rows, plan.venueId, plan.quote);
      if (!base || !quote) throw new Error('post-seed base/quote balance missing');
      balanceDelta = seedBalanceDelta({
        baseBeforeExchange: plan.venueBalance.baseFree,
        quoteBefore: plan.venueBalance.quoteFree,
        baseAfterExchange: base.free,
        quoteAfter: quote.free,
        baseMultiplier: plan.baseMultiplier,
      });
      if (
        orderAccounting.known ||
        plausibleSeedBalanceDelta(balanceDelta, orderAccounting, filledCanonical)
      ) {
        break;
      }
    } catch (error) {
      balanceError = String(error);
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (balanceError) {
    repository.recordRiskEvent(
      'warning',
      'inventory_seed_post_balance_failed',
      balanceError,
      { batchId: input.batchId, venueId: plan.venueId },
      input.now,
    );
  }
  const resolved = resolveSeedAccounting({
    order: orderAccounting,
    filledCanonical,
    balanceDelta,
  });
  if (!usableSeedAccounting(resolved.accounting)) {
    return markAccountingUnknown({
      repository,
      executionId: input.executionId,
      batchId: input.batchId,
      clientOrderId: input.clientOrderId,
      plan,
      order,
      reason: resolved.accounting.known
        ? 'inventory_seed_net_delta_invalid'
        : `inventory_seed_fee_${resolved.accounting.feeTreatment}`,
      now: Date.now(),
    });
  }
  if (resolved.balanceMismatch) {
    repository.recordRiskEvent(
      'warning',
      resolved.balanceMismatch,
      'post-seed balance delta differs from order/fee attribution; order attribution retained',
      {
        batchId: input.batchId,
        venueId: plan.venueId,
        expectedBaseDelta: resolved.accounting.baseDeltaCanonical.toFixed(),
        expectedQuoteDelta: resolved.accounting.quoteDelta.toFixed(),
        ...(resolved.balanceDelta
          ? {
              actualBaseDelta: resolved.balanceDelta.baseDeltaCanonical.toFixed(),
              actualQuoteDelta: resolved.balanceDelta.quoteDelta.toFixed(),
            }
          : {}),
      },
      input.now,
    );
  }
  const quoteSpent = resolved.accounting.quoteDelta.negated();
  const closedAt = input.now;
  repository.recordOrder({
    venueId: plan.venueId,
    venueOrderId: order.venueOrderId,
    clientOrderId: input.clientOrderId,
    executionId: input.executionId,
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
    now: closedAt,
  });
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
    fees: resolved.accounting.feeValueQuote,
    latencyMs: Math.max(0, closedAt - plan.observation.firstSeenAt),
    inventoryDelta: {
      baseAsset: plan.base,
      baseDelta: resolved.accounting.baseDeltaCanonical.toFixed(),
      quoteAsset: plan.quote,
      quoteDelta: quoteSpent.negated().toFixed(),
    },
    metadata: seedMetadata(plan, {
      orderStatus: order.status,
      orderId: order.venueOrderId,
      filled: order.filled.toFixed(),
      filledCanonical: filledCanonical.toFixed(),
      netBaseCanonical: resolved.accounting.baseDeltaCanonical.toFixed(),
      averagePrice: order.averagePrice?.toFixed() ?? null,
      quoteSpent: quoteSpent.toFixed(),
      grossQuote: resolved.accounting.grossQuote.toFixed(),
      feeAmount: order.fee?.toFixed() ?? null,
      feeCurrency: order.feeCurrency ?? null,
      feeTreatment: resolved.accounting.feeTreatment,
      feeValueQuote: resolved.accounting.feeValueQuote.toFixed(),
      accountingSource: resolved.source,
      ...(resolved.balanceDelta
        ? {
            balanceBaseDeltaCanonical: resolved.balanceDelta.baseDeltaCanonical.toFixed(),
            balanceQuoteDelta: resolved.balanceDelta.quoteDelta.toFixed(),
          }
        : {}),
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
      netBaseCanonical: resolved.accounting.baseDeltaCanonical.toFixed(),
      averagePrice: order.averagePrice?.toFixed() ?? null,
      quoteSpent: quoteSpent.toFixed(),
      feeAmount: order.fee?.toFixed() ?? null,
      feeCurrency: order.feeCurrency ?? null,
      feeTreatment: resolved.accounting.feeTreatment,
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
      netBaseCanonical: resolved.accounting.baseDeltaCanonical.toFixed(),
      feeAmount: order.fee?.toFixed() ?? null,
      feeCurrency: order.feeCurrency ?? null,
      feeTreatment: resolved.accounting.feeTreatment,
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

export async function reconcileAutomaticInventoryNoFill(input: {
  repository: ArbitrageRepository;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  batchId: string;
  now?: number;
}): Promise<AutomaticInventoryNoFillReconciliation> {
  const { repository, adapters, batchId } = input;
  const now = input.now ?? Date.now();
  const execution = repository.db
    .prepare(
      `SELECT id, strategy, status, opened_at, closed_at, metadata_json
       FROM executions WHERE batch_id = ?`,
    )
    .get(batchId) as
    | {
        id: number;
        strategy: string;
        status: string;
        opened_at: number;
        closed_at: number | null;
        metadata_json: string | null;
      }
    | undefined;
  if (!execution) throw new Error(`execution not found: ${batchId}`);
  if (execution.strategy !== 'SEED') throw new Error(`execution ${batchId} is not SEED`);
  if (execution.status !== 'SEED_UNKNOWN') {
    throw new Error(`execution ${batchId} is ${execution.status}, not SEED_UNKNOWN`);
  }
  if (execution.closed_at !== null) throw new Error(`execution ${batchId} is already closed`);
  if (repository.countOpenExecutions() !== 1) {
    throw new Error('reconciliation requires exactly one open execution');
  }

  const metadata = metadataObject(execution.metadata_json);
  const venueId = typeof metadata.venueId === 'string' ? metadata.venueId : '';
  const base = typeof metadata.base === 'string' ? metadata.base.toUpperCase() : '';
  const quote = typeof metadata.quote === 'string' ? metadata.quote.toUpperCase() : '';
  const baseBalanceBefore =
    typeof metadata.baseBalanceBefore === 'string' ? metadata.baseBalanceBefore : '';
  const quoteBalanceBefore =
    typeof metadata.quoteBalanceBefore === 'string' ? metadata.quoteBalanceBefore : '';
  if (!venueId || !base || !quote || !baseBalanceBefore || !quoteBalanceBefore) {
    throw new Error('seed metadata is incomplete');
  }
  const bundle = adapters[venueId];
  if (!bundle) throw new Error(`no adapter for ${venueId}`);

  const orderRow = repository.db
    .prepare(
      `SELECT client_order_id, venue_order_id, symbol, side, type, price, amount,
              filled_amount, average_price, fee, status
       FROM orders WHERE execution_id = ? ORDER BY id LIMIT 1`,
    )
    .get(execution.id) as
    | {
        client_order_id: string;
        venue_order_id: string | null;
        symbol: string;
        side: string;
        type: string;
        price: string;
        amount: string;
        filled_amount: string;
        average_price: string | null;
        fee: string | null;
        status: string;
      }
    | undefined;
  if (!orderRow) throw new Error('seed order row is missing');
  if (orderRow.status !== 'unknown') {
    throw new Error(`seed order is ${orderRow.status}, not unknown`);
  }

  const openOrders = await fetchOpenOrdersForSymbols(bundle.adapter, bundle.credentials, [
    orderRow.symbol,
  ]);
  if (openOrders.errors.length > 0) {
    throw new Error(`open-order query failed: ${openOrders.errors.join('; ')}`);
  }
  if (openOrders.orders.length > 0) {
    throw new Error('open orders exist; seed cannot be closed as no-fill');
  }

  let exchangeOrder: OrderState | undefined;
  if (typeof bundle.adapter.fetchOrder !== 'function') {
    throw new Error('order lookup is unavailable');
  }
  try {
    exchangeOrder = await bundle.adapter.fetchOrder(
      {
        clientOrderId: orderRow.client_order_id,
        symbol: orderRow.symbol,
        ...(orderRow.venue_order_id ? { venueOrderId: orderRow.venue_order_id } : {}),
      },
      bundle.credentials,
    );
  } catch (error) {
    if (!isOrderNotFoundOrInvalidId(error)) {
      throw new Error(`order lookup failed: ${String(error)}`);
    }
  }
  if (exchangeOrder) {
    repository.recordOrder({
      venueId,
      venueOrderId: exchangeOrder.venueOrderId,
      clientOrderId: orderRow.client_order_id,
      executionId: execution.id,
      symbol: exchangeOrder.symbol,
      side: exchangeOrder.side,
      type: exchangeOrder.type,
      price: exchangeOrder.price ?? new Decimal(orderRow.price),
      amount: exchangeOrder.amount,
      filledAmount: exchangeOrder.filled,
      ...(exchangeOrder.averagePrice ? { averagePrice: exchangeOrder.averagePrice } : {}),
      ...(exchangeOrder.fee ? { fee: exchangeOrder.fee } : {}),
      ...(exchangeOrder.feeCurrency ? { feeCurrency: exchangeOrder.feeCurrency } : {}),
      status: exchangeOrder.status,
      now,
    });
    repository.recordOrderEvent(
      orderRow.client_order_id,
      'seed_no_fill_reconcile_query',
      {
        at: now,
        status: exchangeOrder.status,
        filled: exchangeOrder.filled.toFixed(),
        remaining: exchangeOrder.remaining.toFixed(),
      },
      now,
    );
    if (exchangeOrder.filled.gt(0)) {
      throw new Error('seed order has a fill; use manual inventory reconciliation');
    }
    if (exchangeOrder.status !== 'canceled' && exchangeOrder.status !== 'rejected') {
      throw new Error(`seed order is ${exchangeOrder.status}; cannot close as no-fill`);
    }
  }

  const rows = await freshBalances(repository, bundle, now);
  const baseRow = findBalance(rows, venueId, base);
  const quoteRow = findBalance(rows, venueId, quote);
  if (!baseRow || !quoteRow) throw new Error('current seed balances are missing');
  const tolerance = new Decimal('0.00000001');
  if (
    baseRow.free.minus(new Decimal(baseBalanceBefore)).abs().gt(tolerance) ||
    quoteRow.free.minus(new Decimal(quoteBalanceBefore)).abs().gt(tolerance)
  ) {
    throw new Error('seed balances changed; possible fill requires manual review');
  }

  const resolvedAt = Date.now();
  repository.recordOrder({
    venueId,
    ...(orderRow.venue_order_id ? { venueOrderId: orderRow.venue_order_id } : {}),
    clientOrderId: orderRow.client_order_id,
    executionId: execution.id,
    symbol: orderRow.symbol,
    side: orderRow.side,
    type: orderRow.type,
    price: new Decimal(orderRow.price),
    amount: new Decimal(orderRow.amount),
    filledAmount: ZERO,
    status: 'canceled',
    now: resolvedAt,
  });
  repository.updateExecutionLeg(orderRow.client_order_id, {
    status: 'canceled',
    filledAmount: ZERO,
  });
  const context = {
    batchId,
    executionId: execution.id,
    previousStatus: execution.status,
    venueId,
    base,
    quote,
    baseFree: baseRow.free.toFixed(),
    quoteFree: quoteRow.free.toFixed(),
    resolution: 'seed_no_fill_reconciled',
  };
  repository.updateExecutionStatus(execution.id, 'SEED_REJECTED', {
    realizedProfit: ZERO,
    closedAt: resolvedAt,
    metadata: {
      ...metadata,
      resolution: 'seed_no_fill_reconciled',
      reconciledAt: new Date(resolvedAt).toISOString(),
      reconciledBy: 'operator',
      observedBaseFree: baseRow.free.toFixed(),
      observedQuoteFree: quoteRow.free.toFixed(),
    },
  });
  repository.recordRiskEvent(
    'warning',
    'inventory_seed_reconciled_no_fill',
    'SEED_UNKNOWN closed after zero-fill and unchanged-balance confirmation',
    context,
    resolvedAt,
  );
  repository.recordAudit('operator', 'inventory_seed_reconciled_no_fill', context, resolvedAt);
  return {
    status: 'RECONCILED',
    batchId,
    executionId: execution.id,
    previousStatus: execution.status,
    venueId,
    baseFree: baseRow.free.toFixed(),
    quoteFree: quoteRow.free.toFixed(),
    reconciledAt: new Date(resolvedAt).toISOString(),
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
    const observedAt = Date.now();
    if (observedAt - bookReceivedAt(result) > SEED_BOOK_MAX_AGE_MS) {
      return { status: 'WAIT', reasons: [`inventory_book_received_stale:${row.market.venueId}`] };
    }
    const validation = validateOrderBook(result, {
      expectedVenueId: row.market.venueId,
      expectedSymbol: row.market.exchangeSymbol,
      maxAgeMs: Math.max(config.settings.maxOrderbookAgeMs, SEED_EXCHANGE_TIMESTAMP_MAX_AGE_MS),
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
  const clientOrderId = seedClientOrderId(now);
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
          bundle,
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
        ...(canceled.feeCurrency ? { feeCurrency: canceled.feeCurrency } : {}),
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
      bundle,
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
