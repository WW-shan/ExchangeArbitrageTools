import {
  Decimal,
  TokenBucketRateLimiter,
  ZERO,
  resolveBaseUnits,
  type Clock,
  type CurrencyMetadata,
  type HealthState,
  type MarketMetadata,
  type OrderBookSnapshot,
  type TickerSnapshot,
  type VenueTier,
} from '@arb/core';
import ccxt, { type Exchange, type Market, type Order, type OrderBook } from 'ccxt';
import type {
  AdapterRuntime,
  ApiCredentials,
  BalanceSnapshot,
  CexAdapter,
  DepositAddress,
  OrderQuery,
  OrderRequest,
  OrderState,
  TransferQuery,
  TransferRecord,
  TransferStatus,
  VenueCapabilities,
  WithdrawalRequest,
  WithdrawalSubmission,
} from './types.js';
import { VENUE_CATALOG, venueDefinition, type VenueMarketType } from './catalog.js';
import {
  networksMatch,
  normalizeAddressTag,
  normalizeCurrencyNetwork,
} from './transfer-network.js';

export { normalizeCurrencyNetwork };

type ExchangeConstructor = new (config?: Record<string, unknown>) => Exchange;

function exchangeRegistry(): Record<string, ExchangeConstructor> {
  return ccxt as unknown as Record<string, ExchangeConstructor>;
}

interface ProExchangeLike {
  watchOrderBook(
    symbol: string,
    limit?: number,
    params?: Record<string, unknown>,
  ): Promise<OrderBook>;
  close(): Promise<void>;
}

type ProExchangeConstructor = new (config?: Record<string, unknown>) => ProExchangeLike;

function proExchangeRegistry(): Record<string, ProExchangeConstructor> {
  const pro = (ccxt as unknown as { pro?: Record<string, ProExchangeConstructor> }).pro;
  return pro ?? {};
}

const PRO_ID_ALIASES: Record<string, string> = { gateio: 'gate' };

function proExchangeId(exchangeId: string): string {
  return PRO_ID_ALIASES[exchangeId] ?? exchangeId;
}

export function isCcxtShutdownError(error: unknown): boolean {
  const pattern = /closedByUser|ExchangeClosedByUser/;
  if (error && typeof error === 'object' && 'message' in error) {
    const candidate = error as { name?: unknown; message?: unknown };
    return pattern.test(`${String(candidate.name ?? '')}: ${String(candidate.message ?? '')}`);
  }
  return pattern.test(String(error));
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function decimalOrUndefined(value: unknown): Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const result = new Decimal(String(value));
    return result.isFinite() ? result : undefined;
  } catch {
    return undefined;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function normalizeTransferStatus(value: unknown): TransferStatus {
  const status = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['ok', 'completed', 'complete', 'success', 'done'].includes(status)) return 'completed';
  if (['pending', 'new', 'open', 'waiting'].includes(status)) return 'pending';
  if (['processing', 'inprogress', 'confirming', 'confirmations'].includes(status)) {
    return 'processing';
  }
  if (['canceled', 'cancelled', 'revoked'].includes(status)) return 'canceled';
  if (['failed', 'failure', 'rejected', 'invalid'].includes(status)) return 'failed';
  return 'unknown';
}

function normalizeCcxtTransfer(
  venueId: string,
  direction: 'deposit' | 'withdrawal',
  transaction: Record<string, unknown>,
): TransferRecord {
  const id = stringOrUndefined(transaction.id) ?? '';
  const currency = (stringOrUndefined(transaction.currency) ?? '').toUpperCase();
  const network = stringOrUndefined(transaction.network);
  const address = stringOrUndefined(transaction.address);
  const tag =
    stringOrUndefined(transaction.tag) ?? stringOrUndefined(transaction.memo) ?? undefined;
  const txId = stringOrUndefined(transaction.txid);
  const feeRecord =
    transaction.fee && typeof transaction.fee === 'object' && !Array.isArray(transaction.fee)
      ? (transaction.fee as Record<string, unknown>)
      : undefined;
  const amount = decimalOrUndefined(transaction.amount) ?? ZERO;
  const fee = decimalOrUndefined(feeRecord?.cost);
  const createdAt = normalizeExchangeTimestamp(numberOrUndefined(transaction.timestamp));
  const updatedAt = normalizeExchangeTimestamp(numberOrUndefined(transaction.updated));
  return {
    venueId,
    id,
    direction,
    currency,
    amount,
    status: normalizeTransferStatus(transaction.status),
    ...(network ? { network } : {}),
    ...(address ? { address } : {}),
    ...(tag ? { tag: normalizeAddressTag(tag) } : {}),
    ...(txId ? { txId } : {}),
    ...(fee !== undefined ? { fee } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    raw: transaction,
  };
}

function transferMatchesQuery(record: TransferRecord, query: TransferQuery): boolean {
  if (query.id && record.id !== query.id) return false;
  if (query.txId && record.txId !== query.txId) return false;
  if (query.network && !networksMatch(record.network, query.network)) return false;
  return true;
}

export function normalizeExchangeTimestamp(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return value;
  if (value > 1e17) return Math.round(value / 1e6);
  if (value > 1e14) return Math.round(value / 1e3);
  if (value < 1e11) return Math.round(value * 1000);
  return value;
}

function responseStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  return numberOrUndefined(candidate.response?.status ?? candidate.status);
}

