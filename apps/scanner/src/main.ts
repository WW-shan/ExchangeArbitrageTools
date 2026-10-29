import { existsSync } from 'node:fs';
import { loadConfig, costSettings } from './config.js';
import { scanBscToken } from './bsc-scanner.js';
import { bscMappings, persistBscToken } from './bsc-mappings.js';
import { persistSimulatedOpportunity } from './persistence.js';
import { ScannerService, type ScannerVenue } from './scanner-service.js';
import { mergeAccountFeeFile } from './fee-file.js';
import { VenueHealthTracker } from '@arb/core';
import { ArbitrageRepository, openDatabase, writeHeartbeat } from '@arb/storage';
import { dirname, join, resolve } from 'node:path';
import {
  CEX_TIERS,
  createCexAdapter,
  createPublicRuntime,
  isCcxtShutdownError,
} from '@arb/venues-cex';
import {
  BscTokenRegistry,
  OneInchQuoteProvider,
  ZeroExQuoteProvider,
  type QuoteProvider,
  type TokenMappingCandidate,
} from '@arb/venues-bsc';

const SCANNER_STARTED_AT = Date.now();

function quoteProvider(
  kind: '0x' | '1inch',
  config: ReturnType<typeof loadConfig>,
): QuoteProvider | undefined {
  if (kind === '0x') {
    return new ZeroExQuoteProvider({
      ...(process.env.ZEROX_API_KEY ? { apiKey: process.env.ZEROX_API_KEY } : {}),
      expectedSlippageBps: config.bsc.slippageBps,
      bnbUsd: config.bsc.bnbUsd,
    });
  }
  if (!process.env.ONEINCH_API_KEY) return undefined;
  return new OneInchQuoteProvider({
    apiKey: process.env.ONEINCH_API_KEY,
    expectedSlippageBps: config.bsc.slippageBps,
    bnbUsd: config.bsc.bnbUsd,
  });
}

function runMaintenance(
  repository: ArbitrageRepository,
  databasePath: string,
  now = Date.now(),
): void {
  const pruned = repository.pruneHistoricalData({ now });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const exported = repository.exportExecutionsJsonl(
    join(dirname(resolve(databasePath)), 'exports', `executions-${stamp}.jsonl`),
  );
  repository.recordAudit('scanner', 'retention_and_execution_export', { pruned, exported }, now);
}

