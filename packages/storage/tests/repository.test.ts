import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assessStartupRecovery,
  evaluateS1Direction,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
} from '@arb/core';
import {
  ArbitrageRepository,
  MIGRATIONS,
  backupBeforePendingMigrations,
  migrate,
  openDatabase,
} from '../src/index.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};

function opportunity(at: number) {
  const market = (venueId: string): MarketMetadata => ({
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 3,
    amountPrecision: 3,
    amountStep: new Decimal('0.001'),
    priceStep: new Decimal('0.001'),
    minAmount: new Decimal('0.01'),
    minNotional: new Decimal('1'),
    feeTakerBps: new Decimal('10'),
    supportsIoc: true,
  });
  const book = (venueId: string, ask: string, bid: string): OrderBookSnapshot => ({
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: at,
    asks: [{ price: new Decimal(ask), amount: new Decimal('100') }],
    bids: [{ price: new Decimal(bid), amount: new Decimal('100') }],
    source: 'replay',
  });
  const result = evaluateS1Direction({
    base: 'CAKE',
    quote: 'USDT',
    buyMarket: market('gateio'),
    sellMarket: market('mexc'),
    buyBook: book('gateio', '2.500', '2.490'),
    sellBook: book('mexc', '2.560', '2.550'),
    requestedNotional: new Decimal('30'),
    settings,
    now: at,
    venueHealth: { gateio: 'B', mexc: 'B' },
  });
  expect(result.valid).toBe(true);
  return result;
}

