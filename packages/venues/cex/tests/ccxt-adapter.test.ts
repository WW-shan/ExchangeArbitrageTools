import { describe, expect, it } from 'vitest';
import ccxt from 'ccxt';
import { Decimal } from 'decimal.js';
import {
  classifyCcxtFailure,
  createCcxtAdapter,
  createPublicRuntime,
  extractOrderFee,
  isCcxtShutdownError,
  normalizeCurrencyNetwork,
  normalizeExchangeTimestamp,
  normalizeTransferCurrency,
  transactionIdsMatch,
  parseRetryAfterMs,
  resolveCcxtExchangeId,
  stepFromCcxt,
} from '../src/index.js';

describe('CCXT adapter construction', () => {
  it('maps Gate.io to the correct CCXT exchange class', () => {
    expect(resolveCcxtExchangeId('gateio')).toBe('gate');
    const adapter = createCcxtAdapter('gateio', createPublicRuntime(1));
    expect(adapter.venueId).toBe('gateio');
    expect(adapter.tier).toBe('S');
    expect(adapter.capabilities.createOrder).toBe(false);
  });

  it('rejects unknown CCXT exchange ids', () => {
    expect(() => createCcxtAdapter('not_an_exchange', createPublicRuntime(1))).toThrow(
      /unknown CCXT/,
    );
  });

  it('extracts a Gate fee and its asset from raw order info', () => {
    const fee = extractOrderFee({
      info: {
        fee: '1.11573',
        fee_currency: 'WARD',
      },
    });
    expect(fee).toMatchObject({ currency: 'WARD', source: 'info.fee' });
    expect(fee?.cost.toFixed()).toBe('1.11573');
  });

  it('extracts a Bitget feeDetail without double counting newFees', () => {
    const fee = extractOrderFee({
      info: {
        feeDetail: JSON.stringify({
          newFees: { r: -0.00833986614, t: -0.00833986614 },
          USDT: { feeCoinCode: 'USDT', totalFee: -0.00833986614 },
        }),
      },
    });
    expect(fee).toMatchObject({ currency: 'USDT', source: 'info.feeDetail' });
    expect(fee?.cost.toFixed()).toBe('0.00833986614');
  });

  it('accepts tick sizes as well as decimal precision digit counts', () => {
    expect(stepFromCcxt(0.01)?.toFixed()).toBe('0.01');
    expect(stepFromCcxt(0.0001)?.toFixed()).toBe('0.0001');
    expect(stepFromCcxt(2)?.toFixed()).toBe('0.01');
    expect(stepFromCcxt(1, ccxt.TICK_SIZE)?.toFixed()).toBe('1');
    expect(stepFromCcxt('1', ccxt.TICK_SIZE)?.toFixed()).toBe('1');
    expect(stepFromCcxt(0.0001, ccxt.TICK_SIZE)?.toFixed()).toBe('0.0001');
    expect(stepFromCcxt(undefined)).toBeUndefined();
    expect(stepFromCcxt('2')?.toFixed()).toBe('0.01');
    expect(stepFromCcxt('0.01')?.toFixed()).toBe('0.01');
    expect(stepFromCcxt(31)).toBeUndefined();
    expect(stepFromCcxt('31')).toBeUndefined();
    expect(stepFromCcxt('-0.01')).toBeUndefined();
    expect(stepFromCcxt('0')).toBeUndefined();
  });

  it('normalizes BSC network aliases to one identity', () => {
    expect(normalizeCurrencyNetwork('BSC')).toBe('BSC');
    expect(normalizeCurrencyNetwork('BEP20')).toBe('BSC');
    expect(normalizeCurrencyNetwork('BNB Smart Chain (BEP20)')).toBe('BSC');
    expect(normalizeCurrencyNetwork('BNB Smart Chain')).toBe('BSC');
    expect(normalizeCurrencyNetwork('ERC20')).toBe('ERC20');
  });

  it('matches EVM transaction hashes case-insensitively', () => {
    const lower = '0x' + 'ab'.repeat(32);
    expect(transactionIdsMatch(lower, lower.toUpperCase())).toBe(true);
    expect(transactionIdsMatch(lower, lower.slice(2))).toBe(true);
    expect(transactionIdsMatch('12345', '12345')).toBe(true);
    expect(transactionIdsMatch('12345', '12346')).toBe(false);
    expect(transactionIdsMatch(undefined, lower)).toBe(false);
    expect(normalizeTransferCurrency('USDT(TRC20)')).toBe('USDT');
  });

  it('normalizes exchange timestamps from seconds, microseconds, and nanoseconds', () => {
    const ms = 1_700_000_000_000;
    expect(normalizeExchangeTimestamp(1_700_000_000)).toBe(ms);
    expect(normalizeExchangeTimestamp(ms)).toBe(ms);
    expect(normalizeExchangeTimestamp(1_700_000_000_000_000)).toBe(ms);
    expect(normalizeExchangeTimestamp(1_700_000_000_000_000_000)).toBe(ms);
  });

  it('keeps IOC and FOK disabled until the venue capability is verified', () => {
    const conservative = createCcxtAdapter('gateio', createPublicRuntime(1));
    expect(conservative.capabilities.ioc).toBe(false);
    expect(conservative.capabilities.fok).toBe(false);

    const verified = createCcxtAdapter('gateio', createPublicRuntime(1), {
      supportsIoc: true,
      supportsFok: false,
    });
    expect(verified.capabilities.ioc).toBe(true);
    expect(verified.capabilities.fok).toBe(false);
  });

  it('fetches and normalizes open orders for a symbol', async () => {
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = prototype.fetchOpenOrders;
    prototype.fetchOpenOrders = async (symbol: string) => [
      {
        id: 'order-1',
        clientOrderId: 'batch-1',
        symbol,
        side: 'buy',
        type: 'limit',
        price: 2.5,
        amount: 10,
        filled: 0,
        remaining: 10,
        status: 'open',
      },
    ];
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), {
        credentials: { apiKey: 'key', secret: 'secret' },
        readOnly: false,
      });
      expect(adapter.capabilities.openOrders).toBe(true);
      const orders = await adapter.fetchOpenOrders!(
        { symbol: 'CAKE/USDT' },
        {
          apiKey: 'key',
          secret: 'secret',
        },
      );
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        venueOrderId: 'order-1',
        clientOrderId: 'batch-1',
        symbol: 'CAKE/USDT',
        side: 'buy',
        status: 'open',
      });
      expect(orders[0]?.amount.toFixed()).toBe('10');
    } finally {
      prototype.fetchOpenOrders = original;
    }
  });

  it('resolves a Bitget create response that only contains an order id', async () => {
    const credentials = { apiKey: 'key', secret: 'secret' };
    const prototype = (ccxt.bitget as unknown as { prototype: Record<string, unknown> }).prototype;
    const originalCreate = prototype.createOrder;
    const originalFetch = prototype.fetchOrder;
    let fetchCalls = 0;
    prototype.createOrder = async (symbol: string, type: string, side: string) => ({
      id: 'bitget-order-1',
      symbol,
      type,
      side,
      info: { orderId: 'bitget-order-1', clientOid: 'client-1' },
    });
    prototype.fetchOrder = async (id: string, symbol: string) => {
      fetchCalls += 1;
      return {
        id,
        clientOrderId: 'client-1',
        symbol,
        side: 'sell',
        type: 'limit',
        price: 0.0053,
        amount: 1211.79,
        filled: 1211.79,
        remaining: 0,
        status: 'closed',
        average: 0.0053295157,
        fee: { cost: 0.00645825386, currency: 'USDT' },
        info: { orderId: id, status: 'filled' },
      };
    };
    try {
      const adapter = createCcxtAdapter('bitget', createPublicRuntime(10), {
        credentials,
        readOnly: false,
        supportsFok: true,
      });
      const order = await adapter.createOrder!(
        {
          symbol: 'WARD/USDT',
          side: 'sell',
          type: 'limit',
          amount: new Decimal('1211.79'),
          price: new Decimal('0.0053'),
          timeInForce: 'FOK',
          clientOrderId: 'client-1',
        },
        credentials,
      );
      expect(fetchCalls).toBe(1);
      expect(order).toMatchObject({
        venueOrderId: 'bitget-order-1',
        clientOrderId: 'client-1',
        status: 'closed',
      });
      expect(order.amount.toFixed()).toBe('1211.79');
      expect(order.filled.toFixed()).toBe('1211.79');
      expect(order.averagePrice?.toFixed()).toBe('0.0053295157');
      expect(order.fee?.toFixed()).toBe('0.00645825386');
      expect(order.feeCurrency).toBe('USDT');
      expect(order.raw).toMatchObject({ info: { orderId: 'bitget-order-1', status: 'filled' } });
    } finally {
      prototype.createOrder = originalCreate;
      prototype.fetchOrder = originalFetch;
    }
  });

  it('keeps the requested amount when Bitget lookup is still incomplete', async () => {
    const credentials = { apiKey: 'key', secret: 'secret' };
    const prototype = (ccxt.bitget as unknown as { prototype: Record<string, unknown> }).prototype;
    const originalCreate = prototype.createOrder;
    const originalFetch = prototype.fetchOrder;
    prototype.createOrder = async (symbol: string, type: string, side: string) => ({
      id: 'bitget-order-2',
      symbol,
      type,
      side,
    });
    prototype.fetchOrder = async (id: string, symbol: string) => ({
      id,
      symbol,
      side: 'sell',
      type: 'limit',
    });
    try {
      const adapter = createCcxtAdapter('bitget', createPublicRuntime(10), {
        credentials,
        readOnly: false,
        supportsFok: true,
      });
      const order = await adapter.createOrder!(
        {
          symbol: 'WARD/USDT',
          side: 'sell',
          type: 'limit',
          amount: new Decimal('10'),
          price: new Decimal('0.5'),
          timeInForce: 'FOK',
          clientOrderId: 'client-2',
        },
        credentials,
      );
      expect(order.status).toBe('unknown');
      expect(order.amount.toFixed()).toBe('10');
      expect(order.remaining.toFixed()).toBe('10');
      expect(order.price?.toFixed()).toBe('0.5');
    } finally {
      prototype.createOrder = originalCreate;
      prototype.fetchOrder = originalFetch;
    }
  });

  it('parses Retry-After from seconds, milliseconds, and HTTP dates', () => {
    expect(parseRetryAfterMs({ response: { headers: { 'retry-after': '7' } } })).toBe(7000);
    expect(parseRetryAfterMs({ retryAfter: 2 })).toBe(2000);
    expect(parseRetryAfterMs({ retryAfter: 1500 })).toBe(1500);
    expect(
      parseRetryAfterMs(
        { response: { headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } } },
        Date.parse('Wed, 21 Oct 2026 07:27:50 GMT'),
      ),
    ).toBe(10_000);
    expect(parseRetryAfterMs(new Error('please retry after 3 seconds'))).toBe(3000);
  });

  it('classifies 403 permission failures as non-retryable', () => {
    const failure = classifyCcxtFailure(
      Object.assign(new Error('Forbidden'), { response: { status: 403 } }),
    );
    expect(failure.permissionDenied).toBe(true);
    expect(failure.rateLimited).toBe(false);
    expect(failure.transient).toBe(false);
  });

  it('reads Gate account identity and whitelists without exposing raw values', async () => {
    const credentials = { apiKey: 'key', secret: 'secret' };
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = prototype.privateAccountGetDetail;
    prototype.privateAccountGetDetail = async () => ({
      user_id: 10406147,
      ip_whitelist: ['203.0.113.7', '198.51.100.9'],
      currency_pairs: ['LIGHT_USDT', 'TBK_USDT'],
      key: { mode: 1 },
    });
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), {
        credentials,
        readOnly: true,
      });
      const status = await adapter.fetchAccountStatus!(
        { requiredPairs: ['LIGHT/USDT', 'TBK/USDT'] },
        credentials,
      );
      expect(status.authenticated).toBe(true);
      expect(status.accountMode).toBe('classic');
      expect(status.accountIdHash).toMatch(/^sha256:/);
      expect(status.ipWhitelist).toMatchObject({
        supported: true,
        present: true,
        count: 2,
        currentIpAccepted: true,
      });
      expect(status.pairWhitelist?.requiredPairsAllowed).toBe(true);
      expect(status.capabilities.trading).toBe('unknown');
      expect(status.capabilities.withdrawal).toBe('unknown');
      expect(JSON.stringify(status)).not.toContain('203.0.113.7');
    } finally {
      prototype.privateAccountGetDetail = original;
    }
  });

  it('does not treat a missing Gate IP whitelist field as an empty list', async () => {
    const credentials = { apiKey: 'key', secret: 'secret' };
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = prototype.privateAccountGetDetail;
    prototype.privateAccountGetDetail = async () => ({
      user_id: 10406147,
      currency_pairs: [],
      key: { mode: 1 },
    });
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), {
        credentials,
        readOnly: true,
      });
      const status = await adapter.fetchAccountStatus!({ requiredPairs: [] }, credentials);
      expect(status.ipWhitelist?.present).toBe(false);
      expect(status.errors).toContain('gate_ip_whitelist_missing');
    } finally {
      prototype.privateAccountGetDetail = original;
    }
  });

  it('classifies rate limits, network errors and server errors as transient', () => {
    expect(classifyCcxtFailure({ response: { status: 429 }, message: 'too many' })).toMatchObject({
      status: 429,
      rateLimited: true,
      transient: true,
    });
    expect(classifyCcxtFailure({ response: { status: 403 } })).toMatchObject({
      rateLimited: false,
      permissionDenied: true,
      transient: false,
    });
    expect(classifyCcxtFailure(new Error('socket hang up'))).toMatchObject({
      rateLimited: false,
      transient: true,
    });
    expect(classifyCcxtFailure({ response: { status: 503 } })).toMatchObject({
      transient: true,
    });
    expect(
      classifyCcxtFailure({ response: { status: 400 }, message: 'bad request' }),
    ).toMatchObject({
      transient: false,
      rateLimited: false,
    });
  });
});

