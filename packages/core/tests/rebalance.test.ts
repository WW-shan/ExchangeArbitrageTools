import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { planRebalance } from '../src/rebalance.js';

describe('rebalance planner', () => {
  const positions = [
    { venueId: 'gateio', currency: 'USDT', free: new Decimal(1000) },
    { venueId: 'mexc', currency: 'USDT', free: new Decimal(100) },
    { venueId: 'weex', currency: 'USDT', free: new Decimal(0) },
  ];
  const targets = [
    { venueId: 'gateio', currency: 'USDT', targetFree: new Decimal(500) },
    { venueId: 'mexc', currency: 'USDT', targetFree: new Decimal(500) },
    { venueId: 'weex', currency: 'USDT', targetFree: new Decimal(100) },
  ];

  it('computes greedy same-currency transfers and cost', () => {
    const plan = planRebalance(positions, targets, { costBps: new Decimal(10) });
    expect(
      plan.transfers.map((row) => `${row.fromVenue}->${row.toVenue}:${row.amount.toFixed()}`),
    ).toEqual(['gateio->mexc:400', 'gateio->weex:100']);
    expect(plan.totalEstimatedCost.toFixed()).toBe('0.5');
    expect(plan.shortfalls).toEqual([]);
  });

  it('skips transfers below the minimum and reports the shortfall', () => {
    const plan = planRebalance(positions, targets, {
      minTransferAmount: new Decimal(150),
    });
    expect(plan.transfers).toHaveLength(1);
    expect(plan.transfers[0]!.toVenue).toBe('mexc');
    expect(plan.shortfalls).toEqual([
      { currency: 'USDT', venueId: 'weex', missing: new Decimal(100) },
    ]);
  });

  it('rejects negative balances or targets', () => {
    expect(() =>
      planRebalance([{ venueId: 'gateio', currency: 'USDT', free: new Decimal(-1) }], targets),
    ).toThrow(/non-negative/);
    expect(() =>
      planRebalance(positions, [
        { venueId: 'gateio', currency: 'USDT', targetFree: new Decimal(-1) },
      ]),
    ).toThrow(/non-negative/);
  });
});
