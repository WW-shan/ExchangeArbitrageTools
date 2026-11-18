import { Decimal, TEN_THOUSAND, ZERO } from './money.js';

/**
 * Dislocation ("插针") detection.
 *
 * The normal S1 target is a 20-60 bps cross-venue spread: both venues agree on
 * the asset and only fees and slippage differ. That trade needs sub-second
 * execution, and our measured proxy RTT is 1.2-3.4 s, so it is structurally
 * unprofitable for us.
 *
 * A dislocation is a different event: one venue prints far from its own recent
 * baseline while the other stays put. The edge is 500+ bps, which survives a
 * slow link.
 *
 * A large spread alone is not enough. Comparing both venues against their own
 * trailing medians separates three very different situations:
 *
 *   spike       one venue moved, the other did not. This is the tradeable
 *               event: a bad print or a burst of market orders we can take.
 *   structural  neither venue moved, yet the spread is large and persistent.
 *               Almost always means one book is frozen, one venue halted
 *               deposits/withdrawals, or the ticker is stale. Trading it means
 *               buying an asset we cannot move. Must be rejected.
 *   repricing   both venues moved. The asset really changed price; there is no
 *               edge, only the illusion of one.
 *
 * The BREV 789 bps "opportunity" in our own 24h data is the structural case:
 * WEEX sat at 0.09174 while Gate sat at 0.09966 for hours. Both were at their
 * own baseline. That is not free money; it is a dead book.
 */

export type DislocationDirection = 'left->right' | 'right->left';

export type DislocationKind = 'spike' | 'structural' | 'repricing';

export interface DislocationQuote {
  venueId: string;
  bid?: Decimal;
  ask?: Decimal;
  timestamp: number;
  /**
   * How many consecutive snapshots have shown this exact top of book.
   *
   * A live market moves constantly. WEEX printed 0.10516/0.1055 for twenty
   * minutes straight in our own recorded data. A frozen book looks perfectly
   * stable to a baseline comparison, so it gets treated as the trustworthy
   * counter-venue while the venue that is actually trading gets labelled the
   * spike. That inverts the trade: we would buy on the side that cannot fill.
   */
  repeatCount?: number;
}

export interface DislocationBaseline {
  /** Median price over the trailing window, usually the mid price. */
  median: Decimal;
  /** How many samples the median was built from. */
  samples: number;
  /** Age of the newest sample used for the median. */
  ageMs: number;
}

export interface DislocationSettings {
  /** Minimum executable cross-venue spread, in bps. 500 = 5%. */
  minDislocationBps: Decimal;
  /** The spiking venue must be at least this far from its own median. */
  minVenueDeviationBps: Decimal;
  /** The other venue must be closer than this to its own median. */
  maxCounterDeviationBps: Decimal;
  /** Reject quotes older than this. */
  maxQuoteAgeMs: number;
  /** Reject baselines older than this. */
  maxBaselineAgeMs: number;
  /** Minimum baseline samples before a deviation is trusted. */
  minBaselineSamples: number;
  /**
   * Reject a venue whose top of book has not changed for this many snapshots.
   * Zero disables the check.
   */
  maxRepeatCount: number;
}

export interface DislocationInput {
  left: DislocationQuote;
  right: DislocationQuote;
  leftBaseline?: DislocationBaseline;
  rightBaseline?: DislocationBaseline;
  now: number;
  settings: DislocationSettings;
}

export type DislocationRejection =
  | 'quote_missing'
  | 'quote_stale'
  | 'baseline_missing'
  | 'baseline_stale'
  | 'baseline_thin'
  | 'spread_below_threshold'
  | 'spike_venue_not_deviating'
  | 'counter_venue_also_deviating'
  | 'structural_spread_not_tradeable'
  | 'venue_book_frozen';

