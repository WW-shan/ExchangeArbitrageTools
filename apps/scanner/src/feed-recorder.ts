import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OrderBookSnapshot } from '@arb/core';

export interface FeedRecorderOptions {
  directory: string;
  clock?: () => number;
  flushEvery?: number;
}

/**
 * Appends normalized L2 snapshots as JSONL so a real session can be replayed
 * offline. Writes are batched to avoid one syscall per WebSocket update.
 */
export class FeedRecorder {
  readonly #path: string;
  readonly #flushEvery: number;
  #buffer: string[] = [];
  #closed = false;

  constructor(options: FeedRecorderOptions) {
    const stamp = new Date(options.clock?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    this.#path = join(options.directory, `feed-${stamp}.jsonl`);
    this.#flushEvery = Math.max(1, options.flushEvery ?? 200);
    mkdirSync(dirname(this.#path), { recursive: true });
  }

  get path(): string {
    return this.#path;
  }

  record(book: OrderBookSnapshot): void {
    if (this.#closed) return;
    this.#buffer.push(
      JSON.stringify({
        venueId: book.venueId,
        exchangeSymbol: book.exchangeSymbol,
        fetchedAt: book.fetchedAt,
        receivedAt: book.receivedAt ?? book.fetchedAt,
        ...(book.exchangeTimestamp !== undefined
          ? { exchangeTimestamp: book.exchangeTimestamp }
          : {}),
        ...(book.sequence !== undefined ? { sequence: book.sequence } : {}),
        asks: book.asks.map((level) => [level.price.toFixed(), level.amount.toFixed()]),
        bids: book.bids.map((level) => [level.price.toFixed(), level.amount.toFixed()]),
        source: book.source,
      }),
    );
    if (this.#buffer.length >= this.#flushEvery) this.flush();
  }

  flush(): void {
    if (this.#buffer.length === 0) return;
    appendFileSync(this.#path, `${this.#buffer.join('\n')}\n`, 'utf8');
    this.#buffer = [];
  }

  close(): void {
    if (this.#closed) return;
    this.flush();
    this.#closed = true;
  }
}
