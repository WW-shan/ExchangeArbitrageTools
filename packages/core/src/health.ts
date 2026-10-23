import type { HealthState } from './types.js';

export interface HealthSample {
  at: number;
  success: boolean;
  latencyMs: number;
  rateLimited: boolean;
  staleData: boolean;
}

export interface HealthSnapshot {
  successRate: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  rateLimitEvents: number;
  staleDataEvents: number;
  feedLatencyP95Ms: number;
  crossedRate: number;
  sequenceGapRate: number;
  staleFeedRate: number;
  reliabilityScore: number;
  feedSamples?: number;
  healthState: HealthState;
  score: number;
}

export interface FeedQualitySample {
  at: number;
  latencyMs: number;
  sequenceGap: boolean;
  crossed: boolean;
  stale: boolean;
}

export class VenueHealthTracker {
  readonly #windowMs: number;
  readonly #samples: HealthSample[] = [];
  readonly #feedSamples: FeedQualitySample[] = [];

  constructor(windowMs = 15 * 60 * 1000) {
    this.#windowMs = windowMs;
  }

  record(sample: HealthSample): void {
    this.#samples.push(sample);
    this.prune(sample.at);
  }

  recordSuccess(latencyMs: number, at = Date.now()): void {
    this.record({ at, success: true, latencyMs, rateLimited: false, staleData: false });
  }

  recordFailure(latencyMs: number, at = Date.now(), rateLimited = false): void {
    this.record({ at, success: false, latencyMs, rateLimited, staleData: false });
  }

  recordStale(at = Date.now()): void {
    this.record({ at, success: true, latencyMs: 0, rateLimited: false, staleData: true });
  }

  recordFeedQuality(input: {
    at?: number;
    latencyMs?: number;
    sequenceGap?: boolean;
    crossed?: boolean;
    stale?: boolean;
  }): void {
    const at = input.at ?? Date.now();
    const latencyMs = Number.isFinite(input.latencyMs) ? Math.max(0, input.latencyMs!) : 0;
    this.#feedSamples.push({
      at,
      latencyMs,
      sequenceGap: input.sequenceGap === true,
      crossed: input.crossed === true,
      stale: input.stale === true,
    });
    this.prune(at);
  }

  snapshot(now = Date.now()): HealthSnapshot {
    this.prune(now);
    if (this.#samples.length === 0) {
      return {
        successRate: 0,
        medianLatencyMs: 0,
        p95LatencyMs: 0,
        rateLimitEvents: 0,
        staleDataEvents: 0,
        feedLatencyP95Ms: 0,
        crossedRate: 0,
        sequenceGapRate: 0,
        staleFeedRate: 0,
        reliabilityScore: 0,
        feedSamples: 0,
        healthState: 'D',
        score: 0,
      };
    }
    const successes = this.#samples.filter((sample) => sample.success).length;
    const successRate = successes / this.#samples.length;
    const latencies = this.#samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    const median = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const rateLimitEvents = this.#samples.filter((sample) => sample.rateLimited).length;
    const staleDataEvents = this.#samples.filter((sample) => sample.staleData).length;
    const feedLatencies = this.#feedSamples
      .map((sample) => sample.latencyMs)
      .sort((left, right) => left - right);
    const feedLatencyP95Ms = percentile(feedLatencies, 0.95);
    const feedCount = this.#feedSamples.length;
    const crossedRate = feedCount
      ? this.#feedSamples.filter((sample) => sample.crossed).length / feedCount
      : 0;
    const sequenceGapRate = feedCount
      ? this.#feedSamples.filter((sample) => sample.sequenceGap).length / feedCount
      : 0;
    const staleFeedRate = feedCount
      ? this.#feedSamples.filter((sample) => sample.stale).length / feedCount
      : 0;
    const reliabilityScore =
      feedCount === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              1 -
                0.5 * crossedRate -
                0.3 * staleFeedRate -
                0.2 * Math.min(feedLatencyP95Ms / 500, 1),
            ),
          );
    let healthState: HealthState;
    if (successRate >= 0.99 && rateLimitEvents === 0 && staleDataEvents === 0) healthState = 'A';
    else if (successRate >= 0.98 && rateLimitEvents <= 1) healthState = 'B';
    else if (successRate >= 0.9) healthState = 'C';
    else healthState = 'D';
    return {
      successRate,
      medianLatencyMs: median,
      p95LatencyMs: p95,
      rateLimitEvents,
      staleDataEvents,
      feedLatencyP95Ms,
      crossedRate,
      sequenceGapRate,
      staleFeedRate,
      reliabilityScore,
      feedSamples: feedCount,
      healthState,
      score: Math.round(successRate * 10_000) / 100,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.#windowMs;
    while (this.#samples.length > 0 && this.#samples[0]!.at < cutoff) this.#samples.shift();
    while (this.#feedSamples.length > 0 && this.#feedSamples[0]!.at < cutoff) {
      this.#feedSamples.shift();
    }
  }
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index]!;
}
