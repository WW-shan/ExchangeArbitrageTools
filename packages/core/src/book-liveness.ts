/**
 * Venue book liveness.
 *
 * Gates and Bitget move their top of book every few seconds even on a quiet
 * pair. WEEX held 0.08432/0.08465 unchanged across 15 REST polls spanning 34
 * seconds. A frozen book is not a price; it is a stale snapshot that any
 * cross-venue spread will happily turn into a fake opportunity.
 *
 * The detector therefore tracks consecutive identical top-of-book snapshots per
 * venue+symbol and refuses to trade a venue once it crosses the threshold.
 */

export interface BookLivenessState {
  key: string;
  lastBid: string;
  lastAsk: string;
  repeatCount: number;
  observedAt: number;
  changes: number;
  samples: number;
  /**
   * Identity of the resting bid: price plus size.
   *
   * Measured 2026-11-18/19 on Bitget WARD: the same 12391.31 WARD bid sat at
   * 0.001676 for over 13 hours while the ask changed constantly. Every S1
   * signal priced against it looked like +120 to +145 bps and filled zero.
   * Comparing price alone cannot see this: the ask keeps moving, so any
   * price-only counter resets before it can fire. A resting order that never
   * trades keeps both price and size, which is the signature we need.
   */
  lastBidSize: string;
  /** Milliseconds the resting bid has kept the same price and size. */
  bidStillMs: number;
  /** Timestamp at which the current bid price+size first appeared. */
  bidSince: number;
}

export interface BookLivenessOptions {
  /** Consecutive unchanged snapshots that mark a book frozen. */
  maxRepeatCount: number;
  /** Forget a venue after this long without an observation. */
  staleMs?: number;
  /**
   * Milliseconds a resting bid may keep the same price and size before the
   * venue is treated as having no real buyer at that price. Zero disables it.
   *
   * Counted in wall-clock time, not samples: the scanner evaluates the hot
   * path every ~100 ms, so a sample count of 8 means ~1 s, not the 40 s its
   * name suggests. Time is the only unit that survives a scan-rate change.
   */
  maxBidStillMs?: number;
}

export class BookLivenessTracker {
  readonly #maxRepeatCount: number;
  readonly #staleMs: number;
  readonly #maxBidStillMs: number;
  readonly #state = new Map<string, BookLivenessState>();

  constructor(options: BookLivenessOptions) {
    this.#maxRepeatCount = Math.max(0, options.maxRepeatCount);
    this.#staleMs = Math.max(1000, options.staleMs ?? 5 * 60_000);
    this.#maxBidStillMs = Math.max(0, options.maxBidStillMs ?? 0);
  }

  observe(
    venueId: string,
    symbol: string,
    bid: string,
    ask: string,
    at: number,
    bidSize?: string,
  ): BookLivenessState {
    const key = `${venueId}|${symbol}`;
    const previous = this.#state.get(key);
    const size = bidSize ?? '';
    if (!previous) {
      const fresh: BookLivenessState = {
        key,
        lastBid: bid,
        lastAsk: ask,
        repeatCount: 1,
        observedAt: at,
        changes: 0,
        samples: 1,
        lastBidSize: size,
        bidStillMs: 0,
        bidSince: at,
      };
      this.#state.set(key, fresh);
      return fresh;
    }
    const unchanged = previous.lastBid === bid && previous.lastAsk === ask;
    const bidUnchanged = previous.lastBid === bid && previous.lastBidSize === size;
    const bidSince = bidUnchanged ? previous.bidSince : at;
    const next: BookLivenessState = {
      key,
      lastBid: bid,
      lastAsk: ask,
      repeatCount: unchanged ? previous.repeatCount + 1 : 1,
      observedAt: at,
      changes: previous.changes + (unchanged ? 0 : 1),
      samples: previous.samples + 1,
      lastBidSize: size,
      bidStillMs: Math.max(0, at - bidSince),
      bidSince,
    };
    this.#state.set(key, next);
    return next;
  }

  /**
   * Milliseconds the resting bid (price AND size) has been unchanged. A live
   * buyer either trades, adds, or cancels within seconds; a number that stays
   * put for tens of seconds is a stale quote, not liquidity.
   */
  bidStillMs(venueId: string, symbol: string): number | undefined {
    return this.#state.get(`${venueId}|${symbol}`)?.bidStillMs;
  }

  /** True when the resting bid has not traded, added, or cancelled for too long. */
  isBidStale(venueId: string, symbol: string): boolean {
    if (this.#maxBidStillMs <= 0) return false;
    const row = this.#state.get(`${venueId}|${symbol}`);
    return row !== undefined && row.bidStillMs >= this.#maxBidStillMs;
  }

  repeatCount(venueId: string, symbol: string): number | undefined {
    return this.#state.get(`${venueId}|${symbol}`)?.repeatCount;
  }

  isFrozen(venueId: string, symbol: string): boolean {
    if (this.#maxRepeatCount <= 0) return false;
    const row = this.#state.get(`${venueId}|${symbol}`);
    return row !== undefined && row.repeatCount >= this.#maxRepeatCount;
  }

  /** Frozen venues for a given symbol, for diagnostics and hard rejection. */
  frozenVenues(symbol: string, venueIds: readonly string[]): string[] {
    return venueIds.filter((venueId) => this.isFrozen(venueId, symbol));
  }

  prune(now: number): void {
    for (const [key, row] of this.#state) {
      if (now - row.observedAt > this.#staleMs) this.#state.delete(key);
    }
  }

  snapshot(): BookLivenessState[] {
    return [...this.#state.values()];
  }
}
