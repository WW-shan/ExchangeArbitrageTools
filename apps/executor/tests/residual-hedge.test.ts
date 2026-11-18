import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, CexAdapter } from '@arb/venues-cex';
import {
  evaluateResidualHedgeCandidate,
  planResidualHedge,
  evaluateShortResidualHedgeCandidate,
  hedgeClientOrderId,
  reconcileResidualHedgeFill,
} from '../src/residual-hedge.js';
import type { RecoveryVenue } from '../src/bootstrap.js';

const market: MarketMetadata = {
  venueId: 'bitget',
  exchangeSymbol: 'WARD/USDT',
  unifiedSymbol: 'WARD/USDT',
  base: 'WARD',
  quote: 'USDT',
  active: true,
  pricePrecision: 6,
  amountPrecision: 2,
  amountStep: new Decimal('0.01'),
  priceStep: new Decimal('0.000001'),
  minAmount: new Decimal('0.01'),
  minNotional: new Decimal('1'),
  feeTakerBps: new Decimal('10'),
};

function book(): OrderBookSnapshot {
  return {
    venueId: 'bitget',
    exchangeSymbol: 'WARD/USDT',
    fetchedAt: 1_700_000_000_000,
    bids: [
      { price: new Decimal('0.0055'), amount: new Decimal('100') },
      { price: new Decimal('0.0054'), amount: new Decimal('1000') },
    ],
    asks: [{ price: new Decimal('0.0056'), amount: new Decimal('1000') }],
    source: 'rest',
  };
}

describe('residual hedge planning', () => {
  it('generates a Gate-safe hedge client order id', () => {
    const id = hedgeClientOrderId(1_700_000_000_000);
    expect(id.length).toBeLessThanOrEqual(28);
    expect(id).toMatch(/^HD-[a-z0-9]+-[0-9a-f]{8}$/);
  });

  it('uses the worst consumed bid and charges the gross fee', () => {
    const candidate = evaluateResidualHedgeCandidate({
      venueId: 'bitget',
      market,
      book: book(),
      residualCanonical: new Decimal('500'),
      costPerCanonical: new Decimal('0.004'),
      freeBase: new Decimal('1000'),
      grossFeeBps: new Decimal('10'),
      minProfitUsd: new Decimal('0.01'),
    });
    expect(candidate).toBeDefined();
    expect(candidate!.exchangeAmount.toFixed()).toBe('500');
    expect(candidate!.exchangePrice.toFixed()).toBe('0.0054');
    expect(candidate!.executableQuote.toFixed()).toBe('2.71');
    expect(candidate!.grossFeeQuote.toFixed()).toBe('0.00271');
    expect(candidate!.projectedProfit.toFixed()).toBe('0.70729');
  });

  it('aligns down to the venue amount step and caps at free base', () => {
    const candidate = evaluateResidualHedgeCandidate({
      venueId: 'bitget',
      market,
      book: book(),
      residualCanonical: new Decimal('500.019'),
      costPerCanonical: new Decimal('0.004'),
      freeBase: new Decimal('500.009'),
      grossFeeBps: new Decimal('10'),
      minProfitUsd: new Decimal('0.01'),
    });
    expect(candidate).toBeDefined();
    expect(candidate!.exchangeAmount.toFixed()).toBe('500');
    expect(candidate!.canonicalAmount.toFixed()).toBe('500');
  });

  it('fails closed when the projected profit is below the rescue floor', () => {
    expect(
      evaluateResidualHedgeCandidate({
        venueId: 'bitget',
        market,
        book: book(),
        residualCanonical: new Decimal('500'),
        costPerCanonical: new Decimal('0.0056'),
        freeBase: new Decimal('1000'),
        grossFeeBps: new Decimal('10'),
        minProfitUsd: new Decimal('0.01'),
      }),
    ).toBeUndefined();
  });

  it('fails closed instead of closing a residual it cannot fully sell', () => {
    expect(
      evaluateResidualHedgeCandidate({
        venueId: 'bitget',
        market,
        book: book(),
        residualCanonical: new Decimal('500'),
        costPerCanonical: new Decimal('0.004'),
        freeBase: new Decimal('400'),
        grossFeeBps: new Decimal('10'),
        minProfitUsd: new Decimal('0.01'),
      }),
    ).toBeUndefined();
  });

  it('buys back a short residual using the worst consumed ask and quote cash', () => {
    const candidate = evaluateShortResidualHedgeCandidate({
      venueId: 'bitget',
      market,
      book: book(),
      residualCanonical: new Decimal('500'),
      proceedsPerCanonical: new Decimal('0.006'),
      freeQuote: new Decimal('1000'),
      grossFeeBps: new Decimal('10'),
      minProfitUsd: new Decimal('0.01'),
    });
    expect(candidate).toBeDefined();
    expect(candidate!.direction).toBe('short');
    expect(candidate!.exchangeAmount.toFixed()).toBe('500.51');
    expect(candidate!.exchangePrice.toFixed()).toBe('0.0056');
    expect(candidate!.executableQuote.toFixed()).toBe('2.802856');
    expect(candidate!.grossFeeQuote.toFixed()).toBe('0.002802856');
    expect(candidate!.netHedgeQuote.toFixed()).toBe('2.805658856');
    expect(candidate!.projectedProfit.toFixed()).toBe('0.194398084');
  });

  it('fails closed when quote cash cannot cover the short buyback', () => {
    expect(
      evaluateShortResidualHedgeCandidate({
        venueId: 'bitget',
        market,
        book: book(),
        residualCanonical: new Decimal('500'),
        proceedsPerCanonical: new Decimal('0.006'),
        freeQuote: new Decimal('2'),
        grossFeeBps: new Decimal('10'),
        minProfitUsd: new Decimal('0.01'),
      }),
    ).toBeUndefined();
  });
});

