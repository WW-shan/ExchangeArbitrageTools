import {
  BatchStateMachine,
  Decimal,
  ExecutionGate,
  ZERO,
  alignAmountDown,
  alignToCommonAmountStep,
  canonicalAmountFromExchange,
  canonicalMarketForEvaluation,
  canonicalPriceFromExchange,
  calculateSellDepthByBase,
  evaluateS1Preparation,
  evaluateS1Direction,
  exchangeAmountFromCanonical,
  exchangePriceFromCanonical,
  isAligned,
  marketBaseMultiplier,
  marketExchangeBase,
  marketsShareUnderlying,
  normalizeBookForMarket,
  validateOrderBook,
  type BatchState,
  type HealthState,
  type MarketMetadata,
  type OpportunityResult,
  type RiskLimits,
} from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';
import { accountClosedTrade, type ClosedTradeAccounting } from './profit-accounting.js';
import type {
  ApiCredentials,
  BalanceSnapshot,
  CexAdapter,
  OrderQuery,
  OrderState,
} from '@arb/venues-cex';

export interface ExecutionVenue {
  adapter: CexAdapter;
  market: MarketMetadata;
  credentials: ApiCredentials;
  healthState: HealthState;
  feeRebatePct?: Decimal;
}

export interface LiveExecutionRequest {
  batchId: string;
  opportunity: OpportunityResult;
  opportunityId?: number;
  buy: ExecutionVenue;
  sell: ExecutionVenue;
  confirmedBatchId: string;
  confirmationMode?: ExecutionConfirmationMode;
  intent?: 'arbitrage' | 'inventory_preparation';
  preparation?: {
    maxCostBps: Decimal;
    maxCostUsd: Decimal;
  };
}

export type ExecutionConfirmationMode = 'manual' | 'automatic';

export type LiveExecutionOutcome =
  'BLOCKED' | 'PREFLIGHT_FAILED' | 'LEG1_REJECTED' | 'PARALLEL_REJECTED' | 'CLOSED' | 'SAFE_STOP';

export type LegExecutionMode = 'serial' | 'parallel_fok';

export interface LiveExecutionResult {
  batchId: string;
  outcome: LiveExecutionOutcome;
  state: BatchState;
  states: BatchState[];
  reasons: string[];
  realizedProfit?: Decimal;
  ordersSubmitted: number;
}

interface PreparedLimitOrder {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit';
  amount: Decimal;
  price: Decimal;
  timeInForce: 'IOC' | 'FOK';
  clientOrderId: string;
}

interface VenueBalanceBaseline {
  base?: BalanceSnapshot;
  quote?: BalanceSnapshot;
}

interface ParallelFokPlan {
  request: LiveExecutionRequest;
  executionId: number;
  preflightAt: number;
  buyPrice: Decimal;
  sellPrice: Decimal;
  buyAmount: Decimal;
  sellAmount: Decimal;
  buyMultiplier: Decimal;
  sellMultiplier: Decimal;
  buyBalanceBaseline: VenueBalanceBaseline;
  sellBalanceBaseline: VenueBalanceBaseline;
  transition: (to: BatchState) => void;
  safeStop: (reason: string) => LiveExecutionResult;
  outcome: (value: LiveExecutionOutcome, realized?: Decimal) => LiveExecutionResult;
  states: () => readonly BatchState[];
}

function findBalance(
  rows: readonly BalanceSnapshot[],
  venueId: string,
  currency: string,
): BalanceSnapshot | undefined {
  return rows.find(
    (balance) =>
      balance.venueId === venueId && balance.currency.toUpperCase() === currency.toUpperCase(),
  );
}

function venueBalanceBaseline(
  venue: ExecutionVenue,
  rows: readonly BalanceSnapshot[],
): VenueBalanceBaseline {
  const base = findBalance(rows, venue.adapter.venueId, marketExchangeBase(venue.market));
  const quote = findBalance(rows, venue.adapter.venueId, venue.market.quote);
  return {
    ...(base ? { base } : {}),
    ...(quote ? { quote } : {}),
  };
}

function sameBalanceValue(left?: BalanceSnapshot, right?: BalanceSnapshot): boolean {
  const normalize = (value?: BalanceSnapshot): string =>
    value ? `${value.free.toFixed()}|${value.used.toFixed()}|${value.total.toFixed()}` : 'missing';
  return normalize(left) === normalize(right);
}

function syntheticNoFillOrder(
  order: {
    venueOrderId?: string;
    clientOrderId: string;
    symbol: string;
    side: 'buy' | 'sell';
    type: string;
    price?: Decimal;
    amount: Decimal;
  },
  reason: string,
): OrderState {
  return {
    venueOrderId: order.venueOrderId ?? order.clientOrderId,
    clientOrderId: order.clientOrderId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    ...(order.price ? { price: order.price } : {}),
    amount: order.amount,
    filled: ZERO,
    remaining: order.amount,
    status: 'canceled',
    raw: { reconciliation: reason },
  };
}

function isDefinitiveNoFillCreateError(error: unknown): boolean {
  return /FOK_NOT_FILL|cannot be filled completely|ioc[^\n]*not[^\n]*fill/i.test(String(error));
}

function isOrderNotFoundError(message: string): boolean {
  return /委单不存在|order not found/i.test(message);
}

export interface CexLiveExecutorOptions {
  repository: ArbitrageRepository;
  gate: ExecutionGate;
  limits: RiskLimits;
  liveEnabled: boolean;
  autoExecutionEnabled?: boolean;
  legMode?: LegExecutionMode;
  settings: {
    maxOrderbookAgeMs: number;
    minNetProfitBps: Decimal;
    maxSlippageBps: Decimal;
    minProfitUsd: Decimal;
    safetyBufferBps: Decimal;
    maxGasCostUsd: Decimal;
    maxTransferTaxBps: Decimal;
  };
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

function normalizedInstrument(market: MarketMetadata): string {
  return `${market.base}/${market.quote}`.trim().toUpperCase();
}

function feeConfigured(value: Decimal | undefined): boolean {
  return value !== undefined && value.isFinite() && value.gte(0);
}

function storedMultiplierMatches(market: MarketMetadata, stored: string | undefined): boolean {
  if (stored === undefined || stored.trim() === '') return true;
  try {
    return new Decimal(stored).eq(marketBaseMultiplier(market));
  } catch {
    return false;
  }
}

function hasLiveExecutionCapabilities(venue: ExecutionVenue): boolean {
  const capabilities = venue.adapter.capabilities;
  return (
    capabilities.privateBalances &&
    capabilities.createOrder &&
    capabilities.fetchOrder &&
    capabilities.cancelOrder &&
    typeof venue.adapter.fetchBalances === 'function' &&
    typeof venue.adapter.createOrder === 'function' &&
    typeof venue.adapter.fetchOrder === 'function' &&
    typeof venue.adapter.cancelOrder === 'function'
  );
}

function routeIsConsistent(request: LiveExecutionRequest): boolean {
  const opportunity = request.opportunity;
  const buyInstrument = normalizedInstrument(request.buy.market);
  const sellInstrument = normalizedInstrument(request.sell.market);
  const storedBuySymbol = opportunity.metadata?.buySymbol;
  const storedSellSymbol = opportunity.metadata?.sellSymbol;
  return (
    opportunity.strategy === 'S1' &&
    request.buy.adapter.venueId === opportunity.venueBuy &&
    request.sell.adapter.venueId === opportunity.venueSell &&
    request.buy.market.venueId === request.buy.adapter.venueId &&
    request.sell.market.venueId === request.sell.adapter.venueId &&
    request.buy.market.active &&
    request.sell.market.active &&
    buyInstrument === sellInstrument &&
    buyInstrument === opportunity.instrumentKey.trim().toUpperCase() &&
    (!storedBuySymbol || storedBuySymbol === request.buy.market.exchangeSymbol) &&
    (!storedSellSymbol || storedSellSymbol === request.sell.market.exchangeSymbol) &&
    storedMultiplierMatches(request.buy.market, opportunity.metadata?.buyBaseMultiplier) &&
    storedMultiplierMatches(request.sell.market, opportunity.metadata?.sellBaseMultiplier)
  );
}

export class CexLiveExecutor {
  readonly #repository: ArbitrageRepository;
  readonly #gate: ExecutionGate;
  readonly #liveEnabled: boolean;
  readonly #autoExecutionEnabled: boolean;
  readonly #legMode: LegExecutionMode;
  readonly #settings: CexLiveExecutorOptions['settings'];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #clock: () => number;

  constructor(options: CexLiveExecutorOptions) {
    this.#repository = options.repository;
    this.#gate = options.gate;
    this.#liveEnabled = options.liveEnabled;
    this.#autoExecutionEnabled = options.autoExecutionEnabled === true;
    this.#legMode = options.legMode ?? 'serial';
    this.#settings = options.settings;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#clock = options.clock ?? Date.now;
  }

