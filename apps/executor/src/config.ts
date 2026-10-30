import { readFileSync } from 'node:fs';
import { Decimal, type RiskLimits } from '@arb/core';
import { normalizeCurrencyNetwork, type VenueFeeOverride } from '@arb/venues-cex';
import { parse } from 'smol-toml';
import type { CexLiveExecutorOptions, LegExecutionMode } from './coordinator.js';

export interface TransferAllowlistEntry {
  fromVenue: string;
  toVenue: string;
  asset: string;
  network: string;
  address: string;
  addressTag?: string;
  venueCurrency?: string;
  minAmount: Decimal;
  maxAmount: Decimal;
  dailyMaxAmount: Decimal;
  withdrawFee?: Decimal;
  feeMode?: 'deducted' | 'added' | 'unknown';
  expectedArrivalMs?: number;
}

export interface TransferConfig {
  enabled: boolean;
  requireManualConfirmation: boolean;
  maxInFlightBatches: number;
  maxLegsPerBatch: number;
  maxBalanceAgeMs: number;
  pollIntervalMs: number;
  withdrawalTimeoutMs: number;
  depositTimeoutMs: number;
  releaseMode: 'manual' | 'automatic';
  minNetEdgeBps: Decimal;
  maxCostUsd: Decimal;
  maxArrivalMs: number;
  allowlist: TransferAllowlistEntry[];
}

export interface RotationPairConfig {
  base: string;
  quote: string;
  maxNotional: Decimal;
  venues: readonly [string, string];
}

export interface AutoRotationPreparationConfig {
  enabled: boolean;
  maxNotional: Decimal;
  minStableMs: number;
  calibrationFile: string;
  minReverseProbability: Decimal;
  minExpectedValueBps: Decimal;
  minExpectedValueUsd: Decimal;
  maxHoldMs: number;
  calibration: Readonly<Record<string, PreparationCalibrationEntry>>;
}

export interface AutoResidualHedgeConfig {
  enabled: boolean;
  maxLossUsd: Decimal;
  maxBaselineAgeMs: number;
}

export interface AutoInventoryConfig {
  enabled: boolean;
  seedNotionalUsd: Decimal;
  minQuoteReserveUsd: Decimal;
  minExecutableBuyUsd: Decimal;
  minUsefulNotionalUsd: Decimal;
  rebalanceEnabled: boolean;
  maxRebalanceLossUsd: Decimal;
  minRebalanceEdgeBps: Decimal;
  rebalanceSignalMaxAgeMs: number;
  requireSignalForSeed: boolean;
  minStableMs: number;
  maxPairDeviationBps: Decimal;
  maxPriceDriftBps: Decimal;
  checkIntervalMs: number;
  retryCooldownMs: number;
}

export interface PreparationCalibrationEntry {
  pair: string;
  direction: 'gate->hotcoin' | 'hotcoin->gate';
  prepBandBps: Decimal;
  horizonMs: number;
  candidateSamples: number;
  reverseProbability: Decimal;
  medianTimeToReverseMs: number;
  medianReverseNetBps?: Decimal;
  medianPrepCostBps: Decimal;
  meanNoReverseLossBps: Decimal;
  expectedValueBps: Decimal;
  expectedValueUsd: Decimal;
}

export interface AutoRotationConfig {
  enabled: boolean;
  pairs: RotationPairConfig[];
  preparation: AutoRotationPreparationConfig;
  residualHedge: AutoResidualHedgeConfig;
  inventory: AutoInventoryConfig;
  heartbeatFile: string;
  pollIntervalMs: number;
  balanceRefreshMs: number;
  maxSignalAgeMs: number;
  maxPreflightMs: number;
  cooldownMs: number;
  maxConsecutiveFailures: number;
}

export interface AccountStatusConfig {
  enabled: boolean;
  refreshMs: number;
  staleMs: number;
  requireIpWhitelist: boolean;
  allowSharedTradeWithdrawalKey: boolean;
  blockOnIpWhitelistChange: boolean;
  blockOnAccountIdChange: boolean;
  blockOnAccountModeChange: boolean;
}

export interface ExecutorConfig {
  databasePath: string;
  secretStorePath: string;
  liveEnabled: boolean;
  killSwitch: boolean;
  manualConfirmation: boolean;
  maxOpenBatches: 1;
  handoffMaxAgeMs: number;
  orderbookDepth: number;
  executionRequestsPerSecond: number;
  minSizingNotional: Decimal;
  legMode: LegExecutionMode;
  iocVenues: string[];
  fokVenues: string[];
  feeFile: string;
  feeOverrides: Record<string, VenueFeeOverride>;
  transfers: TransferConfig;
  autoRotation: AutoRotationConfig;
  accountStatus: AccountStatusConfig;
  riskLimits: RiskLimits;
  settings: CexLiveExecutorOptions['settings'];
}

type Table = Record<string, unknown>;

