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
