import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { assessRotationReadiness, planRotationSeed, type RotationBalances } from '../src/index.js';

const d = (value: string): Decimal => new Decimal(value);

function balances(overrides: Partial<RotationBalances> = {}): RotationBalances {
  return {
    gateBase: d('0'),
    gateQuote: d('100'),
    hotcoinBase: d('10'),
    hotcoinQuote: d('0'),
    ...overrides,
  };
}

describe('two-sided rotation readiness', () => {
  it('allows Gate to Hotcoin when Gate has quote and Hotcoin has base', () => {
    const result = assessRotationReadiness(balances(), {
      buyQuote: d('10'),
      sellBase: d('10'),
    });
    expect(result.state).toBe('READY_GATE_TO_HOT');
    expect(result.gateToHot).toBe(true);
    expect(result.hotToGate).toBe(false);
  });

  it('allows the reverse direction after the first fill', () => {
    const result = assessRotationReadiness(
      balances({
        gateBase: d('10'),
        gateQuote: d('0'),
        hotcoinBase: d('0'),
        hotcoinQuote: d('100'),
      }),
      { buyQuote: d('10'), sellBase: d('10') },
    );
    expect(result.state).toBe('READY_HOTCOIN_TO_GATE');
    expect(result.hotToGate).toBe(true);
  });

  it('reports both ready and wait states without assuming convergence', () => {
    const both = assessRotationReadiness(
      balances({
        gateBase: d('10'),
        gateQuote: d('20'),
        hotcoinBase: d('10'),
        hotcoinQuote: d('20'),
      }),
      { buyQuote: d('10'), sellBase: d('10') },
    );
    expect(both.state).toBe('BOTH_READY');
    const wait = assessRotationReadiness(balances({ gateQuote: d('5'), hotcoinBase: d('5') }), {
      buyQuote: d('10'),
      sellBase: d('10'),
    });
    expect(wait.state).toBe('WAIT');
    expect(wait.reasons).toContain('gate_quote_short');
    expect(wait.reasons).toContain('hotcoin_base_short');
  });
});

describe('rotation seed sizing', () => {
  it('sizes KAT by base quantity and accepts small fee dust', () => {
    const plan = planRotationSeed({
      venue: 'gateio',
      notionalQuote: d('20'),
      ask: d('0.00434'),
      bid: d('0.004328'),
      amountStep: d('0.1'),
      feeBps: d('9.9'),
      feeChargeAsset: 'base',
      maxDustQuote: d('0.01'),
    });
    expect(plan.grossBase.toFixed()).toBe('4608.2');
    expect(plan.residualQuote.lt('0.001')).toBe(true);
    expect(plan.valid).toBe(true);
  });

  it('accepts a clean quote-fee seed', () => {
    const plan = planRotationSeed({
      venue: 'gateio',
      notionalQuote: d('20'),
      ask: d('0.00434'),
      bid: d('0.004328'),
      amountStep: d('0.1'),
      feeBps: d('9.9'),
      feeChargeAsset: 'quote',
      maxDustQuote: d('0.01'),
    });
    expect(plan.netBase.eq(plan.grossBase)).toBe(true);
    expect(plan.residualBase.eq(0)).toBe(true);
    expect(plan.valid).toBe(true);
  });

  it('rejects ULTIMA-sized dust at the small-account limit', () => {
    const plan = planRotationSeed({
      venue: 'gateio',
      notionalQuote: d('20'),
      ask: d('1238.8'),
      bid: d('1232.8'),
      amountStep: d('0.0001'),
      feeBps: d('9.9'),
      feeChargeAsset: 'base',
      maxDustQuote: d('0.01'),
    });
    expect(plan.residualQuote.gt('0.1')).toBe(true);
    expect(plan.valid).toBe(false);
    expect(plan.reasons).toContain('dust_above_limit');
  });
});
