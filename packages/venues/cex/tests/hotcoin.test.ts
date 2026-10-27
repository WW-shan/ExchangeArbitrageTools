import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import {
  HotcoinAdapter,
  HotcoinReadOnlyAdapter,
  createPublicRuntime,
  hotcoinCanonicalQuery,
  hotcoinSignature,
  type HotcoinHttpClient,
  type HotcoinHttpRequest,
  type HotcoinWebSocketLike,
} from '../src/index.js';

const keys = { apiKey: 'key', secret: 'secret', password: 'passphrase' };
const now = Date.parse('2026-10-27T00:00:00.000Z');

function response(body: unknown, status = 200) {
  return {
    status,
    headers: {},
    text: async () => JSON.stringify(body),
  };
}

function clientWith(handler: (request: HotcoinHttpRequest) => unknown): {
  client: HotcoinHttpClient;
  requests: HotcoinHttpRequest[];
} {
  const requests: HotcoinHttpRequest[] = [];
  const client: HotcoinHttpClient = async (request) => {
    requests.push(request);
    return response(handler(request));
  };
  return { client, requests };
}

function depthPayload() {
  return {
    code: 200,
    msg: 'success',
    time: now - 100,
    data: {
      depth: {
        date: Math.floor((now - 100) / 1000),
        asks: [
          ['2.12', '3'],
          ['2.11', '2'],
          ['2.13', '4'],
        ],
        bids: [
          ['2.10', '5'],
          ['2.09', '6'],
          ['2.11', '1'],
        ],
      },
    },
  };
}

function detailRow(statusCode: number) {
  return {
    id: 12345,
    symbol: 'cake_usdt',
    types: 'buy',
    price: '2.10',
    count: '10',
    leftcount: '4',
    successamount: '6',
    fees: '0.01',
    statusCode,
    status: 'test',
    clientOrderId: 'batch-L1',
  };
}

