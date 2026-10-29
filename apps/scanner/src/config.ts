import { readFileSync } from 'node:fs';
import { Decimal, type CostSettings, type ExecutionMode } from '@arb/core';
import type { VenueFeeOverride } from '@arb/venues-cex';
import { parse } from 'smol-toml';

export interface ScannerConfig {
  enabledVenues: string[];
  monitorOnlyVenues: string[];
  quoteCurrency: string;
  assetUniverseMode: 'top_volume' | 'explicit';
  maxBaseAssets: number;
  quoteCurrencies: string[];
  min24hQuoteVolumeUsd: Decimal;
  max24hQuoteVolumeUsd?: Decimal;
  universeRefreshMs: number;
  scanIntervalHotMs: number;
  scanIntervalTop100Ms: number;
  scanIntervalTop500Ms: number;
  signalCooldownMs: number;
  fetchConcurrency: number;
  baseAssets: string[];
  requestedNotional: Decimal;
  maxOrderbookAgeMs: number;
  maxFeedLatencyMs: number;
  maxFreezeMs: number;
  feedMode: 'rest' | 'websocket';
  wsMaxBookAgeMs: number;
  wsMaxSubscriptions: number;
  wsMaxReconnectAttempts: number;
  wsRestFallbackPerVenue: number;
  entryGateMode: 'off' | 'percentile';
  entryPercentile: Decimal;
  entryGateWindowMs: number;
  entryGateMinSamples: number;
  bookSanityEnabled: boolean;
  bookSanityIntervalMs: number;
  bookSanityMaxDeviationBps: Decimal;
  bookSanityRequiredFailures: number;
  bookSanityRequiredSuccesses: number;
  bookSanityCooldownMs: number;
  bookSanitySampleSize: number;
  prefilterEnabled: boolean;
  prefilterFloorBps: number;
  incrementalEvaluation: boolean;
  routeCooldownMs: number;
  hotScanDebounceMs: number;
  hotDepthLevels: number;
  hotScanBudgetMs: number;
  hotNearMissBps: Decimal;
  hotSubscriptionRefreshMs: number;
  hotSeedEnabled: boolean;
  hotSeedLookbackMs: number;
  hotSeedLimit: number;
  hotSeedTtlMs: number;
  recordFeed: boolean;
  recordFeedDir: string;
  wsScanIntervalMs: number;
  wsReconnectMinMs: number;
  wsReconnectMaxMs: number;
  minTopDepthQty: Decimal;
  liquidityTopLevels: number;
  liquidityMultiple: Decimal;
  rebalanceCostBps: Decimal;
  executionMode: ExecutionMode;
  makerFillProbability: Decimal;
  maxPriceDeviationBps: Decimal;
  suspiciousSpreadBps: Decimal;
  maxPairSkewMs: number;
  minReliabilityScore: Decimal;
  scanIntervalMs: number;
  minNetProfitBps: Decimal;
  safetyBufferBps: Decimal;
  minProfitUsd: Decimal;
  maxSlippageBps: Decimal;
  maxGasCostUsd: Decimal;
  maxTransferTaxBps: Decimal;
  minPoolLiquidityUsd: Decimal;
  minPool24hVolumeUsd: Decimal;
  transferRiskBufferBps: Decimal;
  depositRiskBufferBps: Decimal;
  orderBookDepth: number;
  maxTriangularPaths: number;
  maxCandidatesPerCycle: number;
  maxHops: number;
  maxLegsPerCurrency: number;
  crossVenueMode: 'off' | 'inventory';
  maxVenueSwitches: number;
  balanceMaxAgeMs: number;
  requireBalancesForS1: boolean;
  optimalSizing: boolean;
  minSizingNotional: Decimal;
  sizingStep: Decimal;
  maxSizingCandidatesPerCycle: number;
  sizingSamples: number;
  feeFile: string;
  persistSnapshots: boolean;
}

