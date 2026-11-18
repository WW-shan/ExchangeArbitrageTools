import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/money.js';
import { RollingMedian, detectDislocation, type DislocationSettings } from '../src/dislocation.js';

const settings: DislocationSettings = {
  minDislocationBps: new Decimal(500),
  minVenueDeviationBps: new Decimal(300),
  maxCounterDeviationBps: new Decimal(150),
  maxQuoteAgeMs: 5000,
  maxBaselineAgeMs: 60_000,
  minBaselineSamples: 5,
  maxRepeatCount: 20,
};

const d = (value: string) => new Decimal(value);
const now = 1_700_000_000_000;

const baseline = (median: string, samples = 21) => ({
  median: d(median),
  samples,
  ageMs: 1000,
});

/**
 * The BREV numbers from our own 24h data: WEEX asks 0.09174 while Gate bids
 * 0.09966, a 863 bps spread. WEEX is far below its 0.10 baseline, Gate is
 * sitting on its own baseline. That is a spike.
 */
function spikeInput() {
  return {
    left: { venueId: 'weex', bid: d('0.09107'), ask: d('0.09174'), timestamp: now - 100 },
    right: { venueId: 'gateio', bid: d('0.09966'), ask: d('0.10098'), timestamp: now - 120 },
    leftBaseline: baseline('0.1'),
    rightBaseline: baseline('0.1001'),
    now,
    settings,
  };
}

describe('detectDislocation', () => {
  it('flags a one-venue spike with a large executable spread', () => {
    const signal = detectDislocation(spikeInput());
    expect(signal.isDislocation).toBe(true);
    expect(signal.kind).toBe('spike');
    expect(signal.direction).toBe('left->right');
    expect(signal.venueBuy).toBe('weex');
    expect(signal.venueSell).toBe('gateio');
    expect(signal.magnitudeBps.toNumber()).toBeCloseTo(863, 0);
    expect(signal.spikeDeviationBps.toNumber()).toBeGreaterThan(800);
    expect(signal.counterDeviationBps.toNumber()).toBeLessThan(500);
  });

  it('rejects a large spread where both venues moved (repricing)', () => {
    const signal = detectDislocation({
      ...spikeInput(),
      leftBaseline: baseline('0.075'),
      rightBaseline: baseline('0.083'),
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.kind).toBe('repricing');
    expect(signal.reasons).toContain('counter_venue_also_deviating');
  });

  it('rejects a large spread where neither venue moved (frozen book)', () => {
    // This is the exact BREV trap: both venues sat at their own baseline for
    // hours while the books disagreed. Trading it means buying a dead asset.
    const signal = detectDislocation({
      ...spikeInput(),
      leftBaseline: baseline('0.0915'),
      rightBaseline: baseline('0.1001'),
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.kind).toBe('structural');
    expect(signal.reasons).toContain('structural_spread_not_tradeable');
  });

  it('rejects a spread below the threshold even when a venue deviates', () => {
    const signal = detectDislocation({
      ...spikeInput(),
      left: { venueId: 'weex', bid: d('0.0999'), ask: d('0.1'), timestamp: now - 100 },
      leftBaseline: baseline('0.1'),
      rightBaseline: baseline('0.1001'),
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.reasons).toContain('spread_below_threshold');
  });

  it('rejects stale quotes', () => {
    const signal = detectDislocation({
      ...spikeInput(),
      left: { venueId: 'weex', bid: d('0.09107'), ask: d('0.09174'), timestamp: now - 60_000 },
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.reasons).toContain('quote_stale');
  });

  it('rejects quotes timestamped in the future beyond clock skew', () => {
    const signal = detectDislocation({
      ...spikeInput(),
      left: { venueId: 'weex', bid: d('0.09107'), ask: d('0.09174'), timestamp: now + 60_000 },
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.reasons).toContain('quote_stale');
  });

  it('rejects a thin baseline', () => {
    const signal = detectDislocation({
      ...spikeInput(),
      leftBaseline: baseline('0.1', 2),
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.reasons).toContain('baseline_thin');
  });

  it('rejects a stale baseline', () => {
    const signal = detectDislocation({
      ...spikeInput(),
      leftBaseline: { median: d('0.1'), samples: 21, ageMs: 600_000 },
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.reasons).toContain('baseline_stale');
  });

  it('rejects crossed and missing quotes', () => {
    const crossed = detectDislocation({
      ...spikeInput(),
      left: { venueId: 'weex', bid: d('0.2'), ask: d('0.1'), timestamp: now },
    });
    expect(crossed.isDislocation).toBe(false);
    expect(crossed.reasons).toContain('quote_missing');

    const missing = detectDislocation({
      ...spikeInput(),
      right: { venueId: 'gateio', timestamp: now },
    });
    expect(missing.isDislocation).toBe(false);
    expect(missing.reasons).toContain('quote_missing');
  });

  it('rejects a spread whose counter-venue book is frozen', () => {
    // WEEX held 0.10516/0.1055 for twenty minutes in our recorded data. A
    // stable frozen book looks like the trustworthy counter, which inverts the
    // trade: we would buy the side that cannot fill.
    const signal = detectDislocation({
      ...spikeInput(),
      right: {
        venueId: 'gateio',
        bid: d('0.09966'),
        ask: d('0.10098'),
        timestamp: now - 120,
        repeatCount: 140,
      },
    });
    expect(signal.isDislocation).toBe(false);
    expect(signal.reasons).toContain('venue_book_frozen');
  });

  it('detects the reverse direction when the right venue spikes', () => {
    const signal = detectDislocation({
      left: { venueId: 'weex', bid: d('0.09966'), ask: d('0.10098'), timestamp: now - 100 },
      right: { venueId: 'gateio', bid: d('0.09107'), ask: d('0.09174'), timestamp: now - 100 },
      leftBaseline: baseline('0.1001'),
      rightBaseline: baseline('0.1'),
      now,
      settings,
    });
    expect(signal.isDislocation).toBe(true);
    expect(signal.direction).toBe('right->left');
    expect(signal.venueBuy).toBe('gateio');
    expect(signal.venueSell).toBe('weex');
  });
});

describe('RollingMedian', () => {
  it('returns the median of the trailing window', () => {
    const median = new RollingMedian(5);
    for (const [index, price] of ['1', '2', '3', '100', '4'].entries()) {
      median.push(d(price), now - 5000 + index * 1000);
    }
    const result = median.baseline(now, 60_000);
    expect(result?.median.toString()).toBe('3');
    expect(result?.samples).toBe(5);
  });

  it('drops samples older than the baseline window', () => {
    const median = new RollingMedian(5);
    median.push(d('999'), now - 120_000);
    median.push(d('2'), now - 1000);
    median.push(d('4'), now - 900);
    const result = median.baseline(now, 60_000);
    expect(result?.median.toString()).toBe('3');
    expect(result?.samples).toBe(2);
  });

  it('caps the window and rejects non-positive prices', () => {
    const median = new RollingMedian(3);
    median.push(d('0'), now);
    median.push(d('1'), now);
    median.push(d('2'), now);
    median.push(d('3'), now);
    median.push(d('4'), now);
    expect(median.size()).toBe(3);
    expect(median.baseline(now, 60_000)?.median.toString()).toBe('3');
  });

  it('returns undefined when every sample is stale', () => {
    const median = new RollingMedian(5);
    median.push(d('1'), now - 120_000);
    expect(median.baseline(now, 60_000)).toBeUndefined();
  });
});