describe('ccxt transfer adapter', () => {
  const keys = { apiKey: 'key', secret: 'secret' };

  it('normalizes deposit addresses, deposits, withdrawals and submissions', async () => {
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const originalAddress = prototype.fetchDepositAddress;
    const originalDeposits = prototype.fetchDeposits;
    const originalWithdrawals = prototype.fetchWithdrawals;
    const originalWithdraw = prototype.withdraw;
    let withdrawParams: unknown;
    let addressParams: unknown;
    prototype.fetchDepositAddress = async (_code: string, params: unknown) => {
      addressParams = params;
      return {
        address: '0xAbC0000000000000000000000000000000000001',
        network: 'BEP20',
        tag: '',
      };
    };
    prototype.fetchDeposits = async () => [
      {
        id: 'd1',
        currency: 'INC',
        network: 'BSC',
        address: '0xabc',
        amount: '10',
        status: 'ok',
        txid: '0xdeposit',
        timestamp: 1_700_000_000_000,
        fee: { cost: '0.1' },
      },
    ];
    prototype.fetchWithdrawals = async () => [
      {
        id: 'w1',
        currency: 'INC',
        network: 'BSC',
        address: '0xabc',
        amount: '10',
        status: 'pending',
        timestamp: 1_700_000_000_000,
      },
    ];
    prototype.withdraw = async (
      _code: string,
      _amount: number,
      _address: string,
      params: unknown,
    ) => {
      withdrawParams = params;
      return {
        id: 'w2',
        currency: 'INC',
        network: 'BSC',
        address: '0xabc',
        amount: '10',
        status: 'pending',
      };
    };
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), {
        credentials: keys,
        readOnly: false,
      });
      expect(adapter.capabilities.depositAddress).toBe(true);
      expect(adapter.capabilities.depositHistory).toBe(true);
      expect(adapter.capabilities.withdrawalHistory).toBe(true);
      expect(adapter.capabilities.createWithdrawal).toBe(true);

      const address = await adapter.fetchDepositAddress!('INC', 'BSC', keys);
      expect(address.network).toBe('BEP20');
      expect(address.address).toBe('0xAbC0000000000000000000000000000000000001');
      expect(addressParams).toMatchObject({ network: 'BEP20' });

      const deposits = await adapter.fetchDeposits!({ currency: 'INC', network: 'BSC' }, keys);
      expect(deposits[0]).toMatchObject({
        id: 'd1',
        direction: 'deposit',
        status: 'completed',
        txId: '0xdeposit',
      });
      expect(deposits[0]?.fee?.toFixed()).toBe('0.1');

      const withdrawals = await adapter.fetchWithdrawals!({ currency: 'INC', id: 'w1' }, keys);
      expect(withdrawals[0]).toMatchObject({ direction: 'withdrawal', status: 'pending' });

      const submission = await adapter.createWithdrawal!(
        {
          currency: 'INC',
          network: 'BSC',
          amount: new Decimal('10'),
          address: '0xabc',
        },
        keys,
      );
      expect(submission.id).toBe('w2');
      expect(withdrawParams).toMatchObject({ network: 'BEP20' });
    } finally {
      prototype.fetchDepositAddress = originalAddress;
      prototype.fetchDeposits = originalDeposits;
      prototype.fetchWithdrawals = originalWithdrawals;
      prototype.withdraw = originalWithdraw;
    }
  });

  it('does not expose withdrawal on a read-only adapter', async () => {
    const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), {
      credentials: keys,
      readOnly: true,
    });
    expect(adapter.capabilities.depositAddress).toBe(true);
    expect(adapter.capabilities.createWithdrawal).toBe(false);
    await expect(
      adapter.createWithdrawal!(
        {
          currency: 'INC',
          network: 'BSC',
          amount: new Decimal('10'),
          address: '0xabc',
        },
        keys,
      ),
    ).rejects.toThrow(/not enabled/);
  });
});

