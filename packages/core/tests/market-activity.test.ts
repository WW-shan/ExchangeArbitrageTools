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


describe('MarketActivityTracker turnover-relative liveness', () => {
  it('keeps a thin but actively trading book live', () => {
    // 300 USDT/day is far below any absolute "10 USDT per 60 s" floor
    // (which implies 14,400/day), but this book traded 20% of a 60 s slice.
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(0),
      minTurnoverFraction: new Decimal('0.2'),
      minSpanMs: 60_000,
    });
    tracker.observe('gateio', 'THIN/USDT', new Decimal(300), now);
    tracker.observe('gateio', 'THIN/USDT', new Decimal(300.35), now + 60_000);
    expect(tracker.verdict('gateio', 'THIN/USDT')).toBe('live');
  });

  it('still rejects a frozen book with a nonzero 24h volume', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(0),
      minTurnoverFraction: new Decimal('0.3'),
      minSpanMs: 60_000,
    });
    tracker.observe('weex', 'DEAD/USDT', new Decimal(900_000), now);
    tracker.observe('weex', 'DEAD/USDT', new Decimal(900_000), now + 60_000);
    expect(tracker.verdict('weex', 'DEAD/USDT')).toBe('quiet');
  });

  it('rejects a book trading far below its own 24h rate', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(0),
      minTurnoverFraction: new Decimal('0.5'),
      minSpanMs: 60_000,
    });
    // 86,400/day implies 60 USDT/min; 6 USDT observed is 10% of that.
    tracker.observe('bitget', 'SLOW/USDT', new Decimal(86_400), now);
    tracker.observe('bitget', 'SLOW/USDT', new Decimal(86_406), now + 60_000);
    expect(tracker.verdict('bitget', 'SLOW/USDT')).toBe('quiet');
  });

  it('reports the implied expectation so the verdict can be audited', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(0),
      minTurnoverFraction: new Decimal('0.3'),
      minSpanMs: 0,
    });
    tracker.observe('gateio', 'AUDIT/USDT', new Decimal(86_400), now);
    const row = tracker.state('gateio', 'AUDIT/USDT');
    expect(row?.quoteVolume24h.toString()).toBe('86400');
    expect(row?.expectedQuoteVolume.toString()).toBe('0');
  });

  it('keeps the absolute floor working when no fraction is configured', () => {
    const tracker = new MarketActivityTracker({
      minQuoteVolumeDelta: new Decimal(100),
      minSpanMs: 0,
    });
    tracker.observe('gateio', 'ABS/USDT', new Decimal(1000), now);
    tracker.observe('gateio', 'ABS/USDT', new Decimal(1050), now + 5000);
    expect(tracker.verdict('gateio', 'ABS/USDT')).toBe('quiet');
    tracker.observe('gateio', 'ABS/USDT', new Decimal(1200), now + 6000);
    expect(tracker.verdict('gateio', 'ABS/USDT')).toBe('live');
  });
});