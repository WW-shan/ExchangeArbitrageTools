import { Decimal, ZERO } from './money.js';
import { BatchStateMachine, type BatchState } from './state-machine.js';
import { ExecutionGate, type BatchPreflight, type RiskLimits } from './risk.js';
import { calculateBuyDepthByBase, calculateSellDepthByBase } from './depth.js';
import { alignAmountDown, isAligned } from './precision.js';
import type { MarketMetadata, OpportunityResult, OrderBookSnapshot } from './types.js';

export type PaperFillKind = 'full' | 'partial' | 'zero' | 'reject' | 'unknown';

export interface PaperFillScenario {
  kind: PaperFillKind;
  fillRatio?: Decimal;
}

export interface PaperScenarios {
  leg1: PaperFillScenario;
  leg2: PaperFillScenario;
}

export interface PaperOrderRequest {
  clientOrderId: string;
  batchId: string;
  leg: 1 | 2;
  venueId: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: Decimal;
  price: Decimal;
  expectedAveragePrice: Decimal;
  feeBps: Decimal;
}

export interface PaperOrderResult {
  clientOrderId: string;
  venueOrderId: string;
  status: 'filled' | 'partial' | 'rejected' | 'unknown';
  requestedAmount: Decimal;
  filledAmount: Decimal;
  averagePrice: Decimal;
  fee: Decimal;
}

export class ScriptedPaperGateway {
  readonly #scenarios: PaperScenarios;
  readonly #orders = new Map<string, { request: PaperOrderRequest; result: PaperOrderResult }>();
  duplicateSubmitAttempts = 0;
  submitCount = 0;

  constructor(scenarios: PaperScenarios) {
    this.#scenarios = scenarios;
  }

  async submit(request: PaperOrderRequest): Promise<PaperOrderResult> {
    const existing = this.#orders.get(request.clientOrderId);
    if (existing) {
      this.duplicateSubmitAttempts += 1;
      return existing.result;
    }
    this.submitCount += 1;
    const scenario = request.leg === 1 ? this.#scenarios.leg1 : this.#scenarios.leg2;
    const ratio =
      scenario.kind === 'full'
        ? new Decimal(1)
        : scenario.kind === 'partial'
          ? (scenario.fillRatio ?? new Decimal('0.5'))
          : new Decimal(0);
    if (ratio.lt(0) || ratio.gt(1)) throw new Error('paper fill ratio must be between 0 and 1');
    const filledAmount = request.amount.mul(ratio);
    const fee = request.expectedAveragePrice.mul(filledAmount).mul(request.feeBps).div(10_000);
    const status: PaperOrderResult['status'] =
      scenario.kind === 'reject'
        ? 'rejected'
        : scenario.kind === 'unknown'
          ? 'unknown'
          : scenario.kind === 'zero'
            ? 'rejected'
            : scenario.kind === 'partial'
              ? 'partial'
              : 'filled';
    const result: PaperOrderResult = {
      clientOrderId: request.clientOrderId,
      venueOrderId: `paper-${request.clientOrderId}`,
      status,
      requestedAmount: request.amount,
      filledAmount,
      averagePrice: request.expectedAveragePrice,
      fee,
    };
    this.#orders.set(request.clientOrderId, { request, result });
    return result;
  }

  async query(clientOrderId: string): Promise<PaperOrderResult | undefined> {
    return this.#orders.get(clientOrderId)?.result;
  }

