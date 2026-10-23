import { describe, expect, it } from 'vitest';
import {
  ALIAS_PRICE_TOLERANCE_BPS,
  Decimal,
  canonicalAmountFromExchange,
  canonicalMarketForEvaluation,
  canonicalPriceFromExchange,
  evaluateS1Direction,
  exchangeAmountFromCanonical,
  exchangePriceFromCanonical,
  marketBaseMultiplier,
  marketExchangeBase,
  marketsShareUnderlying,
  normalizeBookForMarket,
  resolveBaseUnits,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '../src/index.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal(0),
  safetyBufferBps: new Decimal(0),
  minNetProfitBps: new Decimal(0),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal(0),
  maxTransferTaxBps: new Decimal(0),
};

function market(venueId: string, exchangeBase: string, multiplier?: Decimal): MarketMetadata {
  const alias = multiplier !== undefined && !multiplier.eq(1);
  return {
    venueId,
    exchangeSymbol: `${exchangeBase}/USDT`,
    unifiedSymbol: 'PEPE/USDT',
    base: 'PEPE',
    ...(alias ? { exchangeBase, baseMultiplier: multiplier } : {}),
    quote: 'USDT',
    active: true,
    pricePrecision: 9,
    amountPrecision: 2,
    amountStep: new Decimal('1'),
    priceStep: new Decimal('0.000000001'),
    minAmount: new Decimal('1000'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal(0),
  };
}

function rawBook(
  venueId: string,
  exchangeSymbol: string,
  ask: string,
  bid: string,
  amount: string,
): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol,
    fetchedAt: now,
    asks: [{ price: new Decimal(ask), amount: new Decimal(amount) }],
    bids: [{ price: new Decimal(bid), amount: new Decimal(amount) }],
    source: 'replay',
  };
}

describe('market base units', () => {
  it('resolves the explicit k aliases and 1000 prefix without stripping arbitrary k names', () => {
    expect(resolveBaseUnits('kPEPE')).toMatchObject({ base: 'PEPE', alias: true });
    expect(resolveBaseUnits('KPEPE').multiplier.toFixed()).toBe('1000');
    expect(resolveBaseUnits('1000BONK')).toMatchObject({ base: 'BONK', alias: true });
    expect(resolveBaseUnits('1000SATS').multiplier.toFixed()).toBe('1000');
    expect(resolveBaseUnits('KAITO')).toMatchObject({ base: 'KAITO', alias: false });
    expect(resolveBaseUnits('1000')).toMatchObject({ base: '1000', alias: false });
  });

  it('scales books, precision rules, and order values in both directions', () => {
    const source = market('weex', '1000PEPE', new Decimal(1000));
    const normalized = canonicalMarketForEvaluation(source);
    expect(normalized.amountStep?.toFixed()).toBe('1000');
    expect(normalized.minAmount?.toFixed()).toBe('1000000');
    expect(normalized.priceStep?.toFixed()).toBe('0.000000000001');
    expect(marketBaseMultiplier(normalized).toFixed()).toBe('1');
    expect(marketExchangeBase(source)).toBe('1000PEPE');

    const book = normalizeBookForMarket(
      rawBook('weex', '1000PEPE/USDT', '0.01', '0.0099', '2000'),
      source,
    );
    expect(book.asks[0]?.price.toFixed()).toBe('0.00001');
    expect(book.asks[0]?.amount.toFixed()).toBe('2000000');
    expect(book.bids[0]?.price.toFixed()).toBe('0.0000099');

    expect(exchangeAmountFromCanonical(new Decimal(1_000_000), new Decimal(1000)).toFixed()).toBe(
      '1000',
    );
    expect(canonicalAmountFromExchange(new Decimal(1000), new Decimal(1000)).toFixed()).toBe(
      '1000000',
    );
    expect(exchangePriceFromCanonical(new Decimal('0.00001'), new Decimal(1000)).toFixed()).toBe(
      '0.01',
    );
    expect(canonicalPriceFromExchange(new Decimal('0.01'), new Decimal(1000)).toFixed()).toBe(
      '0.00001',
    );
  });

  it('requires alias venues to agree on the normalized mid but leaves same-unit spreads alone', () => {
    const pepe = market('gateio', 'PEPE');
    const thousandPepe = market('weex', '1000PEPE', new Decimal(1000));
    expect(
      marketsShareUnderlying(
        pepe,
        rawBook('gateio', 'PEPE/USDT', '0.0000101', '0.0000099', '2000000'),
        thousandPepe,
        rawBook('weex', '1000PEPE/USDT', '0.0101', '0.0099', '2000'),
      ),
    ).toBe(true);
    expect(
      marketsShareUnderlying(
        pepe,
        rawBook('gateio', 'PEPE/USDT', '0.0000101', '0.0000099', '2000000'),
        thousandPepe,
        rawBook('weex', '1000PEPE/USDT', '0.02', '0.0199', '2000'),
      ),
    ).toBe(false);
    expect(
      marketsShareUnderlying(
        pepe,
        rawBook('gateio', 'PEPE/USDT', '0.00012', '0.00010', '2000000'),
        { ...pepe, venueId: 'mexc' },
        rawBook('mexc', 'PEPE/USDT', '0.0000101', '0.0000099', '2000000'),
        ALIAS_PRICE_TOLERANCE_BPS,
      ),
    ).toBe(true);
  });

  it('evaluates an alias route in canonical units and reports a canonical instrument', () => {
    const buyMarket = market('weex', '1000PEPE', new Decimal(1000));
    const sellMarket = market('gateio', 'PEPE');
    const result = evaluateS1Direction({
      base: 'PEPE',
      quote: 'USDT',
      buyMarket: canonicalMarketForEvaluation(buyMarket),
      sellMarket: canonicalMarketForEvaluation(sellMarket),
      buyBook: normalizeBookForMarket(
        rawBook('weex', '1000PEPE/USDT', '0.00995', '0.00990', '2000'),
        buyMarket,
      ),
      sellBook: normalizeBookForMarket(
        rawBook('gateio', 'PEPE/USDT', '0.00001010', '0.00001005', '2000000'),
        sellMarket,
      ),
      requestedNotional: new Decimal(10),
      settings,
      now,
    });
    expect(result.valid).toBe(true);
    expect(result.instrumentKey).toBe('PEPE/USDT');
    expect(result.buyDepth?.executableBaseAmount.gte('1000000')).toBe(true);
    expect(result.netProfitBps.gt(0)).toBe(true);
  });

  it('rejects an unnormalized alias market at the S1 boundary', () => {
    const buyMarket = market('weex', '1000PEPE', new Decimal(1000));
    const sellMarket = market('gateio', 'PEPE');
    const result = evaluateS1Direction({
      base: 'PEPE',
      quote: 'USDT',
      buyMarket,
      sellMarket,
      buyBook: rawBook('weex', '1000PEPE/USDT', '0.00995', '0.00990', '2000'),
      sellBook: rawBook('gateio', 'PEPE/USDT', '0.00001010', '0.00001005', '2000000'),
      requestedNotional: new Decimal(10),
      settings,
      now,
    });
    expect(result.valid).toBe(false);
    expect(result.rejectionReasons).toContain('invalid_request');
  });
});
