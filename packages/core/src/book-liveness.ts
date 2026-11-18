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
}

export interface BookLivenessOptions {
  /** Consecutive unchanged snapshots that mark a book frozen. */
  maxRepeatCount: number;
  /** Forget a venue after this long without an observation. */
  staleMs?: number;
}

export class BookLivenessTracker {
  readonly #maxRepeatCount: number;
  readonly #staleMs: number;
  readonly #state = new Map<string, BookLivenessState>();

  constructor(options: BookLivenessOptions) {
    this.#maxRepeatCount = Math.max(0, options.maxRepeatCount);
    this.#staleMs = Math.max(1000, options.staleMs ?? 5 * 60_000);
  }

  observe(venueId: string, symbol: string, bid: string, ask: string, at: number): BookLivenessState {
    const key = `${venueId}|${symbol}`;
    const previous = this.#state.get(key);
    if (!previous) {
      const fresh: BookLivenessState = {
        key,
        lastBid: bid,
        lastAsk: ask,
        repeatCount: 1,
        observedAt: at,
        changes: 0,
        samples: 1,
      };
      this.#state.set(key, fresh);
      return fresh;
    }
    const unchanged = previous.lastBid === bid && previous.lastAsk === ask;
    const next: BookLivenessState = {
      key,
      lastBid: bid,
      lastAsk: ask,
      repeatCount: unchanged ? previous.repeatCount + 1 : 1,
      observedAt: at,
      changes: previous.changes + (unchanged ? 0 : 1),
      samples: previous.samples + 1,
    };
    this.#state.set(key, next);
    return next;
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
