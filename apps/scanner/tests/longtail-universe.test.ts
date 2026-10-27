import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type TickerSnapshot } from '@arb/core';
import { buildLongTailUniverse, type LongTailVenueInput } from '../src/universe.js';

const now = 1_700_000_000_000;

function market(venueId: string, base: string, quote = 'USDT'): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: base + '/' + quote,
    unifiedSymbol: base + '/' + quote,
    base,
    quote,
    active: true,
    pricePrecision: 5,
    amountPrecision: 2,
    amountStep: new Decimal('0.01'),
    priceStep: new Decimal('0.00001'),
    feeTakerBps: new Decimal(10),
  };
}

function ticker(
  venueId: string,
  symbol: string,
  quoteVolume: string,
  bid?: string,
  ask?: string,
): TickerSnapshot {
  return {
    venueId,
    exchangeSymbol: symbol,
    quoteVolume: new Decimal(quoteVolume),
    ...(bid ? { bid: new Decimal(bid) } : {}),
    ...(ask ? { ask: new Decimal(ask) } : {}),
    timestamp: now,
  };
}

function venue(
  venueId: string,
  markets: MarketMetadata[],
  tickers: TickerSnapshot[],
): LongTailVenueInput {
  return { venueId, markets, tickers };
}

describe('long-tail universe', () => {
  it('keeps only shared bases where every venue is inside the volume band', () => {
    const gate = venue(
      'gateio',
      [
        market('gateio', 'INC'),
        market('gateio', 'AB'),
        market('gateio', 'HIGH'),
        market('gateio', 'GATEONLY'),
      ],
      [
        ticker('gateio', 'INC/USDT', '19000', '0.99', '1.00'),
        ticker('gateio', 'AB/USDT', '600000', '0.99', '1.00'),
        ticker('gateio', 'HIGH/USDT', '1000000', '0.99', '1.00'),
        ticker('gateio', 'GATEONLY/USDT', '20000', '0.99', '1.00'),
      ],
    );
    const hotcoin = venue(
      'hotcoin',
      [market('hotcoin', 'INC'), market('hotcoin', 'AB'), market('hotcoin', 'HIGH')],
      [
        ticker('hotcoin', 'INC/USDT', '9000', '1.01', '1.02'),
        ticker('hotcoin', 'AB/USDT', '8000', '1.01', '1.02'),
        ticker('hotcoin', 'HIGH/USDT', '1000000', '1.01', '1.02'),
      ],
    );
    const result = buildLongTailUniverse({
      venues: [gate, hotcoin],
      quoteCurrencies: ['USDT'],
      minQuoteVolumeUsd: new Decimal(1000),
      maxQuoteVolumeUsd: new Decimal(500000),
      now,
    });
    expect(result.map((candidate) => candidate.base)).toEqual(['INC']);
    expect(result[0]?.minQuoteVolume24h.toFixed()).toBe('9000');
    expect(result[0]?.maxQuoteVolume24h.toFixed()).toBe('19000');
    expect(result[0]?.topTickerGrossBps?.toFixed()).toBe('100');
  });

  it('rejects missing tickers, zero volume, and stale ticker snapshots', () => {
    const result = buildLongTailUniverse({
      venues: [
        venue(
          'gateio',
          [market('gateio', 'A'), market('gateio', 'B'), market('gateio', 'C')],
          [
            ticker('gateio', 'A/USDT', '10000'),
            ticker('gateio', 'B/USDT', '0'),
            { ...ticker('gateio', 'C/USDT', '10000'), timestamp: now - 3_600_000 },
          ],
        ),
        venue(
          'hotcoin',
          [market('hotcoin', 'A'), market('hotcoin', 'B'), market('hotcoin', 'C')],
          [
            ticker('hotcoin', 'A/USDT', '10000'),
            ticker('hotcoin', 'B/USDT', '10000'),
            ticker('hotcoin', 'C/USDT', '10000'),
          ],
        ),
      ],
      quoteCurrencies: ['USDT'],
      minQuoteVolumeUsd: new Decimal(1000),
      maxQuoteVolumeUsd: new Decimal(500000),
      maxTickerAgeMs: 60_000,
      now,
    });
    expect(result.map((candidate) => candidate.base)).toEqual(['A']);
  });

  it('ranks by the best ticker spread, then by lower maximum volume', () => {
    const gate = venue(
      'gateio',
      [market('gateio', 'AAA'), market('gateio', 'BBB')],
      [
        ticker('gateio', 'AAA/USDT', '20000', '0.99', '1.00'),
        ticker('gateio', 'BBB/USDT', '20000', '0.99', '1.00'),
      ],
    );
    const hotcoin = venue(
      'hotcoin',
      [market('hotcoin', 'AAA'), market('hotcoin', 'BBB')],
      [
        ticker('hotcoin', 'AAA/USDT', '10000', '1.005', '1.02'),
        ticker('hotcoin', 'BBB/USDT', '10000', '1.02', '1.03'),
      ],
    );
    const result = buildLongTailUniverse({
      venues: [gate, hotcoin],
      quoteCurrencies: ['USDT'],
      minQuoteVolumeUsd: new Decimal(1000),
      maxQuoteVolumeUsd: new Decimal(500000),
      now,
    });
    expect(result.map((candidate) => candidate.base)).toEqual(['BBB', 'AAA']);
  });
});
