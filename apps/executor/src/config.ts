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
  minAmount: Decimal;
  maxAmount: Decimal;
  dailyMaxAmount: Decimal;
  withdrawFee?: Decimal;
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
  allowlist: TransferAllowlistEntry[];
}

export interface ExecutorConfig {
  databasePath: string;
  secretStorePath: string;
  liveEnabled: boolean;
  killSwitch: boolean;
  manualConfirmation: boolean;
  maxOpenBatches: 1;
  handoffMaxAgeMs: number;
  legMode: LegExecutionMode;
  iocVenues: string[];
  fokVenues: string[];
  feeFile: string;
  feeOverrides: Record<string, VenueFeeOverride>;
  transfers: TransferConfig;
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
    if (fromVenue === toVenue) {
      throw new Error('transfers.allowlist from_venue and to_venue must differ');
    }
    const minAmount = decimalValue(row, 'min_amount', '0');
    const maxAmount = decimalValue(row, 'max_amount');
    const dailyMaxAmount = decimalValue(row, 'daily_max_amount');
    const withdrawFee =
      row.withdraw_fee === undefined ? undefined : decimalValue(row, 'withdraw_fee');
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
      minAmount,
      maxAmount,
      dailyMaxAmount,
      ...(withdrawFee !== undefined ? { withdrawFee } : {}),
    };
  });
}

function transferConfig(value: unknown): TransferConfig {
  const transfers = optionalTable(value, 'transfers');
  return {
    enabled: booleanValue(transfers, 'enabled', false),
    requireManualConfirmation: booleanValue(transfers, 'require_manual_confirmation', true),
    maxInFlightBatches: numberValue(transfers, 'max_in_flight_batches', 1),
    maxLegsPerBatch: numberValue(transfers, 'max_legs_per_batch', 2),
    maxBalanceAgeMs: numberValue(transfers, 'max_balance_age_ms', 300_000),
    pollIntervalMs: numberValue(transfers, 'poll_interval_ms', 15_000),
    withdrawalTimeoutMs: numberValue(transfers, 'withdrawal_timeout_ms', 900_000),
    depositTimeoutMs: numberValue(transfers, 'deposit_timeout_ms', 1_800_000),
    allowlist: transferAllowlist(transfers.allowlist),
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
  if (!Number.isInteger(config.handoffMaxAgeMs) || config.handoffMaxAgeMs <= 0) {
    throw new Error('execution.handoff_max_age_ms must be a positive integer');
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
  const maxSlippageBps = decimalValue(scanner, 'max_slippage_bps', '50');
  const maxOrderNotional = decimalValue(scanner, 'max_order_notional', '30');
  const config: ExecutorConfig = {
    databasePath:
      environment.ARB_DATABASE_PATH ?? stringValue(database, 'path', 'data/arbitrage.sqlite'),
    secretStorePath: environment.ARB_SECRET_STORE_PATH ?? 'data/secrets.enc.json',
    liveEnabled,
    killSwitch,
    manualConfirmation,
    maxOpenBatches: 1,
    handoffMaxAgeMs: numberValue(execution, 'handoff_max_age_ms', 15_000),
    legMode: legModeValue(execution, 'leg_mode', 'serial'),
    iocVenues: stringArray(execution, 'ioc_venues', []),
    fokVenues: stringArray(execution, 'fok_venues', []),
    feeFile: typeof scanner.fee_file === 'string' ? scanner.fee_file : '',
    feeOverrides: feeOverrides(document.fees),
    transfers: transferConfig(document.transfers),
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
      minNetProfitBps,
      maxSlippageBps,
      minProfitUsd: decimalValue(scanner, 'min_profit_usd', '0.25'),
      safetyBufferBps: decimalValue(scanner, 'safety_buffer_bps', '15'),
      maxGasCostUsd: decimalValue(scanner, 'max_gas_cost_usd', '0.50'),
      maxTransferTaxBps: decimalValue(scanner, 'max_transfer_tax_bps', '0'),
    },
  };
  if (maxOpenBatches !== 1) throw new Error('execution.max_open_batches must be 1');
  validateSafetyBounds(config);
  return config;
}
