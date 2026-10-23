import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import {
  impliedProfitFloorBps,
  missingFeeOverrideVenues,
  summarizeReadiness,
} from '../src/readiness.js';

describe('readiness helpers', () => {
  it('computes the implied profit floor in bps', () => {
    expect(impliedProfitFloorBps(new Decimal('0.25'), new Decimal('30')).toFixed(2)).toBe('83.33');
    expect(impliedProfitFloorBps(new Decimal('0.005'), new Decimal('10')).toFixed(2)).toBe('5.00');
    expect(impliedProfitFloorBps(new Decimal('0.25'), new Decimal('0')).toFixed(2)).toBe('0.00');
  });

  it('lists enabled venues without an explicit taker fee', () => {
    const fees = { gateio: { takerBps: new Decimal(2) }, mexc: {} };
    expect(missingFeeOverrideVenues(['gateio', 'mexc', 'weex'], fees)).toEqual(['mexc', 'weex']);
  });

  it('summarizes blocked and warning checks', () => {
    const summary = summarizeReadiness([
      { id: 'a', level: 'pass', detail: '' },
      { id: 'b', level: 'warn', detail: '' },
      { id: 'c', level: 'block', detail: '' },
    ]);
    expect(summary.liveTestReady).toBe(false);
    expect(summary.blocked).toEqual(['c']);
    expect(summary.warnings).toEqual(['b']);
  });
});
