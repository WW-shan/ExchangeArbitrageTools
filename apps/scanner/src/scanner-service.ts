import {
  ExecutionGate,
  VenueHealthTracker,
  ZERO,
  Decimal,
  ScriptedPaperGateway,
  defaultPaperRiskLimits,
  estimateTriangularPathReturn,
  enumerateCyclicPaths,
  buildCrossVenueGraph,
  enumerateCrossVenuePaths,
  evaluateCrossVenuePath,
  evaluateCrossVenuePathOptimal,
  estimateS1Return,
  evaluateS1Direction,
  evaluateS1DirectionOptimal,
  evaluateTriangularPath,
  evaluateTriangularPathOptimal,
  runPaperBatch,
  validateOrderBook,
  bookFeedLatencyMs,
  canonicalMarketForEvaluation,
  marketBaseMultiplier,
  marketExchangeBase,
  marketsShareUnderlying,
  normalizeBookForMarket,
  type CostSettings,
  type CurrencyMetadata,
  type HealthState,
  type MarketMetadata,
  type OpportunityResult,
  type OrderBookSnapshot,
  type S1EvaluationInput,
  type TickerSnapshot,
  type TriangularEdge,
} from '@arb/core';
import type { ArbitrageRepository, MarketUniverseEntry, StoredOpportunity } from '@arb/storage';
import {
  applyFeeOverride,
  BookStore,
  type BookSubscription,
  type CexAdapter,
} from '@arb/venues-cex';
import { persistSimulatedOpportunity } from './persistence.js';
import { buildMarketUniverse } from './universe.js';
import { FeedRecorder } from './feed-recorder.js';
import { PercentileEntryGate } from './entry-gate.js';
import { BookSanityMonitor, bookDeviationBps } from './book-sanity.js';
import { depthBoundNotional } from './depth.js';
import type { FeeOverride } from './config.js';

export interface ScannerVenue {
  adapter: CexAdapter;
  health: VenueHealthTracker;
  markets: MarketMetadata[];
  currencies?: CurrencyMetadata[];
  applyBackoff?: (retryAfterMs: number) => void;
}

export interface ScanSummary {
  scannedAt: number;
  booksFetched: number;
  validOpportunities: number;
  rejectedOpportunities: number;
  errors: number;
  s1Count: number;
  s2Count: number;
  s2Candidates: number;
  s2Evaluated: number;
  s2CrossVenueCount: number;
  crossVenueCandidates: number;
  crossVenueEvaluated: number;
  sizingCandidates: number;
  prefiltered: number;
  skippedUnchanged: number;
  dirtyBooks: number;
  dirtyGroups: number;
  deferredGroups: number;
  aliasMismatches: number;
}

interface FetchedBook {
  book: OrderBookSnapshot;
  valid: boolean;
  reasons: string[];
}

const TIER_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };

function tierRank(tier: string): number {
  return TIER_ORDER[tier] ?? 5;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function bookMid(book: OrderBookSnapshot): Decimal | undefined {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (!bid || !ask || !bid.gt(0) || !ask.gt(0)) return undefined;
  return bid.plus(ask).div(2);
}

function medianDecimal(values: readonly Decimal[]): Decimal | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return sorted[middle - 1]!.plus(sorted[middle]!).div(2);
}

export interface ScannerServiceOptions {
  venues: ScannerVenue[];
  repository: ArbitrageRepository;
  settings: CostSettings;
  quoteCurrency: string;
  baseAssets: string[];
  assetUniverseMode?: 'top_volume' | 'explicit';
  maxBaseAssets?: number;
  quoteCurrencies?: string[];
  min24hQuoteVolumeUsd?: Decimal;
  universeRefreshMs?: number;
  scanIntervalHotMs?: number;
  scanIntervalTop100Ms?: number;
  scanIntervalTop500Ms?: number;
  signalCooldownMs?: number;
  fetchConcurrency?: number;
  requestedNotional: import('decimal.js').Decimal;
  orderBookDepth: number;
  maxFeedLatencyMs?: number;
  maxFreezeMs?: number;
  feedMode?: 'rest' | 'websocket';
  wsMaxBookAgeMs?: number;
  wsMaxSubscriptions?: number;
  wsMaxReconnectAttempts?: number;
  wsRestFallbackPerVenue?: number;
  entryGateMode?: 'off' | 'percentile';
  entryPercentile?: Decimal;
  entryGateWindowMs?: number;
  entryGateMinSamples?: number;
  bookSanityEnabled?: boolean;
  bookSanityIntervalMs?: number;
  bookSanityMaxDeviationBps?: Decimal;
  bookSanityRequiredFailures?: number;
  bookSanityRequiredSuccesses?: number;
  bookSanityCooldownMs?: number;
  bookSanitySampleSize?: number;
  liquidityMultiple?: Decimal;
  prefilterEnabled?: boolean;
  prefilterFloorBps?: number;
  incrementalEvaluation?: boolean;
  routeCooldownMs?: number;
  hotScanDebounceMs?: number;
  hotDepthLevels?: number;
  hotScanBudgetMs?: number;
  hotNearMissBps?: Decimal;
  hotSubscriptionRefreshMs?: number;
  hotSeedEnabled?: boolean;
  hotSeedLookbackMs?: number;
  hotSeedLimit?: number;
  hotSeedTtlMs?: number;
  recordFeed?: boolean;
  recordFeedDir?: string;
  feeOverrides?: Record<string, FeeOverride>;
  maxTriangularPaths: number;
  maxCandidatesPerCycle?: number;
  maxHops?: number;
  maxLegsPerCurrency?: number;
  crossVenueMode?: 'off' | 'inventory';
  maxVenueSwitches?: number;
  balanceMaxAgeMs?: number;
  requireBalancesForS1?: boolean;
  monitorOnlyVenues?: string[];
  optimalSizing?: boolean;
  minSizingNotional?: Decimal;
  sizingStep?: Decimal;
  maxSizingCandidatesPerCycle?: number;
  sizingSamples?: number;
  persistSnapshots: boolean;
  paperSimulation?: boolean;
  episodeGapMs?: number;
  clock?: () => number;
}

export class ScannerService {
  readonly #venues: ScannerVenue[];
  readonly #repository: ArbitrageRepository;
  readonly #settings: CostSettings;
  readonly #baseAssets: string[];
  readonly #assetUniverseMode: 'top_volume' | 'explicit';
  readonly #maxBaseAssets: number;
  readonly #quoteCurrencies: string[];
  readonly #min24hQuoteVolumeUsd: Decimal;
  readonly #universeRefreshMs: number;
  readonly #scanIntervalHotMs: number;
  readonly #scanIntervalTop100Ms: number;
  readonly #scanIntervalTop500Ms: number;
  readonly #signalCooldownMs: number;
  readonly #fetchConcurrency: number;
  readonly #requestedNotional: import('decimal.js').Decimal;
  readonly #orderBookDepth: number;
  readonly #maxFeedLatencyMs: number;
  readonly #maxFreezeMs: number;
  readonly #feedMode: 'rest' | 'websocket';
  readonly #wsMaxBookAgeMs: number;
  readonly #wsMaxSubscriptions: number;
  readonly #wsMaxReconnectAttempts: number;
  readonly #wsRestFallbackPerVenue: number;
  readonly #entryGate: PercentileEntryGate;
  readonly #bookSanity: BookSanityMonitor;
  readonly #bookSanitySampleSize: number;
  readonly #liquidityMultiple: Decimal;
  readonly #prefilterEnabled: boolean;
  readonly #prefilterFloorBps: number;
  readonly #incrementalEvaluation: boolean;
  readonly #routeCooldownMs: number;
  readonly #hotScanDebounceMs: number;
  readonly #hotDepthLevels: number;
  readonly #hotScanBudgetMs: number;
  readonly #hotNearMissBps: Decimal;
  readonly #hotSubscriptionRefreshMs: number;
  readonly #hotSeedEnabled: boolean;
  readonly #hotSeedLookbackMs: number;
  readonly #hotSeedLimit: number;
  readonly #hotSeedTtlMs: number;
  #baseFingerprints = new Map<string, string>();
  #baseHadValid = new Map<string, boolean>();
  #routeLastValidAt = new Map<string, number>();
  readonly #recordFeed: boolean;
  readonly #recordFeedDir: string;
  readonly #feeOverrides: Record<string, FeeOverride>;
  readonly #maxTriangularPaths: number;
  readonly #maxCandidatesPerCycle: number;
  readonly #maxHops: number;
  readonly #maxLegsPerCurrency: number;
  readonly #crossVenueMode: 'off' | 'inventory';
  readonly #maxVenueSwitches: number;
  readonly #balanceMaxAgeMs: number;
  readonly #requireBalancesForS1: boolean;
  readonly #monitorOnlyVenues: ReadonlySet<string>;
  readonly #optimalSizing: boolean;
  readonly #minSizingNotional: Decimal;
  readonly #sizingStep: Decimal;
  readonly #maxSizingCandidatesPerCycle: number;
  readonly #sizingSamples: number;
  readonly #persistSnapshots: boolean;
  readonly #paperSimulation: boolean;
  readonly #episodeGapMs: number;
  readonly #clock: () => number;
  #bookCache = new Map<string, FetchedBook>();
  #universe = new Map<string, MarketUniverseEntry[]>();
  #universeBuiltAt = 0;
  #lastTierScan = { hot: 0, top100: 0, top500: 0 };
  #hotUntil = new Map<string, number>();
  #scanErrors = 0;
  #paperSequence = 0;
  #sizingCandidates = 0;
  #bookStore?: BookStore;
  #feedRecorder?: FeedRecorder;
  #subscribedKeys = new Set<string>();
  #restRotation = 0;
  #bookSanityCursor = 0;
  #marketIndex = new Map<string, MarketMetadata>();
  #pairIndex = new Map<string, Array<{ venue: ScannerVenue; market: MarketMetadata }>>();
  #dirtyBooks = new Set<string>();
  #lastBbo = new Map<string, string>();
  #hotWaiters: Array<() => void> = [];
  #subscriptionsDirty = false;
  #lastSubscriptionSyncAt = 0;
  #lastEpisodeCloseAt = 0;
  #closed = false;