describe('Hotcoin public market adapter', () => {
  it('normalizes enabled symbols and preserves the 15 USDT minimum notional', async () => {
    const { client } = clientWith(() => ({
      code: 200,
      msg: 'ok',
      time: now,
      data: [
        {
          baseCurrency: 'cake',
          quoteCurrency: 'usdt',
          symbol: 'cake_usdt',
          pricePrecision: 3,
          amountPrecision: 2,
          minOrderAmount: '15',
          minOrderCount: '0',
          state: 'enable',
        },
        {
          baseCurrency: 'eth',
          quoteCurrency: 'usdt',
          symbol: 'eth_usdt',
          pricePrecision: 2,
          amountPrecision: 4,
          minOrderAmount: '15',
          minOrderCount: '0',
          state: 'disable',
        },
      ],
    }));
    const adapter = new HotcoinReadOnlyAdapter({ httpClient: client, clock: () => now });
    const markets = await adapter.loadMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({
      venueId: 'hotcoin',
      exchangeSymbol: 'cake_usdt',
      unifiedSymbol: 'CAKE/USDT',
      base: 'CAKE',
      quote: 'USDT',
      supportsIoc: false,
      supportsFok: false,
    });
    expect(markets[0]?.minNotional?.toFixed()).toBe('15');
    expect(markets[0]?.amountStep?.toFixed()).toBe('0.01');
    expect(markets[0]?.priceStep?.toFixed()).toBe('0.001');
  });

  it('parses REST depth, sorts levels, truncates depth, and corrects server clock offset', async () => {
    const { client } = clientWith(() => depthPayload());
    const adapter = new HotcoinReadonlyForTest(client);
    const book = await adapter.fetchOrderBook('cake_usdt', 2);
    expect(book.source).toBe('rest');
    expect(book.asks.map((level) => level.price.toFixed())).toEqual(['2.11', '2.12']);
    expect(book.bids.map((level) => level.price.toFixed())).toEqual(['2.11', '2.1']);
    expect(book.exchangeTimestamp).toBe(now);
    expect(book.fetchedAt).toBe(now);
  });

  it('normalizes the public bulk ticker feed for volume-ranked discovery', async () => {
    const { client, requests } = clientWith(() => ({
      status: 'ok',
      timestamp: now,
      ticker: [
        {
          symbol: 'cake_usdt',
          last: '2.12',
          buy: '2.119',
          sell: '2.122',
          vol: '223490.87',
          amount: '474017.17',
          ts: now - 100,
        },
      ],
    }));
    const adapter = new HotcoinReadOnlyAdapter({ httpClient: client, clock: () => now });
    const tickers = await adapter.fetchTickers();
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/market/ticker');
    expect(tickers).toEqual([
      {
        venueId: 'hotcoin',
        exchangeSymbol: 'cake_usdt',
        last: expect.anything(),
        bid: expect.anything(),
        ask: expect.anything(),
        baseVolume: expect.anything(),
        quoteVolume: expect.anything(),
        timestamp: now - 100,
      },
    ]);
    expect(tickers[0]?.quoteVolume?.toFixed()).toBe('474017.17');
    expect(tickers[0]?.baseVolume?.toFixed()).toBe('223490.87');
  });

  it('classifies HTTP 429 as a rate-limit backoff instead of a generic error', async () => {
    const client: HotcoinHttpClient = async () => ({
      status: 429,
      headers: {},
      text: async () => 'too many requests',
    });
    const backoffs: Array<{ rateLimited: boolean; retryAfterMs: number }> = [];
    const adapter = new HotcoinReadOnlyAdapter({
      httpClient: client,
      clock: () => now,
      runtime: createPublicRuntime(2, undefined, {
        onBackoff: (state) =>
          backoffs.push({ rateLimited: state.rateLimited, retryAfterMs: state.retryAfterMs }),
      }),
    });
    await expect(adapter.fetchOrderBook('cake_usdt', 5)).rejects.toThrow(/HTTP 429/);
    expect(backoffs).toEqual([{ rateLimited: true, retryAfterMs: 1000 }]);
  });

  it('uses the corrected server time for signed request timestamps', async () => {
    const { client, requests } = clientWith((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/depth') {
        return { ...depthPayload(), time: now - 5000 };
      }
      return { code: 200, msg: 'success', time: now, data: { wallet: [] } };
    });
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: true,
      clock: () => now,
    });
    await adapter.fetchOrderBook('cake_usdt', 2);
    await adapter.fetchBalances(keys);
    const signed = new URL(requests[1]!.url);
    expect(signed.pathname).toBe('/v3/balance');
    expect(signed.searchParams.get('Timestamp')).toBe(new Date(now - 5000).toISOString());
  });

  it('decodes gzip WebSocket depth and publishes sorted snapshots', async () => {
    const depth = {
      code: 200,
      msg: 'SUCCESS',
      status: 'ok',
      ts: now,
      ch: 'market.cake_usdt.trade.depth',
      data: {
        asks: [
          ['2.12', '3'],
          ['2.11', '2'],
        ],
        bids: [
          ['2.10', '5'],
          ['2.11', '1'],
        ],
      },
    };
    let fake: FakeSocket | undefined;
    const adapter = new HotcoinReadOnlyAdapter({
      clock: () => now,
      webSocketFactory: () => {
        fake = new FakeSocket();
        return fake as unknown as HotcoinWebSocketLike;
      },
    });
    const controller = new AbortController();
    const books: Array<{ asks: string[]; bids: string[]; exchangeTimestamp?: number }> = [];
    const watched = adapter.watchOrderBook(
      'cake_usdt',
      5,
      (book) => {
        books.push({
          asks: book.asks.map((level) => level.price.toFixed()),
          bids: book.bids.map((level) => level.price.toFixed()),
          ...(book.exchangeTimestamp !== undefined
            ? { exchangeTimestamp: book.exchangeTimestamp }
            : {}),
        });
        controller.abort();
      },
      controller.signal,
    );
    expect(fake).toBeDefined();
    fake!.emit('open');
    fake!.emit('message', gzipSync(JSON.stringify({ ping: 12345 })), true);
    fake!.emit('message', gzipSync(JSON.stringify(depth)), true);
    await watched;
    expect(books).toEqual([
      { asks: ['2.11', '2.12'], bids: ['2.11', '2.1'], exchangeTimestamp: now },
    ]);
    expect(fake!.sent.map((value) => JSON.parse(value))).toContainEqual({
      sub: 'market.cake_usdt.trade.depth',
    });
    expect(fake!.sent.map((value) => JSON.parse(value))).toContainEqual({ pong: 'pong' });
  });
});

