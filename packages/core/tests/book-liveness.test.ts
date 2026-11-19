import { describe, expect, it } from 'vitest';
import { BookLivenessTracker } from '../src/book-liveness.js';

const now = 1_700_000_000_000;

describe('BookLivenessTracker', () => {
  it('counts a venue that never changes as frozen', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 5 });
    for (let i = 0; i < 5; i += 1) {
      tracker.observe('weex', 'BREV/USDT', '0.08432', '0.08465', now + i * 2000);
    }
    expect(tracker.isFrozen('weex', 'BREV/USDT')).toBe(true);
    expect(tracker.repeatCount('weex', 'BREV/USDT')).toBe(5);
  });

  it('keeps a venue live when the top of book moves', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 5 });
    for (let i = 0; i < 20; i += 1) {
      const price = (0.084 + i / 100_000).toFixed(5);
      tracker.observe('gateio', 'BREV/USDT', price, price, now + i * 2000);
    }
    expect(tracker.isFrozen('gateio', 'BREV/USDT')).toBe(false);
  });

  it('resets the counter when the book finally moves', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 3 });
    tracker.observe('weex', 'BREV/USDT', '1', '1.1', now);
    tracker.observe('weex', 'BREV/USDT', '1', '1.1', now + 1);
    tracker.observe('weex', 'BREV/USDT', '1', '1.1', now + 2);
    expect(tracker.isFrozen('weex', 'BREV/USDT')).toBe(true);
    tracker.observe('weex', 'BREV/USDT', '1.2', '1.3', now + 3);
    expect(tracker.isFrozen('weex', 'BREV/USDT')).toBe(false);
  });

  it('tracks each venue and symbol separately', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 2 });
    tracker.observe('weex', 'BREV/USDT', '1', '1.1', now);
    tracker.observe('weex', 'BREV/USDT', '1', '1.1', now + 1);
    tracker.observe('gateio', 'BREV/USDT', '2', '2.1', now + 1);
    expect(tracker.isFrozen('weex', 'BREV/USDT')).toBe(true);
    expect(tracker.isFrozen('gateio', 'BREV/USDT')).toBe(false);
    expect(tracker.isFrozen('weex', 'WARD/USDT')).toBe(false);
  });

  it('can be disabled with maxRepeatCount 0', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 0 });
    for (let i = 0; i < 50; i += 1) tracker.observe('weex', 'BREV/USDT', '1', '1.1', now + i);
    expect(tracker.isFrozen('weex', 'BREV/USDT')).toBe(false);
  });

  it('reports every frozen venue for a symbol', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 2 });
    for (const venue of ['weex', 'gateio']) {
      tracker.observe(venue, 'BREV/USDT', '1', '1.1', now);
      tracker.observe(venue, 'BREV/USDT', '1', '1.1', now + 1);
    }
    tracker.observe('bitget', 'BREV/USDT', '1', '1.1', now + 1);
    expect(tracker.frozenVenues('BREV/USDT', ['weex', 'gateio', 'bitget'])).toEqual([
      'weex',
      'gateio',
    ]);
  });

  it('tracks how long the resting bid has kept the same price and size', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 0, maxBidStillMs: 10_000 });
    tracker.observe('bitget', 'WARD/USDT', '0.001676', '0.001677', now, '12391.31');
    tracker.observe('bitget', 'WARD/USDT', '0.001676', '0.001680', now + 5_000, '12391.31');
    expect(tracker.isBidStale('bitget', 'WARD/USDT')).toBe(false);
    tracker.observe('bitget', 'WARD/USDT', '0.001676', '0.001682', now + 10_000, '12391.31');
    expect(tracker.isBidStale('bitget', 'WARD/USDT')).toBe(true);
    expect(tracker.bidStillMs('bitget', 'WARD/USDT')).toBe(10_000);
  });

  it('resets the resting-bid clock when the bid size changes', () => {
    // A real buyer either trades or re-adds; both change the visible size.
    const tracker = new BookLivenessTracker({ maxRepeatCount: 0, maxBidStillMs: 10_000 });
    tracker.observe('bitget', 'WARD/USDT', '0.001676', '0.001677', now, '12391.31');
    tracker.observe('bitget', 'WARD/USDT', '0.001676', '0.001680', now + 20_000, '11000');
    expect(tracker.isBidStale('bitget', 'WARD/USDT')).toBe(false);
    expect(tracker.bidStillMs('bitget', 'WARD/USDT')).toBe(0);
  });

  it('does not let a moving ask reset the resting-bid clock', () => {
    // The exact 2026-11-18 shape: the ask moved constantly while the bid never
    // traded. Price-only repeat counts reset on the ask and never fire.
    const tracker = new BookLivenessTracker({ maxRepeatCount: 3, maxBidStillMs: 10_000 });
    for (let i = 0; i <= 10; i += 1) {
      tracker.observe(
        'bitget',
        'WARD/USDT',
        '0.001676',
        (0.001677 + i * 0.000001).toFixed(6),
        now + i * 1_000,
        '12391.31',
      );
    }
    expect(tracker.repeatCount('bitget', 'WARD/USDT')).toBe(1);
    expect(tracker.isFrozen('bitget', 'WARD/USDT')).toBe(false);
    expect(tracker.isBidStale('bitget', 'WARD/USDT')).toBe(true);
  });

  it('disables the resting-bid check when maxBidStillMs is zero', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 0, maxBidStillMs: 0 });
    tracker.observe('bitget', 'WARD/USDT', '1', '1.1', now, '10');
    tracker.observe('bitget', 'WARD/USDT', '1', '1.1', now + 600_000, '10');
    expect(tracker.isBidStale('bitget', 'WARD/USDT')).toBe(false);
  });

  it('prunes venues that stopped reporting', () => {
    const tracker = new BookLivenessTracker({ maxRepeatCount: 5, staleMs: 60_000 });
    tracker.observe('weex', 'BREV/USDT', '1', '1.1', now);
    tracker.prune(now + 61_000);
    expect(tracker.repeatCount('weex', 'BREV/USDT')).toBeUndefined();
  });
});
