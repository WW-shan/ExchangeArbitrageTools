import { describe, expect, it } from 'vitest';
import { Decimal, type OpportunityResult } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';

const now = 1_700_000_000_000;

function opportunity(
  at: number,
  venueBuy: string,
  venueSell: string,
  valid: boolean,
  netBps: string,
): OpportunityResult {
  return {
    strategy: 'S1',
    opportunityKey: `S1|CAKE/USDT|${venueBuy}|${venueSell}`,
    instrumentKey: 'CAKE/USDT',
    direction: `${venueBuy}->${venueSell}`,
    venueBuy,
    venueSell,
    instrumentBuy: 'CAKE/USDT',
    instrumentSell: 'CAKE/USDT',
    requestedNotional: new Decimal(30),
    grossSpread: new Decimal(0.1),
    totalCost: new Decimal(0.01),
    depthNetProfit: new Decimal(0.09),
    conservativeNetProfit: new Decimal(0.08),
    netProfitBps: new Decimal(netBps),
    dataAgeMs: 10,
    valid,
    rejectionReasons: valid ? [] : ['conservative_profit_below_threshold'],
    sampledAt: at,
  };
}

describe('S1 route stats', () => {
  it('ranks routes by valid samples and reports episode lifetime', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    repo.recordOpportunity(opportunity(now, 'gateio', 'mexc', true, '12'), 15_000);
    repo.recordOpportunity(opportunity(now + 1000, 'gateio', 'mexc', true, '15'), 15_000);
    repo.recordOpportunity(opportunity(now + 2000, 'gateio', 'mexc', true, '18'), 15_000);
    repo.recordOpportunity(opportunity(now + 1000, 'mexc', 'gateio', false, '-4'), 15_000);
    const stats = repo.s1RouteStats({ now: now + 3000, sinceMs: 10_000 });
    expect(stats).toHaveLength(2);
    expect(stats[0]!.venueBuy).toBe('gateio');
    expect(stats[0]!.validSamples).toBe(3);
    expect(stats[0]!.samples).toBe(3);
    expect(stats[0]!.evaluatedSamples).toBe(3);
    expect(stats[0]!.evaluationRate).toBe(1);
    expect(stats[0]!.validRate).toBe(1);
    expect(stats[0]!.avgNetBps.toNumber()).toBeCloseTo(15, 5);
    expect(stats[0]!.maxNetBps.toNumber()).toBe(18);
    expect(stats[0]!.episodes).toBe(1);
    expect(stats[0]!.medianDurationMs).toBe(2000);
    expect(stats[1]!.validSamples).toBe(0);
    expect(stats[1]!.samples).toBe(1);
    expect(stats[1]!.evaluatedSamples).toBe(1);
    expect(stats[1]!.evaluationRate).toBe(1);
    repo.close();
  });
});
