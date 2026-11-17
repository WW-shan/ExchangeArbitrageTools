import { describe, expect, it } from 'vitest';
import { computeClosedS1Accounting } from '../src/trade-accounting-repair.js';

describe('closed S1 accounting repair', () => {
  it('values a base-asset buy fee in quote instead of subtracting its raw amount', () => {
    const accounting = computeClosedS1Accounting([
      {
        side: 'buy',
        symbol: 'WARD/USDT',
        filledAmount: '3105',
        averagePrice: '0.00161',
        price: '0.00161',
        fee: '3.105',
        feeCurrency: 'WARD',
      },
      {
        side: 'sell',
        symbol: 'WARD/USDT',
        filledAmount: '3105',
        averagePrice: '0.001622',
        price: '0.001622',
        fee: '0.0049859469',
        feeCurrency: 'USDT',
      },
    ]);
    expect(accounting.grossSpread.toFixed(5)).toBe('0.03726');
    expect(accounting.buyFeeQuote.toFixed(8)).toBe('0.00499905');
    expect(accounting.sellFeeQuote.toFixed(10)).toBe('0.0049859469');
    expect(accounting.netFeesQuote.toFixed(10)).toBe('0.0099849969');
    expect(accounting.realizedProfit.toFixed(10)).toBe('0.0272750031');
    expect(accounting.baseDelta.toFixed()).toBe('-3.105');
    expect(accounting.quoteDelta.toFixed(10)).toBe('0.0272750031');
  });

  it('accepts quote-asset fees without changing them', () => {
    const accounting = computeClosedS1Accounting([
      {
        side: 'buy',
        symbol: 'WARD/USDT',
        filledAmount: '1000',
        averagePrice: '0.002',
        price: '0.002',
        fee: '0.002',
        feeCurrency: 'USDT',
      },
      {
        side: 'sell',
        symbol: 'WARD/USDT',
        filledAmount: '1000',
        averagePrice: '0.0021',
        price: '0.0021',
        fee: '0.0021',
        feeCurrency: 'USDT',
      },
    ]);
    expect(accounting.grossSpread.toFixed()).toBe('0.1');
    expect(accounting.netFeesQuote.toFixed()).toBe('0.0041');
    expect(accounting.realizedProfit.toFixed()).toBe('0.0959');
    expect(accounting.baseDelta.toFixed()).toBe('0');
  });

  it('fails closed on an unsupported fee currency', () => {
    expect(() =>
      computeClosedS1Accounting([
        {
          side: 'buy',
          symbol: 'WARD/USDT',
          filledAmount: '1000',
          averagePrice: '0.002',
          price: '0.002',
          fee: '0.01',
          feeCurrency: 'BGB',
        },
        {
          side: 'sell',
          symbol: 'WARD/USDT',
          filledAmount: '1000',
          averagePrice: '0.0021',
          price: '0.0021',
          fee: '0.0021',
          feeCurrency: 'USDT',
        },
      ]),
    ).toThrow(/unsupported fee currency/);
  });
});
