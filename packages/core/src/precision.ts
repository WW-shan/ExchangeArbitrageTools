import { Decimal } from './money.js';

export interface PrecisionRules {
  amountStep?: Decimal;
  priceStep?: Decimal;
  amountPrecision?: number;
  pricePrecision?: number;
}

function stepFromPrecision(precision: number | undefined): Decimal | undefined {
  if (precision === undefined) return undefined;
  if (!Number.isInteger(precision) || precision < 0 || precision > 30) {
    throw new Error(`invalid precision: ${precision}`);
  }
  return new Decimal(10).pow(-precision);
}

export function resolveStep(rules: PrecisionRules): {
  amountStep: Decimal;
  priceStep: Decimal;
} {
  const amountStep =
    rules.amountStep ?? stepFromPrecision(rules.amountPrecision) ?? new Decimal('1e-8');
  const priceStep =
    rules.priceStep ?? stepFromPrecision(rules.pricePrecision) ?? new Decimal('1e-8');
  if (!amountStep.isFinite() || amountStep.lte(0)) {
    throw new Error('amountStep must be positive and finite');
  }
  if (!priceStep.isFinite() || priceStep.lte(0)) {
    throw new Error('priceStep must be positive and finite');
  }
  return { amountStep, priceStep };
}

export function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.gt(0)) throw new Error('step must be positive');
  return value.div(step).floor().mul(step);
}

export function ceilToStep(value: Decimal, step: Decimal): Decimal {
  if (!step.gt(0)) throw new Error('step must be positive');
  return value.div(step).ceil().mul(step);
}

export function alignPriceDown(price: Decimal, step: Decimal): Decimal {
  return floorToStep(price, step);
}

export function alignAmountDown(amount: Decimal, step: Decimal): Decimal {
  return floorToStep(amount, step);
}

export function isAligned(value: Decimal, step: Decimal): boolean {
  return value.div(step).isInteger();
}

/** Smallest decimal step on which every supplied venue step is aligned. */
export function commonAmountStep(...steps: Decimal[]): Decimal {
  const valid = steps.filter((step) => step.isFinite() && step.gt(0));
  if (valid.length === 0) throw new Error('at least one positive step is required');
  const scale = Math.max(...valid.map((step) => step.decimalPlaces()));
  const factor = new Decimal(10).pow(scale);
  const units = valid.map((step) => BigInt(step.mul(factor).toFixed(0)));
  const gcd = (left: bigint, right: bigint): bigint =>
    right === 0n ? left : gcd(right, left % right);
  const lcm = units.reduce((left, right) => (left / gcd(left, right)) * right);
  return new Decimal(lcm.toString()).div(factor);
}

export function alignToCommonAmountStep(amount: Decimal, ...steps: Decimal[]): Decimal {
  if (steps.length === 0) return amount;
  return alignAmountDown(amount, commonAmountStep(...steps));
}
