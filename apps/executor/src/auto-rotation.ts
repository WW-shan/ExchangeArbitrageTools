import {
  Decimal,
  type RotationBalances,
  type RotationReadiness,
  type RotationRequirement,
} from '@arb/core';
import type { RebalanceTarget } from '@arb/core';
import type { LoadedOpportunity } from '@arb/storage';
import type {
  PreparationCalibrationEntry,
  RotationPairConfig,
  TransferAllowlistEntry,
} from './config.js';

export type AutoRotationAction = 'EXECUTE' | 'WAIT' | 'BLOCKED';

export type RotationVenuePair = readonly [string, string];

export function rotationVenues(pair?: { venues?: RotationVenuePair }): [string, string] {
  return pair?.venues ? [pair.venues[0], pair.venues[1]] : ['gateio', 'hotcoin'];
}

export function venuesForRotationDirection(
  direction: 'gate->hotcoin' | 'hotcoin->gate',
  pair?: { venues?: RotationVenuePair },
): [string, string] {
  const [venueA, venueB] = rotationVenues(pair);
  return direction === 'gate->hotcoin' ? [venueA, venueB] : [venueB, venueA];
}

export interface AutoRotationDecisionInput {
  loaded: LoadedOpportunity;
  ageMs: number;
  pair: RotationPairConfig | undefined;
  readiness: RotationReadiness;
  liveEnabled: boolean;
  autoExecutionEnabled: boolean;
  persistedAutoExecutionEnabled: boolean;
  killSwitch: boolean;
  openExecutions: number;
  unresolvedOrders: number;
  alreadyExecuted: boolean;
  dailyRealizedLoss: Decimal;
  dailyMaxLoss: Decimal;
  maxOrderNotional: Decimal;
  maxSignalAgeMs: number;
  lastAttemptAt?: number;
  now: number;
  cooldownMs: number;
}

export interface AutoRotationDecision {
  action: AutoRotationAction;
  reasons: string[];
  direction?: 'gate->hotcoin' | 'hotcoin->gate';
}

export interface RotationRebalanceTargetsInput {
  direction: 'gate->hotcoin' | 'hotcoin->gate';
  base: string;
  quote: string;
  balances: RotationBalances;
  requirement: RotationRequirement;
  venues?: RotationVenuePair;
  withdrawFees?: Readonly<Record<string, Decimal>>;
}

export function rotationRebalanceTargets(input: RotationRebalanceTargetsInput): RebalanceTarget[] {
  const base = input.base.trim().toUpperCase();
  const quote = input.quote.trim().toUpperCase();
  const [venueA, venueB] = rotationVenues(input);
  const targets: RebalanceTarget[] = [];
  const move = (
    asset: string,
    fromVenue: string,
    toVenue: string,
    need: Decimal,
    sourceBalance: Decimal,
    destinationBalance: Decimal,
  ): void => {
    if (!need.isFinite() || need.lte(0)) return;
    const fee = input.withdrawFees?.[`${fromVenue}:${asset}`] ?? new Decimal(0);
    const gross = need.plus(fee);
    targets.push(
      {
        venueId: fromVenue,
        currency: asset,
        targetFree: Decimal.max(0, sourceBalance.minus(gross)),
      },
      {
        venueId: toVenue,
        currency: asset,
        targetFree: destinationBalance.plus(need),
      },
    );
  };

  if (input.direction === 'gate->hotcoin') {
    move(
      quote,
      venueB,
      venueA,
      Decimal.max(0, input.requirement.buyQuote.minus(input.balances.gateQuote)),
      input.balances.hotcoinQuote,
      input.balances.gateQuote,
    );
    move(
      base,
      venueA,
      venueB,
      Decimal.max(0, input.requirement.sellBase.minus(input.balances.hotcoinBase)),
      input.balances.gateBase,
      input.balances.hotcoinBase,
    );
  } else {
    move(
      quote,
      venueA,
      venueB,
      Decimal.max(0, input.requirement.buyQuote.minus(input.balances.hotcoinQuote)),
      input.balances.gateQuote,
      input.balances.hotcoinQuote,
    );
    move(
      base,
      venueB,
      venueA,
      Decimal.max(0, input.requirement.sellBase.minus(input.balances.gateBase)),
      input.balances.hotcoinBase,
      input.balances.gateBase,
    );
  }
  return targets;
}

export type AutoRebalanceAction = 'PLAN_MANUAL' | 'EXECUTE_AUTOMATIC' | 'WAIT' | 'BLOCKED';