export interface DislocationSignal {
  isDislocation: boolean;
  kind?: DislocationKind;
  direction?: DislocationDirection;
  /** Venue we buy from (its ask is abnormally low). */
  venueBuy?: string;
  /** Venue we sell into (its bid is abnormally high). */
  venueSell?: string;
  /** Executable cross-venue spread: sell bid vs buy ask. */
  magnitudeBps: Decimal;
  /** Deviation of the venue we take from its own median. */
  spikeDeviationBps: Decimal;
  /** Deviation of the counter venue from its own median. */
  counterDeviationBps: Decimal;
  /** Which side of the spiking venue printed the outlier. */
  spikeSide?: 'bid' | 'ask';
  reasons: DislocationRejection[];
  sampledAt: number;
}

function usable(quote: DislocationQuote): boolean {
  return Boolean(quote.bid?.gt(0) && quote.ask?.gt(0) && quote.bid.lte(quote.ask));
}

function mid(quote: DislocationQuote): Decimal {
  return quote.bid!.plus(quote.ask!).div(2);
}

function deviationBps(price: Decimal, baseline: Decimal): Decimal {
  if (!baseline.gt(0)) return ZERO;
  return price.minus(baseline).div(baseline).mul(TEN_THOUSAND);
}

/** Largest absolute deviation of either side of the book from the baseline. */
function peakDeviation(quote: DislocationQuote, baseline: DislocationBaseline): Decimal {
  return Decimal.max(
    deviationBps(quote.bid!, baseline.median).abs(),
    deviationBps(quote.ask!, baseline.median).abs(),
    deviationBps(mid(quote), baseline.median).abs(),
  );
}

function outlierSide(quote: DislocationQuote, baseline: DislocationBaseline): 'bid' | 'ask' {
  const bidDev = deviationBps(quote.bid!, baseline.median).abs();
  const askDev = deviationBps(quote.ask!, baseline.median).abs();
  return bidDev.gte(askDev) ? 'bid' : 'ask';
}

function executableBps(buy: DislocationQuote, sell: DislocationQuote): Decimal {
  return sell.bid!.minus(buy.ask!).div(buy.ask!).mul(TEN_THOUSAND);
}

