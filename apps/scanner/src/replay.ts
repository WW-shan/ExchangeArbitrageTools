import {
  Decimal,
  VenueHealthTracker,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
  type VenueTier,
} from '@arb/core';
import type { ArbitrageRepository, EpisodeSummary, OpportunityDecaySummary } from '@arb/storage';
import type { CexAdapter, VenueCapabilities } from '@arb/venues-cex';
import { ScannerService, type ScannerVenue } from './scanner-service.js';

export interface ReplayMarket {
  venueId: string;
  exchangeSymbol: string;
  unifiedSymbol: string;
  base: string;
  quote: string;
  active: boolean;
  pricePrecision: number;
  amountPrecision: number;
  amountStep: string;
  priceStep?: string;
  minAmount?: string;
  minNotional?: string;
  feeTakerBps?: string;
  makerFeeBps?: string;
  supportsIoc?: boolean;
  supportsFok?: boolean;
}

export interface ReplayBook {
  venueId: string;
  exchangeSymbol: string;
  fetchedAt: number;
  receivedAt?: number;
  exchangeTimestamp?: number;
  sequence?: number;
  asks: Array<[string, string]>;
  bids: Array<[string, string]>;
  source?: 'rest' | 'websocket' | 'replay';
}

export interface ReplayFixture {
  name?: string;
  kind?: string;
  base?: string;
  quote?: string;
  requestedNotional: string;
  settings: Record<string, string | number>;
  markets: Record<string, ReplayMarket> | ReplayMarket[];
  samples: Array<Record<string, unknown>>;
  balances?: Array<{ venueId: string; currency: string; free: string }>;
}

export interface ReplayOptions {
  repository: ArbitrageRepository;
  paperSimulation?: boolean;
  optimalSizing?: boolean;
  minSizingNotional?: Decimal;
  sizingStep?: Decimal;
  maxSizingCandidatesPerCycle?: number;
  sizingSamples?: number;
  crossVenueMode?: 'off' | 'inventory';
  episodeGapMs?: number;
}

export interface ReplayReport {
  name: string;
  samples: number;
  scanned: number;
  errors: number;
  validOpportunities: number;
  rejectedOpportunities: number;
  opportunitiesByStrategy: Array<{ strategy: string; total: number; valid: number }>;
  episodes: EpisodeSummary[];
  decay: OpportunityDecaySummary[];
  paperTrades: unknown;
  feedLatency: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
  rawEdgeFrames: number;
  netOpportunityFrames: number;
  falsePositiveRate: number;
  firstSampleAt: number;
  lastSampleAt: number;
  durationMs: number;
}

export class ReplayCexAdapter implements CexAdapter {
  readonly capabilities: VenueCapabilities = {
    publicMarketData: true,
    orderBook: true,
    privateBalances: false,
    createOrder: false,
    fetchOrder: false,
    cancelOrder: false,
    websocket: false,
    ioc: true,
    fok: false,
  };
  readonly #markets: MarketMetadata[];
  #books = new Map<string, OrderBookSnapshot>();

  constructor(
    readonly venueId: string,
    readonly tier: VenueTier,
    markets: MarketMetadata[],
  ) {
    this.#markets = markets;
  }

  setBooks(books: OrderBookSnapshot[]): void {
    this.#books = new Map(books.map((book) => [book.exchangeSymbol, book]));
  }

  async loadMarkets(): Promise<MarketMetadata[]> {
    return this.#markets;
  }

  async fetchOrderBook(symbol: string, _depth: number): Promise<OrderBookSnapshot> {
    const book = this.#books.get(symbol);
    if (!book) {
      throw new Error(
        `replay book missing for ${this.venueId} ${symbol}; have ${[...this.#books.keys()].join(',')}`,
      );
    }
    return book;
  }
}

function toMarket(value: ReplayMarket): MarketMetadata {
  return {
    venueId: value.venueId,
    exchangeSymbol: value.exchangeSymbol,
    unifiedSymbol: value.unifiedSymbol,
    base: value.base,
    quote: value.quote,
    active: value.active,
    pricePrecision: value.pricePrecision,
    amountPrecision: value.amountPrecision,
    amountStep: new Decimal(value.amountStep),
    ...(value.priceStep ? { priceStep: new Decimal(value.priceStep) } : {}),
    ...(value.minAmount ? { minAmount: new Decimal(value.minAmount) } : {}),
    ...(value.minNotional ? { minNotional: new Decimal(value.minNotional) } : {}),
    ...(value.feeTakerBps ? { feeTakerBps: new Decimal(value.feeTakerBps) } : {}),
    ...(value.makerFeeBps ? { makerFeeBps: new Decimal(value.makerFeeBps) } : {}),
    supportsIoc: value.supportsIoc ?? true,
    supportsFok: value.supportsFok ?? false,
  };
}