describe('SQLite storage', () => {
  it('preserves an operator execution flag when a venue is re-registered without it', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({
      id: 'gateio',
      type: 'cex',
      name: 'Gate.io',
      tier: 'S',
      executionEnabled: true,
      now,
    });
    expect(repo.venueExecutionEnabled('gateio')).toBe(true);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    expect(repo.venueExecutionEnabled('gateio')).toBe(true);
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });
    expect(repo.venueExecutionEnabled('mexc')).toBe(false);
    repo.upsertVenue({
      id: 'gateio',
      type: 'cex',
      name: 'Gate.io',
      tier: 'S',
      executionEnabled: false,
      now,
    });
    expect(repo.venueExecutionEnabled('gateio')).toBe(false);
    repo.close();
  });

  it('replaces and lists the market universe per venue', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.replaceMarketUniverse(
      'gateio',
      [
        {
          venueId: 'gateio',
          exchangeSymbol: 'ETH/USDT',
          base: 'ETH',
          quote: 'USDT',
          quoteVolume24h: new Decimal('20000000'),
          tier: 'top100',
        },
        {
          venueId: 'gateio',
          exchangeSymbol: 'CAKE/USDT',
          base: 'CAKE',
          quote: 'USDT',
          quoteVolume24h: new Decimal('5000000'),
          tier: 'top100',
        },
      ],
      now,
    );
    const rows = repo.listMarketUniverse('gateio');
    expect(rows.map((row) => row.exchangeSymbol)).toEqual(['ETH/USDT', 'CAKE/USDT']);
    expect(rows[0]?.quoteVolume24h?.toFixed()).toBe('20000000');
    repo.replaceMarketUniverse(
      'gateio',
      [
        {
          venueId: 'gateio',
          exchangeSymbol: 'CAKE/USDC',
          base: 'CAKE',
          quote: 'USDC',
          tier: 'top500',
        },
      ],
      now,
    );
    expect(repo.listMarketUniverse('gateio')).toHaveLength(1);
    expect(repo.listMarketUniverse('gateio')[0]?.tier).toBe('top500');
    repo.close();
  });

  it('migrates idempotently and groups opportunity samples into an episode', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });

    const first = repo.recordOpportunity(opportunity(now));
    const second = repo.recordOpportunity(opportunity(now + 5000));
    expect(first.episodeId).not.toBeNull();
    expect(second.episodeId).toBe(first.episodeId);
    const episode = db
      .prepare('SELECT sample_count, status FROM opportunity_episodes WHERE id = ?')
      .get(first.episodeId!) as { sample_count: number; status: string };
    expect(episode.sample_count).toBe(2);
    expect(episode.status).toBe('open');

    repo.closeStaleEpisodes(now + 60_000, 15_000);
    const closed = db
      .prepare('SELECT status FROM opportunity_episodes WHERE id = ?')
      .get(first.episodeId!) as { status: string };
    expect(closed.status).toBe('closed');
    repo.close();
  });

  it('persists paper trades and exposes startup recovery state', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });
    const stored = repo.recordOpportunity(opportunity(now));
    repo.recordPaperTrade({
      opportunityId: stored.id,
      requestedNotional: new Decimal(30),
      simulatedBaseAmount: new Decimal(12),
      buyPriceAverage: new Decimal('2.5'),
      sellPriceAverage: new Decimal('2.55'),
      fees: new Decimal('0.06'),
      gasCost: new Decimal(0),
      netProfit: new Decimal('0.54'),
      result: 'CLOSED',
      executedAt: now,
    });
    expect(repo.paperTradeSummary().count).toBe(1);
    repo.recordPaperTrade({
      opportunityId: stored.id,
      requestedNotional: new Decimal(30),
      simulatedBaseAmount: new Decimal(30),
      buyPriceAverage: new Decimal(1),
      sellPriceAverage: new Decimal('1.01'),
      fees: new Decimal('0.02'),
      gasCost: new Decimal(0),
      netProfit: new Decimal('0.28'),
      result: 'SIMULATED',
      executedAt: now,
    });
    expect(repo.paperTradeSummary()).toMatchObject({
      count: 2,
      closed_count: 1,
      simulated_count: 1,
      failed_count: 0,
    });

    const executionId = repo.createExecution({
      strategy: 'S1',
      batchId: 'restart-batch',
      status: 'LEG1_UNKNOWN',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.29'),
      openedAt: now,
    });
    repo.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: 'gateio',
      side: 'buy',
      requestedAmount: new Decimal(12),
      requestedPrice: new Decimal('2.5'),
      status: 'unknown',
      submittedAt: now,
      clientOrderId: 'restart-batch-L1',
    });
    const counts = repo.recoveryCounts();
    const decision = assessStartupRecovery({
      openExecutions: counts.openExecutions,
      unresolvedLegs: counts.unresolvedLegs,
      persistedKillSwitch: true,
      balancesConfirmed: false,
    });
    expect(counts.openExecutions).toBe(1);
    expect(counts.unresolvedLegs).toBe(1);
    expect(decision.blockExecution).toBe(true);
    expect(decision.killSwitch).toBe(true);
    repo.close();
  });

  it('loads the latest S1 handoff and aggregates rollout money with exact decimals', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });
    const stored = repo.recordOpportunity(opportunity(now));
    const loaded = repo.latestValidS1Opportunity();
    expect(loaded?.id).toBe(stored.id);
    expect(loaded?.opportunity).toMatchObject({
      strategy: 'S1',
      instrumentKey: 'CAKE/USDT',
      venueBuy: 'gateio',
      venueSell: 'mexc',
      valid: true,
    });
    expect(loaded?.opportunity.requestedNotional.toFixed()).toBe('30');
    expect(loaded?.opportunity.metadata?.buySymbol).toBe('CAKE/USDT');

    for (const [profit, gas] of [
      ['0.1', '0.01'],
      ['0.2', '0.02'],
    ]) {
      repo.recordPaperTrade({
        opportunityId: stored.id,
        requestedNotional: new Decimal(30),
        simulatedBaseAmount: new Decimal(12),
        buyPriceAverage: new Decimal('2.5'),
        sellPriceAverage: new Decimal('2.55'),
        fees: new Decimal('0.06'),
        gasCost: new Decimal(gas!),
        netProfit: new Decimal(profit!),
        result: 'CLOSED',
        executedAt: now,
      });
    }
    const metrics = repo.rolloutMetrics(now + 1000);
    expect(metrics.costs.paperNetProfitUsd.toFixed()).toBe('0.3');
    expect(metrics.costs.gasCostUsd.toFixed()).toBe('0.03');
    expect(metrics.executions.fillRate).toBe(0);

    const executionId = repo.createExecution({
      strategy: 'S1',
      batchId: `S1-${stored.id}-${now}`,
      status: 'PREFLIGHT_CHECK',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.3'),
      openedAt: now,
      opportunityId: stored.id,
    });
    expect(repo.executionForOpportunity(stored.id)).toMatchObject({
      batchId: `S1-${stored.id}-${now}`,
      status: 'PREFLIGHT_CHECK',
    });
    expect(repo.validS1OpportunityById(stored.id)?.id).toBe(stored.id);
    expect(executionId).toBeGreaterThan(0);
    repo.close();
  });

  it('preserves the close timestamp when a closed execution is updated later', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    const executionId = repo.createExecution({
      strategy: 'S1',
      batchId: 'closed-batch',
      status: 'PREFLIGHT_CHECK',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.29'),
      openedAt: now,
    });
    repo.updateExecutionStatus(executionId, 'CLOSED', {
      realizedProfit: new Decimal('0.29'),
      closedAt: now + 10_000,
    });
    repo.updateExecutionStatus(executionId, 'SAFE_STOP', {
      safeModeReason: 'post_close_audit',
    });
    const row = db
      .prepare('SELECT status, closed_at, safe_mode_reason FROM executions WHERE id = ?')
      .get(executionId) as {
      status: string;
      closed_at: number;
      safe_mode_reason: string;
    };
    expect(row.status).toBe('SAFE_STOP');
    expect(row.closed_at).toBe(now + 10_000);
    expect(row.safe_mode_reason).toBe('post_close_audit');
    repo.close();
  });

  it('persists health, currency, BSC mappings and DEX quotes', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: '0x', type: 'aggregator', name: '0x', tier: 'B', now });
    repo.recordHealth(
      'gateio',
      {
        successRate: 1,
        medianLatencyMs: 120,
        p95LatencyMs: 240,
        rateLimitEvents: 0,
        staleDataEvents: 0,
        feedLatencyP95Ms: 0,
        crossedRate: 0,
        sequenceGapRate: 0,
        staleFeedRate: 0,
        reliabilityScore: 1,
        healthState: 'A',
        score: 100,
      },
      now,
    );
    repo.upsertCurrencies(
      [
        {
          venueId: 'gateio',
          code: 'CAKE',
          networks: [
            {
              network: 'BSC',
              nativeName: 'BNB Smart Chain (BEP20)',
              withdrawEnabled: true,
              depositEnabled: true,
              withdrawFee: new Decimal('0.1'),
              minWithdrawAmount: new Decimal('1'),
              minDepositAmount: new Decimal('0.1'),
              canArriveQuickly: true,
            },
          ],
        },
      ],
      now,
    );
    repo.upsertBscToken({
      contractAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      symbol: 'CAKE',
      name: 'PancakeSwap Token',
      decimals: 18,
      verifiedContract: true,
      transferTaxBps: new Decimal(0),
      riskLevel: 'low',
      updatedAt: now,
    });
    repo.upsertTokenMapping({
      cexVenueId: 'gateio',
      cexCurrency: 'CAKE',
      contractAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      status: 'active',
      verificationSources: ['manual-whitelist'],
      transferTaxBps: new Decimal(0),
      riskLevel: 'low',
      updatedAt: now,
    });
    repo.recordDexQuote({
      providerId: '0x',
      chain: 'BSC',
      sellToken: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      buyToken: '0x55d398326f99059fF775485246999027B3197955',
      sellAmount: new Decimal(10),
      buyAmount: new Decimal('25'),
      expectedSlippageBps: new Decimal(10),
      priceImpactBps: new Decimal(5),
      feeBps: new Decimal(0),
      gasEstimate: new Decimal(210000),
      gasPrice: new Decimal('1e9'),
      gasCostUsd: new Decimal('0.12'),
      quotedAt: now,
    });

    const health = db.prepare('SELECT COUNT(*) AS n FROM venue_health').get() as { n: number };
    const currencies = db
      .prepare('SELECT network, withdraw_enabled FROM exchange_currencies')
      .get() as { network: string; withdraw_enabled: number };
    const token = db.prepare('SELECT symbol, verified_contract FROM bsc_tokens').get() as {
      symbol: string;
      verified_contract: number;
    };
    const mapping = db.prepare('SELECT status, verification_sources FROM token_mappings').get() as {
      status: string;
      verification_sources: string;
    };
    const quotes = db.prepare('SELECT COUNT(*) AS n FROM dex_quotes').get() as { n: number };
    expect(health.n).toBe(1);
    expect(currencies).toEqual({ network: 'BSC', withdraw_enabled: 1 });
    expect(token).toEqual({ symbol: 'CAKE', verified_contract: 1 });
    expect(mapping.status).toBe('active');
    expect(JSON.parse(mapping.verification_sources)).toEqual(['manual-whitelist']);
    expect(quotes.n).toBe(1);
    repo.close();
  });

  it('persists balances and inventory snapshots', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'bsc-wallet', type: 'chain', name: 'BSC wallet', tier: 'C', now });
    repo.recordBalance({
      venueId: 'gateio',
      accountId: 'main',
      currency: 'USDT',
      free: new Decimal(60),
      used: new Decimal(0),
      total: new Decimal(60),
      fetchedAt: now,
    });
    const id = repo.recordInventorySnapshot({
      venueId: 'bsc-wallet',
      accountId: 'main',
      chain: 'BSC',
      asset: 'cake',
      contractAddress: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
      free: new Decimal(10),
      used: new Decimal(0),
      total: new Decimal(10),
      usdValue: new Decimal(25),
      capturedAt: now,
    });
    const balances = db.prepare('SELECT COUNT(*) AS n FROM balances').get() as { n: number };
    expect(balances.n).toBe(1);
    expect(id).toBeGreaterThan(0);
    const inventory = repo.latestInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ asset: 'CAKE', total: '10', usd_value: '25' });
    repo.close();
  });

  it('prunes raw order books and expired opportunity history in dependency order', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });
    const stored = repo.recordOpportunity(opportunity(now));
    repo.recordPaperTrade({
      opportunityId: stored.id,
      requestedNotional: new Decimal(30),
      simulatedBaseAmount: new Decimal(12),
      buyPriceAverage: new Decimal('2.5'),
      sellPriceAverage: new Decimal('2.55'),
      fees: new Decimal('0.06'),
      gasCost: new Decimal(0),
      netProfit: new Decimal('0.54'),
      result: 'CLOSED',
      executedAt: now,
    });
    const book = {
      venueId: 'gateio',
      exchangeSymbol: 'CAKE/USDT',
      fetchedAt: now,
      asks: [{ price: new Decimal('2.5'), amount: new Decimal(1) }],
      bids: [{ price: new Decimal('2.49'), amount: new Decimal(1) }],
      source: 'replay' as const,
    };
    repo.recordOrderbook(book, true);
    repo.closeStaleEpisodes(now + 60_000, 15_000);

    const result = repo.pruneHistoricalData({
      now: now + 400 * 24 * 60 * 60 * 1000,
      orderbookMs: 0,
      opportunityMs: 0,
      episodeMs: 0,
      paperMs: 0,
    });
    expect(result.orderbooks).toBe(1);
    expect(result.paperTrades).toBe(1);
    expect(result.opportunities).toBe(1);
    expect(result.episodes).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM opportunities').get() as { n: number }).n).toBe(
      0,
    );
    expect((db.prepare('SELECT COUNT(*) AS n FROM paper_trades').get() as { n: number }).n).toBe(0);
    repo.close();
  });

  it('retains opportunities referenced by executions or recent paper trades', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });

    const executionOpportunity = repo.recordOpportunity(opportunity(now));
    repo.createExecution({
      strategy: 'S1',
      batchId: 'retention-execution',
      status: 'CLOSED',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.25'),
      openedAt: now,
      opportunityId: executionOpportunity.id,
    });

    const paperOpportunity = repo.recordOpportunity(opportunity(now + 1000));
    repo.recordPaperTrade({
      opportunityId: paperOpportunity.id,
      requestedNotional: new Decimal(30),
      simulatedBaseAmount: new Decimal(12),
      buyPriceAverage: new Decimal('2.5'),
      sellPriceAverage: new Decimal('2.55'),
      fees: new Decimal('0.06'),
      gasCost: new Decimal(0),
      netProfit: new Decimal('0.54'),
      result: 'CLOSED',
      executedAt: now + 100 * 24 * 60 * 60 * 1000,
    });

    const day = 24 * 60 * 60 * 1000;
    const result = repo.pruneHistoricalData({
      now: now + 400 * day,
      opportunityMs: 0,
      paperMs: 365 * day,
      episodeMs: 0,
    });
    expect(result.opportunities).toBe(0);
    const ids = (
      db.prepare('SELECT id FROM opportunities ORDER BY id').all() as Array<{ id: number }>
    ).map((row) => row.id);
    expect(ids).toEqual([executionOpportunity.id, paperOpportunity.id]);
    repo.close();
  });

  it('persists daily risk counters and open unhedged inventory across restarts', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    const executionId = repo.createExecution({
      strategy: 'S1',
      batchId: 'risk-batch',
      status: 'LEG2_PARTIAL',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.29'),
      openedAt: now,
    });
    repo.addRealizedLoss(new Decimal('2.50'), now);
    repo.addRealizedLoss(new Decimal('0.25'), now);
    repo.addRebalanceCost(new Decimal('1.25'), now);
    const inventoryId = repo.recordUnhedgedInventory({
      executionId,
      batchId: 'risk-batch',
      venueId: 'gateio',
      asset: 'cake',
      amount: new Decimal('2'),
      usdValue: new Decimal('5'),
      reason: 'leg2_partial_fill',
      createdAt: now,
    });

    const snapshot = repo.riskSnapshot(now);
    expect(snapshot.dailyRealizedLoss.toFixed()).toBe('2.75');
    expect(snapshot.dailyRebalanceCost.toFixed()).toBe('1.25');
    expect(snapshot.unhedgedInventoryRisk.toFixed()).toBe('5');
    expect(repo.openUnhedgedInventory()).toHaveLength(1);
    expect(repo.openUnhedgedInventory()[0]?.direction).toBe('long');

    repo.resolveUnhedgedInventory(inventoryId, now + 1000);
    expect(repo.riskSnapshot(now).unhedgedInventoryRisk.toFixed()).toBe('0');
    expect(repo.openUnhedgedInventory()).toHaveLength(0);
    repo.close();
  });

  it('backs up an existing database before pending migrations are applied', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-migration-'));
    const path = join(directory, 'legacy.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA journal_mode = WAL;');
    legacy.exec('PRAGMA wal_autocheckpoint = 0;');
    legacy.exec(MIGRATIONS[0].sql);
    legacy
      .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)')
      .run(MIGRATIONS[0].name, now);
    legacy
      .prepare(
        `INSERT INTO venues(id, type, name, tier, execution_enabled, created_at, updated_at)
         VALUES ('legacy', 'cex', 'Legacy', 'B', 0, ?, ?)`,
      )
      .run(now, now);
    legacy.close();

    const backupPath = backupBeforePendingMigrations(path, now);
    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath!)).toBe(true);
    const backup = new DatabaseSync(backupPath!, { readOnly: true });
    expect(
      (
        backup.prepare("SELECT COUNT(*) AS n FROM venues WHERE id = 'legacy'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    backup.close();

    const db = openDatabase(path);
    const versions = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{
      version: number;
    }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const columns = db.prepare('PRAGMA table_info(unhedged_inventory)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain('direction');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists venue backoff, execution preflight, simulation quality and recovery queries', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });

    repo.upsertVenueBackoff({
      venueId: 'gateio',
      backoffUntil: now + 30_000,
      reason: 'rate_limited',
      consecutiveFailures: 2,
      updatedAt: now,
    });
    expect(repo.activeVenueBackoffs(now)).toHaveLength(1);
    expect(repo.venueBackoff('gateio', now)?.consecutiveFailures).toBe(2);
    expect(repo.venueBackoff('gateio', now + 30_000)).toBeUndefined();
    repo.clearVenueBackoff('gateio');
    expect(repo.activeVenueBackoffs(now)).toHaveLength(0);

    const stored = repo.recordOpportunity(opportunity(now));
    repo.recordPaperTrade({
      opportunityId: stored.id,
      requestedNotional: new Decimal(30),
      simulatedBaseAmount: new Decimal(12),
      buyPriceAverage: new Decimal('2.5'),
      sellPriceAverage: new Decimal('2.55'),
      buyPriceWorst: new Decimal('2.51'),
      sellPriceWorst: new Decimal('2.54'),
      fees: new Decimal('0.06'),
      gasCost: new Decimal('0.1'),
      netProfit: new Decimal('0.44'),
      result: 'CLOSED',
      executedAt: now,
      durationMs: 4200,
      expectedFailureReasons: ['stale_orderbook'],
      fillQuality: { leg1: { fillRatio: '1' }, leg2: { fillRatio: '1' } },
    });
    const paper = db
      .prepare(
        `SELECT buy_price_worst, sell_price_worst, duration_ms, expected_failure_reasons,
                fill_quality_json FROM paper_trades`,
      )
      .get() as Record<string, string | number>;
    expect(paper.buy_price_worst).toBe('2.51');
    expect(paper.sell_price_worst).toBe('2.54');
    expect(paper.duration_ms).toBe(4200);
    expect(JSON.parse(String(paper.expected_failure_reasons))).toEqual(['stale_orderbook']);
    expect(JSON.parse(String(paper.fill_quality_json))).toEqual({
      leg1: { fillRatio: '1' },
      leg2: { fillRatio: '1' },
    });

    const executionId = repo.createExecution({
      strategy: 'S1',
      batchId: 'audit-batch',
      status: 'PREFLIGHT_CHECK',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.29'),
      openedAt: now,
      opportunityId: stored.id,
      preflight: { refreshedDepth: '12' },
      metadata: { source: 'test' },
    });
    repo.updateExecutionPreflight(executionId, { refreshedDepth: '12.001' });
    repo.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: 'gateio',
      side: 'buy',
      requestedAmount: new Decimal(12),
      requestedPrice: new Decimal('2.5'),
      status: 'submitted',
      submittedAt: now,
      clientOrderId: 'audit-batch-L1',
    });
    repo.recordOrder({
      venueId: 'gateio',
      clientOrderId: 'audit-batch-L1',
      executionId,
      symbol: 'CAKE/USDT',
      side: 'buy',
      type: 'limit',
      price: new Decimal('2.5'),
      amount: new Decimal(12),
      filledAmount: new Decimal(0),
      status: 'open',
      now,
    });
    expect(repo.countUnresolvedOrders()).toBe(1);
    repo.recordOrderEvent('audit-batch-L1', 'submission_response', { status: 'open' }, now);
    expect(repo.getOrder('audit-batch-L1')?.executionId).toBe(executionId);
    expect(repo.listUnresolvedOrders()).toHaveLength(1);
    expect(repo.listOpenExecutions()[0]?.legs).toHaveLength(1);
    expect(repo.listOpenExecutions()[0]?.batchId).toBe('audit-batch');

    repo.updateExecutionStatus(executionId, 'CLOSED', {
      realizedProfit: new Decimal('0.25'),
      closedAt: now + 1000,
      grossSpread: new Decimal('0.35'),
      fees: new Decimal('0.1'),
      latencyMs: 875,
      inventoryDelta: { CAKE: '0', USDT: '0.25' },
      metadata: { final: true },
    });
    const execution = db
      .prepare(
        `SELECT opportunity_id, preflight_json, gross_spread, fees, latency_ms,
                inventory_delta_json, metadata_json, closed_at
         FROM executions WHERE id = ?`,
      )
      .get(executionId) as Record<string, string | number>;
    expect(execution.opportunity_id).toBe(stored.id);
    expect(JSON.parse(String(execution.preflight_json))).toEqual({ refreshedDepth: '12.001' });
    expect(execution.gross_spread).toBe('0.35');
    expect(execution.fees).toBe('0.1');
    expect(execution.latency_ms).toBe(875);
    expect(JSON.parse(String(execution.inventory_delta_json))).toEqual({
      CAKE: '0',
      USDT: '0.25',
    });
    expect(JSON.parse(String(execution.metadata_json))).toEqual({ final: true });
    repo.close();
  });

  it('exports executions with legs, orders and order events as JSONL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-export-'));
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    const executionId = repo.createExecution({
      strategy: 'S1',
      batchId: 'export-batch',
      status: 'LEG1_SUBMITTING',
      plannedNotional: new Decimal(30),
      expectedProfit: new Decimal('0.25'),
      openedAt: now,
    });
    repo.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: 'gateio',
      side: 'buy',
      requestedAmount: new Decimal(12),
      requestedPrice: new Decimal('2.5'),
      status: 'submitted',
      submittedAt: now,
      clientOrderId: 'export-batch-L1',
    });
    repo.recordOrder({
      venueId: 'gateio',
      clientOrderId: 'export-batch-L1',
      executionId,
      symbol: 'CAKE/USDT',
      side: 'buy',
      type: 'limit',
      price: new Decimal('2.5'),
      amount: new Decimal(12),
      filledAmount: new Decimal(0),
      status: 'open',
      now,
    });
    repo.recordOrderEvent('export-batch-L1', 'submission_response', { status: 'open' }, now);
    const output = join(directory, 'exports', 'executions.jsonl');
    const result = repo.exportExecutionsJsonl(output);
    expect(result.executions).toBe(1);
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    const record = JSON.parse(lines[0]!) as {
      batch_id: string;
      legs: unknown[];
      orders: Array<{ events: unknown[] }>;
    };
    expect(record.batch_id).toBe('export-batch');
    expect(record.legs).toHaveLength(1);
    expect(record.orders[0]!.events).toHaveLength(1);
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('opportunity lifetime and decay', () => {
  it('summarises episode duration and first-to-last profit decay', () => {
    const db = openDatabase(':memory:');
    const repo = new ArbitrageRepository(db);
    repo.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repo.upsertVenue({ id: 'mexc', type: 'cex', name: 'MEXC', tier: 'S', now });
    const base = opportunity(now);
    const samples: Array<{ at: number; profit: string }> = [
      { at: now, profit: '1.00' },
      { at: now + 5_000, profit: '0.80' },
      { at: now + 10_000, profit: '0.60' },
    ];
    for (const sample of samples) {
      repo.recordOpportunity({
        ...base,
        sampledAt: sample.at,
        conservativeNetProfit: new Decimal(sample.profit),
      });
    }
    repo.recordOpportunity({
      ...base,
      sampledAt: now + 15_000,
      valid: false,
      conservativeNetProfit: new Decimal(0),
    });

    const summary = repo.episodeSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      strategy: 'S1',
      episodes: 1,
      openEpisodes: 0,
      totalSamples: 3,
      medianDurationMs: 10_000,
      maxDurationMs: 10_000,
    });
    expect(summary[0]!.medianMaxProfit.toFixed()).toBe('1');

    const decay = repo.opportunityDecay();
    expect(decay).toHaveLength(1);
    expect(decay[0]!.episodes).toBe(1);
    expect(decay[0]!.medianDecayBps.toFixed(0)).toBe('-4000');
    expect(decay[0]!.decayingEpisodes).toBe(1);
    expect(decay[0]!.improvingEpisodes).toBe(0);
    repo.close();
  });
});
