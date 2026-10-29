import {
  Decimal,
  type CurrencyMetadata,
  type DexQuote,
  type HealthSnapshot,
  type MarketMetadata,
  type OpportunityResult,
  type TokenRiskLevel,
} from '@arb/core';
import type { OrderBookSnapshot } from '@arb/core';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface EpisodeRow {
  id: number;
  episode_end: number;
  sample_count: number;
}

interface TransferBatchRow {
  id: string;
  status: string;
  plan_json: string;
  confirmation: string | null;
  dry_run: number;
  safe_mode_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface TransferLegRow {
  id: number;
  batch_id: string;
  leg_number: number;
  from_venue: string;
  to_venue: string;
  asset: string;
  network: string;
  amount: string;
  fee: string | null;
  address: string;
  address_tag: string | null;
  status: string;
  source_record_id: string | null;
  source_tx_id: string | null;
  destination_record_id: string | null;
  destination_tx_id: string | null;
  requested_at: number | null;
  source_observed_at: number | null;
  destination_observed_at: number | null;
  error: string | null;
  metadata_json: string;
  updated_at: number;
}

export interface StoredOpportunity {
  id: number;
  episodeId: number | null;
}

export interface LoadedOpportunity {
  id: number;
  opportunity: OpportunityResult;
}

export interface OpportunityExecutionReference {
  batchId: string;
  status: string;
  openedAt: number;
}

export interface OpportunityQuery {
  validOnly?: boolean;
  limit?: number;
}

export interface PaperTradeRecord {
  opportunityId: number;
  requestedNotional: Decimal;
  simulatedBaseAmount: Decimal;
  buyPriceAverage: Decimal;
  sellPriceAverage: Decimal;
  buyPriceWorst?: Decimal;
  sellPriceWorst?: Decimal;
  fees: Decimal;
  gasCost: Decimal;
  netProfit: Decimal;
  result: string;
  executedAt: number;
  durationMs?: number;
  expectedFailureReasons?: string[];
  fillQuality?: unknown;
}

export interface BscTokenRecord {
  contractAddress: string;
  symbol: string;
  decimals: number;
  name?: string;
  verifiedContract: boolean;
  transferTaxBps: Decimal;
  liquidityUsd?: Decimal;
  volume24hUsd?: Decimal;
  riskLevel: TokenRiskLevel;
  updatedAt?: number;
}

export interface TokenMappingRecord {
  cexVenueId: string;
  cexCurrency: string;
  chain?: 'BSC';
  contractAddress: string;
  status: 'candidate' | 'active' | 'rejected';
  verificationSources: string[];
  transferTaxBps: Decimal;
  riskLevel: TokenRiskLevel;
  notes?: string;
  updatedAt?: number;
}

export interface BalanceRecord {
  venueId: string;
  accountId: string;
  currency: string;
  free: Decimal;
  used: Decimal;
  total: Decimal;
  fetchedAt: number;
}

export interface InventorySnapshotRecord {
  venueId: string;
  accountId: string;
  chain?: string;
  asset: string;
  contractAddress?: string;
  free: Decimal;
  used: Decimal;
  total: Decimal;
  usdValue?: Decimal;
  capturedAt: number;
}

export interface DailyRiskSnapshot {
  tradingDay: string;
  dailyRealizedLoss: Decimal;
  dailyRebalanceCost: Decimal;
  unhedgedInventoryRisk: Decimal;
}

export interface RolloutMetrics {
  generatedAt: number;
  executions: {
    total: number;
    closed: number;
    safeStop: number;
    open: number;
    fullyReconciled: number;
    fillRate: number;
    firstLegPartialRate: number;
    secondLegFailureRate: number;
  };
  orders: {
    total: number;
    submitted: number;
    unknown: number;
    unknownOrderRate: number;
    queryEvents: number;
    queryErrorEvents: number;
    queryErrorRate: number;
  };
  costs: {
    paperNetProfitUsd: Decimal;
    liveRealizedProfitUsd: Decimal;
    gasCostUsd: Decimal;
    rebalanceCostUsd: Decimal;
    unhedgedInventoryUsd: Decimal;
  };
  inventory: {
    snapshotPairs: number;
    observedNetChangeUsd: Decimal;
    observedAbsoluteChangeUsd: Decimal;
  };
  transferTax: {
    mappings: number;
    maxTransferTaxBps: Decimal;
  };
  risk: {
    events24h: number;
    criticalEvents24h: number;
    backoffEvents24h: number;
    operatorInterventions24h: number;
  };
}

export interface MarketUniverseEntry {
  venueId: string;
  exchangeSymbol: string;
  base: string;
  quote: string;
  quoteVolume24h?: Decimal;
  tier: 'hot' | 'top100' | 'top500';
}

export interface UnhedgedInventoryRecord {
  executionId: number;
  batchId: string;
  venueId: string;
  asset: string;
  amount: Decimal;
  usdValue: Decimal;
  direction?: 'long' | 'short';
  reason: string;
  createdAt?: number;
}

export interface TransferLegRecord {
  id: number;
  batchId: string;
  legNumber: number;
  fromVenue: string;
  toVenue: string;
  asset: string;
  network: string;
  amount: Decimal;
  fee: Decimal | null;
  address: string;
  addressTag: string | null;
  status: string;
  sourceRecordId: string | null;
  sourceTxId: string | null;
  destinationRecordId: string | null;
  destinationTxId: string | null;
  requestedAt: number | null;
  sourceObservedAt: number | null;
  destinationObservedAt: number | null;
  error: string | null;
  metadata: unknown;
  updatedAt: number;
}

export interface TransferBatchRecord {
  id: string;
  status: string;
  plan: unknown;
  confirmation: string | null;
  dryRun: boolean;
  safeModeReason: string | null;
  createdAt: number;
  updatedAt: number;
  legs: TransferLegRecord[];
}

export interface TransferLegInput {
  legNumber: number;
  fromVenue: string;
  toVenue: string;
  asset: string;
  network: string;
  amount: Decimal;
  fee?: Decimal;
  address: string;
  addressTag?: string;
  status: string;
  error?: string;
  metadata?: unknown;
}

export interface TransferLegUpdate {
  status?: string;
  fee?: Decimal | null;
  sourceRecordId?: string | null;
  sourceTxId?: string | null;
  destinationRecordId?: string | null;
  destinationTxId?: string | null;
  requestedAt?: number | null;
  sourceObservedAt?: number | null;
  destinationObservedAt?: number | null;
  error?: string | null;
  metadata?: unknown;
  updatedAt?: number;
}

export const ACTIVE_TRANSFER_STATUSES = [
  'PLANNED',
  'READY',
  'EXECUTING',
  'WITHDRAWING',
  'WITHDRAWN',
  'WAITING_DEPOSIT',
  'SAFE_STOP',
] as const;

export interface VenueBackoffRecord {
  venueId: string;
  backoffUntil: number;
  reason: string;
  consecutiveFailures: number;
  updatedAt: number;
}

export interface RecoveredOrder {
  id: number;
  executionId: number | null;
  venueId: string;
  venueOrderId: string | null;
  clientOrderId: string;
  symbol: string;
  side: string;
  type: string;
  price: string;
  amount: string;
  filledAmount: string;
  averagePrice: string | null;
  fee: string | null;
  feeCurrency: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionLegRecoveryRecord {
  id: number;
  executionId: number;
  legNumber: number;
  venueId: string;
  side: 'buy' | 'sell' | 'swap';
  requestedAmount: string;
  requestedPrice: string;
  submittedAt: number | null;
  status: string;
  filledAmount: string | null;
  averageFillPrice: string | null;
  feePaid: string | null;
  orderId: string | null;
  clientOrderId: string | null;
  error: string | null;
}

export interface ExecutionRecoveryRecord {
  id: number;
  strategy: string;
  batchId: string;
  status: string;
  plannedNotional: string;
  expectedProfit: string;
  realizedProfit: string | null;
  openedAt: number;
  closedAt: number | null;
  safeModeReason: string | null;
  legs: ExecutionLegRecoveryRecord[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJsonColumn(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number((part / total).toFixed(4));
}

function decimalColumn(row: Record<string, unknown>, key: string): Decimal {
  const value = row[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`stored opportunity column ${key} is invalid`);
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error(`stored opportunity column ${key} is not finite`);
  return parsed;
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`stored opportunity column ${key} is invalid`);
  }
  return value;
}

function opportunityFromRow(row: Record<string, unknown>): OpportunityResult {
  const strategy = stringColumn(row, 'strategy');
  if (strategy !== 'S1' && strategy !== 'S2' && strategy !== 'S3' && strategy !== 'S4') {
    throw new Error('stored opportunity strategy is invalid');
  }
  const instrumentBuy = stringColumn(row, 'instrument_buy');
  const instrumentSell = stringColumn(row, 'instrument_sell');
  if (instrumentBuy.trim().toUpperCase() !== instrumentSell.trim().toUpperCase()) {
    throw new Error('stored opportunity instruments do not match');
  }
  let metadata: Record<string, string> | undefined;
  const rawMetadata = row.metadata_json;
  if (typeof rawMetadata === 'string' && rawMetadata.trim() !== '') {
    const parsed = JSON.parse(rawMetadata) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
      });
      if (entries.length > 0) metadata = Object.fromEntries(entries);
    }
  }
  const rawReasons = row.rejection_reasons;
  const rejectionReasons = Array.isArray(rawReasons)
    ? (rawReasons as OpportunityResult['rejectionReasons'])
    : typeof rawReasons === 'string' && rawReasons.trim() !== ''
      ? (JSON.parse(rawReasons) as OpportunityResult['rejectionReasons'])
      : [];
  return {
    strategy,
    opportunityKey: stringColumn(row, 'opportunity_key'),
    instrumentKey: instrumentBuy,
    direction: stringColumn(row, 'direction'),
    venueBuy: stringColumn(row, 'venue_buy'),
    venueSell: stringColumn(row, 'venue_sell'),
    instrumentBuy,
    instrumentSell,
    requestedNotional: decimalColumn(row, 'requested_notional'),
    grossSpread: decimalColumn(row, 'gross_spread'),
    totalCost: decimalColumn(row, 'total_cost'),
    depthNetProfit: decimalColumn(row, 'depth_net_profit'),
    conservativeNetProfit: decimalColumn(row, 'conservative_net_profit'),
    netProfitBps: decimalColumn(row, 'net_profit_bps'),
    dataAgeMs: Number(row.data_age_ms),
    valid: Number(row.valid) === 1,
    rejectionReasons,
    sampledAt: Number(row.sampled_at),
    ...(metadata ? { metadata } : {}),
  };
}

export interface EpisodeSummary {
  strategy: string;
  episodes: number;
  openEpisodes: number;
  totalSamples: number;
  medianDurationMs: number;
  p90DurationMs: number;
  maxDurationMs: number;
  medianMaxProfit: Decimal;
}