function table(value: unknown, name: string): Table {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`config section [${name}] is missing`);
  }
  return value as Table;
}

function optionalTable(value: unknown, name: string): Table {
  if (value === undefined || value === null) return {};
  return table(value, name);
}

function stringValue(source: Table, key: string, fallback?: string): string {
  const value = source[key] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`config value ${key} must be a non-empty string`);
  }
  return value;
}

function numberValue(source: Table, key: string, fallback?: number): number {
  const value = source[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`config value ${key} must be a number`);
  }
  return value;
}

function booleanValue(source: Table, key: string, fallback?: boolean): boolean {
  const value = source[key] ?? fallback;
  if (typeof value !== 'boolean') throw new Error(`config value ${key} must be a boolean`);
  return value;
}

function decimalValue(source: Table, key: string, fallback?: string): Decimal {
  const value = source[key] ?? fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`config value ${key} must be a decimal string`);
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error(`config value ${key} must be finite`);
  return parsed;
}

function stringArray(source: Table, key: string, fallback: string[]): string[] {
  const value = source[key] ?? fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`config value ${key} must be a string array`);
  }
  return (value as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
}

function legModeValue(source: Table, key: string, fallback: LegExecutionMode): LegExecutionMode {
  const value = source[key] ?? fallback;
  if (value !== 'serial' && value !== 'parallel_fok') {
    throw new Error(`config value ${key} must be serial or parallel_fok`);
  }
  return value;
}

function feeOverrides(value: unknown): Record<string, VenueFeeOverride> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config section [fees] must be a table');
  }
  const result: Record<string, VenueFeeOverride> = {};
  for (const [venueId, raw] of Object.entries(value as Record<string, unknown>)) {
    const row = table(raw, `fees.${venueId}`);
    const taker = row.taker_bps === undefined ? undefined : decimalValue(row, 'taker_bps', '0');
    const maker = row.maker_bps === undefined ? undefined : decimalValue(row, 'maker_bps', '0');
    const rebatePct =
      row.rebate_pct === undefined ? undefined : decimalValue(row, 'rebate_pct', '0');
    if (rebatePct !== undefined && (rebatePct.lt(0) || rebatePct.gt(100))) {
      throw new Error(`config value fees.${venueId}.rebate_pct must be between 0 and 100`);
    }
    let symbols: Record<string, { takerBps?: Decimal; makerBps?: Decimal }> | undefined;
    if (row.symbols !== undefined) {
      const symbolTable = table(row.symbols, `fees.${venueId}.symbols`);
      symbols = {};
      for (const [symbol, symbolRaw] of Object.entries(symbolTable)) {
        const symbolRow = table(symbolRaw, `fees.${venueId}.symbols.${symbol}`);
        const symbolTaker =
          symbolRow.taker_bps === undefined ? undefined : decimalValue(symbolRow, 'taker_bps', '0');
        const symbolMaker =
          symbolRow.maker_bps === undefined ? undefined : decimalValue(symbolRow, 'maker_bps', '0');
        if (symbolTaker === undefined && symbolMaker === undefined) continue;
        symbols[symbol] = {
          ...(symbolTaker !== undefined ? { takerBps: symbolTaker } : {}),
          ...(symbolMaker !== undefined ? { makerBps: symbolMaker } : {}),
        };
      }
      if (Object.keys(symbols).length === 0) symbols = undefined;
    }
    if (taker === undefined && maker === undefined && symbols === undefined) continue;
    result[venueId] = {
      ...(taker !== undefined ? { takerBps: taker } : {}),
      ...(maker !== undefined ? { makerBps: maker } : {}),
      ...(rebatePct !== undefined ? { rebatePct } : {}),
      ...(symbols !== undefined ? { symbols } : {}),
      source: 'config',
    };
  }
  return result;
}