export function detectDislocation(input: DislocationInput): DislocationSignal {
  const { left, right, leftBaseline, rightBaseline, now, settings } = input;
  const reasons: DislocationRejection[] = [];
  const base: DislocationSignal = {
    isDislocation: false,
    magnitudeBps: ZERO,
    spikeDeviationBps: ZERO,
    counterDeviationBps: ZERO,
    reasons,
    sampledAt: now,
  };

  if (!usable(left) || !usable(right)) {
    reasons.push('quote_missing');
    return base;
  }
  const maxAge = Math.max(0, settings.maxQuoteAgeMs);
  if (
    !Number.isFinite(left.timestamp) ||
    !Number.isFinite(right.timestamp) ||
    now - left.timestamp > maxAge ||
    now - right.timestamp > maxAge ||
    left.timestamp > now + 1000 ||
    right.timestamp > now + 1000
  ) {
    reasons.push('quote_stale');
    return base;
  }

  const maxRepeat = settings.maxRepeatCount;
  if (maxRepeat > 0) {
    const frozen = [left, right].filter(
      (quote) => typeof quote.repeatCount === 'number' && quote.repeatCount >= maxRepeat,
    );
    if (frozen.length > 0) {
      reasons.push('venue_book_frozen');
      return { ...base, reasons };
    }
  }

  const forward = executableBps(left, right);
  const backward = executableBps(right, left);
  const direction: DislocationDirection = forward.gte(backward) ? 'left->right' : 'right->left';
  const magnitude = Decimal.max(forward, backward);
  const buyVenue = direction === 'left->right' ? left : right;
  const sellVenue = direction === 'left->right' ? right : left;
  const buyBaseline = direction === 'left->right' ? leftBaseline : rightBaseline;
  const sellBaseline = direction === 'left->right' ? rightBaseline : leftBaseline;

  if (magnitude.lt(settings.minDislocationBps)) {
    reasons.push('spread_below_threshold');
    return { ...base, direction, magnitudeBps: magnitude };
  }
  if (!buyBaseline || !sellBaseline) {
    reasons.push('baseline_missing');
    return { ...base, direction, magnitudeBps: magnitude };
  }
  if (
    !Number.isFinite(buyBaseline.ageMs) ||
    !Number.isFinite(sellBaseline.ageMs) ||
    buyBaseline.ageMs > settings.maxBaselineAgeMs ||
    sellBaseline.ageMs > settings.maxBaselineAgeMs
  ) {
    reasons.push('baseline_stale');
    return { ...base, direction, magnitudeBps: magnitude };
  }
  if (
    buyBaseline.samples < settings.minBaselineSamples ||
    sellBaseline.samples < settings.minBaselineSamples
  ) {
    reasons.push('baseline_thin');
    return { ...base, direction, magnitudeBps: magnitude };
  }

  const buyDeviation = peakDeviation(buyVenue, buyBaseline);
  const sellDeviation = peakDeviation(sellVenue, sellBaseline);
  const spikeIsBuySide = buyDeviation.gte(sellDeviation);
  const spikeDeviation = spikeIsBuySide ? buyDeviation : sellDeviation;
  const counterDeviation = spikeIsBuySide ? sellDeviation : buyDeviation;

  const bothDeviating =
    buyDeviation.gt(settings.maxCounterDeviationBps) &&
    sellDeviation.gt(settings.maxCounterDeviationBps);
  // A structural spread is one where the venue we would take is *also* sitting
  // on its own baseline: nothing moved, the books simply disagree.
  const structural = spikeDeviation.lt(settings.minVenueDeviationBps);

  const signal: DislocationSignal = {
    isDislocation: false,
    kind: bothDeviating ? 'repricing' : structural ? 'structural' : 'spike',
    direction,
    venueBuy: buyVenue.venueId,
    venueSell: sellVenue.venueId,
    magnitudeBps: magnitude,
    spikeDeviationBps: spikeDeviation,
    counterDeviationBps: counterDeviation,
    spikeSide: outlierSide(
      spikeIsBuySide ? buyVenue : sellVenue,
      spikeIsBuySide ? buyBaseline : sellBaseline,
    ),
    reasons,
    sampledAt: now,
  };

  if (bothDeviating) {
    reasons.push('counter_venue_also_deviating');
    return signal;
  }
  if (structural) {
    // A large spread with both venues at their own baseline is a frozen book,
    // a halted market, or a stale ticker. Never tradeable.
    reasons.push('structural_spread_not_tradeable');
    return signal;
  }
  if (spikeDeviation.lt(settings.minVenueDeviationBps)) {
    reasons.push('spike_venue_not_deviating');
    return signal;
  }

  signal.isDislocation = true;
  return signal;
}

/**
 * Trailing median used as the per-venue baseline. Kept as a small rolling
 * window so a single print cannot move its own reference.
 */
export class RollingMedian {
  readonly #capacity: number;
  readonly #values: { price: Decimal; at: number }[] = [];

  constructor(capacity = 61) {
    this.#capacity = Math.max(3, capacity);
  }

  push(price: Decimal, at: number): void {
    if (!price.gt(0) || !Number.isFinite(at)) return;
    this.#values.push({ price, at });
    while (this.#values.length > this.#capacity) this.#values.shift();
  }

  baseline(now: number, maxAgeMs: number): DislocationBaseline | undefined {
    const fresh = this.#values.filter((row) => now - row.at <= maxAgeMs);
    if (fresh.length === 0) return undefined;
    const sorted = fresh.map((row) => row.price).sort((a, b) => a.comparedTo(b));
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? sorted[middle]!
        : sorted[middle - 1]!.plus(sorted[middle]!).div(2);
    return {
      median,
      samples: fresh.length,
      ageMs: now - fresh[fresh.length - 1]!.at,
    };
  }

  size(): number {
    return this.#values.length;
  }
}


