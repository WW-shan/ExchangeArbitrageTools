import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type TickerSnapshot } from '@arb/core';
import { buildMarketUniverse } from '../src/universe.js';

const now = 1_700_000_000_000;

function market(venueId: string, base: string, quote: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: `${base}/${quote}`,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
    active: true,
    pricePrecision: 3,
    amountPrecision: 3,
    amountStep: new Decimal('0.001'),
    priceStep: new Decimal('0.001'),
    feeTakerBps: new Decimal(10),
  };
}

function ticker(venueId: string, symbol: string, quoteVolume: string): TickerSnapshot {
  return {
    venueId,
    exchangeSymbol: symbol,
    quoteVolume: new Decimal(quoteVolume),
    timestamp: now,
  };
}

describe('market universe builder', () => {
  it('ranks by quote volume, filters small markets and applies tiers', () => {
    const markets = [
      market('gateio', 'CAKE', 'USDT'),
      market('gateio', 'ETH', 'USDT'),
      market('gateio', 'DOGE', 'USDT'),
      market('gateio', 'CAKE', 'USDC'),
    ];
    const tickers = [
      ticker('gateio', 'CAKE/USDT', '5000000'),
      ticker('gateio', 'ETH/USDT', '20000000'),
      ticker('gateio', 'DOGE/USDT', '100000'),
      ticker('gateio', 'CAKE/USDC', '2000000'),
    ];
    const universe = buildMarketUniverse({
      markets,
      tickers,
      quoteCurrencies: ['USDT', 'USDC'],
      maxBaseAssets: 2,
      minQuoteVolumeUsd: new Decimal('1000000'),
      now,
    });
    const usdt = universe.filter((entry) => entry.quote === 'USDT');
    expect(usdt.map((entry) => entry.base)).toEqual(['ETH', 'CAKE']);
    expect(usdt.every((entry) => entry.tier === 'top100')).toBe(true);
    expect(
      universe.find((entry) => entry.base === 'DOGE' && entry.quote === 'USDT'),
    ).toBeUndefined();
    expect(
      universe
        .find((entry) => entry.base === 'CAKE' && entry.quote === 'USDC')
        ?.quoteVolume24h?.toFixed(),
    ).toBe('2000000');
  });

  it('restricts the universe to explicit bases when configured', () => {
    const universe = buildMarketUniverse({
      markets: [market('gateio', 'CAKE', 'USDT'), market('gateio', 'ETH', 'USDT')],
      tickers: [],
      quoteCurrencies: ['USDT'],
      maxBaseAssets: 100,
      minQuoteVolumeUsd: new Decimal(0),
      explicitBaseAssets: ['CAKE'],
      now,
    });
    expect(universe.map((entry) => entry.base)).toEqual(['CAKE']);
  });

  it('keeps markets without ticker volume instead of dropping them', () => {
    const universe = buildMarketUniverse({
      markets: [market('gateio', 'CAKE', 'USDT')],
      tickers: [],
      quoteCurrencies: ['USDT'],
      maxBaseAssets: 10,
      minQuoteVolumeUsd: new Decimal('1000000'),
      now,
    });
    expect(universe).toHaveLength(1);
    expect(universe[0]?.quoteVolume24h).toBeUndefined();
  });
});
