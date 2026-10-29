import { Decimal, type RotationReadiness, type RotationRequirement } from '@arb/core';
import type { LoadedOpportunity } from '@arb/storage';
import type { PreparationCalibrationEntry, RotationPairConfig } from './config.js';

export type AutoRotationAction = 'EXECUTE' | 'WAIT' | 'BLOCKED';

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

export interface PreparationGateInput {
  calibration?: PreparationCalibrationEntry;
  depthNetBps: Decimal;
  requestedNotional: Decimal;
  costBps: Decimal;
  costUsd: Decimal;
  minReverseProbability: Decimal;
  maxHoldMs: number;
  reversionBandBps: Decimal;
  maxCostBps: Decimal;
  maxCostUsd: Decimal;
  minExpectedValueBps: Decimal;
  minExpectedValueUsd: Decimal;
}

export interface PreparationGateDecision {
  allowed: boolean;
  reasons: string[];
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
  if (input.depthNetBps.gt(input.reversionBandBps)) {
    reasons.push('preparation_not_at_reversion');
  }
  if (input.calibration) {
    if (input.calibration.reverseProbability.lt(input.minReverseProbability)) {
      reasons.push('preparation_reverse_probability_too_low');
    }
    if (input.calibration.medianTimeToReverseMs > input.maxHoldMs) {
      reasons.push('preparation_reverse_time_too_long');
    }
  }
  if (input.costBps.gt(input.maxCostBps) || input.costUsd.gt(input.maxCostUsd)) {
    reasons.push('preparation_cost_above_limit');
  }
  if (reasons.length > 0 || !input.calibration) {
    return { allowed: false, reasons };
  }
  const adjustedExpectedValueBps = input.calibration.expectedValueBps
    .plus(input.calibration.medianPrepCostBps)
    .minus(input.costBps);
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
      adjustedExpectedValueBps,
      adjustedExpectedValueUsd,
    };
  }
  return {
    allowed: true,
    reasons: [],
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
): 'gate->hotcoin' | 'hotcoin->gate' | undefined {
  const { venueBuy, venueSell } = loaded.opportunity;
  if (venueBuy === 'gateio' && venueSell === 'hotcoin') return 'gate->hotcoin';
  if (venueBuy === 'hotcoin' && venueSell === 'gateio') return 'hotcoin->gate';
  return undefined;
}

export function scannerDirectionForRotation(
  direction: 'gate->hotcoin' | 'hotcoin->gate',
): 'gateio->hotcoin' | 'hotcoin->gateio' {
  return direction === 'gate->hotcoin' ? 'gateio->hotcoin' : 'hotcoin->gateio';
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
  const direction = rotationDirection(input.loaded);
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
