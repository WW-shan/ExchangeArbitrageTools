import { Decimal, VenueHealthTracker } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  createCexAdapter,
  createPublicRuntime,
  isCcxtShutdownError,
  mergeAccountFeeFile,
} from '@arb/venues-cex';
import { costSettings, loadConfig } from '../apps/scanner/src/config.js';
import { ScannerService, type ScannerVenue } from '../apps/scanner/src/scanner-service.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installShutdownGuard(): void {
  const handle = (error: unknown): void => {
    if (isCcxtShutdownError(error)) return;
    console.error(error);
    process.exit(1);
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
}

async function main(): Promise<void> {
  installShutdownGuard();
  const config = loadConfig(process.env.ARB_CONFIG ?? 'config/default.toml');
  const venueIds = arg('--venues', 'gateio,weex')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const bases = arg('--bases', 'CAKE,ETH,BTC')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const quotes = arg('--quotes', arg('--quote', 'USDT'))
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const cycles = Math.max(1, Number(arg('--cycles', '8')));
  const intervalMs = Math.max(100, Number(arg('--interval-ms', '3000')));
  const warmupMs = Math.max(0, Number(arg('--warmup-ms', '15000')));
  const maxFeedLatencyMs = Math.max(
    100,
    Number(arg('--max-feed-latency-ms', String(config.scanner.maxFeedLatencyMs))),
  );
  const notional = new Decimal(arg('--notional', config.scanner.requestedNotional.toFixed()));
  const takerBpsArg = arg('--taker-bps', '');
  const makerBpsArg = arg('--maker-bps', '');
  const minNetProfitArg = arg('--min-net-profit-bps', '');
  const safetyBufferArg = arg('--safety-buffer-bps', '');
  const minProfitUsdArg = arg('--min-profit-usd', '');

  const feeOverrides = mergeAccountFeeFile(config.fees, config.scanner.feeFile);
  if (takerBpsArg || makerBpsArg) {
    for (const venueId of venueIds) {
      const existing = feeOverrides[venueId] ?? {};
      feeOverrides[venueId] = {
        ...existing,
        ...(takerBpsArg ? { takerBps: new Decimal(takerBpsArg) } : {}),
        ...(makerBpsArg ? { makerBps: new Decimal(makerBpsArg) } : {}),
      };
    }
  }
  const settings = costSettings(config.scanner);
  settings.maxOrderbookAgeMs = Math.max(
    settings.maxOrderbookAgeMs,
    Number(arg('--max-book-age-ms', String(config.scanner.maxOrderbookAgeMs))),
  );
  if (minNetProfitArg) settings.minNetProfitBps = new Decimal(minNetProfitArg);
  if (safetyBufferArg) settings.safetyBufferBps = new Decimal(safetyBufferArg);
  if (minProfitUsdArg) settings.minProfitUsd = new Decimal(minProfitUsdArg);

  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  const venues: ScannerVenue[] = venueIds.map((venueId) => {
    const health = new VenueHealthTracker();
    const runtime = createPublicRuntime(2, undefined, {
      onSuccess: (latency) => health.recordSuccess(latency),
      onFailure: (latency, rateLimited) => health.recordFailure(latency, Date.now(), rateLimited),
    });
    return {
      adapter: createCexAdapter(venueId, runtime, { readOnly: true }),
      health,
      markets: [],
    };
  });
  const scanner = new ScannerService({
    venues,
    repository,
    settings,
    quoteCurrency: quotes[0]!,
    baseAssets: bases,
    assetUniverseMode: 'explicit',
    maxBaseAssets: bases.length,
    quoteCurrencies: quotes,
    min24hQuoteVolumeUsd: new Decimal(0),
    universeRefreshMs: Number.MAX_SAFE_INTEGER,
    scanIntervalHotMs: 0,
    scanIntervalTop100Ms: 0,
    scanIntervalTop500Ms: 0,
    signalCooldownMs: 0,
    fetchConcurrency: 16,
    requestedNotional: notional,
    orderBookDepth: 20,
    maxFeedLatencyMs,
    maxFreezeMs: 10000,
    feedMode: 'websocket',
    wsMaxBookAgeMs: 5000,
    wsMaxSubscriptions: Math.max(1, Number(arg('--ws-max-subscriptions', '1200'))),
    wsMaxReconnectAttempts: 5,
    wsRestFallbackPerVenue: Math.max(0, Number(arg('--rest-fallback-per-venue', '8'))),
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
    recordFeed: process.argv.includes('--record'),
    recordFeedDir: arg('--record-dir', 'data/feed'),
    feeOverrides,
    maxTriangularPaths: 0,
    maxCandidatesPerCycle: 10,
    crossVenueMode: 'off',
    optimalSizing: true,
    minSizingNotional: new Decimal(
      arg('--min-sizing-notional', config.scanner.minSizingNotional.toFixed()),
    ),
    sizingStep: new Decimal('0.01'),
    maxSizingCandidatesPerCycle: 20,
    sizingSamples: 8,
    persistSnapshots: false,
    paperSimulation: false,
  });
  const discovered = await scanner.initialize();
  console.log('discovered', JSON.stringify(discovered));
  if (warmupMs > 0) {
    console.log(`warming up ${warmupMs}ms for websocket books`);
    await sleep(warmupMs);
  }
  console.log('initial full scan', JSON.stringify(await scanner.scanOnce()));
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const hot = await scanner.scanUpdates({
      maxWaitMs: intervalMs,
      debounceMs: config.scanner.hotScanDebounceMs,
    });
    const summary = hot ?? (await scanner.scanOnce());
    console.log(`cycle ${cycle} ${hot ? 'hot' : 'full-fallback'}`, JSON.stringify(summary));
    if (cycle < cycles) await sleep(intervalMs);
  }
  for (const venue of venues) {
    console.log('health', venue.adapter.venueId, JSON.stringify(venue.health.snapshot(Date.now())));
  }
  const rows = repository.listOpportunities({ limit: 1000 });
  const rejectionCounts: Record<string, number> = {};
  for (const row of rows) {
    if (Number(row.valid) === 1) continue;
    let reasons: string[] = [];
    try {
      reasons = JSON.parse(String(row.rejection_reasons)) as string[];
    } catch {
      reasons = [];
    }
    for (const reason of reasons) rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  }
  console.log('rejectionCounts', JSON.stringify(rejectionCounts));
  const validRows = rows.filter((row) => Number(row.valid) === 1);
  console.log(
    'validS1Rows',
    JSON.stringify(
      validRows.map((row) => ({
        direction: row.direction,
        netProfitBps: row.net_profit_bps,
        requestedNotional: row.requested_notional,
        sampledAt: row.sampled_at,
      })),
    ),
  );
  await scanner.close();
  repository.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