function toSnapshot(value: ReplayBook): OrderBookSnapshot {
  return {
    venueId: value.venueId,
    exchangeSymbol: value.exchangeSymbol,
    fetchedAt: value.fetchedAt,
    receivedAt: value.receivedAt ?? value.fetchedAt,
    ...(value.exchangeTimestamp ? { exchangeTimestamp: value.exchangeTimestamp } : {}),
    ...(value.sequence !== undefined ? { sequence: value.sequence } : {}),
    asks: value.asks.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    bids: value.bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: value.source ?? 'replay',
  };
}

function normalizeMarkets(fixture: ReplayFixture): ReplayMarket[] {
  return Array.isArray(fixture.markets) ? fixture.markets : Object.values(fixture.markets);
}

function sampleBooks(sample: Record<string, unknown>, venueId: string): ReplayBook[] {
  const value = sample[venueId];
  if (!value) return [];
  return Array.isArray(value) ? (value as ReplayBook[]) : [value as ReplayBook];
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function summarizeLatency(values: readonly number[]): {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
} {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : 0,
  };
}

function hasRawEdge(sample: Record<string, unknown>, markets: readonly MarketMetadata[]): boolean {
  const byVenue = new Map<string, OrderBookSnapshot>();
  for (const market of markets) {
    const book = sampleBooks(sample, market.venueId)
      .map(toSnapshot)
      .find((candidate) => candidate.exchangeSymbol === market.exchangeSymbol);
    if (book) byVenue.set(market.venueId, book);
  }
  const venues = [...byVenue.keys()];
  for (const buyVenue of venues) {
    for (const sellVenue of venues) {
      if (buyVenue === sellVenue) continue;
      const buyMarket = markets.find((market) => market.venueId === buyVenue);
      const sellMarket = markets.find((market) => market.venueId === sellVenue);
      if (!buyMarket || !sellMarket) continue;
      if (buyMarket.base !== sellMarket.base || buyMarket.quote !== sellMarket.quote) continue;
      const ask = byVenue.get(buyVenue)?.asks[0]?.price;
      const bid = byVenue.get(sellVenue)?.bids[0]?.price;
      if (ask && bid && bid.gt(ask)) return true;
    }
  }
  return false;
}

function settingsFrom(fixture: ReplayFixture): CostSettings {
  const value = fixture.settings;
  return {
    minProfitUsd: new Decimal(value.minProfitUsd ?? '0.25'),
    safetyBufferBps: new Decimal(value.safetyBufferBps ?? '15'),
    minNetProfitBps: new Decimal(value.minNetProfitBps ?? '20'),
    maxOrderbookAgeMs: Number(value.maxOrderbookAgeMs ?? 3000),
    maxSlippageBps: new Decimal(value.maxSlippageBps ?? '50'),
    maxGasCostUsd: new Decimal(value.maxGasCostUsd ?? '0.50'),
    maxTransferTaxBps: new Decimal(value.maxTransferTaxBps ?? '0'),
  };
}

