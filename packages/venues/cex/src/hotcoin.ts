import {
  Decimal,
  resolveBaseUnits,
  type CurrencyMetadata,
  type MarketMetadata,
  type OrderBookSnapshot,
  type VenueTier,
} from '@arb/core';
import type { CexAdapter, VenueCapabilities } from './types.js';

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

interface HotcoinResponse<T> {
  code: number;
  msg: string;
  data: T;
}

export interface HotcoinFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type HotcoinFetch = (url: string) => Promise<HotcoinFetchResponse>;

export interface HotcoinAdapterOptions {
  venueId?: string;
  tier?: VenueTier;
  baseUrl?: string;
  fetch?: HotcoinFetch;
  orderBookProvider?: (symbol: string) => Promise<OrderBookSnapshot>;
}

/**
 * Hotcoin has no CCXT adapter. Its public symbols endpoint is verified, while
 * its REST depth response contract is not trusted. Order books must be
 * supplied by a separately verified WebSocket feed; this class deliberately
 * fails closed instead of fabricating a REST shape.
 */
export class HotcoinReadOnlyAdapter implements CexAdapter {
  readonly venueId: string;
  readonly tier: VenueTier;
  readonly capabilities: VenueCapabilities;
  readonly #baseUrl: string;
  readonly #fetch: HotcoinFetch;
  readonly #orderBookProvider?: (symbol: string) => Promise<OrderBookSnapshot>;

  constructor(options: HotcoinAdapterOptions = {}) {
    this.venueId = options.venueId ?? 'hotcoin';
    this.tier = options.tier ?? 'S';
    this.#baseUrl = options.baseUrl ?? 'https://api.hotcoinfin.com';
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as HotcoinFetch);
    if (options.orderBookProvider) this.#orderBookProvider = options.orderBookProvider;
    this.capabilities = {
      publicMarketData: true,
      orderBook: Boolean(options.orderBookProvider),
      privateBalances: false,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      websocket: Boolean(options.orderBookProvider),
      ioc: false,
      fok: false,
    };
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`);
    const body = await response.text();
    if (!response.ok) throw new Error(`Hotcoin HTTP ${response.status}: ${body.slice(0, 200)}`);
    const parsed = JSON.parse(body) as HotcoinResponse<T>;
    if (parsed.code !== 200) throw new Error(`Hotcoin API ${parsed.code}: ${parsed.msg}`);
    return parsed.data;
  }

  async loadMarkets(): Promise<MarketMetadata[]> {
    const symbols = await this.request<HotcoinSymbol[]>('/v1/common/symbols');
    return symbols
      .filter((symbol) => symbol.state === 'enable')
      .map((symbol) => {
        const baseUnits = resolveBaseUnits(symbol.baseCurrency);
        const minNotional = symbol.minOrderAmount ? new Decimal(symbol.minOrderAmount) : undefined;
        const minAmount = symbol.minOrderCount ? new Decimal(symbol.minOrderCount) : undefined;
        return {
          venueId: this.venueId,
          exchangeSymbol: symbol.symbol,
          unifiedSymbol: `${baseUnits.base}/${symbol.quoteCurrency.toUpperCase()}`,
          base: baseUnits.base,
          ...(baseUnits.alias
            ? {
                exchangeBase: symbol.baseCurrency.trim(),
                baseMultiplier: baseUnits.multiplier,
              }
            : {}),
          quote: symbol.quoteCurrency.toUpperCase(),
          active: true,
          pricePrecision: symbol.pricePrecision,
          amountPrecision: symbol.amountPrecision,
          amountStep: new Decimal(10).pow(-symbol.amountPrecision),
          priceStep: new Decimal(10).pow(-symbol.pricePrecision),
          ...(minNotional?.gt(0) ? { minNotional } : {}),
          ...(minAmount?.gt(0) ? { minAmount } : {}),
          // Fees are account-specific and must be supplied by a separate signed
          // metadata check before paper/live use.
          supportsIoc: false,
          supportsFok: false,
        };
      });
  }

  async fetchOrderBook(symbol: string): Promise<OrderBookSnapshot> {
    if (!this.#orderBookProvider) {
      throw new Error(
        'Hotcoin order-book transport is not configured; verified WebSocket feed required',
      );
    }
    return this.#orderBookProvider(symbol);
  }

  async fetchCurrencies(): Promise<CurrencyMetadata[]> {
    throw new Error('Hotcoin public currency/network endpoint is not open');
  }
}
