import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/money.js';
import { MarketActivityTracker } from '../src/market-activity.js';

const now = 1_700_000_000_000;

describe('MarketActivityTracker', () => {
  it('marks a market live once its volume moves', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(100),
      minSpanMs: 30_000,
    });
    tracker.observe('gateio', 'BREV/USDT', new Decimal(1000), now);
    tracker.observe('gateio', 'BREV/USDT', new Decimal(1200), now + 30_000);
    expect(tracker.verdict('gateio', 'BREV/USDT')).toBe('live');
  });

  it('marks a market quiet when volume never moves', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(100),
      minSpanMs: 30_000,
    });
    tracker.observe('weex', 'BREV/USDT', new Decimal(5000), now);
    tracker.observe('weex', 'BREV/USDT', new Decimal(5000), now + 60_000);
    expect(tracker.verdict('weex', 'BREV/USDT')).toBe('quiet');
    expect(tracker.isLive('weex', 'BREV/USDT')).toBe(false);
  });

  it('reports warming until the observation window is long enough', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(100),
      minSpanMs: 30_000,
    });
    tracker.observe('gateio', 'X/USDT', new Decimal(1), now);
    expect(tracker.verdict('gateio', 'X/USDT')).toBe('warming');
    tracker.observe('gateio', 'X/USDT', new Decimal(500), now + 5_000);
    expect(tracker.verdict('gateio', 'X/USDT')).toBe('warming');
    tracker.observe('gateio', 'X/USDT', new Decimal(500), now + 31_000);
    expect(tracker.verdict('gateio', 'X/USDT')).toBe('live');
  });

  it('tracks a rolling delta from the first observation', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(100),
      minSpanMs: 0,
    });
    tracker.observe('bitget', 'Y/USDT', new Decimal(10), now);
    tracker.observe('bitget', 'Y/USDT', new Decimal(60), now + 1000);
    tracker.observe('bitget', 'Y/USDT', new Decimal(160), now + 2000);
    expect(tracker.state('bitget', 'Y/USDT')?.deltaQuoteVolume.toString()).toBe('150');
  });

  it('can be disabled', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(0),
      minSpanMs: 60_000,
    });
    tracker.observe('weex', 'Z/USDT', new Decimal(1), now);
    expect(tracker.verdict('weex', 'Z/USDT')).toBe('live');
  });

  it('ignores missing and negative volume', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(1),
      minSpanMs: 0,
    });
    tracker.observe('gateio', 'Q/USDT', undefined, now);
    expect(tracker.state('gateio', 'Q/USDT')).toBeUndefined();
  });

  it('does not let a decreasing volume count as activity', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(10),
      minSpanMs: 0,
    });
    tracker.observe('gateio', 'R/USDT', new Decimal(1000), now);
    tracker.observe('gateio', 'R/USDT', new Decimal(10), now + 5000);
    expect(tracker.verdict('gateio', 'R/USDT')).toBe('quiet');
  });

  it('prunes stale observations', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(1),
      minSpanMs: 0,
    });
    tracker.observe('gateio', 'S/USDT', new Decimal(1), now);
    tracker.prune(now + 10 * 60_000, 5 * 60_000);
    expect(tracker.state('gateio', 'S/USDT')).toBeUndefined();
  });
});

