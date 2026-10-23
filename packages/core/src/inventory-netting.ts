import { Decimal } from './money.js';

export interface PendingInventory {
  /** Positive = long the base asset, negative = short. */
  signedQty: Decimal;
  averagePrice: Decimal;
}

export interface InventoryFill {
  side: 'buy' | 'sell';
  qty: Decimal;
  price: Decimal;
}

export interface HedgeRules {
  minHedgeNotional: Decimal;
  qtyStep: Decimal;
}

export interface HedgeInstruction {
  side: 'buy' | 'sell';
  qty: Decimal;
  referencePrice: Decimal;
}

export interface NettingResult {
  pending?: PendingInventory;
  realizedPnl: Decimal;
  closedQty: Decimal;
  hedge?: HedgeInstruction;
}

function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.isFinite() || step.lte(0)) return value;
  return value.div(step).floor().mul(step);
}

function ceilToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.isFinite() || step.lte(0)) return value;
  return value.div(step).ceil().mul(step);
}

function hedgeIfLargeEnough(
  pending: PendingInventory,
  referencePrice: Decimal,
  rules: HedgeRules,
): HedgeInstruction | undefined {
  const qty = pending.signedQty.abs();
  if (qty.lte(0) || referencePrice.lte(0)) return undefined;
  if (qty.mul(referencePrice).lt(rules.minHedgeNotional)) return undefined;
  return {
    side: pending.signedQty.gt(0) ? 'sell' : 'buy',
    qty: floorToStep(qty, rules.qtyStep),
    referencePrice,
  };
}

/**
 * Fold an execution fill into pending inventory: same-direction fills accumulate
 * at a size-weighted average, opposite fills net down and book realized PnL.
 * Matches the `inventory.rs` netting model in djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST.
 */
export function applyInventoryFill(
  pending: PendingInventory | undefined,
  fill: InventoryFill,
  rules: HedgeRules,
): NettingResult {
  if (!fill.qty.isFinite() || fill.qty.lte(0)) {
    return {
      ...(pending ? { pending } : {}),
      realizedPnl: new Decimal(0),
      closedQty: new Decimal(0),
    };
  }
  const signed = fill.side === 'buy' ? fill.qty : fill.qty.negated();
  if (!pending || pending.signedQty.eq(0)) {
    const next: PendingInventory = { signedQty: signed, averagePrice: fill.price };
    return {
      pending: next,
      realizedPnl: new Decimal(0),
      closedQty: new Decimal(0),
      ...(hedgeIfLargeEnough(next, fill.price, rules)
        ? { hedge: hedgeIfLargeEnough(next, fill.price, rules)! }
        : {}),
    };
  }

  const sameDirection = pending.signedQty.gt(0) === signed.gt(0);
  if (sameDirection) {
    const oldAbs = pending.signedQty.abs();
    const addAbs = signed.abs();
    const total = oldAbs.plus(addAbs);
    const next: PendingInventory = {
      signedQty: pending.signedQty.plus(signed),
      averagePrice: pending.averagePrice.mul(oldAbs).plus(fill.price.mul(addAbs)).div(total),
    };
    return {
      pending: next,
      realizedPnl: new Decimal(0),
      closedQty: new Decimal(0),
      ...(hedgeIfLargeEnough(next, fill.price, rules)
        ? { hedge: hedgeIfLargeEnough(next, fill.price, rules)! }
        : {}),
    };
  }

  const closedQty = Decimal.min(pending.signedQty.abs(), signed.abs());
  const realizedPnl = pending.signedQty.gt(0)
    ? closedQty.mul(fill.price.minus(pending.averagePrice))
    : closedQty.mul(pending.averagePrice.minus(fill.price));
  const nextSigned = pending.signedQty.plus(signed);
  if (nextSigned.eq(0)) {
    return { realizedPnl, closedQty };
  }
  const next: PendingInventory = {
    signedQty: nextSigned,
    averagePrice: nextSigned.gt(0) === pending.signedQty.gt(0) ? pending.averagePrice : fill.price,
  };
  return {
    pending: next,
    realizedPnl,
    closedQty,
    ...(hedgeIfLargeEnough(next, fill.price, rules)
      ? { hedge: hedgeIfLargeEnough(next, fill.price, rules)! }
      : {}),
  };
}

/**
 * Reduce-only quantity: never exceed the position, round to the venue step, and
 * keep a sub-minimum partial order only when it is a full close.
 */
export function reduceOnlyHedgeQty(
  qty: Decimal,
  position: Decimal,
  rules: HedgeRules,
  limitPrice: Decimal,
): Decimal {
  if (position.eq(0) || qty.lte(0)) return new Decimal(0);
  const absPosition = position.abs();
  const wanted = Decimal.min(qty, absPosition);
  const minQty =
    limitPrice.gt(0) && rules.minHedgeNotional.gt(0)
      ? ceilToStep(rules.minHedgeNotional.div(limitPrice), rules.qtyStep)
      : rules.qtyStep;
  if (wanted.gte(minQty)) return floorToStep(wanted, rules.qtyStep);
  if (wanted.gte(absPosition)) return absPosition;
  return Decimal.min(ceilToStep(minQty, rules.qtyStep), absPosition);
}

export interface LongInventoryRow {
  venueId: string;
  asset: string;
  amount: Decimal;
  usdValue: Decimal;
}

export interface NetInventoryPlan {
  venueId: string;
  asset: string;
  qty: Decimal;
  referencePrice: Decimal;
  hedgeSide: 'sell';
  hedgeQty: Decimal;
}

/**
 * Net long-only S1 unhedged inventory per (venue, asset) and size a reduce-only
 * sell hedge. S1's first leg is always a buy, so open inventory is long.
 */
export function planLongInventoryHedges(
  rows: readonly LongInventoryRow[],
  rules: HedgeRules,
): NetInventoryPlan[] {
  const grouped = new Map<string, { venueId: string; asset: string; qty: Decimal; usd: Decimal }>();
  for (const row of rows) {
    if (!row.amount.isFinite() || row.amount.lte(0)) continue;
    const key = `${row.venueId}|${row.asset.toUpperCase()}`;
    const current = grouped.get(key) ?? {
      venueId: row.venueId,
      asset: row.asset.toUpperCase(),
      qty: new Decimal(0),
      usd: new Decimal(0),
    };
    current.qty = current.qty.plus(row.amount);
    current.usd = current.usd.plus(row.usdValue);
    grouped.set(key, current);
  }
  const plans: NetInventoryPlan[] = [];
  for (const group of grouped.values()) {
    if (group.qty.lte(0)) continue;
    const referencePrice = group.usd.gt(0) ? group.usd.div(group.qty) : new Decimal(0);
    plans.push({
      venueId: group.venueId,
      asset: group.asset,
      qty: group.qty,
      referencePrice,
      hedgeSide: 'sell',
      hedgeQty: reduceOnlyHedgeQty(group.qty, group.qty, rules, referencePrice),
    });
  }
  return plans;
}
