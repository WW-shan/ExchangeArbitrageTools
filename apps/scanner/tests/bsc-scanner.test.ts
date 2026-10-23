import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { findStandardToken } from '@arb/venues-bsc';
import type { CexAdapter } from '@arb/venues-cex';
import type { CostSettings, MarketMetadata, OrderBookSnapshot, DexQuote } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { scanBscToken } from '../src/bsc-scanner.js';
import { persistSimulatedOpportunity } from '../src/persistence.js';

const now = 1_700_000_000_000;
const cake = findStandardToken('CAKE')!;
const usdt = findStandardToken('USDT')!;

const market: MarketMetadata = {
  venueId: 'gateio',
  exchangeSymbol: 'CAKE/USDT',
  unifiedSymbol: 'CAKE/USDT',
  base: 'CAKE',
  quote: 'USDT',
  active: true,
  pricePrecision: 3,
  amountPrecision: 3,
  amountStep: new Decimal('0.001'),
  priceStep: new Decimal('0.001'),
  minAmount: new Decimal('0.01'),
  minNotional: new Decimal('1'),
  feeTakerBps: new Decimal('10'),
  supportsIoc: true,
};

const book: OrderBookSnapshot = {
  venueId: 'gateio',
  exchangeSymbol: 'CAKE/USDT',
  fetchedAt: now,
  asks: [{ price: new Decimal('2.5'), amount: new Decimal('100') }],
  bids: [{ price: new Decimal('2.45'), amount: new Decimal('100') }],
  source: 'replay',
};

function adapter(
  marketMetadata: MarketMetadata = market,
  orderBook: OrderBookSnapshot = book,
): CexAdapter {
  return {
    venueId: 'gateio',
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: false,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      websocket: false,
      ioc: true,
      fok: false,
    },
    loadMarkets: async () => [marketMetadata],
    fetchOrderBook: async () => orderBook,
  };
}

function quote(overrides: Partial<DexQuote>): DexQuote {
  return {
    providerId: '0x',
    chain: 'BSC',
    sellToken: cake.contractAddress,
    buyToken: usdt.contractAddress,
    sellAmount: new Decimal(12),
    buyAmount: new Decimal('31'),
    expectedSlippageBps: new Decimal(10),
    priceImpactBps: new Decimal(5),
    feeBps: new Decimal(0),
    gasEstimate: new Decimal(200000),
    gasPrice: new Decimal(1),
    gasCostUsd: new Decimal('0.05'),
    quotedAt: now,
    ...overrides,
  };
}

const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};

