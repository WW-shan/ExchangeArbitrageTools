import { randomUUID } from 'node:crypto';
import { Decimal, planRebalance, type CurrencyNetwork, type RebalanceTarget } from '@arb/core';
import type { ArbitrageRepository, TransferBatchRecord, TransferLegRecord } from '@arb/storage';
import {
  networksMatch,
  normalizeAddressTag,
  transactionIdsMatch,
  transferAddressesMatch,
  type ApiCredentials,
  type CexAdapter,
  type DepositAddress,
} from '@arb/venues-cex';
import type { TransferAllowlistEntry, TransferConfig } from './config.js';

export const TRANSFER_BATCH_STATUS = {
  PLANNED: 'PLANNED',
  READY: 'READY',
  EXECUTING: 'EXECUTING',
  WITHDRAWING: 'WITHDRAWING',
  WITHDRAWN: 'WITHDRAWN',
  WAITING_DEPOSIT: 'WAITING_DEPOSIT',
  BLOCKED: 'BLOCKED',
  DRY_RUN: 'DRY_RUN',
  COMPLETED: 'COMPLETED',
  SAFE_STOP: 'SAFE_STOP',
} as const;

export const TRANSFER_LEG_STATUS = {
  PLANNED: 'PLANNED',
  READY: 'READY',
  WITHDRAWING: 'WITHDRAWING',
  WITHDRAWN: 'WITHDRAWN',
  WAITING_DEPOSIT: 'WAITING_DEPOSIT',
  ARRIVED: 'ARRIVED',
  BLOCKED: 'BLOCKED',
  WITHDRAW_FAILED: 'WITHDRAW_FAILED',
  UNKNOWN: 'UNKNOWN',
  DEPOSIT_TIMEOUT: 'DEPOSIT_TIMEOUT',
  DEPOSIT_FAILED: 'DEPOSIT_FAILED',
} as const;

const FINAL_BATCH_STATUSES = new Set<string>([
  TRANSFER_BATCH_STATUS.COMPLETED,
  TRANSFER_BATCH_STATUS.BLOCKED,
  TRANSFER_BATCH_STATUS.DRY_RUN,
]);
const FINAL_LEG_FAILURES = new Set<string>([
  TRANSFER_LEG_STATUS.WITHDRAW_FAILED,
  TRANSFER_LEG_STATUS.UNKNOWN,
  TRANSFER_LEG_STATUS.DEPOSIT_TIMEOUT,
  TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
]);
const IN_PROGRESS_BATCH_STATUSES = new Set<string>([
  TRANSFER_BATCH_STATUS.EXECUTING,
  TRANSFER_BATCH_STATUS.WITHDRAWING,
  TRANSFER_BATCH_STATUS.WITHDRAWN,
  TRANSFER_BATCH_STATUS.WAITING_DEPOSIT,
]);

export interface TransferVenueAccess {
  adapter: CexAdapter;
  credentials: ApiCredentials;
}

export interface TransferVenue {
  read?: TransferVenueAccess;
  withdrawal?: TransferVenueAccess;
}

export type TransferVenues = Readonly<Record<string, TransferVenue>>;

export interface PlanTransferBatchOptions {
  repository: ArbitrageRepository;
  config: TransferConfig;
  targets: readonly RebalanceTarget[];
  network?: string;
  batchId?: string;
  now?: number;
}

export interface PreflightTransferBatchOptions {
  repository: ArbitrageRepository;
  config: TransferConfig;
  venues: TransferVenues;
  batchId: string;
  now?: number;
}

