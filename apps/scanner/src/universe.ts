import { Decimal } from '@arb/core';
import type { MarketMetadata, TickerSnapshot } from '@arb/core';
import type { MarketUniverseEntry } from '@arb/storage';

export interface UniverseOptions {
  markets: readonly MarketMetadata[];
  tickers: readonly TickerSnapshot[];
  quoteCurrencies: readonly string[];
  maxBaseAssets: number;
  minQuoteVolumeUsd: Decimal;
  explicitBaseAssets?: readonly string[];
  now: number;
}

interface Candidate {
  market: MarketMetadata;
  quoteVolume: Decimal;
  hasVolume: boolean;
}

function quoteVolumeFor(ticker: TickerSnapshot | undefined): {
  value: Decimal;
  hasVolume: boolean;
} {
  if (!ticker) return { value: new Decimal(0), hasVolume: false };
  if (ticker.quoteVolume?.isFinite() && ticker.quoteVolume.gte(0)) {
    return { value: ticker.quoteVolume, hasVolume: true };
  }
  if (
    ticker.baseVolume?.isFinite() &&
    ticker.baseVolume.gte(0) &&
    ticker.last?.isFinite() &&
    ticker.last.gt(0)
  ) {
    return { value: ticker.baseVolume.mul(ticker.last), hasVolume: true };
  }
  return { value: new Decimal(0), hasVolume: false };
}

