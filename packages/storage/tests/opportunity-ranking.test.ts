import { describe, expect, it } from 'vitest';
import {
  Decimal,
  evaluateS1Direction,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.01'),
  safetyBufferBps: new Decimal(0),
  minNetProfitBps: new Decimal(1),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};

function market(venueId: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 3,
    amountPrecision: 3,
    amountStep: new Decimal('0.001'),
    priceStep: new Decimal('0.001'),
    minAmount: new Decimal('0.01'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal('10'),
    supportsIoc: true,
  };
}

function book(venueId: string, ask: string, bid: string, at: number): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: at,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    source: 'replay',
  };
}

function opportunity(at: number, sellBid: string) {
  const result = evaluateS1Direction({
    base: 'CAKE',
    quote: 'USDT',
    buyMarket: market('gateio'),
    sellMarket: market('mexc'),
    buyBook: book('gateio', '2.500', '2.490', at),
    sellBook: book('mexc', new Decimal(sellBid).plus('0.01').toFixed(3), sellBid, at),
    requestedNotional: new Decimal(30),
    settings,
    now: at,
    venueHealth: { gateio: 'B', mexc: 'B' },
  });
  expect(result.valid).toBe(true);
  return result;
}

describe('S1 opportunity ranking', () => {
  it('selects the highest score instead of the newest row', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    const strong = repo.recordOpportunity(opportunity(now - 1000, '2.560'));
    const weak = repo.recordOpportunity(opportunity(now, '2.520'));
    const best = repo.bestValidS1Opportunity({ now, maxAgeMs: 15_000 });
    expect(best?.id).toBe(strong.id);
    expect(repo.latestValidS1Opportunity()?.id).toBe(weak.id);
    repo.close();
  });

  it('skips opportunities older than their measured lifetime', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    repo.recordOpportunity(opportunity(now - 10_000, '2.560'));
    repo.recordOpportunity(opportunity(now - 8_000, '2.560'));
    repo.closeStaleEpisodes(now + 20_000, 15_000);
    expect(
      repo.medianEpisodeDurationMs('S1', 'S1|CAKE/USDT|gateio|mexc', 'gateio->mexc'),
    ).toBeGreaterThan(0);
    const best = repo.bestValidS1Opportunity({ now: now + 1000, maxAgeMs: 20_000 });
    expect(best).toBeUndefined();
    repo.close();
  });

  it('returns only recent valid opportunities for the requested rotation instruments', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    repo.recordOpportunity(opportunity(now - 500, '2.560'));
    const rows = repo.recentValidS1Opportunities({
      now,
      maxAgeMs: 5000,
      instruments: ['cake/usdt'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.opportunity.instrumentKey).toBe('CAKE/USDT');
    expect(
      repo.recentValidS1Opportunities({
        now,
        maxAgeMs: 5000,
        instruments: ['KAT/USDT'],
      }),
    ).toEqual([]);
    repo.close();
  });
});