export function parseRetryAfterMs(error: unknown, now = Date.now()): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    retryAfter?: unknown;
    response?: { headers?: unknown };
  };
  const direct = numberOrUndefined(candidate.retryAfter);
  if (direct !== undefined) {
    if (direct > 1e12) return Math.max(0, direct - now);
    if (direct > 1e9) return Math.max(0, direct * 1000 - now);
    return Math.max(0, direct < 1000 ? direct * 1000 : direct);
  }
  const headers = candidate.response?.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const values = headers as Record<string, unknown>;
    const raw = values['retry-after'] ?? values['Retry-After'];
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (text !== undefined && text !== null && String(text).trim() !== '') {
      const seconds = Number(text);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const date = Date.parse(String(text));
      if (Number.isFinite(date)) return Math.max(0, date - now);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/retry[- ]after[^\d]*(\d+(?:\.\d+)?)/i);
  return match ? Math.max(0, Number(match[1]) * 1000) : undefined;
}

function isNetworkFailure(message: string): boolean {
  return /network|timeout|timed out|socket|econn|enotfound|eai_again|etimedout|fetch failed|connection reset/i.test(
    message,
  );
}

export interface CcxtFailureClassification {
  status: number | undefined;
  rateLimited: boolean;
  transient: boolean;
  message: string;
}

export function classifyCcxtFailure(error: unknown): CcxtFailureClassification {
  const message = error instanceof Error ? error.message : String(error);
  const status = responseStatus(error);
  const rateLimited =
    status === 403 ||
    status === 418 ||
    status === 429 ||
    /rate.?limit|too many|429|418/i.test(message);
  return {
    status,
    rateLimited,
    transient: rateLimited || isNetworkFailure(message) || (status ?? 0) >= 500,
    message,
  };
}

export function stepFromCcxt(precision: unknown): Decimal | undefined {
  if (typeof precision === 'number') {
    if (!Number.isFinite(precision) || precision <= 0) return undefined;
    if (Number.isInteger(precision)) {
      return precision <= 30 ? new Decimal(10).pow(-precision) : undefined;
    }
    return new Decimal(precision);
  }
  if (typeof precision === 'string' && precision.trim() !== '') {
    const value = decimalOrUndefined(precision);
    if (!value || value.lte(0)) return undefined;
    if (value.gte(1) && value.isInteger()) {
      return value.lte(30) ? new Decimal(10).pow(value.negated().toNumber()) : undefined;
    }
    return value;
  }
  return undefined;
}

