import { describe, expect, it } from 'vitest';
import { Decimal, assessRotationReadiness, type MarketMetadata } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { isRotationExecutionVenue, pairBalances } from '../src/auto-supervisor.js';

const now = 1_700_000_000_000;

function market(venueId: string, exchangeSymbol: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol,
    unifiedSymbol: 'LIGHT/USDT',
    base: 'LIGHT',
    quote: 'USDT',
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
