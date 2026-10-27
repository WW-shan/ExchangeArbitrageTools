import { describe, expect, it } from 'vitest';
import {
  CEX_TIERS,
  VENUE_CATALOG,
  createCexAdapter,
  createCcxtAdapter,
  createPublicRuntime,
  resolveCcxtExchangeId,
  venueDefinition,
} from '../src/index.js';

describe('venue catalog', () => {
  it('contains the mainstream CEX and DEX venues', () => {
    for (const id of [
      'gateio',
      'mexc',
      'weex',
      'binance',
      'okx',
      'bybit',
      'bitget',
      'kucoin',
      'htx',
      'coinbase',
      'kraken',
      'bingx',
      'phemex',
      'whitebit',
      'upbit',
      'bitstamp',
      'gemini',
      'bitfinex',
      'blockchaincom',
      'bigone',
      'hitbtc',
      'btse',
      'cex',
      'digifinex',
      'p2b',
      'deepcoin',
      'hashkey',
      'hyperliquid',
      'lighter',
      'aster',
      'dydx',
      'paradex',
      'extended',
      'apex',
      'derive',
    ]) {
      expect(VENUE_CATALOG[id], id).toBeDefined();
    }
    expect(resolveCcxtExchangeId('gateio')).toBe('gate');
  });

  it('marks spot venues S1-eligible and perp-only venues reference-only', () => {
    expect(venueDefinition('binance')?.marketType).toBe('spot');
    expect(venueDefinition('hyperliquid')?.marketType).toBe('spot');
    expect(venueDefinition('lighter')?.marketType).toBe('spot');
    expect(venueDefinition('dydx')?.marketType).toBe('perp');
    expect(venueDefinition('dydx')?.s1Eligible).toBe(false);
    expect(venueDefinition('paradex')?.s1Eligible).toBe(false);
    expect(venueDefinition('extended')?.s1Eligible).toBe(false);
    expect(venueDefinition('apex')?.s1Eligible).toBe(false);
    expect(venueDefinition('derive')?.s1Eligible).toBe(false);
    expect(venueDefinition('bingx')?.marketType).toBe('spot');
    expect(venueDefinition('phemex')?.marketType).toBe('spot');
    expect(venueDefinition('whitebit')?.marketType).toBe('spot');
  });

  it('constructs an adapter for every catalog entry without network access', () => {
    for (const definition of Object.values(VENUE_CATALOG)) {
      const adapter = createCexAdapter(definition.id, createPublicRuntime(1), {
        readOnly: true,
      });
      expect(adapter.venueId).toBe(definition.id);
      expect(adapter.tier).toBe(definition.tier);
    }
    expect(CEX_TIERS.binance).toBe('A');
    expect(CEX_TIERS.hotcoin).toBe('S');
    expect(CEX_TIERS.dydx).toBeUndefined();
  });

  it('routes Hotcoin through its custom adapter instead of CCXT', () => {
    expect(() => createCcxtAdapter('hotcoin', createPublicRuntime(1))).toThrow(/HotcoinAdapter/);
    const adapter = createCexAdapter('hotcoin', createPublicRuntime(1), { readOnly: true });
    expect(adapter.venueId).toBe('hotcoin');
    expect(adapter.capabilities.websocket).toBe(true);
  });
});