function precisionDigits(value: unknown, fallback = 8): number {
  const numeric = numberOrUndefined(value);
  if (numeric === undefined || numeric < 0) return fallback;
  if (Number.isInteger(numeric)) return numeric <= 30 ? numeric : fallback;
  try {
    const decimalPlaces = new Decimal(String(value)).decimalPlaces();
    return decimalPlaces <= 30 ? decimalPlaces : fallback;
  } catch {
    return fallback;
  }
}
function toMarket(venueId: string, market: Market | undefined): MarketMetadata | undefined {
  if (!market || market.active === false || !market.base || !market.quote || !market.symbol) {
    return undefined;
  }
  const baseUnits = resolveBaseUnits(market.base);
  const quote = market.quote.trim().toUpperCase();
  const feeConfig = market as Market & { fee?: { taker?: unknown; maker?: unknown } };
  const taker = decimalOrUndefined(market.taker ?? feeConfig.fee?.taker);
  const maker = decimalOrUndefined(market.maker ?? feeConfig.fee?.maker);
  const amountStep = stepFromCcxt(market.precision?.amount);
  const priceStep = stepFromCcxt(market.precision?.price);
  const minAmount = decimalOrUndefined(market.limits?.amount?.min);
  const minNotional = decimalOrUndefined(market.limits?.cost?.min);
  return {
    venueId,
    exchangeSymbol: market.symbol,
    unifiedSymbol: `${baseUnits.base}/${quote}`,
    base: baseUnits.base,
    ...(baseUnits.alias
      ? { exchangeBase: market.base.trim(), baseMultiplier: baseUnits.multiplier }
      : {}),
    quote,
    active: true,
    pricePrecision: precisionDigits(market.precision?.price),
    amountPrecision: precisionDigits(market.precision?.amount),
    ...(amountStep ? { amountStep } : {}),
    ...(priceStep ? { priceStep } : {}),
    ...(minAmount ? { minAmount } : {}),
    ...(minNotional ? { minNotional } : {}),
    ...(taker !== undefined ? { feeTakerBps: taker.mul(10_000) } : {}),
    ...(maker !== undefined ? { makerFeeBps: maker.mul(10_000) } : {}),
    feeProvenance: taker !== undefined ? 'ccxt' : 'default',
  };
}
function normalizeOrder(order: Order, venueId: string): OrderState {
  const amount = decimalOrUndefined(order.amount) ?? new Decimal(0);
  const filled = decimalOrUndefined(order.filled) ?? new Decimal(0);
  const remaining =
    decimalOrUndefined(order.remaining) ??
    (amount.minus(filled).lt(0) ? ZERO : amount.minus(filled));
  const rawStatus = order.status ?? 'unknown';
  const status: OrderState['status'] =
    rawStatus === 'closed' || rawStatus === 'canceled' || rawStatus === 'rejected'
      ? rawStatus
      : rawStatus === 'open' || rawStatus === 'pending' || rawStatus === 'new'
        ? 'open'
        : 'unknown';
  return {
    venueOrderId: String(order.id),
    ...(order.clientOrderId ? { clientOrderId: String(order.clientOrderId) } : {}),
    symbol: String(order.symbol),
    side: order.side === 'sell' ? 'sell' : 'buy',
    type: String(order.type ?? 'unknown'),
    ...(decimalOrUndefined(order.price) ? { price: decimalOrUndefined(order.price)! } : {}),
    amount,
    filled,
    remaining,
    ...(decimalOrUndefined(order.average)
      ? { averagePrice: decimalOrUndefined(order.average)! }
      : {}),
    ...(decimalOrUndefined(order.fee?.cost) ? { fee: decimalOrUndefined(order.fee?.cost)! } : {}),
    status,
    raw: { venueId, id: order.id, status: rawStatus },
  };
}

export interface CcxtAdapterOptions {
  venueId?: string;
  exchangeId: string;
  tier: VenueTier;
  runtime: AdapterRuntime;
  credentials?: ApiCredentials;
  readOnly?: boolean;
  sandbox?: boolean;
  proxyUrl?: string;
  supportsIoc?: boolean;
  supportsFok?: boolean;
  marketType?: VenueMarketType;
}

export class CcxtCexAdapter implements CexAdapter {
  readonly venueId: string;
  readonly tier: VenueTier;
  readonly capabilities: VenueCapabilities;
  readonly #exchange: Exchange;
  readonly #exchangeId: string;
  readonly #config: Record<string, unknown>;
  readonly #marketType: VenueMarketType;
  readonly #runtime: AdapterRuntime;
  #proExchange: ProExchangeLike | undefined;
  #proxyConfigured = false;
  #proxyModulesReady = false;
  #proProxyModulesReady = false;
  #consecutiveFailures = 0;
  #degraded = false;

