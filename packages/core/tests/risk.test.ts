import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  ExecutionGate,
  TokenBucketRateLimiter,
  VenueHealthTracker,
  type BatchPreflight,
  type Clock,
} from '../src/index.js';

class FakeClock implements Clock {
  current = 0;
  now(): number {
    return this.current;
  }
  async sleep(ms: number): Promise<void> {
    this.current += ms;
  }
}

const validCheck: BatchPreflight = {
  requestedNotional: new Decimal(10),
  expectedNetProfit: new Decimal('0.2'),
  expectedNetProfitBps: new Decimal(30),
  openBatches: 0,
  unresolvedUnknownOrders: 0,
  dailyRealizedLoss: new Decimal(0),
  dailyRebalanceCost: new Decimal(0),
  unhedgedInventoryRisk: new Decimal(0),
  buyBookAgeMs: 100,
  sellBookAgeMs: 100,
  buyVenueHealth: 'A',
  sellVenueHealth: 'A',
  manualConfirmation: true,
  iocOrFokSupported: true,
  feesConfigured: true,
  precisionConfigured: true,
  balanceMismatch: false,
};

describe('execution risk gate', () => {
  it('defaults to a kill switch and blocks all submissions', () => {
    const gate = new ExecutionGate({
      maxOrderNotional: new Decimal(30),
      dailyMaxLoss: new Decimal(20),
      maxOpenBatches: 1,
      minNetProfitBps: new Decimal(20),
      maxStaleOrderbookMs: 3000,
      maxSlippageBps: new Decimal(50),
      killSwitchDefault: true,
    });
    expect(gate.preflight(validCheck).allowed).toBe(false);
    expect(gate.preflight(validCheck).reasons).toContain('kill_switch_on');
  });

  it('detects loss, unknown-order, and balance failures in one decision', () => {
    const gate = new ExecutionGate({
      maxOrderNotional: new Decimal(30),
      dailyMaxLoss: new Decimal(20),
      maxOpenBatches: 1,
      minNetProfitBps: new Decimal(20),
      maxStaleOrderbookMs: 3000,
      maxSlippageBps: new Decimal(50),
      killSwitchDefault: false,
    });
    const decision = gate.preflight({
      ...validCheck,
      unresolvedUnknownOrders: 1,
      dailyRealizedLoss: new Decimal(20),
      balanceMismatch: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('daily_loss_limit_reached');
    expect(decision.reasons).toContain('unresolved_unknown_order');
    expect(decision.reasons).toContain('balance_mismatch');
  });

  it('rejects estimated slippage above the configured limit', () => {
    const gate = new ExecutionGate({
      maxOrderNotional: new Decimal(30),
      dailyMaxLoss: new Decimal(20),
      maxOpenBatches: 1,
      minNetProfitBps: new Decimal(20),
      maxStaleOrderbookMs: 3000,
      maxSlippageBps: new Decimal(50),
      killSwitchDefault: false,
    });
    const decision = gate.preflight({
      ...validCheck,
      estimatedSlippageBps: new Decimal('50.01'),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('slippage_too_high');
  });

  it('fails closed when risk values or limits are non-finite', () => {
    const gate = new ExecutionGate({
      maxOrderNotional: new Decimal(30),
      dailyMaxLoss: new Decimal(20),
      maxOpenBatches: 1,
      minNetProfitBps: new Decimal(20),
      maxStaleOrderbookMs: 3000,
      maxSlippageBps: new Decimal(50),
      killSwitchDefault: false,
    });
    const decision = gate.preflight({
      ...validCheck,
      requestedNotional: new Decimal(Number.NaN),
      expectedNetProfit: new Decimal(Number.POSITIVE_INFINITY),
      expectedNetProfitBps: new Decimal(Number.NaN),
      openBatches: 0.5,
      unresolvedUnknownOrders: 0.5,
      dailyRealizedLoss: new Decimal(Number.NaN),
      buyBookAgeMs: Number.NaN,
      estimatedSlippageBps: new Decimal(-1),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'notional_outside_limits',
        'expected_profit_not_positive',
        'min_profit_below_threshold',
        'max_open_batches_reached',
        'unresolved_unknown_order',
        'daily_loss_limit_reached',
        'stale_orderbook',
        'slippage_too_high',
      ]),
    );

    const invalidLimits = new ExecutionGate({
      maxOrderNotional: new Decimal(Number.NaN),
      dailyMaxLoss: new Decimal(Number.POSITIVE_INFINITY),
      maxOpenBatches: 0,
      minNetProfitBps: new Decimal(Number.NaN),
      maxStaleOrderbookMs: Number.NaN,
      maxSlippageBps: new Decimal(Number.NaN),
      killSwitchDefault: false,
    });
    const invalidDecision = invalidLimits.preflight(validCheck);
    expect(invalidDecision.allowed).toBe(false);
    expect(invalidDecision.reasons).toContain('risk_limits_invalid');

    const negativeThreshold = new ExecutionGate({
      maxOrderNotional: new Decimal(30),
      dailyMaxLoss: new Decimal(20),
      maxOpenBatches: 1,
      minNetProfitBps: new Decimal(-1),
      maxStaleOrderbookMs: 3000,
      maxSlippageBps: new Decimal(50),
      killSwitchDefault: false,
    });
    const negativeDecision = negativeThreshold.preflight(validCheck);
    expect(negativeDecision.allowed).toBe(false);
    expect(negativeDecision.reasons).toContain('risk_limits_invalid');
  });
});

describe('token bucket rate limiter', () => {
  it('waits for refill instead of exceeding the configured budget', async () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketRateLimiter(
      {
        requestsPerSecond: 1,
        burst: 1,
        costPublic: 1,
        costPrivate: 1,
        respectRetryAfter: true,
      },
      clock,
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(clock.current).toBe(1000);
  });

  it('honors Retry-After before the next request', async () => {
    const clock = new FakeClock();
    const limiter = new TokenBucketRateLimiter(
      {
        requestsPerSecond: 10,
        burst: 10,
        costPublic: 1,
        costPrivate: 1,
        respectRetryAfter: true,
      },
      clock,
    );
    limiter.respectRetryAfter(2000);
    await limiter.acquire();
    expect(clock.current).toBe(2000);
  });
});

describe('venue health tracker', () => {
  it('degrades a venue after failures and rate limits', () => {
    const tracker = new VenueHealthTracker(60_000);
    for (let i = 0; i < 99; i += 1) tracker.recordSuccess(50, 1000 + i);
    tracker.recordFailure(50, 1500, true);
    const snapshot = tracker.snapshot(1600);
    expect(snapshot.healthState).toBe('B');
    expect(snapshot.rateLimitEvents).toBe(1);
  });

  it('scores feed reliability from crossed, stale, and latency samples', () => {
    const tracker = new VenueHealthTracker(60_000);
    tracker.recordSuccess(10, 1000);
    tracker.recordFeedQuality({
      at: 1000,
      latencyMs: 100,
      crossed: false,
      stale: false,
      sequenceGap: false,
    });
    tracker.recordFeedQuality({
      at: 2000,
      latencyMs: 800,
      crossed: true,
      stale: true,
      sequenceGap: true,
    });
    const snapshot = tracker.snapshot(2500);
    expect(snapshot.crossedRate).toBe(0.5);
    expect(snapshot.staleFeedRate).toBe(0.5);
    expect(snapshot.sequenceGapRate).toBe(0.5);
    expect(snapshot.feedLatencyP95Ms).toBe(800);
    expect(snapshot.reliabilityScore).toBeLessThan(0.5);
  });
});
