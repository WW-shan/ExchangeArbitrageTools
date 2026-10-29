import { Decimal, ZERO } from './money.js';

export interface RiskLimits {
  maxOrderNotional: Decimal;
  dailyMaxLoss: Decimal;
  maxOpenBatches: number;
  minNetProfitBps: Decimal;
  maxStaleOrderbookMs: number;
  maxSlippageBps: Decimal;
  killSwitchDefault: boolean;
}

export interface BatchPreflight {
  requestedNotional: Decimal;
  expectedNetProfit: Decimal;
  expectedNetProfitBps: Decimal;
  openBatches: number;
  unresolvedUnknownOrders: number;
  dailyRealizedLoss: Decimal;
  dailyRebalanceCost: Decimal;
  unhedgedInventoryRisk: Decimal;
  buyBookAgeMs: number;
  sellBookAgeMs: number;
  buyVenueHealth: string;
  sellVenueHealth: string;
  manualConfirmation: boolean;
  iocOrFokSupported: boolean;
  estimatedSlippageBps?: Decimal;
  feesConfigured: boolean;
  precisionConfigured: boolean;
  balanceMismatch: boolean;
  preparation?: {
    maxCostBps: Decimal;
    maxCostUsd: Decimal;
  };
}

export interface PreflightDecision {
  allowed: boolean;
  reasons: string[];
}

function limitsAreValid(limits: RiskLimits): boolean {
  return (
    limits.maxOrderNotional.isFinite() &&
    limits.maxOrderNotional.gt(0) &&
    limits.dailyMaxLoss.isFinite() &&
    limits.dailyMaxLoss.gte(0) &&
    Number.isInteger(limits.maxOpenBatches) &&
    limits.maxOpenBatches > 0 &&
    limits.minNetProfitBps.isFinite() &&
    limits.minNetProfitBps.gte(0) &&
    Number.isFinite(limits.maxStaleOrderbookMs) &&
    limits.maxStaleOrderbookMs >= 0 &&
    limits.maxSlippageBps.isFinite() &&
    limits.maxSlippageBps.gte(0)
  );
}

export class ExecutionGate {
  #killSwitch: boolean;
  readonly #limits: RiskLimits;

  constructor(limits: RiskLimits) {
    this.#limits = limits;
    this.#killSwitch = limits.killSwitchDefault;
  }

  get killSwitch(): boolean {
    return this.#killSwitch;
  }

  setKillSwitch(active: boolean, reason?: string): void {
    this.#killSwitch = active;
    if (active && reason) this.lastKillReason = reason;
  }

  lastKillReason: string | undefined;

  preflight(check: BatchPreflight): PreflightDecision {
    const reasons: string[] = [];
    if (this.#killSwitch) reasons.push('kill_switch_on');
    if (!limitsAreValid(this.#limits)) reasons.push('risk_limits_invalid');
    if (
      !check.requestedNotional.isFinite() ||
      check.requestedNotional.lte(0) ||
      check.requestedNotional.gt(this.#limits.maxOrderNotional)
    ) {
      reasons.push('notional_outside_limits');
    }
    if (check.preparation) {
      const budget = check.preparation;
      if (
        !check.expectedNetProfit.isFinite() ||
        !check.expectedNetProfitBps.isFinite() ||
        !budget.maxCostBps.isFinite() ||
        budget.maxCostBps.lt(0) ||
        !budget.maxCostUsd.isFinite() ||
        budget.maxCostUsd.lt(0)
      ) {
        reasons.push('preparation_cost_above_limit');
      } else {
        const cost = check.expectedNetProfit.lt(0) ? check.expectedNetProfit.abs() : ZERO;
        if (cost.gt(budget.maxCostUsd) || check.expectedNetProfitBps.lt(budget.maxCostBps.neg())) {
          reasons.push('preparation_cost_above_limit');
        }
      }
    } else {
      if (!check.expectedNetProfit.isFinite() || check.expectedNetProfit.lte(0)) {
        reasons.push('expected_profit_not_positive');
      }
      if (
        !check.expectedNetProfitBps.isFinite() ||
        check.expectedNetProfitBps.lt(this.#limits.minNetProfitBps)
      ) {
        reasons.push('min_profit_below_threshold');
      }
    }
    if (!Number.isInteger(check.openBatches) || check.openBatches < 0) {
      reasons.push('max_open_batches_reached');
    } else if (check.openBatches >= this.#limits.maxOpenBatches) {
      reasons.push('max_open_batches_reached');
    }
    if (!Number.isInteger(check.unresolvedUnknownOrders) || check.unresolvedUnknownOrders < 0) {
      reasons.push('unresolved_unknown_order');
    } else if (check.unresolvedUnknownOrders > 0) {
      reasons.push('unresolved_unknown_order');
    }
    const riskValues = [
      check.dailyRealizedLoss,
      check.dailyRebalanceCost,
      check.unhedgedInventoryRisk,
    ];
    const loss = check.dailyRealizedLoss
      .plus(check.dailyRebalanceCost)
      .plus(check.unhedgedInventoryRisk);
    if (
      riskValues.some((value) => !value.isFinite() || value.lt(0)) ||
      !loss.isFinite() ||
      loss.gte(this.#limits.dailyMaxLoss)
    ) {
      reasons.push('daily_loss_limit_reached');
    }
    if (
      !Number.isFinite(check.buyBookAgeMs) ||
      !Number.isFinite(check.sellBookAgeMs) ||
      check.buyBookAgeMs < 0 ||
      check.sellBookAgeMs < 0 ||
      check.buyBookAgeMs > this.#limits.maxStaleOrderbookMs ||
      check.sellBookAgeMs > this.#limits.maxStaleOrderbookMs
    ) {
      reasons.push('stale_orderbook');
    }
    if (check.buyVenueHealth !== 'A' || check.sellVenueHealth !== 'A') {
      reasons.push('venue_not_execution_eligible');
    }
    if (!check.iocOrFokSupported) reasons.push('ioc_or_fok_unsupported');
    if (
      check.estimatedSlippageBps !== undefined &&
      (!check.estimatedSlippageBps.isFinite() ||
        check.estimatedSlippageBps.lt(0) ||
        check.estimatedSlippageBps.gt(this.#limits.maxSlippageBps))
    ) {
      reasons.push('slippage_too_high');
    }
    if (!check.feesConfigured || !check.precisionConfigured)
      reasons.push('market_metadata_incomplete');
    if (check.balanceMismatch) reasons.push('balance_mismatch');
    if (!check.manualConfirmation) reasons.push('manual_confirmation_required');
    return { allowed: reasons.length === 0, reasons };
  }

  static zero(): Decimal {
    return ZERO;
  }
}