describe('BSC scan orchestration', () => {
  it('produces S3 directions and an S4 comparison from fresh quotes', async () => {
    const responses = [
      quote({ buyAmount: new Decimal('31') }),
      quote({
        providerId: '0x-buy',
        sellToken: usdt.contractAddress,
        buyToken: cake.contractAddress,
        sellAmount: new Decimal(30),
        buyAmount: new Decimal(12),
      }),
      quote({ providerId: '1inch', buyAmount: new Decimal('31') }),
    ];
    let call = 0;
    const primary = { providerId: '0x', quote: async () => responses[call++]! };
    const backup = { providerId: '1inch', quote: async () => responses[call++]! };
    const result = await scanBscToken({
      cexAdapter: adapter(),
      cexMarket: market,
      mapping: {
        id: 'cake-gateio',
        cexVenueId: 'gateio',
        cexCurrency: 'CAKE',
        chain: 'BSC',
        contractAddress: cake.contractAddress,
        token: { ...cake, liquidityUsd: '500000', volume24hUsd: '500000' },
        verification: ['cex', 'bscscan'],
        manualApproval: false,
        withdrawEnabled: true,
        depositEnabled: true,
        status: 'active',
      },
      primaryProvider: primary,
      backupProvider: backup,
      requestedNotional: new Decimal(30),
      settings,
      slippageBps: new Decimal(10),
      inventoryMode: true,
      clock: () => now,
    });
    expect(result.errors).toEqual([]);
    expect(result.opportunities.map((opportunity) => opportunity.strategy)).toEqual([
      'S3',
      'S3',
      'S4',
    ]);
    expect(result.opportunities.some((opportunity) => opportunity.valid)).toBe(true);

    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    for (const opportunity of result.opportunities) {
      const stored = repository.recordOpportunity(opportunity);
      if (opportunity.valid) {
        persistSimulatedOpportunity(repository, stored, opportunity, 'USDT');
      }
    }
    const papers = db.prepare('SELECT result, fill_quality_json FROM paper_trades').all() as Array<{
      result: string;
      fill_quality_json: string;
    }>;
    expect(papers.length).toBeGreaterThanOrEqual(1);
    expect(papers.every((paper) => paper.result === 'SIMULATED')).toBe(true);
    const strategies = papers.map(
      (paper) => (JSON.parse(paper.fill_quality_json) as { strategy: string }).strategy,
    );
    expect(strategies).toContain('S3');
    expect(strategies).toContain('S4');
    repository.close();
  });

  it('uses the CEX currency for BNB while quoting the verified WBNB contract', async () => {
    const wbnb = findStandardToken('WBNB')!;
    const bnbMarket: MarketMetadata = {
      ...market,
      exchangeSymbol: 'BNB/USDT',
      unifiedSymbol: 'BNB/USDT',
      base: 'BNB',
    };
    const bnbBook: OrderBookSnapshot = {
      ...book,
      exchangeSymbol: 'BNB/USDT',
    };
    const responses = [
      quote({
        sellToken: wbnb.contractAddress,
        buyToken: usdt.contractAddress,
        sellAmount: new Decimal(12),
        buyAmount: new Decimal(31),
      }),
      quote({
        providerId: '0x-buy',
        sellToken: usdt.contractAddress,
        buyToken: wbnb.contractAddress,
        sellAmount: new Decimal(30),
        buyAmount: new Decimal(12),
      }),
      quote({
        providerId: '1inch',
        sellToken: wbnb.contractAddress,
        buyToken: usdt.contractAddress,
        sellAmount: new Decimal(12),
        buyAmount: new Decimal(31),
      }),
    ];
    let call = 0;
    const result = await scanBscToken({
      cexAdapter: adapter(bnbMarket, bnbBook),
      cexMarket: bnbMarket,
      mapping: {
        id: 'bnb-gateio',
        cexVenueId: 'gateio',
        cexCurrency: 'BNB',
        chain: 'BSC',
        contractAddress: wbnb.contractAddress,
        token: { ...wbnb, liquidityUsd: '500000', volume24hUsd: '500000' },
        verification: ['cex', 'bscscan'],
        manualApproval: false,
        withdrawEnabled: true,
        depositEnabled: true,
        status: 'active',
      },
      primaryProvider: { providerId: '0x', quote: async () => responses[call++]! },
      backupProvider: { providerId: '1inch', quote: async () => responses[call++]! },
      requestedNotional: new Decimal(30),
      settings,
      slippageBps: new Decimal(10),
      inventoryMode: true,
      clock: () => now,
    });
    expect(result.errors).toEqual([]);
    expect(result.opportunities).toHaveLength(3);
    expect(result.opportunities.every((item) => item.instrumentKey === 'BNB/USDT')).toBe(true);
    expect(result.opportunities.some((item) => item.valid)).toBe(true);
  });

  it('passes transfer metadata and the arrival window into both S3 directions', async () => {
    const responses = [
      quote({ buyAmount: new Decimal('31') }),
      quote({
        providerId: '0x-buy',
        sellToken: usdt.contractAddress,
        buyToken: cake.contractAddress,
        sellAmount: new Decimal(30),
        buyAmount: new Decimal(12),
      }),
    ];
    let call = 0;
    const result = await scanBscToken({
      cexAdapter: adapter(),
      cexMarket: market,
      mapping: {
        id: 'cake-gateio-transfer',
        cexVenueId: 'gateio',
        cexCurrency: 'CAKE',
        chain: 'BSC',
        contractAddress: cake.contractAddress,
        token: { ...cake, liquidityUsd: '500000', volume24hUsd: '500000' },
        verification: ['cex', 'bscscan'],
        manualApproval: false,
        withdrawEnabled: true,
        depositEnabled: true,
        withdrawFee: new Decimal('0.1'),
        minWithdrawAmount: new Decimal('1'),
        minDepositAmount: new Decimal('1'),
        canArriveQuickly: true,
        estimatedArrivalMs: 60_000,
        status: 'active',
      },
      primaryProvider: { providerId: '0x', quote: async () => responses[call++]! },
      requestedNotional: new Decimal(30),
      settings,
      slippageBps: new Decimal(10),
      inventoryMode: false,
      maxTransferArrivalMs: 120_000,
      clock: () => now,
    });
    expect(result.errors).toEqual([]);
    expect(result.opportunities).toHaveLength(2);
    const transferRejections = new Set([
      'transfer_disabled',
      'withdrawal_fee_unavailable',
      'opportunity_expired',
      'invalid_request',
    ]);
    for (const opportunity of result.opportunities) {
      expect(
        opportunity.rejectionReasons.filter((reason) => transferRejections.has(reason)),
      ).toEqual([]);
      expect(opportunity.metadata?.transferRequired).toBe('true');
      expect(opportunity.metadata?.maxTransferArrivalMs).toBe('120000');
    }
  });
});
