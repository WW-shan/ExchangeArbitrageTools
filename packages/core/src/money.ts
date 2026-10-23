import { Decimal } from 'decimal.js';

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -30,
  toExpPos: 40,
});

export { Decimal };

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const TEN_THOUSAND = new Decimal(10_000);

export function dec(value: Decimal.Value): Decimal {
  if (value === '') {
    throw new Error('empty numeric value');
  }
  const result = new Decimal(value);
  if (!result.isFinite()) {
    throw new Error(`non-finite numeric value: ${String(value)}`);
  }
  return result;
}

export function decimalString(value: Decimal.Value): string {
  return dec(value).toFixed();
}

export function bps(value: Decimal.Value): Decimal {
  return dec(value).div(TEN_THOUSAND);
}

export function maxDecimal(...values: Decimal[]): Decimal {
  if (values.length === 0) {
    throw new Error('maxDecimal requires at least one value');
  }
  return values.reduce((max, value) => (value.gt(max) ? value : max));
}

export function minDecimal(...values: Decimal[]): Decimal {
  if (values.length === 0) {
    throw new Error('minDecimal requires at least one value');
  }
  return values.reduce((min, value) => (value.lt(min) ? value : min));
}

export function isPositive(value: Decimal): boolean {
  return value.isFinite() && value.gt(0);
}

export function calculateSafetyBuffer(
  notional: Decimal.Value,
  safetyBufferBps: Decimal.Value,
  minProfitUsd: Decimal.Value,
): Decimal {
  return maxDecimal(dec(minProfitUsd), dec(notional).mul(bps(safetyBufferBps)));
}

export function calculateNetProfitBps(netProfit: Decimal, notional: Decimal): Decimal {
  if (!notional.gt(0)) {
    return ZERO;
  }
  return netProfit.div(notional).mul(TEN_THOUSAND);
}