  constructor(options: CcxtAdapterOptions) {
    const Constructor = exchangeRegistry()[options.exchangeId];
    if (!Constructor) throw new Error(`unknown CCXT exchange: ${options.exchangeId}`);
    this.venueId = options.venueId ?? options.exchangeId;
    this.tier = options.tier;
    this.#exchangeId = options.exchangeId;
    this.#marketType = options.marketType ?? 'spot';
    this.#runtime = options.runtime;
    const config: Record<string, unknown> = {
      enableRateLimit: false,
      timeout: 15_000,
      options: {
        defaultType: this.#marketType === 'perp' ? 'swap' : 'spot',
        adjustForTimeDifference: true,
        // Gate's CCXT fetchMarkets defaults to spot + swap + future + option.
        // The extra delivery endpoint is irrelevant to S1 and can fail a
        // spot-only probe on its own. Keep the public market load spot-only.
        ...(this.#exchangeId === 'gate' && this.#marketType === 'spot'
          ? { fetchMarkets: { types: ['spot'] } }
          : {}),
      },
    };
    const socksProxy = process.env.ARB_SOCKS_PROXY;
    const httpProxy =
      options.proxyUrl ??
      process.env.ARB_HTTPS_PROXY ??
      process.env.HTTPS_PROXY ??
      process.env.HTTP_PROXY;
    if (socksProxy) {
      config.socksProxy = socksProxy;
      config.wsSocksProxy = socksProxy;
      this.#proxyConfigured = true;
    } else if (httpProxy) {
      config.httpsProxy = httpProxy;
      config.wssProxy = process.env.ARB_WSS_PROXY ?? httpProxy;
      this.#proxyConfigured = true;
    }
    if (options.credentials) {
      config.apiKey = options.credentials.apiKey;
      config.secret = options.credentials.secret;
      if (options.credentials.password) config.password = options.credentials.password;
    }
    this.#config = config;
    this.#exchange = new Constructor(config);
    if (options.sandbox && this.#exchange.setSandboxMode) this.#exchange.setSandboxMode(true);
    const readOnly = options.readOnly ?? true;
    this.capabilities = {
      publicMarketData: true,
      orderBook: true,
      privateBalances: Boolean(options.credentials),
      createOrder: !readOnly && Boolean(options.credentials),
      fetchOrder: !readOnly && Boolean(options.credentials),
      cancelOrder: !readOnly && Boolean(options.credentials),
      depositAddress:
        Boolean(options.credentials) && typeof this.#exchange.fetchDepositAddress === 'function',
      depositHistory:
        Boolean(options.credentials) && typeof this.#exchange.fetchDeposits === 'function',
      withdrawalHistory:
        Boolean(options.credentials) && typeof this.#exchange.fetchWithdrawals === 'function',
      createWithdrawal:
        !readOnly && Boolean(options.credentials) && typeof this.#exchange.withdraw === 'function',
      websocket: Boolean(proExchangeRegistry()[proExchangeId(options.exchangeId)]),
      ioc: options.supportsIoc ?? false,
      fok: options.supportsFok ?? false,
    };
  }

  setCredentials(credentials: ApiCredentials): void {
    this.#exchange.apiKey = credentials.apiKey;
    this.#exchange.secret = credentials.secret;
    if (credentials.password) this.#exchange.password = credentials.password;
  }

  private async call<T>(
    privateRequest: boolean,
    operation: () => Promise<T>,
    priority: 'normal' | 'execution' = 'normal',
  ): Promise<T> {
    await this.ensureProxyModules();
    await this.#runtime.rateLimiter.acquire(priority, privateRequest);
    const started = Date.now();
    try {
      const result = await operation();
      const recovered = this.#degraded;
      this.#consecutiveFailures = 0;
      this.#degraded = false;
      this.#runtime.onSuccess?.(Date.now() - started);
      if (recovered) this.#runtime.onRecover?.();
      return result;
    } catch (error) {
      const { message, status, rateLimited, transient } = classifyCcxtFailure(error);
      if (transient) {
        const retryAfterMs = rateLimited
          ? Math.max(1_000, parseRetryAfterMs(error, Date.now()) ?? 60_000)
          : Math.min(60_000, 1_000 * 2 ** this.#consecutiveFailures);
        this.#consecutiveFailures = Math.min(this.#consecutiveFailures + 1, 6);
        this.#degraded = true;
        this.#runtime.rateLimiter.respectRetryAfter(retryAfterMs);
        const now = this.#runtime.clock?.now() ?? Date.now();
        this.#runtime.onBackoff?.({
          backoffUntil: now + retryAfterMs,
          retryAfterMs,
          reason: rateLimited ? 'rate_limited' : `venue_transient_failure:${status ?? message}`,
          consecutiveFailures: this.#consecutiveFailures,
          rateLimited,
        });
      }
      this.#runtime.onFailure?.(Date.now() - started, rateLimited);
      throw error;
    }
  }

  async loadMarkets(): Promise<MarketMetadata[]> {
    const markets = await this.call(false, () => this.#exchange.loadMarkets());
    return Object.values(markets)
      .filter((market) => {
        const typed = market as Market & { spot?: boolean; swap?: boolean };
        return this.#marketType === 'perp' ? typed.swap === true : typed.spot === true;
      })
      .map((market) => toMarket(this.venueId, market))
      .filter((market): market is MarketMetadata => market !== undefined)
      .map((market) => ({
        ...market,
        supportsIoc: this.capabilities.ioc,
        supportsFok: this.capabilities.fok,
      }));
  }

  async fetchOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    if (!Number.isInteger(depth) || depth <= 0) throw new Error('depth must be a positive integer');
    const book = await this.call(false, () =>
      this.#exchange.fetchOrderBook(symbol, this.restDepth(depth)),
    );
    const fetchedAt = this.#runtime.clock?.now() ?? Date.now();
    return this.normalizeBook(symbol, book, fetchedAt);
  }