describe('Hotcoin private adapter', () => {
  it('builds the documented HMAC query signature', () => {
    const canonical = hotcoinCanonicalQuery({
      SignatureVersion: '2',
      Timestamp: '2026-10-27T00:00:00.000Z',
      SignatureMethod: 'HmacSHA256',
      AccessKeyId: 'key',
    });
    expect(canonical).toBe(
      'AccessKeyId=key&SignatureMethod=HmacSHA256&SignatureVersion=2&Timestamp=2026-10-27T00%3A00%3A00.000Z',
    );
    expect(hotcoinSignature('secret', 'GET', 'api.hotcoinfin.com', '/v1/balance', canonical)).toBe(
      'BVd72wt6KBCnN5Dv38/1r5Uy2qacwQki4WLWGyAzVXo=',
    );
  });

  it('reads balances from v3 and falls back to the documented v1 endpoint', async () => {
    const { client, requests } = clientWith((request) => {
      if (request.url.includes('/v3/balance')) {
        return { code: 300, msg: 'not found', time: now, data: null };
      }
      return {
        code: 200,
        msg: 'success',
        time: now,
        data: {
          wallet: [
            {
              uid: 1001,
              coinName: 'USDT',
              total: '20',
              frozen: '1.5',
            },
            {
              uid: 1001,
              coinName: 'CAKE',
              free: '10',
              frozen: '2',
              total: '12',
            },
          ],
        },
      };
    });
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: true,
      clock: () => now,
    });
    const balances = await adapter.fetchBalances(keys);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v3/balance',
      '/v1/balance',
    ]);
    expect(balances.find((row) => row.currency === 'USDT')).toMatchObject({
      accountId: '1001',
      free: expect.anything(),
      used: expect.anything(),
      total: expect.anything(),
    });
    expect(balances.find((row) => row.currency === 'USDT')?.free.toFixed()).toBe('18.5');
    expect(balances.find((row) => row.currency === 'USDT')?.used.toFixed()).toBe('1.5');
    expect(balances.find((row) => row.currency === 'USDT')?.total.toFixed()).toBe('20');
    expect(balances.find((row) => row.currency === 'CAKE')?.total.toFixed()).toBe('12');
  });

  it('maps documented order status codes and fills', async () => {
    const { client } = clientWith(() => ({
      code: 200,
      msg: 'success',
      time: now,
      data: detailRow(3),
    }));
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: false,
      clock: () => now,
    });
    const order = await adapter.fetchOrder({ venueOrderId: '12345', symbol: 'cake_usdt' }, keys);
    expect(order).toMatchObject({
      venueOrderId: '12345',
      clientOrderId: 'batch-L1',
      symbol: 'cake_usdt',
      side: 'buy',
      amount: expect.anything(),
      filled: expect.anything(),
      remaining: expect.anything(),
      status: 'closed',
    });
    expect(order.amount.toFixed()).toBe('10');
    expect(order.filled.toFixed()).toBe('6');
    expect(order.remaining.toFixed()).toBe('4');
  });

  it('uses successamount when leftcount is absent', async () => {
    const { leftcount: _leftcount, ...row } = detailRow(3);
    const { client } = clientWith(() => ({
      code: 200,
      msg: 'success',
      time: now,
      data: row,
    }));
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: false,
      clock: () => now,
    });
    const order = await adapter.fetchOrder({ venueOrderId: '12345', symbol: 'cake_usdt' }, keys);
    expect(order.filled.toFixed()).toBe('6');
    expect(order.remaining.toFixed()).toBe('4');
  });

  it('paginates clientOrderId lookups before failing closed', async () => {
    const { client, requests } = clientWith((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/order/detailByClOrdId') {
        return { code: 200, msg: 'not found', time: now, data: null };
      }
      expect(url.pathname).toBe('/v1/order/entrust');
      const page = Number(url.searchParams.get('page'));
      const rows =
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              ...detailRow(1),
              id: index + 1,
              clientOrderId: `other-${index}`,
            }))
          : [detailRow(3)];
      return { code: 200, msg: 'success', time: now, data: rows };
    });
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: false,
      clock: () => now,
    });
    const order = await adapter.fetchOrder(
      { clientOrderId: 'batch-L1', symbol: 'cake_usdt' },
      keys,
    );
    expect(order.venueOrderId).toBe('12345');
    expect(requests).toHaveLength(3);
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/order/detailByClOrdId');
    expect(new URL(requests[1]!.url).searchParams.get('page')).toBe('1');
    expect(new URL(requests[2]!.url).searchParams.get('page')).toBe('2');
  });

  it('uses the official detailByClOrdId endpoint before paginating', async () => {
    const { client, requests } = clientWith((request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/v1/order/detailByClOrdId');
      expect(url.searchParams.get('clOrdId')).toBe('batch-L1');
      return { code: 200, msg: 'success', time: now, data: detailRow(3) };
    });
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: false,
      clock: () => now,
    });
    const order = await adapter.fetchOrder({ clientOrderId: 'batch-L1' }, keys);
    expect(order.venueOrderId).toBe('12345');
    expect(requests).toHaveLength(1);
  });

  it('cancels by clOrdId when the venue order id is not known yet', async () => {
    const { client, requests } = clientWith((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/v1/order/cancel') {
        expect(url.searchParams.get('clOrdId')).toBe('batch-L1');
        return { code: 200, msg: 'success', time: now, data: true };
      }
      if (url.pathname === '/v1/order/detailByClOrdId') {
        expect(url.searchParams.get('clOrdId')).toBe('batch-L1');
        return { code: 200, msg: 'success', time: now, data: { ...detailRow(5), leftcount: '10' } };
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: false,
      clock: () => now,
    });
    const order = await adapter.cancelOrder({ clientOrderId: 'batch-L1' }, keys);
    expect(order.status).toBe('canceled');
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/order/cancel',
      '/v1/order/detailByClOrdId',
    ]);
  });

  it('places FOK limit orders with matchType=8 and the exact client id', async () => {
    const { client, requests } = clientWith(() => ({
      code: 200,
      msg: 'order success',
      time: now,
      data: { ID: 98765 },
    }));
    const adapter = new HotcoinAdapter({
      httpClient: client,
      credentials: keys,
      readOnly: false,
      supportsFok: true,
      clock: () => now,
    });
    const order = await adapter.createOrder(
      {
        symbol: 'cake_usdt',
        side: 'buy',
        type: 'limit',
        amount: new Decimal('5'),
        price: new Decimal('2.10'),
        timeInForce: 'FOK',
        clientOrderId: 'S1-1-1-L1',
      },
      keys,
    );
    expect(order.venueOrderId).toBe('98765');
    expect(order.status).toBe('open');
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe('/v1/order/place');
    expect(url.searchParams.get('matchType')).toBe('8');
    expect(url.searchParams.get('clientOrderId')).toBe('S1-1-1-L1');
    expect(url.searchParams.get('tradePrice')).toBe('2.1');
    expect(url.searchParams.get('Signature')).toBeTruthy();
    expect(url.searchParams.get('XH-PASSPHRASE')).toBeNull();
    expect(requests[0]!.headers['XH-PASSPHRASE']).toBe('passphrase');
  });

  it('rejects order placement on a read-only adapter', async () => {
    const adapter = new HotcoinReadOnlyAdapter({ clock: () => now });
    await expect(
      adapter.createOrder(
        {
          symbol: 'cake_usdt',
          side: 'buy',
          type: 'limit',
          amount: new Decimal('5'),
          price: new Decimal('2.10'),
          clientOrderId: 'x',
        },
        keys,
      ),
    ).rejects.toThrow(/read-only/);
  });

  it('rejects FOK before the venue capability is explicitly enabled', async () => {
    const adapter = new HotcoinAdapter({
      clock: () => now,
      credentials: keys,
      readOnly: false,
    });
    await expect(
      adapter.createOrder(
        {
          symbol: 'cake_usdt',
          side: 'buy',
          type: 'limit',
          amount: new Decimal('5'),
          price: new Decimal('2.10'),
          timeInForce: 'FOK',
          clientOrderId: 'x',
        },
        keys,
      ),
    ).rejects.toThrow(/FOK is not enabled/);
  });
});

class HotcoinReadonlyForTest extends HotcoinReadOnlyAdapter {
  constructor(client: HotcoinHttpClient) {
    super({ httpClient: client, clock: () => now });
  }
}

class FakeSocket {
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close', 1000, Buffer.alloc(0));
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}
