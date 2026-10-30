import { describe, expect, it } from 'vitest';
import {
  Decimal,
  assessRotationReadiness,
  type MarketMetadata,
  type OpportunityResult,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ExecutorConfig } from '../src/config.js';
import {
  isRotationExecutionVenue,
  pairBalances,
  selectInventoryFundingPairs,
  selectInventoryRebalanceTarget,
} from '../src/auto-supervisor.js';

const now = 1_700_000_000_000;

function market(
  venueId: string,
  exchangeSymbol: string,
  base = 'LIGHT',
  quote = 'USDT',
): MarketMetadata {
  return {
    venueId,
    exchangeSymbol,
    unifiedSymbol: `${base}/${quote}`,
    base,
    quote,
    active: true,
    pricePrecision: 5,
    amountPrecision: 2,
    amountStep: new Decimal('0.01'),
    priceStep: new Decimal('0.00001'),
    feeTakerBps: new Decimal('4'),
  };
}

function repositoryWithVenues(): ArbitrageRepository {
  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
  repository.upsertVenue({ id: 'hotcoin', type: 'cex', name: 'Hotcoin', tier: 'B', now });
  return repository;
}

function rebalanceOpportunity(
  base: string,
  sampledAt: number,
  netProfitBps: string,
  rejectionReasons: OpportunityResult['rejectionReasons'] = ['insufficient_balance'],
): OpportunityResult {
  const profit = new Decimal(netProfitBps);
  return {
    strategy: 'S1',
    opportunityKey: `${base}/USDT:gateio->bitget`,
    instrumentKey: `${base}/USDT`,
    direction: 'gateio->bitget',
    venueBuy: 'gateio',
    venueSell: 'bitget',
    instrumentBuy: `${base}/USDT`,
    instrumentSell: `${base}/USDT`,
    requestedNotional: new Decimal(5),
    grossSpread: new Decimal(0.05),
    totalCost: new Decimal(0.01),
    depthNetProfit: new Decimal(0.04),
    conservativeNetProfit: new Decimal(0.04),
    netProfitBps: profit,
    dataAgeMs: 100,
    valid: false,
    rejectionReasons,
    sampledAt,
  };
}

describe('rotation balance snapshot', () => {
  it('allows live execution only on Gate and Hotcoin', () => {
    expect(isRotationExecutionVenue('gateio')).toBe(true);
    expect(isRotationExecutionVenue('HOTCOIN')).toBe(true);
    expect(isRotationExecutionVenue('weex')).toBe(false);
    expect(isRotationExecutionVenue('bitget')).toBe(false);
  });

  it('treats a missing zero-balance asset as zero when the venue snapshot is fresh', () => {
    const repository = repositoryWithVenues();
    repository.recordBalance({
      venueId: 'gateio',
      accountId: 'spot',
      currency: 'USDT',
      free: new Decimal(10),
      used: new Decimal(0),
      total: new Decimal(10),
      fetchedAt: now,
    });
    repository.recordBalance({
      venueId: 'hotcoin',
      accountId: 'spot',
      currency: 'USDT',
      free: new Decimal(20),
      used: new Decimal(0),
      total: new Decimal(20),
      fetchedAt: now,
    });
    const balances = pairBalances(
      repository,
      {
        base: 'LIGHT',
        quote: 'USDT',
        maxNotional: new Decimal(20),
        venues: ['gateio', 'hotcoin'] as const,
      },
      {
        gateio: [market('gateio', 'LIGHT/USDT')],
        hotcoin: [market('hotcoin', 'light_usdt')],
      },
      now,
      30_000,
    );
    expect(balances.fresh).toBe(true);
    expect(balances.readinessBalances.gateBase.toFixed()).toBe('0');
    expect(balances.readinessBalances.hotcoinBase.toFixed()).toBe('0');
    const readiness = assessRotationReadiness(balances.readinessBalances, {
      buyQuote: new Decimal(10),
      sellBase: new Decimal(30),
    });
    expect(readiness.state).toBe('WAIT');
    repository.close();
  });

  it('fails closed when a venue balance snapshot is stale', () => {
    const repository = repositoryWithVenues();
    repository.recordBalance({
      venueId: 'gateio',
      accountId: 'spot',
      currency: 'USDT',
      free: new Decimal(10),
      used: new Decimal(0),
      total: new Decimal(10),
      fetchedAt: now - 60_000,
    });
    repository.recordBalance({
      venueId: 'hotcoin',
      accountId: 'spot',
      currency: 'USDT',
      free: new Decimal(20),
      used: new Decimal(0),
      total: new Decimal(20),
      fetchedAt: now,
    });
    const balances = pairBalances(
      repository,
      {
        base: 'LIGHT',
        quote: 'USDT',
        maxNotional: new Decimal(20),
        venues: ['gateio', 'hotcoin'] as const,
      },
      {
        gateio: [market('gateio', 'LIGHT/USDT')],
        hotcoin: [market('hotcoin', 'light_usdt')],
      },
      now,
      30_000,
    );
    expect(balances.fresh).toBe(false);
    expect(balances.reasons).toContain('gateio_balance_snapshot_stale');
    repository.close();
  });
});

