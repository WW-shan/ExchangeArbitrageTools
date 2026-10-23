import { Decimal, type OrderBookSnapshot } from '@arb/core';

export interface BookDeviation {
  bidBps: Decimal;
  askBps: Decimal;
  maxBps: Decimal;
}

/**
 * Compare the best bid/ask of two snapshots (typically WebSocket vs REST) and
 * return the deviation in bps. Adapts the `book_sanity.rs` cross-check from
 * djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST (2026-10).
 */
export function bookDeviationBps(
  left: OrderBookSnapshot,
  right: OrderBookSnapshot,
): BookDeviation | undefined {
  const leftBid = left.bids[0]?.price;
  const leftAsk = left.asks[0]?.price;
  const rightBid = right.bids[0]?.price;
  const rightAsk = right.asks[0]?.price;
  if (!leftBid || !leftAsk || !rightBid || !rightAsk || rightBid.lte(0) || rightAsk.lte(0)) {
    return undefined;
  }
  const bidBps = leftBid.minus(rightBid).abs().div(rightBid).mul(10_000);
  const askBps = leftAsk.minus(rightAsk).abs().div(rightAsk).mul(10_000);
  return { bidBps, askBps, maxBps: Decimal.max(bidBps, askBps) };
}

export interface BookSanityOptions {
  enabled?: boolean;
  intervalMs?: number;
  maxDeviationBps?: Decimal;
  requiredFailures?: number;
  requiredSuccesses?: number;
  cooldownMs?: number;
  clock?: () => number;
}

export interface BookSanitySnapshot {
  blocked: boolean;
  blockedUntil?: number;
  failureStreak: number;
  successStreak: number;
  lastReason?: string;
  lastCheckedAt?: number;
}

interface State {
  blocked: boolean;
  blockedUntil?: number;
  failureStreak: number;
  successStreak: number;
  lastReason?: string;
  lastCheckedAt?: number;
}

export class BookSanityMonitor {
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #maxDeviationBps: Decimal;
  readonly #requiredFailures: number;
  readonly #requiredSuccesses: number;
  readonly #cooldownMs: number;
  readonly #clock: () => number;
  readonly #states = new Map<string, State>();

  constructor(options: BookSanityOptions = {}) {
    this.#enabled = options.enabled ?? false;
    this.#intervalMs = Math.max(0, options.intervalMs ?? 60_000);
    this.#maxDeviationBps = options.maxDeviationBps ?? new Decimal(50);
    this.#requiredFailures = Math.max(1, options.requiredFailures ?? 3);
    this.#requiredSuccesses = Math.max(1, options.requiredSuccesses ?? 3);
    this.#cooldownMs = Math.max(0, options.cooldownMs ?? 300_000);
    this.#clock = options.clock ?? Date.now;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get maxDeviationBps(): Decimal {
    return this.#maxDeviationBps;
  }

  due(key: string, now = this.#clock()): boolean {
    if (!this.#enabled) return false;
    const state = this.#states.get(key);
    return state?.lastCheckedAt === undefined || now - state.lastCheckedAt >= this.#intervalMs;
  }

  isBlocked(key: string): boolean {
    return this.#states.get(key)?.blocked === true;
  }

  snapshot(key: string): BookSanitySnapshot {
    const state = this.#states.get(key);
    if (!state) return { blocked: false, failureStreak: 0, successStreak: 0 };
    return { ...state };
  }

  success(key: string, now = this.#clock()): void {
    const state = this.#state(key);
    state.lastCheckedAt = now;
    state.failureStreak = 0;
    state.successStreak += 1;
    delete state.lastReason;
    if (state.blocked) {
      const cooldownDone = state.blockedUntil === undefined || now >= state.blockedUntil;
      if (cooldownDone && state.successStreak >= this.#requiredSuccesses) {
        state.blocked = false;
        delete state.blockedUntil;
      }
    }
  }

  failure(key: string, reason: string, now = this.#clock()): void {
    const state = this.#state(key);
    state.lastCheckedAt = now;
    state.failureStreak += 1;
    state.successStreak = 0;
    state.lastReason = reason;
    if (state.failureStreak >= this.#requiredFailures) {
      state.blocked = true;
      state.blockedUntil = now + this.#cooldownMs;
    }
  }

  clear(): void {
    this.#states.clear();
  }

  #state(key: string): State {
    let state = this.#states.get(key);
    if (!state) {
      state = { blocked: false, failureStreak: 0, successStreak: 0 };
      this.#states.set(key, state);
    }
    return state;
  }
}
