import { Decimal, ZERO } from './money.js';
import { alignAmountDown } from './precision.js';
import type { FeeChargeAsset } from './types.js';

export type RotationDirection = 'gate->hotcoin' | 'hotcoin->gate';

export type RotationState =
  'READY_GATE_TO_HOT' | 'READY_HOTCOIN_TO_GATE' | 'BOTH_READY' | 'WAIT' | 'BLOCKED';

export interface RotationBalances {
  gateBase: Decimal;
  gateQuote: Decimal;
  hotcoinBase: Decimal;
  hotcoinQuote: Decimal;
}

export interface RotationRequirement {
  buyQuote: Decimal;
  sellBase: Decimal;
}

export interface RotationReadiness {
  state: RotationState;
  gateToHot: boolean;
  hotToGate: boolean;
  reasons: string[];
}

function validBalance(value: Decimal, label: string): string | undefined {
  if (!value.isFinite() || value.lt(0)) return `${label}_invalid`;
  return undefined;
}

/**
 * Derive the only direction that is actually funded. A two-sided rotation
 * deliberately starts with quote on one venue and base on the other; the
 * reverse direction becomes funded after a fill.
 */
export function assessRotationReadiness(
  balances: RotationBalances,
  requirement: RotationRequirement,
): RotationReadiness {
  const reasons = [
    validBalance(balances.gateBase, 'gate_base'),
    validBalance(balances.gateQuote, 'gate_quote'),
    validBalance(balances.hotcoinBase, 'hotcoin_base'),
    validBalance(balances.hotcoinQuote, 'hotcoin_quote'),
    validBalance(requirement.buyQuote, 'buy_quote'),
    validBalance(requirement.sellBase, 'sell_base'),
  ].filter((reason): reason is string => reason !== undefined);
  if (reasons.length > 0) {
    return { state: 'BLOCKED', gateToHot: false, hotToGate: false, reasons };
  }

  const gateToHot =
    balances.gateQuote.gte(requirement.buyQuote) && balances.hotcoinBase.gte(requirement.sellBase);
  const hotToGate =
    balances.hotcoinQuote.gte(requirement.buyQuote) && balances.gateBase.gte(requirement.sellBase);
  if (gateToHot && hotToGate) {
    return { state: 'BOTH_READY', gateToHot, hotToGate, reasons };
  }
  if (gateToHot) {
    return { state: 'READY_GATE_TO_HOT', gateToHot, hotToGate, reasons };
  }
  if (hotToGate) {
    return { state: 'READY_HOTCOIN_TO_GATE', gateToHot, hotToGate, reasons };
  }
  if (balances.gateQuote.gt(0) && balances.gateBase.gt(0)) reasons.push('gate_two_sided');
  if (balances.hotcoinQuote.gt(0) && balances.hotcoinBase.gt(0)) reasons.push('hotcoin_two_sided');
  if (balances.gateQuote.lt(requirement.buyQuote)) reasons.push('gate_quote_short');
  if (balances.hotcoinBase.lt(requirement.sellBase)) reasons.push('hotcoin_base_short');
  if (balances.hotcoinQuote.lt(requirement.buyQuote)) reasons.push('hotcoin_quote_short');
  if (balances.gateBase.lt(requirement.sellBase)) reasons.push('gate_base_short');
  return { state: 'WAIT', gateToHot, hotToGate, reasons };
}

export interface RotationSeedInput {
  venue: string;
  notionalQuote: Decimal;
  ask: Decimal;
  bid: Decimal;
  amountStep: Decimal;
  feeBps: Decimal;
  feeChargeAsset?: FeeChargeAsset;
  minNotional?: Decimal;
  maxDustQuote?: Decimal;
}

export interface RotationSeedPlan {
  venue: string;
  grossBase: Decimal;
  buyFeeBase: Decimal;
  netBase: Decimal;
  residualBase: Decimal;
  residualQuote: Decimal;
  quoteRequired: Decimal;
  valid: boolean;
  reasons: string[];
}

/**
 * Size a seed buy by base quantity. A quote-sized market order is deliberately
 * not used because its base result is arbitrary and often not step-aligned.
 */
export function planRotationSeed(input: RotationSeedInput): RotationSeedPlan {
  const reasons: string[] = [];
  const invalid =
    !input.notionalQuote.isFinite() ||
    input.notionalQuote.lte(0) ||
    !input.ask.isFinite() ||
    input.ask.lte(0) ||
    !input.bid.isFinite() ||
    input.bid.lte(0) ||
    !input.amountStep.isFinite() ||
    input.amountStep.lte(0) ||
    !input.feeBps.isFinite() ||
    input.feeBps.lt(0);
  if (invalid) {
    return {
      venue: input.venue,
      grossBase: ZERO,
      buyFeeBase: ZERO,
      netBase: ZERO,
      residualBase: ZERO,
      residualQuote: ZERO,
      quoteRequired: ZERO,
      valid: false,
      reasons: ['invalid_request'],
    };
  }

  const grossBase = alignAmountDown(input.notionalQuote.div(input.ask), input.amountStep);
  const feeRate = input.feeBps.div(10_000);
  const feeInBase = input.feeChargeAsset !== 'quote';
  const buyFeeBase = feeInBase ? grossBase.mul(feeRate) : ZERO;
  const netBase = Decimal.max(0, grossBase.minus(buyFeeBase));
  const sellableBase = alignAmountDown(netBase, input.amountStep);
  const residualBase = netBase.minus(sellableBase);
  const residualQuote = residualBase.mul(input.bid);
  const quoteRequired = grossBase.mul(input.ask).mul(new Decimal(1).plus(feeInBase ? 0 : feeRate));

  if (!grossBase.gt(0)) reasons.push('below_min_amount');
  if (input.minNotional && grossBase.mul(input.ask).lt(input.minNotional)) {
    reasons.push('below_min_notional');
  }
  if (residualBase.gt(0)) {
    reasons.push('buy_fee_residual');
    if (input.maxDustQuote !== undefined && residualQuote.gt(input.maxDustQuote)) {
      reasons.push('dust_above_limit');
    }
  }
  const hardFailure = reasons.some(
    (reason) =>
      reason === 'invalid_request' ||
      reason === 'below_min_amount' ||
      reason === 'below_min_notional' ||
      reason === 'dust_above_limit',
  );
  return {
    venue: input.venue,
    grossBase,
    buyFeeBase,
    netBase,
    residualBase,
    residualQuote,
    quoteRequired,
    valid: !hardFailure,
    reasons,
  };
}
