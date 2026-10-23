import {
  Decimal,
  TokenBucketRateLimiter,
  type Clock,
  type CurrencyMetadata,
  type MarketMetadata,
  type OrderBookSnapshot,
  type TickerSnapshot,
  type VenueTier,
} from '@arb/core';

export interface ApiCredentials {
  apiKey: string;
  secret: string;
  password?: string;
}

export interface VenueCapabilities {
  publicMarketData: boolean;
  orderBook: boolean;
  privateBalances: boolean;
  createOrder: boolean;
  fetchOrder: boolean;
  cancelOrder: boolean;
  websocket: boolean;
  ioc: boolean;
  fok: boolean;
}

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  amount: Decimal;
  price?: Decimal;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  clientOrderId: string;
}

export interface OrderState {
  venueOrderId: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  price?: Decimal;
  amount: Decimal;
  filled: Decimal;
  remaining: Decimal;
  averagePrice?: Decimal;
  fee?: Decimal;
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'unknown';
  raw: unknown;
}

export interface OrderQuery {
  venueOrderId?: string;
  clientOrderId?: string;
  symbol?: string;
}

export interface BalanceSnapshot {
  venueId: string;
  accountId: string;
  currency: string;
  free: Decimal;
  used: Decimal;
  total: Decimal;
  fetchedAt: number;
}

export interface CexAdapter {
  readonly venueId: string;
  readonly tier: VenueTier;
  readonly capabilities: VenueCapabilities;
  loadMarkets(): Promise<MarketMetadata[]>;
  fetchTickers?(): Promise<TickerSnapshot[]>;
  fetchTradingFees?(): Promise<Record<string, { takerBps?: Decimal; makerBps?: Decimal }>>;
  fetchOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot>;
  watchOrderBook?(
    symbol: string,
    depth: number,
    onBook: (book: OrderBookSnapshot) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  fetchCurrencies?(): Promise<CurrencyMetadata[]>;
  fetchBalances?(keys: ApiCredentials): Promise<BalanceSnapshot[]>;
  createOrder?(request: OrderRequest, keys: ApiCredentials): Promise<OrderState>;
  fetchOrder?(request: OrderQuery, keys: ApiCredentials): Promise<OrderState>;
  cancelOrder?(request: OrderQuery, keys: ApiCredentials): Promise<OrderState>;
  close?(): Promise<void>;
}

export interface AdapterRuntime {
  rateLimiter: TokenBucketRateLimiter;
  clock?: Clock;
  onSuccess?: (latencyMs: number) => void;
  onFailure?: (latencyMs: number, rateLimited: boolean) => void;
  onBackoff?: (state: {
    backoffUntil: number;
    retryAfterMs: number;
    reason: string;
    consecutiveFailures: number;
    rateLimited: boolean;
  }) => void;
  onRecover?: () => void;
}
