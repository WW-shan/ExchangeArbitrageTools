import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { assessRotationReadiness, type OpportunityResult } from '@arb/core';
import type { LoadedOpportunity } from '@arb/storage';
import {
  decideAutoRotation,
  rotationDirection,
  rotationRequirementFromOpportunity,
} from '../src/auto-rotation.js';

const d = (value: string): Decimal => new Decimal(value);
const now = 1_700_000_000_000;

function loaded(direction: string, notional = '20'): LoadedOpportunity {
  const [venueBuy, venueSell] = direction.split('->');
  const opportunity: OpportunityResult = {
    strategy: 'S1',
    opportunityKey: `S1|KAT/USDT|${venueBuy}|${venueSell}`,
    instrumentKey: 'KAT/USDT',
    direction,
    venueBuy: venueBuy!,
    venueSell: venueSell!,
    instrumentBuy: 'KAT/USDT',
    instrumentSell: 'KAT/USDT',
    requestedNotional: d(notional),
    grossSpread: d('0.4'),
    totalCost: d('0.2'),
    depthNetProfit: d('0.2'),
    conservativeNetProfit: d('0.1'),
    netProfitBps: d('50'),
    dataAgeMs: 100,
    valid: true,
    rejectionReasons: [],
    sampledAt: now,
    metadata: { buyDepthWorstPrice: '0.004' },
  };
  return { id: 1, opportunity };
}

function readiness(state: 'gate' | 'hot' | 'none' = 'gate') {
  return assessRotationReadiness(
    {
      gateBase: d(state === 'hot' ? '5000' : '0'),
      gateQuote: d(state === 'gate' ? '50' : '0'),
      hotcoinBase: d(state === 'gate' ? '5000' : '0'),
      hotcoinQuote: d(state === 'hot' ? '50' : '0'),
    },
    { buyQuote: d('20'), sellBase: d('5000') },
  );
}

function input(overrides: Partial<Parameters<typeof decideAutoRotation>[0]> = {}) {
  return {
    loaded: loaded('gateio->hotcoin'),
    ageMs: 1000,
    pair: { base: 'KAT', quote: 'USDT', maxNotional: d('20') },
    readiness: readiness('gate'),
    liveEnabled: true,
    autoExecutionEnabled: true,
    persistedAutoExecutionEnabled: true,
    killSwitch: false,
    openExecutions: 0,
    unresolvedOrders: 0,
    alreadyExecuted: false,
    dailyRealizedLoss: d('0'),
    dailyMaxLoss: d('5'),
    maxOrderNotional: d('20'),
    maxSignalAgeMs: 15_000,
    now,
    cooldownMs: 5000,
    ...overrides,
  };
}

describe('automatic two-sided rotation decision', () => {
  it('executes only the funded direction and requires every live gate', () => {
    expect(decideAutoRotation(input())).toMatchObject({
      action: 'EXECUTE',
      direction: 'gate->hotcoin',
    });
    expect(decideAutoRotation(input({ readiness: readiness('hot') }))).toMatchObject({
      action: 'WAIT',
      reasons: expect.arrayContaining(['direction_not_funded']),
    });
    expect(decideAutoRotation(input({ killSwitch: true })).reasons).toContain('kill_switch_on');
    expect(decideAutoRotation(input({ persistedAutoExecutionEnabled: false })).reasons).toContain(
      'persisted_auto_execution_disabled',
    );
  });

  it('rejects stale, non-whitelisted, oversized, duplicate, and loss-limited signals', () => {
    expect(decideAutoRotation(input({ ageMs: 20_000 })).reasons).toContain('stale_signal');
    expect(decideAutoRotation(input({ pair: undefined })).reasons).toContain(
      'pair_not_whitelisted',
    );
    expect(
      decideAutoRotation(input({ loaded: loaded('gateio->hotcoin', '21') })).reasons,
    ).toContain('notional_above_pair_limit');
    expect(decideAutoRotation(input({ alreadyExecuted: true })).reasons).toContain(
      'opportunity_already_executed',
    );
    expect(decideAutoRotation(input({ dailyRealizedLoss: d('5') })).reasons).toContain(
      'daily_loss_limit',
    );
    expect(decideAutoRotation(input({ openExecutions: 1 })).reasons).toContain('open_execution');
  });

  it('supports the reverse route and derives a conservative base requirement', () => {
    expect(rotationDirection(loaded('hotcoin->gateio'))).toBe('hotcoin->gate');
    const requirement = rotationRequirementFromOpportunity(loaded('gateio->hotcoin'), 20);
    expect(requirement?.buyQuote.toFixed()).toBe('20.04');
    expect(requirement?.sellBase.toFixed()).toBe('5000');
  });
});