export interface ExecutionConfig {
  liveEnabled: boolean;
  killSwitch: boolean;
  manualConfirmation: boolean;
  maxOpenBatches: number;
  dailyMaxLossUsd: Decimal;
  maxOrderNotional: Decimal;
}

export interface DatabaseConfig {
  path: string;
}

export interface BscConfig {
  enabled: boolean;
  primaryProvider: '0x' | '1inch';
  backupProvider: '0x' | '1inch';
  tokenSymbols: string[];
  bnbUsd: Decimal;
  slippageBps: Decimal;
  inventoryMode: boolean;
  estimatedTransferArrivalMs: number;
  maxTransferArrivalMs: number;
}

export interface ApiConfig {
  host: string;
  port: number;
}

export type FeeOverride = VenueFeeOverride;

export interface AppConfig {
  scanner: ScannerConfig;
  execution: ExecutionConfig;
  database: DatabaseConfig;
  api: ApiConfig;
  bsc: BscConfig;
  fees: Record<string, FeeOverride>;
}

type Table = Record<string, unknown>;

function table(value: unknown, name: string): Table {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`config section [${name}] is missing`);
  }
  return value as Table;
}

function stringValue(source: Table, key: string, fallback?: string): string {
  const value = source[key] ?? fallback;
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`config value ${key} must be a string`);
  return value;
}

function numberValue(source: Table, key: string, fallback?: number): number {
  const value = source[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`config value ${key} must be a number`);
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
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error(`config value ${key} must be finite`);
  return result;
}

function stringArray(source: Table, key: string, fallback: string[]): string[] {
  const value = source[key] ?? fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`config value ${key} must be a string array`);
  }
  return value as string[];
}

function feeOverrides(value: unknown): Record<string, FeeOverride> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config section [fees] must be a table');
  }
  const result: Record<string, FeeOverride> = {};
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

