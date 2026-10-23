import { Decimal } from '@arb/core';

export type EntryGateMode = 'off' | 'percentile';

export interface EntryGateOptions {
  mode?: EntryGateMode;
  percentile?: number;
  windowMs?: number;
  minSamples?: number;
  maxSamplesPerKey?: number;
  maxKeys?: number;
  clock?: () => number;
}

export interface EntryGateDecision {
  allow: boolean;
  thresholdBps?: Decimal;
  sampleCount: number;
}

interface Sample {
  at: number;
  value: number;
}

/**
 * Rolling per-route percentile gate, adapted from the entry_gate.rs design in
 * djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST (2026-10). It only admits an entry
 * when the current net edge is at or above a high percentile of the recent
 * history for the same route, so a market-wide spread drift does not flood the
 * executor with mediocre signals.
 *
 * Memory is bounded: at most `maxKeys` routes and `maxSamplesPerKey` samples
 * per route, pruned by both age and count. Disabled mode is a no-op.
 */
export class PercentileEntryGate {
  readonly #mode: EntryGateMode;
  readonly #percentile: number;
  readonly #windowMs: number;
  readonly #minSamples: number;
  readonly #maxSamplesPerKey: number;
  readonly #maxKeys: number;
  readonly #clock: () => number;
  readonly #samples = new Map<string, Sample[]>();

  constructor(options: EntryGateOptions = {}) {
    this.#mode = options.mode ?? 'off';
    this.#percentile = Math.min(100, Math.max(0, options.percentile ?? 90));
    this.#windowMs = Math.max(0, options.windowMs ?? 3_600_000);
    this.#minSamples = Math.max(1, options.minSamples ?? 50);
    this.#maxSamplesPerKey = Math.max(this.#minSamples, options.maxSamplesPerKey ?? 512);
    this.#maxKeys = Math.max(1, options.maxKeys ?? 2000);
    this.#clock = options.clock ?? Date.now;
  }

  get mode(): EntryGateMode {
    return this.#mode;
  }

  observe(key: string, value: Decimal, at = this.#clock()): EntryGateDecision {
    if (this.#mode === 'off') return { allow: true, sampleCount: 0 };
    let list = this.#samples.get(key);
    if (!list) {
      if (this.#samples.size >= this.#maxKeys) {
        const oldest = this.#samples.keys().next().value;
        if (oldest !== undefined) this.#samples.delete(oldest);
      }
      list = [];
      this.#samples.set(key, list);
    }
    const cutoff = at - this.#windowMs;
    while (list.length > 0 && list[0]!.at < cutoff) list.shift();

    // Compare against history only, so the current sample cannot bias its own threshold.
    let decision: EntryGateDecision = { allow: true, sampleCount: list.length };
    if (list.length >= this.#minSamples) {
      const threshold = this.#percentileValue(list);
      decision = {
        allow: value.toNumber() >= threshold,
        thresholdBps: new Decimal(threshold),
        sampleCount: list.length,
      };
    }

    list.push({ at, value: value.toNumber() });
    if (list.length > this.#maxSamplesPerKey) list.splice(0, list.length - this.#maxSamplesPerKey);
    return decision;
  }

  stats(): { keys: number; samples: number } {
    let samples = 0;
    for (const list of this.#samples.values()) samples += list.length;
    return { keys: this.#samples.size, samples };
  }

  clear(): void {
    this.#samples.clear();
  }

  #percentileValue(list: readonly Sample[]): number {
    const sorted = list.map((sample) => sample.value).sort((left, right) => left - right);
    const rank = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((this.#percentile / 100) * sorted.length) - 1),
    );
    return sorted[rank]!;
  }
}