describe('ccxt shutdown guard', () => {
  it('recognises ccxt closedByUser errors only', () => {
    expect(isCcxtShutdownError(new Error('cex closedByUser'))).toBe(true);
    expect(isCcxtShutdownError({ name: 'ExchangeClosedByUser', message: 'x' })).toBe(true);
    expect(isCcxtShutdownError(new Error('boom'))).toBe(false);
  });
});

describe('ccxt market denomination aliases', () => {
  it('keeps the venue currency and exposes a canonical PEPE market', async () => {
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = prototype.loadMarkets;
    prototype.loadMarkets = async () => ({
      '1000PEPE/USDT': {
        id: '1000PEPE_USDT',
        symbol: '1000PEPE/USDT',
        base: '1000PEPE',
        quote: 'USDT',
        active: true,
        spot: true,
        type: 'spot',
        precision: { amount: 1, price: 0.0000001 },
        limits: { amount: { min: 100 }, cost: { min: 3 } },
        taker: 0.001,
        maker: 0.0005,
      },
    });
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), { readOnly: true });
      const markets = await adapter.loadMarkets();
      expect(markets).toHaveLength(1);
      expect(markets[0]).toMatchObject({
        exchangeSymbol: '1000PEPE/USDT',
        unifiedSymbol: 'PEPE/USDT',
        base: 'PEPE',
        exchangeBase: '1000PEPE',
        quote: 'USDT',
      });
      expect(markets[0]?.baseMultiplier?.toFixed()).toBe('1000');
      expect(markets[0]?.amountStep?.toFixed()).toBe('1');
      expect(markets[0]?.amountPrecision).toBe(0);
      expect(markets[0]?.minAmount?.toFixed()).toBe('100');
    } finally {
      prototype.loadMarkets = original;
    }
  });
});