export function buildMarketUniverse(options: UniverseOptions): MarketUniverseEntry[] {
  const quotes = new Set(options.quoteCurrencies.map((quote) => quote.trim().toUpperCase()));
  const explicit = options.explicitBaseAssets
    ? new Set(options.explicitBaseAssets.map((base) => base.trim().toUpperCase()))
    : undefined;
  const tickers = new Map(options.tickers.map((ticker) => [ticker.exchangeSymbol, ticker]));
  const candidates: Candidate[] = [];

  for (const market of options.markets) {
    if (!market.active) continue;
    const quote = market.quote.trim().toUpperCase();
    if (!quotes.has(quote)) continue;
    if (explicit && !explicit.has(market.base.trim().toUpperCase())) continue;
    const { value, hasVolume } = quoteVolumeFor(tickers.get(market.exchangeSymbol));
    if (hasVolume && value.lt(options.minQuoteVolumeUsd)) continue;
    candidates.push({ market, quoteVolume: value, hasVolume });
  }

  const byQuote = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const quote = candidate.market.quote.trim().toUpperCase();
    const rows = byQuote.get(quote) ?? [];
    rows.push(candidate);
    byQuote.set(quote, rows);
  }

  const result: MarketUniverseEntry[] = [];
  const seen = new Set<string>();
  for (const [quote, rows] of byQuote) {
    rows.sort((left, right) => {
      if (left.hasVolume !== right.hasVolume) return left.hasVolume ? -1 : 1;
      return right.quoteVolume.comparedTo(left.quoteVolume);
    });
    rows.slice(0, Math.max(0, options.maxBaseAssets)).forEach((candidate, rank) => {
      const key = `${candidate.market.base.toUpperCase()}|${quote}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        venueId: candidate.market.venueId,
        exchangeSymbol: candidate.market.exchangeSymbol,
        base: candidate.market.base.trim().toUpperCase(),
        quote,
        ...(candidate.hasVolume ? { quoteVolume24h: candidate.quoteVolume } : {}),
        tier: rank < 100 ? 'top100' : 'top500',
      });
    });
  }
  return result;
}

export interface LongTailVenueInput {
  venueId: string;
  markets: readonly MarketMetadata[];
  tickers: readonly TickerSnapshot[];
}

export interface LongTailVenueCandidate {
  venueId: string;
  market: MarketMetadata;
  quoteVolume24h: Decimal;
  tickerTimestamp: number;
  bid?: Decimal;
  ask?: Decimal;
}

export interface LongTailCandidate {
  base: string;
  quote: string;
  venues: LongTailVenueCandidate[];
  minQuoteVolume24h: Decimal;
  maxQuoteVolume24h: Decimal;
  /** Best cross-venue bid/ask spread from the ticker snapshot, before depth. */
  topTickerGrossBps?: Decimal;
}

export interface LongTailUniverseOptions {
  venues: readonly LongTailVenueInput[];
  quoteCurrencies: readonly string[];
  minQuoteVolumeUsd: Decimal;
  maxQuoteVolumeUsd: Decimal;
  minVenueCount?: number;
  maxCandidates?: number;
  maxTickerAgeMs?: number;
  now?: number;
}

function topTickerGrossBps(venues: readonly LongTailVenueCandidate[]): Decimal | undefined {
  let best: Decimal | undefined;
  for (const buy of venues) {
    if (!buy.ask || !buy.ask.gt(0)) continue;
    for (const sell of venues) {
      if (sell.venueId === buy.venueId || !sell.bid || !sell.bid.gt(0)) continue;
      const spread = sell.bid.div(buy.ask).minus(1).mul(10_000);
      if (!best || spread.gt(best)) best = spread;
    }
  }
  return best;
}

/**
 * Build a two-sided, low-volume universe. Unlike buildMarketUniverse, this
 * requires every selected venue to have a fresh ticker in the same volume band,
 * so the scanner cannot fill its quota with unrelated top-volume markets.
 *
 * The ceiling is applied to the most liquid leg, while the floor is applied to
 * the least liquid leg. This keeps pairs where one venue is nearly dead out of
 * the result while still allowing one venue to be much quieter than the other.
 */
export function buildLongTailUniverse(options: LongTailUniverseOptions): LongTailCandidate[] {
  if (options.maxQuoteVolumeUsd.lt(options.minQuoteVolumeUsd)) {
    throw new Error('maxQuoteVolumeUsd must be greater than or equal to minQuoteVolumeUsd');
  }
  const quotes = new Set(options.quoteCurrencies.map((quote) => quote.trim().toUpperCase()));
  const minVenueCount = Math.max(2, options.minVenueCount ?? 2);
  const maxTickerAgeMs = Math.max(0, options.maxTickerAgeMs ?? 15 * 60 * 1000);
  const now = options.now ?? Date.now();
  const groups = new Map<string, Map<string, LongTailVenueCandidate>>();

  for (const venue of options.venues) {
    const tickers = new Map(venue.tickers.map((ticker) => [ticker.exchangeSymbol, ticker]));
    for (const market of venue.markets) {
      if (!market.active) continue;
      const quote = market.quote.trim().toUpperCase();
      if (!quotes.has(quote)) continue;
      const ticker = tickers.get(market.exchangeSymbol);
      if (!ticker || !Number.isFinite(ticker.timestamp) || ticker.timestamp <= 0) continue;
      if (now - ticker.timestamp > maxTickerAgeMs) continue;
      const { value, hasVolume } = quoteVolumeFor(ticker);
      if (!hasVolume) continue;
      if (value.lt(options.minQuoteVolumeUsd) || value.gt(options.maxQuoteVolumeUsd)) continue;
      const base = market.base.trim().toUpperCase();
      const key = quote + '|' + base;
      const byVenue = groups.get(key) ?? new Map<string, LongTailVenueCandidate>();
      const existing = byVenue.get(venue.venueId);
      if (!existing || value.gt(existing.quoteVolume24h)) {
        byVenue.set(venue.venueId, {
          venueId: venue.venueId,
          market,
          quoteVolume24h: value,
          tickerTimestamp: ticker.timestamp,
          ...(ticker.bid && ticker.bid.gt(0) ? { bid: ticker.bid } : {}),
          ...(ticker.ask && ticker.ask.gt(0) ? { ask: ticker.ask } : {}),
        });
      }
      groups.set(key, byVenue);
    }
  }

  const candidates: LongTailCandidate[] = [];
  for (const [key, byVenue] of groups) {
    if (byVenue.size < minVenueCount) continue;
    const [quote, base] = key.split('|') as [string, string];
    const venues = [...byVenue.values()];
    const volumes = venues.map((venue) => venue.quoteVolume24h);
    const minVolume = Decimal.min(...volumes);
    const maxVolume = Decimal.max(...volumes);
    const topSpread = topTickerGrossBps(venues);
    candidates.push({
      base,
      quote,
      venues,
      minQuoteVolume24h: minVolume,
      maxQuoteVolume24h: maxVolume,
      ...(topSpread ? { topTickerGrossBps: topSpread } : {}),
    });
  }

  candidates.sort((left, right) => {
    if (left.topTickerGrossBps && right.topTickerGrossBps) {
      const spread = right.topTickerGrossBps.comparedTo(left.topTickerGrossBps);
      if (spread !== 0) return spread;
    } else if (left.topTickerGrossBps) {
      return -1;
    } else if (right.topTickerGrossBps) {
      return 1;
    }
    const volume = left.maxQuoteVolume24h.comparedTo(right.maxQuoteVolume24h);
    if (volume !== 0) return volume;
    return (left.base + '/' + left.quote).localeCompare(right.base + '/' + right.quote);
  });
  return candidates.slice(0, Math.max(0, options.maxCandidates ?? 200));
}
