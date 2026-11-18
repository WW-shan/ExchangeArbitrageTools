import { Decimal } from './money.js';

/**
 * Is this market actually trading?
 *
 * A frozen price is ambiguous: it can mean a genuinely quiet book, or a stale
 * snapshot. Volume separates the two. A market whose 24h quote volume moves
 * between two snapshots has had a trade; a market whose volume never moves has
 * had none, and its "price" is just the last thing anyone posted.
 *
 * Measured on Gate x Bitget (2026-11-19), REST polling every 5 s:
 *   WEEX        ticker lag 132 s, then 609 s; 624/1379 books frozen
 *   Gate        533/1835 books frozen
 *   Bitget      666/1783 books frozen
 * so "unchanged top of book" is far too common to be a signal on its own.
 */

export interface MarketActivityState {
  key: string;
  firstVolume: string;
  lastVolume: string;
  /** Quote volume accumulated since the first observation. */
  deltaQuoteVolume: Decimal;
  /** Wall-clock span of the observations. */
  spanMs: number;
  samples: number;
  lastAt: number;
}

export interface MarketActivityOptions {
  /**
   * Minimum quote volume that must accumulate over the observation window for
   * a market to count as live. Zero disables the check.
   */
  minQuoteVolumeDelta: Decimal;
  /** How long to observe before the verdict is trusted. */
  minSpanMs: number;
}

export type ActivityVerdict = 'live' | 'quiet' | 'warming';

export class MarketActivityTracker {
  readonly #minDelta: Decimal;
  readonly #minSpanMs: number;
  readonly #state = new Map<string, MarketActivityState>();
  readonly #startedAt = new Map<string, number>();

  constructor(options: MarketActivityOptions) {
    this.#minDelta = options.minQuoteVolumeDelta;
    this.#minSpanMs = Math.max(0, options.minSpanMs);
  }

  observe(venueId: string, symbol: string, quoteVolume: Decimal | undefined, at: number): void {
    if (!quoteVolume || !quoteVolume.isFinite() || quoteVolume.lt(0)) return;
    const key = `${venueId}|${symbol}`;
    const startedAt = this.#startedAt.get(key) ?? at;
    this.#startedAt.set(key, startedAt);
    const previous = this.#state.get(key);
    const startedVolume = new Decimal(previous?.firstVolume ?? quoteVolume.toString());
    this.#state.set(key, {
      key,
      firstVolume: previous?.firstVolume ?? quoteVolume.toString(),
      lastVolume: quoteVolume.toString(),
      deltaQuoteVolume: quoteVolume.minus(startedVolume),
      spanMs: at - startedAt,
      samples: (previous?.samples ?? 0) + 1,
      lastAt: at,
    });
  }

  verdict(venueId: string, symbol: string): ActivityVerdict {
    if (this.#minDelta.lte(0)) return 'live';
    const row = this.#state.get(`${venueId}|${symbol}`);
    if (!row || row.spanMs < this.#minSpanMs) return 'warming';
    return row.deltaQuoteVolume.gte(this.#minDelta) ? 'live' : 'quiet';
  }

  isLive(venueId: string, symbol: string): boolean {
    return this.verdict(venueId, symbol) === 'live';
  }

  state(venueId: string, symbol: string): MarketActivityState | undefined {
    return this.#state.get(`${venueId}|${symbol}`);
  }

  /** Drop observations older than `maxAgeMs` so memory stays bounded. */
  prune(now: number, maxAgeMs: number): void {
    for (const [key, row] of this.#state) {
      if (now - row.lastAt > maxAgeMs) {
        this.#state.delete(key);
        this.#startedAt.delete(key);
      }
    }
  }

  liveCount(): number {
    let live = 0;
    for (const key of this.#state.keys()) {
      const [venueId, ...rest] = key.split('|');
      if (this.isLive(venueId!, rest.join('|'))) live += 1;
    }
    return live;
  }
}