describe('ccxt account trading fees', () => {
  it('maps taker/maker rates to bps and keeps a zero taker fee', async () => {
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = prototype.fetchTradingFees;
    prototype.fetchTradingFees = async () => ({
      'CAKE/USDT': { taker: 0.001, maker: 0.0002 },
      'ZERO/USDT': { taker: 0, maker: 0 },
    });
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), {
        credentials: { apiKey: 'key', secret: 'secret' },
        readOnly: true,
      });
      const fees = await adapter.fetchTradingFees!();
      expect(fees['CAKE/USDT']?.takerBps?.toFixed()).toBe('10');
      expect(fees['CAKE/USDT']?.makerBps?.toFixed()).toBe('2');
      expect(fees['ZERO/USDT']?.takerBps?.toFixed()).toBe('0');
      expect(fees['ZERO/USDT']?.makerBps?.toFixed()).toBe('0');
    } finally {
      prototype.fetchTradingFees = original;
    }
  });
});

describe('ccxt OHLCV mapping', () => {
  it('maps exchange candles to decimal candles', async () => {
    const prototype = (ccxt.gate as unknown as { prototype: Record<string, unknown> }).prototype;
    const original = prototype.fetchOHLCV;
    prototype.fetchOHLCV = async () => [
      [1_700_000_000_000, 2, 2.1, 1.9, 2.05, 100],
      [1_700_000_900_000, 2.05, 2.2, 2, 2.15, 120],
    ];
    try {
      const adapter = createCcxtAdapter('gateio', createPublicRuntime(1), { readOnly: true });
      const candles = await adapter.fetchOHLCV!('CAKE/USDT', '15m', 1_700_000_000_000, 500);
      expect(candles).toHaveLength(2);
      expect(candles[0]?.open.toFixed()).toBe('2');
      expect(candles[1]?.close.toFixed()).toBe('2.15');
      expect(candles[1]?.volume.toFixed()).toBe('120');
    } finally {
      prototype.fetchOHLCV = original;
    }
  });
});