describe('residual hedge reconciliation', () => {
  const credentials: ApiCredentials = { apiKey: 'test', secret: 'test' };
  const now = 1_700_000_000_000;
  const batchId = 'S1-HEDGE-REJECTED';
  const hedgeBatchId = `HEDGE-${batchId}-${now}`;
  const clientOrderId = 'HEDGE-S1-755006-1793321780763-1793321786338-H1';

  function setup(): {
    repository: ArbitrageRepository;
    adapters: Record<string, RecoveryVenue>;
  } {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    const baselineAt = now - 10_000;
    repository.upsertVenue({
      id: 'gateio',
      type: 'cex',
      name: 'Gate.io',
      tier: 'S',
      now,
    });
    for (const currency of ['WARD', 'USDT']) {
      repository.recordBalance({
        venueId: 'gateio',
        accountId: 'default',
        currency,
        free: new Decimal(currency === 'WARD' ? '1390.62192' : '9.37'),
        used: new Decimal(0),
        total: new Decimal(currency === 'WARD' ? '1390.62192' : '9.37'),
        fetchedAt: baselineAt,
      });
    }
    const executionId = repository.createExecution({
      strategy: 'HEDGE',
      batchId: hedgeBatchId,
      status: 'HEDGE_UNKNOWN',
      plannedNotional: new Decimal('5'),
      expectedProfit: new Decimal('0'),
      openedAt: now,
      metadata: {
        hedgesExecutionId: 31,
        originalBatchId: batchId,
        hedgeVenue: 'gateio',
        base: 'WARD',
        quote: 'USDT',
        exchangeBase: 'WARD',
        exchangeSymbol: 'WARD/USDT',
        baseMultiplier: '1',
        direction: 'long',
        residualCanonical: '1390.62192',
        costPerCanonical: '0.0037629',
        exchangeAmount: '1390.62',
      },
    });
    repository.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: 'gateio',
      side: 'sell',
      requestedAmount: new Decimal('1390.62'),
      requestedPrice: new Decimal('0.0038'),
      status: 'unknown',
      submittedAt: now,
      clientOrderId,
    });
    repository.recordOrder({
      venueId: 'gateio',
      clientOrderId,
      executionId,
      symbol: 'WARD/USDT',
      side: 'sell',
      type: 'limit',
      price: new Decimal('0.0038'),
      amount: new Decimal('1390.62'),
      filledAmount: new Decimal(0),
      status: 'unknown',
      now,
    });
    const adapter = {
      venueId: 'gateio',
      tier: 'S',
      capabilities: {
        publicMarketData: true,
        orderBook: true,
        privateBalances: true,
        createOrder: true,
        fetchOrder: true,
        openOrders: true,
        cancelOrder: true,
        websocket: false,
        ioc: true,
        fok: true,
      },
      loadMarkets: async () => [market],
      fetchOrderBook: async () => book(),
      fetchOrder: async () => {
        throw new Error(
          'BadRequest: gate createOrder () clientOrderId or text param must be up to 28 characters',
        );
      },
      fetchOpenOrders: async () => [],
      fetchBalances: async () =>
        (['WARD', 'USDT'] as const).map((currency) => ({
          venueId: 'gateio',
          accountId: 'default',
          currency,
          free: new Decimal(currency === 'WARD' ? '1390.62192' : '9.37'),
          used: new Decimal(0),
          total: new Decimal(currency === 'WARD' ? '1390.62192' : '9.37'),
          fetchedAt: now + 1000,
        })),
      createOrder: async () => {
        throw new Error('not used');
      },
    } as unknown as CexAdapter;
    return {
      repository,
      adapters: { gateio: { adapter, credentials } },
    };
  }

  it('marks a definitively rejected historical hedge as no-fill', async () => {
    const { repository, adapters } = setup();
    const result = await reconcileResidualHedgeFill({
      repository,
      adapters,
      hedgeBatchId,
      now: now + 5000,
    });

    expect(result).toMatchObject({
      status: 'BLOCKED',
      reasons: ['hedge_rejected_no_fill'],
    });
    expect(
      repository.db
        .prepare('SELECT status, closed_at FROM executions WHERE batch_id = ?')
        .get(hedgeBatchId),
    ).toMatchObject({ status: 'HEDGE_REJECTED', closed_at: now + 5000 });
    expect(
      repository.db
        .prepare('SELECT status FROM orders WHERE client_order_id = ?')
        .get(clientOrderId),
    ).toMatchObject({ status: 'rejected' });
    expect(
      repository.db
        .prepare('SELECT severity, rule FROM risk_events WHERE rule = ?')
        .get('hedge_rejected_no_fill'),
    ).toMatchObject({ severity: 'warning', rule: 'hedge_rejected_no_fill' });
    expect(repository.countUnresolvedOrders()).toBe(0);
  });
});