describe('inventory funding pair selection', () => {
  it('tries the target pair first, then other pairs with the most base inventory', () => {
    const repository = repositoryWithVenues();
    repository.upsertVenue({ id: 'bitget', type: 'cex', name: 'Bitget', tier: 'S', now });
    for (const [currency, free] of [
      ['WARD', '0'],
      ['KAT', '1'],
      ['LIGHT', '20'],
      ['LA', '100'],
    ] as const) {
      repository.recordBalance({
        venueId: 'gateio',
        accountId: 'spot',
        currency,
        free: new Decimal(free),
        used: new Decimal(0),
        total: new Decimal(free),
        fetchedAt: now,
      });
    }
    const pairs = [
      {
        base: 'WARD',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
      {
        base: 'KAT',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
      {
        base: 'LIGHT',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
      {
        base: 'LA',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
    ];
    const selected = selectInventoryFundingPairs({
      repository,
      pairs,
      targetPair: pairs[0]!,
      trigger: {
        venueId: 'gateio',
        otherVenueId: 'bitget',
        edgeBps: new Decimal(100),
        sampledAt: now,
      },
      markets: {
        gateio: [
          market('gateio', 'WARD/USDT', 'WARD'),
          market('gateio', 'KAT/USDT', 'KAT'),
          market('gateio', 'LIGHT/USDT', 'LIGHT'),
          market('gateio', 'LA/USDT', 'LA'),
        ],
      },
      now,
    });
    expect(selected.map((pair) => `${pair.base}/${pair.quote}`)).toEqual([
      'WARD/USDT',
      'LA/USDT',
      'LIGHT/USDT',
      'KAT/USDT',
    ]);
    repository.close();
  });

  it('uses the freshest balance-blocked opportunity across all pairs', () => {
    const repository = repositoryWithVenues();
    repository.upsertVenue({ id: 'bitget', type: 'cex', name: 'Bitget', tier: 'S', now });
    repository.recordOpportunity(rebalanceOpportunity('WARD', now - 5_000, '300'));
    repository.recordOpportunity(rebalanceOpportunity('KAT', now - 1_000, '100'));
    const pairs = [
      {
        base: 'WARD',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
      {
        base: 'KAT',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
    ];
    const target = selectInventoryRebalanceTarget({
      repository,
      pairs,
      now,
      config: {
        rebalanceSignalMaxAgeMs: 15_000,
        minRebalanceEdgeBps: new Decimal(50),
      } as ExecutorConfig['autoRotation']['inventory'],
    });
    expect(target?.pair.base).toBe('KAT');
    expect(target?.trigger.sampledAt).toBe(now - 1_000);
    repository.close();
  });

  it('accepts balance-limited signals with derived notional and depth rejections', () => {
    const repository = repositoryWithVenues();
    repository.upsertVenue({ id: 'bitget', type: 'cex', name: 'Bitget', tier: 'S', now });
    repository.recordOpportunity(
      rebalanceOpportunity('WARD', now - 1_000, '180', [
        'insufficient_balance',
        'below_min_notional',
        'insufficient_depth',
      ]),
    );
    const pairs = [
      {
        base: 'WARD',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
    ];
    const target = selectInventoryRebalanceTarget({
      repository,
      pairs,
      now,
      config: {
        rebalanceSignalMaxAgeMs: 15_000,
        minRebalanceEdgeBps: new Decimal(50),
      } as ExecutorConfig['autoRotation']['inventory'],
    });
    expect(target?.pair.base).toBe('WARD');
    repository.close();
  });

  it('rejects a balance-limited signal that also has a hard market-data failure', () => {
    const repository = repositoryWithVenues();
    repository.upsertVenue({ id: 'bitget', type: 'cex', name: 'Bitget', tier: 'S', now });
    repository.recordOpportunity(
      rebalanceOpportunity('WARD', now - 1_000, '180', ['insufficient_balance', 'stale_orderbook']),
    );
    const pairs = [
      {
        base: 'WARD',
        quote: 'USDT',
        maxNotional: new Decimal(10),
        venues: ['gateio', 'bitget'] as const,
      },
    ];
    const target = selectInventoryRebalanceTarget({
      repository,
      pairs,
      now,
      config: {
        rebalanceSignalMaxAgeMs: 15_000,
        minRebalanceEdgeBps: new Decimal(50),
      } as ExecutorConfig['autoRotation']['inventory'],
    });
    expect(target).toBeUndefined();
    repository.close();
  });
});