export interface AutoRebalanceGateInput {
  transfersEnabled: boolean;
  releaseMode: 'manual' | 'automatic';
  autoReleaseArmed: boolean;
  openExecutions: number;
  unresolvedOrders: number;
  activeTransferBatches: number;
  signalAgeMs: number;
  maxSignalAgeMs: number;
  expectedTransferCostUsd: Decimal | undefined;
  maxCostUsd: Decimal;
  minNetEdgeBps: Decimal;
  conservativeNetProfit: Decimal;
  requestedNotional: Decimal;
  expectedArrivalMs: number | undefined;
  maxArrivalMs: number;
}

export interface AutoRebalanceGateDecision {
  action: AutoRebalanceAction;
  reasons: string[];
}

export function decideAutoRebalance(input: AutoRebalanceGateInput): AutoRebalanceGateDecision {
  if (!input.transfersEnabled) return { action: 'WAIT', reasons: ['transfers_disabled'] };
  if (input.openExecutions > 0) return { action: 'WAIT', reasons: ['open_execution'] };
  if (input.unresolvedOrders > 0) return { action: 'WAIT', reasons: ['unresolved_order'] };
  if (input.activeTransferBatches > 0) {
    return { action: 'WAIT', reasons: ['active_transfer'] };
  }
  if (input.signalAgeMs > input.maxSignalAgeMs) {
    return { action: 'WAIT', reasons: ['stale_signal'] };
  }
  if (!input.expectedTransferCostUsd) {
    return { action: 'WAIT', reasons: ['transfer_cost_unknown'] };
  }
  if (!input.expectedArrivalMs) {
    return { action: 'WAIT', reasons: ['expected_arrival_unknown'] };
  }
  if (input.expectedArrivalMs > input.maxArrivalMs) {
    return { action: 'WAIT', reasons: ['arrival_too_slow'] };
  }
  if (input.expectedTransferCostUsd.gt(input.maxCostUsd)) {
    return { action: 'BLOCKED', reasons: ['transfer_cost_above_cap'] };
  }
  const minimumRemaining = input.requestedNotional.mul(input.minNetEdgeBps).div(10_000);
  if (input.conservativeNetProfit.lt(input.expectedTransferCostUsd.plus(minimumRemaining))) {
    return { action: 'WAIT', reasons: ['transfer_cost_above_expected_edge'] };
  }
  if (input.releaseMode === 'manual') return { action: 'PLAN_MANUAL', reasons: ['manual_release'] };
  if (!input.autoReleaseArmed) {
    return { action: 'BLOCKED', reasons: ['auto_release_not_armed'] };
  }
  return { action: 'EXECUTE_AUTOMATIC', reasons: [] };
}

export interface RotationRebalanceEstimateInput {
  direction: 'gate->hotcoin' | 'hotcoin->gate';
  base: string;
  quote: string;
  balances: RotationBalances;
  requirement: RotationRequirement;
  venues?: RotationVenuePair;
  allowlist: readonly TransferAllowlistEntry[];
  assetPricesUsd: Readonly<Record<string, Decimal>>;
}

export interface RotationRebalanceEstimateLeg {
  asset: string;
  fromVenue: string;
  toVenue: string;
  amount: Decimal;
  fee?: Decimal;
  feeMode?: 'deducted' | 'added' | 'unknown';
  expectedArrivalMs?: number;
  costUsd?: Decimal;
}

export interface RotationRebalanceEstimate {
  legs: RotationRebalanceEstimateLeg[];
  withdrawFees: Record<string, Decimal>;
  totalCostUsd?: Decimal;
  expectedArrivalMs?: number;
  reasons: string[];
}