export function loadConfig(path = 'config/default.toml'): AppConfig {
  const document = parse(readFileSync(path, 'utf8')) as Table;
  const scanner = table(document.scanner, 'scanner');
  const execution = table(document.execution, 'execution');
  const database = table(document.database, 'database');
  const api = table(document.api, 'api');
  const bsc = document.bsc ? table(document.bsc, 'bsc') : {};
  const quoteCurrency = stringValue(scanner, 'quote_currency', 'USDT');
  const quoteCurrencies = stringArray(scanner, 'quote_currencies', [quoteCurrency]).map((quote) =>
    quote.trim().toUpperCase(),
  );
  const assetUniverseMode = stringValue(scanner, 'asset_universe_mode', 'top_volume');
  if (assetUniverseMode !== 'top_volume' && assetUniverseMode !== 'explicit') {
    throw new Error('config value asset_universe_mode must be top_volume or explicit');
  }
  const crossVenueMode = stringValue(scanner, 'cross_venue_mode', 'off');
  if (crossVenueMode !== 'off' && crossVenueMode !== 'inventory') {
    throw new Error('config value cross_venue_mode must be off or inventory');
  }
  const feedMode = stringValue(scanner, 'feed_mode', 'rest');
  if (feedMode !== 'rest' && feedMode !== 'websocket') {
    throw new Error('config value feed_mode must be rest or websocket');
  }
  const executionMode = stringValue(scanner, 'execution_mode', 'taker_taker');
  if (
    executionMode !== 'taker_taker' &&
    executionMode !== 'maker_buy_taker_sell' &&
    executionMode !== 'taker_buy_maker_sell'
  ) {
    throw new Error(
      'config value execution_mode must be taker_taker, maker_buy_taker_sell, or taker_buy_maker_sell',
    );
  }
  const entryGateMode = stringValue(scanner, 'entry_gate_mode', 'off');
  if (entryGateMode !== 'off' && entryGateMode !== 'percentile') {
    throw new Error('config value entry_gate_mode must be off or percentile');
  }
  const enabledVenues = stringArray(scanner, 'enabled_venues', ['gateio', 'mexc', 'weex']);
  const monitorOnlyVenues = stringArray(scanner, 'monitor_only_venues', []);
  const unknownMonitorOnly = monitorOnlyVenues.filter(
    (venueId) => !enabledVenues.includes(venueId),
  );
  if (unknownMonitorOnly.length > 0) {
    throw new Error(
      `monitor_only_venues must be a subset of enabled_venues: ${unknownMonitorOnly.join(',')}`,
    );
  }
  const config: AppConfig = {
    scanner: {
      enabledVenues,
      monitorOnlyVenues,
      quoteCurrency,
      assetUniverseMode,
      maxBaseAssets: numberValue(scanner, 'max_base_assets', 100),
      quoteCurrencies,
      min24hQuoteVolumeUsd: decimalValue(scanner, 'min_24h_quote_volume_usd', '1000000'),
      ...(scanner.max_24h_quote_volume_usd !== undefined
        ? { max24hQuoteVolumeUsd: decimalValue(scanner, 'max_24h_quote_volume_usd', '0') }
        : {}),
      universeRefreshMs: numberValue(scanner, 'universe_refresh_ms', 3_600_000),
      scanIntervalHotMs: numberValue(scanner, 'scan_interval_hot_ms', 30_000),
      scanIntervalTop100Ms: numberValue(scanner, 'scan_interval_top100_ms', 120_000),
      scanIntervalTop500Ms: numberValue(scanner, 'scan_interval_top500_ms', 600_000),
      signalCooldownMs: numberValue(scanner, 'signal_cooldown_ms', 300_000),
      fetchConcurrency: numberValue(scanner, 'fetch_concurrency', 8),
      baseAssets: stringArray(scanner, 'base_assets', ['CAKE', 'BNB', 'ETH', 'BTC']),
      requestedNotional: decimalValue(scanner, 'max_order_notional', '30'),
      maxOrderbookAgeMs: numberValue(scanner, 'max_orderbook_age_ms', 3000),
      maxFeedLatencyMs: numberValue(scanner, 'max_feed_latency_ms', 500),
      maxFreezeMs: numberValue(scanner, 'max_freeze_ms', 5000),
      feedMode,
      wsMaxBookAgeMs: numberValue(scanner, 'ws_max_book_age_ms', 2000),
      wsMaxSubscriptions: numberValue(scanner, 'ws_max_subscriptions', 1200),
      wsMaxReconnectAttempts: numberValue(scanner, 'ws_max_reconnect_attempts', 5),
      wsRestFallbackPerVenue: numberValue(scanner, 'ws_rest_fallback_per_venue', 8),
      entryGateMode,
      entryPercentile: decimalValue(scanner, 'entry_percentile', '90'),
      entryGateWindowMs: numberValue(scanner, 'entry_gate_window_ms', 3_600_000),
      entryGateMinSamples: numberValue(scanner, 'entry_gate_min_samples', 50),
      bookSanityEnabled: booleanValue(scanner, 'book_sanity_enabled', false),
      bookSanityIntervalMs: numberValue(scanner, 'book_sanity_interval_ms', 60_000),
      bookSanityMaxDeviationBps: decimalValue(scanner, 'book_sanity_max_deviation_bps', '50'),
      bookSanityRequiredFailures: numberValue(scanner, 'book_sanity_required_failures', 3),
      bookSanityRequiredSuccesses: numberValue(scanner, 'book_sanity_required_successes', 3),
      bookSanityCooldownMs: numberValue(scanner, 'book_sanity_cooldown_ms', 300_000),
      bookSanitySampleSize: numberValue(scanner, 'book_sanity_sample_size', 4),
      prefilterEnabled: booleanValue(scanner, 'prefilter_enabled', false),
      prefilterFloorBps: numberValue(scanner, 'prefilter_floor_bps', 0),
      incrementalEvaluation: booleanValue(scanner, 'incremental_evaluation', false),
      routeCooldownMs: numberValue(scanner, 'route_cooldown_ms', 0),
      hotScanDebounceMs: numberValue(scanner, 'hot_scan_debounce_ms', 25),
      hotDepthLevels: numberValue(scanner, 'hot_depth_levels', 3),
      hotScanBudgetMs: numberValue(scanner, 'hot_scan_budget_ms', 250),
      hotNearMissBps: decimalValue(scanner, 'hot_near_miss_bps', '5'),
      hotSubscriptionRefreshMs: numberValue(scanner, 'hot_subscription_refresh_ms', 5_000),
      hotSeedEnabled: booleanValue(scanner, 'hot_seed_enabled', true),
      hotSeedLookbackMs: numberValue(scanner, 'hot_seed_lookback_ms', 7 * 24 * 60 * 60 * 1000),
      hotSeedLimit: numberValue(scanner, 'hot_seed_limit', 30),
      hotSeedTtlMs: numberValue(scanner, 'hot_seed_ttl_ms', 60 * 60 * 1000),
      recordFeed: booleanValue(scanner, 'record_feed', false),
      recordFeedDir: stringValue(scanner, 'record_feed_dir', 'data/feed'),
      wsScanIntervalMs: numberValue(scanner, 'ws_scan_interval_ms', 1000),
      wsReconnectMinMs: numberValue(scanner, 'ws_reconnect_min_ms', 1000),
      wsReconnectMaxMs: numberValue(scanner, 'ws_reconnect_max_ms', 30000),
      minTopDepthQty: decimalValue(scanner, 'min_top_depth_qty', '0'),
      liquidityTopLevels: numberValue(scanner, 'liquidity_top_levels', 5),
      liquidityMultiple: decimalValue(scanner, 'liquidity_multiple', '1.5'),
      rebalanceCostBps: decimalValue(scanner, 'rebalance_cost_bps', '0'),
      executionMode,
      makerFillProbability: decimalValue(scanner, 'maker_fill_probability', '0.5'),
      maxPriceDeviationBps: decimalValue(scanner, 'max_price_deviation_bps', '0'),
      suspiciousSpreadBps: decimalValue(scanner, 'suspicious_spread_bps', '0'),
      maxPairSkewMs: numberValue(scanner, 'max_pair_skew_ms', 0),
      minReliabilityScore: decimalValue(scanner, 'min_reliability_score', '0'),
      scanIntervalMs: numberValue(scanner, 'scan_interval_ms', 5000),
      minNetProfitBps: decimalValue(scanner, 'min_net_profit_bps', '20'),
      safetyBufferBps: decimalValue(scanner, 'safety_buffer_bps', '15'),
      minProfitUsd: decimalValue(scanner, 'min_profit_usd', '0.25'),
      maxSlippageBps: decimalValue(scanner, 'max_slippage_bps', '50'),
      maxGasCostUsd: decimalValue(scanner, 'max_gas_cost_usd', '0.50'),
      maxTransferTaxBps: decimalValue(scanner, 'max_transfer_tax_bps', '0'),
      minPoolLiquidityUsd: decimalValue(scanner, 'min_pool_liquidity_usd', '50000'),
      minPool24hVolumeUsd: decimalValue(scanner, 'min_pool_24h_volume_usd', '50000'),
      transferRiskBufferBps: decimalValue(scanner, 'transfer_risk_buffer_bps', '0'),
      depositRiskBufferBps: decimalValue(scanner, 'deposit_risk_buffer_bps', '0'),
      orderBookDepth: numberValue(scanner, 'orderbook_depth', 50),
      maxTriangularPaths: numberValue(scanner, 'max_triangular_paths', 100),
      maxCandidatesPerCycle: numberValue(scanner, 'max_candidates_per_cycle', 100),
      maxHops: numberValue(scanner, 'max_hops', 5),
      maxLegsPerCurrency: numberValue(scanner, 'max_legs_per_currency', 4),
      crossVenueMode,
      maxVenueSwitches: numberValue(scanner, 'max_venue_switches', 1),
      balanceMaxAgeMs: numberValue(scanner, 'balance_max_age_ms', 300_000),
      requireBalancesForS1: booleanValue(scanner, 'require_balances_for_s1', false),
      optimalSizing: booleanValue(scanner, 'optimal_sizing', true),
      minSizingNotional: decimalValue(scanner, 'min_sizing_notional', '1'),
      sizingStep: decimalValue(scanner, 'sizing_step', '0.01'),
      maxSizingCandidatesPerCycle: numberValue(scanner, 'max_sizing_candidates_per_cycle', 40),
      sizingSamples: numberValue(scanner, 'sizing_samples', 16),
      feeFile: typeof scanner.fee_file === 'string' ? scanner.fee_file : '',
      persistSnapshots: booleanValue(scanner, 'persist_snapshots', true),
    },
    execution: {
      liveEnabled: booleanValue(execution, 'live_enabled', false),
      killSwitch: booleanValue(execution, 'kill_switch', true),
      manualConfirmation: booleanValue(execution, 'manual_confirmation', true),
      maxOpenBatches: numberValue(execution, 'max_open_batches', 1),
      dailyMaxLossUsd: decimalValue(execution, 'daily_max_loss_usd', '20'),
      maxOrderNotional: decimalValue(execution, 'max_order_notional', '30'),
    },
    database: { path: stringValue(database, 'path', 'data/arbitrage.sqlite') },
    api: {
      host: stringValue(api, 'host', '127.0.0.1'),
      port: numberValue(api, 'port', 8787),
    },
    bsc: {
      enabled: booleanValue(bsc, 'enabled', false),
      primaryProvider: stringValue(bsc, 'primary_provider', '0x') as '0x' | '1inch',
      backupProvider: stringValue(bsc, 'backup_provider', '1inch') as '0x' | '1inch',
      tokenSymbols: stringArray(bsc, 'token_symbols', ['CAKE', 'BNB', 'USDT', 'USDC']),
      bnbUsd: decimalValue(bsc, 'bnb_usd', '600'),
      slippageBps: decimalValue(bsc, 'slippage_bps', '10'),
      inventoryMode: booleanValue(bsc, 'inventory_mode', true),
      estimatedTransferArrivalMs: numberValue(bsc, 'estimated_transfer_arrival_ms', 900_000),
      maxTransferArrivalMs: numberValue(bsc, 'max_transfer_arrival_ms', 1_800_000),
    },
    fees: feeOverrides(document.fees),
  };
  return config;
}

