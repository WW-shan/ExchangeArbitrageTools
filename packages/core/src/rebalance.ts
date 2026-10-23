import { Decimal, ZERO, bps } from './money.js';

export interface BalancePosition {
  venueId: string;
  currency: string;
  free: Decimal;
}

export interface RebalanceTarget {
  venueId: string;
  currency: string;
  targetFree: Decimal;
}

export interface RebalanceOptions {
  minTransferAmount?: Decimal;
  costBps?: Decimal;
}

export interface RebalanceTransfer {
  currency: string;
  fromVenue: string;
  toVenue: string;
  amount: Decimal;
  estimatedCost: Decimal;
}

export interface RebalanceShortfall {
  currency: string;
  venueId: string;
  missing: Decimal;
}

export interface RebalancePlan {
  transfers: RebalanceTransfer[];
  shortfalls: RebalanceShortfall[];
  totalEstimatedCost: Decimal;
}

function requireNonNegative(value: Decimal, label: string): void {
  if (!value.isFinite() || value.lt(0)) throw new Error(`${label} must be finite and non-negative`);
}

/**
 * Read-only inventory rebalance planner. It computes the minimal greedy set of
 * same-currency transfers needed to move each venue toward its target free
 * balance. It never signs, transfers, or withdraws anything.
 */
export function planRebalance(
  positions: readonly BalancePosition[],
  targets: readonly RebalanceTarget[],
  options: RebalanceOptions = {},
): RebalancePlan {
  const minTransfer = options.minTransferAmount ?? ZERO;
  const costRate = bps(options.costBps ?? ZERO);
  requireNonNegative(minTransfer, 'minTransferAmount');

  const currencies = [...new Set(targets.map((target) => target.currency.trim().toUpperCase()))];
  const transfers: RebalanceTransfer[] = [];
  const shortfalls: RebalanceShortfall[] = [];
  let totalEstimatedCost = ZERO;

  for (const currency of currencies) {
    const current = new Map<string, Decimal>();
    for (const position of positions) {
      if (position.currency.trim().toUpperCase() !== currency) continue;
      requireNonNegative(position.free, `balance ${position.venueId}/${currency}`);
      current.set(position.venueId, (current.get(position.venueId) ?? ZERO).plus(position.free));
    }
    const desired = new Map<string, Decimal>();
    for (const target of targets) {
      if (target.currency.trim().toUpperCase() !== currency) continue;
      requireNonNegative(target.targetFree, `target ${target.venueId}/${currency}`);
      desired.set(target.venueId, (desired.get(target.venueId) ?? ZERO).plus(target.targetFree));
    }

    const surplus: Array<{ venueId: string; amount: Decimal }> = [];
    const deficit: Array<{ venueId: string; amount: Decimal }> = [];
    for (const [venueId, targetAmount] of desired) {
      const delta = (current.get(venueId) ?? ZERO).minus(targetAmount);
      if (delta.gt(0)) surplus.push({ venueId, amount: delta });
      else if (delta.lt(0)) deficit.push({ venueId, amount: delta.negated() });
    }
    surplus.sort((left, right) => right.amount.comparedTo(left.amount));
    deficit.sort((left, right) => right.amount.comparedTo(left.amount));

    for (const need of deficit) {
      let remaining = need.amount;
      for (const supply of surplus) {
        if (remaining.lte(0)) break;
        if (supply.amount.lte(0)) continue;
        const amount = Decimal.min(remaining, supply.amount);
        if (amount.lt(minTransfer)) continue;
        const estimatedCost = amount.mul(costRate);
        transfers.push({
          currency,
          fromVenue: supply.venueId,
          toVenue: need.venueId,
          amount,
          estimatedCost,
        });
        totalEstimatedCost = totalEstimatedCost.plus(estimatedCost);
        supply.amount = supply.amount.minus(amount);
        remaining = remaining.minus(amount);
      }
      if (remaining.gt(0)) {
        shortfalls.push({ currency, venueId: need.venueId, missing: remaining });
      }
    }
  }

  return { transfers, shortfalls, totalEstimatedCost };
}