export function estimateRotationRebalance(
  input: RotationRebalanceEstimateInput,
): RotationRebalanceEstimate {
  const base = input.base.trim().toUpperCase();
  const quote = input.quote.trim().toUpperCase();
  const [venueA, venueB] = rotationVenues(input);
  const moves: Array<{ asset: string; fromVenue: string; toVenue: string; amount: Decimal }> = [];
  if (input.direction === 'gate->hotcoin') {
    const quoteNeed = input.requirement.buyQuote.minus(input.balances.gateQuote);
    if (quoteNeed.gt(0)) {
      moves.push({ asset: quote, fromVenue: venueB, toVenue: venueA, amount: quoteNeed });
    }
    const baseNeed = input.requirement.sellBase.minus(input.balances.hotcoinBase);
    if (baseNeed.gt(0)) {
      moves.push({ asset: base, fromVenue: venueA, toVenue: venueB, amount: baseNeed });
    }
  } else {
    const quoteNeed = input.requirement.buyQuote.minus(input.balances.hotcoinQuote);
    if (quoteNeed.gt(0)) {
      moves.push({ asset: quote, fromVenue: venueA, toVenue: venueB, amount: quoteNeed });
    }
    const baseNeed = input.requirement.sellBase.minus(input.balances.gateBase);
    if (baseNeed.gt(0)) {
      moves.push({ asset: base, fromVenue: venueB, toVenue: venueA, amount: baseNeed });
    }
  }

  const reasons: string[] = [];
  const withdrawFees: Record<string, Decimal> = {};
  const legs: RotationRebalanceEstimateLeg[] = [];
  let totalCostUsd = new Decimal(0);
  let costKnown = true;
  let expectedArrivalMs = 0;
  let arrivalKnown = true;
  for (const move of moves) {
    const candidates = input.allowlist.filter(
      (entry) =>
        entry.fromVenue === move.fromVenue &&
        entry.toVenue === move.toVenue &&
        entry.asset === move.asset,
    );
    if (candidates.length !== 1) {
      reasons.push(candidates.length === 0 ? 'allowlist_missing' : 'allowlist_network_ambiguous');
      costKnown = false;
      arrivalKnown = false;
      legs.push({ ...move });
      continue;
    }
    const entry = candidates[0]!;
    const price = input.assetPricesUsd[move.asset];
    let costUsd: Decimal | undefined;
    if (entry.withdrawFee !== undefined && price) {
      costUsd = entry.withdrawFee.mul(price);
      totalCostUsd = totalCostUsd.plus(costUsd);
      withdrawFees[`${move.fromVenue}:${move.asset}`] = entry.withdrawFee;
    } else {
      costKnown = false;
      reasons.push(
        entry.withdrawFee === undefined ? 'withdraw_fee_unknown' : 'asset_price_unknown',
      );
    }
    if (entry.expectedArrivalMs === undefined) {
      arrivalKnown = false;
      reasons.push('expected_arrival_unknown');
    } else {
      expectedArrivalMs = Math.max(expectedArrivalMs, entry.expectedArrivalMs);
    }
    legs.push({
      ...move,
      ...(entry.withdrawFee !== undefined ? { fee: entry.withdrawFee } : {}),
      ...(entry.feeMode ? { feeMode: entry.feeMode } : {}),
      ...(entry.expectedArrivalMs !== undefined
        ? { expectedArrivalMs: entry.expectedArrivalMs }
        : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }
  return {
    legs,
    withdrawFees,
    ...(costKnown ? { totalCostUsd } : {}),
    ...(arrivalKnown ? { expectedArrivalMs } : {}),
    reasons: [...new Set(reasons)],
  };
}

export interface PreparationGateInput {
  calibration?: PreparationCalibrationEntry;
  requestedNotional: Decimal;
  costBps: Decimal;
  minReverseProbability: Decimal;
  maxHoldMs: number;
  minExpectedValueBps: Decimal;
  minExpectedValueUsd: Decimal;
}

export interface PreparationGateDecision {
  allowed: boolean;
  reasons: string[];
  breakEvenCostBps?: Decimal;
  adjustedExpectedValueBps?: Decimal;
  adjustedExpectedValueUsd?: Decimal;
}

/**
 * The preparation is a small inventory shift, not a promise that the spread
 * will return. It is allowed only when the historical calibration says the
 * reverse opportunity arrived often enough, soon enough, and with enough edge
 * to pay for this specific preparation cost.
 */
export function evaluatePreparationGate(input: PreparationGateInput): PreparationGateDecision {
  const reasons: string[] = [];
  if (!input.calibration) reasons.push('preparation_calibration_missing');
  if (input.calibration) {
    if (input.costBps.gt(input.calibration.prepBandBps)) {
      reasons.push('preparation_cost_above_calibrated_band');
    }
    if (input.calibration.reverseProbability.lt(input.minReverseProbability)) {
      reasons.push('preparation_reverse_probability_too_low');
    }
    if (input.calibration.medianTimeToReverseMs > input.maxHoldMs) {
      reasons.push('preparation_reverse_time_too_long');
    }
  }
  if (reasons.length > 0 || !input.calibration) {
    return { allowed: false, reasons };
  }
  const breakEvenCostBps = input.calibration.expectedValueBps.plus(
    input.calibration.medianPrepCostBps,
  );
  const adjustedExpectedValueBps = breakEvenCostBps.minus(input.costBps);
  const adjustedExpectedValueUsd = input.requestedNotional
    .mul(adjustedExpectedValueBps)
    .div(10_000);
  if (
    adjustedExpectedValueBps.lt(input.minExpectedValueBps) ||
    adjustedExpectedValueUsd.lt(input.minExpectedValueUsd)
  ) {
    return {
      allowed: false,
      reasons: ['preparation_expected_value_too_low'],
      breakEvenCostBps,
      adjustedExpectedValueBps,
      adjustedExpectedValueUsd,
    };
  }
  return {
    allowed: true,
    reasons: [],
    breakEvenCostBps,
    adjustedExpectedValueBps,
    adjustedExpectedValueUsd,
  };
}

export function rotationPairKey(instrumentKey: string): string {
  return instrumentKey.trim().toUpperCase();
}

export function rotationPairConfig(
  pairs: readonly RotationPairConfig[],
  instrumentKey: string,
): RotationPairConfig | undefined {
  const key = rotationPairKey(instrumentKey);
  return pairs.find((pair) => `${pair.base}/${pair.quote}` === key);
}

export function rotationDirection(
  loaded: LoadedOpportunity,
  pair?: { venues?: RotationVenuePair },
): 'gate->hotcoin' | 'hotcoin->gate' | undefined {
  const { venueBuy, venueSell } = loaded.opportunity;
  const [venueA, venueB] = rotationVenues(pair);
  if (venueBuy === venueA && venueSell === venueB) return 'gate->hotcoin';
  if (venueBuy === venueB && venueSell === venueA) return 'hotcoin->gate';
  return undefined;
}

export function scannerDirectionForRotation(
  direction: 'gate->hotcoin' | 'hotcoin->gate',
  pair?: { venues?: RotationVenuePair },
): string {
  const [venueBuy, venueSell] = venuesForRotationDirection(direction, pair);
  return `${venueBuy}->${venueSell}`;
}

/**
 * Cheap funded-direction pre-check used before the executor refreshes the
 * books and balances. The executor still performs the authoritative sizing.
 */
export function rotationRequirementFromOpportunity(
  loaded: LoadedOpportunity,
  bufferBps = 0,
): RotationRequirement | undefined {
  const opportunity = loaded.opportunity;
  const worstBuyPrice = new Decimal(opportunity.metadata?.buyDepthWorstPrice ?? '0');
  if (!worstBuyPrice.isFinite() || worstBuyPrice.lte(0)) return undefined;
  const buffer = new Decimal(1).plus(new Decimal(Math.max(0, bufferBps)).div(10_000));
  return {
    buyQuote: opportunity.requestedNotional.mul(buffer),
    // The scanner already caps notional by the sell venue's free base. Do not
    // inflate the base requirement here or a fully funded rotation will wait
    // forever by a few basis points. The executor re-sizes from fresh books.
    sellBase: opportunity.requestedNotional.div(worstBuyPrice),
  };
}

export function decideAutoRotation(input: AutoRotationDecisionInput): AutoRotationDecision {
  const reasons: string[] = [];
  if (!input.liveEnabled) reasons.push('config_live_disabled');
  if (!input.autoExecutionEnabled) reasons.push('auto_execution_disabled');
  if (!input.persistedAutoExecutionEnabled) reasons.push('persisted_auto_execution_disabled');
  if (input.killSwitch) reasons.push('kill_switch_on');
  if (input.openExecutions > 0) reasons.push('open_execution');
  if (input.unresolvedOrders > 0) reasons.push('unresolved_order');
  if (input.alreadyExecuted) reasons.push('opportunity_already_executed');
  if (!input.pair) reasons.push('pair_not_whitelisted');
  if (input.ageMs > input.maxSignalAgeMs) reasons.push('stale_signal');
  if (
    input.loaded.opportunity.requestedNotional.gt(input.pair?.maxNotional ?? input.maxOrderNotional)
  ) {
    reasons.push('notional_above_pair_limit');
  }
  if (input.loaded.opportunity.requestedNotional.gt(input.maxOrderNotional)) {
    reasons.push('notional_above_global_limit');
  }
  if (input.dailyRealizedLoss.gte(input.dailyMaxLoss)) reasons.push('daily_loss_limit');
  if (input.lastAttemptAt !== undefined && input.now - input.lastAttemptAt < input.cooldownMs) {
    reasons.push('cooldown');
  }
  const direction = rotationDirection(input.loaded, input.pair);
  if (!direction) reasons.push('venue_route_not_supported');
  if (reasons.length > 0)
    return { action: 'BLOCKED', reasons, ...(direction ? { direction } : {}) };

  if (input.readiness.state === 'BLOCKED') {
    return {
      action: 'BLOCKED',
      reasons: ['inventory_blocked', ...input.readiness.reasons],
      ...(direction ? { direction } : {}),
    };
  }
  if (direction === 'gate->hotcoin' && !input.readiness.gateToHot) {
    return {
      action: 'WAIT',
      reasons: ['direction_not_funded', ...input.readiness.reasons],
      direction,
    };
  }
  if (direction === 'hotcoin->gate' && !input.readiness.hotToGate) {
    return {
      action: 'WAIT',
      reasons: ['direction_not_funded', ...input.readiness.reasons],
      direction,
    };
  }
  return { action: 'EXECUTE', reasons: [], direction: direction! };
}
