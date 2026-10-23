import {
  BatchStateMachine,
  Decimal,
  ExecutionGate,
  ZERO,
  alignAmountDown,
  canonicalAmountFromExchange,
  canonicalMarketForEvaluation,
  canonicalPriceFromExchange,
  calculateSellDepthByBase,
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
import type { ApiCredentials, CexAdapter, OrderQuery, OrderState } from '@arb/venues-cex';

export interface ExecutionVenue {
  adapter: CexAdapter;
  market: MarketMetadata;
  credentials: ApiCredentials;
  healthState: HealthState;
}

export interface LiveExecutionRequest {
  batchId: string;
  opportunity: OpportunityResult;
  opportunityId?: number;
  buy: ExecutionVenue;
  sell: ExecutionVenue;
  confirmedBatchId: string;
}

export type LiveExecutionOutcome =
  'BLOCKED' | 'PREFLIGHT_FAILED' | 'LEG1_REJECTED' | 'CLOSED' | 'SAFE_STOP';

export interface LiveExecutionResult {
  batchId: string;
  outcome: LiveExecutionOutcome;
  state: BatchState;
  states: BatchState[];
  reasons: string[];
  realizedProfit?: Decimal;
  ordersSubmitted: number;
}

export interface CexLiveExecutorOptions {
  repository: ArbitrageRepository;
  gate: ExecutionGate;
  limits: RiskLimits;
  liveEnabled: boolean;
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
  readonly #settings: CexLiveExecutorOptions['settings'];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #clock: () => number;

  constructor(options: CexLiveExecutorOptions) {
    this.#repository = options.repository;
    this.#gate = options.gate;
    this.#liveEnabled = options.liveEnabled;
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

    if (!this.#liveEnabled) {
      reasons.push('live_execution_disabled');
      return outcome('BLOCKED');
    }
    if (request.confirmedBatchId !== request.batchId) {
      reasons.push('manual_confirmation_mismatch');
      return outcome('BLOCKED');
    }
    this.#repository.recordAudit(
      'operator',
      'manual_batch_confirmation',
      {
        batchId: request.batchId,
        confirmedBatchId: request.confirmedBatchId,
        opportunityId: request.opportunityId ?? null,
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
    const buyBookResult = await this.fetchFreshBook(request.buy);
    const sellBookResult = await this.fetchFreshBook(request.sell);
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
    const refreshed = evaluateS1Direction({
      base: buyEvalMarket.base,
      quote: buyEvalMarket.quote,
      buyMarket: buyEvalMarket,
      sellMarket: sellEvalMarket,
      buyBook: buyEvalBook,
      sellBook: sellEvalBook,
      requestedNotional: request.opportunity.requestedNotional,
      settings: this.#settings,
      now: evaluatedAt,
      venueHealth: {
        [request.buy.adapter.venueId]: request.buy.healthState,
        [request.sell.adapter.venueId]: request.sell.healthState,
      },
    });
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
    const plannedBase = refreshed.buyDepth?.executableBaseAmount ?? ZERO;
    const plannedQuote = refreshed.buyDepth?.executableQuoteAmount ?? refreshed.requestedNotional;
    const plannedLeg1Amount = alignAmountDown(
      exchangeAmountFromCanonical(plannedBase, buyMultiplier),
      request.buy.market.amountStep!,
    );
    const plannedLeg2Amount = alignAmountDown(
      exchangeAmountFromCanonical(plannedBase, sellMultiplier),
      request.sell.market.amountStep!,
    );
    if (
      !plannedLeg1Amount.gt(0) ||
      !plannedLeg2Amount.gt(0) ||
      (request.buy.market.minAmount && plannedLeg1Amount.lt(request.buy.market.minAmount)) ||
      (request.sell.market.minAmount && plannedLeg2Amount.lt(request.sell.market.minAmount))
    ) {
      reasons.push('below_min_notional');
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }
    const buyFeeBps = request.buy.market.feeTakerBps ?? ZERO;
    const requiredQuote = plannedQuote.mul(new Decimal(1).plus(buyFeeBps.div(10_000))).mul('1.01');
    const balances = await this.fetchBalances(request, requiredQuote, plannedBase);
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
    });
    if (!decision.allowed) {
      reasons.push(...decision.reasons);
      transition('PREFLIGHT_FAILED');
      return outcome('PREFLIGHT_FAILED');
    }

    const preflight = {
      strategy: 'S1',
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
        requiredBase: plannedBase.toFixed(),
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
      strategy: 'S1',
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
    ordersSubmitted += 1;
    try {
      leg1 = await request.buy.adapter.createOrder!(leg1Request, request.buy.credentials);
      this.persistOrder(request, 1, leg1);
    } catch (error) {
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

    const reconciledLeg1 = await this.reconcile(request, request.buy, 1, leg1);
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
    if (projectedProfit.lte(0)) {
      this.recordUnhedgedInventory(
        request,
        executionId,
        boughtCanonical,
        this.conservativePrice(buyCanonicalAverage, executionSellDepth.averagePrice),
        'post_fill_profit_not_positive',
      );
      return safeStop('post_fill_profit_not_positive');
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
    ordersSubmitted += 1;
    try {
      leg2 = await request.sell.adapter.createOrder!(leg2Request, request.sell.credentials);
      this.persistOrder(request, 2, leg2);
    } catch (error) {
      this.markSubmissionUnknown(request, 2, leg2Request, error);
      this.#repository.updateExecutionStatus(executionId, 'LEG2_UNKNOWN');
      transition('LEG2_UNKNOWN');
      const recovered = await this.reconcile(request, request.sell, 2);
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

    const reconciledLeg2 = await this.reconcile(request, request.sell, 2, leg2);
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
    const sellFeeActual = second.fee ?? ZERO;
    const sellProceeds = (second.averagePrice ?? sellExecutionPrice).mul(second.filled);
    const realized = sellProceeds.minus(sellFeeActual).minus(buyCost);
    const grossSpread = sellProceeds.minus((first.averagePrice ?? leg1Price).mul(first.filled));
    const fees = buyFee.plus(sellFeeActual);
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
        baseDelta: boughtCanonical
          .minus(canonicalAmountFromExchange(second.filled, sellMultiplier))
          .toFixed(),
        quoteAsset: request.buy.market.quote,
        quoteDelta: realized.toFixed(),
      },
      metadata: {
        states: [...states],
        outcome: 'CLOSED',
        leg1Filled: first.filled.toFixed(),
        leg2Filled: second.filled.toFixed(),
        leg1CanonicalFilled: boughtCanonical.toFixed(),
        leg2CanonicalFilled: canonicalAmountFromExchange(second.filled, sellMultiplier).toFixed(),
        buyExchangeBase: marketExchangeBase(request.buy.market),
        sellExchangeBase: marketExchangeBase(request.sell.market),
        buyBaseMultiplier: buyMultiplier.toFixed(),
        sellBaseMultiplier: sellMultiplier.toFixed(),
        leg1AveragePrice: first.averagePrice?.toFixed() ?? null,
        leg2AveragePrice: second.averagePrice?.toFixed() ?? null,
      },
    });
    if (realized.lt(0)) this.#repository.addRealizedLoss(realized.abs(), closedAt);
    return outcome('CLOSED', realized);
  }

  readonly #executionIds = new Map<string, number>();

  private async fetchBalances(
    request: LiveExecutionRequest,
    requiredQuote: Decimal,
    requiredBase: Decimal,
  ): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
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
      return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
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

  private async reconcile(
    request: LiveExecutionRequest,
    venue: ExecutionVenue,
    legNumber: 1 | 2,
    submitted?: OrderState,
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
    this.#repository.updateExecutionLeg(`${request.batchId}-L${legNumber}`, {
      status: 'unknown',
      error: lastError,
    });
    return { ok: false, reason: lastError };
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
    if (!canonicalAmount.gt(0)) return undefined;
    const multiplier = marketBaseMultiplier(request.buy.market);
    const exchangeAmount = exchangeAmountFromCanonical(canonicalAmount, multiplier);
    const usdValue = canonicalAmount.mul(canonicalUnitPrice.gt(0) ? canonicalUnitPrice : ZERO);
    const exchangeBase = marketExchangeBase(request.buy.market);
    const id = this.#repository.recordUnhedgedInventory({
      executionId,
      batchId: request.batchId,
      venueId: request.buy.adapter.venueId,
      asset: exchangeBase,
      amount: exchangeAmount,
      usdValue,
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
        venueId: request.buy.adapter.venueId,
        asset: exchangeBase,
        amount: exchangeAmount.toFixed(),
        canonicalAsset: request.buy.market.base,
        canonicalAmount: canonicalAmount.toFixed(),
        baseMultiplier: multiplier.toFixed(),
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
}