export interface OpportunityDecaySummary {
  strategy: string;
  episodes: number;
  medianDurationMs: number;
  medianDecayBps: Decimal;
  improvingEpisodes: number;
  decayingEpisodes: number;
}

export interface S1RouteStats {
  instrument: string;
  venueBuy: string;
  venueSell: string;
  samples: number;
  evaluatedSamples: number;
  evaluationRate: number;
  validSamples: number;
  validRate: number;
  avgNetBps: Decimal;
  maxNetBps: Decimal;
  lastSeenAt: number;
  episodes: number;
  medianDurationMs: number;
  p90DurationMs: number;
  maxDurationMs: number;
}

function nearestRankPercentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function medianDecimal(values: readonly Decimal[]): Decimal {
  if (values.length === 0) return new Decimal(0);
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? sorted[middle - 1]!.plus(sorted[middle]!).div(2)
    : sorted[middle]!;
}

export class ArbitrageRepository {
  constructor(readonly db: DatabaseSync) {}

  upsertVenue(input: {
    id: string;
    type: 'cex' | 'dex' | 'aggregator' | 'chain';
    name: string;
    tier: 'S' | 'A' | 'B' | 'C';
    executionEnabled?: boolean;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    if (input.executionEnabled === undefined) {
      this.db
        .prepare(
          `INSERT INTO venues(id, type, name, tier, execution_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             type = excluded.type,
             name = excluded.name,
             tier = excluded.tier,
             updated_at = excluded.updated_at`,
        )
        .run(input.id, input.type, input.name, input.tier, now, now);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO venues(id, type, name, tier, execution_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           name = excluded.name,
           tier = excluded.tier,
           execution_enabled = excluded.execution_enabled,
           updated_at = excluded.updated_at`,
      )
      .run(input.id, input.type, input.name, input.tier, input.executionEnabled ? 1 : 0, now, now);
  }

  ensureVenue(input: {
    id: string;
    type: 'cex' | 'dex' | 'aggregator' | 'chain';
    name: string;
    tier: 'S' | 'A' | 'B' | 'C';
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO venues(
          id, type, name, tier, execution_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(input.id, input.type, input.name, input.tier, now, now);
  }

  venueExecutionEnabled(venueId: string): boolean {
    const row = this.db
      .prepare('SELECT execution_enabled FROM venues WHERE id = ?')
      .get(venueId) as { execution_enabled: number } | undefined;
    return row?.execution_enabled === 1;
  }

  setVenueExecutionEnabled(venueId: string, enabled: boolean, now = Date.now()): boolean {
    const result = this.db
      .prepare('UPDATE venues SET execution_enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, venueId) as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  upsertVenueBackoff(input: VenueBackoffRecord): void {
    this.db
      .prepare(
        `INSERT INTO venue_backoff(
          venue_id, backoff_until, reason, consecutive_failures, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(venue_id) DO UPDATE SET
          backoff_until = excluded.backoff_until,
          reason = excluded.reason,
          consecutive_failures = excluded.consecutive_failures,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.venueId,
        input.backoffUntil,
        input.reason,
        Math.max(0, input.consecutiveFailures),
        input.updatedAt,
      );
  }

  activeVenueBackoffs(now = Date.now()): VenueBackoffRecord[] {
    const rows = this.db
      .prepare(
        `SELECT venue_id, backoff_until, reason, consecutive_failures, updated_at
         FROM venue_backoff WHERE backoff_until > ? ORDER BY venue_id`,
      )
      .all(now) as Array<{
      venue_id: string;
      backoff_until: number;
      reason: string;
      consecutive_failures: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      venueId: row.venue_id,
      backoffUntil: row.backoff_until,
      reason: row.reason,
      consecutiveFailures: row.consecutive_failures,
      updatedAt: row.updated_at,
    }));
  }

  venueBackoff(venueId: string, now = Date.now()): VenueBackoffRecord | undefined {
    return this.activeVenueBackoffs(now).find((row) => row.venueId === venueId);
  }

  clearVenueBackoff(venueId: string): void {
    this.db.prepare('DELETE FROM venue_backoff WHERE venue_id = ?').run(venueId);
  }

  recordHealth(venueId: string, health: HealthSnapshot, measuredAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO venue_health(
          venue_id, measured_at, success_rate, median_latency_ms, p95_latency_ms,
          rate_limit_events, stale_data_events, health_state, score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        venueId,
        measuredAt,
        health.successRate,
        health.medianLatencyMs,
        health.p95LatencyMs,
        health.rateLimitEvents,
        health.staleDataEvents,
        health.healthState,
        health.score,
      );
  }

  upsertMarket(market: MarketMetadata, updatedAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO exchange_markets(
          venue_id, exchange_symbol, unified_symbol, base, quote, active,
          price_precision, amount_precision, amount_step, price_step, min_amount,
          min_notional, taker_fee_bps, maker_fee_bps, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id, exchange_symbol) DO UPDATE SET
          unified_symbol = excluded.unified_symbol,
          base = excluded.base,
          quote = excluded.quote,
          active = excluded.active,
          price_precision = excluded.price_precision,
          amount_precision = excluded.amount_precision,
          amount_step = excluded.amount_step,
          price_step = excluded.price_step,
          min_amount = excluded.min_amount,
          min_notional = excluded.min_notional,
          taker_fee_bps = excluded.taker_fee_bps,
          maker_fee_bps = excluded.maker_fee_bps,
          updated_at = excluded.updated_at`,
      )
      .run(
        market.venueId,
        market.exchangeSymbol,
        market.unifiedSymbol,
        market.base,
        market.quote,
        market.active ? 1 : 0,
        market.pricePrecision,
        market.amountPrecision,
        market.amountStep?.toFixed() ?? null,
        market.priceStep?.toFixed() ?? null,
        market.minAmount?.toFixed() ?? null,
        market.minNotional?.toFixed() ?? null,
        market.feeTakerBps?.toFixed() ?? null,
        market.makerFeeBps?.toFixed() ?? null,
        updatedAt,
      );
  }

  replaceMarketUniverse(
    venueId: string,
    entries: readonly MarketUniverseEntry[],
    updatedAt = Date.now(),
  ): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM market_universe WHERE venue_id = ?').run(venueId);
      const statement = this.db.prepare(
        `INSERT INTO market_universe(
          venue_id, exchange_symbol, base, quote, quote_volume_24h, tier, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of entries) {
        statement.run(
          venueId,
          entry.exchangeSymbol,
          entry.base,
          entry.quote,
          entry.quoteVolume24h?.toFixed() ?? null,
          entry.tier,
          updatedAt,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listMarketUniverse(venueId?: string): MarketUniverseEntry[] {
    const sql = `SELECT venue_id, exchange_symbol, base, quote, quote_volume_24h, tier
                 FROM market_universe`;
    const rows = (
      venueId
        ? this.db
            .prepare(
              `${sql} WHERE venue_id = ? ORDER BY quote, CAST(quote_volume_24h AS REAL) DESC`,
            )
            .all(venueId)
        : this.db
            .prepare(`${sql} ORDER BY venue_id, quote, CAST(quote_volume_24h AS REAL) DESC`)
            .all()
    ) as Array<{
      venue_id: string;
      exchange_symbol: string;
      base: string;
      quote: string;
      quote_volume_24h: string | null;
      tier: 'hot' | 'top100' | 'top500';
    }>;
    return rows.map((row) => ({
      venueId: row.venue_id,
      exchangeSymbol: row.exchange_symbol,
      base: row.base,
      quote: row.quote,
      ...(row.quote_volume_24h !== null
        ? { quoteVolume24h: new Decimal(row.quote_volume_24h) }
        : {}),
      tier: row.tier,
    }));
  }

  upsertCurrencies(currencies: readonly CurrencyMetadata[], updatedAt = Date.now()): void {
    const statement = this.db.prepare(
      `INSERT INTO exchange_currencies(
        venue_id, currency, network, native_network_name, withdraw_enabled,
        deposit_enabled, withdraw_fee, min_withdraw_amount, min_deposit_amount, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(venue_id, currency, network) DO UPDATE SET
        native_network_name = excluded.native_network_name,
        withdraw_enabled = excluded.withdraw_enabled,
        deposit_enabled = excluded.deposit_enabled,
        withdraw_fee = excluded.withdraw_fee,
        min_withdraw_amount = excluded.min_withdraw_amount,
        min_deposit_amount = excluded.min_deposit_amount,
        updated_at = excluded.updated_at`,
    );
    for (const currency of currencies) {
      for (const network of currency.networks) {
        statement.run(
          currency.venueId,
          currency.code,
          network.network,
          network.nativeName,
          network.withdrawEnabled ? 1 : 0,
          network.depositEnabled ? 1 : 0,
          network.withdrawFee?.toFixed() ?? null,
          network.minWithdrawAmount?.toFixed() ?? null,
          network.minDepositAmount?.toFixed() ?? null,
          updatedAt,
        );
      }
    }
  }

  upsertBscToken(token: BscTokenRecord): void {
    const updatedAt = token.updatedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO bsc_tokens(
          contract_address, symbol, decimals, name, verified_contract, transfer_tax_bps,
          liquidity_usd, volume_24h_usd, risk_level, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(contract_address) DO UPDATE SET
          symbol = excluded.symbol,
          decimals = excluded.decimals,
          name = excluded.name,
          verified_contract = excluded.verified_contract,
          transfer_tax_bps = excluded.transfer_tax_bps,
          liquidity_usd = excluded.liquidity_usd,
          volume_24h_usd = excluded.volume_24h_usd,
          risk_level = excluded.risk_level,
          updated_at = excluded.updated_at`,
      )
      .run(
        token.contractAddress,
        token.symbol,
        token.decimals,
        token.name ?? null,
        token.verifiedContract ? 1 : 0,
        token.transferTaxBps.toFixed(),
        token.liquidityUsd?.toFixed() ?? null,
        token.volume24hUsd?.toFixed() ?? null,
        token.riskLevel,
        updatedAt,
      );
  }

  upsertTokenMapping(mapping: TokenMappingRecord): void {
    const updatedAt = mapping.updatedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO token_mappings(
          cex_venue_id, cex_currency, chain, contract_address, status,
          verification_sources, transfer_tax_bps, risk_level, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cex_venue_id, cex_currency, chain, contract_address) DO UPDATE SET
          status = excluded.status,
          verification_sources = excluded.verification_sources,
          transfer_tax_bps = excluded.transfer_tax_bps,
          risk_level = excluded.risk_level,
          notes = excluded.notes,
          updated_at = excluded.updated_at`,
      )
      .run(
        mapping.cexVenueId,
        mapping.cexCurrency.toUpperCase(),
        mapping.chain ?? 'BSC',
        mapping.contractAddress,
        mapping.status,
        json(mapping.verificationSources),
        mapping.transferTaxBps.toFixed(),
        mapping.riskLevel,
        mapping.notes ?? null,
        updatedAt,
      );
  }

  recordDexQuote(quote: DexQuote): void {
    this.db
      .prepare(
        `INSERT INTO dex_quotes(
          provider_id, chain, sell_token, buy_token, sell_amount, buy_amount,
          fee_bps, price_impact_bps, gas_estimate, gas_price, gas_cost_usd,
          quoted_at, valid_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        quote.providerId,
        quote.chain,
        quote.sellToken,
        quote.buyToken,
        quote.sellAmount.toFixed(),
        quote.buyAmount.toFixed(),
        quote.feeBps.toFixed(),
        quote.priceImpactBps.toFixed(),
        quote.gasEstimate.toFixed(),
        quote.gasPrice.toFixed(),
        quote.gasCostUsd.toFixed(),
        quote.quotedAt,
        quote.validUntil ?? null,
      );
  }

  recordBalance(balance: BalanceRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO balances(
          venue_id, account_id, currency, free, used, total, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        balance.venueId,
        balance.accountId,
        balance.currency,
        balance.free.toFixed(),
        balance.used.toFixed(),
        balance.total.toFixed(),
        balance.fetchedAt,
      );
  }

  latestBalances(options: { maxAgeMs?: number; now?: number } = {}): BalanceRecord[] {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        `SELECT venue_id, account_id, currency, free, used, total, fetched_at
         FROM balances b
         WHERE fetched_at >= ?
           AND fetched_at = (
             SELECT MAX(fetched_at) FROM balances b2
             WHERE b2.venue_id = b.venue_id
               AND b2.account_id = b.account_id
               AND b2.currency = b.currency
           )
         ORDER BY venue_id, currency`,
      )
      .all(now - maxAgeMs) as Array<{
      venue_id: string;
      account_id: string;
      currency: string;
      free: string;
      used: string;
      total: string;
      fetched_at: number;
    }>;
    return rows.map((row) => ({
      venueId: row.venue_id,
      accountId: row.account_id,
      currency: row.currency,
      free: new Decimal(row.free),
      used: new Decimal(row.used),
      total: new Decimal(row.total),
      fetchedAt: row.fetched_at,
    }));
  }

  balanceFor(
    venueId: string,
    asset: string,
    options: { maxAgeMs?: number; now?: number } = {},
  ): Decimal | undefined {
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? Number.MAX_SAFE_INTEGER;
    const row = this.db
      .prepare(
        `SELECT free FROM balances
         WHERE venue_id = ? AND currency = ? AND fetched_at >= ?
         ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(venueId, asset.toUpperCase(), now - maxAgeMs) as { free: string } | undefined;
    return row ? new Decimal(row.free) : undefined;
  }

  recordInventorySnapshot(snapshot: InventorySnapshotRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO inventory_snapshots(
          venue_id, account_id, chain, asset, contract_address,
          free, used, total, usd_value, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.venueId,
        snapshot.accountId,
        snapshot.chain ?? null,
        snapshot.asset.toUpperCase(),
        snapshot.contractAddress ?? null,
        snapshot.free.toFixed(),
        snapshot.used.toFixed(),
        snapshot.total.toFixed(),
        snapshot.usdValue?.toFixed() ?? null,
        snapshot.capturedAt,
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  latestInventory(limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT s.*, v.name AS venue_name
         FROM inventory_snapshots s
         JOIN venues v ON v.id = s.venue_id
         ORDER BY s.captured_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
  }

  addRealizedLoss(amount: Decimal, now = Date.now()): void {
    if (amount.lt(0)) throw new Error('realized loss increment cannot be negative');
    this.mutateDailyRisk('realized_loss', amount, now);
  }

  addRebalanceCost(amount: Decimal, now = Date.now()): void {
    if (amount.lt(0)) throw new Error('rebalance cost increment cannot be negative');
    this.mutateDailyRisk('rebalance_cost', amount, now);
  }

  riskSnapshot(now = Date.now()): DailyRiskSnapshot {
    const tradingDay = this.tradingDay(now);
    const row = this.db
      .prepare(`SELECT realized_loss, rebalance_cost FROM daily_risk_state WHERE trading_day = ?`)
      .get(tradingDay) as { realized_loss: string; rebalance_cost: string } | undefined;
    const unhedged = this.db
      .prepare(
        `SELECT usd_value FROM unhedged_inventory
         WHERE status = 'open' ORDER BY created_at ASC`,
      )
      .all() as Array<{ usd_value: string }>;
    return {
      tradingDay,
      dailyRealizedLoss: new Decimal(row?.realized_loss ?? 0),
      dailyRebalanceCost: new Decimal(row?.rebalance_cost ?? 0),
      unhedgedInventoryRisk: unhedged.reduce(
        (total, item) => total.plus(new Decimal(item.usd_value)),
        new Decimal(0),
      ),
    };
  }

  latestClosedExecutionAt(): number | undefined {
    const row = this.db
      .prepare('SELECT MAX(closed_at) AS closed_at FROM executions WHERE closed_at IS NOT NULL')
      .get() as { closed_at: number | bigint | null };
    return row.closed_at === null ? undefined : Number(row.closed_at);
  }

  recordUnhedgedInventory(input: UnhedgedInventoryRecord): number {
    if (!input.amount.gt(0)) throw new Error('unhedged inventory amount must be positive');
    if (input.usdValue.lt(0)) throw new Error('unhedged inventory value cannot be negative');
    const direction = input.direction ?? 'long';
    if (direction !== 'long' && direction !== 'short') {
      throw new Error('unhedged inventory direction must be long or short');
    }
    const result = this.db
      .prepare(
        `INSERT INTO unhedged_inventory(
          execution_id, batch_id, venue_id, asset, amount, usd_value, direction, reason, status,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        input.executionId,
        input.batchId,
        input.venueId,
        input.asset.toUpperCase(),
        input.amount.toFixed(),
        input.usdValue.toFixed(),
        direction,
        input.reason,
        input.createdAt ?? Date.now(),
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  resolveUnhedgedInventory(id: number, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE unhedged_inventory SET status = 'closed', resolved_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(now, id);
  }

  openUnhedgedInventory(): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM unhedged_inventory WHERE status = 'open' ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
  }

  hasOpenUnhedgedInventory(batchId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM unhedged_inventory
         WHERE batch_id = ? AND status = 'open'`,
      )
      .get(batchId) as { count: number | bigint };
    return Number(row.count) > 0;
  }

  private tradingDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  private mutateDailyRisk(
    column: 'realized_loss' | 'rebalance_cost',
    amount: Decimal,
    now: number,
  ): void {
    if (amount.lte(0)) return;
    const tradingDay = this.tradingDay(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(`SELECT ${column} AS value FROM daily_risk_state WHERE trading_day = ?`)
        .get(tradingDay) as { value: string } | undefined;
      const next = new Decimal(row?.value ?? 0).plus(amount);
      this.db
        .prepare(
          `INSERT INTO daily_risk_state(trading_day, ${column}, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(trading_day) DO UPDATE SET
             ${column} = excluded.${column}, updated_at = excluded.updated_at`,
        )
        .run(tradingDay, next.toFixed(), now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordOrderbook(book: OrderBookSnapshot, valid: boolean, validationError?: string): void {
    this.db
      .prepare(
        `INSERT INTO orderbooks(
          venue_id, exchange_symbol, fetched_at, exchange_timestamp,
          bids_json, asks_json, valid, validation_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        book.venueId,
        book.exchangeSymbol,
        book.fetchedAt,
        book.exchangeTimestamp ?? null,
        json(book.bids.map((level) => [level.price.toFixed(), level.amount.toFixed()])),
        json(book.asks.map((level) => [level.price.toFixed(), level.amount.toFixed()])),
        valid ? 1 : 0,
        validationError ?? null,
      );
  }

  recordOpportunity(opportunity: OpportunityResult, episodeGapMs = 15_000): StoredOpportunity {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const episodeId = opportunity.valid
        ? this.updateEpisode(opportunity, episodeGapMs)
        : this.closeOpenEpisode(opportunity, opportunity.sampledAt);
      const result = this.db
        .prepare(
          `INSERT INTO opportunities(
            episode_id, strategy, opportunity_key, venue_buy, venue_sell,
            instrument_buy, instrument_sell, direction, requested_notional,
            gross_spread, total_cost, depth_net_profit, conservative_net_profit,
            net_profit_bps, data_age_ms, valid, rejection_reasons, metadata_json, sampled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episodeId,
          opportunity.strategy,
          opportunity.opportunityKey,
          opportunity.venueBuy,
          opportunity.venueSell,
          opportunity.instrumentBuy,
          opportunity.instrumentSell,
          opportunity.direction,
          opportunity.requestedNotional.toFixed(),
          opportunity.grossSpread.toFixed(),
          opportunity.totalCost.toFixed(),
          opportunity.depthNetProfit.toFixed(),
          opportunity.conservativeNetProfit.toFixed(),
          opportunity.netProfitBps.toFixed(),
          opportunity.dataAgeMs,
          opportunity.valid ? 1 : 0,
          json(opportunity.rejectionReasons),
          json(opportunity.metadata ?? {}),
          opportunity.sampledAt,
        ) as { lastInsertRowid: number | bigint };
      const id = Number(result.lastInsertRowid);
      if (episodeId !== null) this.refreshEpisodeStats(episodeId, opportunity.sampledAt);
      this.db.exec('COMMIT');
      return { id, episodeId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private updateEpisode(opportunity: OpportunityResult, gapMs: number): number {
    const open = this.db
      .prepare(
        `SELECT id, episode_end, sample_count FROM opportunity_episodes
         WHERE status = 'open' AND strategy = ? AND opportunity_key = ? AND direction = ?
         ORDER BY episode_start DESC LIMIT 1`,
      )
      .get(opportunity.strategy, opportunity.opportunityKey, opportunity.direction) as
      EpisodeRow | undefined;
    if (open && opportunity.sampledAt - open.episode_end <= gapMs) {
      this.db
        .prepare(
          `UPDATE opportunity_episodes SET
            episode_end = ?, sample_count = ?, duration_ms = ? - episode_start
           WHERE id = ?`,
        )
        .run(opportunity.sampledAt, open.sample_count + 1, opportunity.sampledAt, open.id);
      return open.id;
    }
    if (open) {
      this.db
        .prepare(`UPDATE opportunity_episodes SET status = 'closed' WHERE id = ?`)
        .run(open.id);
    }
    const result = this.db
      .prepare(
        `INSERT INTO opportunity_episodes(
          strategy, opportunity_key, direction, episode_start, episode_end,
          sample_count, max_profit, median_profit, min_profit, duration_ms, status
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 'open')`,
      )
      .run(
        opportunity.strategy,
        opportunity.opportunityKey,
        opportunity.direction,
        opportunity.sampledAt,
        opportunity.sampledAt,
        opportunity.conservativeNetProfit.toFixed(),
        opportunity.conservativeNetProfit.toFixed(),
        opportunity.conservativeNetProfit.toFixed(),
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  private closeOpenEpisode(opportunity: OpportunityResult, at: number): null {
    // Lifetime ends at the last sample where the opportunity was still valid.
    // episode_end already holds that timestamp; do not extend it to the first
    // invalid sample.
    void at;
    this.db
      .prepare(
        `UPDATE opportunity_episodes SET status = 'closed'
         WHERE status = 'open' AND strategy = ? AND opportunity_key = ? AND direction = ?`,
      )
      .run(opportunity.strategy, opportunity.opportunityKey, opportunity.direction);
    return null;
  }

  private refreshEpisodeStats(episodeId: number, episodeEnd: number): void {
    const rows = this.db
      .prepare(
        `SELECT conservative_net_profit AS profit FROM opportunities
         WHERE episode_id = ? ORDER BY conservative_net_profit ASC`,
      )
      .all(episodeId) as Array<{ profit: string }>;
    const values = rows.map((row) => new Decimal(row.profit)).sort((a, b) => a.comparedTo(b));
    if (values.length === 0) return;
    const middle = Math.floor(values.length / 2);
    const median =
      values.length % 2 === 0 ? values[middle - 1]!.plus(values[middle]!).div(2) : values[middle]!;
    const min = values[0]!;
    const max = values[values.length - 1]!;
    this.db
      .prepare(
        `UPDATE opportunity_episodes SET
          episode_end = ?, sample_count = ?, max_profit = ?, median_profit = ?,
          min_profit = ?, duration_ms = ? - episode_start
         WHERE id = ?`,
      )
      .run(
        episodeEnd,
        values.length,
        max.toFixed(),
        median.toFixed(),
        min.toFixed(),
        episodeEnd,
        episodeId,
      );
  }

  closeStaleEpisodes(now = Date.now(), gapMs = 15_000): number {
    const result = this.db
      .prepare(
        `UPDATE opportunity_episodes SET status = 'closed'
         WHERE status = 'open' AND episode_end < ?`,
      )
      .run(now - gapMs) as { changes: number | bigint };
    return Number(result.changes);
  }

  episodeDuration(episodeId: number): number {
    const row = this.db
      .prepare('SELECT duration_ms FROM opportunity_episodes WHERE id = ?')
      .get(episodeId) as { duration_ms: number } | undefined;
    return Math.max(0, row?.duration_ms ?? 0);
  }

  episodeSummary(): EpisodeSummary[] {
    const rows = this.db
      .prepare(
        `SELECT strategy, status, duration_ms, sample_count, max_profit
         FROM opportunity_episodes`,
      )
      .all() as Array<{
      strategy: string;
      status: string;
      duration_ms: number;
      sample_count: number;
      max_profit: string;
    }>;
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = grouped.get(row.strategy) ?? [];
      list.push(row);
      grouped.set(row.strategy, list);
    }
    return [...grouped.entries()]
      .map(([strategy, list]) => {
        const durations = list.map((row) => Math.max(0, Number(row.duration_ms)));
        return {
          strategy,
          episodes: list.length,
          openEpisodes: list.filter((row) => row.status === 'open').length,
          totalSamples: list.reduce((sum, row) => sum + Number(row.sample_count), 0),
          medianDurationMs: nearestRankPercentile(durations, 0.5),
          p90DurationMs: nearestRankPercentile(durations, 0.9),
          maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
          medianMaxProfit: medianDecimal(list.map((row) => new Decimal(row.max_profit))),
        };
      })
      .sort((left, right) => left.strategy.localeCompare(right.strategy));
  }

  opportunityDecay(): OpportunityDecaySummary[] {
    const rows = this.db
      .prepare(
        `SELECT e.strategy AS strategy, e.duration_ms AS duration_ms,
           (SELECT o.conservative_net_profit FROM opportunities o
             WHERE o.episode_id = e.id ORDER BY o.sampled_at ASC, o.id ASC LIMIT 1) AS first_profit,
           (SELECT o.conservative_net_profit FROM opportunities o
             WHERE o.episode_id = e.id ORDER BY o.sampled_at DESC, o.id DESC LIMIT 1) AS last_profit
         FROM opportunity_episodes e`,
      )
      .all() as Array<{
      strategy: string;
      duration_ms: number;
      first_profit: string | null;
      last_profit: string | null;
    }>;
    const grouped = new Map<string, Array<{ durationMs: number; decayBps: Decimal }>>();
    for (const row of rows) {
      if (row.first_profit === null || row.last_profit === null) continue;
      const first = new Decimal(row.first_profit);
      const last = new Decimal(row.last_profit);
      const decayBps = first.abs().gt(0)
        ? last.minus(first).div(first.abs()).mul(10_000)
        : new Decimal(0);
      const list = grouped.get(row.strategy) ?? [];
      list.push({ durationMs: Math.max(0, Number(row.duration_ms)), decayBps });
      grouped.set(row.strategy, list);
    }
    return [...grouped.entries()]
      .map(([strategy, list]) => ({
        strategy,
        episodes: list.length,
        medianDurationMs: nearestRankPercentile(
          list.map((item) => item.durationMs),
          0.5,
        ),
        medianDecayBps: medianDecimal(list.map((item) => item.decayBps)),
        improvingEpisodes: list.filter((item) => item.decayBps.gt(0)).length,
        decayingEpisodes: list.filter((item) => item.decayBps.lt(0)).length,
      }))
      .sort((left, right) => left.strategy.localeCompare(right.strategy));
  }

  /**
   * Rank S1 routes by how often they actually produce a valid edge and how
   * long their episodes last. This is the discovery-side feedback loop: spend
   * WebSocket subscriptions and hot-path attention on routes that pay.
   */
  s1RouteStats(options: { sinceMs?: number; limit?: number; now?: number } = {}): S1RouteStats[] {
    const now = options.now ?? Date.now();
    const since = now - Math.max(0, options.sinceMs ?? 24 * 60 * 60 * 1000);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 1000));
    const rows = this.db
      .prepare(
        `SELECT instrument_buy AS instrument, venue_buy, venue_sell,
           COUNT(*) AS samples,
           SUM(CASE WHEN valid = 1 OR CAST(net_profit_bps AS REAL) <> 0 THEN 1 ELSE 0 END) AS evaluated_samples,
           SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) AS valid_samples,
           AVG(CASE WHEN valid = 1 OR CAST(net_profit_bps AS REAL) <> 0 THEN CAST(net_profit_bps AS REAL) END) AS avg_bps,
           MAX(CASE WHEN valid = 1 OR CAST(net_profit_bps AS REAL) <> 0 THEN CAST(net_profit_bps AS REAL) END) AS max_bps,
           MAX(sampled_at) AS last_seen
         FROM opportunities
         WHERE strategy = 'S1' AND sampled_at >= ?
         GROUP BY instrument_buy, venue_buy, venue_sell
         ORDER BY valid_samples DESC, max_bps DESC, samples DESC
         LIMIT ?`,
      )
      .all(since, limit) as Array<{
      instrument: string;
      venue_buy: string;
      venue_sell: string;
      samples: number;
      evaluated_samples: number;
      valid_samples: number;
      avg_bps: number | null;
      max_bps: number | null;
      last_seen: number;
    }>;
    const episodeRows = this.db
      .prepare(
        `SELECT opportunity_key, duration_ms
         FROM opportunity_episodes
         WHERE strategy = 'S1'`,
      )
      .all() as Array<{ opportunity_key: string; duration_ms: number }>;
    const durationsByRoute = new Map<string, number[]>();
    for (const row of episodeRows) {
      const parts = row.opportunity_key.split('|');
      if (parts.length < 4) continue;
      const key = `${parts[1]}|${parts[2]}|${parts[3]}`;
      const list = durationsByRoute.get(key) ?? [];
      list.push(Math.max(0, Number(row.duration_ms)));
      durationsByRoute.set(key, list);
    }
    return rows.map((row) => {
      const durations =
        durationsByRoute.get(`${row.instrument}|${row.venue_buy}|${row.venue_sell}`) ?? [];
      return {
        instrument: row.instrument,
        venueBuy: row.venue_buy,
        venueSell: row.venue_sell,
        samples: Number(row.samples),
        evaluatedSamples: Number(row.evaluated_samples),
        validSamples: Number(row.valid_samples),
        evaluationRate:
          Number(row.samples) > 0 ? Number(row.evaluated_samples) / Number(row.samples) : 0,
        validRate:
          Number(row.evaluated_samples) > 0
            ? Number(row.valid_samples) / Number(row.evaluated_samples)
            : 0,
        avgNetBps: new Decimal(row.avg_bps ?? 0),
        maxNetBps: new Decimal(row.max_bps ?? 0),
        lastSeenAt: Number(row.last_seen),
        episodes: durations.length,
        medianDurationMs: nearestRankPercentile(durations, 0.5),
        p90DurationMs: nearestRankPercentile(durations, 0.9),
        maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      };
    });
  }

  recordPaperTrade(trade: PaperTradeRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO paper_trades(
          opportunity_id, requested_notional, simulated_base_amount,
          buy_price_average, sell_price_average, buy_price_worst, sell_price_worst,
          fees, gas_cost, net_profit, result, executed_at, duration_ms,
          expected_failure_reasons, fill_quality_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trade.opportunityId,
        trade.requestedNotional.toFixed(),
        trade.simulatedBaseAmount.toFixed(),
        trade.buyPriceAverage.toFixed(),
        trade.sellPriceAverage.toFixed(),
        trade.buyPriceWorst?.toFixed() ?? null,
        trade.sellPriceWorst?.toFixed() ?? null,
        trade.fees.toFixed(),
        trade.gasCost.toFixed(),
        trade.netProfit.toFixed(),
        trade.result,
        trade.executedAt,
        Math.max(0, Math.floor(trade.durationMs ?? 0)),
        json(trade.expectedFailureReasons ?? []),
        json(trade.fillQuality ?? {}),
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  listOpportunities(query: OpportunityQuery = {}): Array<Record<string, unknown>> {
    const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
    const where = query.validOnly ? 'WHERE valid = 1' : '';
    return this.db
      .prepare(`SELECT * FROM opportunities ${where} ORDER BY sampled_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;
  }

  opportunityCountsByStrategy(): Array<{ strategy: string; total: number; valid: number }> {
    const rows = this.db
      .prepare(
        `SELECT strategy, COUNT(*) AS total, COALESCE(SUM(valid), 0) AS valid
         FROM opportunities GROUP BY strategy ORDER BY strategy`,
      )
      .all() as Array<{ strategy: string; total: number; valid: number }>;
    return rows.map((row) => ({
      strategy: row.strategy,
      total: Number(row.total),
      valid: Number(row.valid),
    }));
  }

  latestValidS1Opportunity(): LoadedOpportunity | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM opportunities
         WHERE strategy = 'S1' AND valid = 1
         ORDER BY sampled_at DESC, id DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? { id: Number(row.id), opportunity: opportunityFromRow(row) } : undefined;
  }

  bestValidS1Opportunity(options: {
    now: number;
    maxAgeMs: number;
    maxCandidates?: number;
  }): LoadedOpportunity | undefined {
    const { now, maxAgeMs } = options;
    if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      return undefined;
    }
    const limit = Math.max(1, Math.min(1000, options.maxCandidates ?? 200));
    const rows = this.db
      .prepare(
        `SELECT * FROM opportunities
         WHERE strategy = 'S1' AND valid = 1 AND sampled_at >= ? AND sampled_at <= ?
         ORDER BY sampled_at DESC, id DESC LIMIT ?`,
      )
      .all(now - maxAgeMs, now, limit) as Record<string, unknown>[];
    let best: { loaded: LoadedOpportunity; score: number } | undefined;
    for (const row of rows) {
      const opportunity = opportunityFromRow(row);
      const age = Math.max(0, now - opportunity.sampledAt);
      const lifetime = this.medianEpisodeDurationMs(
        'S1',
        opportunity.opportunityKey,
        opportunity.direction,
      );
      if (lifetime !== undefined && lifetime > 0 && age > lifetime) continue;
      const rawFill = Number(opportunity.metadata?.fillProbability ?? '1');
      const fillProbability = Number.isFinite(rawFill) ? Math.max(0, Math.min(1, rawFill)) : 1;
      const recency = maxAgeMs > 0 ? Math.max(0, 1 - age / maxAgeMs) : 0;
      const score = opportunity.netProfitBps.toNumber() * fillProbability * recency;
      if (!best || score > best.score) {
        best = { loaded: { id: Number(row.id), opportunity }, score };
      }
    }
    return best?.loaded;
  }

  recentValidS1Opportunities(options: {
    now: number;
    maxAgeMs: number;
    instruments?: readonly string[];
    maxCandidates?: number;
  }): LoadedOpportunity[] {
    return this.recentS1Opportunities({ ...options, validOnly: true });
  }

  recentS1Opportunities(options: {
    now: number;
    maxAgeMs: number;
    instruments?: readonly string[];
    maxCandidates?: number;
    validOnly?: boolean;
  }): LoadedOpportunity[] {
    const { now, maxAgeMs } = options;
    if (!Number.isFinite(now) || now <= 0 || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(1000, options.maxCandidates ?? 200));
    const instruments = (options.instruments ?? [])
      .map((instrument) => instrument.trim().toUpperCase())
      .filter((instrument) => instrument.length > 0);
    const params: Array<string | number> = [now - maxAgeMs, now];
    let filter = '';
    if (instruments.length > 0) {
      filter = ` AND UPPER(instrument_buy) IN (${instruments.map(() => '?').join(',')})`;
      params.push(...instruments);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM opportunities
         WHERE strategy = 'S1' AND sampled_at >= ? AND sampled_at <= ?${options.validOnly ? ' AND valid = 1' : ''}${filter}
         ORDER BY sampled_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({ id: Number(row.id), opportunity: opportunityFromRow(row) }));
  }

  medianEpisodeDurationMs(
    strategy: string,
    opportunityKey: string,
    direction: string,
  ): number | undefined {
    const rows = this.db
      .prepare(
        `SELECT duration_ms AS duration FROM opportunity_episodes
         WHERE strategy = ? AND opportunity_key = ? AND direction = ? AND status = 'closed'
         ORDER BY episode_end DESC LIMIT 50`,
      )
      .all(strategy, opportunityKey, direction) as Array<{ duration: number }>;
    const values = rows
      .map((row) => Number(row.duration))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    if (values.length === 0) return undefined;
    const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * 0.5) - 1));
    return values[index];
  }

  validS1OpportunityById(id: number): LoadedOpportunity | undefined {
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM opportunities
         WHERE id = ? AND strategy = 'S1' AND valid = 1 LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? { id: Number(row.id), opportunity: opportunityFromRow(row) } : undefined;
  }

  executionForOpportunity(opportunityId: number): OpportunityExecutionReference | undefined {
    const row = this.db
      .prepare(
        `SELECT batch_id, status, opened_at FROM executions
         WHERE opportunity_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(opportunityId) as { batch_id: string; status: string; opened_at: number } | undefined;
    return row ? { batchId: row.batch_id, status: row.status, openedAt: row.opened_at } : undefined;
  }

  listEpisodes(limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM opportunity_episodes ORDER BY episode_start DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
  }

  latestHealth(): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT v.id AS venue_id, v.name, v.tier, v.execution_enabled,
                h.measured_at, h.success_rate, h.median_latency_ms, h.p95_latency_ms,
                h.rate_limit_events, h.stale_data_events, h.health_state, h.score
         FROM venues v
         LEFT JOIN venue_health h ON h.id = (
           SELECT id FROM venue_health WHERE venue_id = v.id ORDER BY measured_at DESC LIMIT 1
         )
         ORDER BY v.id`,
      )
      .all() as Array<Record<string, unknown>>;
  }

  paperTradeSummary(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT result, net_profit FROM paper_trades').all() as Array<{
      result: string;
      net_profit: string;
    }>;
    let netProfit = new Decimal(0);
    let closed = 0;
    let simulated = 0;
    for (const row of rows) {
      netProfit = netProfit.plus(new Decimal(row.net_profit));
      if (row.result === 'CLOSED') closed += 1;
      if (row.result === 'SIMULATED') simulated += 1;
    }
    return {
      count: rows.length,
      net_profit: netProfit.toFixed(),
      closed_count: closed,
      simulated_count: simulated,
      failed_count: rows.length - closed - simulated,
    };
  }

  rolloutMetrics(now = Date.now()): RolloutMetrics {
    const executionRows = this.db
      .prepare('SELECT id, status, closed_at, realized_profit FROM executions')
      .all() as Array<{
      id: number;
      status: string;
      closed_at: number | null;
      realized_profit: string | null;
    }>;
    const legRows = this.db
      .prepare(
        `SELECT execution_id, leg_number, status, requested_amount, filled_amount
         FROM execution_legs`,
      )
      .all() as Array<{
      execution_id: number;
      leg_number: number;
      status: string;
      requested_amount: string;
      filled_amount: string | null;
    }>;
    const legsByExecution = new Map<
      number,
      { leg1?: (typeof legRows)[number]; leg2?: (typeof legRows)[number] }
    >();
    for (const leg of legRows) {
      const entry = legsByExecution.get(leg.execution_id) ?? {};
      if (leg.leg_number === 1) entry.leg1 = leg;
      if (leg.leg_number === 2) entry.leg2 = leg;
      legsByExecution.set(leg.execution_id, entry);
    }

    let closed = 0;
    let safeStop = 0;
    let open = 0;
    let fullyReconciled = 0;
    let firstLegSamples = 0;
    let firstLegPartials = 0;
    let secondLegSamples = 0;
    let secondLegFailures = 0;
    for (const execution of executionRows) {
      if (execution.status === 'CLOSED') closed += 1;
      if (execution.status === 'SAFE_STOP') safeStop += 1;
      if (execution.closed_at === null) open += 1;
      const legs = legsByExecution.get(execution.id);
      const leg1 = legs?.leg1;
      const leg2 = legs?.leg2;
      if (leg1) {
        firstLegSamples += 1;
        const requested = new Decimal(leg1.requested_amount);
        const filled = new Decimal(leg1.filled_amount ?? 0);
        if (leg1.status === 'partial' || (filled.gt(0) && filled.lt(requested))) {
          firstLegPartials += 1;
        }
      }
      if (leg2 && !['planned', 'submitted'].includes(leg2.status)) {
        secondLegSamples += 1;
        if (['rejected', 'unknown', 'canceled', 'partial'].includes(leg2.status)) {
          secondLegFailures += 1;
        }
      }
      if (execution.status === 'CLOSED' && leg1?.status === 'filled' && leg2?.status === 'filled') {
        fullyReconciled += 1;
      }
    }

    const orderRows = this.db.prepare('SELECT status FROM orders').all() as Array<{
      status: string;
    }>;
    const submittedOrders = orderRows.filter((order) => order.status !== 'pending');
    const unknownOrders = submittedOrders.filter((order) => order.status === 'unknown').length;
    const orderEventRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN event_type LIKE '%error%' THEN 1 ELSE 0 END), 0) AS errors
         FROM order_events`,
      )
      .get() as { total: number | bigint; errors: number | bigint };

    const paperRows = this.db
      .prepare('SELECT net_profit, gas_cost FROM paper_trades')
      .all() as Array<{ net_profit: string; gas_cost: string }>;
    const paperNetProfit = paperRows.reduce(
      (total, row) => total.plus(new Decimal(row.net_profit)),
      new Decimal(0),
    );
    const gasCost = paperRows.reduce(
      (total, row) => total.plus(new Decimal(row.gas_cost)),
      new Decimal(0),
    );
    const liveRows = this.db
      .prepare('SELECT realized_profit FROM executions WHERE realized_profit IS NOT NULL')
      .all() as Array<{ realized_profit: string }>;
    const liveRealizedProfit = liveRows.reduce(
      (total, row) => total.plus(new Decimal(row.realized_profit)),
      new Decimal(0),
    );
    const riskRows = this.db
      .prepare('SELECT realized_loss, rebalance_cost FROM daily_risk_state')
      .all() as Array<{ realized_loss: string; rebalance_cost: string }>;
    const rebalanceCost = riskRows.reduce(
      (total, row) => total.plus(new Decimal(row.rebalance_cost)),
      new Decimal(0),
    );
    const unhedgedRows = this.db
      .prepare(
        `SELECT usd_value AS unhedged
         FROM unhedged_inventory WHERE status = 'open'`,
      )
      .all() as Array<{ unhedged: string }>;
    const unhedgedUsd = unhedgedRows.reduce(
      (total, row) => total.plus(new Decimal(row.unhedged)),
      new Decimal(0),
    );

    const snapshotRows = this.db
      .prepare(
        `SELECT venue_id, asset, total, usd_value, captured_at FROM (
           SELECT venue_id, asset, total, usd_value, captured_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY venue_id, asset ORDER BY captured_at DESC, id DESC
                  ) AS row_number
           FROM inventory_snapshots
         ) WHERE row_number <= 2 ORDER BY venue_id, asset, captured_at DESC`,
      )
      .all() as Array<{
      venue_id: string;
      asset: string;
      total: string;
      usd_value: string | null;
      captured_at: number;
    }>;
    const snapshotsByKey = new Map<string, typeof snapshotRows>();
    for (const row of snapshotRows) {
      const key = `${row.venue_id}\u0000${row.asset}`;
      const rows = snapshotsByKey.get(key) ?? [];
      rows.push(row);
      snapshotsByKey.set(key, rows);
    }
    let snapshotPairs = 0;
    let observedNetChange = new Decimal(0);
    let observedAbsoluteChange = new Decimal(0);
    for (const rows of snapshotsByKey.values()) {
      if (rows.length < 2 || rows[0]?.usd_value === null || rows[1]?.usd_value === null) continue;
      const current = new Decimal(rows[0]!.usd_value!);
      const previous = new Decimal(rows[1]!.usd_value!);
      const delta = current.minus(previous);
      snapshotPairs += 1;
      observedNetChange = observedNetChange.plus(delta);
      observedAbsoluteChange = observedAbsoluteChange.plus(delta.abs());
    }

    const transferRows = this.db
      .prepare('SELECT transfer_tax_bps FROM token_mappings')
      .all() as Array<{ transfer_tax_bps: string }>;
    const maxTransferTax = transferRows.reduce(
      (max, row) => Decimal.max(max, new Decimal(row.transfer_tax_bps)),
      new Decimal(0),
    );
    const since = now - 24 * 60 * 60 * 1000;
    const risk24Row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END), 0) AS critical,
                COALESCE(SUM(CASE WHEN rule = 'venue_backoff' THEN 1 ELSE 0 END), 0) AS backoffs
         FROM risk_events WHERE created_at >= ?`,
      )
      .get(since) as {
      total: number | bigint;
      critical: number | bigint;
      backoffs: number | bigint;
    };
    const operator24Row = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM audit_logs WHERE actor = 'operator' AND created_at >= ?`,
      )
      .get(since) as { total: number | bigint };

    return {
      generatedAt: now,
      executions: {
        total: executionRows.length,
        closed,
        safeStop,
        open,
        fullyReconciled,
        fillRate: ratio(fullyReconciled, executionRows.length),
        firstLegPartialRate: ratio(firstLegPartials, firstLegSamples),
        secondLegFailureRate: ratio(secondLegFailures, secondLegSamples),
      },
      orders: {
        total: orderRows.length,
        submitted: submittedOrders.length,
        unknown: unknownOrders,
        unknownOrderRate: ratio(unknownOrders, submittedOrders.length),
        queryEvents: Number(orderEventRow.total),
        queryErrorEvents: Number(orderEventRow.errors),
        queryErrorRate: ratio(Number(orderEventRow.errors), Number(orderEventRow.total)),
      },
      costs: {
        paperNetProfitUsd: paperNetProfit,
        liveRealizedProfitUsd: liveRealizedProfit,
        gasCostUsd: gasCost,
        rebalanceCostUsd: rebalanceCost,
        unhedgedInventoryUsd: unhedgedUsd,
      },
      inventory: {
        snapshotPairs,
        observedNetChangeUsd: observedNetChange,
        observedAbsoluteChangeUsd: observedAbsoluteChange,
      },
      transferTax: {
        mappings: transferRows.length,
        maxTransferTaxBps: maxTransferTax,
      },
      risk: {
        events24h: Number(risk24Row.total),
        criticalEvents24h: Number(risk24Row.critical),
        backoffEvents24h: Number(risk24Row.backoffs),
        operatorInterventions24h: Number(operator24Row.total),
      },
    };
  }

  opportunityCounts(): Record<string, unknown> {
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM opportunities').get() as {
      count: number | bigint;
    };
    const valid = this.db
      .prepare('SELECT COUNT(*) AS count FROM opportunities WHERE valid = 1')
      .get() as { count: number | bigint };
    const openEpisodes = this.db
      .prepare("SELECT COUNT(*) AS count FROM opportunity_episodes WHERE status = 'open'")
      .get() as { count: number | bigint };
    return {
      total: Number(total.count),
      valid: Number(valid.count),
      rejected: Number(total.count) - Number(valid.count),
      open_episodes: Number(openEpisodes.count),
    };
  }

  listRiskEvents(limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM risk_events ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
  }

  listAuditLogs(limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
  }
  setSetting(key: string, value: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  recordRiskEvent(
    severity: 'info' | 'warning' | 'critical',
    rule: string,
    message: string,
    context: unknown = {},
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO risk_events(severity, rule, message, context_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(severity, rule, message, json(context), now);
  }

  recordAudit(actor: string, action: string, context: unknown = {}, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs(actor, action, context_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(actor, action, json(context), now);
  }

  createExecution(input: {
    strategy: string;
    batchId: string;
    status: string;
    plannedNotional: Decimal;
    expectedProfit: Decimal;
    openedAt?: number;
    opportunityId?: number;
    preflight?: unknown;
    metadata?: unknown;
  }): number {
    const openedAt = input.openedAt ?? Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO executions(
          strategy, batch_id, status, planned_notional, expected_profit, opened_at,
          opportunity_id, preflight_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.strategy,
        input.batchId,
        input.status,
        input.plannedNotional.toFixed(),
        input.expectedProfit.toFixed(),
        openedAt,
        input.opportunityId ?? null,
        input.preflight === undefined ? null : json(input.preflight),
        json(input.metadata ?? {}),
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  addExecutionLeg(input: {
    executionId: number;
    legNumber: number;
    venueId: string;
    side: 'buy' | 'sell' | 'swap';
    requestedAmount: Decimal;
    requestedPrice: Decimal;
    status: string;
    submittedAt?: number;
    clientOrderId?: string | undefined;
    orderId?: string | undefined;
    error?: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO execution_legs(
          execution_id, leg_number, venue_id, side, requested_amount, requested_price,
          submitted_at, status, client_order_id, order_id, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.executionId,
        input.legNumber,
        input.venueId,
        input.side,
        input.requestedAmount.toFixed(),
        input.requestedPrice.toFixed(),
        input.submittedAt ?? null,
        input.status,
        input.clientOrderId ?? null,
        input.orderId ?? null,
        input.error ?? null,
      ) as { lastInsertRowid: number | bigint };
    return Number(result.lastInsertRowid);
  }

  updateExecutionStatus(
    executionId: number,
    status: string,
    options: {
      realizedProfit?: Decimal;
      closedAt?: number;
      safeModeReason?: string;
      grossSpread?: Decimal;
      fees?: Decimal;
      latencyMs?: number;
      inventoryDelta?: unknown;
      metadata?: unknown;
    } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE executions SET status = ?, realized_profit = COALESCE(?, realized_profit),
           closed_at = COALESCE(?, closed_at),
           safe_mode_reason = COALESCE(?, safe_mode_reason),
           gross_spread = COALESCE(?, gross_spread),
           fees = COALESCE(?, fees),
           latency_ms = COALESCE(?, latency_ms),
           inventory_delta_json = COALESCE(?, inventory_delta_json),
           metadata_json = COALESCE(?, metadata_json)
         WHERE id = ?`,
      )
      .run(
        status,
        options.realizedProfit?.toFixed() ?? null,
        options.closedAt ?? null,
        options.safeModeReason ?? null,
        options.grossSpread?.toFixed() ?? null,
        options.fees?.toFixed() ?? null,
        options.latencyMs ?? null,
        options.inventoryDelta === undefined ? null : json(options.inventoryDelta),
        options.metadata === undefined ? null : json(options.metadata),
        executionId,
      );
  }

  updateExecutionPreflight(executionId: number, preflight: unknown): void {
    this.db
      .prepare('UPDATE executions SET preflight_json = ? WHERE id = ?')
      .run(json(preflight), executionId);
  }

  recoveryCounts(): { openExecutions: number; unresolvedLegs: number } {
    return {
      openExecutions: this.countOpenExecutions(),
      unresolvedLegs: this.countUnresolvedOrders(),
    };
  }
  updateExecutionLeg(
    clientOrderId: string,
    fields: {
      status: string;
      filledAmount?: Decimal;
      averageFillPrice?: Decimal | undefined;
      feePaid?: Decimal | undefined;
      orderId?: string | undefined;
      error?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE execution_legs SET status = ?, filled_amount = COALESCE(?, filled_amount),
           average_fill_price = COALESCE(?, average_fill_price), fee_paid = COALESCE(?, fee_paid),
           order_id = COALESCE(?, order_id), error = COALESCE(?, error)
         WHERE client_order_id = ?`,
      )
      .run(
        fields.status,
        fields.filledAmount?.toFixed() ?? null,
        fields.averageFillPrice?.toFixed() ?? null,
        fields.feePaid?.toFixed() ?? null,
        fields.orderId ?? null,
        fields.error ?? null,
        clientOrderId,
      );
  }

  recordOrder(input: {
    venueId: string;
    venueOrderId?: string | undefined;
    clientOrderId: string;
    executionId?: number | undefined;
    symbol: string;
    side: string;
    type: string;
    price: Decimal;
    amount: Decimal;
    filledAmount: Decimal;
    averagePrice?: Decimal;
    fee?: Decimal;
    feeCurrency?: string;
    status: string;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO orders(
          venue_id, venue_order_id, client_order_id, execution_id, symbol, side, type, price, amount,
          filled_amount, average_price, fee, fee_currency, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_order_id) DO UPDATE SET
          venue_order_id = COALESCE(excluded.venue_order_id, venue_order_id),
          execution_id = COALESCE(excluded.execution_id, execution_id),
          filled_amount = excluded.filled_amount,
          average_price = excluded.average_price,
          fee = excluded.fee,
          fee_currency = excluded.fee_currency,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.venueId,
        input.venueOrderId ?? null,
        input.clientOrderId,
        input.executionId ?? null,
        input.symbol,
        input.side,
        input.type,
        input.price.toFixed(),
        input.amount.toFixed(),
        input.filledAmount.toFixed(),
        input.averagePrice?.toFixed() ?? null,
        input.fee?.toFixed() ?? null,
        input.feeCurrency?.trim().toUpperCase() || null,
        input.status,
        now,
        now,
      );
  }

  recordOrderEvent(
    clientOrderId: string,
    eventType: string,
    rawResponse: unknown,
    now = Date.now(),
  ): void {
    const row = this.db
      .prepare('SELECT id FROM orders WHERE client_order_id = ?')
      .get(clientOrderId) as { id: number } | undefined;
    if (!row) throw new Error(`order not found: ${clientOrderId}`);
    this.db
      .prepare(
        'INSERT INTO order_events(order_id, event_type, raw_response, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(row.id, eventType, json(rawResponse), now);
  }
  countUnresolvedOrders(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT client_order_id) AS count
         FROM (
           SELECT client_order_id FROM orders
           WHERE status IN ('pending', 'submitted', 'open', 'unknown')
           UNION ALL
           SELECT client_order_id FROM execution_legs
           WHERE status IN ('submitted', 'unknown') AND client_order_id IS NOT NULL
         )`,
      )
      .get() as { count: number | bigint };
    return Number(row.count);
  }

  countOpenExecutions(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM executions WHERE closed_at IS NULL')
      .get() as { count: number | bigint };
    return Number(row.count);
  }

  getOrder(clientOrderId: string): RecoveredOrder | undefined {
    const row = this.db
      .prepare(
        `SELECT id, execution_id, venue_id, venue_order_id, client_order_id, symbol,
                side, type, price, amount, filled_amount, average_price, fee, fee_currency, status,
                created_at, updated_at
         FROM orders WHERE client_order_id = ?`,
      )
      .get(clientOrderId) as
      | {
          id: number;
          execution_id: number | null;
          venue_id: string;
          venue_order_id: string | null;
          client_order_id: string;
          symbol: string;
          side: string;
          type: string;
          price: string;
          amount: string;
          filled_amount: string;
          average_price: string | null;
          fee: string | null;
          fee_currency: string | null;
          status: string;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      executionId: row.execution_id,
      venueId: row.venue_id,
      venueOrderId: row.venue_order_id,
      clientOrderId: row.client_order_id,
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      price: row.price,
      amount: row.amount,
      filledAmount: row.filled_amount,
      averagePrice: row.average_price,
      fee: row.fee,
      feeCurrency: row.fee_currency,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listUnresolvedOrders(): RecoveredOrder[] {
    const rows = this.db
      .prepare(
        `SELECT o.id, o.execution_id, o.venue_id, o.venue_order_id, o.client_order_id,
                o.symbol, o.side, o.type, o.price, o.amount, o.filled_amount,
                o.average_price, o.fee, o.fee_currency, o.status, o.created_at, o.updated_at
         FROM orders o
         WHERE o.status IN ('submitted', 'open', 'unknown', 'pending')
            OR EXISTS (
              SELECT 1 FROM execution_legs l
              WHERE l.client_order_id = o.client_order_id
                AND l.status IN ('submitted', 'unknown')
            )
         ORDER BY o.created_at ASC, o.id ASC`,
      )
      .all() as Array<{
      id: number;
      execution_id: number | null;
      venue_id: string;
      venue_order_id: string | null;
      client_order_id: string;
      symbol: string;
      side: string;
      type: string;
      price: string;
      amount: string;
      filled_amount: string;
      average_price: string | null;
      fee: string | null;
      fee_currency: string | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      executionId: row.execution_id,
      venueId: row.venue_id,
      venueOrderId: row.venue_order_id,
      clientOrderId: row.client_order_id,
      symbol: row.symbol,
      side: row.side,
      type: row.type,
      price: row.price,
      amount: row.amount,
      filledAmount: row.filled_amount,
      averagePrice: row.average_price,
      fee: row.fee,
      feeCurrency: row.fee_currency,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listOpenExecutions(): ExecutionRecoveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, strategy, batch_id, status, planned_notional, expected_profit,
                realized_profit, opened_at, closed_at, safe_mode_reason
         FROM executions WHERE closed_at IS NULL ORDER BY opened_at ASC, id ASC`,
      )
      .all() as Array<{
      id: number;
      strategy: string;
      batch_id: string;
      status: string;
      planned_notional: string;
      expected_profit: string;
      realized_profit: string | null;
      opened_at: number;
      closed_at: number | null;
      safe_mode_reason: string | null;
    }>;
    const legStatement = this.db.prepare(
      `SELECT id, execution_id, leg_number, venue_id, side, requested_amount,
              requested_price, submitted_at, status, filled_amount, average_fill_price,
              fee_paid, order_id, client_order_id, error
       FROM execution_legs WHERE execution_id = ? ORDER BY leg_number`,
    );
    return rows.map((row) => {
      const legRows = legStatement.all(row.id) as Array<{
        id: number;
        execution_id: number;
        leg_number: number;
        venue_id: string;
        side: 'buy' | 'sell' | 'swap';
        requested_amount: string;
        requested_price: string;
        submitted_at: number | null;
        status: string;
        filled_amount: string | null;
        average_fill_price: string | null;
        fee_paid: string | null;
        order_id: string | null;
        client_order_id: string | null;
        error: string | null;
      }>;
      return {
        id: row.id,
        strategy: row.strategy,
        batchId: row.batch_id,
        status: row.status,
        plannedNotional: row.planned_notional,
        expectedProfit: row.expected_profit,
        realizedProfit: row.realized_profit,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        safeModeReason: row.safe_mode_reason,
        legs: legRows.map((leg) => ({
          id: leg.id,
          executionId: leg.execution_id,
          legNumber: leg.leg_number,
          venueId: leg.venue_id,
          side: leg.side,
          requestedAmount: leg.requested_amount,
          requestedPrice: leg.requested_price,
          submittedAt: leg.submitted_at,
          status: leg.status,
          filledAmount: leg.filled_amount,
          averageFillPrice: leg.average_fill_price,
          feePaid: leg.fee_paid,
          orderId: leg.order_id,
          clientOrderId: leg.client_order_id,
          error: leg.error,
        })),
      };
    });
  }

  pruneRawOrderbooks(cutoff: number): number {
    const result = this.db.prepare('DELETE FROM orderbooks WHERE fetched_at < ?').run(cutoff) as {
      changes: number | bigint;
    };
    return Number(result.changes);
  }

  pruneHistoricalData(
    options: {
      now?: number;
      orderbookMs?: number;
      opportunityMs?: number;
      episodeMs?: number;
      paperMs?: number;
    } = {},
  ): {
    orderbooks: number;
    opportunities: number;
    episodes: number;
    paperTrades: number;
  } {
    const now = options.now ?? Date.now();
    const orderbookCutoff = now - (options.orderbookMs ?? 3 * 24 * 60 * 60 * 1000);
    const opportunityCutoff = now - (options.opportunityMs ?? 90 * 24 * 60 * 60 * 1000);
    const episodeCutoff = now - (options.episodeMs ?? 365 * 24 * 60 * 60 * 1000);
    const paperCutoff = now - (options.paperMs ?? 365 * 24 * 60 * 60 * 1000);
    let paperTrades = 0;
    let opportunities = 0;
    let episodes = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      paperTrades += this.deleteChanges(
        'DELETE FROM paper_trades WHERE executed_at < ?',
        paperCutoff,
      );
      opportunities = this.deleteChanges(
        `DELETE FROM opportunities
         WHERE sampled_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM executions WHERE executions.opportunity_id = opportunities.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM paper_trades WHERE paper_trades.opportunity_id = opportunities.id
           )`,
        opportunityCutoff,
      );
      episodes = this.deleteChanges(
        `DELETE FROM opportunity_episodes
         WHERE status = 'closed' AND episode_end < ?
           AND NOT EXISTS (
             SELECT 1 FROM opportunities
             WHERE opportunities.episode_id = opportunity_episodes.id
           )`,
        episodeCutoff,
      );
      const orderbooks = this.deleteChanges(
        'DELETE FROM orderbooks WHERE fetched_at < ?',
        orderbookCutoff,
      );
      this.db.exec('COMMIT');
      return { orderbooks, opportunities, episodes, paperTrades };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  exportExecutionsJsonl(path: string): { path: string; executions: number; bytes: number } {
    const executionRows = this.db
      .prepare('SELECT * FROM executions ORDER BY opened_at ASC, id ASC')
      .all() as Array<Record<string, unknown> & { id: number }>;
    const legStatement = this.db.prepare(
      'SELECT * FROM execution_legs WHERE execution_id = ? ORDER BY leg_number ASC, id ASC',
    );
    const orderStatement = this.db.prepare(
      'SELECT * FROM orders WHERE execution_id = ? ORDER BY created_at ASC, id ASC',
    );
    const eventStatement = this.db.prepare(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC',
    );
    const records = executionRows.map((execution) => ({
      ...execution,
      legs: legStatement.all(execution.id),
      orders: (
        orderStatement.all(execution.id) as Array<Record<string, unknown> & { id: number }>
      ).map((order) => ({ ...order, events: eventStatement.all(order.id) })),
    }));
    const output = records.map((record) => JSON.stringify(record)).join('\n');
    const body = records.length > 0 ? `${output}\n` : '';
    const outputPath = resolve(path);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, body, 'utf8');
    return {
      path: outputPath,
      executions: records.length,
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  }

  createTransferBatch(input: {
    id: string;
    status: string;
    plan: unknown;
    dryRun: boolean;
    confirmation?: string | null;
    safeModeReason?: string | null;
    createdAt?: number;
    legs: TransferLegInput[];
  }): void {
    if (!input.id.trim()) throw new Error('transfer batch id is required');
    if (input.legs.length === 0) throw new Error('transfer batch requires at least one leg');
    const now = input.createdAt ?? Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO transfer_batches(
            id, status, plan_json, confirmation, dry_run, safe_mode_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.status,
          json(input.plan),
          input.confirmation ?? null,
          input.dryRun ? 1 : 0,
          input.safeModeReason ?? null,
          now,
          now,
        );
      const insertLeg = this.db.prepare(
        `INSERT INTO transfer_legs(
          batch_id, leg_number, from_venue, to_venue, asset, network, amount, fee,
          address, address_tag, status, error, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const leg of input.legs) {
        if (!Number.isInteger(leg.legNumber) || leg.legNumber <= 0) {
          throw new Error('transfer leg number must be a positive integer');
        }
        if (!leg.amount.isFinite() || leg.amount.lte(0)) {
          throw new Error('transfer leg amount must be finite and positive');
        }
        insertLeg.run(
          input.id,
          leg.legNumber,
          leg.fromVenue,
          leg.toVenue,
          leg.asset.toUpperCase(),
          leg.network.toUpperCase(),
          leg.amount.toFixed(),
          leg.fee?.toFixed() ?? null,
          leg.address,
          leg.addressTag ?? null,
          leg.status,
          leg.error ?? null,
          json(leg.metadata ?? {}),
          now,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getTransferBatch(id: string): TransferBatchRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, status, plan_json, confirmation, dry_run, safe_mode_reason,
                created_at, updated_at
         FROM transfer_batches WHERE id = ?`,
      )
      .get(id) as TransferBatchRow | undefined;
    return row ? this.transferBatchFromRow(row) : undefined;
  }

  listTransferBatches(limit = 20): TransferBatchRecord[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('transfer batch limit must be a positive integer');
    }
    const rows = this.db
      .prepare(
        `SELECT id, status, plan_json, confirmation, dry_run, safe_mode_reason,
                created_at, updated_at
         FROM transfer_batches ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as unknown as TransferBatchRow[];
    return rows.map((row) => this.transferBatchFromRow(row));
  }

  activeTransferBatches(): TransferBatchRecord[] {
    const placeholders = ACTIVE_TRANSFER_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT id, status, plan_json, confirmation, dry_run, safe_mode_reason,
                created_at, updated_at
         FROM transfer_batches
         WHERE status IN (${placeholders})
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...ACTIVE_TRANSFER_STATUSES) as unknown as TransferBatchRow[];
    return rows.map((row) => this.transferBatchFromRow(row));
  }

  countActiveTransferBatches(excludeBatchId?: string): number {
    const placeholders = ACTIVE_TRANSFER_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM transfer_batches
         WHERE status IN (${placeholders}) AND (? IS NULL OR id <> ?)`,
      )
      .get(...ACTIVE_TRANSFER_STATUSES, excludeBatchId ?? null, excludeBatchId ?? null) as {
      count: number | bigint;
    };
    return Number(row.count);
  }

  dailyTransferAmount(fromVenue: string, asset: string, since: number): Decimal {
    const rows = this.db
      .prepare(
        `SELECT l.amount FROM transfer_legs l
         JOIN transfer_batches b ON b.id = l.batch_id
         WHERE l.from_venue = ? AND l.asset = ?
           AND l.status NOT IN ('BLOCKED', 'DRY_RUN')
           AND l.requested_at IS NOT NULL
           AND l.requested_at >= ?`,
      )
      .all(fromVenue, asset.toUpperCase(), since) as Array<{ amount: string }>;
    return rows.reduce((total, row) => total.plus(new Decimal(row.amount)), new Decimal(0));
  }

  applyTransferPreflight(input: {
    id: string;
    status: string;
    safeModeReason: string | null;
    now: number;
    legs: Array<{
      legNumber: number;
      status: string;
      error: string | null;
      fee?: Decimal;
      metadata: unknown;
    }>;
  }): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    let applied = false;
    try {
      const row = this.db
        .prepare(
          `SELECT status, execution_token, execution_lease_until
           FROM transfer_batches WHERE id = ?`,
        )
        .get(input.id) as
        | { status: string; execution_token: string | null; execution_lease_until: number | null }
        | undefined;
      if (!row) throw new Error(`transfer batch not found: ${input.id}`);
      const idle =
        ['PLANNED', 'READY', 'BLOCKED'].includes(row.status) &&
        !(row.execution_token !== null && (row.execution_lease_until ?? 0) > input.now);
      if (idle) {
        for (const leg of input.legs) {
          const fields = ['status = ?', 'error = ?', 'metadata_json = ?', 'updated_at = ?'];
          const values: Array<string | number | null> = [
            leg.status,
            leg.error,
            json(leg.metadata),
            input.now,
          ];
          if (leg.fee !== undefined) {
            fields.push('fee = ?');
            values.push(leg.fee.toFixed());
          }
          const result = this.db
            .prepare(
              `UPDATE transfer_legs SET ${fields.join(', ')}
               WHERE batch_id = ? AND leg_number = ?`,
            )
            .run(...values, input.id, leg.legNumber) as { changes: number | bigint };
          if (Number(result.changes) !== 1) {
            throw new Error(`transfer leg not found: ${input.id}:${leg.legNumber}`);
          }
        }
        this.db
          .prepare(
            `UPDATE transfer_batches
             SET status = ?, safe_mode_reason = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.status, input.safeModeReason, input.now, input.id);
        applied = true;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return applied;
  }

  claimTransferExecution(input: {
    id: string;
    token: string;
    now: number;
    leaseUntil: number;
    confirmation?: string | null;
  }): { claimed: boolean; reason?: string } {
    if (!input.token.trim()) throw new Error('transfer execution token is required');
    if (!Number.isFinite(input.leaseUntil) || input.leaseUntil <= input.now) {
      throw new Error('transfer execution lease must end after now');
    }
    this.db.exec('BEGIN IMMEDIATE');
    let result: { claimed: boolean; reason?: string };
    try {
      const row = this.db
        .prepare(
          `SELECT status, execution_token, execution_lease_until
           FROM transfer_batches WHERE id = ?`,
        )
        .get(input.id) as
        | { status: string; execution_token: string | null; execution_lease_until: number | null }
        | undefined;
      if (!row) throw new Error(`transfer batch not found: ${input.id}`);
      if (row.status === 'SAFE_STOP') {
        result = { claimed: false, reason: 'batch_safe_stop' };
      } else if (['COMPLETED', 'BLOCKED', 'DRY_RUN'].includes(row.status)) {
        result = { claimed: false, reason: `batch_terminal:${row.status}` };
      } else if (
        !['PLANNED', 'READY', 'EXECUTING', 'WITHDRAWING', 'WITHDRAWN', 'WAITING_DEPOSIT'].includes(
          row.status,
        )
      ) {
        result = { claimed: false, reason: `batch_not_executable:${row.status}` };
      } else if (
        row.execution_token !== null &&
        row.execution_token !== input.token &&
        (row.execution_lease_until ?? 0) > input.now
      ) {
        result = { claimed: false, reason: 'batch_execution_locked' };
      } else {
        const placeholders = ACTIVE_TRANSFER_STATUSES.map(() => '?').join(', ');
        const other = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM transfer_batches
             WHERE status IN (${placeholders}) AND id <> ?`,
          )
          .get(...ACTIVE_TRANSFER_STATUSES, input.id) as { count: number | bigint };
        if (Number(other.count) > 0) {
          result = { claimed: false, reason: 'another_transfer_batch_active' };
        } else {
          const updated = this.db
            .prepare(
              `UPDATE transfer_batches
               SET status = 'EXECUTING', confirmation = COALESCE(?, confirmation),
                   dry_run = 0, execution_token = ?, execution_lease_until = ?,
                   safe_mode_reason = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              input.confirmation ?? null,
              input.token,
              input.leaseUntil,
              input.now,
              input.id,
            ) as { changes: number | bigint };
          if (Number(updated.changes) !== 1) {
            throw new Error(`transfer batch claim did not update: ${input.id}`);
          }
          result = { claimed: true };
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return result;
  }

  releaseTransferExecution(id: string, token: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE transfer_batches
         SET execution_token = NULL, execution_lease_until = NULL, updated_at = ?
         WHERE id = ? AND execution_token = ?`,
      )
      .run(now, id, token) as { changes: number | bigint };
    return Number(result.changes) > 0;
  }

  updateTransferBatch(
    id: string,
    input: {
      status?: string;
      confirmation?: string | null;
      dryRun?: boolean;
      safeModeReason?: string | null;
      updatedAt?: number;
    },
  ): void {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (input.status !== undefined) {
      fields.push('status = ?');
      values.push(input.status);
    }
    if (input.confirmation !== undefined) {
      fields.push('confirmation = ?');
      values.push(input.confirmation);
    }
    if (input.dryRun !== undefined) {
      fields.push('dry_run = ?');
      values.push(input.dryRun ? 1 : 0);
    }
    if (input.safeModeReason !== undefined) {
      fields.push('safe_mode_reason = ?');
      values.push(input.safeModeReason);
    }
    fields.push('updated_at = ?');
    values.push(input.updatedAt ?? Date.now());
    const result = this.db
      .prepare(`UPDATE transfer_batches SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values, id) as { changes: number | bigint };
    if (Number(result.changes) === 0) {
      const exists = this.db.prepare('SELECT 1 FROM transfer_batches WHERE id = ?').get(id);
      if (!exists) throw new Error(`transfer batch not found: ${id}`);
    }
  }

  updateTransferLeg(batchId: string, legNumber: number, input: TransferLegUpdate): void {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const setText = (column: string, value: string | null | undefined): void => {
      if (value === undefined) return;
      fields.push(`${column} = ?`);
      values.push(value);
    };
    const setNumber = (column: string, value: number | null | undefined): void => {
      if (value === undefined) return;
      fields.push(`${column} = ?`);
      values.push(value);
    };
    setText('status', input.status);
    if (input.fee !== undefined) {
      fields.push('fee = ?');
      values.push(input.fee?.toFixed() ?? null);
    }
    setText('source_record_id', input.sourceRecordId);
    setText('source_tx_id', input.sourceTxId);
    setText('destination_record_id', input.destinationRecordId);
    setText('destination_tx_id', input.destinationTxId);
    setNumber('requested_at', input.requestedAt);
    setNumber('source_observed_at', input.sourceObservedAt);
    setNumber('destination_observed_at', input.destinationObservedAt);
    setText('error', input.error);
    if (input.metadata !== undefined) {
      fields.push('metadata_json = ?');
      values.push(json(input.metadata));
    }
    fields.push('updated_at = ?');
    values.push(input.updatedAt ?? Date.now());
    const result = this.db
      .prepare(
        `UPDATE transfer_legs SET ${fields.join(', ')} WHERE batch_id = ? AND leg_number = ?`,
      )
      .run(...values, batchId, legNumber) as { changes: number | bigint };
    if (Number(result.changes) === 0) {
      const exists = this.db
        .prepare('SELECT 1 FROM transfer_legs WHERE batch_id = ? AND leg_number = ?')
        .get(batchId, legNumber);
      if (!exists) throw new Error(`transfer leg not found: ${batchId}:${legNumber}`);
    }
  }

  private transferBatchFromRow(row: TransferBatchRow): TransferBatchRecord {
    const legs = this.db
      .prepare(
        `SELECT id, batch_id, leg_number, from_venue, to_venue, asset, network, amount, fee,
                address, address_tag, status, source_record_id, source_tx_id,
                destination_record_id, destination_tx_id, requested_at,
                source_observed_at, destination_observed_at, error, metadata_json, updated_at
         FROM transfer_legs WHERE batch_id = ? ORDER BY leg_number ASC`,
      )
      .all(row.id) as unknown as TransferLegRow[];
    return {
      id: row.id,
      status: row.status,
      plan: parseJsonColumn(row.plan_json),
      confirmation: row.confirmation,
      dryRun: row.dry_run === 1,
      safeModeReason: row.safe_mode_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      legs: legs.map((leg) => ({
        id: leg.id,
        batchId: leg.batch_id,
        legNumber: leg.leg_number,
        fromVenue: leg.from_venue,
        toVenue: leg.to_venue,
        asset: leg.asset,
        network: leg.network,
        amount: new Decimal(leg.amount),
        fee: leg.fee === null ? null : new Decimal(leg.fee),
        address: leg.address,
        addressTag: leg.address_tag,
        status: leg.status,
        sourceRecordId: leg.source_record_id,
        sourceTxId: leg.source_tx_id,
        destinationRecordId: leg.destination_record_id,
        destinationTxId: leg.destination_tx_id,
        requestedAt: leg.requested_at,
        sourceObservedAt: leg.source_observed_at,
        destinationObservedAt: leg.destination_observed_at,
        error: leg.error,
        metadata: parseJsonColumn(leg.metadata_json),
        updatedAt: leg.updated_at,
      })),
    };
  }

  private deleteChanges(sql: string, cutoff: number): number {
    const result = this.db.prepare(sql).run(cutoff) as { changes: number | bigint };
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
