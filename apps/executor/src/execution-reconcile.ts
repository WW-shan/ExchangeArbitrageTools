import type { DatabaseSync } from 'node:sqlite';
import { Decimal } from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';

interface ExecutionRow {
  id: number;
  status: string;
  closed_at: number | null;
  metadata_json: string | null;
}

interface LegRow {
  leg_number: number;
  venue_id: string;
  side: string;
  status: string;
  filled_amount: string | null;
}

interface UnhedgedRow {
  id: number;
  venue_id: string;
  asset: string;
  amount: string;
  direction: string;
  reason: string;
}

export interface CarriedInventoryObservation {
  unhedgedIds: number[];
  venueId: string;
  asset: string;
  requiredAmount: string;
  freeAmount: string;
}

export interface CarriedInventoryReconciliation {
  batchId: string;
  executionId: number;
  previousStatus: string;
  status: 'RECONCILED';
  resolvedUnhedgedIds: number[];
  observedBalances: CarriedInventoryObservation[];
  reconciledAt: string;
}

export interface NoFillReconciliation {
  batchId: string;
  executionId: number;
  previousStatus: string;
  status: 'RECONCILED';
  reconciledAt: string;
}

function metadataObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('execution metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve a SAFE_STOP execution by carrying its unhedged long inventory as
 * deliberate inventory. This never submits an order and never clears the kill
 * switch. The operator must refresh balances immediately before running it.
 */
export function reconcileCarriedInventory(input: {
  db: DatabaseSync;
  repository: ArbitrageRepository;
  batchId: string;
  now?: number;
  maxBalanceAgeMs?: number;
}): CarriedInventoryReconciliation {
  const { db, repository, batchId } = input;
  const now = input.now ?? Date.now();
  const maxBalanceAgeMs = Math.max(0, input.maxBalanceAgeMs ?? 300_000);
  const execution = db
    .prepare('SELECT id, status, closed_at, metadata_json FROM executions WHERE batch_id = ?')
    .get(batchId) as ExecutionRow | undefined;
  if (!execution) throw new Error(`execution not found: ${batchId}`);
  if (execution.status !== 'SAFE_STOP') {
    throw new Error(`execution ${batchId} is ${execution.status}, not SAFE_STOP`);
  }
  if (execution.closed_at !== null) {
    throw new Error(`execution ${batchId} is already closed`);
  }
  if (repository.countOpenExecutions() !== 1) {
    throw new Error('reconciliation requires exactly one open execution');
  }
  if (repository.countUnresolvedOrders() > 0) {
    throw new Error('unresolved orders exist; reconcile the exchange order state first');
  }

  const legs = db
    .prepare(
      `SELECT leg_number, venue_id, side, status, filled_amount
       FROM execution_legs WHERE execution_id = ? ORDER BY leg_number`,
    )
    .all(execution.id) as unknown as LegRow[];
  const unresolvedLeg = legs.find((leg) => leg.status === 'submitted' || leg.status === 'unknown');
  if (unresolvedLeg) {
    throw new Error(
      `leg ${unresolvedLeg.leg_number} on ${unresolvedLeg.venue_id} is ${unresolvedLeg.status}`,
    );
  }
  if (
    !legs.some(
      (leg) =>
        (leg.status === 'filled' || leg.status === 'partial') &&
        leg.filled_amount !== null &&
        new Decimal(leg.filled_amount).gt(0),
    )
  ) {
    throw new Error('execution has no filled leg to carry');
  }

  const unhedged = db
    .prepare(
      `SELECT id, venue_id, asset, amount, direction, reason
       FROM unhedged_inventory WHERE batch_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(batchId) as unknown as UnhedgedRow[];
  if (unhedged.length === 0) {
    throw new Error('execution has no open unhedged inventory');
  }
  if (unhedged.some((row) => row.direction !== 'long')) {
    throw new Error('carry-inventory reconciliation only supports long inventory');
  }

  const requiredByAsset = new Map<
    string,
    { venueId: string; asset: string; ids: number[]; amount: Decimal }
  >();
  for (const row of unhedged) {
    const amount = new Decimal(row.amount);
    if (!amount.gt(0)) throw new Error(`unhedged row ${row.id} has a non-positive amount`);
    const asset = row.asset.trim().toUpperCase();
    const key = `${row.venue_id}|${asset}`;
    const existing = requiredByAsset.get(key);
    if (existing) {
      existing.ids.push(row.id);
      existing.amount = existing.amount.plus(amount);
    } else {
      requiredByAsset.set(key, {
        venueId: row.venue_id,
        asset,
        ids: [row.id],
        amount,
      });
    }
  }

  const balances = repository.latestBalances({ maxAgeMs: maxBalanceAgeMs, now });
  const observedBalances = [...requiredByAsset.values()].map((required) => {
    const free = balances
      .filter(
        (balance) =>
          balance.venueId === required.venueId &&
          balance.currency.trim().toUpperCase() === required.asset,
      )
      .reduce((total, balance) => total.plus(balance.free), new Decimal(0));
    if (free.lt(required.amount)) {
      throw new Error(
        `insufficient free ${required.asset} on ${required.venueId}: need ${required.amount.toFixed()}, observed ${free.toFixed()}; refresh balances first`,
      );
    }
    return {
      unhedgedIds: required.ids,
      venueId: required.venueId,
      asset: required.asset,
      requiredAmount: required.amount.toFixed(),
      freeAmount: free.toFixed(),
    };
  });

  const metadata = {
    ...metadataObject(execution.metadata_json),
    resolution: 'carried_inventory',
    reconciledAt: new Date(now).toISOString(),
    reconciledBy: 'operator',
    observedBalances,
  };
  const context = {
    batchId,
    executionId: execution.id,
    previousStatus: execution.status,
    resolution: 'carried_inventory',
    resolvedUnhedgedIds: unhedged.map((row) => row.id),
    observedBalances,
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of unhedged) repository.resolveUnhedgedInventory(row.id, now);
    repository.updateExecutionStatus(execution.id, 'RECONCILED', {
      closedAt: now,
      metadata,
    });
    repository.recordRiskEvent(
      'warning',
      'execution_reconciled',
      'SAFE_STOP inventory carried by operator',
      context,
      now,
    );
    repository.recordAudit('operator', 'execution_reconciled', context, now);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The database may already have rolled back the transaction.
    }
    throw error;
  }

  return {
    batchId,
    executionId: execution.id,
    previousStatus: execution.status,
    status: 'RECONCILED',
    resolvedUnhedgedIds: unhedged.map((row) => row.id),
    observedBalances,
    reconciledAt: new Date(now).toISOString(),
  };
}

/**
 * Close a SAFE_STOP execution after every leg has been independently confirmed
 * as a zero-fill terminal order. This never submits orders and never clears the
 * kill switch.
 */
export function reconcileNoFillExecution(input: {
  db: DatabaseSync;
  repository: ArbitrageRepository;
  batchId: string;
  now?: number;
}): NoFillReconciliation {
  const { db, repository, batchId } = input;
  const now = input.now ?? Date.now();
  const execution = db
    .prepare('SELECT id, status, closed_at, metadata_json FROM executions WHERE batch_id = ?')
    .get(batchId) as ExecutionRow | undefined;
  if (!execution) throw new Error(`execution not found: ${batchId}`);
  if (execution.status !== 'SAFE_STOP') {
    throw new Error(`execution ${batchId} is ${execution.status}, not SAFE_STOP`);
  }
  if (execution.closed_at !== null) {
    throw new Error(`execution ${batchId} is already closed`);
  }
  if (repository.countOpenExecutions() !== 1) {
    throw new Error('reconciliation requires exactly one open execution');
  }
  if (repository.countUnresolvedOrders() > 0) {
    throw new Error('unresolved orders exist; confirm every order as zero-fill first');
  }

  const legs = db
    .prepare(
      `SELECT leg_number, venue_id, side, status, filled_amount
       FROM execution_legs WHERE execution_id = ? ORDER BY leg_number`,
    )
    .all(execution.id) as unknown as LegRow[];
  if (legs.length === 0) throw new Error('execution has no legs');
  if (legs.some((leg) => leg.status === 'submitted' || leg.status === 'unknown')) {
    throw new Error('execution still has an unresolved leg');
  }
  if (legs.some((leg) => leg.filled_amount !== null && new Decimal(leg.filled_amount).gt(0))) {
    throw new Error('execution has a filled leg; use --carry-inventory instead');
  }

  const unhedged = db
    .prepare(
      `SELECT COUNT(*) AS count FROM unhedged_inventory
       WHERE batch_id = ? AND status = 'open'`,
    )
    .get(batchId) as { count: number | bigint };
  if (Number(unhedged.count) > 0) {
    throw new Error('execution has open unhedged inventory; use --carry-inventory instead');
  }

  const metadata = {
    ...metadataObject(execution.metadata_json),
    resolution: 'no_fill',
    reconciledAt: new Date(now).toISOString(),
    reconciledBy: 'operator',
  };
  const context = {
    batchId,
    executionId: execution.id,
    previousStatus: execution.status,
    resolution: 'no_fill',
    legs: legs.map((leg) => ({
      legNumber: leg.leg_number,
      venueId: leg.venue_id,
      side: leg.side,
      status: leg.status,
      filledAmount: leg.filled_amount ?? '0',
    })),
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    repository.updateExecutionStatus(execution.id, 'RECONCILED', {
      closedAt: now,
      metadata,
    });
    repository.recordRiskEvent(
      'warning',
      'execution_reconciled_no_fill',
      'SAFE_STOP execution closed after zero-fill confirmation',
      context,
      now,
    );
    repository.recordAudit('operator', 'execution_reconciled', context, now);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The database may already have rolled back the transaction.
    }
    throw error;
  }

  return {
    batchId,
    executionId: execution.id,
    previousStatus: execution.status,
    status: 'RECONCILED',
    reconciledAt: new Date(now).toISOString(),
  };
}