  getSubmittedOrders(): PaperOrderRequest[] {
    return [...this.#orders.values()].map((entry) => entry.request);
  }
}

export interface PaperRunOptions {
  batchId: string;
  buyMarket: MarketMetadata;
  sellMarket: MarketMetadata;
  buyBook: OrderBookSnapshot;
  sellBook: OrderBookSnapshot;
  riskLimits: RiskLimits;
  gate: ExecutionGate;
  now: number;
  health: { buy: 'A' | 'B' | 'C' | 'D'; sell: 'A' | 'B' | 'C' | 'D' };
  manualConfirmation?: boolean;
  maxFillDeviationBps?: Decimal;
}

export interface PaperRunResult {
  batchId: string;
  state: BatchState;
  states: BatchState[];
  closed: boolean;
  safeMode: boolean;
  safeModeReason?: string;
  leg1Submitted: boolean;
  leg2Submitted: boolean;
  filledBaseAmount: Decimal;
  buyCost: Decimal;
  sellProceeds: Decimal;
  fees: Decimal;
  realizedProfit: Decimal;
  duplicateSubmitAttempts: number;
  operatorActionRequired: boolean;
  leg1Fill?: {
    requestedAmount: Decimal;
    filledAmount: Decimal;
    averagePrice: Decimal;
    limitPrice: Decimal;
    fee: Decimal;
    status: PaperOrderResult['status'];
  };
  leg2Fill?: {
    requestedAmount: Decimal;
    filledAmount: Decimal;
    averagePrice: Decimal;
    limitPrice: Decimal;
    fee: Decimal;
    status: PaperOrderResult['status'];
  };
}

function executionPreflight(
  opportunity: OpportunityResult,
  options: PaperRunOptions,
): BatchPreflight {
  const feeConfigured = (value: Decimal | undefined): boolean =>
    value !== undefined && value.isFinite() && value.gte(0);
  return {
    requestedNotional: opportunity.requestedNotional,
    expectedNetProfit: opportunity.conservativeNetProfit,
    expectedNetProfitBps: opportunity.netProfitBps,
    openBatches: 0,
    unresolvedUnknownOrders: 0,
    dailyRealizedLoss: ZERO,
    dailyRebalanceCost: ZERO,
    unhedgedInventoryRisk: ZERO,
    buyBookAgeMs: Math.max(0, options.now - options.buyBook.fetchedAt),
    sellBookAgeMs: Math.max(0, options.now - options.sellBook.fetchedAt),
    buyVenueHealth: options.health.buy,
    sellVenueHealth: options.health.sell,
    manualConfirmation: options.manualConfirmation ?? true,
    iocOrFokSupported: Boolean(
      (options.buyMarket.supportsIoc || options.buyMarket.supportsFok) &&
      (options.sellMarket.supportsIoc || options.sellMarket.supportsFok),
    ),
    feesConfigured:
      feeConfigured(options.buyMarket.feeTakerBps) && feeConfigured(options.sellMarket.feeTakerBps),
    precisionConfigured: Boolean(
      options.buyMarket.amountStep &&
      options.sellMarket.amountStep &&
      options.buyMarket.priceStep &&
      options.sellMarket.priceStep,
    ),
    balanceMismatch: false,
  };
}

function isPartial(result: PaperOrderResult): boolean {
  return result.filledAmount.gt(0) && result.filledAmount.lt(result.requestedAmount);
}

export async function runPaperBatch(
  opportunity: OpportunityResult,
  gateway: ScriptedPaperGateway,
  options: PaperRunOptions,
): Promise<PaperRunResult> {
  const machine = new BatchStateMachine();
  const result: PaperRunResult = {
    batchId: options.batchId,
    state: 'IDLE',
    states: [],
    closed: false,
    safeMode: false,
    leg1Submitted: false,
    leg2Submitted: false,
    filledBaseAmount: ZERO,
    buyCost: ZERO,
    sellProceeds: ZERO,
    fees: ZERO,
    realizedProfit: ZERO,
    duplicateSubmitAttempts: 0,
    operatorActionRequired: false,
  };
  const setState = (to: BatchState): void => {
    machine.transition(to);
    result.state = machine.state;
    result.states = [...machine.history];
  };
  const safeStop = (reason: string): void => {
    if (!result.safeMode) setState('SAFE_STOP');
    result.safeMode = true;
    result.safeModeReason = reason;
    result.operatorActionRequired = true;
  };

  setState('OPPORTUNITY_FOUND');
  setState('PREFLIGHT_CHECK');
  if (!opportunity.valid) {
    setState('PREFLIGHT_FAILED');
    result.safeModeReason = 'invalid_opportunity';
    result.operatorActionRequired = true;
    return result;
  }

  const baseAmount = opportunity.buyDepth?.executableBaseAmount;
  const buyPrice = opportunity.expectedBuyPrice;
  const sellPrice = opportunity.expectedSellPrice;
  if (!baseAmount || !buyPrice || !sellPrice || !baseAmount.gt(0)) {
    setState('PREFLIGHT_FAILED');
    result.safeModeReason = 'missing_executable_depth';
    result.operatorActionRequired = true;
    return result;
  }
  if (
    !options.buyMarket.priceStep ||
    !options.sellMarket.priceStep ||
    !isAligned(buyPrice, options.buyMarket.priceStep) ||
    !isAligned(sellPrice, options.sellMarket.priceStep)
  ) {
    setState('PREFLIGHT_FAILED');
    result.safeModeReason = 'execution_price_not_aligned';
    result.operatorActionRequired = true;
    return result;
  }

  const decision = options.gate.preflight(executionPreflight(opportunity, options));
  if (!decision.allowed) {
    setState('PREFLIGHT_FAILED');
    result.safeModeReason = decision.reasons.join(',');
    result.operatorActionRequired = true;
    return result;
  }

  setState('LEG1_SUBMITTING');
  const leg1 = await gateway.submit({
    clientOrderId: `${options.batchId}-L1`,
    batchId: options.batchId,
    leg: 1,
    venueId: options.buyMarket.venueId,
    symbol: options.buyMarket.exchangeSymbol,
    side: 'buy',
    amount: baseAmount,
    price: buyPrice,
    expectedAveragePrice: opportunity.buyDepth!.averagePrice,
    feeBps: options.buyMarket.feeTakerBps!,
  });
  result.leg1Submitted = true;
  result.leg1Fill = {
    requestedAmount: leg1.requestedAmount,
    filledAmount: leg1.filledAmount,
    averagePrice: leg1.averagePrice,
    limitPrice: buyPrice,
    fee: leg1.fee,
    status: leg1.status,
  };
  if (leg1.status === 'rejected') {
    setState('LEG1_REJECTED');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  if (leg1.status === 'unknown') {
    setState('LEG1_UNKNOWN');
    options.gate.setKillSwitch(true, 'unknown order outcome');
    safeStop('unknown_leg1_order');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  setState('LEG1_RECONCILING');
  if (leg1.filledAmount.lte(0)) {
    setState('CLOSED');
    result.closed = true;
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  if (isPartial(leg1)) {
    setState('LEG1_PARTIAL');
    safeStop('partial_leg1_fill');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  setState('HEDGE_DECISION');

  const leg2Amount = alignAmountDown(leg1.filledAmount, options.sellMarket.amountStep!);
  if (!leg2Amount.gt(0)) {
    safeStop('leg2_below_minimum');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  const actualBuy = calculateBuyDepthByBase(options.buyBook, leg1.filledAmount);
  const actualSell = calculateSellDepthByBase(options.sellBook, leg2Amount);
  if (actualBuy.insufficientDepth || actualSell.insufficientDepth) {
    safeStop('insufficient_hedge_depth');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  const buyCost = actualBuy.executableQuoteAmount.plus(leg1.fee);
  const projectedSellProceeds = actualSell.executableQuoteAmount.minus(
    actualSell.executableQuoteAmount.mul(options.sellMarket.feeTakerBps!).div(10_000),
  );
  const projectedProfit = projectedSellProceeds.minus(buyCost);
  if (projectedProfit.lte(0)) {
    safeStop('post_fill_profit_not_positive');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  if (options.sellMarket.minAmount && leg2Amount.lt(options.sellMarket.minAmount)) {
    safeStop('leg2_below_minimum');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  if (
    options.sellMarket.minNotional &&
    actualSell.executableQuoteAmount.lt(options.sellMarket.minNotional)
  ) {
    safeStop('leg2_below_minimum');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }

  setState('LEG2_SUBMITTING');
  const leg2 = await gateway.submit({
    clientOrderId: `${options.batchId}-L2`,
    batchId: options.batchId,
    leg: 2,
    venueId: options.sellMarket.venueId,
    symbol: options.sellMarket.exchangeSymbol,
    side: 'sell',
    amount: leg2Amount,
    price: sellPrice,
    expectedAveragePrice: actualSell.averagePrice,
    feeBps: options.sellMarket.feeTakerBps!,
  });
  result.leg2Submitted = true;
  result.leg2Fill = {
    requestedAmount: leg2.requestedAmount,
    filledAmount: leg2.filledAmount,
    averagePrice: leg2.averagePrice,
    limitPrice: sellPrice,
    fee: leg2.fee,
    status: leg2.status,
  };
  if (leg2.status === 'rejected') {
    setState('LEG2_REJECTED');
    options.gate.setKillSwitch(true, 'second leg rejected');
    safeStop('leg2_rejected');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  if (leg2.status === 'unknown') {
    setState('LEG2_UNKNOWN');
    options.gate.setKillSwitch(true, 'unknown second leg outcome');
    safeStop('unknown_leg2_order');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  setState('LEG2_RECONCILING');
  if (isPartial(leg2)) {
    setState('LEG2_PARTIAL');
    safeStop('partial_leg2_fill');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  if (leg2.filledAmount.lte(0)) {
    setState('LEG2_REJECTED');
    options.gate.setKillSwitch(true, 'second leg unfilled');
    safeStop('leg2_unfilled');
    result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
    return result;
  }
  setState('CLOSED');
  result.closed = true;
  result.filledBaseAmount = leg1.filledAmount;
  result.buyCost = buyCost;
  result.sellProceeds = actualSell.executableQuoteAmount;
  result.fees = leg1.fee.plus(leg2.fee);
  result.realizedProfit = actualSell.executableQuoteAmount.minus(leg2.fee).minus(buyCost);
  result.duplicateSubmitAttempts = gateway.duplicateSubmitAttempts;
  return result;
}

export function defaultPaperRiskLimits(maxNotional = new Decimal(30)): RiskLimits {
  return {
    maxOrderNotional: maxNotional,
    dailyMaxLoss: new Decimal(20),
    maxOpenBatches: 1,
    minNetProfitBps: new Decimal(20),
    maxStaleOrderbookMs: 3000,
    maxSlippageBps: new Decimal(50),
    killSwitchDefault: false,
  };
}

export function createPaperGate(maxNotional = new Decimal(30)): ExecutionGate {
  return new ExecutionGate(defaultPaperRiskLimits(maxNotional));
}
