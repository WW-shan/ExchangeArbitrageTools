import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import { summarizeSpreadSamples, type SpreadSample } from '../src/spread-tracking.js';

function sample(
  direction: string,
  timestamp: number,
  gross: string,
  feeBreakEven: boolean,
  eligible: string | undefined,
): SpreadSample {
  return {
    direction,
    timestamp,
    grossBps: new Decimal(gross),
    netBps: new Decimal(gross).minus(20),
    ...(feeBreakEven ? { maxFeeBreakEvenNotional: new Decimal(50) } : {}),
    ...(eligible ? { maxEligibleNotional: new Decimal(eligible) } : {}),
    bindingReason: eligible ? 'spread_decay' : 'fee_floor',
    flags: [],
  };
}

describe('spread persistence summary', () => {
  it('measures eligible streaks, positive streaks, and time to loss', () => {
    const samples = [
      sample('gateio->hotcoin', 0, '100', true, undefined),
      sample('gateio->hotcoin', 3_000, '100', true, '10'),
      sample('gateio->hotcoin', 6_000, '80', true, '8'),
      sample('gateio->hotcoin', 9_000, '-5', false, undefined),
      sample('gateio->hotcoin', 12_000, '120', true, '12'),
    ];
    const [summary] = summarizeSpreadSamples(samples, 3_000);
    expect(summary?.eligibleSamples).toBe(3);
    expect(summary?.eligibleRatio).toBeCloseTo(3 / 5);
    expect(summary?.maxEligibleNotional?.toFixed()).toBe('12');
    expect(summary?.longestEligibleStreakMs).toBe(6_000);
    expect(summary?.longestPositiveStreakMs).toBe(9_000);
    expect(summary?.firstEligibleAt).toBe(3_000);
    expect(summary?.firstNonEligibleAfterFirstEligibleAt).toBe(9_000);
    expect(summary?.timeToFirstLossAfterEligibleMs).toBe(6_000);
  });

  it('groups directions and ranks by eligible sample count', () => {
    const samples = [
      sample('a->b', 0, '30', false, undefined),
      sample('a->b', 1_000, '40', false, undefined),
      sample('c->d', 0, '10', true, '5'),
      sample('c->d', 1_000, '12', true, '6'),
    ];
    const summaries = summarizeSpreadSamples(samples, 1_000);
    expect(summaries.map((row) => row.direction)).toEqual(['c->d', 'a->b']);
    expect(summaries[0]?.eligibleSamples).toBe(2);
    expect(summaries[1]?.eligibleSamples).toBe(0);
  });
});
