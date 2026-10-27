import { Decimal } from 'decimal.js';
import type { RebalanceTarget } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { CEX_TIERS, createCexAdapter, createPublicRuntime, type CexAdapter } from '@arb/venues-cex';
import type { ExecutorConfig } from '../apps/executor/src/config.js';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import {
  loadEncryptedSecretStore,
  type StoredCredential,
} from '../apps/executor/src/secret-store.js';
import { refreshBalances } from '../apps/executor/src/balance-service.js';
import {
  TRANSFER_BATCH_STATUS,
  executeTransferBatch,
  planTransferBatch,
  preflightTransferBatch,
  reconcileTransferBatch,
  type TransferVenue,
  type TransferVenues,
} from '../apps/executor/src/transfer-service.js';

interface CliOptions {
  help: boolean;
  targets?: string;
  network?: string;
  batchId?: string;
  confirmBatchId?: string;
  operator?: string;
  refresh: boolean;
  preflight: boolean;
  dryRun: boolean;
  execute: boolean;
  reconcile: boolean;
  resolve: boolean;
  status?: string;
  reason?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  npm run rebalance:execute -- --targets <venue:CCY=amount,...> [--refresh] [--network BSC]',
    '  npm run rebalance:execute -- --batch <id> --preflight',
    '  npm run rebalance:execute -- --batch <id> --dry-run',
    '  npm run rebalance:execute -- --batch <id> --reconcile',
    '  npm run rebalance:execute -- --batch <id> --execute --confirm-batch <id>',
    '  npm run rebalance:execute -- --batch <id> --resolve --status BLOCKED --reason <text>',
    '',
    'Planning never withdraws. Live execution requires transfers.enabled=true,',
    'execution.live_enabled=true, kill_switch=false, and an exact batch confirmation.',
    'Use ARB_CONFIG to select config/live-test.toml and ARB_SECRET_STORE_KEY for keys.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    refresh: false,
    preflight: false,
    dryRun: false,
    execute: false,
    reconcile: false,
    resolve: false,
  };
  const flags = new Set([
    '--help',
    '-h',
    '--refresh',
    '--preflight',
    '--dry-run',
    '--execute',
    '--reconcile',
    '--resolve',
  ]);
  const values = new Set([
    '--targets',
    '--network',
    '--batch',
    '--confirm-batch',
    '--operator',
    '--status',
    '--reason',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }
    if (flags.has(value)) {
      if (value === '--refresh') options.refresh = true;
      else if (value === '--preflight') options.preflight = true;
      else if (value === '--dry-run') options.dryRun = true;
      else if (value === '--execute') options.execute = true;
      else if (value === '--reconcile') options.reconcile = true;
      else if (value === '--resolve') options.resolve = true;
      continue;
    }
    if (values.has(value)) {
      const argument = argv[index + 1];
      if (!argument) throw new Error(`${value} requires a value`);
      if (value === '--targets') options.targets = argument;
      else if (value === '--network') options.network = argument;
      else if (value === '--batch') options.batchId = argument;
      else if (value === '--confirm-batch') options.confirmBatchId = argument;
      else if (value === '--operator') options.operator = argument;
      else if (value === '--status') options.status = argument.toUpperCase();
      else if (value === '--reason') options.reason = argument;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

export function parseTransferTargets(value: string): RebalanceTarget[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([^:]+):([^=]+)=(.+)$/);
      if (!match) throw new Error(`invalid target ${entry}; expected venue:CCY=amount`);
      const targetFree = new Decimal(match[3]!.trim());
      if (!targetFree.isFinite() || targetFree.lt(0)) {
        throw new Error(`invalid target amount for ${entry}`);
      }
      return {
        venueId: match[1]!.trim(),
        currency: match[2]!.trim().toUpperCase(),
        targetFree,
      };
    });
}

interface LoadedVenues {
  venues: TransferVenues;
  adapters: CexAdapter[];
}

async function loadTransferVenues(config: ExecutorConfig): Promise<LoadedVenues> {
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) {
    throw new Error('ARB_SECRET_STORE_KEY is required for private transfer operations');
  }
  const records = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const byVenue = new Map<string, Partial<Record<StoredCredential['role'], StoredCredential>>>();
  for (const record of records.values()) {
    const roles = byVenue.get(record.venueId) ?? {};
    roles[record.role] = record;
    byVenue.set(record.venueId, roles);
  }
  const venues: Record<string, TransferVenue> = {};
  const adapters: CexAdapter[] = [];
  for (const [venueId, roles] of byVenue) {
    if (!CEX_TIERS[venueId]) continue;
    const readCredential = roles.read_only ?? roles.trade;
    const withdrawalCredential = roles.withdrawal;
    const runtime = createPublicRuntime(1);
    const readAdapter = readCredential
      ? createCexAdapter(venueId, runtime, {
          credentials: readCredential,
          readOnly: true,
        })
      : undefined;
    if (readAdapter) adapters.push(readAdapter);
    const withdrawalAdapter = withdrawalCredential
      ? createCexAdapter(venueId, runtime, {
          credentials: withdrawalCredential,
          readOnly: false,
        })
      : undefined;
    if (withdrawalAdapter) adapters.push(withdrawalAdapter);
    venues[venueId] = {
      ...(readAdapter && readCredential
        ? { read: { adapter: readAdapter, credentials: readCredential } }
        : {}),
      ...(withdrawalAdapter && withdrawalCredential
        ? { withdrawal: { adapter: withdrawalAdapter, credentials: withdrawalCredential } }
        : {}),
    };
  }
  return { venues, adapters };
}