  async execute(request: LiveExecutionRequest): Promise<LiveExecutionResult> {
    const machine = new BatchStateMachine();
    const states: BatchState[] = ['IDLE'];
    const reasons: string[] = [];
    let ordersSubmitted = 0;
    const transition = (to: BatchState): void => {
      machine.transition(to);
      states.push(to);
      const executionId = this.#executionIds.get(request.batchId);
      if (executionId !== undefined) {
        this.#repository.updateExecutionStatus(executionId, to, {
          metadata: { states: [...states] },
        });
      }
    };
    const outcome = (value: LiveExecutionOutcome, realized?: Decimal): LiveExecutionResult => ({
      batchId: request.batchId,
      outcome: value,
      state: machine.state,
      states,
      reasons,
      ordersSubmitted,
      ...(realized ? { realizedProfit: realized } : {}),
    });
    const safeStop = (reason: string): LiveExecutionResult => {
      reasons.push(reason);
      this.#gate.setKillSwitch(true, reason);
      this.#repository.setSetting('kill_switch', 'true', this.#clock());
      this.#repository.recordRiskEvent('critical', 'execution_safe_stop', reason, {
        batchId: request.batchId,
        states,
      });
      if (machine.state !== 'SAFE_STOP') transition('SAFE_STOP');
      const executionId = this.#executionIds.get(request.batchId);
      if (executionId !== undefined) {
        this.#repository.updateExecutionStatus(executionId, 'SAFE_STOP', {
          safeModeReason: reason,
          metadata: { states: [...states], reasons: [...reasons] },
        });
      }
      return outcome('SAFE_STOP');
    };
    const intent = request.intent ?? 'arbitrage';
    const preparation = intent === 'inventory_preparation' ? request.preparation : undefined;
    if (intent === 'inventory_preparation' && !preparation) {
      reasons.push('preparation_budget_missing');
      return outcome('BLOCKED');
    }

    if (!this.#liveEnabled) {
      reasons.push('live_execution_disabled');
      return outcome('BLOCKED');
    }
    if (request.confirmedBatchId !== request.batchId) {
      reasons.push('manual_confirmation_mismatch');
      return outcome('BLOCKED');
    }
    const confirmationMode = request.confirmationMode ?? 'manual';
    if (confirmationMode === 'automatic') {
      if (!this.#autoExecutionEnabled) {
        reasons.push('automatic_execution_disabled');
        return outcome('BLOCKED');
      }
      if (this.#repository.getSetting('auto_execution_enabled') !== 'true') {
        reasons.push('persisted_automatic_execution_disabled');
        return outcome('BLOCKED');
      }
    }
    this.#repository.recordAudit(
      confirmationMode === 'automatic' ? 'executor' : 'operator',
      confirmationMode === 'automatic'
        ? 'automatic_batch_confirmation'
        : 'manual_batch_confirmation',
      {
        batchId: request.batchId,
        confirmedBatchId: request.confirmedBatchId,
        opportunityId: request.opportunityId ?? null,
        confirmationMode,
        confirmedAt: this.#clock(),
      },
      this.#clock(),
    );
    if (this.#repository.getSetting('kill_switch') !== 'false') {
      this.#gate.setKillSwitch(true, 'persisted_kill_switch_on');
      reasons.push('persisted_kill_switch_on');
      return outcome('BLOCKED');
    }
    if (
      !this.#repository.venueExecutionEnabled(request.buy.adapter.venueId) ||
      !this.#repository.venueExecutionEnabled(request.sell.adapter.venueId)
    ) {
      reasons.push('venue_execution_disabled');
      return outcome('BLOCKED');
    }
    if (!routeIsConsistent(request)) {
      reasons.push('route_mismatch');
      return outcome('BLOCKED');
    }
    if (!hasLiveExecutionCapabilities(request.buy) || !hasLiveExecutionCapabilities(request.sell)) {
      reasons.push('venue_execution_capability_missing');
      return outcome('BLOCKED');
    }

    transition('OPPORTUNITY_FOUND');
    transition('PREFLIGHT_CHECK');
    if (this.#repository.getSetting('balance_mismatch') === 'true') {
      transition('BALANCE_MISMATCH');
      return safeStop('persisted_balance_mismatch');
    }
    const risk = this.#repository.riskSnapshot(this.#clock());
    const [buyBookResult, sellBookResult] = await Promise.all([
      this.fetchFreshBook(request.buy),
      this.fetchFreshBook(request.sell),
    ]);
    if (!buyBookResult.ok || !sellBookResult.ok) {
      if (!buyBookResult.ok) reasons.push(...buyBookResult.reasons);
      if (!sellBookResult.ok) reasons.push(...sellBookResult.reasons);
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const evaluatedAt = this.#clock();
    const buyMultiplier = marketBaseMultiplier(request.buy.market);
    const sellMultiplier = marketBaseMultiplier(request.sell.market);
    const buyEvalMarket = canonicalMarketForEvaluation(request.buy.market);
    const sellEvalMarket = canonicalMarketForEvaluation(request.sell.market);
    const buyEvalBook = normalizeBookForMarket(buyBookResult.book, request.buy.market);
    const sellEvalBook = normalizeBookForMarket(sellBookResult.book, request.sell.market);
    if (
      !marketsShareUnderlying(
        request.buy.market,
        buyBookResult.book,
        request.sell.market,
        sellBookResult.book,
      )
    ) {
      reasons.push('alias_price_mismatch');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const evaluationSettings = preparation
      ? {
          ...this.#settings,
          safetyBufferBps: ZERO,
          minProfitUsd: ZERO,
          minNetProfitBps: ZERO,
        }
      : this.#settings;
    const evaluationInput = {
      base: buyEvalMarket.base,
      quote: buyEvalMarket.quote,
      buyMarket: buyEvalMarket,
      sellMarket: sellEvalMarket,
      buyBook: buyEvalBook,
      sellBook: sellEvalBook,
      requestedNotional: request.opportunity.requestedNotional,
      settings: evaluationSettings,
      now: evaluatedAt,
      venueHealth: {
        [request.buy.adapter.venueId]: request.buy.healthState,
        [request.sell.adapter.venueId]: request.sell.healthState,
      },
    } as const;
    const refreshed = preparation
      ? evaluateS1Preparation(evaluationInput, preparation)
      : evaluateS1Direction(evaluationInput);
    if (!refreshed.valid) {
      reasons.push(...refreshed.rejectionReasons);
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    if (!refreshed.expectedBuyPrice || !refreshed.expectedSellPrice) {
      reasons.push('price_precision_invalid');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const leg1Price = exchangePriceFromCanonical(refreshed.expectedBuyPrice, buyMultiplier);
    const plannedSellPrice = exchangePriceFromCanonical(
      refreshed.expectedSellPrice,
      sellMultiplier,
    );
    if (
      !request.buy.market.priceStep ||
      !request.sell.market.priceStep ||
      !request.buy.market.amountStep ||
      !request.sell.market.amountStep ||
      !buyEvalMarket.priceStep ||
      !sellEvalMarket.priceStep ||
      !isAligned(refreshed.expectedBuyPrice, buyEvalMarket.priceStep) ||
      !isAligned(refreshed.expectedSellPrice, sellEvalMarket.priceStep) ||
      !isAligned(leg1Price, request.buy.market.priceStep) ||
      !isAligned(plannedSellPrice, request.sell.market.priceStep)
    ) {
      reasons.push('price_precision_invalid');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const parallelFok = this.#legMode === 'parallel_fok';
    if (parallelFok && (!request.buy.market.supportsFok || !request.sell.market.supportsFok)) {
      reasons.push('parallel_fok_unsupported');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const plannedBase = refreshed.buyDepth?.executableBaseAmount ?? ZERO;
    let plannedLeg1Amount = alignAmountDown(
      exchangeAmountFromCanonical(plannedBase, buyMultiplier),
      request.buy.market.amountStep!,
    );
    let plannedLeg2Amount = alignAmountDown(
      exchangeAmountFromCanonical(plannedBase, sellMultiplier),
      request.sell.market.amountStep!,
    );
    if (parallelFok) {
      const commonCanonical = alignToCommonAmountStep(
        Decimal.min(
          canonicalAmountFromExchange(plannedLeg1Amount, buyMultiplier),
          canonicalAmountFromExchange(plannedLeg2Amount, sellMultiplier),
        ),
        buyEvalMarket.amountStep!,
        sellEvalMarket.amountStep!,
      );
      plannedLeg1Amount = alignAmountDown(
        exchangeAmountFromCanonical(commonCanonical, buyMultiplier),
        request.buy.market.amountStep,
      );
      plannedLeg2Amount = alignAmountDown(
        exchangeAmountFromCanonical(commonCanonical, sellMultiplier),
        request.sell.market.amountStep,
      );
    }
    const plannedBuyCanonical = canonicalAmountFromExchange(plannedLeg1Amount, buyMultiplier);
    const plannedSellCanonical = canonicalAmountFromExchange(plannedLeg2Amount, sellMultiplier);
    const plannedBuyNotional = plannedLeg1Amount.mul(leg1Price);
    const plannedSellNotional = plannedSellCanonical.mul(plannedSellPrice);
    if (parallelFok && !plannedBuyCanonical.eq(plannedSellCanonical)) {
      reasons.push('parallel_amount_mismatch');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    if (
      !plannedLeg1Amount.gt(0) ||
      !plannedLeg2Amount.gt(0) ||
      (request.buy.market.minAmount && plannedLeg1Amount.lt(request.buy.market.minAmount)) ||
      (request.sell.market.minAmount && plannedLeg2Amount.lt(request.sell.market.minAmount)) ||
      (request.buy.market.minNotional && plannedBuyNotional.lt(request.buy.market.minNotional)) ||
      (request.sell.market.minNotional && plannedSellNotional.lt(request.sell.market.minNotional))
    ) {
      reasons.push('below_min_notional');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const buyFeeBps = request.buy.market.feeTakerBps ?? ZERO;
    const requiredQuote = plannedBuyNotional
      .mul(new Decimal(1).plus(buyFeeBps.div(10_000)))
      .mul('1.01');
    const balances = await this.fetchBalances(
      request,
      requiredQuote,
      parallelFok ? plannedSellCanonical : plannedBase,
    );
    if (!balances.ok) {
      reasons.push(...balances.reasons);
      if (
        balances.reasons.includes('buy_quote_balance_insufficient') ||
        balances.reasons.includes('sell_base_balance_insufficient')
      ) {
        transition('BALANCE_MISMATCH');
        return safeStop('preflight_balance_mismatch');
      }
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const balanceBaselines = { buy: balances.buy, sell: balances.sell };
    const preflightAt = this.#clock();
    const decision = this.#gate.preflight({
      requestedNotional: refreshed.requestedNotional,
      expectedNetProfit: refreshed.conservativeNetProfit,
      expectedNetProfitBps: refreshed.netProfitBps,
      openBatches: this.#repository.countOpenExecutions(),
      unresolvedUnknownOrders: this.#repository.countUnresolvedOrders(),
      dailyRealizedLoss: risk.dailyRealizedLoss,
      dailyRebalanceCost: risk.dailyRebalanceCost,
      unhedgedInventoryRisk: risk.unhedgedInventoryRisk,
      buyBookAgeMs: Math.max(0, preflightAt - buyBookResult.book.fetchedAt),
      sellBookAgeMs: Math.max(0, preflightAt - sellBookResult.book.fetchedAt),
      buyVenueHealth: request.buy.healthState,
      sellVenueHealth: request.sell.healthState,
      manualConfirmation: request.confirmedBatchId === request.batchId,
      iocOrFokSupported: Boolean(
        (request.buy.market.supportsIoc || request.buy.market.supportsFok) &&
        (request.sell.market.supportsIoc || request.sell.market.supportsFok),
      ),
      feesConfigured:
        feeConfigured(request.buy.market.feeTakerBps) &&
        feeConfigured(request.sell.market.feeTakerBps),
      precisionConfigured: Boolean(
        request.buy.market.amountStep &&
        request.sell.market.amountStep &&
        request.buy.market.priceStep &&
        request.sell.market.priceStep,
      ),
      balanceMismatch: false,
      ...(preparation ? { preparation } : {}),
    });
    if (!decision.allowed) {
      reasons.push(...decision.reasons);
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }

    const preflight = {
      strategy: intent === 'inventory_preparation' ? 'PREP' : 'S1',
      intent,
      ...(preparation
        ? {
            preparation: {
              maxCostBps: preparation.maxCostBps.toFixed(),
              maxCostUsd: preparation.maxCostUsd.toFixed(),
            },
          }
        : {}),
      evaluatedAt,
      preflightAt,
      requestedNotional: refreshed.requestedNotional.toFixed(),
      refreshed: {
        grossSpread: refreshed.grossSpread.toFixed(),
        totalCost: refreshed.totalCost.toFixed(),
        depthNetProfit: refreshed.depthNetProfit.toFixed(),
        conservativeNetProfit: refreshed.conservativeNetProfit.toFixed(),
        netProfitBps: refreshed.netProfitBps.toFixed(),
        expectedBuyPrice: refreshed.expectedBuyPrice?.toFixed() ?? null,
        expectedSellPrice: refreshed.expectedSellPrice?.toFixed() ?? null,
        buyDepth: refreshed.buyDepth
          ? {
              executableBaseAmount: refreshed.buyDepth.executableBaseAmount.toFixed(),
              executableQuoteAmount: refreshed.buyDepth.executableQuoteAmount.toFixed(),
              averagePrice: refreshed.buyDepth.averagePrice.toFixed(),
              worstPrice: refreshed.buyDepth.worstPrice.toFixed(),
              levelsConsumed: refreshed.buyDepth.levelsConsumed,
              insufficientDepth: refreshed.buyDepth.insufficientDepth,
            }
          : null,
      },
      orderbooks: {
        buy: {
          venueId: buyBookResult.book.venueId,
          symbol: buyBookResult.book.exchangeSymbol,
          fetchedAt: buyBookResult.book.fetchedAt,
          bids: buyBookResult.book.bids.map((level) => ({
            price: level.price.toFixed(),
            amount: level.amount.toFixed(),
          })),
          asks: buyBookResult.book.asks.map((level) => ({
            price: level.price.toFixed(),
            amount: level.amount.toFixed(),
          })),
        },
        sell: {
          venueId: sellBookResult.book.venueId,
          symbol: sellBookResult.book.exchangeSymbol,
          fetchedAt: sellBookResult.book.fetchedAt,
          bids: sellBookResult.book.bids.map((level) => ({
            price: level.price.toFixed(),
            amount: level.amount.toFixed(),
          })),
          asks: sellBookResult.book.asks.map((level) => ({
            price: level.price.toFixed(),
            amount: level.amount.toFixed(),
          })),
        },
      },
      balanceRequirements: {
        quoteCurrency: request.buy.market.quote,
        requiredQuote: requiredQuote.toFixed(),
        baseCurrency: marketExchangeBase(request.sell.market),
        requiredBase: (parallelFok ? plannedSellCanonical : plannedBase).toFixed(),
        requiredExchangeBase: plannedLeg2Amount.toFixed(),
        canonicalBase: request.buy.market.base,
        buyBaseMultiplier: buyMultiplier.toFixed(),
        sellBaseMultiplier: sellMultiplier.toFixed(),
      },
      riskSnapshot: {
        dailyRealizedLoss: risk.dailyRealizedLoss.toFixed(),
        dailyRebalanceCost: risk.dailyRebalanceCost.toFixed(),
        unhedgedInventoryRisk: risk.unhedgedInventoryRisk.toFixed(),
      },
      gateDecision: decision,
    };

    const executionId = this.#repository.createExecution({
      strategy: intent === 'inventory_preparation' ? 'PREP' : 'S1',
      batchId: request.batchId,
      status: 'PREFLIGHT_CHECK',
      plannedNotional: refreshed.requestedNotional,
      expectedProfit: refreshed.conservativeNetProfit,
      openedAt: preflightAt,
      ...(request.opportunityId !== undefined ? { opportunityId: request.opportunityId } : {}),
      preflight,
      metadata: {
        opportunityKey: refreshed.opportunityKey,
        instrumentKey: refreshed.instrumentKey,
        direction: refreshed.direction,
        intent,
      },
    });
    this.#executionIds.set(request.batchId, executionId);
    this.#repository.updateExecutionPreflight(executionId, preflight);
    this.#repository.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: request.buy.adapter.venueId,
      side: 'buy',
      requestedAmount: plannedLeg1Amount,
      requestedPrice: leg1Price,
      status: 'planned',
      clientOrderId: `${request.batchId}-L1`,
    });
    this.#repository.addExecutionLeg({
      executionId,
      legNumber: 2,
      venueId: request.sell.adapter.venueId,
      side: 'sell',
      requestedAmount: plannedLeg2Amount,
      requestedPrice: plannedSellPrice,
      status: 'planned',
      clientOrderId: `${request.batchId}-L2`,
    });
    this.#repository.updateExecutionStatus(executionId, 'PREFLIGHT_CHECK');

    if (parallelFok) {
      ordersSubmitted += 2;
      return this.executeParallelFok({
        request,
        executionId,
        preflightAt,
        buyPrice: leg1Price,
        sellPrice: plannedSellPrice,
        buyAmount: plannedLeg1Amount,
        sellAmount: plannedLeg2Amount,
        buyMultiplier,
        sellMultiplier,
        buyBalanceBaseline: balanceBaselines.buy,
        sellBalanceBaseline: balanceBaselines.sell,
        transition,
        safeStop,
        outcome,
        states: () => states,
      });
    }

    transition('LEG1_SUBMITTING');
    const leg1TimeInForce = request.buy.market.supportsIoc ? ('IOC' as const) : ('FOK' as const);
    const leg1Request = {
      symbol: request.buy.market.exchangeSymbol,
      side: 'buy' as const,
      type: 'limit' as const,
      amount: plannedLeg1Amount,
      price: leg1Price,
      timeInForce: leg1TimeInForce,
      clientOrderId: `${request.batchId}-L1`,
    };
    this.prepareOrder(request, 1, leg1Request);
    let leg1: OrderState;
    let leg1NoFill = false;
    ordersSubmitted += 1;
    try {
      leg1 = await request.buy.adapter.createOrder!(leg1Request, request.buy.credentials);
      this.persistOrder(request, 1, leg1);
    } catch (error) {
      if (isDefinitiveNoFillCreateError(error)) {
        leg1 = syntheticNoFillOrder(leg1Request, 'definitive_ioc_or_fok_no_fill');
        leg1NoFill = true;
        this.persistOrder(request, 1, leg1);
        this.#repository.recordRiskEvent(
          'info',
          'definitive_no_fill_submission',
          'venue explicitly rejected an IOC/FOK order without filling',
          {
            batchId: request.batchId,
            leg: 1,
            venueId: request.buy.adapter.venueId,
            error: String(error),
          },
        );
      } else {
        this.markSubmissionUnknown(request, 1, leg1Request, error);
        this.#repository.updateExecutionStatus(executionId, 'LEG1_UNKNOWN', {
          safeModeReason: 'ambiguous_leg1_submission',
        });
        transition('LEG1_UNKNOWN');
        const recovered = await this.reconcile(request, request.buy, 1);
        if (recovered.ok && recovered.order.filled.gt(0)) {
          this.recordUnhedgedInventory(
            request,
            executionId,
            canonicalAmountFromExchange(recovered.order.filled, buyMultiplier),
            this.conservativePrice(
              recovered.order.averagePrice
                ? canonicalPriceFromExchange(recovered.order.averagePrice, buyMultiplier)
                : refreshed.expectedBuyPrice,
              refreshed.expectedSellPrice,
            ),
            'ambiguous_leg1_fill_reconciled',
          );
        }
        return safeStop('ambiguous_leg1_submission');
      }
    }

    const reconciledLeg1 = leg1NoFill
      ? { ok: true as const, order: leg1 }
      : await this.reconcile(request, request.buy, 1, leg1, balanceBaselines.buy, leg1TimeInForce);
    transition('LEG1_RECONCILING');
    if (!reconciledLeg1.ok) return safeStop(reconciledLeg1.reason);
    let first = reconciledLeg1.order;
    if (first.status === 'rejected') {
      transition('LEG1_REJECTED');
      this.#repository.updateExecutionStatus(executionId, 'LEG1_REJECTED', {
        closedAt: this.#clock(),
      });
      return outcome('LEG1_REJECTED');
    }
    if (first.filled.lt(first.amount) || first.remaining.gt(0)) {
      transition('LEG1_PARTIAL');
      if (first.status === 'open' && first.remaining.gt(0)) {
        const canceled = await this.cancelRemaining(request, request.buy, 1, first);
        if (!canceled.ok) {
          this.recordUnhedgedInventory(
            request,
            executionId,
            canonicalAmountFromExchange(first.filled, buyMultiplier),
            this.conservativePrice(
              first.averagePrice
                ? canonicalPriceFromExchange(first.averagePrice, buyMultiplier)
                : refreshed.expectedBuyPrice,
              refreshed.expectedSellPrice,
            ),
            'leg1_partial_cancel_unconfirmed',
          );
          return safeStop(canceled.reason);
        }
        first = canceled.order;
      }
      this.#repository.updateExecutionLeg(`${request.batchId}-L1`, {
        status: first.filled.gt(0) ? 'partial' : 'canceled',
        filledAmount: first.filled,
        averageFillPrice: first.averagePrice,
        feePaid: first.fee,
        orderId: first.venueOrderId,
      });
      if (first.filled.lte(0)) {
        transition('CLOSED');
        const closedAt = this.#clock();
        this.#repository.updateExecutionStatus(executionId, 'CLOSED', {
          realizedProfit: ZERO,
          closedAt,
          grossSpread: ZERO,
          fees: first.fee ?? ZERO,
          latencyMs: Math.max(0, closedAt - preflightAt),
          inventoryDelta: {
            baseAsset: request.buy.market.base,
            baseDelta: '0',
            quoteAsset: request.buy.market.quote,
            quoteDelta: '0',
          },
          metadata: { states: [...states], outcome: 'CLOSED', leg1Filled: '0' },
        });
        return outcome('CLOSED', ZERO);
      }
    }
    transition('HEDGE_DECISION');
    const boughtCanonical = canonicalAmountFromExchange(first.filled, buyMultiplier);
    const buyCanonicalAverage = first.averagePrice
      ? canonicalPriceFromExchange(first.averagePrice, buyMultiplier)
      : refreshed.expectedBuyPrice;
    const secondBookResult = await this.fetchFreshBook(request.sell);
    if (!secondBookResult.ok) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, refreshed.expectedSellPrice),
        'leg2_orderbook_unavailable',
      );
      return safeStop(secondBookResult.reasons.join(','));
    }
    const sellHedgeBook = normalizeBookForMarket(secondBookResult.book, request.sell.market);
    const sellDepth = calculateSellDepthByBase(sellHedgeBook, boughtCanonical);
    const sellExecutionPrice = sellDepth.worstPrice.gt(0)
      ? exchangePriceFromCanonical(sellDepth.worstPrice, sellMultiplier)
      : ZERO;
    if (
      !request.sell.market.priceStep ||
      !sellEvalMarket.priceStep ||
      !isAligned(sellDepth.worstPrice, sellEvalMarket.priceStep) ||
      !isAligned(sellExecutionPrice, request.sell.market.priceStep)
    ) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, refreshed.expectedSellPrice),
        'leg2_price_precision_invalid',
      );
      return safeStop('leg2_price_precision_invalid');
    }
    if (sellDepth.insufficientDepth) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, refreshed.expectedSellPrice),
        'insufficient_leg2_depth',
      );
      return safeStop('insufficient_leg2_depth');
    }
    const leg2Canonical = alignAmountDown(boughtCanonical, sellEvalMarket.amountStep!);
    const leg2Amount = alignAmountDown(
      exchangeAmountFromCanonical(leg2Canonical, sellMultiplier),
      request.sell.market.amountStep!,
    );
    const leg2CanonicalActual = canonicalAmountFromExchange(leg2Amount, sellMultiplier);
    const executionSellDepth = leg2Amount.gt(0)
      ? calculateSellDepthByBase(sellHedgeBook, leg2CanonicalActual)
      : undefined;
    if (
      !leg2Amount.gt(0) ||
      !executionSellDepth ||
      executionSellDepth.insufficientDepth ||
      (request.sell.market.minAmount && leg2Amount.lt(request.sell.market.minAmount)) ||
      (request.sell.market.minNotional &&
        executionSellDepth.executableQuoteAmount.lt(request.sell.market.minNotional))
    ) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, sellDepth.averagePrice),
        'leg2_below_minimum',
      );
      return safeStop('leg2_below_minimum');
    }
    const buyFee = first.fee ?? ZERO;
    const buyCost = (first.averagePrice ?? leg1Price).mul(first.filled).plus(buyFee);
    const sellFee = executionSellDepth.executableQuoteAmount.mul(
      (request.sell.market.feeTakerBps ?? ZERO).div(10_000),
    );
    const projectedProfit = executionSellDepth.executableQuoteAmount.minus(sellFee).minus(buyCost);
    const postFillProfitBps = request.opportunity.requestedNotional.gt(0)
      ? projectedProfit.div(request.opportunity.requestedNotional).mul(10_000)
      : new Decimal(Number.NEGATIVE_INFINITY);
    const preparationCostTooHigh =
      preparation !== undefined &&
      (projectedProfit.lt(preparation.maxCostUsd.neg()) ||
        postFillProfitBps.lt(preparation.maxCostBps.neg()));
    if (preparation ? preparationCostTooHigh : projectedProfit.lte(0)) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
        preparation ? 'post_fill_preparation_cost_too_high' : 'post_fill_profit_not_positive',
      );
      return safeStop(
        preparation ? 'post_fill_preparation_cost_too_high' : 'post_fill_profit_not_positive',
      );
    }
    const precisionResidual = boughtCanonical.minus(leg2CanonicalActual);
    if (precisionResidual.gt(0)) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        precisionResidual,
        this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
        'leg2_precision_residual',
      );
    }
    this.#repository.updateExecutionLeg(`${request.batchId}-L1`, {
      status: 'filled',
      filledAmount: first.filled,
      averageFillPrice: first.averagePrice,
      feePaid: first.fee,
      orderId: first.venueOrderId,
    });

    transition('LEG2_SUBMITTING');
    const leg2TimeInForce = request.sell.market.supportsIoc ? ('IOC' as const) : ('FOK' as const);
    const leg2Request = {
      symbol: request.sell.market.exchangeSymbol,
      side: 'sell' as const,
      type: 'limit' as const,
      amount: leg2Amount,
      price: sellExecutionPrice,
      timeInForce: leg2TimeInForce,
      clientOrderId: `${request.batchId}-L2`,
    };
    this.prepareOrder(request, 2, leg2Request);
    let leg2: OrderState;
    let leg2NoFill = false;
    ordersSubmitted += 1;
    try {
      leg2 = await request.sell.adapter.createOrder!(leg2Request, request.sell.credentials);
      this.persistOrder(request, 2, leg2);
    } catch (error) {
      if (isDefinitiveNoFillCreateError(error)) {
        leg2 = syntheticNoFillOrder(leg2Request, 'definitive_ioc_or_fok_no_fill');
        leg2NoFill = true;
        this.persistOrder(request, 2, leg2);
        this.#repository.recordRiskEvent(
          'warning',
          'definitive_no_fill_submission',
          'venue explicitly rejected the hedge IOC/FOK order without filling',
          {
            batchId: request.batchId,
            leg: 2,
            venueId: request.sell.adapter.venueId,
            error: String(error),
          },
        );
      } else {
        this.markSubmissionUnknown(request, 2, leg2Request, error);
        this.#repository.updateExecutionStatus(executionId, 'LEG2_UNKNOWN');
        transition('LEG2_UNKNOWN');
        const recovered = await this.reconcile(
          request,
          request.sell,
          2,
          undefined,
          balanceBaselines.sell,
          leg2TimeInForce,
        );
        const reconciledFill = recovered.ok ? recovered.order.filled : ZERO;
        const reconciledCanonical = canonicalAmountFromExchange(reconciledFill, sellMultiplier);
        this.recordUnhedgedInventory(
          request,
          executionId,
          Decimal.max(0, boughtCanonical.minus(reconciledCanonical)),
          this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
          'ambiguous_leg2_submission',
        );
        return safeStop('ambiguous_leg2_submission');
      }
    }

    const reconciledLeg2 = leg2NoFill
      ? { ok: true as const, order: leg2 }
      : await this.reconcile(
          request,
          request.sell,
          2,
          leg2,
          balanceBaselines.sell,
          leg2TimeInForce,
        );
    transition('LEG2_RECONCILING');
    if (!reconciledLeg2.ok) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
        'leg2_reconcile_failed',
      );
      return safeStop(reconciledLeg2.reason);
    }
    let second = reconciledLeg2.order;
    if (second.status === 'rejected') {
      transition('LEG2_REJECTED');
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
        'leg2_rejected',
      );
      return safeStop('leg2_rejected');
    }
    if (second.filled.lt(second.amount) || second.remaining.gt(0)) {
      transition('LEG2_PARTIAL');
      if (second.status === 'open' && second.remaining.gt(0)) {
        const canceled = await this.cancelRemaining(request, request.sell, 2, second);
        if (!canceled.ok) {
          this.recordUnhedgedInventory(
            request,
            executionId,
            Decimal.max(
              0,
              boughtCanonical.minus(canonicalAmountFromExchange(second.filled, sellMultiplier)),
            ),
            this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
            'leg2_partial_cancel_unconfirmed',
          );
          return safeStop(canceled.reason);
        }
        second = canceled.order;
      }
      this.#repository.updateExecutionLeg(`${request.batchId}-L2`, {
        status: 'partial',
        filledAmount: second.filled,
        averageFillPrice: second.averagePrice,
        feePaid: second.fee,
        orderId: second.venueOrderId,
      });
      this.recordUnhedgedInventory(
        request,
        executionId,
        Decimal.max(
          0,
          boughtCanonical.minus(canonicalAmountFromExchange(second.filled, sellMultiplier)),
        ),
        this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
        'leg2_partial_fill',
      );
      return safeStop('leg2_partial_fill');
    }
    transition('CLOSED');
    const soldCanonical = canonicalAmountFromExchange(second.filled, sellMultiplier);
    const sellCanonicalAverage = second.averagePrice
      ? canonicalPriceFromExchange(second.averagePrice, sellMultiplier)
      : canonicalPriceFromExchange(sellExecutionPrice, sellMultiplier);
    const accounting = await this.reconcileClosedTrade({
      request,
      buyBaseline: balanceBaselines.buy,
      sellBaseline: balanceBaselines.sell,
      buyBaseFilled: boughtCanonical,
      sellBaseFilled: soldCanonical,
      buyPrice: buyCanonicalAverage,
      sellPrice: sellCanonicalAverage,
    });
    const sellFeeActual = second.fee ?? ZERO;
    const sellProceeds = (second.averagePrice ?? sellExecutionPrice).mul(second.filled);
    const fallbackRealized = sellProceeds.minus(sellFeeActual).minus(buyCost);
    const fallbackGrossSpread = sellProceeds.minus(
      (first.averagePrice ?? leg1Price).mul(first.filled),
    );
    const realized = accounting?.economicProfit ?? fallbackRealized;
    const grossSpread = accounting?.grossSpread ?? fallbackGrossSpread;
    const fees = accounting?.netFeesQuote ?? buyFee.plus(sellFeeActual);
    const riskProfit = accounting?.cashProfit ?? realized;
    this.#repository.updateExecutionLeg(`${request.batchId}-L2`, {
      status: 'filled',
      filledAmount: second.filled,
      averageFillPrice: second.averagePrice,
      feePaid: second.fee,
      orderId: second.venueOrderId,
    });
    const closedAt = this.#clock();
    this.#repository.updateExecutionStatus(executionId, 'CLOSED', {
      realizedProfit: realized,
      closedAt,
      grossSpread,
      fees,
      latencyMs: Math.max(0, closedAt - preflightAt),
      inventoryDelta: {
        baseAsset: request.buy.market.base,
        baseDelta: (accounting?.baseDelta ?? boughtCanonical.minus(soldCanonical)).toFixed(),
        quoteAsset: request.buy.market.quote,
        quoteDelta: (accounting?.quoteDelta ?? realized).toFixed(),
      },
      metadata: {
        states: [...states],
        outcome: 'CLOSED',
        leg1Filled: first.filled.toFixed(),
        leg2Filled: second.filled.toFixed(),
        leg1CanonicalFilled: boughtCanonical.toFixed(),
        leg2CanonicalFilled: soldCanonical.toFixed(),
        buyExchangeBase: marketExchangeBase(request.buy.market),
        sellExchangeBase: marketExchangeBase(request.sell.market),
        buyBaseMultiplier: buyMultiplier.toFixed(),
        sellBaseMultiplier: sellMultiplier.toFixed(),
        leg1AveragePrice: first.averagePrice?.toFixed() ?? null,
        leg2AveragePrice: second.averagePrice?.toFixed() ?? null,
        ...(accounting
          ? {
              profitAccounting: 'balance_delta_with_accrued_rebate',
              cashProfitQuote: accounting.cashProfit.toFixed(),
              rebateReceivableQuote: accounting.rebateReceivableQuote.toFixed(),
              grossFeesQuote: accounting.grossFeesQuote.toFixed(),
              netFeesQuote: accounting.netFeesQuote.toFixed(),
              economicProfitQuote: accounting.economicProfit.toFixed(),
              buyGrossFeeQuote: accounting.buyGrossFeeQuote.toFixed(),
              sellGrossFeeQuote: accounting.sellGrossFeeQuote.toFixed(),
              baseDelta: accounting.baseDelta.toFixed(),
              quoteDelta: accounting.quoteDelta.toFixed(),
              markPrice: accounting.markPrice.toFixed(),
            }
          : { profitAccounting: 'order_fee_fallback' }),
      },
    });
    if (riskProfit.lt(0)) this.#repository.addRealizedLoss(riskProfit.abs(), closedAt);
    return outcome('CLOSED', realized);
  }

  private async executeParallelFok(plan: ParallelFokPlan): Promise<LiveExecutionResult> {
    const { request } = plan;
    plan.transition('PARALLEL_SUBMITTING');
    const buyOrder: PreparedLimitOrder = {
      symbol: request.buy.market.exchangeSymbol,
      side: 'buy',
      type: 'limit',
      amount: plan.buyAmount,
      price: plan.buyPrice,
      timeInForce: 'FOK',
      clientOrderId: `${request.batchId}-L1`,
    };
    const sellOrder: PreparedLimitOrder = {
      symbol: request.sell.market.exchangeSymbol,
      side: 'sell',
      type: 'limit',
      amount: plan.sellAmount,
      price: plan.sellPrice,
      timeInForce: 'FOK',
      clientOrderId: `${request.batchId}-L2`,
    };
    this.prepareOrder(request, 1, buyOrder);
    this.prepareOrder(request, 2, sellOrder);
    const [buySubmission, sellSubmission] = await Promise.all([
      this.submitParallelFokLeg(request, 1, buyOrder),
      this.submitParallelFokLeg(request, 2, sellOrder),
    ]);
    const responseAt = this.#clock();
    const submissionStartSkewMs = Math.abs(buySubmission.submittedAt - sellSubmission.submittedAt);
    const responseSkewMs = Math.abs(buySubmission.respondedAt - sellSubmission.respondedAt);
    this.#repository.recordAudit(
      'executor',
      'parallel_fok_submission_timing',
      {
        batchId: request.batchId,
        submissionStartSkewMs,
        responseSkewMs,
        buy: {
          ok: buySubmission.ok,
          submittedAt: buySubmission.submittedAt,
          respondedAt: buySubmission.respondedAt,
          ...(buySubmission.ok ? {} : { error: buySubmission.error }),
        },
        sell: {
          ok: sellSubmission.ok,
          submittedAt: sellSubmission.submittedAt,
          respondedAt: sellSubmission.respondedAt,
          ...(sellSubmission.ok ? {} : { error: sellSubmission.error }),
        },
      },
      responseAt,
    );

    plan.transition('PARALLEL_RECONCILING');
    const [buyReconciliation, sellReconciliation] = await Promise.all([
      this.reconcile(
        request,
        request.buy,
        1,
        buySubmission.ok ? buySubmission.order : undefined,
        plan.buyBalanceBaseline,
        'FOK',
      ),
      this.reconcile(
        request,
        request.sell,
        2,
        sellSubmission.ok ? sellSubmission.order : undefined,
        plan.sellBalanceBaseline,
        'FOK',
      ),
    ]);
    let buyOrderState = buyReconciliation.ok ? buyReconciliation.order : undefined;
    let sellOrderState = sellReconciliation.ok ? sellReconciliation.order : undefined;

    const cancellationTasks: Array<
      Promise<{
        leg: 1 | 2;
        result: { ok: true; order: OrderState } | { ok: false; reason: string };
      }>
    > = [];
    if (buyOrderState?.status === 'open' && buyOrderState.remaining.gt(0)) {
      cancellationTasks.push(
        this.cancelRemaining(request, request.buy, 1, buyOrderState).then((result) => ({
          leg: 1 as const,
          result,
        })),
      );
    }
    if (sellOrderState?.status === 'open' && sellOrderState.remaining.gt(0)) {
      cancellationTasks.push(
        this.cancelRemaining(request, request.sell, 2, sellOrderState).then((result) => ({
          leg: 2 as const,
          result,
        })),
      );
    }
    let cancellationFailure: string | undefined;
    for (const cancellation of await Promise.all(cancellationTasks)) {
      if (!cancellation.result.ok) {
        cancellationFailure = cancellation.result.reason;
      } else if (cancellation.leg === 1) {
        buyOrderState = cancellation.result.order;
      } else {
        sellOrderState = cancellation.result.order;
      }
    }

    const buyFilledCanonical = buyOrderState
      ? canonicalAmountFromExchange(buyOrderState.filled, plan.buyMultiplier)
      : undefined;
    const sellFilledCanonical = sellOrderState
      ? canonicalAmountFromExchange(sellOrderState.filled, plan.sellMultiplier)
      : undefined;
    const unresolvedReasons = [
      ...(!buyReconciliation.ok ? [buyReconciliation.reason] : []),
      ...(!sellReconciliation.ok ? [sellReconciliation.reason] : []),
      ...(cancellationFailure ? [cancellationFailure] : []),
    ];
    if (unresolvedReasons.length > 0 || !buyOrderState || !sellOrderState) {
      this.recordParallelResidualRisk(
        request,
        plan.executionId,
        buyFilledCanonical,
        sellFilledCanonical,
        buyOrderState?.averagePrice ?? plan.buyPrice,
        sellOrderState?.averagePrice ?? plan.sellPrice,
        'parallel_unresolved_fill',
      );
      return plan.safeStop(unresolvedReasons.join(',') || 'parallel_leg_unresolved');
    }

    const buyFilled = buyOrderState.filled;
    const sellFilled = sellOrderState.filled;
    if (buyFilled.eq(0) && sellFilled.eq(0)) {
      plan.transition('PARALLEL_REJECTED');
      const closedAt = this.#clock();
      this.#repository.updateExecutionStatus(plan.executionId, 'PARALLEL_REJECTED', {
        realizedProfit: ZERO,
        closedAt,
        latencyMs: Math.max(0, closedAt - plan.preflightAt),
        metadata: {
          states: [...plan.states()],
          outcome: 'PARALLEL_REJECTED',
          mode: 'parallel_fok',
          submissionStartSkewMs,
          responseSkewMs,
        },
      });
      this.#repository.recordRiskEvent(
        'warning',
        'parallel_fok_rejected',
        'both FOK legs finished without a fill',
        {
          batchId: request.batchId,
          buyStatus: buyOrderState.status,
          sellStatus: sellOrderState.status,
        },
      );
      return plan.outcome('PARALLEL_REJECTED');
    }

    const buyComplete =
      buyOrderState.filled.gte(buyOrderState.amount) && buyOrderState.remaining.lte(0);
    const sellComplete =
      sellOrderState.filled.gte(sellOrderState.amount) && sellOrderState.remaining.lte(0);
    const boughtCanonical = canonicalAmountFromExchange(buyFilled, plan.buyMultiplier);
    const soldCanonical = canonicalAmountFromExchange(sellFilled, plan.sellMultiplier);
    if (!buyComplete || !sellComplete) {
      this.recordParallelResidualRisk(
        request,
        plan.executionId,
        boughtCanonical,
        soldCanonical,
        buyOrderState.averagePrice ?? plan.buyPrice,
        sellOrderState.averagePrice ?? plan.sellPrice,
        'parallel_incomplete_fill',
      );
      return plan.safeStop('parallel_leg_not_fully_filled');
    }
    if (!boughtCanonical.eq(soldCanonical)) {
      this.recordParallelResidualRisk(
        request,
        plan.executionId,
        boughtCanonical,
        soldCanonical,
        buyOrderState.averagePrice ?? plan.buyPrice,
        sellOrderState.averagePrice ?? plan.sellPrice,
        'parallel_fill_mismatch',
      );
      return plan.safeStop('parallel_fill_mismatch');
    }

    const buyAverage = buyOrderState.averagePrice ?? plan.buyPrice;
    const sellAverage = sellOrderState.averagePrice ?? plan.sellPrice;
    const buyFee = buyOrderState.fee ?? ZERO;
    const sellFee = sellOrderState.fee ?? ZERO;
    const buyCost = buyAverage.mul(buyFilled).plus(buyFee);
    const sellProceeds = sellAverage.mul(sellFilled);
    const fallbackRealized = sellProceeds.minus(sellFee).minus(buyCost);
    const fallbackGrossSpread = sellProceeds.minus(buyAverage.mul(buyFilled));
    this.#repository.updateExecutionLeg(`${request.batchId}-L1`, {
      status: 'filled',
      filledAmount: buyFilled,
      averageFillPrice: buyOrderState.averagePrice,
      feePaid: buyOrderState.fee,
      orderId: buyOrderState.venueOrderId,
    });
    this.#repository.updateExecutionLeg(`${request.batchId}-L2`, {
      status: 'filled',
      filledAmount: sellFilled,
      averageFillPrice: sellOrderState.averagePrice,
      feePaid: sellOrderState.fee,
      orderId: sellOrderState.venueOrderId,
    });
    plan.transition('CLOSED');
    const accounting = await this.reconcileClosedTrade({
      request,
      buyBaseline: plan.buyBalanceBaseline,
      sellBaseline: plan.sellBalanceBaseline,
      buyBaseFilled: boughtCanonical,
      sellBaseFilled: soldCanonical,
      buyPrice: canonicalPriceFromExchange(buyAverage, plan.buyMultiplier),
      sellPrice: canonicalPriceFromExchange(sellAverage, plan.sellMultiplier),
    });
    const realized = accounting?.economicProfit ?? fallbackRealized;
    const grossSpread = accounting?.grossSpread ?? fallbackGrossSpread;
    const fees = accounting?.netFeesQuote ?? buyFee.plus(sellFee);
    const riskProfit = accounting?.cashProfit ?? realized;
    const closedAt = this.#clock();
    this.#repository.updateExecutionStatus(plan.executionId, 'CLOSED', {
      realizedProfit: realized,
      closedAt,
      grossSpread,
      fees,
      latencyMs: Math.max(0, closedAt - plan.preflightAt),
      inventoryDelta: {
        baseAsset: request.buy.market.base,
        baseDelta: (accounting?.baseDelta ?? ZERO).toFixed(),
        quoteAsset: request.buy.market.quote,
        quoteDelta: (accounting?.quoteDelta ?? realized).toFixed(),
      },
      metadata: {
        states: [...plan.states()],
        outcome: 'CLOSED',
        mode: 'parallel_fok',
        submissionStartSkewMs,
        responseSkewMs,
        leg1Filled: buyFilled.toFixed(),
        leg2Filled: sellFilled.toFixed(),
        leg1CanonicalFilled: boughtCanonical.toFixed(),
        leg2CanonicalFilled: soldCanonical.toFixed(),
        leg1AveragePrice: buyOrderState.averagePrice?.toFixed() ?? null,
        leg2AveragePrice: sellOrderState.averagePrice?.toFixed() ?? null,
        ...(accounting
          ? {
              profitAccounting: 'balance_delta_with_accrued_rebate',
              cashProfitQuote: accounting.cashProfit.toFixed(),
              rebateReceivableQuote: accounting.rebateReceivableQuote.toFixed(),
              grossFeesQuote: accounting.grossFeesQuote.toFixed(),
              netFeesQuote: accounting.netFeesQuote.toFixed(),
              economicProfitQuote: accounting.economicProfit.toFixed(),
              buyGrossFeeQuote: accounting.buyGrossFeeQuote.toFixed(),
              sellGrossFeeQuote: accounting.sellGrossFeeQuote.toFixed(),
              baseDelta: accounting.baseDelta.toFixed(),
              quoteDelta: accounting.quoteDelta.toFixed(),
              markPrice: accounting.markPrice.toFixed(),
            }
          : { profitAccounting: 'order_fee_fallback' }),
      },
    });
    if (riskProfit.lt(0)) this.#repository.addRealizedLoss(riskProfit.abs(), closedAt);
    return plan.outcome('CLOSED', realized);
  }

  private async submitParallelFokLeg(
    request: LiveExecutionRequest,
    leg: 1 | 2,
    order: PreparedLimitOrder,
  ): Promise<
    | { ok: true; order: OrderState; submittedAt: number; respondedAt: number }
    | { ok: false; error: string; submittedAt: number; respondedAt: number }
  > {
    const venue = leg === 1 ? request.buy : request.sell;
    const submittedAt = this.#clock();
    try {
      const state = await venue.adapter.createOrder!(order, venue.credentials);
      this.persistOrder(request, leg, state);
      return { ok: true, order: state, submittedAt, respondedAt: this.#clock() };
    } catch (error) {
      if (isDefinitiveNoFillCreateError(error)) {
        const state = syntheticNoFillOrder(order, 'definitive_ioc_or_fok_no_fill');
        this.persistOrder(request, leg, state);
        this.#repository.recordRiskEvent(
          'info',
          'definitive_no_fill_submission',
          'venue explicitly rejected a parallel FOK order without filling',
          {
            batchId: request.batchId,
            leg,
            venueId: venue.adapter.venueId,
            error: String(error),
          },
        );
        return { ok: true, order: state, submittedAt, respondedAt: this.#clock() };
      }
      this.markSubmissionUnknown(request, leg, order, error);
      return { ok: false, error: String(error), submittedAt, respondedAt: this.#clock() };
    }
  }

  private recordParallelResidualRisk(
    request: LiveExecutionRequest,
    executionId: number,
    buyFilled: Decimal | undefined,
    sellFilled: Decimal | undefined,
    buyPrice: Decimal | undefined,
    sellPrice: Decimal | undefined,
    reason: string,
  ): void {
    const bought = buyFilled ?? ZERO;
    const sold = sellFilled ?? ZERO;
    if (bought.gt(sold)) {
      this.recordUnhedgedInventoryAt(
        request,
        executionId,
        request.buy,
        bought.minus(sold),
        this.conservativePrice(buyPrice, sellPrice),
        `${reason}_long`,
        'long',
      );
    } else if (sold.gt(bought)) {
      this.recordUnhedgedInventoryAt(
        request,
        executionId,
        request.sell,
        sold.minus(bought),
        this.conservativeShortPrice(buyPrice, sellPrice),
        `${reason}_inventory_shortfall`,
        'short',
      );
    }
  }

  readonly #executionIds = new Map<string, number>();

  private async fetchBalances(
    request: LiveExecutionRequest,
    requiredQuote: Decimal,
    requiredBase: Decimal,
  ): Promise<
    | { ok: true; buy: VenueBalanceBaseline; sell: VenueBalanceBaseline }
    | { ok: false; reasons: string[] }
  > {
    try {
      const buyBalances = await request.buy.adapter.fetchBalances!(request.buy.credentials);
      const sellBalances = await request.sell.adapter.fetchBalances!(request.sell.credentials);
      for (const balance of [...buyBalances, ...sellBalances]) {
        this.#repository.recordBalance(balance);
        this.#repository.recordInventorySnapshot({
          venueId: balance.venueId,
          accountId: balance.accountId,
          asset: balance.currency,
          free: balance.free,
          used: balance.used,
          total: balance.total,
          capturedAt: balance.fetchedAt,
        });
      }
      const quoteBalance = buyBalances.find(
        (balance) =>
          balance.venueId === request.buy.adapter.venueId &&
          balance.currency.toUpperCase() === request.buy.market.quote.toUpperCase(),
      );
      const baseBalance = sellBalances.find(
        (balance) =>
          balance.venueId === request.sell.adapter.venueId &&
          balance.currency.toUpperCase() === marketExchangeBase(request.sell.market).toUpperCase(),
      );
      const reasons: string[] = [];
      if (!quoteBalance || quoteBalance.free.lt(requiredQuote))
        reasons.push('buy_quote_balance_insufficient');
      const baseFreeCanonical = baseBalance
        ? baseBalance.free.mul(marketBaseMultiplier(request.sell.market))
        : ZERO;
      if (!baseBalance || baseFreeCanonical.lt(requiredBase))
        reasons.push('sell_base_balance_insufficient');
      return reasons.length === 0
        ? {
            ok: true,
            buy: venueBalanceBaseline(request.buy, buyBalances),
            sell: venueBalanceBaseline(request.sell, sellBalances),
          }
        : { ok: false, reasons };
    } catch (error) {
      return { ok: false, reasons: [`balance_fetch_failed: ${String(error)}`] };
    }
  }

  private async fetchFreshBook(
    venue: ExecutionVenue,
  ): Promise<
    { ok: true; book: import('@arb/core').OrderBookSnapshot } | { ok: false; reasons: string[] }
  > {
    try {
      const book = await venue.adapter.fetchOrderBook(venue.market.exchangeSymbol, 50);
      const observedAt = this.#clock();
      const validation = validateOrderBook(book, {
        expectedVenueId: venue.adapter.venueId,
        expectedSymbol: venue.market.exchangeSymbol,
        maxAgeMs: this.#settings.maxOrderbookAgeMs,
        now: observedAt,
      });
      return validation.valid
        ? { ok: true, book: validation.book }
        : { ok: false, reasons: validation.reasons };
    } catch (error) {
      return { ok: false, reasons: [`orderbook_fetch_failed: ${String(error)}`] };
    }
  }

  private async reconcileClosedTrade(input: {
    request: LiveExecutionRequest;
    buyBaseline: VenueBalanceBaseline;
    sellBaseline: VenueBalanceBaseline;
    buyBaseFilled: Decimal;
    sellBaseFilled: Decimal;
    buyPrice: Decimal;
    sellPrice: Decimal;
  }): Promise<ClosedTradeAccounting | undefined> {
    const { request } = input;
    if (!request.buy.adapter.fetchBalances || !request.sell.adapter.fetchBalances) {
      return undefined;
    }
    try {
      const [buyRows, sellRows] = await Promise.all([
        request.buy.adapter.fetchBalances(request.buy.credentials),
        request.sell.adapter.fetchBalances(request.sell.credentials),
      ]);
      for (const row of [...buyRows, ...sellRows]) {
        this.#repository.recordBalance(row);
        this.#repository.recordInventorySnapshot({
          venueId: row.venueId,
          accountId: row.accountId,
          asset: row.currency,
          free: row.free,
          used: row.used,
          total: row.total,
          capturedAt: row.fetchedAt,
        });
      }
      const buyBase = findBalance(
        buyRows,
        request.buy.adapter.venueId,
        marketExchangeBase(request.buy.market),
      );
      const buyQuote = findBalance(buyRows, request.buy.adapter.venueId, request.buy.market.quote);
      const sellBase = findBalance(
        sellRows,
        request.sell.adapter.venueId,
        marketExchangeBase(request.sell.market),
      );
      const sellQuote = findBalance(
        sellRows,
        request.sell.adapter.venueId,
        request.sell.market.quote,
      );
      if (!buyBase || !buyQuote || !sellBase || !sellQuote) return undefined;
      if (
        !input.buyBaseline.base ||
        !input.buyBaseline.quote ||
        !input.sellBaseline.base ||
        !input.sellBaseline.quote
      ) {
        return undefined;
      }
      const buyMultiplier = marketBaseMultiplier(request.buy.market);
      const sellMultiplier = marketBaseMultiplier(request.sell.market);
      const buyBaseBefore = input.buyBaseline.base.total.mul(buyMultiplier);
      const buyBaseAfter = buyBase.total.mul(buyMultiplier);
      const sellBaseBefore = input.sellBaseline.base.total.mul(sellMultiplier);
      const sellBaseAfter = sellBase.total.mul(sellMultiplier);
      const buyBaseDelta = buyBaseAfter.minus(buyBaseBefore);
      const sellBaseDelta = sellBaseAfter.minus(sellBaseBefore);
      const buyQuoteDelta = buyQuote.total.minus(input.buyBaseline.quote.total);
      const sellQuoteDelta = sellQuote.total.minus(input.sellBaseline.quote.total);
      const tolerance = Decimal.max(
        new Decimal('0.01'),
        input.buyBaseFilled.mul('0.01'),
        input.sellBaseFilled.mul('0.01'),
      );
      const plausible =
        buyBaseDelta.gt(0) &&
        sellBaseDelta.lt(0) &&
        buyQuoteDelta.lte(0) &&
        sellQuoteDelta.gte(0) &&
        buyBaseDelta.minus(input.buyBaseFilled).abs().lte(tolerance) &&
        sellBaseDelta.plus(input.sellBaseFilled).abs().lte(tolerance);
      if (!plausible) return undefined;
      return accountClosedTrade({
        buyBaseFilled: input.buyBaseFilled,
        sellBaseFilled: input.sellBaseFilled,
        buyPrice: input.buyPrice,
        sellPrice: input.sellPrice,
        buyBaseline: {
          base: buyBaseBefore,
          quote: input.buyBaseline.quote.total,
        },
        buyFinal: { base: buyBaseAfter, quote: buyQuote.total },
        sellBaseline: {
          base: sellBaseBefore,
          quote: input.sellBaseline.quote.total,
        },
        sellFinal: { base: sellBaseAfter, quote: sellQuote.total },
        buyRebatePct: request.buy.feeRebatePct ?? ZERO,
        sellRebatePct: request.sell.feeRebatePct ?? ZERO,
      });
    } catch (error) {
      this.#repository.recordRiskEvent(
        'warning',
        'post_trade_balance_reconciliation_failed',
        'could not reconcile closed trade from balances',
        { batchId: request.batchId, error: String(error) },
      );
      return undefined;
    }
  }

  private async reconcile(
    request: LiveExecutionRequest,
    venue: ExecutionVenue,
    legNumber: 1 | 2,
    submitted?: OrderState,
    baseline?: VenueBalanceBaseline,
    timeInForce?: 'IOC' | 'FOK',
  ): Promise<{ ok: true; order: OrderState } | { ok: false; reason: string }> {
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const query = this.orderQuery(request, venue, legNumber, submitted);
      try {
        const order = await venue.adapter.fetchOrder!(query, venue.credentials);
        this.updatePersistedOrder(request, legNumber, order, `reconcile_query_${attempt + 1}`);
        if (order.status === 'unknown') {
          lastError = `leg${legNumber}_unknown_order_state`;
        } else {
          return { ok: true, order };
        }
      } catch (error) {
        lastError = `leg${legNumber}_reconcile_failed: ${String(error)}`;
        this.recordOrderEvent(request, legNumber, `reconcile_query_${attempt + 1}_error`, {
          query,
          error: String(error),
          attempt: attempt + 1,
        });
      }
      await this.#sleep(250 * (attempt + 1));
    }
    if (submitted && baseline && timeInForce && isOrderNotFoundError(lastError)) {
      const confirmed = await this.confirmNoFillFromBalances(
        request,
        venue,
        legNumber,
        submitted,
        baseline,
      );
      if (confirmed.ok) return confirmed;
      lastError = confirmed.reason;
    }
    this.#repository.updateExecutionLeg(`${request.batchId}-L${legNumber}`, {
      status: 'unknown',
      error: lastError,
    });
    return { ok: false, reason: lastError };
  }

  private async confirmNoFillFromBalances(
    request: LiveExecutionRequest,
    venue: ExecutionVenue,
    legNumber: 1 | 2,
    submitted: OrderState,
    baseline: VenueBalanceBaseline,
  ): Promise<{ ok: true; order: OrderState } | { ok: false; reason: string }> {
    if (!venue.adapter.fetchBalances) {
      return { ok: false, reason: `leg${legNumber}_no_fill_confirmation_unsupported` };
    }
    if (!submitted.filled.eq(0)) {
      return { ok: false, reason: `leg${legNumber}_no_fill_confirmation_has_fill` };
    }
    if ((legNumber === 1 && !baseline.quote) || (legNumber === 2 && !baseline.base)) {
      return { ok: false, reason: `leg${legNumber}_no_fill_confirmation_missing_balance` };
    }
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.#sleep(750);
      try {
        const rows = await venue.adapter.fetchBalances(venue.credentials);
        for (const balance of rows) {
          this.#repository.recordBalance(balance);
          this.#repository.recordInventorySnapshot({
            venueId: balance.venueId,
            accountId: balance.accountId,
            asset: balance.currency,
            free: balance.free,
            used: balance.used,
            total: balance.total,
            capturedAt: balance.fetchedAt,
          });
        }
        const current = venueBalanceBaseline(venue, rows);
        const unchanged =
          sameBalanceValue(baseline.base, current.base) &&
          sameBalanceValue(baseline.quote, current.quote);
        this.#repository.recordAudit(
          'executor',
          'no_fill_balance_check',
          {
            batchId: request.batchId,
            leg: legNumber,
            venueId: venue.adapter.venueId,
            attempt,
            unchanged,
            baselineBase: baseline.base?.total.toFixed() ?? null,
            baselineQuote: baseline.quote?.total.toFixed() ?? null,
            currentBase: current.base?.total.toFixed() ?? null,
            currentQuote: current.quote?.total.toFixed() ?? null,
          },
          this.#clock(),
        );
        if (!unchanged) {
          return { ok: false, reason: `leg${legNumber}_not_found_balance_changed` };
        }
      } catch (error) {
        lastError = `leg${legNumber}_no_fill_balance_query_failed: ${String(error)}`;
      }
    }
    if (lastError) return { ok: false, reason: lastError };

    const order = syntheticNoFillOrder(
      {
        venueOrderId: submitted.venueOrderId,
        clientOrderId: submitted.clientOrderId ?? `${request.batchId}-L${legNumber}`,
        symbol: submitted.symbol,
        side: submitted.side,
        type: submitted.type,
        ...(submitted.price ? { price: submitted.price } : {}),
        amount: submitted.amount,
      },
      'balance_confirmed_no_fill_after_not_found',
    );
    this.updatePersistedOrder(request, legNumber, order, 'balance_confirmed_no_fill');
    this.#repository.recordRiskEvent(
      'warning',
      'order_not_found_confirmed_no_fill',
      'venue did not expose the IOC/FOK order, but balances prove it did not fill or rest',
      {
        batchId: request.batchId,
        leg: legNumber,
        venueId: venue.adapter.venueId,
        venueOrderId: submitted.venueOrderId,
      },
    );
    return { ok: true, order };
  }

  private persistOrder(request: LiveExecutionRequest, leg: 1 | 2, order: OrderState): void {
    this.updatePersistedOrder(request, leg, order, 'submission_response');
  }

  private prepareOrder(
    request: LiveExecutionRequest,
    leg: 1 | 2,
    order: {
      symbol: string;
      side: 'buy' | 'sell';
      type: 'limit';
      amount: Decimal;
      price: Decimal;
      timeInForce: 'IOC' | 'FOK';
      clientOrderId: string;
    },
  ): void {
    const venue = leg === 1 ? request.buy : request.sell;
    const now = this.#clock();
    const executionId = this.#executionIds.get(request.batchId);
    this.#repository.recordOrder({
      venueId: venue.adapter.venueId,
      clientOrderId: order.clientOrderId,
      ...(executionId !== undefined ? { executionId } : {}),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      amount: order.amount,
      filledAmount: ZERO,
      status: 'pending',
      now,
    });
    this.recordOrderEvent(request, leg, 'submission_request', {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      amount: order.amount.toFixed(),
      price: order.price.toFixed(),
      timeInForce: order.timeInForce,
      clientOrderId: order.clientOrderId,
    });
  }

  private markSubmissionUnknown(
    request: LiveExecutionRequest,
    leg: 1 | 2,
    order: {
      symbol: string;
      side: 'buy' | 'sell';
      type: 'limit';
      amount: Decimal;
      price: Decimal;
      timeInForce: 'IOC' | 'FOK';
      clientOrderId: string;
    },
    error: unknown,
  ): void {
    const venue = leg === 1 ? request.buy : request.sell;
    const now = this.#clock();
    const executionId = this.#executionIds.get(request.batchId);
    this.#repository.recordOrder({
      venueId: venue.adapter.venueId,
      clientOrderId: order.clientOrderId,
      ...(executionId !== undefined ? { executionId } : {}),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      amount: order.amount,
      filledAmount: ZERO,
      status: 'unknown',
      now,
    });
    this.recordOrderEvent(request, leg, 'submission_error', {
      error: String(error),
      attempt: 1,
    });
    this.#repository.updateExecutionLeg(`${request.batchId}-L${leg}`, {
      status: 'unknown',
      error: String(error),
    });
  }

  private async cancelRemaining(
    request: LiveExecutionRequest,
    venue: ExecutionVenue,
    leg: 1 | 2,
    order: OrderState,
  ): Promise<{ ok: true; order: OrderState } | { ok: false; reason: string }> {
    if (!order.remaining.gt(0) || order.status !== 'open') return { ok: true, order };
    const query = this.orderQuery(request, venue, leg, order);
    try {
      this.recordOrderEvent(request, leg, 'cancel_request', { query });
      const canceled = await venue.adapter.cancelOrder!(query, venue.credentials);
      this.updatePersistedOrder(request, leg, canceled, 'cancel_response');
    } catch (error) {
      this.recordOrderEvent(request, leg, 'cancel_error', {
        query,
        error: String(error),
      });
      return { ok: false, reason: `leg${leg}_cancel_failed: ${String(error)}` };
    }

    let lastError = `leg${leg}_cancel_not_confirmed`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.#sleep(150 * (attempt + 1));
      try {
        const finalOrder = await venue.adapter.fetchOrder!(query, venue.credentials);
        this.updatePersistedOrder(request, leg, finalOrder, `cancel_confirm_query_${attempt + 1}`);
        if (
          finalOrder.status === 'closed' ||
          finalOrder.status === 'canceled' ||
          finalOrder.status === 'rejected'
        ) {
          return { ok: true, order: finalOrder };
        }
        lastError = `leg${leg}_cancel_not_confirmed:${finalOrder.status}`;
      } catch (error) {
        lastError = `leg${leg}_cancel_confirmation_failed: ${String(error)}`;
        this.recordOrderEvent(request, leg, `cancel_confirm_query_${attempt + 1}_error`, {
          query,
          error: String(error),
          attempt: attempt + 1,
        });
      }
    }
    return { ok: false, reason: lastError };
  }

  private updatePersistedOrder(
    request: LiveExecutionRequest,
    leg: 1 | 2,
    order: OrderState,
    eventType: string,
  ): void {
    const venue = leg === 1 ? request.buy : request.sell;
    const now = this.#clock();
    const clientOrderId = `${request.batchId}-L${leg}`;
    const executionId = this.#executionIds.get(request.batchId);
    this.#repository.recordOrder({
      venueId: venue.adapter.venueId,
      venueOrderId: order.venueOrderId,
      clientOrderId,
      ...(executionId !== undefined ? { executionId } : {}),
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price ?? ZERO,
      amount: order.amount,
      filledAmount: order.filled,
      ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
      ...(order.fee ? { fee: order.fee } : {}),
      status: order.status,
      now,
    });
    this.#repository.recordOrderEvent(
      clientOrderId,
      eventType,
      {
        at: now,
        status: order.status,
        filled: order.filled.toFixed(),
        remaining: order.remaining.toFixed(),
        raw: order.raw,
      },
      now,
    );
    this.#repository.updateExecutionLeg(clientOrderId, {
      status: this.executionLegStatus(order),
      filledAmount: order.filled,
      ...(order.averagePrice ? { averageFillPrice: order.averagePrice } : {}),
      ...(order.fee ? { feePaid: order.fee } : {}),
      orderId: order.venueOrderId,
    });
  }

  private recordOrderEvent(
    request: LiveExecutionRequest,
    leg: 1 | 2,
    eventType: string,
    payload: unknown,
  ): void {
    const now = this.#clock();
    this.#repository.recordOrderEvent(
      `${request.batchId}-L${leg}`,
      eventType,
      { at: now, ...(typeof payload === 'object' && payload ? payload : { value: payload }) },
      now,
    );
  }

  private orderQuery(
    request: LiveExecutionRequest,
    venue: ExecutionVenue,
    leg: 1 | 2,
    order?: OrderState,
  ): OrderQuery {
    const query: OrderQuery = {
      clientOrderId: `${request.batchId}-L${leg}`,
      symbol: venue.market.exchangeSymbol,
    };
    if (order?.venueOrderId) query.venueOrderId = order.venueOrderId;
    return query;
  }

  private executionLegStatus(order: OrderState): string {
    if (order.status === 'closed') {
      return order.filled.gt(0) && order.filled.lt(order.amount) ? 'partial' : 'filled';
    }
    if (order.status === 'canceled') return order.filled.gt(0) ? 'partial' : 'canceled';
    if (order.status === 'rejected') return 'rejected';
    if (order.status === 'open') return order.filled.gt(0) ? 'partial' : 'submitted';
    return 'unknown';
  }

  private recordUnhedgedInventory(
    request: LiveExecutionRequest,
    executionId: number,
    canonicalAmount: Decimal,
    canonicalUnitPrice: Decimal,
    reason: string,
  ): number | undefined {
    return this.recordUnhedgedInventoryAt(
      request,
      executionId,
      request.buy,
      canonicalAmount,
      canonicalUnitPrice,
      reason,
      'long',
    );
  }

  private recordUnhedgedInventoryAt(
    request: LiveExecutionRequest,
    executionId: number,
    venue: ExecutionVenue,
    canonicalAmount: Decimal,
    canonicalUnitPrice: Decimal,
    reason: string,
    direction: 'long' | 'short',
  ): number | undefined {
    if (!canonicalAmount.gt(0)) return undefined;
    const multiplier = marketBaseMultiplier(venue.market);
    const exchangeAmount = exchangeAmountFromCanonical(canonicalAmount, multiplier);
    const usdValue = canonicalAmount.mul(canonicalUnitPrice.gt(0) ? canonicalUnitPrice : ZERO);
    const exchangeBase = marketExchangeBase(venue.market);
    const id = this.#repository.recordUnhedgedInventory({
      executionId,
      batchId: request.batchId,
      venueId: venue.adapter.venueId,
      asset: exchangeBase,
      amount: exchangeAmount,
      usdValue,
      direction,
      reason,
      createdAt: this.#clock(),
    });
    this.#repository.recordRiskEvent(
      'critical',
      'unhedged_inventory',
      reason,
      {
        batchId: request.batchId,
        unhedgedInventoryId: id,
        venueId: venue.adapter.venueId,
        asset: exchangeBase,
        amount: exchangeAmount.toFixed(),
        canonicalAsset: venue.market.base,
        canonicalAmount: canonicalAmount.toFixed(),
        baseMultiplier: multiplier.toFixed(),
        direction,
        usdValue: usdValue.toFixed(),
      },
      this.#clock(),
    );
    return id;
  }

  private conservativePrice(first?: Decimal, second?: Decimal): Decimal {
    const prices = [first, second].filter(
      (price): price is Decimal => price !== undefined && price.gt(0),
    );
    if (prices.length === 0) return ZERO;
    return prices.reduce((lowest, price) => (price.lt(lowest) ? price : lowest));
  }

  private conservativeShortPrice(first?: Decimal, second?: Decimal): Decimal {
    const prices = [first, second].filter(
      (price): price is Decimal => price !== undefined && price.gt(0),
    );
    if (prices.length === 0) return ZERO;
    return prices.reduce((highest, price) => (price.gt(highest) ? price : highest));
  }
}
