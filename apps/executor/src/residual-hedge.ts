import { randomUUID } from 'node:crypto';
import {
  Decimal,
  ZERO,
  alignAmountDown,
  calculateBuyDepthByBase,
  calculateSellDepthByBase,
  canonicalAmountFromExchange,
  ceilToStep,
  exchangeAmountFromCanonical,
  exchangePriceFromCanonical,
  isAligned,
  marketBaseMultiplier,
  marketExchangeBase,
  normalizeBookForMarket,
  validateOrderBook,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';
import type { ApiCredentials, BalanceSnapshot, CexAdapter, OrderState } from '@arb/venues-cex';
import type { ExecutorConfig } from './config.js';
import type { RecoveryVenue } from './bootstrap.js';
import { fetchOpenOrdersForSymbols } from './open-orders.js';
import { findMarket } from './runtime.js';

interface ExecutionRow {
  id: number;
  batch_id: string;
  status: string;
  opened_at: number;
  closed_at: number | null;
  preflight_json: string | null;
  metadata_json: string | null;
}

interface UnhedgedRow {
  id: number;
  execution_id: number;
  batch_id: string;
  venue_id: string;
  asset: string;
  amount: string;
  usd_value: string;
  direction: 'long' | 'short';
  reason: string;
}

interface BalanceRow {
  venue_id: string;
  currency: string;
  free: string;
  used: string;
  total: string;
  fetched_at: number;
}

export interface ResidualHedgeVenue {
  adapter: CexAdapter;
  credentials: ApiCredentials;
  market: MarketMetadata;
  balances: BalanceSnapshot[];
}

export interface ResidualHedgePlan {
  originalBatchId: string;
  originalExecutionId: number;
  unhedgedIds: number[];
  base: string;
  quote: string;
  exchangeBase: string;
  baseMultiplier: Decimal;
  direction: 'long' | 'short';
  /**
   * Side the hedge order must take on `venueId`. Equals `direction` when the
   * hedge flattens on the residual venue, and is the opposite when it finishes
   * the trade at the original counterparty.
   */
  hedgeSide: 'long' | 'short';
  residualCanonical: Decimal;
  costPerCanonical: Decimal;
  costQuote: Decimal;
  venueId: string;
  exchangeSymbol: string;
  exchangeAmount: Decimal;
  canonicalAmount: Decimal;
  exchangePrice: Decimal;
  canonicalPrice: Decimal;
  executableQuote: Decimal;
  grossFeeQuote: Decimal;
  netHedgeQuote: Decimal;
  projectedProfit: Decimal;
  book: OrderBookSnapshot;
  balanceBaseline: { base: BalanceSnapshot; quote: BalanceSnapshot };
  freeBase: Decimal;
  freeQuote: Decimal;
}

export interface ResidualHedgeResult {
  status: 'PLANNED' | 'HEDGED' | 'NO_RESIDUAL' | 'BLOCKED';
  reasons: string[];
  plan?: ResidualHedgePlan;
  hedgeBatchId?: string;
  hedgeExecutionId?: number;
  order?: OrderState;
  realizedProfit?: Decimal;
}

export interface ResidualHedgeCandidate {
  venueId: string;
  exchangeSymbol: string;
  exchangeAmount: Decimal;
  canonicalAmount: Decimal;
  exchangePrice: Decimal;
  canonicalPrice: Decimal;
  executableQuote: Decimal;
  grossFeeQuote: Decimal;
  netHedgeQuote: Decimal;
  projectedProfit: Decimal;
  book: OrderBookSnapshot;
  freeBase: Decimal;
  freeQuote: Decimal;
  direction: 'long' | 'short';
}

function decimal(value: string | null | undefined): Decimal {
  return value === null || value === undefined ? ZERO : new Decimal(value);
}

function findBalance(rows: readonly BalanceSnapshot[], venueId: string, currency: string) {
  return rows.find(
    (row) =>
      row.venueId === venueId && row.currency.trim().toUpperCase() === currency.toUpperCase(),
  );
}

function baselineRows(
  repository: ArbitrageRepository,
  venueId: string,
  openedAt: number,
  maxAgeMs: number,
): BalanceRow[] {
  const latest = repository.db
    .prepare(
      `SELECT MAX(fetched_at) AS fetched_at FROM balances
       WHERE venue_id = ? AND fetched_at <= ?`,
    )
    .get(venueId, openedAt) as { fetched_at: number | bigint | null } | undefined;
  if (latest?.fetched_at === null || latest?.fetched_at === undefined) return [];
  const fetchedAt = Number(latest.fetched_at);
  if (openedAt - fetchedAt > maxAgeMs) return [];
  return repository.db
    .prepare('SELECT * FROM balances WHERE venue_id = ? AND fetched_at = ?')
    .all(venueId, fetchedAt) as unknown as BalanceRow[];
}

function grossFeeBps(config: ExecutorConfig, venueId: string, market: MarketMetadata): Decimal {
  return config.feeOverrides[venueId]?.takerBps ?? market.feeTakerBps ?? ZERO;
}

export function evaluateResidualHedgeCandidate(input: {
  venueId: string;
  market: MarketMetadata;
  book: OrderBookSnapshot;
  residualCanonical: Decimal;
  costPerCanonical: Decimal;
  freeBase: Decimal;
  grossFeeBps: Decimal;
  minProfitUsd: Decimal;
}): ResidualHedgeCandidate | undefined {
  const { venueId, market, book, residualCanonical, costPerCanonical, freeBase } = input;
  if (!market.amountStep || !market.priceStep || residualCanonical.lte(0) || freeBase.lte(0)) {
    return undefined;
  }
  const multiplier = marketBaseMultiplier(market);
  const normalized = normalizeBookForMarket(book, market);
  const requestedExchange = exchangeAmountFromCanonical(residualCanonical, multiplier);
  if (requestedExchange.minus(freeBase).gt(market.amountStep)) return undefined;
  const cappedExchange = Decimal.min(requestedExchange, freeBase);
  const exchangeAmount = alignAmountDown(cappedExchange, market.amountStep);
  const canonicalAmount = canonicalAmountFromExchange(exchangeAmount, multiplier);
  if (!exchangeAmount.gt(0) || !canonicalAmount.gt(0)) return undefined;
  if (market.minAmount && exchangeAmount.lt(market.minAmount)) return undefined;
  const depth = calculateSellDepthByBase(normalized, canonicalAmount);
  if (depth.insufficientDepth || !depth.worstPrice.gt(0)) return undefined;
  const canonicalPrice = depth.worstPrice;
  const exchangePrice = exchangePriceFromCanonical(canonicalPrice, multiplier);
  if (!isAligned(exchangePrice, market.priceStep)) return undefined;
  if (market.minNotional && depth.executableQuoteAmount.lt(market.minNotional)) return undefined;
  const grossFeeQuote = depth.executableQuoteAmount.mul(input.grossFeeBps).div(10_000);
  const netProceedsQuote = depth.executableQuoteAmount.minus(grossFeeQuote);
  const projectedProfit = netProceedsQuote.minus(costPerCanonical.mul(canonicalAmount));
  if (projectedProfit.lt(input.minProfitUsd)) return undefined;
  return {
    venueId,
    exchangeSymbol: market.exchangeSymbol,
    exchangeAmount,
    canonicalAmount,
    exchangePrice,
    canonicalPrice,
    executableQuote: depth.executableQuoteAmount,
    grossFeeQuote,
    netHedgeQuote: netProceedsQuote,
    projectedProfit,
    book: normalized,
    freeBase,
    freeQuote: ZERO,
    direction: 'long',
  };
}

export function evaluateShortResidualHedgeCandidate(input: {
  venueId: string;
  market: MarketMetadata;
  book: OrderBookSnapshot;
  residualCanonical: Decimal;
  proceedsPerCanonical: Decimal;
  freeQuote: Decimal;
  grossFeeBps: Decimal;
  minProfitUsd: Decimal;
}): ResidualHedgeCandidate | undefined {
  const { venueId, market, book, residualCanonical, proceedsPerCanonical, freeQuote } = input;
  if (
    !market.amountStep ||
    !market.priceStep ||
    residualCanonical.lte(0) ||
    freeQuote.lte(0) ||
    !proceedsPerCanonical.gt(0)
  ) {
    return undefined;
  }
  const multiplier = marketBaseMultiplier(market);
  const normalized = normalizeBookForMarket(book, market);
  const feeRate = input.grossFeeBps.div(10_000);
  const netFactor = new Decimal(1).minus(feeRate);
  if (!netFactor.gt(0)) return undefined;
  const requestedExchange = exchangeAmountFromCanonical(residualCanonical, multiplier).div(
    netFactor,
  );
  const exchangeAmount = ceilToStep(requestedExchange, market.amountStep);
  const canonicalAmount = canonicalAmountFromExchange(exchangeAmount, multiplier);
  if (!exchangeAmount.gt(0) || !canonicalAmount.gt(0)) return undefined;
  if (market.minAmount && exchangeAmount.lt(market.minAmount)) return undefined;
  const depth = calculateBuyDepthByBase(normalized, canonicalAmount);
  if (depth.insufficientDepth || !depth.worstPrice.gt(0)) return undefined;
  if (market.minNotional && depth.executableQuoteAmount.lt(market.minNotional)) return undefined;
  const grossFeeQuote = depth.executableQuoteAmount.mul(feeRate);
  const totalCostQuote = depth.executableQuoteAmount.plus(grossFeeQuote);
  if (totalCostQuote.gt(freeQuote)) return undefined;
  const netCanonicalAmount = canonicalAmount.mul(netFactor);
  if (netCanonicalAmount.lt(residualCanonical)) return undefined;
  const projectedProfit = proceedsPerCanonical.mul(netCanonicalAmount).minus(totalCostQuote);
  if (projectedProfit.lt(input.minProfitUsd)) return undefined;
  const canonicalPrice = depth.worstPrice;
  const exchangePrice = ceilToStep(
    exchangePriceFromCanonical(canonicalPrice, multiplier),
    market.priceStep,
  );
  if (!isAligned(exchangePrice, market.priceStep)) return undefined;
  return {
    venueId,
    exchangeSymbol: market.exchangeSymbol,
    exchangeAmount,
    canonicalAmount,
    exchangePrice,
    canonicalPrice,
    executableQuote: depth.executableQuoteAmount,
    grossFeeQuote,
    netHedgeQuote: totalCostQuote,
    projectedProfit,
    book: normalized,
    freeBase: ZERO,
    freeQuote,
    direction: 'short',
  };
}

async function fetchBalances(
  repository: ArbitrageRepository,
  venue: { adapter: CexAdapter; credentials: ApiCredentials },
): Promise<BalanceSnapshot[]> {
  if (!venue.adapter.fetchBalances)
    throw new Error(`${venue.adapter.venueId}: balances unsupported`);
  const rows = await venue.adapter.fetchBalances(venue.credentials);
  for (const row of rows) {
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
  return rows;
}

export async function planResidualHedge(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  batchId: string;
  minProfitUsd?: Decimal;
  maxBaselineAgeMs?: number;
}): Promise<ResidualHedgeResult> {
  const { repository, config, adapters, batchId } = input;
  const minProfitUsd = input.minProfitUsd ?? new Decimal('0.01');
  const execution = repository.db
    .prepare('SELECT * FROM executions WHERE batch_id = ?')
    .get(batchId) as ExecutionRow | undefined;
  if (!execution) return { status: 'BLOCKED', reasons: ['execution_not_found'] };
  if (execution.status !== 'SAFE_STOP') {
    return { status: 'BLOCKED', reasons: [`execution_status_${execution.status.toLowerCase()}`] };
  }
  if (execution.closed_at !== null) {
    return { status: 'BLOCKED', reasons: ['execution_already_closed'] };
  }
  if (repository.countOpenExecutions() !== 1) {
    return { status: 'BLOCKED', reasons: ['requires_exactly_one_open_execution'] };
  }
  if (repository.countUnresolvedOrders() > 0) {
    return { status: 'BLOCKED', reasons: ['unresolved_orders_exist'] };
  }
  const unhedged = repository.db
    .prepare(
      `SELECT id, execution_id, batch_id, venue_id, asset, amount, usd_value, direction, reason
       FROM unhedged_inventory WHERE batch_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(batchId) as unknown as UnhedgedRow[];
  if (unhedged.length === 0) return { status: 'NO_RESIDUAL', reasons: [] };
  const direction = unhedged[0]!.direction;
  if (direction !== 'long' && direction !== 'short') {
    return { status: 'BLOCKED', reasons: ['unknown_residual_direction'] };
  }
  if (unhedged.some((row) => row.direction !== direction)) {
    return { status: 'BLOCKED', reasons: ['mixed_residual_directions_not_supported'] };
  }
  const asset = unhedged[0]!.asset.trim().toUpperCase();
  if (unhedged.some((row) => row.asset.trim().toUpperCase() !== asset)) {
    return { status: 'BLOCKED', reasons: ['multiple_assets_not_supported'] };
  }
  const pair = config.autoRotation.pairs.find((row) => row.base.toUpperCase() === asset);
  // A stopped S1 leaves the base on the venue that filled leg 1. The natural
  // way to finish that trade is to sell on the venue where leg 2 *was meant to
  // run*, not to dump on leg 1's venue. Measured 2026-11-18: every hedge sold
  // on Gate at 0.001649 while Bitget bid 0.001676 and the original leg-2 order
  // there filled 0. On a 4138 WARD batch that single choice was the difference
  // between +45 bps and -96 bps.
  //
  // We only switch when the counterparty actually holds the asset (or the
  // quote, for a short), so a venue with empty inventory still falls back to
  // flattening locally.
  if (!pair) return { status: 'BLOCKED', reasons: ['rotation_pair_missing'] };
  const residualVenue = unhedged[0]!.venue_id.trim().toLowerCase();
  //
  // This is opt-in. Selling inventory a venue already held is a deliberate
  // strategy choice, not a recovery default: it can liquidate a position the
  // operator built for another purpose. Off by default keeps the old, narrow
  // behaviour ("flatten only what leg 1 bought").
  const allowCounterpartyHedge = config.autoRotation.residualHedge.allowCounterpartyHedge === true;
  const plannedCounterpartyVenue = (() => {
    if (!allowCounterpartyHedge) return undefined;
    const legs = repository.db
      .prepare(
        `SELECT venue_id, side, status FROM execution_legs
         WHERE execution_id = ? ORDER BY leg_number`,
      )
      .all(execution.id) as Array<{ venue_id: string; side: string; status: string }>;
    const wantedSide = direction === 'long' ? 'sell' : 'buy';
    const leg = legs.find((row) => row.side === wantedSide && row.venue_id.toLowerCase() !== residualVenue);
    return leg ? leg.venue_id.trim().toLowerCase() : undefined;
  })();
  const residualBaseline = baselineRows(
    repository,
    residualVenue,
    execution.opened_at,
    input.maxBaselineAgeMs ?? 60_000,
  );
  if (residualBaseline.length === 0) {
    return { status: 'BLOCKED', reasons: ['pre_execution_balance_baseline_missing'] };
  }
  const baselineBase = residualBaseline.find((row) => row.currency.toUpperCase() === asset);
  const baselineQuote = residualBaseline.find((row) => row.currency.toUpperCase() === pair.quote);
  if (!baselineBase || !baselineQuote) {
    return { status: 'BLOCKED', reasons: ['pre_execution_balance_baseline_incomplete'] };
  }

  // Where should the hedge run?
  //
  // A stopped S1 leaves the base on the venue that filled leg 1. Flattening
  // there means selling at that venue's own bid. Finishing the trade means
  // selling on the venue leg 2 was planned for.
  //
  // Measured 2026-11-18: 27 Gate->Bitget batches filled leg 1 on Gate, leg 2
  // on Bitget filled zero times, and every hedge then sold on Gate at
  // 0.001649 while Bitget still bid 0.001676. That single venue choice turned
  // +45 bps into -96 bps on every batch, and it is why the day lost 2.54 USDT
  // with a fully filled buy leg.
  //
  // The counterparty is preferred only when it actually holds what it needs to
  // act; otherwise we fall back to flattening on the residual venue, which is
  // the old behaviour and still correct for inventory that cannot move.
  const candidates: Array<{
    venueId: string;
    side: 'long' | 'short';
    role: 'counterparty' | 'residual';
  }> = [];
  if (plannedCounterpartyVenue && plannedCounterpartyVenue !== residualVenue) {
    candidates.push({ venueId: plannedCounterpartyVenue, side: direction, role: 'counterparty' });
  }
  candidates.push({ venueId: residualVenue, side: direction, role: 'residual' });

  let hedgeVenue: string | undefined;
  let hedgeSide: 'long' | 'short' | undefined;
  let hedgeVenueData: ResidualHedgeVenue | undefined;
  for (const candidate of candidates) {
    const candidateBundle = adapters[candidate.venueId];
    if (!candidateBundle) continue;
    const candidateMarkets = await candidateBundle.adapter.loadMarkets();
    const candidateMarket = findMarket(candidateMarkets, candidate.venueId, pair.base, pair.quote);
    if (!candidateMarket) continue;
    const data: ResidualHedgeVenue = {
      adapter: candidateBundle.adapter,
      credentials: candidateBundle.credentials,
      market: candidateMarket,
      balances: await fetchBalances(repository, candidateBundle),
    };
    const base = findBalance(data.balances, candidate.venueId, asset);
    const quote = findBalance(data.balances, candidate.venueId, pair.quote);
    if (!base || !quote) continue;
    // Selling requires base; buying back requires quote. Never substitute one
    // for the other - that is how an unrelated position gets liquidated.
    const canAct = candidate.side === 'long' ? base.free.gt(0) : quote.free.gt(0);
    if (!canAct) continue;
    hedgeVenue = candidate.venueId;
    hedgeSide = candidate.side;
    hedgeVenueData = data;
    break;
  }
  if (!hedgeVenue || !hedgeSide || !hedgeVenueData) {
    // No venue can act. Keep the specific reason the caller already relies on:
    // the residual venue lacking the base is the common, expected case.
    return {
      status: 'BLOCKED',
      reasons: [direction === 'long' ? 'residual_base_not_available' : 'residual_quote_not_available'],
    };
  }
  const residualVenueData = hedgeVenueData;
  const currentBase = findBalance(residualVenueData.balances, hedgeVenue, asset);
  const currentQuote = findBalance(residualVenueData.balances, hedgeVenue, pair.quote);
  if (!currentBase || !currentQuote) {
    return { status: 'BLOCKED', reasons: ['current_residual_balances_missing'] };
  }
  const multiplier = marketBaseMultiplier(residualVenueData.market);
  const recordedResidual = unhedged.reduce((sum, row) => sum.plus(decimal(row.amount)), ZERO);
  const counterparty = hedgeVenue !== residualVenue;
  // A counterparty hedge is a *new* position there (we sell base it already
  // holds), so its reference balance is that venue's baseline, not the
  // residual venue's.
  const hedgeBaseline =
    counterparty
      ? baselineRows(repository, hedgeVenue, execution.opened_at, input.maxBaselineAgeMs ?? 60_000)
      : residualBaseline;
  const hedgeBaselineBase = hedgeBaseline.find((row) => row.currency.toUpperCase() === asset);
  const hedgeBaselineQuote = hedgeBaseline.find((row) => row.currency.toUpperCase() === pair.quote);
  if (!hedgeBaselineBase || !hedgeBaselineQuote) {
    return { status: 'BLOCKED', reasons: ['hedge_venue_baseline_incomplete'] };
  }

  // How much to close.
  //
  // Flattening locally: the residual is what leg 1 bought and leg 2 did not
  // sell, which is exactly what was recorded at stop time. Using the balance
  // delta here would double-count, because the baseline is taken at
  // `opened_at` and already excludes the fill.
  //
  // Finishing at the counterparty: the amount is the same recorded residual;
  // that venue simply already holds enough base (or quote) to supply it, which
  // is what makes the trade whole rather than a fire sale on the wrong book.
  let residualExchange = recordedResidual;
  if (hedgeSide === 'long') {
    // Only sell base that is actually there. At the residual venue this is the
    // tokens leg 1 bought; at the counterparty it is inventory that was already
    // held, which is why the trade can be finished there without moving funds.
    const available = Decimal.min(currentBase.free, currentBase.total);
    if (!available.gt(0)) {
      return { status: 'NO_RESIDUAL', reasons: ['base_not_held'] };
    }
    residualExchange = Decimal.min(recordedResidual, available);
  } else {
    if (!currentQuote.total.gt(0)) {
      return { status: 'NO_RESIDUAL', reasons: ['quote_not_held'] };
    }
    residualExchange = recordedResidual;
  }
  const freeBaseNow = findBalance(
    residualVenueData.balances,
    hedgeVenue,
    marketExchangeBase(residualVenueData.market),
  )?.free;
  if (hedgeSide === 'long' && freeBaseNow && freeBaseNow.lt(residualExchange)) {
    residualExchange = freeBaseNow;
  }
  if (!residualExchange.gt(0)) {
    return { status: 'NO_RESIDUAL', reasons: ['nothing_to_hedge'] };
  }
  const residualCanonical = residualExchange.mul(multiplier);

  // Cost basis.
  //
  // long: the round trip starts at the price leg 1 paid for the base, so use
  //   that fill and net out the buy fee.
  // short: leg 1 sold base we did not have, so the basis is the quote received,
  //   measured from that venue's own balance delta.
  let costPerCanonical: Decimal;
  let costQuote: Decimal;
  if (hedgeSide === 'long') {
    const originalBuy = repository.db
      .prepare(
        `SELECT average_fill_price FROM execution_legs
         WHERE execution_id = ? AND side = 'buy' AND average_fill_price IS NOT NULL
         ORDER BY leg_number LIMIT 1`,
      )
      .get(execution.id) as { average_fill_price: string } | undefined;
    const originalBuyPrice = decimal(originalBuy?.average_fill_price);
    if (originalBuyPrice.gt(0)) {
      const buyFeeBps = grossFeeBps(config, residualVenue, residualVenueData.market).div(10_000);
      const denominator = new Decimal(1).minus(buyFeeBps);
      if (!denominator.gt(0)) return { status: 'BLOCKED', reasons: ['fee_basis_invalid'] };
      costPerCanonical = originalBuyPrice.div(denominator);
      costQuote = costPerCanonical.mul(residualCanonical);
    } else {
      const quoteCost = decimal(hedgeBaselineQuote.total).minus(currentQuote.total);
      if (!quoteCost.gt(0)) return { status: 'BLOCKED', reasons: ['cost_basis_missing'] };
      costPerCanonical = quoteCost.div(residualCanonical);
      costQuote = quoteCost;
    }
  } else {
    const quoteProceeds = currentQuote.total.minus(decimal(hedgeBaselineQuote.total));
    if (quoteProceeds.gt(0)) {
      costPerCanonical = quoteProceeds.div(residualCanonical);
      costQuote = quoteProceeds;
    } else {
      const originalSell = repository.db
        .prepare(
          `SELECT average_fill_price FROM execution_legs
           WHERE execution_id = ? AND side = 'sell' AND average_fill_price IS NOT NULL
           ORDER BY leg_number LIMIT 1`,
        )
        .get(execution.id) as { average_fill_price: string } | undefined;
      const originalSellPrice = decimal(originalSell?.average_fill_price);
      if (!originalSellPrice.gt(0)) {
        return { status: 'BLOCKED', reasons: ['proceeds_basis_missing'] };
      }
      const sellFeeBps = grossFeeBps(config, residualVenue, residualVenueData.market).div(10_000);
      const netFactor = new Decimal(1).minus(sellFeeBps);
      if (!netFactor.gt(0)) return { status: 'BLOCKED', reasons: ['fee_basis_invalid'] };
      costPerCanonical = originalSellPrice.mul(netFactor);
      costQuote = costPerCanonical.mul(residualCanonical);
    }
  }

  const freeBase = freeBaseNow;
  const freeQuote = findBalance(residualVenueData.balances, hedgeVenue, pair.quote)?.free;
  if (!residualVenueData.adapter.capabilities.fok) {
    return { status: 'BLOCKED', reasons: ['residual_venue_not_fok_eligible'] };
  }
  if (hedgeSide === 'long' && (!freeBase || freeBase.lte(0))) {
    return { status: 'BLOCKED', reasons: ['residual_base_not_available'] };
  }
  if (hedgeSide === 'short' && (!freeQuote || freeQuote.lte(0))) {
    return { status: 'BLOCKED', reasons: ['residual_quote_not_available'] };
  }
  let book: OrderBookSnapshot;
  try {
    book = await residualVenueData.adapter.fetchOrderBook(
      residualVenueData.market.exchangeSymbol,
      config.orderbookDepth,
    );
  } catch {
    return { status: 'BLOCKED', reasons: ['residual_book_unavailable'] };
  }
  const validation = validateOrderBook(book, {
    expectedVenueId: hedgeVenue,
    expectedSymbol: residualVenueData.market.exchangeSymbol,
    // Flattening a naked leg is a recovery action, not a scan. Judge it by the
    // fetch that just happened, not by the scanner's low-liquidity window, and
    // let the exchange's own last-update time be older than that: an illiquid
    // book that has not printed recently is still tradable against.
    maxAgeMs: config.autoRotation.residualHedge.bookMaxAgeMs,
    maxExchangeAgeMs: config.autoRotation.residualHedge.bookMaxExchangeAgeMs,
    now: Date.now(),
  });
  if (!validation.valid) {
    return {
      status: 'BLOCKED',
      reasons: ['residual_book_stale_or_invalid', ...validation.reasons],
    };
  }
  const chosen =
    hedgeSide === 'long'
      ? evaluateResidualHedgeCandidate({
          venueId: hedgeVenue,
          market: residualVenueData.market,
          book: validation.book,
          residualCanonical,
          costPerCanonical,
          freeBase: freeBase!,
          grossFeeBps: grossFeeBps(config, hedgeVenue, residualVenueData.market),
          minProfitUsd,
        })
      : evaluateShortResidualHedgeCandidate({
          venueId: hedgeVenue,
          market: residualVenueData.market,
          book: validation.book,
          residualCanonical,
          proceedsPerCanonical: costPerCanonical,
          freeQuote: freeQuote!,
          grossFeeBps: grossFeeBps(config, hedgeVenue, residualVenueData.market),
          minProfitUsd,
        });
  if (!chosen) {
    return { status: 'BLOCKED', reasons: ['no_fok_hedge_candidate_within_limits'] };
  }
  const chosenVenue = residualVenueData;
  const chosenBase = findBalance(
    chosenVenue.balances,
    chosen.venueId,
    marketExchangeBase(chosenVenue.market),
  );
  const chosenQuote = findBalance(chosenVenue.balances, chosen.venueId, pair.quote);
  if (!chosenBase || !chosenQuote) {
    return { status: 'BLOCKED', reasons: ['hedge_venue_balance_missing'] };
  }
  return {
    status: 'PLANNED',
    reasons: [],
    plan: {
      originalBatchId: batchId,
      originalExecutionId: execution.id,
      unhedgedIds: unhedged.map((row) => row.id),
      base: pair.base,
      quote: pair.quote,
      exchangeBase: marketExchangeBase(chosenVenue.market),
      baseMultiplier: marketBaseMultiplier(chosenVenue.market),
      direction,
      hedgeSide: hedgeSide!,
      residualCanonical,
      costPerCanonical,
      costQuote,
      venueId: chosen.venueId,
      exchangeSymbol: chosen.exchangeSymbol,
      exchangeAmount: chosen.exchangeAmount,
      canonicalAmount: chosen.canonicalAmount,
      exchangePrice: chosen.exchangePrice,
      canonicalPrice: chosen.canonicalPrice,
      executableQuote: chosen.executableQuote,
      grossFeeQuote: chosen.grossFeeQuote,
      netHedgeQuote: chosen.netHedgeQuote,
      projectedProfit: chosen.projectedProfit,
      book: chosen.book,
      balanceBaseline: { base: chosenBase, quote: chosenQuote },
      freeBase: freeBase ?? ZERO,
      freeQuote: freeQuote ?? ZERO,
    },
  };
}

function isDefinitiveNoFill(error: unknown): boolean {
  return /FOK_NOT_FILL|cannot be filled completely|clientOrderId or text param must be up to 28 characters|clientOrderId[^\n]*invalid|invalid[^\n]*clientOrderId/i.test(
    String(error),
  );
}

function isOrderLookupNoFillError(error: string): boolean {
  return /ordernotfound|client_id_not_found|order not found|clientOrderId or text param must be up to 28 characters|clientOrderId[^\n]*invalid|invalid[^\n]*clientOrderId/i.test(
    error,
  );
}

export function hedgeClientOrderId(now: number): string {
  return `HD-${now.toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function hedgeMetadata(plan: ResidualHedgePlan, extra: Record<string, unknown> = {}) {
  return {
    hedgesExecutionId: plan.originalExecutionId,
    originalBatchId: plan.originalBatchId,
    hedgeVenue: plan.venueId,
    base: plan.base,
    quote: plan.quote,
    exchangeBase: plan.exchangeBase,
    baseMultiplier: plan.baseMultiplier.toFixed(),
    direction: plan.direction,
    residualCanonical: plan.residualCanonical.toFixed(),
    costPerCanonical: plan.costPerCanonical.toFixed(),
    exchangeAmount: plan.exchangeAmount.toFixed(),
    canonicalAmount: plan.canonicalAmount.toFixed(),
    exchangePrice: plan.exchangePrice.toFixed(),
    executableQuote: plan.executableQuote.toFixed(),
    netHedgeQuote: plan.netHedgeQuote.toFixed(),
    projectedProfit: plan.projectedProfit.toFixed(),
    ...extra,
  };
}

interface HedgeMetadata {
  hedgesExecutionId: number;
  originalBatchId: string;
  hedgeVenue: string;
  base: string;
  quote: string;
  origin?: 'manual' | 'automatic';
  exchangeBase?: string;
  exchangeSymbol?: string;
  baseMultiplier?: string;
  direction?: 'long' | 'short';
  residualCanonical?: string;
  costPerCanonical: string;
  exchangeAmount: string;
}

function parseHedgeMetadata(row: ExecutionRow): HedgeMetadata {
  if (!row.metadata_json) throw new Error('hedge execution metadata is missing');
  const parsed = JSON.parse(row.metadata_json) as Partial<HedgeMetadata>;
  if (
    parsed.hedgesExecutionId === undefined ||
    !parsed.originalBatchId ||
    !parsed.hedgeVenue ||
    !parsed.base ||
    !parsed.quote ||
    !parsed.costPerCanonical ||
    !parsed.exchangeAmount
  ) {
    throw new Error('hedge execution metadata is incomplete');
  }
  return parsed as HedgeMetadata;
}

function finalizeHedgeFill(input: {
  repository: ArbitrageRepository;
  hedgeExecution: ExecutionRow;
  metadata: HedgeMetadata;
  order: OrderState;
  afterRows: readonly BalanceSnapshot[];
  now: number;
}): ResidualHedgeResult {
  const { repository, hedgeExecution, metadata, order, afterRows, now } = input;
  const origin = metadata.origin ?? 'manual';
  const actor = origin === 'automatic' ? 'executor' : 'operator';
  const exchangeBase = metadata.exchangeBase ?? metadata.base;
  const multiplier = new Decimal(metadata.baseMultiplier ?? '1');
  const baseline = baselineRows(repository, metadata.hedgeVenue, hedgeExecution.opened_at, 300_000);
  const baselineBase = baseline.find(
    (row) => row.currency.toUpperCase() === exchangeBase.toUpperCase(),
  );
  const baselineQuote = baseline.find(
    (row) => row.currency.toUpperCase() === metadata.quote.toUpperCase(),
  );
  const afterBase = findBalance(afterRows, metadata.hedgeVenue, exchangeBase);
  const afterQuote = findBalance(afterRows, metadata.hedgeVenue, metadata.quote);
  if (!baselineBase || !baselineQuote || !afterBase || !afterQuote) {
    return { status: 'BLOCKED', reasons: ['hedge_balance_reconciliation_missing'] };
  }
  const direction = metadata.direction ?? 'long';
  if (
    (direction === 'long' && order.side !== 'sell') ||
    (direction === 'short' && order.side !== 'buy')
  ) {
    return { status: 'BLOCKED', reasons: ['hedge_order_side_direction_mismatch'] };
  }
  const baseDeltaExchange =
    direction === 'long'
      ? decimal(baselineBase.total).minus(afterBase.total)
      : afterBase.total.minus(decimal(baselineBase.total));
  const baseDeltaCanonical = canonicalAmountFromExchange(baseDeltaExchange, multiplier);
  const quoteDelta =
    direction === 'long'
      ? afterQuote.total.minus(decimal(baselineQuote.total))
      : decimal(baselineQuote.total).minus(afterQuote.total);
  if (!baseDeltaCanonical.gt(0) || !quoteDelta.gt(0)) {
    return { status: 'BLOCKED', reasons: ['hedge_balance_delta_not_plausible'] };
  }
  const plannedResidual = new Decimal(metadata.residualCanonical ?? metadata.exchangeAmount);
  if (direction === 'short' && baseDeltaCanonical.lt(plannedResidual)) {
    repository.updateExecutionStatus(hedgeExecution.id, 'HEDGE_PARTIAL', {
      safeModeReason: 'hedge_net_residual_remains',
      metadata: {
        ...metadata,
        direction,
        orderStatus: order.status,
        orderId: order.venueOrderId,
        plannedResidualCanonical: plannedResidual.toFixed(),
        netBaseDeltaCanonical: baseDeltaCanonical.toFixed(),
      },
    });
    repository.recordRiskEvent(
      'critical',
      'hedge_net_residual_remains',
      'short hedge filled gross but fees left part of the short open',
      {
        batchId: metadata.originalBatchId,
        hedgeBatchId: hedgeExecution.batch_id,
        hedgeExecutionId: hedgeExecution.id,
        venueId: metadata.hedgeVenue,
        plannedResidualCanonical: plannedResidual.toFixed(),
        netBaseDeltaCanonical: baseDeltaCanonical.toFixed(),
      },
      now,
    );
    return { status: 'BLOCKED', reasons: ['hedge_net_residual_remains'], order };
  }
  const costPerCanonical = new Decimal(metadata.costPerCanonical);
  const realizedProfit =
    direction === 'long'
      ? quoteDelta.minus(costPerCanonical.mul(baseDeltaCanonical))
      : costPerCanonical.mul(baseDeltaCanonical).minus(quoteDelta);
  const grossSpread = realizedProfit;
  const closedAt = now;
  const clientOrderId = order.clientOrderId ?? `${hedgeExecution.batch_id}-H1`;
  repository.updateExecutionLeg(clientOrderId, {
    status: 'filled',
    filledAmount: order.filled,
    averageFillPrice: order.averagePrice,
    feePaid: order.fee,
    orderId: order.venueOrderId,
  });
  repository.updateExecutionStatus(hedgeExecution.id, 'CLOSED', {
    realizedProfit,
    closedAt,
    grossSpread,
    fees: order.fee ?? ZERO,
    latencyMs: Math.max(0, closedAt - hedgeExecution.opened_at),
    inventoryDelta: {
      baseAsset: metadata.base,
      baseDelta: (direction === 'long'
        ? baseDeltaCanonical.negated()
        : baseDeltaCanonical
      ).toFixed(),
      quoteAsset: metadata.quote,
      quoteDelta: (direction === 'long' ? quoteDelta : quoteDelta.negated()).toFixed(),
    },
    metadata: {
      ...metadata,
      direction,
      orderStatus: order.status,
      orderId: order.venueOrderId,
      baseDeltaExchange: baseDeltaExchange.toFixed(),
      baseDeltaCanonical: baseDeltaCanonical.toFixed(),
      settlementQuote: quoteDelta.toFixed(),
      realizedProfit: realizedProfit.toFixed(),
    },
  });
  const openRows = repository.db
    .prepare(`SELECT id FROM unhedged_inventory WHERE batch_id = ? AND status = 'open'`)
    .all(metadata.originalBatchId) as Array<{ id: number }>;
  for (const row of openRows) repository.resolveUnhedgedInventory(row.id, closedAt);
  repository.updateExecutionStatus(metadata.hedgesExecutionId, 'RECONCILED', {
    realizedProfit,
    closedAt,
    grossSpread,
    fees: order.fee ?? ZERO,
    metadata: {
      resolution: 'residual_hedged',
      hedgeBatchId: hedgeExecution.batch_id,
      hedgeExecutionId: hedgeExecution.id,
      hedgeOrderId: order.venueOrderId,
      direction,
      baseDeltaExchange: baseDeltaExchange.toFixed(),
      baseDeltaCanonical: baseDeltaCanonical.toFixed(),
      settlementQuote: quoteDelta.toFixed(),
      realizedProfit: realizedProfit.toFixed(),
    },
  });
  if (realizedProfit.lt(0)) repository.addRealizedLoss(realizedProfit.abs(), closedAt);
  repository.recordRiskEvent(
    'warning',
    'residual_hedged',
    'SAFE_STOP residual was flattened with a FOK hedge',
    {
      batchId: metadata.originalBatchId,
      hedgeBatchId: hedgeExecution.batch_id,
      hedgeExecutionId: hedgeExecution.id,
      venueId: metadata.hedgeVenue,
      amount: order.filled.toFixed(),
      price: order.averagePrice?.toFixed() ?? null,
      realizedProfit: realizedProfit.toFixed(),
      origin,
    },
    closedAt,
  );
  repository.recordAudit(
    actor,
    'residual_hedged',
    {
      batchId: metadata.originalBatchId,
      hedgeBatchId: hedgeExecution.batch_id,
      hedgeExecutionId: hedgeExecution.id,
      venueId: metadata.hedgeVenue,
      amount: order.filled.toFixed(),
      price: order.averagePrice?.toFixed() ?? null,
      realizedProfit: realizedProfit.toFixed(),
      origin,
    },
    closedAt,
  );
  return {
    status: 'HEDGED',
    reasons: [],
    hedgeBatchId: hedgeExecution.batch_id,
    hedgeExecutionId: hedgeExecution.id,
    order,
    realizedProfit,
  };
}

export async function reconcileResidualHedgeFill(input: {
  repository: ArbitrageRepository;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  hedgeBatchId: string;
  now?: number;
}): Promise<ResidualHedgeResult> {
  const { repository, adapters, hedgeBatchId } = input;
  const hedgeExecution = repository.db
    .prepare('SELECT * FROM executions WHERE batch_id = ?')
    .get(hedgeBatchId) as ExecutionRow | undefined;
  if (!hedgeExecution) return { status: 'BLOCKED', reasons: ['hedge_execution_not_found'] };
  if (hedgeExecution.status === 'CLOSED') {
    return { status: 'HEDGED', reasons: ['already_closed'], hedgeBatchId };
  }
  if (hedgeExecution.status !== 'HEDGE_UNKNOWN' && hedgeExecution.status !== 'HEDGE_PARTIAL') {
    return { status: 'BLOCKED', reasons: [`hedge_status_${hedgeExecution.status.toLowerCase()}`] };
  }
  const metadata = parseHedgeMetadata(hedgeExecution);
  const bundle = adapters[metadata.hedgeVenue];
  if (!bundle?.adapter.fetchOrder || !bundle.adapter.fetchBalances) {
    return { status: 'BLOCKED', reasons: ['hedge_adapter_unavailable'] };
  }
  const localOrder = repository.db
    .prepare(
      'SELECT client_order_id, venue_order_id, symbol FROM orders WHERE execution_id = ? ORDER BY id LIMIT 1',
    )
    .get(hedgeExecution.id) as
    { client_order_id: string; venue_order_id: string | null; symbol: string } | undefined;
  if (!localOrder) return { status: 'BLOCKED', reasons: ['hedge_order_missing'] };
  const symbol =
    localOrder.symbol || metadata.exchangeSymbol || `${metadata.base}/${metadata.quote}`;
  let order: OrderState | undefined;
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      order = await bundle.adapter.fetchOrder(
        {
          clientOrderId: localOrder.client_order_id,
          symbol,
          ...(localOrder.venue_order_id ? { venueOrderId: localOrder.venue_order_id } : {}),
        },
        bundle.credentials,
      );
      if (order.status !== 'unknown') break;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  if (!order) {
    if (isOrderLookupNoFillError(lastError)) {
      const baseline = baselineRows(
        repository,
        metadata.hedgeVenue,
        hedgeExecution.opened_at,
        300_000,
      );
      const baselineBase = baseline.find(
        (row) =>
          row.currency.toUpperCase() === (metadata.exchangeBase ?? metadata.base).toUpperCase(),
      );
      const baselineQuote = baseline.find(
        (row) => row.currency.toUpperCase() === metadata.quote.toUpperCase(),
      );
      const openOrders = await fetchOpenOrdersForSymbols(bundle.adapter, bundle.credentials, [
        symbol,
      ]);
      if (
        baselineBase &&
        baselineQuote &&
        openOrders.errors.length === 0 &&
        openOrders.orders.length === 0
      ) {
        const rows = await bundle.adapter.fetchBalances(bundle.credentials);
        for (const row of rows) repository.recordBalance(row);
        const currentBase = findBalance(
          rows,
          metadata.hedgeVenue,
          metadata.exchangeBase ?? metadata.base,
        );
        const currentQuote = findBalance(rows, metadata.hedgeVenue, metadata.quote);
        const unchanged =
          currentBase !== undefined &&
          currentQuote !== undefined &&
          currentBase.total.eq(decimal(baselineBase.total)) &&
          currentQuote.total.eq(decimal(baselineQuote.total));
        if (unchanged) {
          const closedAt = input.now ?? Date.now();
          repository.recordOrder({
            venueId: metadata.hedgeVenue,
            clientOrderId: localOrder.client_order_id,
            executionId: hedgeExecution.id,
            symbol,
            side: metadata.direction === 'short' ? 'buy' : 'sell',
            type: 'limit',
            price: ZERO,
            amount: new Decimal(metadata.exchangeAmount),
            filledAmount: ZERO,
            status: 'rejected',
            now: closedAt,
          });
          repository.updateExecutionLeg(localOrder.client_order_id, {
            status: 'canceled',
            filledAmount: ZERO,
            error: lastError,
          });
          repository.updateExecutionStatus(hedgeExecution.id, 'HEDGE_REJECTED', {
            closedAt,
            metadata: {
              ...metadata,
              rejectionReason: lastError,
              rejectionConfirmedBy: 'no_open_orders_and_unchanged_balances',
            },
          });
          repository.recordRiskEvent(
            'warning',
            'hedge_rejected_no_fill',
            'hedge submission was definitively rejected; balances and open orders confirm no fill',
            {
              batchId: metadata.originalBatchId,
              hedgeBatchId: hedgeExecution.batch_id,
              hedgeExecutionId: hedgeExecution.id,
              error: lastError,
            },
            closedAt,
          );
          return { status: 'BLOCKED', reasons: ['hedge_rejected_no_fill'] };
        }
      }
    }
    return {
      status: 'BLOCKED',
      reasons: [`hedge_order_query_failed:${lastError || 'no response'}`],
    };
  }
  const responseAt = input.now ?? Date.now();
  repository.recordOrder({
    venueId: metadata.hedgeVenue,
    venueOrderId: order.venueOrderId,
    clientOrderId: localOrder.client_order_id,
    executionId: hedgeExecution.id,
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
    now: responseAt,
  });
  repository.recordOrderEvent(
    localOrder.client_order_id,
    'hedge_reconcile_query',
    {
      at: responseAt,
      status: order.status,
      filled: order.filled.toFixed(),
      remaining: order.remaining.toFixed(),
      averagePrice: order.averagePrice?.toFixed() ?? null,
    },
    responseAt,
  );
  if (order.status === 'open' || order.status === 'unknown') {
    return { status: 'BLOCKED', reasons: [`hedge_order_${order.status}`], order };
  }
  if (order.filled.lte(0)) {
    repository.updateExecutionStatus(hedgeExecution.id, 'HEDGE_REJECTED', {
      closedAt: responseAt,
      metadata: { ...metadata, orderStatus: order.status },
    });
    return { status: 'BLOCKED', reasons: ['hedge_fok_not_filled'], order };
  }
  if (order.status !== 'closed' || order.filled.lt(order.amount)) {
    return { status: 'BLOCKED', reasons: ['hedge_partial_fill'], order };
  }
  const afterRows = await bundle.adapter.fetchBalances(bundle.credentials);
  for (const row of afterRows) {
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
  return finalizeHedgeFill({
    repository,
    hedgeExecution,
    metadata,
    order,
    afterRows,
    now: responseAt,
  });
}

export async function executeResidualHedge(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  batchId: string;
  plan: ResidualHedgePlan;
  origin?: 'manual' | 'automatic';
  now?: number;
}): Promise<ResidualHedgeResult> {
  const { repository, config, adapters, batchId, plan } = input;
  const origin = input.origin ?? 'manual';
  const now = input.now ?? Date.now();
  if (!config.liveEnabled || repository.getSetting('live_enabled') !== 'true') {
    return { status: 'BLOCKED', reasons: ['live_execution_disabled'], plan };
  }
  if (!config.fokVenues.includes(plan.venueId)) {
    return { status: 'BLOCKED', reasons: [`fok_not_enabled_${plan.venueId}`], plan };
  }
  const bundle = adapters[plan.venueId];
  if (!bundle) return { status: 'BLOCKED', reasons: ['hedge_adapter_missing'], plan };
  const openOrders = await fetchOpenOrdersForSymbols(bundle.adapter, bundle.credentials, [
    plan.exchangeSymbol,
  ]);
  if (openOrders.errors.length > 0) {
    return { status: 'BLOCKED', reasons: openOrders.errors, plan };
  }
  if (openOrders.orders.length > 0) {
    return { status: 'BLOCKED', reasons: ['open_orders_present'], plan };
  }
  const hedgeBatchId = `HEDGE-${batchId}-${now}`;
  const clientOrderId = hedgeClientOrderId(now);
  const hedgeSide: 'buy' | 'sell' = (plan.hedgeSide ?? plan.direction) === 'long' ? 'sell' : 'buy';
  const hedgeExecutionId = repository.createExecution({
    strategy: 'HEDGE',
    batchId: hedgeBatchId,
    status: 'HEDGE_SUBMITTING',
    plannedNotional: plan.netHedgeQuote,
    expectedProfit: plan.projectedProfit,
    openedAt: now,
    metadata: hedgeMetadata(plan, { origin }),
  });
  repository.addExecutionLeg({
    executionId: hedgeExecutionId,
    legNumber: 1,
    venueId: plan.venueId,
    side: hedgeSide,
    requestedAmount: plan.exchangeAmount,
    requestedPrice: plan.exchangePrice,
    status: 'submitting',
    submittedAt: now,
    clientOrderId,
  });
  repository.recordOrder({
    venueId: plan.venueId,
    clientOrderId,
    executionId: hedgeExecutionId,
    symbol: plan.exchangeSymbol,
    side: hedgeSide,
    type: 'limit',
    price: plan.exchangePrice,
    amount: plan.exchangeAmount,
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
      side: hedgeSide,
      type: 'limit',
      amount: plan.exchangeAmount.toFixed(),
      price: plan.exchangePrice.toFixed(),
      timeInForce: 'FOK',
      clientOrderId,
    },
    now,
  );

  let order: OrderState;
  try {
    order = await bundle.adapter.createOrder!(
      {
        symbol: plan.exchangeSymbol,
        side: hedgeSide,
        type: 'limit',
        amount: plan.exchangeAmount,
        price: plan.exchangePrice,
        timeInForce: 'FOK',
        clientOrderId,
      },
      bundle.credentials,
    );
  } catch (error) {
    const definitive = isDefinitiveNoFill(error);
    const status = definitive ? 'canceled' : 'unknown';
    repository.recordOrder({
      venueId: plan.venueId,
      clientOrderId,
      executionId: hedgeExecutionId,
      symbol: plan.exchangeSymbol,
      side: hedgeSide,
      type: 'limit',
      price: plan.exchangePrice,
      amount: plan.exchangeAmount,
      filledAmount: ZERO,
      status,
      now: Date.now(),
    });
    repository.recordOrderEvent(
      clientOrderId,
      definitive ? 'definitive_no_fill' : 'submission_error',
      { at: Date.now(), error: String(error) },
      Date.now(),
    );
    repository.updateExecutionLeg(clientOrderId, {
      status: definitive ? 'canceled' : 'unknown',
      filledAmount: ZERO,
      error: String(error),
    });
    const failedAt = Date.now();
    repository.updateExecutionStatus(
      hedgeExecutionId,
      definitive ? 'HEDGE_REJECTED' : 'HEDGE_UNKNOWN',
      definitive
        ? { closedAt: failedAt, metadata: hedgeMetadata(plan, { origin, error: String(error) }) }
        : {
            safeModeReason: 'ambiguous_hedge_submission',
            metadata: hedgeMetadata(plan, { origin, error: String(error) }),
          },
    );
    if (!definitive) {
      repository.setSetting('kill_switch', 'true', Date.now());
      repository.recordRiskEvent(
        'critical',
        'hedge_submission_unknown',
        'residual hedge order state is unknown; do not retry',
        { batchId, hedgeBatchId, clientOrderId, origin, error: String(error) },
        Date.now(),
      );
    }
    return {
      status: 'BLOCKED',
      reasons: [definitive ? 'hedge_fok_not_filled' : 'hedge_submission_unknown'],
      plan,
      hedgeBatchId,
      hedgeExecutionId,
    };
  }

  const responseAt = Date.now();
  repository.recordOrder({
    venueId: plan.venueId,
    venueOrderId: order.venueOrderId,
    clientOrderId,
    executionId: hedgeExecutionId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    price: order.price ?? plan.exchangePrice,
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
  repository.updateExecutionLeg(clientOrderId, {
    status:
      order.status === 'closed'
        ? 'filled'
        : order.status === 'canceled' && order.filled.eq(0)
          ? 'canceled'
          : order.status,
    filledAmount: order.filled,
    averageFillPrice: order.averagePrice,
    feePaid: order.fee,
    orderId: order.venueOrderId,
  });
  if (order.status === 'unknown' || order.status === 'open') {
    repository.updateExecutionStatus(hedgeExecutionId, 'HEDGE_UNKNOWN', {
      safeModeReason: `hedge_order_${order.status}`,
      metadata: hedgeMetadata(plan, { origin, orderStatus: order.status }),
    });
    repository.setSetting('kill_switch', 'true', Date.now());
    repository.recordRiskEvent(
      'critical',
      'hedge_order_unresolved',
      'residual hedge order was not terminal on submission; running bounded order lookup',
      { batchId, hedgeBatchId, clientOrderId, origin, orderStatus: order.status },
      Date.now(),
    );
    const reconciled = await reconcileResidualHedgeFill({
      repository,
      adapters,
      hedgeBatchId,
    });
    if (reconciled.status === 'HEDGED') return { ...reconciled, plan };
    return {
      status: 'BLOCKED',
      reasons: reconciled.reasons,
      plan,
      hedgeBatchId,
      hedgeExecutionId,
      order: reconciled.order ?? order,
    };
  }
  if (order.filled.lte(0)) {
    repository.updateExecutionStatus(hedgeExecutionId, 'HEDGE_REJECTED', {
      closedAt: Date.now(),
      metadata: hedgeMetadata(plan, { orderStatus: order.status, origin }),
    });
    return {
      status: 'BLOCKED',
      reasons: ['hedge_fok_not_filled'],
      plan,
      hedgeBatchId,
      hedgeExecutionId,
      order,
    };
  }
  if (order.status !== 'closed' || order.filled.lt(order.amount)) {
    repository.updateExecutionStatus(hedgeExecutionId, 'HEDGE_PARTIAL', {
      safeModeReason: 'hedge_fok_partial_fill',
      metadata: hedgeMetadata(plan, {
        origin,
        orderStatus: order.status,
        filled: order.filled.toFixed(),
        remaining: order.remaining.toFixed(),
      }),
    });
    repository.setSetting('kill_switch', 'true', Date.now());
    repository.recordRiskEvent(
      'critical',
      'hedge_partial_fill',
      'residual hedge did not fill completely; original inventory remains open',
      {
        batchId,
        hedgeBatchId,
        clientOrderId,
        origin,
        status: order.status,
        filled: order.filled.toFixed(),
        remaining: order.remaining.toFixed(),
      },
      Date.now(),
    );
    return {
      status: 'BLOCKED',
      reasons: ['hedge_partial_fill'],
      plan,
      hedgeBatchId,
      hedgeExecutionId,
      order,
    };
  }

  const afterRows = await fetchBalances(repository, bundle);
  const metadata: HedgeMetadata = {
    hedgesExecutionId: plan.originalExecutionId,
    originalBatchId: plan.originalBatchId,
    hedgeVenue: plan.venueId,
    base: plan.base,
    quote: plan.quote,
    origin,
    exchangeBase: plan.exchangeBase,
    exchangeSymbol: plan.exchangeSymbol,
    baseMultiplier: plan.baseMultiplier.toFixed(),
    direction: plan.direction,
    residualCanonical: plan.residualCanonical.toFixed(),
    costPerCanonical: plan.costPerCanonical.toFixed(),
    exchangeAmount: plan.exchangeAmount.toFixed(),
  };
  const finalized = finalizeHedgeFill({
    repository,
    hedgeExecution: {
      id: hedgeExecutionId,
      batch_id: hedgeBatchId,
      status: 'HEDGE_UNKNOWN',
      opened_at: now,
      closed_at: null,
      preflight_json: null,
      metadata_json: JSON.stringify(metadata),
    },
    metadata,
    order,
    afterRows,
    now: Date.now(),
  });
  return { ...finalized, plan };
}