describe('residual hedge venue selection', () => {
  const now = 1_700_000_000_000;

  function build() {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
    repository.upsertVenue({ id: 'bitget', type: 'cex', name: 'Bitget', tier: 'S', now });
    repository.setSetting('kill_switch', 'false', now);

    // Pre-trade balances: Gate holds the quote, Bitget holds the base.
    const baseline = {
      gateio: { WARD: '0', USDT: '20' },
      bitget: { WARD: '10000', USDT: '0' },
    };
    for (const [venueId, rows] of Object.entries(baseline)) {
      for (const [currency, total] of Object.entries(rows)) {
        repository.recordBalance({
          venueId,
          accountId: 'default',
          currency,
          free: new Decimal(total),
          used: new Decimal(0),
          total: new Decimal(total),
          fetchedAt: now - 30_000,
        });
      }
    }

    // The failed S1: leg 1 filled on Gate, leg 2 on Bitget never filled.
    const executionId = repository.createExecution({
      strategy: 'S1',
      batchId: 'S1-TEST-1',
      status: 'SAFE_STOP',
      plannedNotional: new Decimal('7'),
      expectedProfit: new Decimal('0.05'),
      openedAt: now - 20_000,
      metadata: {},
    });
    repository.addExecutionLeg({
      executionId,
      legNumber: 1,
      venueId: 'gateio',
      side: 'buy',
      requestedAmount: new Decimal('4100'),
      requestedPrice: new Decimal('0.001665'),
      status: 'filled',
      submittedAt: now - 20_000,
      clientOrderId: 'S1-TEST-1-L1',
    });
    repository.updateExecutionLeg('S1-TEST-1-L1', {
      status: 'filled',
      filledAmount: new Decimal('4100'),
      averageFillPrice: new Decimal('0.001665'),
    });
    repository.addExecutionLeg({
      executionId,
      legNumber: 2,
      venueId: 'bitget',
      side: 'sell',
      requestedAmount: new Decimal('4100'),
      requestedPrice: new Decimal('0.001676'),
      status: 'partial',
      submittedAt: now - 19_000,
      clientOrderId: 'S1-TEST-1-L2',
    });
    repository.recordUnhedgedInventory({
      executionId,
      batchId: 'S1-TEST-1',
      venueId: 'gateio',
      asset: 'WARD',
      amount: new Decimal('4100'),
      usdValue: new Decimal('6.8'),
      direction: 'long',
      reason: 'leg2_zero_fill',
      createdAt: now - 18_000,
    });

    // Post-trade: Gate now holds the 4100 WARD it bought.
    repository.recordBalance({
      venueId: 'gateio',
      accountId: 'default',
      currency: 'WARD',
      free: new Decimal('4100'),
      used: new Decimal(0),
      total: new Decimal('4100'),
      fetchedAt: now,
    });

    const makeAdapter = (venueId: string, bids: Array<[string, string]>) => {
      const adapter: Partial<CexAdapter> = {
        venueId,
        tier: 'S',
        capabilities: {
          publicMarketData: true,
          orderBook: true,
          privateBalances: true,
          createOrder: true,
          fetchOrder: true,
          openOrders: true,
          cancelOrder: true,
          websocket: false,
          ioc: true,
          fok: true,
        },
        loadMarkets: async () => [
          {
            venueId,
            exchangeSymbol: 'WARD/USDT',
            unifiedSymbol: 'WARD/USDT',
            base: 'WARD',
            quote: 'USDT',
            active: true,
            pricePrecision: 6,
            amountPrecision: 0,
            amountStep: new Decimal('1'),
            priceStep: new Decimal('0.000001'),
            minAmount: new Decimal('1'),
            minNotional: new Decimal('1'),
            feeTakerBps: new Decimal('10'),
          },
        ],
        fetchOrderBook: async () => ({
          venueId,
          exchangeSymbol: 'WARD/USDT',
          fetchedAt: Date.now(),
          bids: bids.map(([price, amount]) => ({
            price: new Decimal(price),
            amount: new Decimal(amount),
          })),
          asks: [{ price: new Decimal('0.002'), amount: new Decimal('100000') }],
          source: 'rest',
        }),
        fetchBalances: async () =>
          Object.entries(baseline).length >= 0 && venueId === 'bitget'
            ? [
                {
                  venueId,
                  accountId: 'default',
                  currency: 'WARD',
                  free: new Decimal('10000'),
                  used: new Decimal(0),
                  total: new Decimal('10000'),
                  fetchedAt: Date.now(),
                },
                {
                  venueId,
                  accountId: 'default',
                  currency: 'USDT',
                  free: new Decimal('5'),
                  used: new Decimal(0),
                  total: new Decimal('5'),
                  fetchedAt: Date.now(),
                },
              ]
            : [
                {
                  venueId,
                  accountId: 'default',
                  currency: 'WARD',
                  free: new Decimal('4100'),
                  used: new Decimal(0),
                  total: new Decimal('4100'),
                  fetchedAt: Date.now(),
                },
                {
                  venueId,
                  accountId: 'default',
                  currency: 'USDT',
                  free: new Decimal('13'),
                  used: new Decimal(0),
                  total: new Decimal('13'),
                  fetchedAt: Date.now(),
                },
              ],
        fetchOpenOrders: async () => [],
        createOrder: async () => {
          throw new Error('not used');
        },
      };
      return adapter as CexAdapter;
    };

    const config = {
      orderbookDepth: 20,
      autoRotation: {
        pairs: [{ base: 'WARD', quote: 'USDT', venues: ['gateio', 'bitget'] }],
        residualHedge: {
          bookMaxAgeMs: 300_000,
          bookMaxExchangeAgeMs: 300_000,
          allowCounterpartyHedge: true,
        },
      },
      feeOverrides: { gateio: { takerBps: new Decimal('9.9'), rebatePct: new Decimal('70') } },
    } as unknown as ExecutorConfig;

    const credentials: ApiCredentials = { apiKey: 'test', secret: 'test' };
    return {
      repository,
      config,
      adapters: {
        // Gate bids 0.001649 (the bad venue), Bitget bids 0.001676 (the good one).
        gateio: { adapter: makeAdapter('gateio', [['0.001649', '500000']]), credentials },
        bitget: { adapter: makeAdapter('bitget', [['0.001676', '500000']]), credentials },
      },
    };
  }

  it('finishes the trade on the original counterparty instead of dumping on the buy venue', async () => {
    const { repository, config, adapters } = build();
    const result = await planResidualHedge({
      repository,
      config,
      adapters,
      batchId: 'S1-TEST-1',
      maxBaselineAgeMs: 300_000,
      minProfitUsd: new Decimal('-1'),
    });
    expect(result.status).toBe('PLANNED');
    const plan = result.plan!;
    // The hedge must run on Bitget, where leg 2 was planned and where the bid
    // is 0.001676, not on Gate where the bid is 0.001649.
    expect(plan.venueId).toBe('bitget');
    // Selling the residual is always a sell, whichever venue supplies it.
    expect(plan.hedgeSide).toBe('long');
    expect(plan.exchangePrice.toFixed()).toBe('0.001676');
    repository.close();
  });
});
