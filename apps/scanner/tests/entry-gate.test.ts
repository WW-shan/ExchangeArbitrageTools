import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import { PercentileEntryGate } from '../src/entry-gate.js';

describe('PercentileEntryGate', () => {
  it('is a no-op when disabled', () => {
    const gate = new PercentileEntryGate({ mode: 'off' });
    const decision = gate.observe('k', new Decimal(1));
    expect(decision.allow).toBe(true);
    expect(gate.stats()).toEqual({ keys: 0, samples: 0 });
  });

  it('admits only edges above the rolling percentile once warmed up', () => {
    let now = 1_000;
    const gate = new PercentileEntryGate({
      mode: 'percentile',
      percentile: 75,
      windowMs: 60_000,
      minSamples: 4,
      clock: () => now,
    });
    for (const value of ['1', '2', '3', '4']) {
      expect(gate.observe('k', new Decimal(value)).allow).toBe(true);
    }
    const below = gate.observe('k', new Decimal('2.5'));
    expect(below.allow).toBe(false);
    expect(below.thresholdBps?.toFixed()).toBe('3');
    const above = gate.observe('k', new Decimal('3.5'));
    expect(above.allow).toBe(true);
    now += 120_000;
    const afterWindow = gate.observe('k', new Decimal('1'));
    expect(afterWindow.allow).toBe(true);
    expect(afterWindow.sampleCount).toBe(0);
  });

  it('bounds memory by key and sample count', () => {
    const gate = new PercentileEntryGate({
      mode: 'percentile',
      minSamples: 2,
      maxSamplesPerKey: 3,
      maxKeys: 2,
      clock: () => 1,
    });
    for (let index = 0; index < 10; index += 1) gate.observe('a', new Decimal(index));
    expect(gate.stats().samples).toBe(3);
    gate.observe('b', new Decimal(1));
    gate.observe('c', new Decimal(1));
    expect(gate.stats().keys).toBe(2);
  });
});