async function main(): Promise<void> {
  process.on('uncaughtException', (error) => {
    if (isCcxtShutdownError(error)) return;
    console.error(error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    if (isCcxtShutdownError(error)) return;
    console.error(error);
    process.exit(1);
  });
  const config = loadConfig(process.env.ARB_CONFIG ?? 'config/default.toml');
  const db = openDatabase(config.database.path);
  const repository = new ArbitrageRepository(db);
  const heartbeatFile =
    process.env.ARB_ROTATION_SCANNER_HEARTBEAT ?? 'data/rotation-scanner.heartbeat.json';
  const stopFile = process.env.ARB_ROTATION_STOP_FILE ?? 'data/rotation.stop';
  let scannerPhase = 'STARTING';
  const recordScannerHeartbeat = (state: 'running' | 'stopped', phase: string): void => {
    try {
      writeHeartbeat(heartbeatFile, {
        version: 1,
        role: 'scanner',
        ...(process.env.ARB_ROTATION_RUN_ID ? { runId: process.env.ARB_ROTATION_RUN_ID } : {}),
        pid: process.pid,
        startedAt: SCANNER_STARTED_AT,
        updatedAt: Date.now(),
        state,
        phase,
        lastProgressAt: Date.now(),
      });
    } catch (error) {
      console.error('failed to write scanner heartbeat', error);
    }
  };
  recordScannerHeartbeat('running', scannerPhase);
  const heartbeatTimer = setInterval(() => {
    recordScannerHeartbeat('running', scannerPhase);
  }, 5000);
  heartbeatTimer.unref?.();
  const bscRegistry = new BscTokenRegistry();
  const persistedKillSwitch = repository.getSetting('kill_switch');
  if (config.execution.killSwitch || persistedKillSwitch === undefined) {
    repository.setSetting('kill_switch', String(config.execution.killSwitch));
  }
  repository.setSetting('live_enabled', String(config.execution.liveEnabled));
  repository.recordAudit('scanner', 'startup', { killSwitch: config.execution.killSwitch });
  let nextMaintenanceAt = 0;
  runMaintenance(repository, config.database.path);
  nextMaintenanceAt = Date.now() + 24 * 60 * 60 * 1000;
  repository.upsertVenue({ id: '0x', type: 'aggregator', name: '0x', tier: 'B' });
  repository.upsertVenue({ id: '1inch', type: 'aggregator', name: '1inch', tier: 'B' });
  for (const token of bscRegistry.getWhitelist()) persistBscToken(repository, token);

  const venues: ScannerVenue[] = config.scanner.enabledVenues.map((venueId) => {
    const health = new VenueHealthTracker();
    const ensureVenue = (): void => {
      repository.upsertVenue({
        id: venueId,
        type: 'cex',
        name: venueId,
        tier: CEX_TIERS[venueId] ?? 'B',
      });
    };
    let runtime!: ReturnType<typeof createPublicRuntime>;
    runtime = createPublicRuntime(2, undefined, {
      onSuccess: (latency) => health.recordSuccess(latency),
      onFailure: (latency, rateLimited) => health.recordFailure(latency, Date.now(), rateLimited),
      onBackoff: (state) => {
        try {
          ensureVenue();
          repository.upsertVenueBackoff({
            venueId,
            backoffUntil: state.backoffUntil,
            reason: state.reason,
            consecutiveFailures: state.consecutiveFailures,
            updatedAt: Date.now(),
          });
          repository.recordRiskEvent(
            'warning',
            'venue_backoff',
            state.reason,
            {
              venueId,
              backoffUntil: state.backoffUntil,
              retryAfterMs: state.retryAfterMs,
              consecutiveFailures: state.consecutiveFailures,
            },
            Date.now(),
          );
        } catch (error) {
          console.error('failed to persist venue backoff', venueId, error);
        }
      },
      onRecover: () => {
        try {
          repository.clearVenueBackoff(venueId);
        } catch (error) {
          console.error('failed to clear venue backoff', venueId, error);
        }
      },
    });
    const adapter = createCexAdapter(venueId, runtime, { readOnly: true });
    return {
      adapter,
      health,
      markets: [],
      applyBackoff: (retryAfterMs) => runtime.rateLimiter.respectRetryAfter(retryAfterMs),
    };
  });

  const scanner = new ScannerService({
    venues,
    repository,
    settings: costSettings(config.scanner),
    quoteCurrency: config.scanner.quoteCurrency,
    baseAssets: config.scanner.baseAssets,
    assetUniverseMode: config.scanner.assetUniverseMode,
    maxBaseAssets: config.scanner.maxBaseAssets,
    quoteCurrencies: config.scanner.quoteCurrencies,
    min24hQuoteVolumeUsd: config.scanner.min24hQuoteVolumeUsd,
    universeRefreshMs: config.scanner.universeRefreshMs,
    scanIntervalHotMs: config.scanner.scanIntervalHotMs,
    scanIntervalTop100Ms: config.scanner.scanIntervalTop100Ms,
    scanIntervalTop500Ms: config.scanner.scanIntervalTop500Ms,
    signalCooldownMs: config.scanner.signalCooldownMs,
    fetchConcurrency: config.scanner.fetchConcurrency,
    requestedNotional: config.scanner.requestedNotional,
    orderBookDepth: config.scanner.orderBookDepth,
    maxFeedLatencyMs: config.scanner.maxFeedLatencyMs,
    maxFreezeMs: config.scanner.maxFreezeMs,
    feedMode: config.scanner.feedMode,
    wsMaxBookAgeMs: config.scanner.wsMaxBookAgeMs,
    wsMaxSubscriptions: config.scanner.wsMaxSubscriptions,
    wsMaxReconnectAttempts: config.scanner.wsMaxReconnectAttempts,
    wsRestFallbackPerVenue: config.scanner.wsRestFallbackPerVenue,
    entryGateMode: config.scanner.entryGateMode,
    entryPercentile: config.scanner.entryPercentile,
    entryGateWindowMs: config.scanner.entryGateWindowMs,
    entryGateMinSamples: config.scanner.entryGateMinSamples,
    bookSanityEnabled: config.scanner.bookSanityEnabled,
    bookSanityIntervalMs: config.scanner.bookSanityIntervalMs,
    bookSanityMaxDeviationBps: config.scanner.bookSanityMaxDeviationBps,
    bookSanityRequiredFailures: config.scanner.bookSanityRequiredFailures,
    bookSanityRequiredSuccesses: config.scanner.bookSanityRequiredSuccesses,
    bookSanityCooldownMs: config.scanner.bookSanityCooldownMs,
    bookSanitySampleSize: config.scanner.bookSanitySampleSize,
    liquidityMultiple: config.scanner.liquidityMultiple,
    prefilterEnabled: config.scanner.prefilterEnabled,
    prefilterFloorBps: config.scanner.prefilterFloorBps,
    incrementalEvaluation: config.scanner.incrementalEvaluation,
    routeCooldownMs: config.scanner.routeCooldownMs,
    hotScanDebounceMs: config.scanner.hotScanDebounceMs,
    hotDepthLevels: config.scanner.hotDepthLevels,
    hotScanBudgetMs: config.scanner.hotScanBudgetMs,
    hotNearMissBps: config.scanner.hotNearMissBps,
    hotSubscriptionRefreshMs: config.scanner.hotSubscriptionRefreshMs,
    hotSeedEnabled: config.scanner.hotSeedEnabled,
    hotSeedLookbackMs: config.scanner.hotSeedLookbackMs,
    hotSeedLimit: config.scanner.hotSeedLimit,
    hotSeedTtlMs: config.scanner.hotSeedTtlMs,
    recordFeed: config.scanner.recordFeed,
    recordFeedDir: config.scanner.recordFeedDir,
    feeOverrides: mergeAccountFeeFile(config.fees, config.scanner.feeFile),
    maxTriangularPaths: config.scanner.maxTriangularPaths,
    maxCandidatesPerCycle: config.scanner.maxCandidatesPerCycle,
    maxHops: config.scanner.maxHops,
    maxLegsPerCurrency: config.scanner.maxLegsPerCurrency,
    crossVenueMode: config.scanner.crossVenueMode,
    maxVenueSwitches: config.scanner.maxVenueSwitches,
    balanceMaxAgeMs: config.scanner.balanceMaxAgeMs,
    requireBalancesForS1: config.scanner.requireBalancesForS1,
    balanceSafetyBufferBps: config.scanner.balanceSafetyBufferBps,
    monitorOnlyVenues: config.scanner.monitorOnlyVenues,
    optimalSizing: config.scanner.optimalSizing,
    minSizingNotional: config.scanner.minSizingNotional,
    sizingStep: config.scanner.sizingStep,
    maxSizingCandidatesPerCycle: config.scanner.maxSizingCandidatesPerCycle,
    sizingSamples: config.scanner.sizingSamples,
    persistSnapshots: config.scanner.persistSnapshots,
  });
  const discovered = await scanner.initialize();
  console.log('market discovery', discovered);

  let primary: QuoteProvider | undefined;
  let backup: QuoteProvider | undefined;
  let mappings: Array<{ mapping: TokenMappingCandidate; venue: ScannerVenue }> = [];
  if (config.bsc.enabled) {
    primary = quoteProvider(config.bsc.primaryProvider, config);
    backup = quoteProvider(config.bsc.backupProvider, config);
    mappings = bscMappings(
      {
        tokenSymbols: config.bsc.tokenSymbols,
        quoteCurrency: config.scanner.quoteCurrency,
        estimatedTransferArrivalMs: config.bsc.estimatedTransferArrivalMs,
      },
      venues,
      bscRegistry,
      repository,
    );
    if (!primary) {
      console.warn('BSC scanning enabled but primary quote provider credentials are missing');
    }
    if (!backup) {
      console.warn('BSC backup provider unavailable; S4 comparisons will be skipped');
    }
  }

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });
  let nextFullScanAt = 0;
  while (!stopping) {
    if (existsSync(stopFile)) {
      stopping = true;
      break;
    }
    scannerPhase = 'SCANNING';
    recordScannerHeartbeat('running', 'SCANNING');
    const now = Date.now();
    const didFullScan = now >= nextFullScanAt;
    if (didFullScan) {
      try {
        const summary = await scanner.scanOnce();
        console.log(JSON.stringify({ ...summary, mode: 'full' }));
      } catch (error) {
        console.error('scan failed', error);
        repository.recordRiskEvent('warning', 'scanner_cycle_failure', String(error));
      }
      nextFullScanAt = Date.now() + config.scanner.scanIntervalMs;
      scannerPhase = 'WAIT';
      recordScannerHeartbeat('running', 'WAIT');
    } else if (config.scanner.feedMode === 'websocket') {
      try {
        const waitMs = Math.max(
          25,
          Math.min(config.scanner.wsScanIntervalMs, nextFullScanAt - Date.now()),
        );
        const summary = await scanner.scanUpdates({
          maxWaitMs: waitMs,
          debounceMs: config.scanner.hotScanDebounceMs,
        });
        if (summary && (summary.s1Count > 0 || summary.validOpportunities > 0)) {
          console.log(JSON.stringify({ ...summary, mode: 'hot' }));
        }
      } catch (error) {
        console.error('hot scan failed', error);
        repository.recordRiskEvent('warning', 'scanner_hot_cycle_failure', String(error));
      }
      scannerPhase = 'WAIT';
      recordScannerHeartbeat('running', 'WAIT');
    } else {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(25, nextFullScanAt - Date.now())),
      );
      scannerPhase = 'WAIT';
      recordScannerHeartbeat('running', 'WAIT');
    }

    if (didFullScan && config.bsc.enabled && primary) {
      for (const entry of mappings) {
        const market = entry.venue.markets.find(
          (candidate) =>
            candidate.base === entry.mapping.cexCurrency &&
            candidate.quote === config.scanner.quoteCurrency &&
            candidate.active,
        );
        if (!market) continue;
        try {
          const result = await scanBscToken({
            cexAdapter: entry.venue.adapter,
            cexMarket: market,
            mapping: entry.mapping,
            primaryProvider: primary,
            ...(backup ? { backupProvider: backup } : {}),
            requestedNotional: config.scanner.requestedNotional,
            settings: costSettings(config.scanner),
            slippageBps: config.bsc.slippageBps,
            inventoryMode: config.bsc.inventoryMode,
            maxTransferArrivalMs: config.bsc.maxTransferArrivalMs,
            registry: bscRegistry,
          });
          if (
            result.book &&
            config.scanner.persistSnapshots &&
            result.opportunities.some((opportunity) => opportunity.valid)
          ) {
            repository.recordOrderbook(result.book, true);
          }
          for (const opportunity of result.opportunities) {
            const stored = repository.recordOpportunity(opportunity);
            if (opportunity.valid) {
              console.log(
                `BSC opportunity ${opportunity.strategy} ${opportunity.direction} ${opportunity.conservativeNetProfit.toFixed()} USDT`,
              );
            }
            if (
              opportunity.valid &&
              (opportunity.strategy === 'S3' || opportunity.strategy === 'S4')
            ) {
              persistSimulatedOpportunity(
                repository,
                stored,
                opportunity,
                config.scanner.quoteCurrency,
              );
            }
          }
          for (const quote of result.quotes) {
            repository.recordDexQuote(quote);
          }
          for (const error of result.errors) {
            repository.recordRiskEvent('warning', 'bsc_scan_error', error, {
              token: entry.mapping.cexCurrency,
            });
          }
        } catch (error) {
          repository.recordRiskEvent('warning', 'bsc_scan_failure', String(error), {
            token: entry.mapping.cexCurrency,
          });
        }
      }
    }
    if (didFullScan && Date.now() >= nextMaintenanceAt) {
      runMaintenance(repository, config.database.path);
      nextMaintenanceAt = Date.now() + 24 * 60 * 60 * 1000;
    }
  }
  await scanner.close();
  clearInterval(heartbeatTimer);
  recordScannerHeartbeat('stopped', 'STOPPED');
  repository.recordAudit('scanner', 'shutdown');
  repository.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