  constructor(options: ScannerServiceOptions) {
    if (options.venues.length < 2)
      throw new Error('at least two CEX venues are required for S1 scanning');
    this.#venues = options.venues;
    this.#repository = options.repository;
    this.#settings = options.settings;
    this.#baseAssets = options.baseAssets;
    this.#assetUniverseMode = options.assetUniverseMode ?? 'explicit';
    this.#maxBaseAssets = options.maxBaseAssets ?? Math.max(1, options.baseAssets.length);
    this.#quoteCurrencies = options.quoteCurrencies ?? [options.quoteCurrency];
    this.#min24hQuoteVolumeUsd = options.min24hQuoteVolumeUsd ?? new Decimal(0);
    this.#universeRefreshMs = options.universeRefreshMs ?? 3_600_000;
    this.#scanIntervalHotMs = options.scanIntervalHotMs ?? 0;
    this.#scanIntervalTop100Ms = options.scanIntervalTop100Ms ?? 0;
    this.#scanIntervalTop500Ms = options.scanIntervalTop500Ms ?? 0;
    this.#signalCooldownMs = options.signalCooldownMs ?? 0;
    this.#fetchConcurrency = Math.max(1, options.fetchConcurrency ?? 8);
    this.#requestedNotional = options.requestedNotional;
    this.#orderBookDepth = options.orderBookDepth;
    this.#maxFeedLatencyMs = Math.max(0, options.maxFeedLatencyMs ?? 500);
    this.#maxFreezeMs = Math.max(0, options.maxFreezeMs ?? 5000);
    this.#feedMode = options.feedMode ?? 'rest';
    this.#wsMaxBookAgeMs = Math.max(0, options.wsMaxBookAgeMs ?? 2000);
    this.#wsMaxSubscriptions = Math.max(1, options.wsMaxSubscriptions ?? 200);
    this.#wsMaxReconnectAttempts = Math.max(0, options.wsMaxReconnectAttempts ?? 5);
    this.#wsRestFallbackPerVenue = Math.max(0, options.wsRestFallbackPerVenue ?? 8);
    this.#entryGate = new PercentileEntryGate({
      mode: options.entryGateMode ?? 'off',
      ...(options.entryPercentile ? { percentile: options.entryPercentile.toNumber() } : {}),
      ...(options.entryGateWindowMs !== undefined ? { windowMs: options.entryGateWindowMs } : {}),
      ...(options.entryGateMinSamples !== undefined
        ? { minSamples: options.entryGateMinSamples }
        : {}),
      clock: options.clock ?? Date.now,
    });
    this.#bookSanity = new BookSanityMonitor({
      enabled: options.bookSanityEnabled ?? false,
      ...(options.bookSanityIntervalMs !== undefined
        ? { intervalMs: options.bookSanityIntervalMs }
        : {}),
      ...(options.bookSanityMaxDeviationBps !== undefined
        ? { maxDeviationBps: options.bookSanityMaxDeviationBps }
        : {}),
      ...(options.bookSanityRequiredFailures !== undefined
        ? { requiredFailures: options.bookSanityRequiredFailures }
        : {}),
      ...(options.bookSanityRequiredSuccesses !== undefined
        ? { requiredSuccesses: options.bookSanityRequiredSuccesses }
        : {}),
      ...(options.bookSanityCooldownMs !== undefined
        ? { cooldownMs: options.bookSanityCooldownMs }
        : {}),
      clock: options.clock ?? Date.now,
    });
    this.#bookSanitySampleSize = Math.max(1, options.bookSanitySampleSize ?? 4);
    this.#liquidityMultiple =
      options.liquidityMultiple && options.liquidityMultiple.gte(1)
        ? options.liquidityMultiple
        : new Decimal(1);
    this.#prefilterEnabled = options.prefilterEnabled ?? false;
    this.#prefilterFloorBps = options.prefilterFloorBps ?? 0;
    this.#incrementalEvaluation = options.incrementalEvaluation ?? false;
    this.#routeCooldownMs = Math.max(0, options.routeCooldownMs ?? 0);
    this.#hotScanDebounceMs = Math.max(0, options.hotScanDebounceMs ?? 25);
    this.#hotDepthLevels = Math.max(0, Math.min(20, options.hotDepthLevels ?? 3));
    this.#hotScanBudgetMs = Math.max(0, options.hotScanBudgetMs ?? 250);
    this.#hotNearMissBps = options.hotNearMissBps ?? new Decimal(5);
    this.#hotSubscriptionRefreshMs = Math.max(0, options.hotSubscriptionRefreshMs ?? 5_000);
    this.#hotSeedEnabled = options.hotSeedEnabled ?? true;
    this.#hotSeedLookbackMs = Math.max(0, options.hotSeedLookbackMs ?? 7 * 24 * 60 * 60 * 1000);
    this.#hotSeedLimit = Math.max(0, options.hotSeedLimit ?? 30);
    this.#hotSeedTtlMs = Math.max(0, options.hotSeedTtlMs ?? 60 * 60 * 1000);
    this.#recordFeed = options.recordFeed ?? false;
    this.#recordFeedDir = options.recordFeedDir ?? 'data/feed';
    this.#feeOverrides = options.feeOverrides ?? {};
    this.#maxTriangularPaths = options.maxTriangularPaths;
    this.#maxCandidatesPerCycle = Math.max(
      1,
      options.maxCandidatesPerCycle ?? Number.MAX_SAFE_INTEGER,
    );
    this.#maxHops = Math.max(2, options.maxHops ?? 5);
    this.#maxLegsPerCurrency = Math.max(1, options.maxLegsPerCurrency ?? 4);
    this.#crossVenueMode = options.crossVenueMode ?? 'off';
    this.#maxVenueSwitches = Math.max(0, options.maxVenueSwitches ?? 1);
    this.#balanceMaxAgeMs = Math.max(0, options.balanceMaxAgeMs ?? 300_000);
    this.#requireBalancesForS1 = options.requireBalancesForS1 ?? false;
    this.#monitorOnlyVenues = new Set(
      (options.monitorOnlyVenues ?? []).map((venueId) => venueId.trim().toLowerCase()),
    );
    this.#optimalSizing = options.optimalSizing ?? false;
    this.#minSizingNotional = options.minSizingNotional ?? new Decimal(1);
    this.#sizingStep = options.sizingStep ?? new Decimal('0.01');
    this.#maxSizingCandidatesPerCycle = Math.max(0, options.maxSizingCandidatesPerCycle ?? 40);
    this.#sizingSamples = Math.max(4, options.sizingSamples ?? 16);
    this.#persistSnapshots = options.persistSnapshots;
    this.#paperSimulation = options.paperSimulation ?? true;
    this.#episodeGapMs = options.episodeGapMs ?? 15_000;
    this.#clock = options.clock ?? Date.now;
  }

  async initialize(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    // Discover venues concurrently; with 30+ exchanges a sequential pass takes
    // minutes because each loadMarkets is a network round trip.
    await this.runWithConcurrency(this.#venues, this.#fetchConcurrency, async (venue) => {
      await this.discoverVenue(venue);
      counts[venue.adapter.venueId] = venue.markets.length;
    });
    await this.runWithConcurrency(this.#venues, this.#fetchConcurrency, (venue) =>
      this.refreshUniverse(venue),
    );
    this.rebuildIndexes();
    this.#universeBuiltAt = this.#clock();
    this.seedHotFromRoutes();
    if (this.#feedMode === 'websocket') {
      if (this.#recordFeed) {
        this.#feedRecorder = new FeedRecorder({
          directory: this.#recordFeedDir,
          clock: this.#clock,
        });
      }
      this.#bookStore = new BookStore({
        depth: this.#orderBookDepth,
        maxBookAgeMs: this.#wsMaxBookAgeMs,
        maxReconnectAttempts: this.#wsMaxReconnectAttempts,
        clock: this.#clock,
        onError: (venueId, symbol, error) => {
          this.#repository.recordRiskEvent(
            'warning',
            'websocket_error',
            String(error),
            { venueId, symbol },
            this.#clock(),
          );
        },
        onBook: (book) => {
          this.#feedRecorder?.record(book);
          this.onBookUpdate(book);
        },
      });
      this.syncSubscriptions();
    }
    return counts;
  }

  private async discoverVenue(venue: ScannerVenue): Promise<void> {
    this.#repository.upsertVenue({
      id: venue.adapter.venueId,
      type: 'cex',
      name: venue.adapter.venueId,
      tier: venue.adapter.tier,
    });
    const backoff = this.#repository.venueBackoff(venue.adapter.venueId, this.#clock());
    if (backoff) {
      venue.applyBackoff?.(Math.max(0, backoff.backoffUntil - this.#clock()));
      this.#repository.recordRiskEvent(
        'warning',
        'venue_backoff_restored',
        backoff.reason,
        {
          venueId: venue.adapter.venueId,
          backoffUntil: backoff.backoffUntil,
          consecutiveFailures: backoff.consecutiveFailures,
        },
        this.#clock(),
      );
    }
    const discoveryStarted = Date.now();
    try {
      const markets = await venue.adapter.loadMarkets();
      venue.markets = markets
        .filter((market) => market.active && market.venueId === venue.adapter.venueId)
        .map((market) => applyFeeOverride(market, this.#feeOverrides));
    } catch (error) {
      venue.markets = [];
      const observedAt = this.#clock();
      venue.health.recordFailure(
        Date.now() - discoveryStarted,
        observedAt,
        /rate|429|418/i.test(String(error)),
      );
      this.#repository.recordRiskEvent(
        'critical',
        'market_discovery_failed',
        String(error),
        { venueId: venue.adapter.venueId },
        observedAt,
      );
    }
    for (const market of venue.markets) this.#repository.upsertMarket(market);
    if (venue.adapter.fetchCurrencies) {
      try {
        const currencies = await venue.adapter.fetchCurrencies();
        venue.currencies = currencies;
        this.#repository.upsertCurrencies(currencies);
      } catch (error) {
        this.#repository.recordRiskEvent(
          'warning',
          'currency_metadata_unavailable',
          String(error),
          { venueId: venue.adapter.venueId },
        );
      }
    }
  }

  private async runWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    task: (item: T) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= items.length) return;
        await task(items[current]!);
      }
    });
    await Promise.all(workers);
  }

  async scanOnce(): Promise<ScanSummary> {
    const cycleStartedAt = this.#clock();
    // The full pass evaluates every active base; updates that arrive during the
    // pass will be added back to the dirty set and handled by scanUpdates().
    this.#dirtyBooks.clear();
    this.#bookCache = new Map();
    this.#scanErrors = 0;
    this.#sizingCandidates = 0;
    const summary: ScanSummary = {
      scannedAt: cycleStartedAt,
      booksFetched: 0,
      validOpportunities: 0,
      rejectedOpportunities: 0,
      errors: 0,
      s1Count: 0,
      s2Count: 0,
      s2Candidates: 0,
      s2Evaluated: 0,
      s2CrossVenueCount: 0,
      crossVenueCandidates: 0,
      crossVenueEvaluated: 0,
      sizingCandidates: 0,
      prefiltered: 0,
      skippedUnchanged: 0,
      dirtyBooks: 0,
      dirtyGroups: 0,
      deferredGroups: 0,
      aliasMismatches: 0,
    };
    const persisted = new Set<string>();
    const balances = this.#repository.latestBalances({
      maxAgeMs: this.#balanceMaxAgeMs,
      now: cycleStartedAt,
    });
    if (cycleStartedAt - this.#universeBuiltAt >= this.#universeRefreshMs) {
      for (const venue of this.#venues) await this.refreshUniverse(venue);
      this.#universeBuiltAt = this.#clock();
      this.rebuildIndexes();
      this.syncSubscriptions();
    }
    const dueTiers = this.dueTiers(cycleStartedAt);
    const active = this.activeUniverse(dueTiers, cycleStartedAt);
    if (this.#bookSanity.enabled) {
      // REST cross-checks must not sit on the hot scan path.
      void this.runBookSanityChecks(active).catch(() => undefined);
    }
    // WebSocket books are already pushed into BookStore during warmup; only the
    // REST feed needs a prefetch pass. Skipping it keeps cycle latency low so
    // that books are still fresh when they are evaluated.
    if (this.#feedMode !== 'websocket') await this.prefetchBooks(active);

    for (const quote of this.#quoteCurrencies) {
      // Group the active universe by base, then fetch one base's books
      // concurrently and evaluate it immediately. This keeps every book close to
      // its evaluation time even when many venues fall back to REST.
      const refsByBase = new Map<string, Array<{ venue: ScannerVenue; market: MarketMetadata }>>();
      for (const venue of this.#venues) {
        const entries = active.get(venue.adapter.venueId) ?? [];
        for (const entry of entries) {
          if (entry.quote !== quote) continue;
          const market = this.findMarket(venue, entry.base, quote, entry.exchangeSymbol);
          if (!market) continue;
          const rows = refsByBase.get(entry.base) ?? [];
          rows.push({ venue, market });
          refsByBase.set(entry.base, rows);
        }
      }
      for (const [base, refs] of refsByBase) {
        await this.evaluateS1Group({
          quote,
          base,
          refs,
          summary,
          persisted,
          balances,
          allowRestFallback: true,
        });
      }
    }

    let evaluatedTriangularPaths = 0;
    for (const venue of this.#venues) {
      const entries = active.get(venue.adapter.venueId) ?? [];
      if (entries.length === 0) continue;
      const assets = new Set(entries.map((entry) => entry.base));
      for (const quote of this.#quoteCurrencies) {
        if (evaluatedTriangularPaths >= this.#maxTriangularPaths) break;
        const edgeAssets = new Set([...assets, quote]);
        const edges: TriangularEdge[] = [];
        const edgeBooks = new Map<string, FetchedBook>();
        for (const market of venue.markets) {
          // S2/S3 graph sizing is not yet unit-translated; fail closed rather
          // than mixing 1000PEPE quantities into a PEPE path.
          if (!marketBaseMultiplier(market).eq(1)) continue;
          if (!edgeAssets.has(market.base) || !edgeAssets.has(market.quote)) continue;
          if (!venue.adapter.capabilities.orderBook) continue;
          const fetched = await this.getBook(venue, market.exchangeSymbol);
          if (!fetched || !fetched.valid) continue;
          edges.push({ market, book: fetched.book });
          edgeBooks.set(market.exchangeSymbol, fetched);
        }
        const seen = new Set<string>();
        const evaluatedAt = this.#clock();
        const health = this.healthMap(evaluatedAt);
        const candidates = enumerateCyclicPaths(edges, {
          startCurrency: quote,
          maxHops: this.#maxHops,
          maxLegsPerCurrency: this.#maxLegsPerCurrency,
          maxPaths: Math.max(0, this.#maxTriangularPaths - evaluatedTriangularPaths),
        })
          .filter((path) => {
            const key = path.currencies.join('>');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((path) => ({ path, estimate: estimateTriangularPathReturn(path) }))
          .sort((left, right) => right.estimate.comparedTo(left.estimate))
          .slice(0, Math.max(0, this.#maxTriangularPaths - evaluatedTriangularPaths));
        summary.s2Candidates += candidates.length;
        const exactCandidates = candidates.slice(0, this.#maxCandidatesPerCycle);
        summary.s2Evaluated += exactCandidates.length;
        for (const { path, estimate } of exactCandidates) {
          evaluatedTriangularPaths += 1;
          const opportunity = this.shouldOptimize(estimate)
            ? evaluateTriangularPathOptimal(
                path,
                this.#requestedNotional,
                this.#settings,
                evaluatedAt,
                health[venue.adapter.venueId] ?? 'D',
                {
                  minNotional: this.#minSizingNotional,
                  step: this.#sizingStep,
                  samples: this.#sizingSamples,
                },
              )
            : evaluateTriangularPath(
                path,
                this.#requestedNotional,
                this.#settings,
                evaluatedAt,
                health[venue.adapter.venueId] ?? 'D',
              );
          const stored = this.record(opportunity, summary);
          summary.s2Count += 1;
          if (opportunity.valid && this.#persistSnapshots) {
            for (const edge of path.edges) {
              const fetched = edgeBooks.get(edge.market.exchangeSymbol);
              if (fetched)
                this.persistSnapshot(venue.adapter.venueId, edge.market, fetched.book, persisted);
            }
          }
          if (opportunity.valid) {
            for (const edge of path.edges) this.promoteHot(venue, edge.market, evaluatedAt);
          }
          if (opportunity.valid && this.#paperSimulation) {
            persistSimulatedOpportunity(this.#repository, stored, opportunity, quote);
          }
        }
      }
    }

    if (this.#crossVenueMode === 'inventory') {
      await this.scanCrossVenue(active, cycleStartedAt, summary, persisted);
    }

    const closeAt = this.#clock();
    this.#lastEpisodeCloseAt = closeAt;
    this.#repository.closeStaleEpisodes(closeAt, this.#episodeGapMs);
    const healthAt = this.#clock();
    for (const venue of this.#venues) {
      this.#repository.recordHealth(
        venue.adapter.venueId,
        venue.health.snapshot(healthAt),
        healthAt,
      );
    }
    summary.errors = this.#scanErrors;
    summary.sizingCandidates = this.#sizingCandidates;
    return summary;
  }

  private async evaluateS1Group(input: {
    quote: string;
    base: string;
    refs: Array<{ venue: ScannerVenue; market: MarketMetadata }>;
    summary: ScanSummary;
    persisted: Set<string>;
    balances: ReturnType<ArbitrageRepository['latestBalances']>;
    allowRestFallback: boolean;
  }): Promise<void> {
    const { quote, base, refs, summary, persisted, balances, allowRestFallback } = input;
    const resolved = await Promise.all(
      refs.map(async (ref) => ({
        ...ref,
        fetched: await this.getBook(ref.venue, ref.market.exchangeSymbol, {
          restFallback: allowRestFallback,
        }),
      })),
    );
    summary.booksFetched += resolved.filter((row) => row.fetched !== undefined).length;
    const entries = resolved.filter(
      (row): row is { venue: ScannerVenue; market: MarketMetadata; fetched: FetchedBook } =>
        Boolean(row.fetched && row.fetched.valid),
    );
    if (entries.length < 2) return;
    const prepared = entries.map((entry) => ({
      ...entry,
      evalMarket: canonicalMarketForEvaluation(entry.market),
      evalBook: normalizeBookForMarket(entry.fetched.book, entry.market),
    }));
    const baseKey = `${quote}|${base}`;
    const bookFingerprint = entries
      .map(
        (entry) =>
          `${entry.venue.adapter.venueId}|${entry.market.exchangeSymbol}|${
            entry.fetched.book.sequence ??
            entry.fetched.book.receivedAt ??
            entry.fetched.book.fetchedAt
          }`,
      )
      .sort()
      .join(';');
    if (
      this.#incrementalEvaluation &&
      this.#baseFingerprints.get(baseKey) === bookFingerprint &&
      this.#baseHadValid.get(baseKey) !== true
    ) {
      summary.skippedUnchanged += 1;
      return;
    }
    this.#baseFingerprints.set(baseKey, bookFingerprint);
    this.#baseHadValid.set(baseKey, false);
    const evaluatedAt = this.#clock();
    const health = this.healthMap(evaluatedAt);
    const reliability = this.reliabilityMap(evaluatedAt);
    const referenceMidPrice = medianDecimal(
      prepared.flatMap((entry) => {
        const mid = bookMid(entry.evalBook);
        return mid ? [mid] : [];
      }),
    );
    for (let i = 0; i < prepared.length; i += 1) {
      for (let j = i + 1; j < prepared.length; j += 1) {
        const first = prepared[i]!;
        const second = prepared[j]!;
        if (
          !marketsShareUnderlying(
            first.market,
            first.fetched.book,
            second.market,
            second.fetched.book,
          )
        ) {
          summary.aliasMismatches += 1;
          continue;
        }
        const directions: Array<{
          input: Omit<S1EvaluationInput, 'requestedNotional'>;
          sourceBuyMarket: MarketMetadata;
          sourceSellMarket: MarketMetadata;
        }> = [
          {
            input: {
              base,
              quote,
              buyMarket: first.evalMarket,
              sellMarket: second.evalMarket,
              buyBook: first.evalBook,
              sellBook: second.evalBook,
              settings: this.#settings,
              now: evaluatedAt,
              venueHealth: health,
              venueReliability: reliability,
              ...(referenceMidPrice ? { referenceMidPrice } : {}),
            },
            sourceBuyMarket: first.market,
            sourceSellMarket: second.market,
          },
          {
            input: {
              base,
              quote,
              buyMarket: second.evalMarket,
              sellMarket: first.evalMarket,
              buyBook: second.evalBook,
              sellBook: first.evalBook,
              settings: this.#settings,
              now: evaluatedAt,
              venueHealth: health,
              venueReliability: reliability,
              ...(referenceMidPrice ? { referenceMidPrice } : {}),
            },
            sourceBuyMarket: second.market,
            sourceSellMarket: first.market,
          },
        ];
        for (const { input, sourceBuyMarket, sourceSellMarket } of directions) {
          if (!this.passesPrefilter(input)) {
            summary.prefiltered += 1;
            continue;
          }
          const estimate = estimateS1Return(
            input.buyBook,
            input.sellBook,
            input.buyMarket,
            input.sellMarket,
          );
          const buyPrice = input.buyBook.asks[0]?.price;
          const cap = this.balanceCap(
            balances,
            input.buyMarket.venueId,
            input.sellMarket.venueId,
            sourceSellMarket,
            input.quote,
            buyPrice,
          );
          const monitorOnlyRoute =
            this.#monitorOnlyVenues.has(input.buyMarket.venueId) ||
            this.#monitorOnlyVenues.has(input.sellMarket.venueId);
          const cappedNotional = monitorOnlyRoute
            ? this.#requestedNotional
            : cap.maxNotional
              ? Decimal.min(this.#requestedNotional, cap.maxNotional)
              : this.#requestedNotional;
          const insufficientBalance =
            !monitorOnlyRoute &&
            ((cap.missing && this.#requireBalancesForS1) ||
              (cap.maxNotional !== undefined && cappedNotional.lt(this.#minSizingNotional)));
          const effectiveNotional = cappedNotional.gt(0) ? cappedNotional : this.#minSizingNotional;
          const sizedNotional = Decimal.min(
            effectiveNotional,
            depthBoundNotional(
              input.buyBook,
              input.sellBook,
              this.#settings.liquidityTopLevels ?? 5,
              this.#liquidityMultiple,
            ),
          );
          const depthTooThin = sizedNotional.lt(this.#minSizingNotional);
          const opportunity =
            !insufficientBalance && !depthTooThin && this.shouldOptimize(estimate)
              ? evaluateS1DirectionOptimal({
                  ...input,
                  maxNotional: sizedNotional,
                  minNotional: this.#minSizingNotional,
                  step: this.#sizingStep,
                  samples: this.#sizingSamples,
                })
              : evaluateS1Direction({
                  ...input,
                  requestedNotional: depthTooThin ? this.#minSizingNotional : sizedNotional,
                });
          if (depthTooThin) {
            opportunity.valid = false;
            opportunity.rejectionReasons = [
              ...new Set([...opportunity.rejectionReasons, 'insufficient_depth' as const]),
            ];
          }
          opportunity.metadata = {
            ...(opportunity.metadata ?? {}),
            ...(monitorOnlyRoute ? { monitorOnly: 'true', balanceCapIgnored: 'true' } : {}),
            ...(cap.missing ? { balanceIncomplete: 'true' } : {}),
            depthCapNotional: sizedNotional.toFixed(),
            liquidityMultiple: this.#liquidityMultiple.toFixed(),
            ...(opportunity.buyDepth
              ? {
                  buyDepthLevels: String(opportunity.buyDepth.levelsConsumed),
                  buyDepthWorstPrice: opportunity.buyDepth.worstPrice.toFixed(),
                }
              : {}),
            ...(opportunity.sellDepth
              ? {
                  sellDepthLevels: String(opportunity.sellDepth.levelsConsumed),
                  sellDepthWorstPrice: opportunity.sellDepth.worstPrice.toFixed(),
                }
              : {}),
          };
          opportunity.metadata = {
            ...(opportunity.metadata ?? {}),
            buyFeeProvenance: input.buyMarket.feeProvenance ?? 'default',
            sellFeeProvenance: input.sellMarket.feeProvenance ?? 'default',
            buyExchangeBase: marketExchangeBase(sourceBuyMarket),
            sellExchangeBase: marketExchangeBase(sourceSellMarket),
            buyBaseMultiplier: marketBaseMultiplier(sourceBuyMarket).toFixed(),
            sellBaseMultiplier: marketBaseMultiplier(sourceSellMarket).toFixed(),
          };
          if (!monitorOnlyRoute && cap.maxNotional !== undefined) {
            opportunity.metadata = {
              ...(opportunity.metadata ?? {}),
              balanceLimited: String(cap.limited),
              maxExecutableNotional: cap.maxNotional.toFixed(),
            };
          }
          if (insufficientBalance) {
            opportunity.valid = false;
            opportunity.rejectionReasons = [
              ...new Set([...opportunity.rejectionReasons, 'insufficient_balance' as const]),
            ];
          }
          const gateDecision = this.#entryGate.observe(
            `${opportunity.instrumentKey}|${opportunity.venueBuy}->${opportunity.venueSell}`,
            opportunity.netProfitBps,
            evaluatedAt,
          );
          if (opportunity.valid && !gateDecision.allow) {
            opportunity.valid = false;
            opportunity.rejectionReasons = [
              ...new Set([...opportunity.rejectionReasons, 'below_percentile_gate' as const]),
            ];
          }
          if (gateDecision.thresholdBps !== undefined) {
            opportunity.metadata = {
              ...(opportunity.metadata ?? {}),
              percentileThresholdBps: gateDecision.thresholdBps.toFixed(),
              entryGateSamples: String(gateDecision.sampleCount),
            };
          }
          let duplicateRoute = false;
          if (opportunity.valid) {
            const routeKey = `${opportunity.instrumentKey}|${opportunity.venueBuy}->${opportunity.venueSell}`;
            const lastValidAt = this.#routeLastValidAt.get(routeKey) ?? 0;
            duplicateRoute =
              this.#routeCooldownMs > 0 && evaluatedAt - lastValidAt < this.#routeCooldownMs;
            if (duplicateRoute) {
              opportunity.metadata = {
                ...(opportunity.metadata ?? {}),
                duplicateRoute: 'true',
              };
            } else {
              this.#routeLastValidAt.set(routeKey, evaluatedAt);
            }
          }
          const stored = this.record(opportunity, summary);
          summary.s1Count += 1;
          if (opportunity.valid && this.#persistSnapshots) {
            this.persistSnapshot(
              first.venue.adapter.venueId,
              first.market,
              first.fetched.book,
              persisted,
            );
            this.persistSnapshot(
              second.venue.adapter.venueId,
              second.market,
              second.fetched.book,
              persisted,
            );
          }
          const nearMiss =
            opportunity.netProfitBps.gte(
              this.#settings.minNetProfitBps.minus(this.#hotNearMissBps),
            ) && opportunity.netProfitBps.gt(0);
          if (opportunity.valid) this.#baseHadValid.set(baseKey, true);
          if ((opportunity.valid || nearMiss) && !duplicateRoute) {
            if (!opportunity.valid) {
              opportunity.metadata = {
                ...(opportunity.metadata ?? {}),
                nearMiss: 'true',
              };
            }
            this.promoteHot(first.venue, first.market, evaluatedAt);
            this.promoteHot(second.venue, second.market, evaluatedAt);
          }
          if (opportunity.valid && this.#paperSimulation && !duplicateRoute && !monitorOnlyRoute) {
            const buyEntry = opportunity.venueBuy === first.venue.adapter.venueId ? first : second;
            const sellEntry =
              opportunity.venueSell === first.venue.adapter.venueId ? first : second;
            await this.simulateS1Paper(
              stored,
              opportunity,
              buyEntry,
              sellEntry,
              health[opportunity.venueBuy] ?? 'D',
              health[opportunity.venueSell] ?? 'D',
            );
          }
        }
      }
    }
  }

  /**
   * Event-driven S1 path: drain the books that changed since the last call and
   * evaluate only their base/quote groups. The periodic `scanOnce` pass remains
   * responsible for universe refresh, S2/S3 and REST-only fallbacks.
   */
  async scanUpdates(
    options: { maxWaitMs?: number; debounceMs?: number } = {},
  ): Promise<ScanSummary | undefined> {
    if (this.#feedMode !== 'websocket' || this.#closed) return undefined;
    const maxWaitMs = Math.max(0, options.maxWaitMs ?? 0);
    if (this.#dirtyBooks.size === 0 && maxWaitMs > 0) {
      await this.waitForBookUpdate(maxWaitMs);
    }
    if (this.#dirtyBooks.size === 0) return undefined;

    const debounceMs = Math.max(0, options.debounceMs ?? this.#hotScanDebounceMs);
    if (debounceMs > 0) await sleep(debounceMs);

    const dirty = new Set(this.#dirtyBooks);
    this.#dirtyBooks.clear();
    const groups = new Map<string, { quote: string; base: string }>();
    const groupKeys = new Map<string, string[]>();
    for (const key of dirty) {
      const market = this.#marketIndex.get(key);
      if (!market) continue;
      const groupKey = `${market.quote}|${market.base}`;
      groups.set(groupKey, { quote: market.quote, base: market.base });
      const keys = groupKeys.get(groupKey) ?? [];
      keys.push(key);
      groupKeys.set(groupKey, keys);
    }

    const summary: ScanSummary = {
      scannedAt: this.#clock(),
      booksFetched: 0,
      validOpportunities: 0,
      rejectedOpportunities: 0,
      errors: 0,
      s1Count: 0,
      s2Count: 0,
      s2Candidates: 0,
      s2Evaluated: 0,
      s2CrossVenueCount: 0,
      crossVenueCandidates: 0,
      crossVenueEvaluated: 0,
      sizingCandidates: 0,
      prefiltered: 0,
      skippedUnchanged: 0,
      dirtyBooks: dirty.size,
      dirtyGroups: groups.size,
      deferredGroups: 0,
      aliasMismatches: 0,
    };
    if (groups.size === 0) return summary;

    this.#bookCache = new Map();
    this.#scanErrors = 0;
    this.#sizingCandidates = 0;
    const persisted = new Set<string>();
    const balances = this.#repository.latestBalances({
      maxAgeMs: this.#balanceMaxAgeMs,
      now: summary.scannedAt,
    });
    const groupEntries = [...groups.entries()];
    const startedAt = Date.now();
    for (let index = 0; index < groupEntries.length; index += 1) {
      if (
        index > 0 &&
        this.#hotScanBudgetMs > 0 &&
        Date.now() - startedAt >= this.#hotScanBudgetMs
      ) {
        for (let rest = index; rest < groupEntries.length; rest += 1) {
          for (const key of groupKeys.get(groupEntries[rest]![0]) ?? []) {
            this.#dirtyBooks.add(key);
          }
        }
        summary.deferredGroups = groupEntries.length - index;
        break;
      }
      const [baseKey, group] = groupEntries[index]!;
      const refs = (this.#pairIndex.get(baseKey) ?? []).filter((ref) =>
        this.#bookStore?.isFresh(
          ref.venue.adapter.venueId,
          ref.market.exchangeSymbol,
          summary.scannedAt,
        ),
      );
      if (refs.length < 2) continue;
      await this.evaluateS1Group({
        quote: group.quote,
        base: group.base,
        refs,
        summary,
        persisted,
        balances,
        allowRestFallback: false,
      });
    }
    const closeAt = this.#clock();
    if (closeAt - this.#lastEpisodeCloseAt >= 1000) {
      this.#lastEpisodeCloseAt = closeAt;
      this.#repository.closeStaleEpisodes(closeAt, this.#episodeGapMs);
    }
    summary.errors = this.#scanErrors;
    summary.sizingCandidates = this.#sizingCandidates;
    if (this.#subscriptionsDirty) {
      const now = this.#clock();
      if (now - this.#lastSubscriptionSyncAt >= this.#hotSubscriptionRefreshMs) {
        this.#subscriptionsDirty = false;
        this.#lastSubscriptionSyncAt = now;
        this.syncSubscriptions();
      }
    }
    return summary;
  }

  private onBookUpdate(book: OrderBookSnapshot): void {
    const key = `${book.venueId}|${book.exchangeSymbol}`;
    const levels = Math.max(1, this.#hotDepthLevels);
    const side = (rows: OrderBookSnapshot['bids']): string =>
      rows
        .slice(0, levels)
        .map((level) => `${level.price.toFixed()}|${level.amount.toFixed()}`)
        .join(';');
    const bbo = `${side(book.bids)}#${side(book.asks)}`;
    if (this.#lastBbo.get(key) === bbo) return;
    this.#lastBbo.set(key, bbo);
    if (this.#dirtyBooks.size < 20_000) this.#dirtyBooks.add(key);
    const waiters = this.#hotWaiters;
    this.#hotWaiters = [];
    for (const wake of waiters) wake();
  }

  private waitForBookUpdate(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      this.#hotWaiters.push(finish);
    });
  }

  private rebuildIndexes(): void {
    this.#marketIndex.clear();
    this.#pairIndex.clear();
    for (const venue of this.#venues) {
      for (const market of venue.markets) {
        this.#marketIndex.set(`${venue.adapter.venueId}|${market.exchangeSymbol}`, market);
        const canonicalKey = `${venue.adapter.venueId}|${market.base}/${market.quote}`;
        const existing = this.#marketIndex.get(canonicalKey);
        if (
          !existing ||
          (marketBaseMultiplier(existing).gt(1) && marketBaseMultiplier(market).eq(1))
        ) {
          this.#marketIndex.set(canonicalKey, market);
        }
        const exchangeBase = marketExchangeBase(market);
        if (exchangeBase !== market.base) {
          this.#marketIndex.set(`${venue.adapter.venueId}|${exchangeBase}/${market.quote}`, market);
        }
      }
      const entries = this.#universe.get(venue.adapter.venueId) ?? [];
      for (const entry of entries) {
        const market = this.findMarket(venue, entry.base, entry.quote, entry.exchangeSymbol);
        if (!market) continue;
        const key = `${entry.quote}|${entry.base}`;
        const rows = this.#pairIndex.get(key) ?? [];
        if (
          rows.some(
            (row) =>
              row.venue.adapter.venueId === venue.adapter.venueId &&
              row.market.exchangeSymbol === market.exchangeSymbol,
          )
        ) {
          continue;
        }
        rows.push({ venue, market });
        this.#pairIndex.set(key, rows);
      }
    }
  }

  private shouldOptimize(estimate: Decimal): boolean {
    if (!this.#optimalSizing) return false;
    if (!estimate.isFinite() || estimate.lte(0)) return false;
    if (this.#sizingCandidates >= this.#maxSizingCandidatesPerCycle) return false;
    this.#sizingCandidates += 1;
    return true;
  }

  private passesPrefilter(input: Omit<S1EvaluationInput, 'requestedNotional'>): boolean {
    if (!this.#prefilterEnabled) return true;
    const buyTop = input.buyBook.asks[0]?.price;
    const sellTop = input.sellBook.bids[0]?.price;
    if (!buyTop || !sellTop || !buyTop.gt(0)) return true;
    const grossBps = sellTop.minus(buyTop).div(buyTop).toNumber() * 10_000;
    const mode = this.#settings.executionMode ?? 'taker_taker';
    const buyFee =
      mode === 'maker_buy_taker_sell' ? input.buyMarket.makerFeeBps : input.buyMarket.feeTakerBps;
    const sellFee =
      mode === 'taker_buy_maker_sell' ? input.sellMarket.makerFeeBps : input.sellMarket.feeTakerBps;
    if (!buyFee || !sellFee) return true;
    const feeBps = buyFee.toNumber() + sellFee.toNumber();
    return grossBps - feeBps >= this.#prefilterFloorBps;
  }

  private reliabilityMap(now: number): Record<string, Decimal> {
    const map: Record<string, Decimal> = {};
    for (const venue of this.#venues) {
      const snapshot = venue.health.snapshot(now);
      if ((snapshot.feedSamples ?? 0) >= 5) {
        map[venue.adapter.venueId] = new Decimal(String(snapshot.reliabilityScore));
      }
    }
    return map;
  }

  private balanceCap(
    balances: ReadonlyArray<{ venueId: string; currency: string; free: Decimal }>,
    buyVenueId: string,
    sellVenueId: string,
    sellMarket: MarketMetadata,
    quote: string,
    buyPrice: Decimal | undefined,
  ): { maxNotional?: Decimal; missing: boolean; limited: boolean } {
    const findFree = (venueId: string, currency: string): Decimal | undefined => {
      const target = currency.trim().toUpperCase();
      return balances.find(
        (balance) =>
          balance.venueId === venueId && balance.currency.trim().toUpperCase() === target,
      )?.free;
    };
    const quoteFree = findFree(buyVenueId, quote);
    const baseFree = findFree(sellVenueId, marketExchangeBase(sellMarket));
    if (quoteFree === undefined || baseFree === undefined || !buyPrice || !buyPrice.gt(0)) {
      return { missing: true, limited: false };
    }
    const baseFreeCanonical = baseFree.mul(marketBaseMultiplier(sellMarket));
    const maxNotional = Decimal.min(quoteFree, baseFreeCanonical.mul(buyPrice));
    return {
      maxNotional,
      missing: false,
      limited: maxNotional.lt(this.#requestedNotional),
    };
  }

  private async scanCrossVenue(
    active: Map<string, MarketUniverseEntry[]>,
    now: number,
    summary: ScanSummary,
    persisted: Set<string>,
  ): Promise<void> {
    const balances = this.#repository.latestBalances({
      maxAgeMs: this.#balanceMaxAgeMs,
      now,
    });
    if (balances.length === 0) return;

    const markets: Array<{
      venueId: string;
      market: MarketMetadata;
      book: OrderBookSnapshot;
    }> = [];
    for (const venue of this.#venues) {
      const entries = active.get(venue.adapter.venueId) ?? [];
      if (entries.length === 0) continue;
      for (const entry of entries) {
        const market = this.findMarket(venue, entry.base, entry.quote, entry.exchangeSymbol);
        if (!market) continue;
        if (!marketBaseMultiplier(market).eq(1)) continue;
        const fetched = await this.getBook(venue, market.exchangeSymbol);
        if (!fetched || !fetched.valid) continue;
        markets.push({ venueId: venue.adapter.venueId, market, book: fetched.book });
      }
    }
    if (markets.length === 0) return;

    const graph = buildCrossVenueGraph({
      markets,
      balances: balances.map((balance) => ({
        venueId: balance.venueId,
        currency: balance.currency,
        free: balance.free,
      })),
    });

    const availabilityByCurrency = new Map<string, Map<string, Decimal>>();
    for (const balance of balances) {
      const currency = balance.currency.trim().toUpperCase();
      const byVenue = availabilityByCurrency.get(currency) ?? new Map<string, Decimal>();
      byVenue.set(balance.venueId, (byVenue.get(balance.venueId) ?? ZERO).plus(balance.free));
      availabilityByCurrency.set(currency, byVenue);
    }

    const health = this.healthMap(now);
    for (const quote of this.#quoteCurrencies) {
      const availability = availabilityByCurrency.get(quote.trim().toUpperCase());
      if (!availability) continue;
      const startVenues = [...availability.entries()]
        .filter(([, free]) => free.gte(this.#requestedNotional))
        .map(([venueId]) => venueId);
      if (startVenues.length === 0) continue;

      const candidates = enumerateCrossVenuePaths(graph, {
        startCurrency: quote,
        startVenues,
        startAvailableByVenue: availability,
        maxHops: this.#maxHops,
        maxVenueSwitches: this.#maxVenueSwitches,
        maxLegsPerNode: this.#maxLegsPerCurrency,
        maxPaths: Math.max(500, this.#maxTriangularPaths),
      })
        .filter((path) => path.estimatedReturn.gt(0))
        .sort((left, right) => right.estimatedReturn.comparedTo(left.estimatedReturn))
        .slice(0, this.#maxCandidatesPerCycle);

      summary.crossVenueCandidates += candidates.length;
      summary.crossVenueEvaluated += candidates.length;
      for (const path of candidates) {
        const opportunity = this.shouldOptimize(path.estimatedReturn)
          ? evaluateCrossVenuePathOptimal(
              path,
              this.#requestedNotional,
              this.#settings,
              now,
              health,
              {
                minNotional: this.#minSizingNotional,
                step: this.#sizingStep,
                samples: this.#sizingSamples,
              },
            )
          : evaluateCrossVenuePath(path, this.#requestedNotional, this.#settings, now, health);
        const stored = this.record(opportunity, summary);
        summary.s2CrossVenueCount += 1;
        if (opportunity.valid && this.#persistSnapshots) {
          for (const leg of path.legs) {
            if (leg.kind !== 'trade') continue;
            this.persistSnapshot(leg.market.venueId, leg.market, leg.book, persisted);
          }
        }
        if (opportunity.valid && this.#paperSimulation) {
          persistSimulatedOpportunity(this.#repository, stored, opportunity, quote);
        }
      }
    }
  }

  private dueTiers(now: number): Set<'hot' | 'top100' | 'top500'> {
    const tiers = new Set<'hot' | 'top100' | 'top500'>();
    if (this.#feedMode === 'websocket') {
      // WebSocket books are pushed; hot and top100 symbols can be evaluated on
      // every short cycle without extra REST calls.
      tiers.add('hot');
      tiers.add('top100');
    }
    if (now - this.#lastTierScan.hot >= this.#scanIntervalHotMs) {
      tiers.add('hot');
      this.#lastTierScan.hot = now;
    }
    if (now - this.#lastTierScan.top100 >= this.#scanIntervalTop100Ms) {
      tiers.add('top100');
      this.#lastTierScan.top100 = now;
    }
    if (now - this.#lastTierScan.top500 >= this.#scanIntervalTop500Ms) {
      tiers.add('top500');
      this.#lastTierScan.top500 = now;
    }
    return tiers;
  }

  private activeUniverse(
    dueTiers: Set<'hot' | 'top100' | 'top500'>,
    now: number,
  ): Map<string, MarketUniverseEntry[]> {
    const active = new Map<string, MarketUniverseEntry[]>();
    const websocket = this.#feedMode === 'websocket';
    const rotation = this.#restRotation;
    this.#restRotation += 1;
    for (const venue of this.#venues) {
      const entries = this.#universe.get(venue.adapter.venueId) ?? [];
      const selected: MarketUniverseEntry[] = [];
      const seen = new Set<string>();
      const fallback: MarketUniverseEntry[] = [];
      for (const entry of entries) {
        const hot = (this.#hotUntil.get(`${entry.venueId}|${entry.exchangeSymbol}`) ?? 0) > now;
        if (!dueTiers.has(entry.tier) && entry.tier !== 'hot' && !hot) continue;
        if (seen.has(entry.exchangeSymbol)) continue;
        seen.add(entry.exchangeSymbol);
        if (!websocket) {
          selected.push(entry);
        } else if (this.#subscribedKeys.has(`${entry.venueId}|${entry.exchangeSymbol}`)) {
          selected.push(entry);
        } else {
          fallback.push(entry);
        }
      }
      if (websocket && fallback.length > 0 && this.#wsRestFallbackPerVenue > 0) {
        const limit = Math.min(this.#wsRestFallbackPerVenue, fallback.length);
        for (let index = 0; index < limit; index += 1) {
          selected.push(fallback[(rotation + index) % fallback.length]!);
        }
      }
      active.set(venue.adapter.venueId, selected);
    }
    return active;
  }

  private async refreshUniverse(venue: ScannerVenue): Promise<void> {
    const now = this.#clock();
    const explicit = this.#assetUniverseMode === 'explicit';
    let tickers: TickerSnapshot[] = [];
    if (!explicit && venue.adapter.fetchTickers) {
      try {
        tickers = await venue.adapter.fetchTickers();
      } catch (error) {
        this.#repository.recordRiskEvent(
          'warning',
          'ticker_fetch_failed',
          String(error),
          { venueId: venue.adapter.venueId },
          now,
        );
      }
    }
    const entries = buildMarketUniverse({
      markets: venue.markets,
      tickers,
      quoteCurrencies: this.#quoteCurrencies,
      maxBaseAssets: explicit ? Math.max(1, this.#baseAssets.length) : this.#maxBaseAssets,
      minQuoteVolumeUsd: explicit ? new Decimal(0) : this.#min24hQuoteVolumeUsd,
      ...(explicit ? { explicitBaseAssets: this.#baseAssets } : {}),
      now,
    });
    this.#repository.replaceMarketUniverse(venue.adapter.venueId, entries, now);
    this.#universe.set(venue.adapter.venueId, entries);
  }

  private async prefetchBooks(active: Map<string, MarketUniverseEntry[]>): Promise<void> {
    const requests: Array<{ venue: ScannerVenue; symbol: string }> = [];
    const seen = new Set<string>();
    for (const venue of this.#venues) {
      const entries = active.get(venue.adapter.venueId) ?? [];
      if (entries.length === 0) continue;
      const assets = new Set(entries.map((entry) => entry.base));
      for (const quote of this.#quoteCurrencies) assets.add(quote);
      for (const market of venue.markets) {
        if (!assets.has(market.base) || !assets.has(market.quote)) continue;
        if (!venue.adapter.capabilities.orderBook) continue;
        const key = `${venue.adapter.venueId}|${market.exchangeSymbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push({ venue, symbol: market.exchangeSymbol });
      }
    }
    let index = 0;
    const workers = Array.from(
      { length: Math.min(this.#fetchConcurrency, requests.length) },
      async () => {
        while (true) {
          const current = index;
          index += 1;
          if (current >= requests.length) return;
          const request = requests[current]!;
          await this.getBook(request.venue, request.symbol);
        }
      },
    );
    await Promise.all(workers);
  }

  private promoteHot(venue: ScannerVenue, market: MarketMetadata, now: number): void {
    if (this.#signalCooldownMs <= 0) return;
    const key = `${venue.adapter.venueId}|${market.exchangeSymbol}`;
    if ((this.#hotUntil.get(key) ?? 0) > now) return;
    this.#hotUntil.set(key, now + this.#signalCooldownMs);
    this.#subscriptionsDirty = true;
  }

  /**
   * Seed the hot set from recent route density so a restart does not forget
   * which routes actually paid. Only routes with at least one valid S1 sample
   * in the lookback window are eligible.
   */
  private seedHotFromRoutes(): void {
    if (!this.#hotSeedEnabled || this.#hotSeedTtlMs <= 0 || this.#hotSeedLimit <= 0) return;
    const now = this.#clock();
    let seeded = 0;
    for (const route of this.#repository.s1RouteStats({
      sinceMs: this.#hotSeedLookbackMs,
      limit: this.#hotSeedLimit,
      now,
    })) {
      if (route.validSamples < 1 || now - route.lastSeenAt > this.#hotSeedLookbackMs) continue;
      const [base, quote] = route.instrument.split('/');
      if (!base || !quote) continue;
      for (const venueId of [route.venueBuy, route.venueSell]) {
        const venue = this.#venues.find((candidate) => candidate.adapter.venueId === venueId);
        if (!venue) continue;
        const market = this.findMarket(venue, base, quote);
        if (!market) continue;
        const key = `${venueId}|${market.exchangeSymbol}`;
        const until = Math.max(this.#hotUntil.get(key) ?? 0, now + this.#hotSeedTtlMs);
        this.#hotUntil.set(key, until);
        seeded += 1;
      }
    }
    if (seeded > 0) this.#subscriptionsDirty = true;
  }

  hotSymbols(): string[] {
    const now = this.#clock();
    return [...this.#hotUntil.entries()]
      .filter(([, until]) => until > now)
      .map(([key]) => key)
      .sort();
  }

  private record(opportunity: OpportunityResult, summary: ScanSummary): StoredOpportunity {
    const stored = this.#repository.recordOpportunity(opportunity, this.#episodeGapMs);
    if (opportunity.valid) summary.validOpportunities += 1;
    else summary.rejectedOpportunities += 1;
    return stored;
  }

  private async simulateS1Paper(
    stored: StoredOpportunity,
    opportunity: OpportunityResult,
    buy: { venue: ScannerVenue; market: MarketMetadata; fetched: FetchedBook },
    sell: { venue: ScannerVenue; market: MarketMetadata; fetched: FetchedBook },
    buyHealth: HealthState,
    sellHealth: HealthState,
  ): Promise<void> {
    const riskLimits = defaultPaperRiskLimits(this.#requestedNotional);
    try {
      const paper = new ScriptedPaperGateway({
        leg1: { kind: 'full' },
        leg2: { kind: 'full' },
      });
      const result = await runPaperBatch(opportunity, paper, {
        batchId: `paper-${opportunity.opportunityKey}-${opportunity.sampledAt}-${this.#paperSequence++}`,
        buyMarket: canonicalMarketForEvaluation(buy.market),
        sellMarket: canonicalMarketForEvaluation(sell.market),
        buyBook: normalizeBookForMarket(buy.fetched.book, buy.market),
        sellBook: normalizeBookForMarket(sell.fetched.book, sell.market),
        riskLimits,
        gate: new ExecutionGate(riskLimits),
        now: opportunity.sampledAt,
        health: { buy: buyHealth, sell: sellHealth },
      });
      this.#repository.recordPaperTrade({
        opportunityId: stored.id,
        requestedNotional: opportunity.requestedNotional,
        simulatedBaseAmount: result.filledBaseAmount,
        buyPriceAverage:
          result.leg1Fill?.averagePrice ?? opportunity.buyDepth?.averagePrice ?? ZERO,
        sellPriceAverage:
          result.leg2Fill?.averagePrice ?? opportunity.sellDepth?.averagePrice ?? ZERO,
        ...(opportunity.buyDepth ? { buyPriceWorst: opportunity.buyDepth.worstPrice } : {}),
        ...(opportunity.sellDepth ? { sellPriceWorst: opportunity.sellDepth.worstPrice } : {}),
        fees: result.fees,
        gasCost: ZERO,
        netProfit: result.realizedProfit,
        result: result.closed ? 'CLOSED' : result.state,
        executedAt: opportunity.sampledAt,
        durationMs: stored.episodeId ? this.#repository.episodeDuration(stored.episodeId) : 0,
        expectedFailureReasons: opportunity.rejectionReasons,
        fillQuality: {
          strategy: 'S1',
          closed: result.closed,
          safeMode: result.safeMode,
          ...(result.safeModeReason ? { safeModeReason: result.safeModeReason } : {}),
          ...(result.leg1Fill
            ? {
                leg1: {
                  requestedAmount: result.leg1Fill.requestedAmount.toFixed(),
                  filledAmount: result.leg1Fill.filledAmount.toFixed(),
                  averagePrice: result.leg1Fill.averagePrice.toFixed(),
                  limitPrice: result.leg1Fill.limitPrice.toFixed(),
                  fee: result.leg1Fill.fee.toFixed(),
                  status: result.leg1Fill.status,
                },
              }
            : {}),
          ...(result.leg2Fill
            ? {
                leg2: {
                  requestedAmount: result.leg2Fill.requestedAmount.toFixed(),
                  filledAmount: result.leg2Fill.filledAmount.toFixed(),
                  averagePrice: result.leg2Fill.averagePrice.toFixed(),
                  limitPrice: result.leg2Fill.limitPrice.toFixed(),
                  fee: result.leg2Fill.fee.toFixed(),
                  status: result.leg2Fill.status,
                },
              }
            : {}),
        },
      });
    } catch (error) {
      this.#repository.recordRiskEvent('warning', 'paper_simulation_failed', String(error), {
        opportunityId: stored.id,
        opportunityKey: opportunity.opportunityKey,
      });
    }
  }

  private persistSnapshot(
    venueId: string,
    market: MarketMetadata,
    book: OrderBookSnapshot,
    persisted: Set<string>,
  ): void {
    const key = `${venueId}|${market.exchangeSymbol}|${book.fetchedAt}`;
    if (persisted.has(key)) return;
    persisted.add(key);
    this.#repository.recordOrderbook(book, true);
  }

  private healthMap(now: number): Record<string, HealthState> {
    return Object.fromEntries(
      this.#venues.map((venue) => [venue.adapter.venueId, venue.health.snapshot(now).healthState]),
    );
  }

  private findMarket(
    venue: ScannerVenue,
    base: string,
    quote: string,
    exchangeSymbol?: string,
  ): MarketMetadata | undefined {
    const canonicalBase = base.trim().toUpperCase();
    const canonicalQuote = quote.trim().toUpperCase();
    if (exchangeSymbol) {
      const exact = this.#marketIndex.get(`${venue.adapter.venueId}|${exchangeSymbol}`);
      if (
        exact &&
        exact.base.trim().toUpperCase() === canonicalBase &&
        exact.quote.trim().toUpperCase() === canonicalQuote
      ) {
        return exact;
      }
    }
    return (
      this.#marketIndex.get(`${venue.adapter.venueId}|${canonicalBase}/${canonicalQuote}`) ??
      venue.markets.find(
        (market) =>
          market.base.trim().toUpperCase() === canonicalBase &&
          market.quote.trim().toUpperCase() === canonicalQuote,
      )
    );
  }

  private syncSubscriptions(): void {
    if (!this.#bookStore) return;
    const subscriptions: BookSubscription[] = [];
    const subscribedKeys = new Set<string>();
    // Only a base quoted the same way on at least two venues can produce a
    // cross-venue S1 edge. Subscribing to just those keeps the WebSocket stream
    // set small while still covering every possible S1 pair.
    const venueCountByBase = new Map<string, number>();
    for (const venue of this.#venues) {
      const entries = this.#universe.get(venue.adapter.venueId) ?? [];
      const seen = new Set<string>();
      for (const entry of entries) {
        const key = `${entry.quote}|${entry.base}`;
        if (seen.has(key)) continue;
        seen.add(key);
        venueCountByBase.set(key, (venueCountByBase.get(key) ?? 0) + 1);
      }
    }
    const perVenue = Math.max(2, Math.ceil(this.#wsMaxSubscriptions / this.#venues.length));
    const orderedVenues = [...this.#venues].sort(
      (left, right) => tierRank(left.adapter.tier) - tierRank(right.adapter.tier),
    );
    const now = this.#clock();
    const isHot = (venue: ScannerVenue, entry: MarketUniverseEntry): boolean =>
      (this.#hotUntil.get(`${venue.adapter.venueId}|${entry.exchangeSymbol}`) ?? 0) > now;
    for (const venue of orderedVenues) {
      const entries = this.#universe.get(venue.adapter.venueId) ?? [];
      const candidates = entries
        .filter((entry) => entry.tier !== 'top500' || isHot(venue, entry))
        .filter((entry) => (venueCountByBase.get(`${entry.quote}|${entry.base}`) ?? 0) >= 2)
        .sort((left, right) => {
          const leftHot = isHot(venue, left);
          const rightHot = isHot(venue, right);
          if (leftHot !== rightHot) return leftHot ? -1 : 1;
          const leftVolume = left.quoteVolume24h;
          const rightVolume = right.quoteVolume24h;
          if (leftVolume && rightVolume) return rightVolume.comparedTo(leftVolume);
          if (leftVolume) return -1;
          if (rightVolume) return 1;
          return left.base.localeCompare(right.base);
        });
      let subscribed = 0;
      for (const entry of candidates) {
        if (subscriptions.length >= this.#wsMaxSubscriptions) break;
        const hot = isHot(venue, entry);
        if (subscribed >= perVenue && !hot) break;
        const market = this.findMarket(venue, entry.base, entry.quote);
        if (!market) continue;
        const key = `${venue.adapter.venueId}|${market.exchangeSymbol}`;
        if (subscribedKeys.has(key)) continue;
        subscribedKeys.add(key);
        subscriptions.push({
          venueId: venue.adapter.venueId,
          adapter: venue.adapter,
          symbol: market.exchangeSymbol,
        });
        subscribed += 1;
      }
    }
    this.#subscribedKeys = subscribedKeys;
    this.#bookStore.setSubscriptions(subscriptions);
  }

  private async runBookSanityChecks(active: Map<string, MarketUniverseEntry[]>): Promise<void> {
    if (!this.#bookSanity.enabled || !this.#bookStore) return;
    const now = this.#clock();
    const candidates: Array<{ venue: ScannerVenue; symbol: string; key: string }> = [];
    for (const venue of this.#venues) {
      for (const entry of active.get(venue.adapter.venueId) ?? []) {
        const key = `${venue.adapter.venueId}|${entry.exchangeSymbol}`;
        if (!this.#bookSanity.due(key, now)) continue;
        if (!this.#bookStore.get(venue.adapter.venueId, entry.exchangeSymbol)) continue;
        candidates.push({ venue, symbol: entry.exchangeSymbol, key });
      }
    }
    if (candidates.length === 0) return;
    const count = Math.min(this.#bookSanitySampleSize, candidates.length);
    const sample: typeof candidates = [];
    for (let index = 0; index < count; index += 1) {
      sample.push(candidates[(this.#bookSanityCursor + index) % candidates.length]!);
    }
    this.#bookSanityCursor = (this.#bookSanityCursor + count) % candidates.length;
    await Promise.all(
      sample.map(async (candidate) => {
        const ws = this.#bookStore?.get(candidate.venue.adapter.venueId, candidate.symbol);
        if (!ws) return;
        try {
          const rest = await withTimeout(
            candidate.venue.adapter.fetchOrderBook(candidate.symbol, this.#orderBookDepth),
            5_000,
            'book_sanity',
          );
          const checkedAt = this.#clock();
          const deviation = bookDeviationBps(ws, rest);
          if (!deviation) {
            this.#bookSanity.failure(candidate.key, 'missing_book', checkedAt);
            return;
          }
          if (deviation.maxBps.gt(this.#bookSanity.maxDeviationBps)) {
            const reason = `deviation_${deviation.maxBps.toFixed(1)}bps`;
            this.#bookSanity.failure(candidate.key, reason, checkedAt);
            this.#repository.recordRiskEvent(
              'warning',
              'book_sanity_failure',
              reason,
              { venueId: candidate.venue.adapter.venueId, symbol: candidate.symbol },
              checkedAt,
            );
            return;
          }
          const wasBlocked = this.#bookSanity.isBlocked(candidate.key);
          this.#bookSanity.success(candidate.key, checkedAt);
          if (wasBlocked && !this.#bookSanity.isBlocked(candidate.key)) {
            this.#repository.recordRiskEvent(
              'info',
              'book_sanity_recovered',
              'ws/rest books agree again',
              { venueId: candidate.venue.adapter.venueId, symbol: candidate.symbol },
              checkedAt,
            );
          }
        } catch (error) {
          this.#bookSanity.failure(
            candidate.key,
            `rest_error:${String(error).slice(0, 80)}`,
            this.#clock(),
          );
        }
      }),
    );
  }

  private async getBook(
    venue: ScannerVenue,
    symbol: string,
    options: { restFallback?: boolean } = {},
  ): Promise<FetchedBook | undefined> {
    const key = `${venue.adapter.venueId}|${symbol}`;
    if (this.#bookSanity.isBlocked(key)) {
      const blocked: FetchedBook = {
        book: {
          venueId: venue.adapter.venueId,
          exchangeSymbol: symbol,
          fetchedAt: this.#clock(),
          asks: [],
          bids: [],
          source: 'rest',
        },
        valid: false,
        reasons: ['book_sanity_blocked'],
      };
      this.#bookCache.set(key, blocked);
      return blocked;
    }
    const cached = this.#bookCache.get(key);
    if (cached) return cached;
    if (!venue.adapter.capabilities.orderBook) return undefined;
    const streamed = this.#bookStore?.get(venue.adapter.venueId, symbol);
    if (streamed && this.#bookStore?.isFresh(venue.adapter.venueId, symbol, this.#clock())) {
      venue.health.recordSuccess(0, this.#clock());
      return this.acceptBook(venue, symbol, streamed, key);
    }
    if (options.restFallback === false) return undefined;
    const started = Date.now();
    try {
      const book = await venue.adapter.fetchOrderBook(symbol, this.#orderBookDepth);
      venue.health.recordSuccess(Date.now() - started, this.#clock());
      return this.acceptBook(venue, symbol, book, key);
    } catch (error) {
      this.#scanErrors += 1;
      venue.health.recordFailure(
        Date.now() - started,
        this.#clock(),
        /rate|429|418/i.test(String(error)),
      );
      this.#bookCache.set(key, {
        book: {
          venueId: venue.adapter.venueId,
          exchangeSymbol: symbol,
          fetchedAt: this.#clock(),
          asks: [],
          bids: [],
          source: 'rest',
        },
        valid: false,
        reasons: ['fetch_failed'],
      });
      return undefined;
    }
  }

  private acceptBook(
    venue: ScannerVenue,
    symbol: string,
    book: OrderBookSnapshot,
    key: string,
  ): FetchedBook {
    const observedAt = this.#clock();
    const validation = validateOrderBook(book, {
      expectedVenueId: venue.adapter.venueId,
      expectedSymbol: symbol,
      maxAgeMs: this.#settings.maxOrderbookAgeMs,
      now: observedAt,
      maxFeedLatencyMs: this.#maxFeedLatencyMs,
      maxFreezeMs: this.#maxFreezeMs,
    });
    const feedLatency = bookFeedLatencyMs(book) ?? 0;
    venue.health.recordFeedQuality({
      at: observedAt,
      latencyMs: feedLatency,
      crossed: !validation.valid && validation.reasons.includes('crossed_orderbook'),
      stale:
        !validation.valid &&
        (validation.reasons.includes('stale_orderbook') ||
          validation.reasons.includes('frozen_orderbook')),
      sequenceGap: !validation.valid && validation.reasons.includes('sequence_gap'),
    });
    if (!validation.valid) {
      if (validation.reasons.includes('stale_orderbook')) venue.health.recordStale(observedAt);
      this.#repository.recordRiskEvent(
        'warning',
        'invalid_orderbook',
        validation.reasons.join(','),
        { venueId: venue.adapter.venueId, symbol },
        observedAt,
      );
      this.#scanErrors += 1;
      const result: FetchedBook = { book, valid: false, reasons: validation.reasons };
      this.#bookCache.set(key, result);
      return result;
    }
    const result: FetchedBook = { book: validation.book, valid: true, reasons: [] };
    this.#bookCache.set(key, result);
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const waiters = this.#hotWaiters;
    this.#hotWaiters = [];
    for (const wake of waiters) wake();
    this.#bookStore?.close();
    this.#feedRecorder?.close();
    for (const venue of this.#venues) {
      try {
        await venue.adapter.close?.();
      } catch {
        // ignore shutdown errors
      }
    }
  }
}