  async fetchTradingFees(): Promise<Record<string, { takerBps?: Decimal; makerBps?: Decimal }>> {
    const target = this.#exchange as unknown as {
      fetchTradingFees?: () => Promise<Record<string, { taker?: unknown; maker?: unknown }>>;
    };
    if (typeof target.fetchTradingFees !== 'function') return {};
    const fees = await this.call(
      true,
      () => target.fetchTradingFees!.call(this.#exchange),
      'execution',
    );
    const result: Record<string, { takerBps?: Decimal; makerBps?: Decimal }> = {};
    for (const [symbol, fee] of Object.entries(fees ?? {})) {
      const taker = decimalOrUndefined(fee.taker);
      const maker = decimalOrUndefined(fee.maker);
      result[symbol] = {
        ...(taker ? { takerBps: taker.mul(10_000) } : {}),
        ...(maker ? { makerBps: maker.mul(10_000) } : {}),
      };
    }
    return result;
  }

  async watchOrderBook(
    symbol: string,
    depth: number,
    onBook: (book: OrderBookSnapshot) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isInteger(depth) || depth <= 0) throw new Error('depth must be a positive integer');
    const exchange = this.proExchange();
    await this.ensureProProxyModules(exchange);
    while (!signal?.aborted) {
      const book = await exchange.watchOrderBook(symbol, this.wsDepth(depth));
      if (signal?.aborted) return;
      const receivedAt = this.#runtime.clock?.now() ?? Date.now();
      onBook(this.normalizeBook(symbol, book, receivedAt, 'websocket'));
    }
  }

  async close(): Promise<void> {
    if (this.#proExchange) {
      try {
        await this.#proExchange.close();
      } catch {
        // ignore shutdown errors
      }
      this.#proExchange = undefined;
    }
    const maybeClose = (this.#exchange as unknown as { close?: () => Promise<void> }).close;
    if (typeof maybeClose === 'function') {
      try {
        await maybeClose.call(this.#exchange);
      } catch {
        // ignore shutdown errors
      }
    }
  }

  private proExchange(): ProExchangeLike {
    if (this.#proExchange) return this.#proExchange;
    const id = proExchangeId(this.#exchangeId);
    const Constructor = proExchangeRegistry()[id];
    if (!Constructor) throw new Error(`CCXT pro does not support ${this.#exchangeId}`);
    this.#proExchange = new Constructor({ ...this.#config });
    return this.#proExchange;
  }

  private async ensureProxyModules(): Promise<void> {
    if (!this.#proxyConfigured || this.#proxyModulesReady) return;
    const target = this.#exchange as unknown as { loadProxyModules?: () => Promise<void> };
    if (typeof target.loadProxyModules === 'function') await target.loadProxyModules();
    this.#proxyModulesReady = true;
  }

  private restDepth(depth: number): number {
    if (this.#exchangeId === 'kucoin') return depth <= 20 ? 20 : 100;
    if (this.#exchangeId === 'bitfinex') return depth <= 25 ? 25 : 100;
    if (this.#exchangeId === 'kraken') {
      if (depth <= 10) return 10;
      if (depth <= 25) return 25;
      if (depth <= 100) return 100;
      return 500;
    }
    return depth;
  }

  private wsDepth(depth: number): number {
    if (this.#exchangeId === 'bybit') {
      if (depth <= 1) return 1;
      if (depth <= 50) return 50;
      if (depth <= 200) return 200;
      return 1000;
    }
    if (this.#exchangeId === 'kraken') {
      if (depth <= 10) return 10;
      if (depth <= 25) return 25;
      if (depth <= 100) return 100;
      if (depth <= 500) return 500;
      return 1000;
    }
    if (this.#exchangeId === 'kucoin') return depth <= 20 ? 20 : 100;
    if (this.#exchangeId === 'bitfinex') return depth <= 25 ? 25 : 100;
    return depth;
  }

  private async ensureProProxyModules(exchange: ProExchangeLike): Promise<void> {
    if (!this.#proxyConfigured || this.#proProxyModulesReady) return;
    const target = exchange as unknown as { loadProxyModules?: () => Promise<void> };
    if (typeof target.loadProxyModules === 'function') await target.loadProxyModules();
    this.#proProxyModulesReady = true;
  }

  async fetchTickers(): Promise<TickerSnapshot[]> {
    const tickers = await this.call(false, () => this.#exchange.fetchTickers());
    const fetchedAt = this.#runtime.clock?.now() ?? Date.now();
    return Object.values(tickers).flatMap((ticker) => {
      if (!ticker.symbol) return [];
      const last = decimalOrUndefined(ticker.last);
      const bid = decimalOrUndefined(ticker.bid);
      const ask = decimalOrUndefined(ticker.ask);
      const baseVolume = decimalOrUndefined(ticker.baseVolume);
      const quoteVolume = decimalOrUndefined(ticker.quoteVolume);
      return [
        {
          venueId: this.venueId,
          exchangeSymbol: ticker.symbol,
          ...(last ? { last } : {}),
          ...(bid ? { bid } : {}),
          ...(ask ? { ask } : {}),
          ...(baseVolume ? { baseVolume } : {}),
          ...(quoteVolume ? { quoteVolume } : {}),
          timestamp: typeof ticker.timestamp === 'number' ? ticker.timestamp : fetchedAt,
        },
      ];
    });
  }

  private normalizeBook(
    symbol: string,
    book: OrderBook,
    fetchedAt: number,
    source: 'rest' | 'websocket' = 'rest',
  ): OrderBookSnapshot {
    const sequence = numberOrUndefined((book as { nonce?: unknown }).nonce);
    const exchangeTimestamp = normalizeExchangeTimestamp(numberOrUndefined(book.timestamp));
    const levels = (values: unknown): Array<{ price: Decimal; amount: Decimal }> => {
      if (!Array.isArray(values)) return [];
      return values
        .filter((level): level is [unknown, unknown] => Array.isArray(level) && level.length >= 2)
        .map(([price, amount]) => ({
          price: new Decimal(String(price)),
          amount: new Decimal(String(amount)),
        }))
        .filter((level) => level.price.isFinite() && level.amount.isFinite());
    };
    return {
      venueId: this.venueId,
      exchangeSymbol: symbol,
      fetchedAt,
      receivedAt: fetchedAt,
      ...(exchangeTimestamp !== undefined ? { exchangeTimestamp } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      asks: levels(book.asks),
      bids: levels(book.bids),
      source,
    };
  }

  async fetchCurrencies(): Promise<CurrencyMetadata[]> {
    const currencies = await this.call(false, () => this.#exchange.fetchCurrencies());
    return Object.values(currencies).map((currency) => ({
      venueId: this.venueId,
      code: currency.code,
      networks: Object.entries(currency.networks ?? {}).map(([network, data]) => {
        const networkData = data as typeof data & {
          withdraw?: boolean;
          deposit?: boolean;
          fee?: unknown;
          limits?: {
            withdraw?: { min?: unknown };
            deposit?: { min?: unknown };
          };
        };
        const normalizedNetwork = normalizeCurrencyNetwork(network);
        const withdrawFee = decimalOrUndefined(networkData.fee);
        const minWithdrawAmount = decimalOrUndefined(networkData.limits?.withdraw?.min);
        const minDepositAmount = decimalOrUndefined(networkData.limits?.deposit?.min);
        return {
          network: normalizedNetwork,
          nativeName: network,
          withdrawEnabled: Boolean(networkData.withdraw),
          depositEnabled: Boolean(networkData.deposit),
          ...(withdrawFee ? { withdrawFee } : {}),
          ...(minWithdrawAmount ? { minWithdrawAmount } : {}),
          ...(minDepositAmount ? { minDepositAmount } : {}),
          canArriveQuickly: normalizedNetwork === 'BSC',
        };
      }),
    }));
  }

  async fetchBalances(keys: ApiCredentials): Promise<BalanceSnapshot[]> {
    this.setCredentials(keys);
    const balances = await this.call(true, () => this.#exchange.fetchBalance(), 'execution');
    const fetchedAt = this.#runtime.clock?.now() ?? Date.now();
    const totals = (balances.total ?? {}) as Record<string, unknown>;
    const freeBalances = (balances.free ?? {}) as Record<string, unknown>;
    const usedBalances = (balances.used ?? {}) as Record<string, unknown>;
    return Object.entries(totals).map(([currency, total]) => {
      const free = decimalOrUndefined(freeBalances[currency]) ?? new Decimal(0);
      const used = decimalOrUndefined(usedBalances[currency]) ?? new Decimal(0);
      return {
        venueId: this.venueId,
        accountId: 'default',
        currency,
        free,
        used,
        total: decimalOrUndefined(total) ?? free.plus(used),
        fetchedAt,
      };
    });
  }

  async fetchDepositAddress(
    currency: string,
    network: string,
    keys: ApiCredentials,
  ): Promise<DepositAddress> {
    if (!this.capabilities.depositAddress) {
      throw new Error(`${this.venueId} deposit-address API is not available`);
    }
    this.setCredentials(keys);
    const response = await this.call(
      true,
      () => this.#exchange.fetchDepositAddress(currency, { network }),
      'execution',
    );
    const record = response as unknown as Record<string, unknown>;
    const address = stringOrUndefined(record.address);
    if (!address) throw new Error(`${this.venueId} deposit address response is missing address`);
    const returnedNetwork = stringOrUndefined(record.network) ?? network;
    if (!networksMatch(returnedNetwork, network)) {
      throw new Error(
        `${this.venueId} deposit address network mismatch: ${returnedNetwork} != ${network}`,
      );
    }
    const tag = stringOrUndefined(record.tag);
    return {
      venueId: this.venueId,
      currency: currency.toUpperCase(),
      network: returnedNetwork,
      address,
      ...(tag ? { tag } : {}),
      fetchedAt: Date.now(),
      raw: response,
    };
  }

  async fetchDeposits(query: TransferQuery, keys: ApiCredentials): Promise<TransferRecord[]> {
    if (!this.capabilities.depositHistory) {
      throw new Error(`${this.venueId} deposit-history API is not available`);
    }
    this.setCredentials(keys);
    const rows = await this.call(
      true,
      () => this.#exchange.fetchDeposits(query.currency, query.since, query.limit),
      'execution',
    );
    return rows
      .map((row) =>
        normalizeCcxtTransfer(this.venueId, 'deposit', row as unknown as Record<string, unknown>),
      )
      .filter((record) => transferMatchesQuery(record, query));
  }

  async fetchWithdrawals(query: TransferQuery, keys: ApiCredentials): Promise<TransferRecord[]> {
    if (!this.capabilities.withdrawalHistory) {
      throw new Error(`${this.venueId} withdrawal-history API is not available`);
    }
    this.setCredentials(keys);
    const rows = await this.call(
      true,
      () => this.#exchange.fetchWithdrawals(query.currency, query.since, query.limit),
      'execution',
    );
    return rows
      .map((row) =>
        normalizeCcxtTransfer(
          this.venueId,
          'withdrawal',
          row as unknown as Record<string, unknown>,
        ),
      )
      .filter((record) => transferMatchesQuery(record, query));
  }

  async createWithdrawal(
    request: WithdrawalRequest,
    keys: ApiCredentials,
  ): Promise<WithdrawalSubmission> {
    if (!this.capabilities.createWithdrawal) {
      throw new Error(`${this.venueId} withdrawal API is not enabled for this adapter`);
    }
    this.setCredentials(keys);
    const tag = normalizeAddressTag(request.tag);
    const params: Record<string, unknown> = {
      network: request.network,
      ...(tag ? { tag } : {}),
    };
    const response = await this.call(
      true,
      () =>
        this.#exchange.withdraw(
          request.currency,
          request.amount.toFixed() as unknown as number,
          request.address,
          params,
        ),
      'execution',
    );
    const record = normalizeCcxtTransfer(
      this.venueId,
      'withdrawal',
      response as unknown as Record<string, unknown>,
    );
    return {
      venueId: this.venueId,
      ...(record.id ? { id: record.id } : {}),
      currency: record.currency || request.currency.toUpperCase(),
      network: record.network ?? request.network,
      address: record.address ?? request.address,
      ...(record.tag ? { tag: record.tag } : {}),
      amount: record.amount.gt(0) ? record.amount : request.amount,
      status: record.status,
      ...(record.fee !== undefined ? { fee: record.fee } : {}),
      ...(record.txId ? { txId: record.txId } : {}),
      ...(record.createdAt !== undefined ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
      raw: record.raw,
    };
  }

  async createOrder(request: OrderRequest, keys: ApiCredentials): Promise<OrderState> {
    this.setCredentials(keys);
    const params: Record<string, unknown> = {};
    if (request.clientOrderId) params.clientOrderId = request.clientOrderId;
    if (request.timeInForce) params.timeInForce = request.timeInForce;
    const order = await this.call(
      true,
      () =>
        this.#exchange.createOrder(
          request.symbol,
          request.type,
          request.side,
          // CCXT forwards these values unchanged; exact decimal strings avoid binary-float drift.
          request.amount.toFixed() as unknown as number,
          request.price?.toFixed() as unknown as number | undefined,
          params,
        ),
      'execution',
    );
    return normalizeOrder(order, this.venueId);
  }

  async fetchOrder(request: OrderQuery, keys: ApiCredentials): Promise<OrderState> {
    this.setCredentials(keys);
    const identifier = request.venueOrderId ?? request.clientOrderId;
    if (!identifier) throw new Error('venueOrderId or clientOrderId is required');
    const params: Record<string, unknown> = {};
    if (request.clientOrderId) params.clientOrderId = request.clientOrderId;
    const order = await this.call(
      true,
      () => this.#exchange.fetchOrder(identifier, request.symbol, params),
      'execution',
    );
    return normalizeOrder(order, this.venueId);
  }

  async cancelOrder(request: OrderQuery, keys: ApiCredentials): Promise<OrderState> {
    this.setCredentials(keys);
    const identifier = request.venueOrderId ?? request.clientOrderId;
    if (!identifier) throw new Error('venueOrderId or clientOrderId is required');
    const params: Record<string, unknown> = {};
    if (request.clientOrderId) params.clientOrderId = request.clientOrderId;
    const order = await this.call(
      true,
      () => this.#exchange.cancelOrder(identifier, request.symbol, params),
      'execution',
    );
    return normalizeOrder(order, this.venueId);
  }
}

export const CCXT_EXCHANGE_IDS: Readonly<Record<string, string>> = {
  gateio: 'gate',
  cryptocom: 'cryptocom',
};

export function resolveCcxtExchangeId(venueId: string): string {
  return venueDefinition(venueId)?.ccxtId ?? CCXT_EXCHANGE_IDS[venueId] ?? venueId;
}

export const CEX_TIERS: Readonly<Record<string, VenueTier>> = {
  ...Object.fromEntries(
    Object.values(VENUE_CATALOG)
      .filter((venue) => venue.kind === 'cex')
      .map((venue) => [venue.id, venue.tier]),
  ),
};

export function createCcxtAdapter(
  exchangeId: keyof typeof CEX_TIERS | string,
  runtime: AdapterRuntime,
  options: {
    credentials?: ApiCredentials;
    readOnly?: boolean;
    sandbox?: boolean;
    proxyUrl?: string;
    supportsIoc?: boolean;
    supportsFok?: boolean;
    tier?: VenueTier;
    marketType?: VenueMarketType;
  } = {},
): CcxtCexAdapter {
  if (exchangeId === 'hotcoin') {
    throw new Error('Hotcoin requires HotcoinAdapter, not createCcxtAdapter');
  }
  const definition = venueDefinition(exchangeId);
  const tier = options.tier ?? definition?.tier ?? CEX_TIERS[exchangeId] ?? 'B';
  const marketType = options.marketType ?? definition?.marketType ?? 'spot';
  return new CcxtCexAdapter({
    venueId: exchangeId,
    exchangeId: resolveCcxtExchangeId(exchangeId),
    tier,
    marketType,
    runtime,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {}),
    ...(options.proxyUrl !== undefined ? { proxyUrl: options.proxyUrl } : {}),
    ...(options.supportsIoc !== undefined ? { supportsIoc: options.supportsIoc } : {}),
    ...(options.supportsFok !== undefined ? { supportsFok: options.supportsFok } : {}),
  });
}

export function createPublicRuntime(
  requestsPerSecond = 2,
  clock?: Clock,
  callbacks: Pick<AdapterRuntime, 'onSuccess' | 'onFailure' | 'onBackoff' | 'onRecover'> = {},
): AdapterRuntime {
  return {
    rateLimiter: new TokenBucketRateLimiter(
      {
        requestsPerSecond,
        burst: Math.max(1, requestsPerSecond),
        costPublic: 1,
        costPrivate: 1,
        respectRetryAfter: true,
      },
      clock,
    ),
    ...(clock ? { clock } : {}),
    ...(callbacks.onSuccess ? { onSuccess: callbacks.onSuccess } : {}),
    ...(callbacks.onFailure ? { onFailure: callbacks.onFailure } : {}),
    ...(callbacks.onBackoff ? { onBackoff: callbacks.onBackoff } : {}),
    ...(callbacks.onRecover ? { onRecover: callbacks.onRecover } : {}),
  };
}

export type { HealthState };
