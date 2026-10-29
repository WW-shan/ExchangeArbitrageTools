import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { reconcileCarriedInventory } from '../src/execution-reconcile.js';

const now = 1_700_000_000_000;
const batchId = 'S1-RECONCILE-TEST';

function seed(freeLight = '20') {
  const db = openDatabase(':memory:');
  const repository = new ArbitrageRepository(db);
  repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
  repository.upsertVenue({ id: 'hotcoin', type: 'cex', name: 'Hotcoin', tier: 'B', now });
  const executionId = repository.createExecution({
    strategy: 'S1',
    batchId,
    status: 'SAFE_STOP',
    plannedNotional: new Decimal('4'),
    expectedProfit: new Decimal('0.01'),
    openedAt: now,
    metadata: { states: ['LEG1_RECONCILING', 'SAFE_STOP'] },
  });
  repository.addExecutionLeg({
    executionId,
    legNumber: 1,
    venueId: 'gateio',
    side: 'buy',
    requestedAmount: new Decimal('16'),
    requestedPrice: new Decimal('0.2391'),
    status: 'filled',
    submittedAt: now,
  });
  db.prepare(
    `UPDATE execution_legs SET filled_amount = ?, average_fill_price = ?
     WHERE execution_id = ? AND leg_number = 1`,
  ).run('16', '0.23908', executionId);
  repository.addExecutionLeg({
    executionId,
    legNumber: 2,
    venueId: 'hotcoin',
    side: 'sell',
    requestedAmount: new Decimal('16'),
    requestedPrice: new Decimal('0.24'),
    status: 'planned',
  });
  repository.recordUnhedgedInventory({
    executionId,
    batchId,
    venueId: 'gateio',
    asset: 'LIGHT',
    amount: new Decimal('16'),
    usdValue: new Decimal('3.82528'),
    reason: 'post_fill_profit_not_positive',
    createdAt: now,
  });
  repository.recordBalance({
    venueId: 'gateio',
    accountId: 'default',
    currency: 'LIGHT',
    free: new Decimal(freeLight),
    used: new Decimal(0),
    total: new Decimal(freeLight),
    fetchedAt: now,
  });
  return { db, repository, executionId };
}

describe('SAFE_STOP carried-inventory reconciliation', () => {
  it('closes the execution', () => {
    const { db, repository } = seed('20');
    const result = reconcileCarriedInventory({
      db,
      repository,
      batchId,
      now,
      maxBalanceAgeMs: 60_000,
    });
    expect(result.status).toBe('RECONCILED');
    expect(result.resolvedUnhedgedIds).toHaveLength(1);
    expect(result.observedBalances[0]?.freeAmount).toBe('20');
    expect(repository.countOpenExecutions()).toBe(0);
    expect(repository.riskSnapshot(now).unhedgedInventoryRisk.toFixed()).toBe('0');
    const execution = db
      .prepare('SELECT status, closed_at, metadata_json FROM executions WHERE batch_id = ?')
      .get(batchId) as { status: string; closed_at: number; metadata_json: string };
    expect(execution.status).toBe('RECONCILED');
    expect(execution.closed_at).toBe(now);
    expect(JSON.parse(execution.metadata_json).resolution).toBe('carried_inventory');
    const audit = db
      .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'execution_reconciled'`)
      .get() as { count: number };
    expect(audit.count).toBe(1);
    repository.close();
  });

  it('fails closed when the verified balance is below the carried amount', () => {
    const { db, repository } = seed('10');
    expect(() =>
      reconcileCarriedInventory({
        db,
        repository,
        batchId,
        now,
        maxBalanceAgeMs: 60_000,
      }),
    ).toThrow(/insufficient free LIGHT/);
    expect(repository.countOpenExecutions()).toBe(1);
    const unhedged = db
      .prepare(`SELECT COUNT(*) AS count FROM unhedged_inventory WHERE status = 'open'`)
      .get() as { count: number };
    expect(unhedged.count).toBe(1);
    repository.close();
  });

  it('aggregates multiple unhedged rows before checking the balance', () => {
    const { db, repository, executionId } = seed('20');
    repository.recordUnhedgedInventory({
      executionId,
      batchId,
      venueId: 'gateio',
      asset: 'LIGHT',
      amount: new Decimal('10'),
      usdValue: new Decimal('2.39'),
      reason: 'partial_leg',
      createdAt: now,
    });
    expect(() =>
      reconcileCarriedInventory({
        db,
        repository,
        batchId,
        now,
        maxBalanceAgeMs: 60_000,
      }),
    ).toThrow(/need 26/);
    repository.close();
  });
});