export function costSettings(config: ScannerConfig): CostSettings {
  return {
    minProfitUsd: config.minProfitUsd,
    safetyBufferBps: config.safetyBufferBps,
    minNetProfitBps: config.minNetProfitBps,
    maxOrderbookAgeMs: config.maxOrderbookAgeMs,
    minTopDepthQty: config.minTopDepthQty,
    liquidityTopLevels: config.liquidityTopLevels,
    rebalanceCostBps: config.rebalanceCostBps,
    executionMode: config.executionMode,
    makerFillProbability: config.makerFillProbability,
    maxPriceDeviationBps: config.maxPriceDeviationBps,
    suspiciousSpreadBps: config.suspiciousSpreadBps,
    maxPairSkewMs: config.maxPairSkewMs,
    minReliabilityScore: config.minReliabilityScore,
    maxSlippageBps: config.maxSlippageBps,
    maxGasCostUsd: config.maxGasCostUsd,
    maxTransferTaxBps: config.maxTransferTaxBps,
    minPoolLiquidityUsd: config.minPoolLiquidityUsd,
    minPool24hVolumeUsd: config.minPool24hVolumeUsd,
    transferRiskBufferBps: config.transferRiskBufferBps,
    depositRiskBufferBps: config.depositRiskBufferBps,
  };
}
