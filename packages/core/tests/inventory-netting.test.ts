import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/money.js';
import {
  applyInventoryFill,
  planLongInventoryHedges,
  reduceOnlyHedgeQty,
} from '../src/inventory-netting.js';

const rules = { minHedgeNotional: new Decimal(10), qtyStep: new Decimal('0.1') };

describe('inventory netting', () => {
  it('accumulates same-direction fills at a size-weighted average', () => {
    const result = applyInventoryFill(
      { signedQty: new Decimal(10), averagePrice: new Decimal(2) },
      { side: 'buy', qty: new Decimal(10), price: new Decimal(3) },
      rules,
    );
    expect(result.pending?.signedQty.toFixed()).toBe('20');
    expect(result.pending?.averagePrice.toFixed()).toBe('2.5');
  });

  it('nets opposite fills and books realized PnL', () => {
    const result = applyInventoryFill(
      { signedQty: new Decimal(10), averagePrice: new Decimal(2) },
      { side: 'sell', qty: new Decimal(4), price: new Decimal(3) },
      rules,
    );
    expect(result.pending?.signedQty.toFixed()).toBe('6');
    expect(result.realizedPnl.toFixed()).toBe('4');
    expect(result.closedQty.toFixed()).toBe('4');
  });

  it('flips direction and resets the average price', () => {
    const result = applyInventoryFill(
      { signedQty: new Decimal(10), averagePrice: new Decimal(2) },
      { side: 'sell', qty: new Decimal(15), price: new Decimal(3) },
      rules,
    );
    expect(result.pending?.signedQty.toFixed()).toBe('-5');
    expect(result.pending?.averagePrice.toFixed()).toBe('3');
    expect(result.realizedPnl.toFixed()).toBe('10');
  });

  it('emits a hedge once the net notional clears the minimum', () => {
    const result = applyInventoryFill(
      undefined,
      { side: 'buy', qty: new Decimal(10), price: new Decimal(2) },
      rules,
    );
    expect(result.hedge?.side).toBe('sell');
    expect(result.hedge?.qty.toFixed()).toBe('10');
  });

  it('clamps reduce-only quantity to the position and supports full closes', () => {
    expect(
      reduceOnlyHedgeQty(new Decimal(10), new Decimal(5), rules, new Decimal(2)).toFixed(),
    ).toBe('5');
    expect(
      reduceOnlyHedgeQty(new Decimal(5), new Decimal(5), rules, new Decimal(2)).toFixed(),
    ).toBe('5');
  });

  it('nets long inventory by venue and asset', () => {
    const plans = planLongInventoryHedges(
      [
        { venueId: 'gateio', asset: 'cake', amount: new Decimal(10), usdValue: new Decimal(20) },
        { venueId: 'gateio', asset: 'CAKE', amount: new Decimal(5), usdValue: new Decimal(10) },
        { venueId: 'mexc', asset: 'BTC', amount: new Decimal(0.1), usdValue: new Decimal(8000) },
      ],
      rules,
    );
    expect(plans).toHaveLength(2);
    expect(plans.find((plan) => plan.asset === 'CAKE')?.qty.toFixed()).toBe('15');
    expect(plans.find((plan) => plan.asset === 'CAKE')?.hedgeSide).toBe('sell');
  });
});
