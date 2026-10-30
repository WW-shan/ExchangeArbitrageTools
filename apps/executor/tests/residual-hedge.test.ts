import { describe, expect, it } from 'vitest';
import { Decimal, type MarketMetadata, type OrderBookSnapshot } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, CexAdapter } from '@arb/venues-cex';
import {
  evaluateResidualHedgeCandidate,
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