export interface ExecuteTransferBatchOptions {
  repository: ArbitrageRepository;
  config: TransferConfig;
  venues: TransferVenues;
  batchId: string;
  liveEnabled: boolean;
  killSwitch: boolean;
  confirmBatchId?: string;
  operator?: string;
  dryRun?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReconcileTransferBatchOptions {
  repository: ArbitrageRepository;
  config: TransferConfig;
  venues: TransferVenues;
  batchId: string;
  now?: number;
}

export interface TransferPreflightLegResult {
  legNumber: number;
  status: string;
  reasons: string[];
  fee?: string;
  depositAddress?: string;
}

export interface TransferPreflightResult {
  batchId: string;
  status: string;
  reasons: string[];
  legs: TransferPreflightLegResult[];
}

export interface TransferExecutionLegResult {
  legNumber: number;
  status: string;
  sourceRecordId?: string;
  destinationRecordId?: string;
}

export interface TransferExecutionResult {
  batchId: string;
  status: string;
  reasons: string[];
  withdrawalsSubmitted: number;
  legs: TransferExecutionLegResult[];
}

interface PreflightLegResult {
  ok: boolean;
  reasons: string[];
  allowlist?: TransferAllowlistEntry;
  fee?: Decimal;
  sourceFree?: Decimal;
  depositAddress?: DepositAddress;
  metadata: Record<string, unknown>;
}

interface SettleLegResult {
  status: string;
  reasons: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startOfUtcDay(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function findAllowlistEntry(
  config: TransferConfig,
  leg: Pick<TransferLegRecord, 'fromVenue' | 'toVenue' | 'asset' | 'network'>,
): TransferAllowlistEntry | undefined {
  return config.allowlist.find(
    (entry) =>
      entry.fromVenue === leg.fromVenue &&
      entry.toVenue === leg.toVenue &&
      entry.asset === leg.asset.toUpperCase() &&
      networksMatch(entry.network, leg.network),
  );
}

function sourceAccess(venues: TransferVenues, venueId: string): TransferVenueAccess | undefined {
  return venues[venueId]?.withdrawal;
}

function readAccess(venues: TransferVenues, venueId: string): TransferVenueAccess | undefined {
  const venue = venues[venueId];
  return venue?.read ?? venue?.withdrawal;
}

function destinationAccess(
  venues: TransferVenues,
  venueId: string,
): TransferVenueAccess | undefined {
  return readAccess(venues, venueId);
}

function currencyNetwork(
  currencies: readonly { code: string; networks: CurrencyNetwork[] }[],
  asset: string,
  network: string,
): CurrencyNetwork | undefined {
  const currency = currencies.find((row) => row.code.toUpperCase() === asset.toUpperCase());
  if (!currency) return undefined;
  return currency.networks.find((row) => networksMatch(row.network, network));
}

export function planTransferBatch(options: PlanTransferBatchOptions): TransferBatchRecord {
  const { repository, config } = options;
  const now = options.now ?? Date.now();
  if (repository.countActiveTransferBatches() > 0) {
    throw new Error('another transfer batch is already active');
  }
  if (options.targets.length === 0) throw new Error('at least one transfer target is required');
  const balances = repository.latestBalances({ maxAgeMs: config.maxBalanceAgeMs, now });
  for (const target of options.targets) {
    const found = balances.some(
      (balance) =>
        balance.venueId === target.venueId &&
        balance.currency.toUpperCase() === target.currency.toUpperCase(),
    );
    if (!found) {
      throw new Error(
        `fresh balance is missing for ${target.venueId}/${target.currency}; run executor:balances first`,
      );
    }
  }
  const plan = planRebalance(
    balances.map((balance) => ({
      venueId: balance.venueId,
      currency: balance.currency,
      free: balance.free,
    })),
    options.targets,
  );
  if (plan.transfers.length === 0) {
    throw new Error('no inventory transfer is required for the supplied targets');
  }
  if (plan.transfers.length > config.maxLegsPerBatch) {
    throw new Error(
      `plan requires ${plan.transfers.length} legs; max_legs_per_batch is ${config.maxLegsPerBatch}`,
    );
  }

  const blockers: string[] = [];
  for (const shortfall of plan.shortfalls) {
    blockers.push(
      `shortfall:${shortfall.venueId}:${shortfall.currency}:${shortfall.missing.toFixed()}`,
    );
  }
  const legs = plan.transfers.map((transfer, index) => {
    const candidates = config.allowlist.filter(
      (entry) =>
        entry.fromVenue === transfer.fromVenue &&
        entry.toVenue === transfer.toVenue &&
        entry.asset === transfer.currency.toUpperCase() &&
        (!options.network || networksMatch(entry.network, options.network)),
    );
    const entry = candidates.length === 1 ? candidates[0] : undefined;
    const reasons: string[] = [];
    if (candidates.length === 0) reasons.push('allowlist_missing');
    else if (candidates.length > 1) reasons.push('allowlist_network_ambiguous');
    if (entry) {
      if (transfer.amount.lt(entry.minAmount)) reasons.push('amount_below_allowlist_minimum');
      if (transfer.amount.gt(entry.maxAmount)) reasons.push('amount_above_allowlist_maximum');
      const spent = repository.dailyTransferAmount(
        transfer.fromVenue,
        transfer.currency,
        startOfUtcDay(now),
      );
      if (spent.plus(transfer.amount).gt(entry.dailyMaxAmount)) {
        reasons.push('daily_allowlist_limit_exceeded');
      }
    }
    if (reasons.length > 0) blockers.push(`leg${index + 1}:${reasons.join(',')}`);
    return {
      legNumber: index + 1,
      fromVenue: transfer.fromVenue,
      toVenue: transfer.toVenue,
      asset: transfer.currency.toUpperCase(),
      network: entry?.network ?? options.network?.trim().toUpperCase() ?? 'UNKNOWN',
      amount: transfer.amount,
      address: entry?.address ?? '',
      ...(entry?.addressTag ? { addressTag: entry.addressTag } : {}),
      status: reasons.length === 0 ? TRANSFER_LEG_STATUS.PLANNED : TRANSFER_LEG_STATUS.BLOCKED,
      ...(reasons.length > 0 ? { error: reasons.join(',') } : {}),
      metadata: {
        plannedAt: now,
        allowlistAddress: entry?.address,
        allowlistTag: entry?.addressTag ?? '',
      },
    };
  });

  const batchId = options.batchId ?? `xfer-${now}-${randomUUID().slice(0, 8)}`;
  repository.createTransferBatch({
    id: batchId,
    status: blockers.length === 0 ? TRANSFER_BATCH_STATUS.PLANNED : TRANSFER_BATCH_STATUS.BLOCKED,
    plan: {
      generatedAt: now,
      maxBalanceAgeMs: config.maxBalanceAgeMs,
      targets: options.targets.map((target) => ({
        venueId: target.venueId,
        currency: target.currency,
        targetFree: target.targetFree.toFixed(),
      })),
      transfers: plan.transfers.map((transfer) => ({
        fromVenue: transfer.fromVenue,
        toVenue: transfer.toVenue,
        asset: transfer.currency,
        amount: transfer.amount.toFixed(),
      })),
      shortfalls: plan.shortfalls.map((shortfall) => ({
        venueId: shortfall.venueId,
        currency: shortfall.currency,
        missing: shortfall.missing.toFixed(),
      })),
      blockers,
    },
    dryRun: false,
    ...(blockers.length > 0 ? { safeModeReason: blockers.join('; ') } : {}),
    createdAt: now,
    legs,
  });
  if (blockers.length > 0) {
    repository.recordRiskEvent(
      'warning',
      'transfer_plan_blocked',
      blockers.join('; '),
      { batchId },
      now,
    );
  }
  repository.recordAudit('operator', 'transfer_plan_created', { batchId, blockers }, now);
  return repository.getTransferBatch(batchId)!;
}

async function preflightLeg(input: {
  repository: ArbitrageRepository;
  config: TransferConfig;
  venues: TransferVenues;
  batch: TransferBatchRecord;
  leg: TransferLegRecord;
  now: number;
}): Promise<PreflightLegResult> {
  const { repository, config, venues, batch, leg, now } = input;
  const reasons: string[] = [];
  const metadata: Record<string, unknown> = {
    checkedAt: now,
    checkedBatchStatus: batch.status,
  };
  const allowlist = findAllowlistEntry(config, leg);
  if (!allowlist) {
    return { ok: false, reasons: ['allowlist_missing'], metadata };
  }
  if (!transferAddressesMatch(allowlist.address, leg.address)) {
    reasons.push('allowlist_address_changed');
  }
  if (normalizeAddressTag(allowlist.addressTag) !== normalizeAddressTag(leg.addressTag)) {
    reasons.push('allowlist_tag_changed');
  }
  if (leg.amount.lt(allowlist.minAmount)) reasons.push('amount_below_allowlist_minimum');
  if (leg.amount.gt(allowlist.maxAmount)) reasons.push('amount_above_allowlist_maximum');
  const dailySpent = repository.dailyTransferAmount(leg.fromVenue, leg.asset, startOfUtcDay(now));
  if (dailySpent.plus(leg.amount).gt(allowlist.dailyMaxAmount)) {
    reasons.push('daily_allowlist_limit_exceeded');
  }
  metadata.dailySpent = dailySpent.toFixed();
  metadata.allowlistAddress = allowlist.address;
  metadata.allowlistTag = allowlist.addressTag ?? '';

  const source = sourceAccess(venues, leg.fromVenue);
  const destination = destinationAccess(venues, leg.toVenue);
  const balanceAccess = readAccess(venues, leg.fromVenue);
  if (
    !source ||
    typeof source.adapter.createWithdrawal !== 'function' ||
    typeof source.adapter.fetchWithdrawals !== 'function'
  ) {
    reasons.push('source_withdrawal_adapter_missing');
  }
  if (
    !destination ||
    typeof destination.adapter.fetchDepositAddress !== 'function' ||
    typeof destination.adapter.fetchDeposits !== 'function'
  ) {
    reasons.push('destination_deposit_adapter_missing');
  }
  if (!balanceAccess || typeof balanceAccess.adapter.fetchBalances !== 'function') {
    reasons.push('source_balance_adapter_missing');
  }
  if (reasons.length > 0 || !source || !destination || !balanceAccess) {
    return { ok: false, reasons, allowlist, metadata };
  }
  const fetchBalances = balanceAccess.adapter.fetchBalances;
  if (!fetchBalances) {
    return {
      ok: false,
      reasons: [...reasons, 'source_balance_adapter_missing'],
      allowlist,
      metadata,
    };
  }

  let depositAddress: DepositAddress;
  try {
    depositAddress = await destination.adapter.fetchDepositAddress!(
      leg.asset,
      leg.network,
      destination.credentials,
    );
  } catch (error) {
    return {
      ok: false,
      reasons: [`deposit_address_failed:${errorMessage(error)}`],
      allowlist,
      metadata,
    };
  }
  metadata.depositAddress = depositAddress.address;
  metadata.depositNetwork = depositAddress.network;
  metadata.depositTag = depositAddress.tag ?? '';
  if (!networksMatch(depositAddress.network, leg.network)) {
    reasons.push('deposit_network_mismatch');
  }
  if (!transferAddressesMatch(depositAddress.address, allowlist.address)) {
    reasons.push('deposit_address_mismatch');
  }
  if (normalizeAddressTag(depositAddress.tag) !== normalizeAddressTag(allowlist.addressTag)) {
    reasons.push('deposit_tag_mismatch');
  }

  let fee = allowlist.withdrawFee;
  if (typeof source.adapter.fetchCurrencies === 'function') {
    try {
      const networkInfo = currencyNetwork(
        await source.adapter.fetchCurrencies(),
        leg.asset,
        leg.network,
      );
      if (!networkInfo) {
        reasons.push('source_currency_network_not_listed');
      } else {
        if (!networkInfo.withdrawEnabled) reasons.push('source_withdraw_disabled');
        if (networkInfo.minWithdrawAmount?.gt(leg.amount)) {
          reasons.push('amount_below_source_minimum');
        }
        if (fee === undefined && networkInfo.withdrawFee !== undefined) {
          fee = networkInfo.withdrawFee;
        }
      }
    } catch (error) {
      metadata.sourceMetadataError = errorMessage(error);
      if (fee === undefined) reasons.push('source_withdraw_fee_unknown');
    }
  }
  if (fee === undefined) reasons.push('source_withdraw_fee_unknown');
  if (fee !== undefined) metadata.fee = fee.toFixed();

  if (typeof destination.adapter.fetchCurrencies === 'function') {
    try {
      const networkInfo = currencyNetwork(
        await destination.adapter.fetchCurrencies(),
        leg.asset,
        leg.network,
      );
      if (!networkInfo) {
        reasons.push('destination_currency_network_not_listed');
      } else {
        if (!networkInfo.depositEnabled) reasons.push('destination_deposit_disabled');
        if (networkInfo.minDepositAmount?.gt(leg.amount)) {
          reasons.push('amount_below_destination_deposit_minimum');
        }
      }
    } catch (error) {
      metadata.destinationMetadataError = errorMessage(error);
      reasons.push('destination_currency_metadata_unavailable');
    }
  }

  let sourceFree: Decimal | undefined;
  try {
    const balances = await fetchBalances.call(balanceAccess.adapter, balanceAccess.credentials);
    for (const balance of balances) {
      repository.recordBalance(balance);
      repository.recordInventorySnapshot({
        venueId: balance.venueId,
        accountId: balance.accountId,
        asset: balance.currency,
        free: balance.free,
        used: balance.used,
        total: balance.total,
        capturedAt: balance.fetchedAt,
      });
    }
    sourceFree = balances.find(
      (balance) =>
        balance.venueId === leg.fromVenue &&
        balance.currency.toUpperCase() === leg.asset.toUpperCase(),
    )?.free;
    if (!sourceFree) {
      reasons.push('source_balance_missing');
    } else {
      metadata.sourceFree = sourceFree.toFixed();
      if (fee !== undefined && sourceFree.lt(leg.amount.plus(fee))) {
        reasons.push('source_balance_insufficient');
      }
    }
  } catch (error) {
    reasons.push(`source_balance_fetch_failed:${errorMessage(error)}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    allowlist,
    ...(fee !== undefined ? { fee } : {}),
    ...(sourceFree !== undefined ? { sourceFree } : {}),
    depositAddress,
    metadata,
  };
}

export async function preflightTransferBatch(
  options: PreflightTransferBatchOptions,
): Promise<TransferPreflightResult> {
  const { repository, config, venues, batchId } = options;
  const now = options.now ?? Date.now();
  const batch = repository.getTransferBatch(batchId);
  if (!batch) throw new Error(`transfer batch not found: ${batchId}`);
  if (FINAL_BATCH_STATUSES.has(batch.status) || batch.status === TRANSFER_BATCH_STATUS.SAFE_STOP) {
    return {
      batchId,
      status: batch.status,
      reasons: [batch.safeModeReason ?? `batch already ${batch.status}`],
      legs: batch.legs.map((leg) => ({
        legNumber: leg.legNumber,
        status: leg.status,
        reasons: leg.error ? [leg.error] : [],
      })),
    };
  }
  if (IN_PROGRESS_BATCH_STATUSES.has(batch.status)) {
    return {
      batchId,
      status: batch.status,
      reasons: ['batch_in_progress; use reconcile instead of preflight'],
      legs: batch.legs.map((leg) => ({
        legNumber: leg.legNumber,
        status: leg.status,
        reasons: leg.error ? [leg.error] : [],
      })),
    };
  }
  const reasons: string[] = [];
  if (repository.countActiveTransferBatches(batchId) > 0) {
    reasons.push('another_transfer_batch_active');
  }
  if (batch.legs.length > config.maxLegsPerBatch) {
    reasons.push('batch_exceeds_max_legs');
  }
  const legs: TransferPreflightLegResult[] = [];
  for (const leg of batch.legs) {
    const result = await preflightLeg({ repository, config, venues, batch, leg, now });
    const status = result.ok ? TRANSFER_LEG_STATUS.READY : TRANSFER_LEG_STATUS.BLOCKED;
    repository.updateTransferLeg(batchId, leg.legNumber, {
      status,
      error: result.ok ? null : result.reasons.join(','),
      metadata: {
        ...metadataObject(leg.metadata),
        preflight: result.metadata,
        preflightReasons: result.reasons,
      },
      ...(result.fee !== undefined ? { fee: result.fee } : {}),
      updatedAt: now,
    });
    legs.push({
      legNumber: leg.legNumber,
      status,
      reasons: result.reasons,
      ...(result.fee !== undefined ? { fee: result.fee.toFixed() } : {}),
      ...(result.depositAddress ? { depositAddress: result.depositAddress.address } : {}),
    });
    if (!result.ok) reasons.push(`leg${leg.legNumber}:${result.reasons.join(',')}`);
  }
  const status = reasons.length === 0 ? TRANSFER_BATCH_STATUS.READY : TRANSFER_BATCH_STATUS.BLOCKED;
  repository.updateTransferBatch(batchId, {
    status,
    safeModeReason: reasons.length === 0 ? null : reasons.join('; '),
    updatedAt: now,
  });
  if (reasons.length > 0) {
    repository.recordRiskEvent(
      'warning',
      'transfer_preflight_blocked',
      reasons.join('; '),
      { batchId },
      now,
    );
  }
  repository.recordAudit('operator', 'transfer_preflight', { batchId, status, reasons }, now);
  return { batchId, status, reasons, legs };
}

async function settleLegOnce(input: {
  repository: ArbitrageRepository;
  config: TransferConfig;
  venues: TransferVenues;
  batch: TransferBatchRecord;
  leg: TransferLegRecord;
  now: number;
}): Promise<SettleLegResult> {
  const { repository, venues, batch, now } = input;
  let leg = input.leg;
  const source = sourceAccess(venues, leg.fromVenue);
  const destination = destinationAccess(venues, leg.toVenue);
  if (
    !source ||
    typeof source.adapter.fetchWithdrawals !== 'function' ||
    !destination ||
    typeof destination.adapter.fetchDeposits !== 'function'
  ) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.UNKNOWN,
      error: 'settlement_adapter_missing',
      updatedAt: now,
    });
    return { status: TRANSFER_LEG_STATUS.UNKNOWN, reasons: ['settlement_adapter_missing'] };
  }

  if (!leg.sourceRecordId) {
    try {
      const since = Math.max(0, (leg.requestedAt ?? batch.createdAt) - 5 * 60_000);
      const rows = await source.adapter.fetchWithdrawals(
        { currency: leg.asset, network: leg.network, since, limit: 100 },
        source.credentials,
      );
      const candidates = rows.filter(
        (row) =>
          transferAddressesMatch(row.address ?? '', leg.address) &&
          row.amount.eq(leg.amount) &&
          (!row.network || networksMatch(row.network, leg.network)),
      );
      if (candidates.length === 1) {
        repository.updateTransferLeg(batch.id, leg.legNumber, {
          sourceRecordId: candidates[0]!.id,
          updatedAt: now,
        });
        leg = { ...leg, sourceRecordId: candidates[0]!.id };
      } else if (candidates.length > 1) {
        repository.updateTransferLeg(batch.id, leg.legNumber, {
          status: TRANSFER_LEG_STATUS.UNKNOWN,
          error: 'source_withdrawal_candidates_ambiguous',
          updatedAt: now,
        });
        return {
          status: TRANSFER_LEG_STATUS.UNKNOWN,
          reasons: ['source_withdrawal_candidates_ambiguous'],
        };
      }
    } catch (error) {
      return {
        status: leg.status,
        reasons: [`source_history_failed:${errorMessage(error)}`],
      };
    }
  }

  if (!leg.sourceRecordId) {
    return { status: leg.status, reasons: [] };
  }

  let sourceRecord;
  try {
    const rows = await source.adapter.fetchWithdrawals(
      { currency: leg.asset, id: leg.sourceRecordId, limit: 100 },
      source.credentials,
    );
    sourceRecord = rows.find((row) => row.id === leg.sourceRecordId);
  } catch (error) {
    return { status: leg.status, reasons: [`source_history_failed:${errorMessage(error)}`] };
  }
  if (!sourceRecord) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      sourceObservedAt: now,
      updatedAt: now,
    });
    return { status: leg.status, reasons: [] };
  }

  if (sourceRecord.status === 'failed' || sourceRecord.status === 'canceled') {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.WITHDRAW_FAILED,
      sourceObservedAt: now,
      error: `source_withdrawal_${sourceRecord.status}`,
      ...(sourceRecord.fee !== undefined ? { fee: sourceRecord.fee } : {}),
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.WITHDRAW_FAILED,
      reasons: [`source_withdrawal_${sourceRecord.status}`],
    };
  }
  if (sourceRecord.status !== 'completed') {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.WITHDRAWING,
      sourceObservedAt: now,
      ...(sourceRecord.fee !== undefined ? { fee: sourceRecord.fee } : {}),
      updatedAt: now,
    });
    return { status: TRANSFER_LEG_STATUS.WITHDRAWING, reasons: [] };
  }

  repository.updateTransferLeg(batch.id, leg.legNumber, {
    status: TRANSFER_LEG_STATUS.WITHDRAWN,
    sourceObservedAt: now,
    sourceTxId: sourceRecord.txId ?? null,
    ...(sourceRecord.fee !== undefined ? { fee: sourceRecord.fee } : {}),
    updatedAt: now,
  });
  leg = {
    ...leg,
    status: TRANSFER_LEG_STATUS.WITHDRAWN,
    sourceTxId: sourceRecord.txId ?? null,
    sourceObservedAt: now,
    ...(sourceRecord.fee !== undefined ? { fee: sourceRecord.fee } : {}),
  };
  if (!sourceRecord.txId) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.WAITING_DEPOSIT,
      error: 'source_tx_id_missing',
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.WAITING_DEPOSIT,
      reasons: ['source_tx_id_missing'],
    };
  }

  let deposits;
  try {
    deposits = await destination.adapter.fetchDeposits(
      { currency: leg.asset, network: leg.network, txId: sourceRecord.txId, limit: 100 },
      destination.credentials,
    );
  } catch (error) {
    return { status: leg.status, reasons: [`destination_history_failed:${errorMessage(error)}`] };
  }
  const deposit = deposits.find((row) => transactionIdsMatch(row.txId, sourceRecord!.txId));
  if (!deposit) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.WAITING_DEPOSIT,
      destinationObservedAt: now,
      updatedAt: now,
    });
    return { status: TRANSFER_LEG_STATUS.WAITING_DEPOSIT, reasons: [] };
  }
  if (deposit.status === 'failed' || deposit.status === 'canceled') {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      destinationRecordId: deposit.id,
      destinationTxId: deposit.txId ?? null,
      destinationObservedAt: now,
      error: `destination_deposit_${deposit.status}`,
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      reasons: [`destination_deposit_${deposit.status}`],
    };
  }
  if (deposit.status !== 'completed') {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.WAITING_DEPOSIT,
      destinationRecordId: deposit.id,
      destinationTxId: deposit.txId ?? null,
      destinationObservedAt: now,
      updatedAt: now,
    });
    return { status: TRANSFER_LEG_STATUS.WAITING_DEPOSIT, reasons: [] };
  }
  if (deposit.address && !transferAddressesMatch(deposit.address, leg.address)) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      destinationRecordId: deposit.id,
      destinationTxId: deposit.txId ?? null,
      destinationObservedAt: now,
      error: 'destination_deposit_address_mismatch',
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      reasons: ['destination_deposit_address_mismatch'],
    };
  }
  if (deposit.network && !networksMatch(deposit.network, leg.network)) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      destinationRecordId: deposit.id,
      destinationTxId: deposit.txId ?? null,
      destinationObservedAt: now,
      error: 'destination_deposit_network_mismatch',
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      reasons: ['destination_deposit_network_mismatch'],
    };
  }
  if (deposit.tag && normalizeAddressTag(deposit.tag) !== normalizeAddressTag(leg.addressTag)) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      destinationRecordId: deposit.id,
      destinationTxId: deposit.txId ?? null,
      destinationObservedAt: now,
      error: 'destination_deposit_tag_mismatch',
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      reasons: ['destination_deposit_tag_mismatch'],
    };
  }
  if (!deposit.amount.gt(0)) {
    repository.updateTransferLeg(batch.id, leg.legNumber, {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      destinationRecordId: deposit.id,
      destinationTxId: deposit.txId ?? null,
      destinationObservedAt: now,
      error: 'destination_deposit_amount_not_positive',
      updatedAt: now,
    });
    return {
      status: TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      reasons: ['destination_deposit_amount_not_positive'],
    };
  }
  repository.updateTransferLeg(batch.id, leg.legNumber, {
    status: TRANSFER_LEG_STATUS.ARRIVED,
    destinationRecordId: deposit.id,
    destinationTxId: deposit.txId ?? null,
    destinationObservedAt: now,
    error: null,
    metadata: {
      ...metadataObject(leg.metadata),
      arrival: {
        amount: deposit.amount.toFixed(),
        fee: deposit.fee?.toFixed() ?? null,
        txId: deposit.txId ?? null,
        recordId: deposit.id,
      },
    },
    updatedAt: now,
  });
  return { status: TRANSFER_LEG_STATUS.ARRIVED, reasons: [] };
}

function markSafeStop(
  repository: ArbitrageRepository,
  batchId: string,
  reason: string,
  now: number,
): void {
  repository.updateTransferBatch(batchId, {
    status: TRANSFER_BATCH_STATUS.SAFE_STOP,
    safeModeReason: reason,
    updatedAt: now,
  });
  repository.recordRiskEvent('critical', 'transfer_safe_stop', reason, { batchId }, now);
  repository.recordAudit('system', 'transfer_safe_stop', { batchId, reason }, now);
}

async function waitForLeg(input: {
  repository: ArbitrageRepository;
  config: TransferConfig;
  venues: TransferVenues;
  batch: TransferBatchRecord;
  leg: TransferLegRecord;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<SettleLegResult> {
  const startedAt = input.leg.requestedAt ?? input.now();
  const deadline = startedAt + input.config.withdrawalTimeoutMs + input.config.depositTimeoutMs;
  let last: SettleLegResult = { status: input.leg.status, reasons: [] };
  while (true) {
    last = await settleLegOnce({
      repository: input.repository,
      config: input.config,
      venues: input.venues,
      batch: input.batch,
      leg: input.leg,
      now: input.now(),
    });
    if (last.status === TRANSFER_LEG_STATUS.ARRIVED || FINAL_LEG_FAILURES.has(last.status)) {
      return last;
    }
    if (input.now() >= deadline) {
      const status =
        last.status === TRANSFER_LEG_STATUS.WITHDRAWING
          ? TRANSFER_LEG_STATUS.UNKNOWN
          : TRANSFER_LEG_STATUS.DEPOSIT_TIMEOUT;
      input.repository.updateTransferLeg(input.batch.id, input.leg.legNumber, {
        status,
        error: `transfer_timeout:${last.status}`,
        updatedAt: input.now(),
      });
      return { status, reasons: [`transfer_timeout:${last.status}`] };
    }
    await input.sleep(input.config.pollIntervalMs);
  }
}

function executionLegs(batch: TransferBatchRecord): TransferExecutionLegResult[] {
  return batch.legs.map((leg) => ({
    legNumber: leg.legNumber,
    status: leg.status,
    ...(leg.sourceRecordId ? { sourceRecordId: leg.sourceRecordId } : {}),
    ...(leg.destinationRecordId ? { destinationRecordId: leg.destinationRecordId } : {}),
  }));
}

export async function executeTransferBatch(
  options: ExecuteTransferBatchOptions,
): Promise<TransferExecutionResult> {
  const { repository, config, venues, batchId } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let batch = repository.getTransferBatch(batchId);
  if (!batch) throw new Error(`transfer batch not found: ${batchId}`);
  if (FINAL_BATCH_STATUSES.has(batch.status)) {
    return {
      batchId,
      status: batch.status,
      reasons: [batch.safeModeReason ?? `batch already ${batch.status}`],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  if (batch.status === TRANSFER_BATCH_STATUS.SAFE_STOP) {
    return {
      batchId,
      status: batch.status,
      reasons: [batch.safeModeReason ?? 'batch is in SAFE_STOP; reconcile or resolve it first'],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }

  if (options.dryRun) {
    const preflight = await preflightTransferBatch({
      repository,
      config,
      venues,
      batchId,
      now: now(),
    });
    if (preflight.status !== TRANSFER_BATCH_STATUS.READY) {
      return {
        batchId,
        status: preflight.status,
        reasons: preflight.reasons,
        withdrawalsSubmitted: 0,
        legs: executionLegs(repository.getTransferBatch(batchId)!),
      };
    }
    repository.updateTransferBatch(batchId, {
      status: TRANSFER_BATCH_STATUS.DRY_RUN,
      dryRun: true,
      safeModeReason: null,
      updatedAt: now(),
    });
    repository.recordAudit('operator', 'transfer_dry_run', { batchId }, now());
    batch = repository.getTransferBatch(batchId)!;
    return {
      batchId,
      status: batch.status,
      reasons: [],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }

  if (!config.enabled) {
    return {
      batchId,
      status: TRANSFER_BATCH_STATUS.BLOCKED,
      reasons: ['transfers.enabled=false'],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  if (!options.liveEnabled) {
    return {
      batchId,
      status: TRANSFER_BATCH_STATUS.BLOCKED,
      reasons: ['execution.live_enabled=false'],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  if (options.killSwitch) {
    return {
      batchId,
      status: TRANSFER_BATCH_STATUS.BLOCKED,
      reasons: ['execution.kill_switch=true'],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  if (!config.requireManualConfirmation) {
    return {
      batchId,
      status: TRANSFER_BATCH_STATUS.BLOCKED,
      reasons: ['transfers.require_manual_confirmation=false'],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  if (options.confirmBatchId !== batchId) {
    return {
      batchId,
      status: TRANSFER_BATCH_STATUS.BLOCKED,
      reasons: ['confirmation_batch_id_mismatch'],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }

  if (
    batch.status === TRANSFER_BATCH_STATUS.PLANNED ||
    batch.status === TRANSFER_BATCH_STATUS.READY
  ) {
    const preflight = await preflightTransferBatch({
      repository,
      config,
      venues,
      batchId,
      now: now(),
    });
    if (preflight.status !== TRANSFER_BATCH_STATUS.READY) {
      return {
        batchId,
        status: preflight.status,
        reasons: preflight.reasons,
        withdrawalsSubmitted: 0,
        legs: executionLegs(repository.getTransferBatch(batchId)!),
      };
    }
  }

  repository.updateTransferBatch(batchId, {
    status: TRANSFER_BATCH_STATUS.EXECUTING,
    dryRun: false,
    confirmation: options.operator ?? 'operator',
    safeModeReason: null,
    updatedAt: now(),
  });
  repository.recordAudit(
    options.operator ?? 'operator',
    'transfer_execute_confirmed',
    { batchId },
    now(),
  );
  batch = repository.getTransferBatch(batchId)!;
  let withdrawalsSubmitted = 0;

  for (const initialLeg of batch.legs) {
    const currentBatch = repository.getTransferBatch(batchId)!;
    let leg = currentBatch.legs.find((candidate) => candidate.legNumber === initialLeg.legNumber)!;
    if (leg.status === TRANSFER_LEG_STATUS.ARRIVED) continue;
    if (leg.status === TRANSFER_LEG_STATUS.BLOCKED) {
      const reason = `leg${leg.legNumber}_blocked:${leg.error ?? 'preflight blocked'}`;
      repository.updateTransferBatch(batchId, {
        status: TRANSFER_BATCH_STATUS.BLOCKED,
        safeModeReason: reason,
        updatedAt: now(),
      });
      return {
        batchId,
        status: TRANSFER_BATCH_STATUS.BLOCKED,
        reasons: [reason],
        withdrawalsSubmitted,
        legs: executionLegs(repository.getTransferBatch(batchId)!),
      };
    }
    if (FINAL_LEG_FAILURES.has(leg.status)) {
      const reason = `leg${leg.legNumber}_already_${leg.status}`;
      markSafeStop(repository, batchId, reason, now());
      return {
        batchId,
        status: TRANSFER_BATCH_STATUS.SAFE_STOP,
        reasons: [reason],
        withdrawalsSubmitted,
        legs: executionLegs(repository.getTransferBatch(batchId)!),
      };
    }

    const partialBatch =
      leg.requestedAt !== null ||
      currentBatch.legs.some(
        (candidate) =>
          candidate.requestedAt !== null || candidate.status === TRANSFER_LEG_STATUS.ARRIVED,
      );
    if (leg.status === TRANSFER_LEG_STATUS.READY || leg.status === TRANSFER_LEG_STATUS.PLANNED) {
      const check = await preflightLeg({
        repository,
        config,
        venues,
        batch: repository.getTransferBatch(batchId)!,
        leg,
        now: now(),
      });
      if (!check.ok) {
        const reason = `leg${leg.legNumber}_recheck_failed:${check.reasons.join(',')}`;
        repository.updateTransferLeg(batchId, leg.legNumber, {
          status: TRANSFER_LEG_STATUS.BLOCKED,
          error: reason,
          updatedAt: now(),
        });
        if (partialBatch) markSafeStop(repository, batchId, reason, now());
        else {
          repository.updateTransferBatch(batchId, {
            status: TRANSFER_BATCH_STATUS.BLOCKED,
            safeModeReason: reason,
            updatedAt: now(),
          });
        }
        return {
          batchId,
          status: partialBatch ? TRANSFER_BATCH_STATUS.SAFE_STOP : TRANSFER_BATCH_STATUS.BLOCKED,
          reasons: [reason],
          withdrawalsSubmitted,
          legs: executionLegs(repository.getTransferBatch(batchId)!),
        };
      }
      const fee = check.fee;
      repository.updateTransferLeg(batchId, leg.legNumber, {
        status: TRANSFER_LEG_STATUS.WITHDRAWING,
        requestedAt: now(),
        error: null,
        ...(fee !== undefined ? { fee } : {}),
        updatedAt: now(),
      });
      const source = sourceAccess(venues, leg.fromVenue)!;
      const allowlist = findAllowlistEntry(config, leg);
      const withdrawalCurrency = allowlist?.venueCurrency ?? leg.asset;
      try {
        const submission = await source.adapter.createWithdrawal!(
          {
            currency: withdrawalCurrency,
            network: leg.network,
            amount: leg.amount,
            address: leg.address,
            ...(leg.addressTag ? { tag: leg.addressTag } : {}),
            remark: `${batchId}:${leg.legNumber}`,
          },
          source.credentials,
        );
        if (!submission.id) {
          throw new Error('withdrawal response is missing a record id');
        }
        repository.updateTransferLeg(batchId, leg.legNumber, {
          status: TRANSFER_LEG_STATUS.WITHDRAWING,
          sourceRecordId: submission.id,
          sourceTxId: submission.txId ?? null,
          ...(submission.fee !== undefined ? { fee: submission.fee } : {}),
          error: null,
          updatedAt: now(),
        });
        withdrawalsSubmitted += 1;
        repository.recordAudit(
          options.operator ?? 'operator',
          'transfer_withdrawal_submitted',
          { batchId, legNumber: leg.legNumber, sourceRecordId: submission.id },
          now(),
        );
      } catch (error) {
        const reason = `withdrawal_unknown:${errorMessage(error)}`;
        repository.updateTransferLeg(batchId, leg.legNumber, {
          status: TRANSFER_LEG_STATUS.UNKNOWN,
          error: reason,
          updatedAt: now(),
        });
        markSafeStop(repository, batchId, reason, now());
        return {
          batchId,
          status: TRANSFER_BATCH_STATUS.SAFE_STOP,
          reasons: [reason],
          withdrawalsSubmitted,
          legs: executionLegs(repository.getTransferBatch(batchId)!),
        };
      }
    }

    leg = repository
      .getTransferBatch(batchId)!
      .legs.find((candidate) => candidate.legNumber === leg.legNumber)!;
    const settled = await waitForLeg({
      repository,
      config,
      venues,
      batch: repository.getTransferBatch(batchId)!,
      leg,
      now,
      sleep,
    });
    if (settled.status !== TRANSFER_LEG_STATUS.ARRIVED) {
      const reason = `leg${leg.legNumber}_${settled.status}:${settled.reasons.join(',')}`;
      markSafeStop(repository, batchId, reason, now());
      return {
        batchId,
        status: TRANSFER_BATCH_STATUS.SAFE_STOP,
        reasons: [reason],
        withdrawalsSubmitted,
        legs: executionLegs(repository.getTransferBatch(batchId)!),
      };
    }
  }

  repository.updateTransferBatch(batchId, {
    status: TRANSFER_BATCH_STATUS.COMPLETED,
    safeModeReason: null,
    updatedAt: now(),
  });
  repository.recordAudit('system', 'transfer_completed', { batchId }, now());
  return {
    batchId,
    status: TRANSFER_BATCH_STATUS.COMPLETED,
    reasons: [],
    withdrawalsSubmitted,
    legs: executionLegs(repository.getTransferBatch(batchId)!),
  };
}

export async function reconcileTransferBatch(
  options: ReconcileTransferBatchOptions,
): Promise<TransferExecutionResult> {
  const { repository, config, venues, batchId } = options;
  const now = options.now ?? Date.now();
  const batch = repository.getTransferBatch(batchId);
  if (!batch) throw new Error(`transfer batch not found: ${batchId}`);
  if (batch.status === TRANSFER_BATCH_STATUS.COMPLETED) {
    return {
      batchId,
      status: batch.status,
      reasons: [],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  if (
    batch.status === TRANSFER_BATCH_STATUS.BLOCKED ||
    batch.status === TRANSFER_BATCH_STATUS.DRY_RUN
  ) {
    return {
      batchId,
      status: batch.status,
      reasons: [batch.safeModeReason ?? `batch already ${batch.status}`],
      withdrawalsSubmitted: 0,
      legs: executionLegs(batch),
    };
  }
  const reasons: string[] = [];
  for (const leg of batch.legs) {
    if (leg.status === TRANSFER_LEG_STATUS.ARRIVED) continue;
    if (
      leg.status === TRANSFER_LEG_STATUS.PLANNED ||
      leg.status === TRANSFER_LEG_STATUS.READY ||
      leg.status === TRANSFER_LEG_STATUS.BLOCKED
    ) {
      continue;
    }
    const settled = await settleLegOnce({
      repository,
      config,
      venues,
      batch,
      leg,
      now,
    });
    if (FINAL_LEG_FAILURES.has(settled.status)) {
      reasons.push(`leg${leg.legNumber}:${settled.reasons.join(',')}`);
    }
  }
  const current = repository.getTransferBatch(batchId)!;
  const allArrived =
    current.legs.length > 0 &&
    current.legs.every((leg) => leg.status === TRANSFER_LEG_STATUS.ARRIVED);
  const failed = current.legs.some((leg) => FINAL_LEG_FAILURES.has(leg.status));
  const failedReasons = current.legs
    .filter((leg) => FINAL_LEG_FAILURES.has(leg.status))
    .map((leg) => `leg${leg.legNumber}:${leg.status}:${leg.error ?? 'no_detail'}`);
  let status = current.status;
  if (allArrived) status = TRANSFER_BATCH_STATUS.COMPLETED;
  else if (failed) status = TRANSFER_BATCH_STATUS.SAFE_STOP;
  else if (current.legs.some((leg) => leg.status === TRANSFER_LEG_STATUS.WAITING_DEPOSIT)) {
    status = TRANSFER_BATCH_STATUS.WAITING_DEPOSIT;
  }
  repository.updateTransferBatch(batchId, {
    status,
    safeModeReason: failed
      ? reasons.join('; ') || failedReasons.join('; ') || current.safeModeReason
      : null,
    updatedAt: now,
  });
  repository.recordAudit('system', 'transfer_reconciled', { batchId, status, reasons }, now);
  return {
    batchId,
    status,
    reasons,
    withdrawalsSubmitted: 0,
    legs: executionLegs(repository.getTransferBatch(batchId)!),
  };
}