export async function runReplay(
  fixture: ReplayFixture,
  options: ReplayOptions,
): Promise<ReplayReport> {
  const marketValues = normalizeMarkets(fixture);
  if (marketValues.length === 0) throw new Error('replay fixture has no markets');
  const markets = marketValues.map(toMarket);
  const venueIds = [...new Set(markets.map((market) => market.venueId))];
  if (venueIds.length < 2) throw new Error('replay requires at least two venues');
  const bases = [...new Set(markets.map((market) => market.base))];
  const quotes = [...new Set(markets.map((market) => market.quote))];

  const ordered = fixture.samples
    .map((sample) => ({ sample, at: Number(sample.sampledAt) }))
    .sort((left, right) => left.at - right.at);
  if (ordered.length === 0) throw new Error('replay fixture has no samples');
  for (const entry of ordered) {
    if (!Number.isFinite(entry.at) || entry.at <= 0) {
      throw new Error('replay sample sampledAt must be a positive epoch millisecond');
    }
  }

  const adapters = new Map<string, ReplayCexAdapter>();
  for (const venueId of venueIds) {
    adapters.set(
      venueId,
      new ReplayCexAdapter(
        venueId,
        'S',
        markets.filter((market) => market.venueId === venueId),
      ),
    );
  }

  let currentTime = ordered[0]!.at;
  const venues: ScannerVenue[] = venueIds.map((venueId) => ({
    adapter: adapters.get(venueId)!,
    health: new VenueHealthTracker(),
    markets: [],
  }));
  const episodeGapMs = options.episodeGapMs ?? 15_000;
  const scanner = new ScannerService({
    venues,
    repository: options.repository,
    settings: settingsFrom(fixture),
    quoteCurrency: fixture.quote ?? quotes[0]!,
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
    fetchConcurrency: 8,
    requestedNotional: new Decimal(fixture.requestedNotional),
    orderBookDepth: 50,
    maxTriangularPaths: 100,
    maxCandidatesPerCycle: 100,
    maxHops: 5,
    maxLegsPerCurrency: 4,
    crossVenueMode: options.crossVenueMode ?? (fixture.balances?.length ? 'inventory' : 'off'),
    maxVenueSwitches: 1,
    balanceMaxAgeMs: Number.MAX_SAFE_INTEGER,
    balanceSafetyBufferBps: new Decimal(100),
    optimalSizing: options.optimalSizing ?? true,
    minSizingNotional: options.minSizingNotional ?? new Decimal(1),
    sizingStep: options.sizingStep ?? new Decimal('0.01'),
    maxSizingCandidatesPerCycle: options.maxSizingCandidatesPerCycle ?? 40,
    sizingSamples: options.sizingSamples ?? 16,
    persistSnapshots: false,
    paperSimulation: options.paperSimulation ?? false,
    episodeGapMs,
    clock: () => currentTime,
  });

  await scanner.initialize();
  if (fixture.balances?.length) {
    for (const balance of fixture.balances) {
      const free = new Decimal(balance.free);
      options.repository.recordBalance({
        venueId: balance.venueId,
        accountId: 'replay',
        currency: balance.currency,
        free,
        used: new Decimal(0),
        total: free,
        fetchedAt: currentTime,
      });
    }
  }

  let scanned = 0;
  let errors = 0;
  let validOpportunities = 0;
  let rejectedOpportunities = 0;
  let rawEdgeFrames = 0;
  let netOpportunityFrames = 0;
  const latencies: number[] = [];
  for (const entry of ordered) {
    currentTime = entry.at;
    for (const [venueId, adapter] of adapters) {
      const books = sampleBooks(entry.sample, venueId).map(toSnapshot);
      for (const book of books) {
        if (book.exchangeTimestamp !== undefined) {
          latencies.push(Math.max(0, (book.receivedAt ?? book.fetchedAt) - book.exchangeTimestamp));
        }
      }
      adapter.setBooks(books);
    }
    if (hasRawEdge(entry.sample, markets)) rawEdgeFrames += 1;
    const summary = await scanner.scanOnce();
    scanned += 1;
    errors += summary.errors;
    validOpportunities += summary.validOpportunities;
    rejectedOpportunities += summary.rejectedOpportunities;
    if (summary.validOpportunities > 0) netOpportunityFrames += 1;
  }

  const lastSampleAt = ordered.at(-1)!.at;
  options.repository.closeStaleEpisodes(lastSampleAt + episodeGapMs + 1, episodeGapMs);
  return {
    name: fixture.name ?? 'replay',
    samples: ordered.length,
    scanned,
    errors,
    validOpportunities,
    rejectedOpportunities,
    opportunitiesByStrategy: options.repository.opportunityCountsByStrategy(),
    episodes: options.repository.episodeSummary(),
    decay: options.repository.opportunityDecay(),
    paperTrades: options.paperSimulation ? options.repository.paperTradeSummary() : null,
    feedLatency: summarizeLatency(latencies),
    rawEdgeFrames,
    netOpportunityFrames,
    falsePositiveRate:
      rawEdgeFrames > 0 ? Math.max(0, (rawEdgeFrames - netOpportunityFrames) / rawEdgeFrames) : 0,
    firstSampleAt: ordered[0]!.at,
    lastSampleAt,
    durationMs: lastSampleAt - ordered[0]!.at,
  };
}