function printResult(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function statusFailure(status: string): boolean {
  return status === TRANSFER_BATCH_STATUS.BLOCKED || status === TRANSFER_BATCH_STATUS.SAFE_STOP;
}

function resolveBatch(
  repository: ArbitrageRepository,
  batchId: string,
  status: string | undefined,
  reason: string | undefined,
): unknown {
  if (status !== TRANSFER_BATCH_STATUS.BLOCKED && status !== TRANSFER_BATCH_STATUS.COMPLETED) {
    throw new Error('--resolve requires --status BLOCKED or COMPLETED');
  }
  if (!reason?.trim()) throw new Error('--resolve requires --reason');
  const batch = repository.getTransferBatch(batchId);
  if (!batch) throw new Error(`transfer batch not found: ${batchId}`);
  if (
    new Set<string>([
      TRANSFER_BATCH_STATUS.EXECUTING,
      TRANSFER_BATCH_STATUS.WITHDRAWING,
      TRANSFER_BATCH_STATUS.WITHDRAWN,
      TRANSFER_BATCH_STATUS.WAITING_DEPOSIT,
    ]).has(batch.status)
  ) {
    throw new Error('cannot resolve an in-flight transfer; wait or use --reconcile first');
  }
  if (
    batch.status === TRANSFER_BATCH_STATUS.COMPLETED ||
    batch.status === TRANSFER_BATCH_STATUS.BLOCKED
  ) {
    throw new Error(`transfer batch is already terminal: ${batch.status}`);
  }
  if (
    status === TRANSFER_BATCH_STATUS.COMPLETED &&
    !batch.legs.every((leg) => leg.status === 'ARRIVED')
  ) {
    throw new Error('cannot resolve as COMPLETED unless every leg is ARRIVED; use BLOCKED');
  }
  const now = Date.now();
  repository.updateTransferBatch(batchId, {
    status,
    safeModeReason: reason.trim(),
    updatedAt: now,
  });
  repository.recordAudit(
    'operator',
    'transfer_manually_resolved',
    { batchId, status, reason },
    now,
  );
  repository.recordRiskEvent(
    'warning',
    'transfer_manually_resolved',
    reason.trim(),
    { batchId, status },
    now,
  );
  return repository.getTransferBatch(batchId);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const modes = [
    options.preflight,
    options.dryRun,
    options.execute,
    options.reconcile,
    options.resolve,
  ].filter(Boolean).length;
  if (modes > 1) {
    throw new Error('choose only one of --preflight, --dry-run, --execute, --reconcile, --resolve');
  }
  if (options.batchId && options.targets) {
    throw new Error('use either --batch or --targets, not both');
  }
  if (options.execute && !options.confirmBatchId) {
    throw new Error('--execute requires --confirm-batch <batch-id>');
  }
  if (options.execute && !options.batchId) {
    throw new Error('--execute requires --batch <batch-id> after planning in a previous run');
  }
  const config = loadExecutorConfig();
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  let loaded: LoadedVenues | undefined;
  try {
    if (options.resolve) {
      if (!options.batchId) throw new Error('--resolve requires --batch <id>');
      printResult(resolveBatch(repository, options.batchId, options.status, options.reason));
      return;
    }

    let batchId = options.batchId;
    if (!batchId) {
      if (!options.targets) throw new Error('--targets is required when --batch is omitted');
      const targets = parseTransferTargets(options.targets);
      if (options.refresh) {
        loaded = await loadTransferVenues(config);
        const balanceVenues = Object.values(loaded.venues).flatMap((venue) =>
          venue.read ? [{ adapter: venue.read.adapter, credentials: venue.read.credentials }] : [],
        );
        if (balanceVenues.length === 0) {
          throw new Error('--refresh requires at least one read_only or trade credential');
        }
        const refreshed = await refreshBalances(repository, balanceVenues);
        printResult({ balanceRefresh: refreshed });
      }
      const batch = planTransferBatch({
        repository,
        config: config.transfers,
        targets,
        ...(options.network ? { network: options.network } : {}),
      });
      batchId = batch.id;
      if (!options.preflight && !options.dryRun && !options.execute && !options.reconcile) {
        printResult(batch);
        if (statusFailure(batch.status)) process.exitCode = 1;
        return;
      }
    }

    loaded ??= await loadTransferVenues(config);
    let result;
    if (options.preflight) {
      result = await preflightTransferBatch({
        repository,
        config: config.transfers,
        venues: loaded.venues,
        batchId,
      });
    } else if (options.dryRun) {
      result = await executeTransferBatch({
        repository,
        config: config.transfers,
        venues: loaded.venues,
        batchId,
        liveEnabled: config.liveEnabled,
        killSwitch: config.killSwitch,
        dryRun: true,
      });
    } else if (options.execute) {
      result = await executeTransferBatch({
        repository,
        config: config.transfers,
        venues: loaded.venues,
        batchId,
        liveEnabled: config.liveEnabled,
        killSwitch: config.killSwitch,
        confirmBatchId: options.confirmBatchId!,
        ...(options.operator ? { operator: options.operator } : {}),
      });
    } else if (options.reconcile) {
      result = await reconcileTransferBatch({
        repository,
        config: config.transfers,
        venues: loaded.venues,
        batchId,
      });
    } else {
      const batch = repository.getTransferBatch(batchId);
      if (!batch) throw new Error(`transfer batch not found: ${batchId}`);
      printResult(batch);
      if (statusFailure(batch.status)) process.exitCode = 1;
      return;
    }
    printResult(result);
    if (statusFailure(result.status)) process.exitCode = 1;
  } finally {
    for (const adapter of loaded?.adapters ?? []) {
      try {
        await adapter.close?.();
      } catch {
        // best-effort close
      }
    }
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