function transferAllowlist(value: unknown): TransferAllowlistEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('config value transfers.allowlist must be an array of tables');
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const row = table(raw, `transfers.allowlist[${index}]`);
    const fromVenue = stringValue(row, 'from_venue').trim();
    const toVenue = stringValue(row, 'to_venue').trim();
    const asset = stringValue(row, 'asset').trim().toUpperCase();
    const network = stringValue(row, 'network').trim();
    const address = stringValue(row, 'address').trim();
    const addressTag =
      typeof row.address_tag === 'string' && row.address_tag.trim() !== ''
        ? row.address_tag.trim()
        : undefined;
    const venueCurrency =
      typeof row.venue_currency === 'string' && row.venue_currency.trim() !== ''
        ? row.venue_currency.trim()
        : undefined;
    if (fromVenue === toVenue) {
      throw new Error('transfers.allowlist from_venue and to_venue must differ');
    }
    const minAmount = decimalValue(row, 'min_amount', '0');
    const maxAmount = decimalValue(row, 'max_amount');
    const dailyMaxAmount = decimalValue(row, 'daily_max_amount');
    const withdrawFee =
      row.withdraw_fee === undefined ? undefined : decimalValue(row, 'withdraw_fee');
    const feeModeRaw = row.fee_mode === undefined ? 'unknown' : row.fee_mode;
    if (feeModeRaw !== 'deducted' && feeModeRaw !== 'added' && feeModeRaw !== 'unknown') {
      throw new Error('transfers.allowlist fee_mode must be deducted, added or unknown');
    }
    const expectedArrivalMs =
      row.expected_arrival_ms === undefined ? undefined : numberValue(row, 'expected_arrival_ms');
    if (minAmount.lt(0)) throw new Error('transfers.allowlist min_amount cannot be negative');
    if (maxAmount.lte(0)) throw new Error('transfers.allowlist max_amount must be positive');
    if (dailyMaxAmount.lte(0)) {
      throw new Error('transfers.allowlist daily_max_amount must be positive');
    }
    if (minAmount.gt(maxAmount)) {
      throw new Error('transfers.allowlist min_amount cannot exceed max_amount');
    }
    if (withdrawFee !== undefined && withdrawFee.lt(0)) {
      throw new Error('transfers.allowlist withdraw_fee cannot be negative');
    }
    if (
      expectedArrivalMs !== undefined &&
      (!Number.isInteger(expectedArrivalMs) || expectedArrivalMs <= 0)
    ) {
      throw new Error('transfers.allowlist expected_arrival_ms must be a positive integer');
    }
    const key = `${fromVenue}->${toVenue}:${asset}:${normalizeCurrencyNetwork(network)}`;
    if (seen.has(key)) throw new Error(`duplicate transfer allowlist entry: ${key}`);
    seen.add(key);
    return {
      fromVenue,
      toVenue,
      asset,
      network,
      address,
      ...(addressTag ? { addressTag } : {}),
      ...(venueCurrency ? { venueCurrency } : {}),
      minAmount,
      maxAmount,
      dailyMaxAmount,
      ...(withdrawFee !== undefined ? { withdrawFee } : {}),
      feeMode: feeModeRaw,
      ...(expectedArrivalMs !== undefined ? { expectedArrivalMs } : {}),
    };
  });
}

function transferConfig(value: unknown): TransferConfig {
  const transfers = optionalTable(value, 'transfers');
  const releaseMode = transfers.release_mode ?? 'manual';
  if (releaseMode !== 'manual' && releaseMode !== 'automatic') {
    throw new Error('transfers.release_mode must be manual or automatic');
  }
  return {
    enabled: booleanValue(transfers, 'enabled', false),
    requireManualConfirmation: booleanValue(transfers, 'require_manual_confirmation', true),
    maxInFlightBatches: numberValue(transfers, 'max_in_flight_batches', 1),
    maxLegsPerBatch: numberValue(transfers, 'max_legs_per_batch', 2),
    maxBalanceAgeMs: numberValue(transfers, 'max_balance_age_ms', 300_000),
    pollIntervalMs: numberValue(transfers, 'poll_interval_ms', 15_000),
    withdrawalTimeoutMs: numberValue(transfers, 'withdrawal_timeout_ms', 900_000),
    depositTimeoutMs: numberValue(transfers, 'deposit_timeout_ms', 1_800_000),
    releaseMode,
    minNetEdgeBps: decimalValue(transfers, 'min_net_edge_bps', '5'),
    maxCostUsd: decimalValue(transfers, 'max_cost_usd', '0.5'),
    maxArrivalMs: numberValue(transfers, 'max_arrival_ms', 1_800_000),
    allowlist: transferAllowlist(transfers.allowlist),
  };
}

function accountStatusConfig(value: unknown): AccountStatusConfig {
  const accountStatus = optionalTable(value, 'account_status');
  return {
    enabled: booleanValue(accountStatus, 'enabled', false),
    refreshMs: numberValue(accountStatus, 'refresh_ms', 60_000),
    staleMs: numberValue(accountStatus, 'stale_ms', 180_000),
    requireIpWhitelist: booleanValue(accountStatus, 'require_ip_whitelist', false),
    allowSharedTradeWithdrawalKey: booleanValue(
      accountStatus,
      'allow_shared_trade_withdrawal_key',
      true,
    ),
    blockOnIpWhitelistChange: booleanValue(accountStatus, 'block_on_ip_whitelist_change', true),
    blockOnAccountIdChange: booleanValue(accountStatus, 'block_on_account_id_change', true),
    blockOnAccountModeChange: booleanValue(accountStatus, 'block_on_account_mode_change', true),
  };
}

function rotationPairs(value: unknown): RotationPairConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('config value auto_rotation.pairs must be an array of tables');
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const row = table(raw, `auto_rotation.pairs[${index}]`);
    const base = stringValue(row, 'base').trim().toUpperCase();
    const quote = stringValue(row, 'quote').trim().toUpperCase();
    const maxNotional = decimalValue(row, 'max_notional', '20');
    const key = `${base}/${quote}`;
    const venues = rotationPairVenues(row.venues, key);
    if (maxNotional.lte(0)) {
      throw new Error('auto_rotation pair max_notional must be positive');
    }
    if (seen.has(key)) throw new Error(`duplicate auto_rotation pair: ${key}`);
    seen.add(key);
    return { base, quote, maxNotional, venues };
  });
}

