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
 *
 * The threshold must scale with the pair's own turnover. An absolute floor
 * ("10 USDT in 60 s") silently implies "at least 14,400 USDT/day", which
 * permanently excludes every thin market. Measured 2026-11-19: of the 412
 * Gate x Bitget USDT pairs inside the scanner's 200-5,000,000 USDT band, 161
 * (39%) can never clear a 10 USDT/60 s floor no matter how actively they
 * trade. Those are exactly the books that print the spikes worth taking.
 *
 * `minTurnoverFraction` therefore compares the observed volume delta against
 * the turnover the venue's own 24h volume implies for the same span. A dead
 * book still fails (zero delta), while a thin but live book passes.
 */

export interface MarketActivityState {
  key: string;
  firstVolume: string;
  lastVolume: string;
  /** Quote volume accumulated since the first observation. */
  deltaQuoteVolume: Decimal;
  /** Latest venue-reported 24h quote volume. */
  quoteVolume24h: Decimal;
  /** Quote volume the 24h rate predicts for the observed span. */
  expectedQuoteVolume: Decimal;
  /** Wall-clock span of the observations. */
  spanMs: number;
  samples: number;
  lastAt: number;
}

export interface MarketActivityOptions {
  /**
   * Minimum quote volume that must accumulate over the observation window for
   * a market to count as live. Zero disables the absolute floor.
   */
  minQuoteVolumeDelta: Decimal;
  /** How long to observe before the verdict is trusted. */
  minSpanMs: number;
  /**
   * Fraction of the 24h-rate turnover that must be observed to call a market
   * live. 0.3 means "traded at least 30% as fast as its own daily average",
   * which tolerates quiet hours and bursts. Zero disables the relative test.
   */
  minTurnoverFraction?: Decimal;
}

export type ActivityVerdict = 'live' | 'quiet' | 'warming';

export class MarketActivityTracker {
  readonly #minDelta: Decimal;
  readonly #minSpanMs: number;
  readonly #minTurnoverFraction: Decimal;
  readonly #state = new Map<string, MarketActivityState>();
  readonly #startedAt = new Map<string, number>();

  constructor(options: MarketActivityOptions) {
    this.#minDelta = options.minQuoteVolumeDelta;
    this.#minSpanMs = Math.max(0, options.minSpanMs);
    this.#minTurnoverFraction = options.minTurnoverFraction ?? new Decimal(0);
  }

  observe(venueId: string, symbol: string, quoteVolume: Decimal | undefined, at: number): void {
    if (!quoteVolume || !quoteVolume.isFinite() || quoteVolume.lt(0)) return;
    const key = `${venueId}|${symbol}`;
    const startedAt = this.#startedAt.get(key) ?? at;
    this.#startedAt.set(key, startedAt);
    const previous = this.#state.get(key);
    const startedVolume = new Decimal(previous?.firstVolume ?? quoteVolume.toString());
    const spanMs = Math.max(0, at - startedAt);
    // The venue reports a rolling 24h volume, so the rate it implies for this
    // span is volume24h * span / 24h.
    const expected = quoteVolume.mul(spanMs).div(86_400_000);
    this.#state.set(key, {
      key,
      firstVolume: previous?.firstVolume ?? quoteVolume.toString(),
      lastVolume: quoteVolume.toString(),
      deltaQuoteVolume: quoteVolume.minus(startedVolume),
      quoteVolume24h: quoteVolume,
      expectedQuoteVolume: expected,
      spanMs,
      samples: (previous?.samples ?? 0) + 1,
      lastAt: at,
    });
  }

  verdict(venueId: string, symbol: string): ActivityVerdict {
    const relativeOnly = this.#minDelta.lte(0) && this.#minTurnoverFraction.lte(0);
    if (relativeOnly) return 'live';
    const row = this.#state.get(`${venueId}|${symbol}`);
    if (!row || row.spanMs < this.#minSpanMs) return 'warming';
    // Zero accumulated volume is dead regardless of how the thresholds are set.
    if (row.deltaQuoteVolume.lte(0)) return 'quiet';
    if (this.#minTurnoverFraction.gt(0)) {
      const required = row.expectedQuoteVolume.mul(this.#minTurnoverFraction);
      return row.deltaQuoteVolume.gte(required) ? 'live' : 'quiet';
    }
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
