import type { OrderBookSnapshot } from '@arb/core';
import type { CexAdapter } from './types.js';

export interface BookSubscription {
  venueId: string;
  adapter: CexAdapter;
  symbol: string;
}

export interface BookStoreOptions {
  depth?: number;
  maxBookAgeMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  maxReconnectAttempts?: number;
  clock?: () => number;
  onError?: (venueId: string, symbol: string, error: unknown) => void;
  onBook?: (book: OrderBookSnapshot) => void;
}

interface Entry {
  key: string;
  venueId: string;
  symbol: string;
  adapter: CexAdapter;
  controller: AbortController;
  stopped: boolean;
  version: number;
  attempts: number;
  lastUpdateAt?: number;
  lastError?: string;
  book?: OrderBookSnapshot;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps one live order-book snapshot per (venue, symbol) and reconnects on
 * failure. The scanner reads from here instead of polling REST whenever a
 * fresh WebSocket book is available.
 */
export class BookStore {
  readonly #entries = new Map<string, Entry>();
  readonly #depth: number;
  readonly #maxBookAgeMs: number;
  readonly #reconnectMinMs: number;
  readonly #reconnectMaxMs: number;
  readonly #maxReconnectAttempts: number;
  readonly #clock: () => number;
  readonly #onError?: (venueId: string, symbol: string, error: unknown) => void;
  readonly #onBook?: (book: OrderBookSnapshot) => void;
  #closed = false;

  constructor(options: BookStoreOptions = {}) {
    this.#depth = Math.max(1, options.depth ?? 50);
    this.#maxBookAgeMs = Math.max(0, options.maxBookAgeMs ?? 2000);
    this.#reconnectMinMs = Math.max(100, options.reconnectMinMs ?? 1000);
    this.#reconnectMaxMs = Math.max(this.#reconnectMinMs, options.reconnectMaxMs ?? 30_000);
    this.#maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 5);
    this.#clock = options.clock ?? Date.now;
    if (options.onError) this.#onError = options.onError;
    if (options.onBook) this.#onBook = options.onBook;
  }

  setSubscriptions(subscriptions: readonly BookSubscription[]): void {
    if (this.#closed) return;
    const desired = new Map<string, BookSubscription>();
    for (const subscription of subscriptions) {
      if (!subscription.adapter.watchOrderBook) continue;
      desired.set(`${subscription.venueId}|${subscription.symbol}`, subscription);
    }
    for (const [key, entry] of this.#entries) {
      if (desired.has(key)) continue;
      entry.stopped = true;
      entry.controller.abort();
      this.#entries.delete(key);
    }
    for (const [key, subscription] of desired) {
      if (this.#entries.has(key)) continue;
      const entry: Entry = {
        key,
        venueId: subscription.venueId,
        symbol: subscription.symbol,
        adapter: subscription.adapter,
        controller: new AbortController(),
        stopped: false,
        version: 0,
        attempts: 0,
      };
      this.#entries.set(key, entry);
      void this.run(entry);
    }
  }

  get(venueId: string, symbol: string): OrderBookSnapshot | undefined {
    return this.#entries.get(`${venueId}|${symbol}`)?.book;
  }

  isFresh(venueId: string, symbol: string, now = this.#clock()): boolean {
    const book = this.get(venueId, symbol);
    if (!book) return false;
    const receivedAt = book.receivedAt ?? book.fetchedAt;
    return Number.isFinite(receivedAt) && now - receivedAt <= this.#maxBookAgeMs;
  }

  version(venueId: string, symbol: string): number {
    return this.#entries.get(`${venueId}|${symbol}`)?.version ?? 0;
  }

  totalVersion(): number {
    let total = 0;
    for (const entry of this.#entries.values()) total += entry.version;
    return total;
  }

  stats(): { subscriptions: number; withBooks: number; stale: number } {
    const now = this.#clock();
    let withBooks = 0;
    let stale = 0;
    for (const entry of this.#entries.values()) {
      if (!entry.book) continue;
      withBooks += 1;
      if (!this.isFresh(entry.venueId, entry.symbol, now)) stale += 1;
    }
    return { subscriptions: this.#entries.size, withBooks, stale };
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      entry.stopped = true;
      entry.controller.abort();
    }
    this.#entries.clear();
  }

  private async run(entry: Entry): Promise<void> {
    let backoff = this.#reconnectMinMs;
    while (!entry.stopped && !this.#closed) {
      try {
        await entry.adapter.watchOrderBook!(
          entry.symbol,
          this.#depth,
          (book) => {
            if (entry.stopped || this.#closed) return;
            entry.book = book;
            entry.version += 1;
            entry.attempts = 0;
            entry.lastUpdateAt = this.#clock();
            backoff = this.#reconnectMinMs;
            this.#onBook?.(book);
          },
          entry.controller.signal,
        );
        if (entry.stopped || this.#closed) return;
        entry.lastError = 'watch_ended';
      } catch (error) {
        if (entry.stopped || this.#closed) return;
        entry.attempts += 1;
        entry.lastError = String(error);
        this.#onError?.(entry.venueId, entry.symbol, error);
        if (this.#maxReconnectAttempts > 0 && entry.attempts >= this.#maxReconnectAttempts) {
          entry.stopped = true;
          return;
        }
      }
      if (entry.stopped || this.#closed) return;
      await sleep(backoff);
      backoff = Math.min(this.#reconnectMaxMs, Math.max(this.#reconnectMinMs, backoff * 2));
    }
  }
}
