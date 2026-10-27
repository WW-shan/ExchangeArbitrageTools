import { createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { Agent } from 'node:http';
import { gunzipSync } from 'node:zlib';
import {
  Decimal,
  resolveBaseUnits,
  type MarketMetadata,
  type OrderBookSnapshot,
  type TickerSnapshot,
  type VenueTier,
} from '@arb/core';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket, { type RawData } from 'ws';
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
import {
  networksMatch,
  normalizeAddressTag,
  normalizeTransferCurrency,
  transactionIdsMatch,
} from './transfer-network.js';

interface HotcoinSymbol {
  baseCurrency: string;
  quoteCurrency: string;
  symbol: string;
  pricePrecision: number;
  amountPrecision: number;
  minOrderAmount?: string;
  minOrderCount?: string;
  state: string;
}

interface HotcoinEnvelope<T> {
  code?: number;
  msg?: string;
  status?: string;
  time?: number;
  timestamp?: number;
  data?: T;
  ticker?: unknown;
}

interface HotcoinDepthLevels {
  asks?: unknown;
  bids?: unknown;
  date?: number;
  tradeId?: number;
}

export interface HotcoinHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HotcoinHttpResponse {
  status: number;
  headers?: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
}

export type HotcoinHttpClient = (request: HotcoinHttpRequest) => Promise<HotcoinHttpResponse>;

export interface HotcoinWebSocketLike {
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export type HotcoinWebSocketFactory = (
  url: string,
  options: { agent?: Agent },
) => HotcoinWebSocketLike;

export interface HotcoinAdapterOptions {
  venueId?: string;
  tier?: VenueTier;
  baseUrl?: string;
  wsUrl?: string;
  signHost?: string;
  httpClient?: HotcoinHttpClient;
  webSocketFactory?: HotcoinWebSocketFactory;
  runtime?: AdapterRuntime;
  credentials?: ApiCredentials;
  readOnly?: boolean;
  supportsIoc?: boolean;
  supportsFok?: boolean;
  proxyUrl?: string;
  clock?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

const ZERO = new Decimal(0);
const DEFAULT_BASE_URL = 'https://api.hotcoinfin.com';
const DEFAULT_WS_URL = 'wss://wss.hotcoinfin.com/trade/multiple';
const DEFAULT_SIGN_HOST = 'api.hotcoinfin.com';

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimalOrUndefined(value: unknown): Decimal | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringOrUndefined(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstDecimal(record: Record<string, unknown>, keys: string[]): Decimal | undefined {
  for (const key of keys) {
    const value = decimalOrUndefined(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function queryString(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(params[key] ?? '')}`)
    .join('&');
}

export function hotcoinCanonicalQuery(params: Readonly<Record<string, string>>): string {
  return queryString(params);
}

export function hotcoinSignature(
  secretKey: string,
  method: 'GET' | 'POST',
  host: string,
  path: string,
  canonicalQuery: string,
): string {
  const payload = `${method.toUpperCase()}\n${host}\n${path}\n${canonicalQuery}`;
  return createHmac('sha256', secretKey).update(payload, 'utf8').digest('base64');
}

function normalizeParams(
  params: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) result[key] = String(value);
  }
  return result;
}

function proxyAgent(proxyUrl: string | undefined): Agent | undefined {
  const explicit = proxyUrl?.trim();
  if (explicit) {
    return explicit.startsWith('socks')
      ? new SocksProxyAgent(explicit)
      : new HttpsProxyAgent(explicit);
  }
  const socks = process.env.ARB_SOCKS_PROXY?.trim();
  if (socks) return new SocksProxyAgent(socks);
  const httpsProxy =
    process.env.ARB_HTTPS_PROXY?.trim() ??
    process.env.HTTPS_PROXY?.trim() ??
    process.env.HTTP_PROXY?.trim();
  return httpsProxy ? new HttpsProxyAgent(httpsProxy) : undefined;
}

function createNodeHttpClient(agent: Agent | undefined, timeoutMs: number): HotcoinHttpClient {
  return (request) =>
    new Promise<HotcoinHttpResponse>((resolve, reject) => {
      const target = new URL(request.url);
      const req = httpsRequest(
        target,
        {
          method: request.method,
          headers: request.headers,
          ...(agent ? { agent } : {}),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: async () => Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Hotcoin HTTP request timeout')));
      req.on('error', reject);
      if (request.body) req.write(request.body);
      req.end();
    });
}

function defaultWebSocketFactory(url: string, options: { agent?: Agent }): HotcoinWebSocketLike {
  return new WebSocket(
    url,
    options.agent ? { agent: options.agent } : {},
  ) as unknown as HotcoinWebSocketLike;
}

function sortLevels(
  values: unknown,
  side: 'asks' | 'bids',
): Array<{ price: Decimal; amount: Decimal }> {
  if (!Array.isArray(values)) return [];
  const levels = values
    .filter((level): level is [unknown, unknown] => Array.isArray(level) && level.length >= 2)
    .map(([price, amount]) => ({
      price: decimalOrUndefined(price),
      amount: decimalOrUndefined(amount),
    }))
    .filter(
      (level): level is { price: Decimal; amount: Decimal } =>
        level.price !== undefined &&
        level.amount !== undefined &&
        level.price.gt(0) &&
        level.amount.gt(0),
    );
  levels.sort((a, b) =>
    side === 'bids' ? b.price.comparedTo(a.price) : a.price.comparedTo(b.price),
  );
  return levels;
}

function normalizeOrderStatus(row: Record<string, unknown>): OrderState['status'] {
  const code = numberOrUndefined(row.statusCode ?? row.status_code);
  if (code !== undefined) {
    if (code === 1 || code === 2 || code === 4) return 'open';
    if (code === 3) return 'closed';
    if (code === 5 || code === 8) return 'canceled';
    return 'unknown';
  }
  const text = firstString(row, ['status', 'state'])?.toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('cancel') || text.includes('revok')) return 'canceled';
  if (text.includes('reject') || text.includes('fail')) return 'rejected';
  if (text.includes('fill') || text.includes('complete') || text.includes('closed'))
    return 'closed';
  if (
    text.includes('unfill') ||
    text.includes('partial') ||
    text.includes('open') ||
    text.includes('pending') ||
    text.includes('new') ||
    text.includes('entrust')
  ) {
    return 'open';
  }
  return 'unknown';
}

function normalizeSide(row: Record<string, unknown>): 'buy' | 'sell' {
  const text = firstString(row, ['types', 'side'])?.toLowerCase();
  if (text === 'sell') return 'sell';
  if (text === 'buy') return 'buy';
  const code = numberOrUndefined(row.type);
  return code === 1 ? 'sell' : 'buy';
}

function normalizeOrder(row: Record<string, unknown>, fallbackSymbol?: string): OrderState {
  const amount = firstDecimal(row, ['count', 'tradeAmount', 'amount', 'quantity']) ?? ZERO;
  const left = firstDecimal(row, ['leftcount', 'leftCount', 'remaining']);
  const filled = firstDecimal(row, [
    'successamount',
    'successAmount',
    'tradeTotalAmount',
    'filled',
  ]);
  const filledAmount = Decimal.max(0, left !== undefined ? amount.minus(left) : (filled ?? ZERO));
  const remaining = Decimal.max(0, left ?? amount.minus(filledAmount));
  const price = firstDecimal(row, ['price', 'tradePrice']);
  const turnover = firstDecimal(row, ['tradeTurnover', 'turnover', 'successTurnover']);
  const average =
    turnover !== undefined && filledAmount.gt(0)
      ? turnover.div(filledAmount)
      : (price ?? firstDecimal(row, ['last']));
  const venueOrderId = firstString(row, ['id', 'ID', 'orderId', 'order_id']);
  if (!venueOrderId) throw new Error('Hotcoin order response is missing an order id');
  return {
    venueOrderId,
    ...(firstString(row, ['clientOrderId', 'client_order_id'])
      ? { clientOrderId: firstString(row, ['clientOrderId', 'client_order_id'])! }
      : {}),
    symbol: firstString(row, ['symbol']) ?? fallbackSymbol ?? '',
    side: normalizeSide(row),
    type: firstString(row, ['typeName', 'orderType']) ?? 'limit',
    ...(price !== undefined ? { price } : {}),
    amount,
    filled: filledAmount,
    remaining,
    ...(average !== undefined ? { averagePrice: average } : {}),
    ...(firstDecimal(row, ['fees', 'fee']) !== undefined
      ? { fee: firstDecimal(row, ['fees', 'fee'])! }
      : {}),
    status: normalizeOrderStatus(row),
    raw: row,
  };
}

function normalizeHotcoinTransferStatus(
  direction: 'deposit' | 'withdrawal',
  value: unknown,
): TransferStatus {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return 'unknown';
  const numeric = /^\d+/.test(text) ? Number.parseInt(text, 10) : undefined;
  if (numeric !== undefined) {
    if (direction === 'deposit') {
      if (numeric === 0) return 'pending';
      if (numeric === 1 || numeric === 2) return 'processing';
      if (numeric === 3) return 'completed';
      if (numeric === 4 || numeric === 5) return 'failed';
      return 'unknown';
    }
    if (numeric === 1) return 'pending';
    if (numeric === 2 || numeric === 5 || numeric === 6) return 'processing';
    if (numeric === 3) return 'completed';
    if (numeric === 4) return 'canceled';
    if (numeric === 7 || numeric === 8) return 'failed';
    return 'unknown';
  }
  if (text.startsWith('0') || text.includes('confirm')) return 'pending';
  if (text.startsWith('3') || text.includes('completed') || text.includes('success')) {
    return 'completed';
  }
  if (text.includes('revok') || text.includes('cancel')) return 'canceled';
  if (text.includes('fail') || text.includes('reject') || text.includes('risk')) {
    return 'failed';
  }
  if (text.includes('pending')) return 'pending';
  if (text.includes('processing') || text.includes('remit')) return 'processing';
  return 'unknown';
}

function normalizeHotcoinTransfer(
  venueId: string,
  direction: 'deposit' | 'withdrawal',
  row: Record<string, unknown>,
): TransferRecord {
  const id = firstString(row, ['id', 'recordId', 'withdrawId']) ?? '';
  const currency = (firstString(row, ['currency', 'coin', 'symbol']) ?? '').toUpperCase();
  const network = firstString(row, ['chain', 'network']);
  const address = firstString(row, ['address']);
  const tag = firstString(row, ['addressTag', 'tag', 'memo']);
  const txId = firstString(row, ['txId', 'txid', 'transactionId']);
  const amount = firstDecimal(row, ['amount', 'quantity']) ?? ZERO;
  const fee = firstDecimal(row, ['fee', 'fees']);
  const createdAt = numberOrUndefined(row.createdAt ?? row.createTime ?? row.timestamp);
  const updatedAt = numberOrUndefined(row.updatedAt ?? row.updateTime);
  return {
    venueId,
    id,
    direction,
    currency,
    amount,
    status: normalizeHotcoinTransferStatus(direction, row.status),
    ...(network ? { network } : {}),
    ...(address ? { address } : {}),
    ...(tag ? { tag: normalizeAddressTag(tag) } : {}),
    ...(txId ? { txId } : {}),
    ...(fee !== undefined ? { fee } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    raw: row,
  };
}

function hotcoinTransferMatches(record: TransferRecord, query: TransferQuery): boolean {
  if (
    query.currency &&
    normalizeTransferCurrency(record.currency) !== normalizeTransferCurrency(query.currency)
  ) {
    return false;
  }
  if (query.id && record.id !== query.id) return false;
  if (query.txId && !transactionIdsMatch(record.txId, query.txId)) return false;
  if (query.network && !networksMatch(record.network, query.network)) return false;
  return true;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value
      .map(recordOrUndefined)
      .filter((row): row is Record<string, unknown> => Boolean(row));
  }
  const record = recordOrUndefined(value);
  if (!record) return [];
  for (const key of [
    'list',
    'rows',
    'wallet',
    'assets',
    'balances',
    'entrusts',
    'entrustsCur',
    'entrustsHis',
  ]) {
    if (!(key in record)) continue;
    if (Array.isArray(record[key])) return asRecords(record[key]);
    const nested = asRecords(record[key]);
    if (nested.length > 0) return nested;
  }
  return [record];
}

function decodeSocketMessage(data: RawData): string {
  const raw = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data);
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return gunzipSync(raw).toString('utf8');
  }
  return raw.toString('utf8');
}

export class HotcoinAdapter implements CexAdapter {
  readonly venueId: string;
  readonly tier: VenueTier;
  readonly capabilities: VenueCapabilities;
  readonly #baseUrl: string;
  readonly #wsUrl: string;
  readonly #signHost: string;
  readonly #httpClient: HotcoinHttpClient;
  readonly #webSocketFactory: HotcoinWebSocketFactory;
  readonly #runtime?: AdapterRuntime;
  readonly #readOnly: boolean;
  readonly #clock: () => number;
  readonly #connectTimeoutMs: number;
  readonly #agent: Agent | undefined;
  readonly #controllers = new Set<AbortController>();
  readonly #sockets = new Set<HotcoinWebSocketLike>();
  #clockOffsetMs = 0;
  #consecutiveFailures = 0;
  #closed = false;

  constructor(options: HotcoinAdapterOptions = {}) {
    this.venueId = options.venueId ?? 'hotcoin';
    this.tier = options.tier ?? 'S';
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
    this.#signHost = options.signHost ?? DEFAULT_SIGN_HOST;
    this.#agent = proxyAgent(options.proxyUrl);
    this.#clock = options.clock ?? Date.now;
    this.#connectTimeoutMs = Math.max(1000, options.connectTimeoutMs ?? 15_000);
    const timeoutMs = Math.max(1000, options.requestTimeoutMs ?? 15_000);
    this.#httpClient = options.httpClient ?? createNodeHttpClient(this.#agent, timeoutMs);
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    if (options.runtime) this.#runtime = options.runtime;
    this.#readOnly = options.readOnly ?? true;
    this.capabilities = {
      publicMarketData: true,
      orderBook: true,
      privateBalances: Boolean(options.credentials),
      createOrder: Boolean(options.credentials) && !this.#readOnly,
      fetchOrder: Boolean(options.credentials) && !this.#readOnly,
      cancelOrder: Boolean(options.credentials) && !this.#readOnly,
      depositAddress: Boolean(options.credentials),
      depositHistory: Boolean(options.credentials),
      withdrawalHistory: Boolean(options.credentials),
      createWithdrawal: Boolean(options.credentials) && !this.#readOnly,
      websocket: true,
      ioc: options.supportsIoc ?? false,
      fok: options.supportsFok ?? false,
    };
  }

  private ensureOpen(): void {
    if (this.#closed) throw new Error('Hotcoin adapter is closed');
  }

  private updateClockOffset(
    serverTime: number | undefined,
    startedAt: number,
    endedAt: number,
  ): void {
    if (serverTime === undefined || !Number.isFinite(serverTime)) return;
    const candidate = serverTime - (startedAt + endedAt) / 2;
    if (Math.abs(candidate) <= 5 * 60_000) this.#clockOffsetMs = candidate;
  }

  private serverToLocal(serverTime: number | undefined): number | undefined {
    return serverTime === undefined ? undefined : serverTime - this.#clockOffsetMs;
  }

  private async requestEnvelope<T>(
    path: string,
    params: Readonly<Record<string, string | number | boolean | undefined>>,
    credentials?: ApiCredentials,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<{ envelope: HotcoinEnvelope<T>; serverTime?: number }> {
    this.ensureOpen();
    const normalized = normalizeParams(params);
    const signed = credentials !== undefined;
    const priority = signed ? 'execution' : 'normal';
    await this.#runtime?.rateLimiter.acquire(priority, signed);
    let query: string;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'ExchangeArbitrageTools/0.1',
    };
    if (method === 'POST') headers['Content-Length'] = '0';
    if (signed) {
      const timestamp = new Date(this.#clock() + this.#clockOffsetMs).toISOString();
      const signingParams: Record<string, string> = {
        ...normalized,
        AccessKeyId: credentials.apiKey,
        SignatureMethod: 'HmacSHA256',
        SignatureVersion: '2',
        Timestamp: timestamp,
      };
      const canonical = queryString(signingParams);
      signingParams.Signature = hotcoinSignature(
        credentials.secret,
        method,
        this.#signHost,
        path,
        canonical,
      );
      query = queryString(signingParams);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (credentials.password) headers['XH-PASSPHRASE'] = credentials.password;
    } else {
      query = queryString(normalized);
    }
    const url = `${this.#baseUrl}${path}${query ? `?${query}` : ''}`;
    const startedAt = this.#clock();
    try {
      const response = await this.#httpClient({ method, url, headers });
      const body = await response.text();
      const endedAt = this.#clock();
      if (response.status < 200 || response.status >= 300) {
        const error = new Error(
          `Hotcoin HTTP ${response.status}: ${body.slice(0, 200)}`,
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      let envelope: HotcoinEnvelope<T>;
      try {
        envelope = JSON.parse(body) as HotcoinEnvelope<T>;
      } catch {
        throw new Error('Hotcoin returned invalid JSON');
      }
      const statusText = envelope.status?.toLowerCase();
      if (
        (envelope.code !== undefined && envelope.code !== 200) ||
        (statusText !== undefined &&
          statusText !== 'ok' &&
          statusText !== 'success' &&
          statusText !== '0')
      ) {
        const error = new Error(
          `Hotcoin API ${envelope.code ?? statusText}: ${envelope.msg ?? 'unknown error'}`,
        ) as Error & { status?: number; code?: number };
        if (envelope.code !== undefined) error.code = envelope.code;
        throw error;
      }
      const serverTime = numberOrUndefined(envelope.time ?? envelope.timestamp);
      this.updateClockOffset(serverTime, startedAt, endedAt);
      const recovered = this.#consecutiveFailures > 0;
      this.#consecutiveFailures = 0;
      this.#runtime?.onSuccess?.(endedAt - startedAt);
      if (recovered) this.#runtime?.onRecover?.();
      return {
        envelope,
        ...(serverTime !== undefined ? { serverTime } : {}),
      };
    } catch (error) {
      const endedAt = this.#clock();
      const status = numberOrUndefined((error as { status?: unknown }).status);
      const code = numberOrUndefined((error as { code?: unknown }).code);
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited =
        status === 418 ||
        status === 429 ||
        code === 418 ||
        code === 429 ||
        /rate.?limit|too many|429/i.test(message);
      const transient =
        rateLimited ||
        (status ?? 0) >= 500 ||
        /timeout|timed out|network|socket|econn|enotfound|eai_again|fetch failed|connection reset/i.test(
          message,
        );
      this.#consecutiveFailures = Math.min(this.#consecutiveFailures + 1, 6);
      this.#runtime?.onFailure?.(endedAt - startedAt, rateLimited);
      if (transient) {
        const retryAfterMs = rateLimited
          ? 1000
          : Math.min(60_000, 1000 * 2 ** (this.#consecutiveFailures - 1));
        this.#runtime?.rateLimiter.respectRetryAfter(retryAfterMs);
        this.#runtime?.onBackoff?.({
          backoffUntil: endedAt + retryAfterMs,
          retryAfterMs,
          reason: message,
          consecutiveFailures: this.#consecutiveFailures,
          rateLimited,
        });
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    params: Readonly<Record<string, string | number | boolean | undefined>>,
    credentials?: ApiCredentials,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<{ data: T; serverTime?: number }> {
    const { envelope, serverTime } = await this.requestEnvelope<T>(
      path,
      params,
      credentials,
      method,
    );
    return {
      data: envelope.data as T,
      ...(serverTime !== undefined ? { serverTime } : {}),
    };
  }

  async loadMarkets(): Promise<MarketMetadata[]> {
    const result = await this.request<HotcoinSymbol[]>('/v1/common/symbols', {});
    const symbols = Array.isArray(result.data) ? result.data : [];
    const markets: MarketMetadata[] = [];
    for (const symbol of symbols) {
      if (!symbol || symbol.state !== 'enable') continue;
      const baseUnits = resolveBaseUnits(symbol.baseCurrency);
      const pricePrecision = numberOrUndefined(symbol.pricePrecision);
      const amountPrecision = numberOrUndefined(symbol.amountPrecision);
      if (pricePrecision === undefined || amountPrecision === undefined) continue;
      const minNotional = decimalOrUndefined(symbol.minOrderAmount);
      const minAmount = decimalOrUndefined(symbol.minOrderCount);
      markets.push({
        venueId: this.venueId,
        exchangeSymbol: symbol.symbol,
        unifiedSymbol: `${baseUnits.base}/${symbol.quoteCurrency.toUpperCase()}`,
        base: baseUnits.base,
        ...(baseUnits.alias
          ? { exchangeBase: symbol.baseCurrency.trim(), baseMultiplier: baseUnits.multiplier }
          : {}),
        quote: symbol.quoteCurrency.toUpperCase(),
        active: true,
        pricePrecision,
        amountPrecision,
        amountStep: new Decimal(10).pow(-amountPrecision),
        priceStep: new Decimal(10).pow(-pricePrecision),
        ...(minNotional?.gt(0) ? { minNotional } : {}),
        ...(minAmount?.gt(0) ? { minAmount } : {}),
        supportsIoc: this.capabilities.ioc,
        supportsFok: this.capabilities.fok,
      });
    }
    return markets;
  }

  async fetchTickers(): Promise<TickerSnapshot[]> {
    const { envelope } = await this.requestEnvelope<unknown>('/v1/market/ticker', {});
    const rows = Array.isArray(envelope.ticker)
      ? envelope.ticker
      : Array.isArray(envelope.data)
        ? envelope.data
        : [];
    const fetchedAt = this.#clock();
    const envelopeTimestamp = numberOrUndefined(envelope.timestamp);
    return rows.flatMap((value) => {
      const row = recordOrUndefined(value);
      if (!row) return [];
      const symbol = firstString(row, ['symbol', 'exchangeSymbol']);
      if (!symbol) return [];
      const last = firstDecimal(row, ['last', 'close', 'price']);
      const bid = firstDecimal(row, ['buy', 'bid']);
      const ask = firstDecimal(row, ['sell', 'ask']);
      const baseVolume = firstDecimal(row, ['vol', 'baseVolume', 'volume']);
      const quoteVolume = firstDecimal(row, ['amount', 'quoteVolume', 'turnover']);
      const rawTimestamp =
        numberOrUndefined(row.ts ?? row.timestamp) ?? envelopeTimestamp ?? fetchedAt;
      const timestamp = rawTimestamp < 1e11 ? rawTimestamp * 1000 : rawTimestamp;
      return [
        {
          venueId: this.venueId,
          exchangeSymbol: symbol,
          ...(last !== undefined ? { last } : {}),
          ...(bid !== undefined ? { bid } : {}),
          ...(ask !== undefined ? { ask } : {}),
          ...(baseVolume !== undefined ? { baseVolume } : {}),
          ...(quoteVolume !== undefined ? { quoteVolume } : {}),
          timestamp,
        },
      ];
    });
  }

  async fetchOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot> {
    if (!Number.isInteger(depth) || depth <= 0) throw new Error('depth must be a positive integer');
    const response = await this.request<{ depth?: HotcoinDepthLevels }>('/v1/depth', { symbol });
    const depthData = recordOrUndefined(response.data?.depth) ?? recordOrUndefined(response.data);
    if (!depthData) throw new Error('Hotcoin depth response is malformed');
    const receivedAt = this.#clock();
    return this.makeBook(symbol, depthData, depth, 'rest', response.serverTime, receivedAt);
  }

  private makeBook(
    symbol: string,
    depthData: Record<string, unknown>,
    depth: number,
    source: 'rest' | 'websocket',
    exchangeTimestamp: number | undefined,
    receivedAt: number,
  ): OrderBookSnapshot {
    const asks = sortLevels(depthData.asks, 'asks').slice(0, depth);
    const bids = sortLevels(depthData.bids, 'bids').slice(0, depth);
    const localTimestamp = this.serverToLocal(exchangeTimestamp);
    return {
      venueId: this.venueId,
      exchangeSymbol: symbol,
      fetchedAt: receivedAt,
      receivedAt,
      ...(localTimestamp !== undefined ? { exchangeTimestamp: localTimestamp } : {}),
      asks,
      bids,
      source,
    };
  }

  async watchOrderBook(
    symbol: string,
    depth: number,
    onBook: (book: OrderBookSnapshot) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.ensureOpen();
    if (!Number.isInteger(depth) || depth <= 0) throw new Error('depth must be a positive integer');
    if (signal?.aborted) return;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.#controllers.add(controller);
    try {
      await this.runDepthSocket(symbol, depth, onBook, controller.signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#controllers.delete(controller);
    }
  }

  private runDepthSocket(
    symbol: string,
    depth: number,
    onBook: (book: OrderBookSnapshot) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const topic = `market.${symbol.toLowerCase()}.trade.depth`;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sawMessage = false;
      let socket: HotcoinWebSocketLike | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (socket) {
          this.#sockets.delete(socket);
          try {
            socket.close();
          } catch {
            // ignore close errors
          }
        }
        if (signal.aborted) resolve();
        else if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error('Hotcoin WebSocket connection timeout')),
        this.#connectTimeoutMs,
      );
      try {
        socket = this.#webSocketFactory(this.#wsUrl, this.#agent ? { agent: this.#agent } : {});
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.#sockets.add(socket);
      const onAbort = (): void => {
        finish();
        try {
          socket?.terminate?.();
        } catch {
          // ignore terminate errors
        }
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('open', () => {
        try {
          socket?.send(JSON.stringify({ sub: topic }));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on('message', (data) => {
        if (settled) return;
        let message: Record<string, unknown>;
        try {
          const parsed = JSON.parse(decodeSocketMessage(data)) as unknown;
          const record = recordOrUndefined(parsed);
          if (!record) return;
          message = record;
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (firstString(message, ['ping']) !== undefined) {
          try {
            socket?.send(JSON.stringify({ pong: 'pong' }));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        const channel = firstString(message, ['ch']);
        if (
          channel === topic &&
          numberOrUndefined(message.code) !== undefined &&
          numberOrUndefined(message.code) !== 200
        ) {
          finish(
            new Error(`Hotcoin WebSocket error: ${firstString(message, ['msg']) ?? 'unknown'}`),
          );
          return;
        }
        const payload = recordOrUndefined(message.data);
        if (!payload || (!Array.isArray(payload.asks) && !Array.isArray(payload.bids))) return;
        sawMessage = true;
        clearTimeout(timer);
        const receivedAt = this.#clock();
        const messageTime = numberOrUndefined(message.ts);
        const depthDate = numberOrUndefined(payload.date);
        const serverTime = messageTime ?? (depthDate !== undefined ? depthDate * 1000 : undefined);
        try {
          onBook(this.makeBook(symbol, payload, depth, 'websocket', serverTime, receivedAt));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', (code, reason) => {
        if (signal.aborted) finish();
        else if (!sawMessage)
          finish(new Error(`Hotcoin WebSocket closed before data: ${code} ${String(reason)}`));
        else finish(new Error(`Hotcoin WebSocket closed: ${code} ${String(reason)}`));
      });
    });
  }

  async fetchBalances(keys: ApiCredentials): Promise<BalanceSnapshot[]> {
    if (!this.capabilities.privateBalances) {
      throw new Error('Hotcoin adapter has no private credentials');
    }
    let data: unknown;
    try {
      data = (await this.request<unknown>('/v3/balance', {}, keys)).data;
    } catch {
      data = (await this.request<unknown>('/v1/balance', {}, keys)).data;
    }
    const rows = asRecords(recordOrUndefined(data)?.wallet ?? data);
    const fetchedAt = this.#clock();
    return rows
      .map((row): BalanceSnapshot | undefined => {
        const currency = firstString(row, ['currency', 'coinName', 'symbol', 'shortName', 'coin']);
        if (!currency) return undefined;
        const freeField = firstDecimal(row, ['free', 'available', 'normal']);
        const totalField = firstDecimal(row, ['total', 'balance']);
        const usedField = firstDecimal(row, ['frozen', 'locked', 'used']);
        let free = freeField ?? ZERO;
        let used = usedField ?? ZERO;
        let total: Decimal;
        if (totalField !== undefined) {
          total = totalField;
          if (freeField === undefined) free = Decimal.max(0, total.minus(used));
          else if (usedField === undefined) used = Decimal.max(0, total.minus(free));
        } else {
          total = free.plus(used);
        }
        const accountId = firstString(row, ['uid', 'accountId', 'account_id']) ?? 'default';
        return {
          venueId: this.venueId,
          accountId,
          currency: currency.toUpperCase(),
          free,
          used,
          total,
          fetchedAt,
        };
      })
      .filter((row): row is BalanceSnapshot => Boolean(row));
  }

  async fetchDepositAddress(
    currency: string,
    network: string,
    keys: ApiCredentials,
  ): Promise<DepositAddress> {
    if (!this.capabilities.depositAddress) {
      throw new Error('Hotcoin adapter has no private credentials');
    }
    const result = await this.request<unknown>(
      '/v1/asset/deposit/address',
      { currency: currency.toUpperCase() },
      keys,
    );
    const rows = asRecords(result.data);
    const candidates = rows.filter((row) => {
      const chain = firstString(row, ['chain', 'network']);
      return chain ? networksMatch(chain, network) : false;
    });
    if (candidates.length === 0) {
      throw new Error(`Hotcoin has no deposit address for ${currency} on ${network}`);
    }
    const selected = candidates.find(
      (row) =>
        row.selected === true ||
        row.selected === 1 ||
        String(row.selected ?? '').toLowerCase() === 'true' ||
        String(row.selected ?? '') === '1',
    );
    if (!selected && candidates.length > 1) {
      throw new Error(`Hotcoin deposit address is ambiguous for ${currency} on ${network}`);
    }
    const row = selected ?? candidates[0]!;
    const address = firstString(row, ['address']);
    if (!address) throw new Error('Hotcoin deposit address response is missing address');
    const chain = firstString(row, ['chain', 'network']);
    if (!chain) throw new Error('Hotcoin deposit address response is missing chain');
    const tag = firstString(row, ['addressTag', 'tag', 'memo']);
    return {
      venueId: this.venueId,
      currency: currency.toUpperCase(),
      network: chain,
      address,
      ...(tag ? { tag: normalizeAddressTag(tag) } : {}),
      fetchedAt: this.#clock(),
      raw: row,
    };
  }

  async fetchDeposits(query: TransferQuery, keys: ApiCredentials): Promise<TransferRecord[]> {
    if (!this.capabilities.depositHistory) {
      throw new Error('Hotcoin adapter has no private credentials');
    }
    const result = await this.request<unknown>(
      '/v1/asset/deposit/history',
      {
        currency: query.currency.toUpperCase(),
        pageNum: 1,
        limit: query.limit ?? 100,
        direct: 'prev',
      },
      keys,
    );
    return asRecords(result.data)
      .map((row) => normalizeHotcoinTransfer(this.venueId, 'deposit', row))
      .filter((record) => hotcoinTransferMatches(record, query));
  }

  async fetchWithdrawals(query: TransferQuery, keys: ApiCredentials): Promise<TransferRecord[]> {
    if (!this.capabilities.withdrawalHistory) {
      throw new Error('Hotcoin adapter has no private credentials');
    }
    const result = await this.request<unknown>(
      '/v1/asset/withdrawal/history',
      {
        currency: query.currency.toUpperCase(),
        pageNum: 1,
        limit: query.limit ?? 100,
        direct: 'prev',
      },
      keys,
    );
    return asRecords(result.data)
      .map((row) => normalizeHotcoinTransfer(this.venueId, 'withdrawal', row))
      .filter((record) => hotcoinTransferMatches(record, query));
  }

  async createWithdrawal(
    request: WithdrawalRequest,
    keys: ApiCredentials,
  ): Promise<WithdrawalSubmission> {
    if (!this.capabilities.createWithdrawal) {
      throw new Error('Hotcoin adapter is read-only or missing withdrawal credentials');
    }
    if (!request.amount.gt(0)) throw new Error('Hotcoin withdrawal amount must be positive');
    if (!request.address.trim()) throw new Error('Hotcoin withdrawal address is required');
    const tag = normalizeAddressTag(request.tag);
    const params: Record<string, string | number | boolean | undefined> = {
      currency: request.currency.toUpperCase(),
      ...(request.network ? { chain: request.network } : {}),
      transferMode: 1,
      address: request.address.trim(),
      addressType: 0,
      amount: request.amount.toFixed(),
      ...(tag ? { addressTag: tag } : {}),
      ...(request.remark ? { remark: request.remark } : {}),
    };
    const result = await this.request<unknown>('/v1/asset/withdrawal/apply', params, keys, 'POST');
    const row = recordOrUndefined(result.data);
    const id = row
      ? firstString(row, ['id', 'recordId', 'withdrawId'])
      : stringOrUndefined(result.data);
    return {
      venueId: this.venueId,
      ...(id ? { id } : {}),
      currency: request.currency.toUpperCase(),
      ...(request.network ? { network: request.network } : {}),
      address: request.address.trim(),
      ...(tag ? { tag } : {}),
      amount: request.amount,
      status: 'pending',
      raw: result.data,
    };
  }

  async createOrder(request: OrderRequest, keys: ApiCredentials): Promise<OrderState> {
    if (!this.capabilities.createOrder) {
      throw new Error('Hotcoin adapter is read-only or missing credentials');
    }
    if (request.type === 'limit' && !request.price)
      throw new Error('Hotcoin limit order requires price');
    if (request.timeInForce === 'IOC' && !this.capabilities.ioc) {
      throw new Error('Hotcoin IOC is not enabled for this adapter');
    }
    if (request.timeInForce === 'FOK' && !this.capabilities.fok) {
      throw new Error('Hotcoin FOK is not enabled for this adapter');
    }
    const params: Record<string, string | number | boolean | undefined> = {
      symbol: request.symbol,
      type: request.side,
      tradeAmount: request.amount.toFixed(),
      ...(request.price ? { tradePrice: request.price.toFixed() } : {}),
      matchType:
        request.type === 'market'
          ? 1
          : request.timeInForce === 'FOK'
            ? 8
            : request.timeInForce === 'IOC'
              ? 9
              : 0,
      ...(request.type === 'market' ? { marketUnit: 'amount' } : {}),
      ...(request.clientOrderId ? { clientOrderId: request.clientOrderId } : {}),
    };
    const result = await this.request<unknown>('/v1/order/place', params, keys, 'POST');
    const row = recordOrUndefined(result.data);
    const venueOrderId = row
      ? firstString(row, ['ID', 'id', 'orderId', 'order_id'])
      : stringOrUndefined(result.data);
    if (!venueOrderId) throw new Error('Hotcoin order response is missing an order id');
    return {
      venueOrderId,
      ...(request.clientOrderId ? { clientOrderId: request.clientOrderId } : {}),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      ...(request.price ? { price: request.price } : {}),
      amount: request.amount,
      filled: ZERO,
      remaining: request.amount,
      status: 'open',
      raw: result.data,
    };
  }

  async fetchOrder(request: OrderQuery, keys: ApiCredentials): Promise<OrderState> {
    if (!this.capabilities.fetchOrder) {
      throw new Error('Hotcoin adapter is read-only or missing credentials');
    }
    if (request.venueOrderId) {
      const result = await this.request<unknown>(
        '/v1/order/detailById',
        { id: request.venueOrderId },
        keys,
      );
      const row = recordOrUndefined(result.data);
      if (!row) throw new Error('Hotcoin order details are empty');
      return normalizeOrder(row, request.symbol);
    }
    if (!request.clientOrderId) throw new Error('venueOrderId or clientOrderId is required');
    try {
      const direct = await this.request<unknown>(
        '/v1/order/detailByClOrdId',
        { clOrdId: request.clientOrderId },
        keys,
      );
      const row = recordOrUndefined(direct.data);
      if (row) return normalizeOrder(row, request.symbol);
    } catch (error) {
      if (/rate.?limit|429|auth|signature|permission|forbidden/i.test(String(error))) throw error;
    }
    if (!request.symbol) {
      throw new Error('symbol is required when Hotcoin direct clientOrderId lookup misses');
    }
    const pageSize = 100;
    const maxPages = 20;
    let pagesScanned = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      pagesScanned = page;
      const result = await this.request<unknown>(
        '/v1/order/entrust',
        { symbol: request.symbol, type: 0, page, count: pageSize },
        keys,
      );
      const rows = asRecords(result.data);
      const row = rows.find(
        (candidate) =>
          firstString(candidate, ['clientOrderId', 'client_order_id']) === request.clientOrderId,
      );
      if (row) return normalizeOrder(row, request.symbol);
      if (rows.length < pageSize) break;
    }
    throw new Error(
      `Hotcoin order not found for clientOrderId after ${pagesScanned} pages (fail closed)`,
    );
  }

  async cancelOrder(request: OrderQuery, keys: ApiCredentials): Promise<OrderState> {
    if (!this.capabilities.cancelOrder) {
      throw new Error('Hotcoin adapter is read-only or missing credentials');
    }
    const venueOrderId = request.venueOrderId;
    if (!venueOrderId && !request.clientOrderId) {
      throw new Error('venueOrderId or clientOrderId is required');
    }
    await this.request<unknown>(
      '/v1/order/cancel',
      venueOrderId ? { id: venueOrderId } : { clOrdId: request.clientOrderId! },
      keys,
      'POST',
    );
    return this.fetchOrder(
      {
        ...(venueOrderId ? { venueOrderId } : { clientOrderId: request.clientOrderId! }),
        ...(request.symbol ? { symbol: request.symbol } : {}),
      },
      keys,
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    for (const socket of this.#sockets) {
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
    }
    this.#sockets.clear();
  }
}

export class HotcoinReadOnlyAdapter extends HotcoinAdapter {
  constructor(options: Omit<HotcoinAdapterOptions, 'readOnly'> = {}) {
    super({ ...options, readOnly: true });
  }
}
