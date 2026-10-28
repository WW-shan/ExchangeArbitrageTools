import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import { accountClosedTrade } from '../src/profit-accounting.js';

function d(value: string): Decimal {
  return new Decimal(value);
}

describe('closed-trade profit accounting', () => {
  it('accounts for base-asset fees and accrued rebates', () => {
    const result = accountClosedTrade({
      buyBaseFilled: d('40'),
      sellBaseFilled: d('40'),
      buyPrice: d('0.23728'),
      sellPrice: d('0.23888'),
      buyBaseline: { base: d('0'), quote: d('20') },
      buyFinal: { base: d('39.9604'), quote: d('10.5088') },
      sellBaseline: { base: d('40.916'), quote: d('10.150402') },
      sellFinal: { base: d('0.916'), quote: d('19.686491') },
      buyRebatePct: d('70'),
      sellRebatePct: d('80'),
    });

    expect(result.grossSpread.toFixed()).toBe('0.064');
    expect(result.buyGrossFeeQuote.toFixed()).toBe('0.009396288');
    expect(result.sellGrossFeeQuote.toFixed()).toBe('0.019111');
    expect(result.grossFeesQuote.toFixed()).toBe('0.028507288');
    expect(result.rebateReceivableQuote.toFixed()).toBe('0.0218662016');
    expect(result.netFeesQuote.toFixed()).toBe('0.0066410864');
    expect(result.cashProfit.toFixed()).toBe('0.035492712');
    expect(result.economicProfit.toFixed()).toBe('0.0573589136');
    expect(result.baseDelta.toFixed()).toBe('-0.0396');
    expect(result.quoteDelta.toFixed()).toBe('0.044889');
  });

  it('accounts for quote-asset fees', () => {
    const result = accountClosedTrade({
      buyBaseFilled: d('10'),
      sellBaseFilled: d('10'),
      buyPrice: d('2'),
      sellPrice: d('2.1'),
      buyBaseline: { base: d('0'), quote: d('100') },
      buyFinal: { base: d('10'), quote: d('79.8') },
      sellBaseline: { base: d('10'), quote: d('0') },
      sellFinal: { base: d('0'), quote: d('20.79') },
      buyRebatePct: d('0'),
      sellRebatePct: d('0'),
    });

    expect(result.grossSpread.toFixed()).toBe('1');
    expect(result.grossFeesQuote.toFixed()).toBe('0.41');
    expect(result.cashProfit.toFixed()).toBe('0.59');
    expect(result.economicProfit.toFixed()).toBe('0.59');
  });
});