function rotationPairVenues(value: unknown, pair: string): [string, string] {
  if (value === undefined) return ['gateio', 'hotcoin'];
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`auto_rotation pair ${pair} venues must contain exactly two venue ids`);
  }
  const venues = value.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''));
  const [first, second] = venues;
  if (!first || !second || first === second) {
    throw new Error(`auto_rotation pair ${pair} venues must be two distinct venue ids`);
  }
  return [first, second];
}

function preparationDirection(value: unknown): 'gate->hotcoin' | 'hotcoin->gate' {
  if (typeof value !== 'string') {
    throw new Error('preparation calibration direction must be a string');
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll('gateio', 'gate')
    .replaceAll('hotcoin', 'hotcoin');
  if (normalized === 'gate->hotcoin' || normalized === 'hotcoin->gate') return normalized;
  throw new Error(`unsupported preparation direction: ${value}`);
}

function preparationCalibration(path: string): Record<string, PreparationCalibrationEntry> {
  if (path.trim() === '') return {};
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`failed to read preparation calibration ${path}: ${String(error)}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('preparation calibration must be a JSON object');
  }
  const rawEntries = (document as Table).entries;
  if (!Array.isArray(rawEntries)) {
    throw new Error('preparation calibration entries must be an array');
  }
  const result: Record<string, PreparationCalibrationEntry> = {};
  for (const raw of rawEntries) {
    const row = table(raw, 'preparation calibration entry');
    const pair = stringValue(row, 'pair').trim().toUpperCase();
    const direction = preparationDirection(row.direction);
    const prepBandBps = decimalValue(row, 'prep_band_bps');
    const horizonMs = numberValue(row, 'horizon_ms');
    const candidateSamples = numberValue(row, 'candidate_samples');
    const reverseProbability = decimalValue(row, 'reverse_probability');
    const medianTimeToReverseMs = numberValue(row, 'median_time_to_reverse_ms');
    const medianPrepCostBps = decimalValue(row, 'median_prep_cost_bps');
    const meanNoReverseLossBps = decimalValue(row, 'mean_no_reverse_loss_bps');
    const expectedValueBps = decimalValue(row, 'expected_value_bps');
    const expectedValueUsd = decimalValue(row, 'expected_value_usd');
    const medianReverseNetBps =
      row.median_reverse_net_bps === null || row.median_reverse_net_bps === undefined
        ? undefined
        : decimalValue(row, 'median_reverse_net_bps');
    if (
      !Number.isInteger(horizonMs) ||
      horizonMs <= 0 ||
      !prepBandBps.isFinite() ||
      prepBandBps.lte(0) ||
      !Number.isInteger(candidateSamples) ||
      candidateSamples <= 0 ||
      !reverseProbability.isFinite() ||
      reverseProbability.lt(0) ||
      reverseProbability.gt(1) ||
      !Number.isFinite(medianTimeToReverseMs) ||
      medianTimeToReverseMs < 0 ||
      !medianPrepCostBps.isFinite() ||
      medianPrepCostBps.lt(0) ||
      !meanNoReverseLossBps.isFinite() ||
      meanNoReverseLossBps.lt(0) ||
      !expectedValueBps.isFinite() ||
      !expectedValueUsd.isFinite()
    ) {
      throw new Error(`invalid preparation calibration entry for ${pair} ${direction}`);
    }
    const key = `${pair}|${direction}|${prepBandBps.toFixed()}`;
    if (result[key]) throw new Error(`duplicate preparation calibration entry: ${key}`);
    result[key] = {
      pair,
      direction,
      prepBandBps,
      horizonMs,
      candidateSamples,
      reverseProbability,
      medianTimeToReverseMs,
      medianPrepCostBps,
      meanNoReverseLossBps,
      expectedValueBps,
      expectedValueUsd,
      ...(medianReverseNetBps ? { medianReverseNetBps } : {}),
    };
  }
  return result;
}

function autoRotationConfig(value: unknown, handoffMaxAgeMs: number): AutoRotationConfig {
  const rotation = optionalTable(value, 'auto_rotation');
  const preparation = optionalTable(rotation.preparation, 'auto_rotation.preparation');
  const residualHedge = optionalTable(rotation.residual_hedge, 'auto_rotation.residual_hedge');
  const inventory = optionalTable(rotation.inventory, 'auto_rotation.inventory');
  const pollIntervalMs = numberValue(rotation, 'poll_interval_ms', 1000);
  const balanceRefreshMs = numberValue(rotation, 'balance_refresh_ms', 10_000);
  const maxSignalAgeMs = numberValue(rotation, 'max_signal_age_ms', handoffMaxAgeMs);
  const maxPreflightMs = numberValue(rotation, 'max_preflight_ms', 2_500);
  const cooldownMs = numberValue(rotation, 'cooldown_ms', 5000);
  const maxConsecutiveFailures = numberValue(rotation, 'max_consecutive_failures', 3);
  const preparationEnabled = booleanValue(preparation, 'enabled', false);
  const calibrationFile =
    typeof preparation.calibration_file === 'string' ? preparation.calibration_file.trim() : '';
  const calibration = preparationEnabled ? preparationCalibration(calibrationFile) : {};
  for (const [name, value] of [
    ['poll_interval_ms', pollIntervalMs],
    ['balance_refresh_ms', balanceRefreshMs],
    ['max_signal_age_ms', maxSignalAgeMs],
    ['max_preflight_ms', maxPreflightMs],
    ['cooldown_ms', cooldownMs],
    ['max_consecutive_failures', maxConsecutiveFailures],
  ] as const) {
    if (!Number.isInteger(value) || value < (name === 'cooldown_ms' ? 0 : 1)) {
      throw new Error(`auto_rotation.${name} must be a positive integer`);
    }
  }
  return {
    enabled: booleanValue(rotation, 'enabled', false),
    pairs: rotationPairs(rotation.pairs),
    preparation: {
      enabled: preparationEnabled,
      maxNotional: decimalValue(preparation, 'max_notional', '10'),
      minStableMs: numberValue(preparation, 'min_stable_ms', 30_000),
      calibrationFile,
      minReverseProbability: decimalValue(preparation, 'min_reverse_probability', '0.55'),
      minExpectedValueBps: decimalValue(preparation, 'min_expected_value_bps', '0'),
      minExpectedValueUsd: decimalValue(preparation, 'min_expected_value_usd', '0'),
      maxHoldMs: numberValue(preparation, 'max_hold_ms', 3_600_000),
      calibration,
    },
    residualHedge: {
      enabled: booleanValue(residualHedge, 'enabled', false),
      maxLossUsd: decimalValue(residualHedge, 'max_loss_usd', '0'),
      maxBaselineAgeMs: numberValue(residualHedge, 'max_baseline_age_ms', 60_000),
    },
    inventory: {
      enabled: booleanValue(inventory, 'enabled', false),
      seedNotionalUsd: decimalValue(inventory, 'seed_notional_usd', '5'),
      minQuoteReserveUsd: decimalValue(inventory, 'min_quote_reserve_usd', '5'),
      minExecutableBuyUsd: decimalValue(inventory, 'min_executable_buy_usd', '3'),
      minUsefulNotionalUsd: decimalValue(inventory, 'min_useful_notional_usd', '3'),
      rebalanceEnabled: booleanValue(inventory, 'rebalance_enabled', false),
      maxRebalanceLossUsd: decimalValue(inventory, 'max_rebalance_loss_usd', '0.25'),
      minRebalanceEdgeBps: decimalValue(inventory, 'min_rebalance_edge_bps', '50'),
      rebalanceSignalMaxAgeMs: numberValue(inventory, 'rebalance_signal_max_age_ms', 15_000),
      requireSignalForSeed: booleanValue(inventory, 'require_signal_for_seed', true),
      minStableMs: numberValue(inventory, 'min_stable_ms', 3_000),
      maxPairDeviationBps: decimalValue(inventory, 'max_pair_deviation_bps', '15'),
      maxPriceDriftBps: decimalValue(inventory, 'max_price_drift_bps', '25'),
      checkIntervalMs: numberValue(inventory, 'check_interval_ms', 1_000),
      retryCooldownMs: numberValue(inventory, 'retry_cooldown_ms', 60_000),
    },
    heartbeatFile: stringValue(rotation, 'heartbeat_file', 'data/rotation-heartbeat.json'),
    pollIntervalMs,
    balanceRefreshMs,
    maxSignalAgeMs,
    maxPreflightMs,
    cooldownMs,
    maxConsecutiveFailures,
  };
}

function validateSafetyBounds(config: ExecutorConfig): void {
  if (config.maxOpenBatches !== 1) throw new Error('MVP requires max_open_batches = 1');
  if (!config.manualConfirmation) {
    throw new Error('MVP requires manual_confirmation = true until live rollout gates pass');
  }
  if (config.riskLimits.maxOrderNotional.gt(30)) {
    throw new Error('max_order_notional cannot exceed the 30 USDT MVP limit');
  }
  if (config.riskLimits.dailyMaxLoss.gt(20)) {
    throw new Error('daily_max_loss_usd cannot exceed the 20 USDT MVP limit');
  }
  if (config.autoRotation.enabled) {
    if (config.autoRotation.pairs.length === 0) {
      throw new Error('auto_rotation.enabled requires at least one whitelist pair');
    }
    if (config.autoRotation.maxSignalAgeMs > 30_000) {
      throw new Error('auto_rotation.max_signal_age_ms cannot exceed 30000');
    }
    if (
      !Number.isInteger(config.autoRotation.maxPreflightMs) ||
      config.autoRotation.maxPreflightMs < 500 ||
      config.autoRotation.maxPreflightMs > 10_000
    ) {
      throw new Error('auto_rotation.max_preflight_ms must be between 500 and 10000');
    }
    for (const pair of config.autoRotation.pairs) {
      if (pair.maxNotional.gt(config.riskLimits.maxOrderNotional)) {
        throw new Error(
          `auto_rotation pair ${pair.base}/${pair.quote} max_notional exceeds max_order_notional`,
        );
      }
    }
    const preparation = config.autoRotation.preparation;
    const residualHedge = config.autoRotation.residualHedge;
    const inventory = config.autoRotation.inventory;
    if (
      !residualHedge.maxLossUsd.isFinite() ||
      residualHedge.maxLossUsd.lt(0) ||
      residualHedge.maxLossUsd.gt(config.riskLimits.dailyMaxLoss)
    ) {
      throw new Error('auto_rotation.residual_hedge.max_loss_usd is outside the daily loss limit');
    }
    if (
      !Number.isInteger(residualHedge.maxBaselineAgeMs) ||
      residualHedge.maxBaselineAgeMs < 1_000 ||
      residualHedge.maxBaselineAgeMs > 300_000
    ) {
      throw new Error(
        'auto_rotation.residual_hedge.max_baseline_age_ms must be between 1000 and 300000',
      );
    }
    if (
      !inventory.seedNotionalUsd.isFinite() ||
      inventory.seedNotionalUsd.lte(0) ||
      inventory.seedNotionalUsd.gt(config.riskLimits.maxOrderNotional)
    ) {
      throw new Error('auto_rotation.inventory.seed_notional_usd is outside the order limit');
    }
    if (!inventory.minQuoteReserveUsd.isFinite() || inventory.minQuoteReserveUsd.lt(0)) {
      throw new Error('auto_rotation.inventory.min_quote_reserve_usd must be non-negative');
    }
    if (
      !inventory.minExecutableBuyUsd.isFinite() ||
      inventory.minExecutableBuyUsd.lte(0) ||
      inventory.minExecutableBuyUsd.gt(inventory.seedNotionalUsd)
    ) {
      throw new Error(
        'auto_rotation.inventory.min_executable_buy_usd must be within the seed notional',
      );
    }
    if (
      !inventory.maxRebalanceLossUsd.isFinite() ||
      inventory.maxRebalanceLossUsd.lt(0) ||
      inventory.maxRebalanceLossUsd.gt(config.riskLimits.dailyMaxLoss)
    ) {
      throw new Error(
        'auto_rotation.inventory.max_rebalance_loss_usd is outside the daily loss limit',
      );
    }
    if (
      !inventory.minRebalanceEdgeBps.isFinite() ||
      inventory.minRebalanceEdgeBps.lt(0) ||
      inventory.minRebalanceEdgeBps.gt(1_000)
    ) {
      throw new Error('auto_rotation.inventory.min_rebalance_edge_bps is outside the safety bound');
    }
    if (
      !Number.isInteger(inventory.rebalanceSignalMaxAgeMs) ||
      inventory.rebalanceSignalMaxAgeMs < 1_000 ||
      inventory.rebalanceSignalMaxAgeMs > 300_000
    ) {
      throw new Error(
        'auto_rotation.inventory.rebalance_signal_max_age_ms must be between 1000 and 300000',
      );
    }
    if (
      !inventory.minUsefulNotionalUsd.isFinite() ||
      inventory.minUsefulNotionalUsd.lte(0) ||
      inventory.minUsefulNotionalUsd.gt(inventory.seedNotionalUsd)
    ) {
      throw new Error(
        'auto_rotation.inventory.min_useful_notional_usd must be within the seed notional',
      );
    }
    if (!Number.isInteger(inventory.minStableMs) || inventory.minStableMs < 0) {
      throw new Error('auto_rotation.inventory.min_stable_ms must be a non-negative integer');
    }
    if (
      !inventory.maxPairDeviationBps.isFinite() ||
      inventory.maxPairDeviationBps.lt(0) ||
      inventory.maxPairDeviationBps.gt(100)
    ) {
      throw new Error('auto_rotation.inventory.max_pair_deviation_bps is outside the safety bound');
    }
    if (
      !inventory.maxPriceDriftBps.isFinite() ||
      inventory.maxPriceDriftBps.lt(0) ||
      inventory.maxPriceDriftBps.gt(500)
    ) {
      throw new Error('auto_rotation.inventory.max_price_drift_bps is outside the safety bound');
    }
    if (!Number.isInteger(inventory.checkIntervalMs) || inventory.checkIntervalMs <= 0) {
      throw new Error('auto_rotation.inventory.check_interval_ms must be a positive integer');
    }
    if (!Number.isInteger(inventory.retryCooldownMs) || inventory.retryCooldownMs < 0) {
      throw new Error('auto_rotation.inventory.retry_cooldown_ms must be a non-negative integer');
    }
    if (preparation.enabled) {
      if (!Number.isInteger(preparation.minStableMs) || preparation.minStableMs < 0) {
        throw new Error('auto_rotation.preparation.min_stable_ms must be a non-negative integer');
      }
      if (
        !preparation.maxNotional.isFinite() ||
        preparation.maxNotional.lte(0) ||
        preparation.maxNotional.gt(config.riskLimits.maxOrderNotional)
      ) {
        throw new Error('auto_rotation.preparation.max_notional is outside the order limit');
      }
      if (preparation.calibrationFile === '' || Object.keys(preparation.calibration).length === 0) {
        throw new Error('auto_rotation.preparation requires a non-empty calibration_file');
      }
      if (
        !preparation.minReverseProbability.isFinite() ||
        preparation.minReverseProbability.lt(0) ||
        preparation.minReverseProbability.gt(1) ||
        !preparation.minExpectedValueBps.isFinite() ||
        preparation.minExpectedValueBps.lt(0) ||
        !preparation.minExpectedValueUsd.isFinite() ||
        preparation.minExpectedValueUsd.lt(0) ||
        !Number.isInteger(preparation.maxHoldMs) ||
        preparation.maxHoldMs <= 0
      ) {
        throw new Error('auto_rotation.preparation reversion gate is outside the safety bound');
      }
    }
  }
  if (!Number.isInteger(config.handoffMaxAgeMs) || config.handoffMaxAgeMs <= 0) {
    throw new Error('execution.handoff_max_age_ms must be a positive integer');
  }
  if (!Number.isInteger(config.orderbookDepth) || config.orderbookDepth < 1) {
    throw new Error('scanner.orderbook_depth must be a positive integer');
  }
  if (!config.minSizingNotional.isFinite() || config.minSizingNotional.lte(0)) {
    throw new Error('scanner.min_sizing_notional must be positive');
  }
  const transfers = config.transfers;
  if (transfers.maxInFlightBatches !== 1) {
    throw new Error('transfers.max_in_flight_batches must be 1 for the MVP');
  }
  if (!transfers.requireManualConfirmation) {
    throw new Error('transfers.require_manual_confirmation must remain true for the MVP');
  }
  if (
    !Number.isInteger(transfers.maxLegsPerBatch) ||
    transfers.maxLegsPerBatch < 1 ||
    transfers.maxLegsPerBatch > 2
  ) {
    throw new Error('transfers.max_legs_per_batch must be 1 or 2');
  }
  for (const [name, value] of [
    ['max_balance_age_ms', transfers.maxBalanceAgeMs],
    ['poll_interval_ms', transfers.pollIntervalMs],
    ['withdrawal_timeout_ms', transfers.withdrawalTimeoutMs],
    ['deposit_timeout_ms', transfers.depositTimeoutMs],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`transfers.${name} must be a positive integer`);
    }
  }
  if (transfers.pollIntervalMs >= transfers.withdrawalTimeoutMs) {
    throw new Error('transfers.poll_interval_ms must be below withdrawal_timeout_ms');
  }
  if (!transfers.minNetEdgeBps.isFinite() || transfers.minNetEdgeBps.lt(0)) {
    throw new Error('transfers.min_net_edge_bps must be non-negative');
  }
  if (!transfers.maxCostUsd.isFinite() || transfers.maxCostUsd.lte(0)) {
    throw new Error('transfers.max_cost_usd must be positive');
  }
  if (!Number.isInteger(transfers.maxArrivalMs) || transfers.maxArrivalMs <= 0) {
    throw new Error('transfers.max_arrival_ms must be a positive integer');
  }
  if (transfers.enabled) {
    if (!config.liveEnabled) {
      throw new Error('transfers.enabled requires execution.live_enabled=true');
    }
    if (config.killSwitch) {
      throw new Error('transfers.enabled requires execution.kill_switch=false');
    }
    if (transfers.allowlist.length === 0) {
      throw new Error('transfers.enabled requires at least one allowlist entry');
    }
    for (const entry of transfers.allowlist) {
      if (
        entry.expectedArrivalMs !== undefined &&
        entry.expectedArrivalMs > transfers.maxArrivalMs
      ) {
        throw new Error(
          `transfers.allowlist ${entry.fromVenue}->${entry.toVenue}/${entry.asset} expected arrival exceeds max_arrival_ms`,
        );
      }
      if (transfers.releaseMode === 'automatic') {
        if (entry.withdrawFee === undefined) {
          throw new Error(
            `transfers.allowlist ${entry.fromVenue}->${entry.toVenue}/${entry.asset} requires withdraw_fee for automatic release`,
          );
        }
        if (entry.feeMode !== 'deducted') {
          throw new Error(
            `transfers.allowlist ${entry.fromVenue}->${entry.toVenue}/${entry.asset} requires fee_mode=deducted for automatic release`,
          );
        }
        if (entry.expectedArrivalMs === undefined) {
          throw new Error(
            `transfers.allowlist ${entry.fromVenue}->${entry.toVenue}/${entry.asset} requires expected_arrival_ms for automatic release`,
          );
        }
      }
    }
  }
  const accountStatus = config.accountStatus;
  if (!Number.isInteger(accountStatus.refreshMs) || accountStatus.refreshMs <= 0) {
    throw new Error('account_status.refresh_ms must be a positive integer');
  }
  if (!Number.isInteger(accountStatus.staleMs) || accountStatus.staleMs <= 0) {
    throw new Error('account_status.stale_ms must be a positive integer');
  }
  if (accountStatus.staleMs < accountStatus.refreshMs) {
    throw new Error('account_status.stale_ms cannot be below refresh_ms');
  }
}

export function loadExecutorConfig(
  path = process.env.ARB_CONFIG ?? 'config/default.toml',
  environment: NodeJS.ProcessEnv = process.env,
): ExecutorConfig {
  const document = parse(readFileSync(path, 'utf8')) as Table;
  const scanner = table(document.scanner, 'scanner');
  const execution = table(document.execution, 'execution');
  const database = table(document.database, 'database');
  const liveEnabled = booleanValue(execution, 'live_enabled', false);
  const killSwitch = booleanValue(execution, 'kill_switch', true);
  const manualConfirmation = booleanValue(execution, 'manual_confirmation', true);
  const maxOpenBatches = numberValue(execution, 'max_open_batches', 1);
  const minNetProfitBps = decimalValue(scanner, 'min_net_profit_bps', '20');
  const maxOrderbookAgeMs = numberValue(scanner, 'max_orderbook_age_ms', 3000);
  const orderbookDepth = numberValue(scanner, 'orderbook_depth', 20);
  const executionRequestsPerSecond = numberValue(execution, 'requests_per_second', 5);
  const minSizingNotional = decimalValue(scanner, 'min_sizing_notional', '1');
  const maxSlippageBps = decimalValue(scanner, 'max_slippage_bps', '50');
  const maxOrderNotional = decimalValue(scanner, 'max_order_notional', '30');
  const handoffMaxAgeMs = numberValue(execution, 'handoff_max_age_ms', 15_000);
  const autoRotation = autoRotationConfig(document.auto_rotation, handoffMaxAgeMs);
  const config: ExecutorConfig = {
    databasePath:
      environment.ARB_DATABASE_PATH ?? stringValue(database, 'path', 'data/arbitrage.sqlite'),
    secretStorePath: environment.ARB_SECRET_STORE_PATH ?? 'data/secrets.enc.json',
    liveEnabled,
    killSwitch,
    manualConfirmation,
    maxOpenBatches: 1,
    handoffMaxAgeMs,
    orderbookDepth,
    executionRequestsPerSecond,
    minSizingNotional,
    legMode: legModeValue(execution, 'leg_mode', 'serial'),
    iocVenues: stringArray(execution, 'ioc_venues', []),
    fokVenues: stringArray(execution, 'fok_venues', []),
    feeFile: typeof scanner.fee_file === 'string' ? scanner.fee_file : '',
    feeOverrides: feeOverrides(document.fees),
    transfers: transferConfig(document.transfers),
    autoRotation,
    accountStatus: accountStatusConfig(document.account_status),
    riskLimits: {
      maxOrderNotional,
      dailyMaxLoss: decimalValue(execution, 'daily_max_loss_usd', '20'),
      maxOpenBatches: 1,
      minNetProfitBps,
      maxStaleOrderbookMs: maxOrderbookAgeMs,
      maxSlippageBps,
      killSwitchDefault: killSwitch,
    },
    settings: {
      maxOrderbookAgeMs,
      orderbookDepth,
      maxSignalAgeMs: autoRotation.maxSignalAgeMs,
      maxPreflightMs: autoRotation.maxPreflightMs,
      minNetProfitBps,
      maxSlippageBps,
      minProfitUsd: decimalValue(scanner, 'min_profit_usd', '0.25'),
      safetyBufferBps: decimalValue(scanner, 'safety_buffer_bps', '15'),
      maxGasCostUsd: decimalValue(scanner, 'max_gas_cost_usd', '0.50'),
      maxTransferTaxBps: decimalValue(scanner, 'max_transfer_tax_bps', '0'),
      minBuyQuoteReserveUsd: autoRotation.inventory.minQuoteReserveUsd,
    },
  };
  if (maxOpenBatches !== 1) throw new Error('execution.max_open_batches must be 1');
  if (
    !Number.isInteger(executionRequestsPerSecond) ||
    executionRequestsPerSecond < 1 ||
    executionRequestsPerSecond > 20
  ) {
    throw new Error('execution.requests_per_second must be an integer between 1 and 20');
  }
  validateSafetyBounds(config);
  return config;
}
