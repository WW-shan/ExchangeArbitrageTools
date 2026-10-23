import { Decimal } from './money.js';
import { alignAmountDown } from './precision.js';
import type { RejectionReason } from './types.js';

export interface NotionalEvaluation {
  conservativeNetProfit: Decimal;
  valid: boolean;
  rejectionReasons: RejectionReason[];
}

export interface NotionalSearchOptions {
  minNotional: Decimal;
  maxNotional: Decimal;
  step?: Decimal;
  samples?: number;
  refineLevels?: number;
  refineSamples?: number;
  evaluate: (notional: Decimal) => NotionalEvaluation;
}

export interface NotionalSearchResult extends NotionalEvaluation {
  notional: Decimal;
  evaluated: number;
  feasible: boolean;
  boundary: 'min' | 'max' | 'interior';
}

interface Candidate {
  notional: Decimal;
  evaluation: NotionalEvaluation;
  feasible: boolean;
}

const SOFT_REJECTIONS: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  'gross_profit_below_threshold',
  'conservative_profit_below_threshold',
]);

const INVALID_PROFIT = new Decimal('-1e30');

export function isSoftRejection(reasons: readonly RejectionReason[]): boolean {
  return reasons.every((reason) => SOFT_REJECTIONS.has(reason));
}

function normalizeBound(value: Decimal, fallback: Decimal): Decimal {
  return value.isFinite() && value.gt(0) ? value : fallback;
}

/**
 * Deterministic bounded search for the notional that maximises conservative net
 * profit. The profit curve of a discrete order-book path is piecewise linear, so
 * a coarse grid followed by local grid refinement is more robust than assuming a
 * smooth concave function. Only profit-threshold rejections count as feasible
 * sizes; depth, inventory, precision, staleness and health failures are hard.
 */
export function searchOptimalNotional(options: NotionalSearchOptions): NotionalSearchResult {
  const step =
    options.step && options.step.isFinite() && options.step.gt(0)
      ? options.step
      : new Decimal('0.01');
  const requestedMin = normalizeBound(options.minNotional, step);
  const requestedMax = normalizeBound(options.maxNotional, requestedMin);
  const maxNotional = requestedMax;
  const minNotional = requestedMin.lte(requestedMax) ? requestedMin : requestedMax;

  const cache = new Map<string, Candidate>();
  let evaluated = 0;
  let bestFeasible: Candidate | undefined;
  let bestOverall: Candidate | undefined;

  const consider = (value: Decimal): Candidate | undefined => {
    const notional = alignAmountDown(value, step);
    if (!notional.isFinite() || notional.lte(0)) return undefined;
    const key = notional.toFixed();
    const cached = cache.get(key);
    if (cached) return cached;
    let evaluation: NotionalEvaluation;
    try {
      evaluation = options.evaluate(notional);
    } catch {
      evaluation = {
        conservativeNetProfit: INVALID_PROFIT,
        valid: false,
        rejectionReasons: ['invalid_request'],
      };
    }
    const feasible = isSoftRejection(evaluation.rejectionReasons);
    const candidate: Candidate = { notional, evaluation, feasible };
    cache.set(key, candidate);
    evaluated += 1;
    if (
      !bestOverall ||
      evaluation.conservativeNetProfit.gt(bestOverall.evaluation.conservativeNetProfit)
    ) {
      bestOverall = candidate;
    }
    if (
      feasible &&
      (!bestFeasible ||
        evaluation.conservativeNetProfit.gt(bestFeasible.evaluation.conservativeNetProfit) ||
        (evaluation.conservativeNetProfit.eq(bestFeasible.evaluation.conservativeNetProfit) &&
          notional.lt(bestFeasible.notional)))
    ) {
      bestFeasible = candidate;
    }
    return candidate;
  };

  const grid = (lo: Decimal, hi: Decimal, count: number): Decimal[] => {
    const values: Decimal[] = [];
    const seen = new Set<string>();
    const push = (value: Decimal): void => {
      const aligned = alignAmountDown(value, step);
      if (!aligned.isFinite() || aligned.lte(0)) return;
      const key = aligned.toFixed();
      if (seen.has(key)) return;
      seen.add(key);
      values.push(aligned);
    };
    push(lo);
    if (hi.gt(lo)) {
      const span = hi.minus(lo);
      const divisions = Math.max(1, Math.floor(count));
      for (let index = 1; index <= divisions; index += 1) {
        push(lo.plus(span.mul(index).div(divisions)));
      }
    }
    return values;
  };

  let values = grid(minNotional, maxNotional, options.samples ?? 16);
  if (values.length === 0) {
    const fallback = alignAmountDown(minNotional, step);
    values = fallback.gt(0) ? [fallback] : [];
  }
  for (const value of values) consider(value);

  const bestIn = (candidates: readonly Decimal[]): Candidate | undefined => {
    let localFeasible: Candidate | undefined;
    let localOverall: Candidate | undefined;
    for (const value of candidates) {
      const candidate = cache.get(value.toFixed());
      if (!candidate) continue;
      if (
        candidate.feasible &&
        (!localFeasible ||
          candidate.evaluation.conservativeNetProfit.gt(
            localFeasible.evaluation.conservativeNetProfit,
          ) ||
          (candidate.evaluation.conservativeNetProfit.eq(
            localFeasible.evaluation.conservativeNetProfit,
          ) &&
            candidate.notional.lt(localFeasible.notional)))
      ) {
        localFeasible = candidate;
      }
      if (
        !localOverall ||
        candidate.evaluation.conservativeNetProfit.gt(localOverall.evaluation.conservativeNetProfit)
      ) {
        localOverall = candidate;
      }
    }
    return localFeasible ?? localOverall;
  };

  const refineLevels = Math.max(0, Math.floor(options.refineLevels ?? 3));
  const refineSamples = Math.max(2, Math.floor(options.refineSamples ?? 10));
  for (let level = 0; level < refineLevels; level += 1) {
    const anchor = bestIn(values);
    if (!anchor) break;
    const index = values.findIndex((value) => value.eq(anchor.notional));
    const lo = index > 0 ? values[index - 1]! : minNotional;
    const hi = index >= 0 && index < values.length - 1 ? values[index + 1]! : maxNotional;
    if (!hi.gt(lo)) break;
    values = grid(lo, hi, refineSamples);
    if (values.length === 0) break;
    for (const value of values) consider(value);
  }

  const chosen = bestFeasible ?? bestOverall;
  if (!chosen) {
    return {
      notional: minNotional,
      conservativeNetProfit: new Decimal(0),
      valid: false,
      rejectionReasons: ['invalid_request'],
      evaluated,
      feasible: false,
      boundary: 'min',
    };
  }
  const boundary: 'min' | 'max' | 'interior' = chosen.notional.lte(minNotional.plus(step))
    ? 'min'
    : chosen.notional.gte(maxNotional.minus(step))
      ? 'max'
      : 'interior';
  return {
    notional: chosen.notional,
    conservativeNetProfit: chosen.evaluation.conservativeNetProfit,
    valid: chosen.evaluation.valid,
    rejectionReasons: chosen.evaluation.rejectionReasons,
    evaluated,
    feasible: chosen.feasible,
    boundary,
  };
}
