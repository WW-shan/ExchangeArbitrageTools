import { describe, expect, it } from 'vitest';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  runReplay,
  type ReplayBook,
  type ReplayFixture,
  type ReplayMarket,
} from '../src/replay.js';

const start = 1_700_000_000_000;

function market(venueId: string): ReplayMarket {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 3,
    amountPrecision: 3,
    amountStep: '0.001',
    priceStep: '0.001',
    minAmount: '0.01',
    minNotional: '1',
    feeTakerBps: '10',
    supportsIoc: true,
    supportsFok: false,
  };
}

function book(venueId: string, ask: string, bid: string, at: number): ReplayBook {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: at,
    asks: [[ask, '100']],
    bids: [[bid, '100']],
    source: 'replay',
  };
}

function fixture(): ReplayFixture {
  const bids = ['2.55', '2.54', '2.53', '2.45', '2.45'];
  return {
    name: 'Replay lifetime test',
    requestedNotional: '30',
    settings: {
      minProfitUsd: '0.05',
      safetyBufferBps: '10',
      minNetProfitBps: '5',
      maxOrderbookAgeMs: 3000,
      maxSlippageBps: '50',
      maxGasCostUsd: '0.50',
      maxTransferTaxBps: '0',
    },
    markets: { gateio: market('gateio'), mexc: market('mexc') },
    samples: bids.map((bid, index) => {
      const at = start + index * 5_000;
      return {
        sampledAt: at,
        gateio: book('gateio', '2.5', '2.49', at),
        mexc: book('mexc', '2.57', bid, at),
      };
    }),
  };
}

describe('historical replay', () => {
  it('reports opportunity lifetime and profit decay', async () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    const report = await runReplay(fixture(), { repository });
    expect(report.samples).toBe(5);
    expect(report.scanned).toBe(5);
    expect(report.errors).toBe(0);
    expect(report.validOpportunities).toBeGreaterThanOrEqual(3);
    expect(
      report.opportunitiesByStrategy.find((row) => row.strategy === 'S1')?.valid,
    ).toBeGreaterThanOrEqual(3);
    const episode = report.episodes.find((row) => row.strategy === 'S1');
    expect(episode).toBeDefined();
    expect(episode!.totalSamples).toBeGreaterThanOrEqual(3);
    expect(episode!.openEpisodes).toBe(0);
    expect(episode!.medianDurationMs).toBe(10_000);
    const decay = report.decay.find((row) => row.strategy === 'S1');
    expect(decay).toBeDefined();
    expect(decay!.medianDecayBps.lt(0)).toBe(true);
    expect(decay!.decayingEpisodes).toBe(1);
    repository.close();
  });

  it('enables cross-venue inventory replay when balances are provided', async () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    const withBalances = fixture();
    withBalances.balances = [
      { venueId: 'gateio', currency: 'USDT', free: '1000' },
      { venueId: 'mexc', currency: 'CAKE', free: '100' },
    ];
    const report = await runReplay(withBalances, { repository });
    expect(
      report.opportunitiesByStrategy.some((row) => row.strategy === 'S2' && row.valid > 0),
    ).toBe(true);
    repository.close();
  });
});
