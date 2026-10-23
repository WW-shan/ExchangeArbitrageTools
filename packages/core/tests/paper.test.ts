import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  createPaperGate,
  defaultPaperRiskLimits,
  evaluateS1Direction,
  runPaperBatch,
  ScriptedPaperGateway,
  type CostSettings,
  type MarketMetadata,
  type OrderBookSnapshot,
  type OpportunityResult,
  type PaperFillScenario,
} from '../src/index.js';

const now = 1_700_000_000_000;
const settings: CostSettings = {
  minProfitUsd: new Decimal('0.25'),
  safetyBufferBps: new Decimal(15),
  minNetProfitBps: new Decimal(20),
  maxOrderbookAgeMs: 3000,
  maxSlippageBps: new Decimal(50),
  maxGasCostUsd: new Decimal('0.50'),
  maxTransferTaxBps: new Decimal(0),
};

const buyMarket: MarketMetadata = {
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
const sellMarket: MarketMetadata = { ...buyMarket, venueId: 'mexc' };

function makeOpportunity(): OpportunityResult {
  const buyBook: OrderBookSnapshot = {
    venueId: 'gateio',
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: now,
    asks: [{ price: new Decimal('2.500'), amount: new Decimal('100') }],
    bids: [{ price: new Decimal('2.490'), amount: new Decimal('100') }],
    source: 'replay',
  };
  const sellBook: OrderBookSnapshot = {
    venueId: 'mexc',
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: now,
    asks: [{ price: new Decimal('2.560'), amount: new Decimal('100') }],
    bids: [{ price: new Decimal('2.550'), amount: new Decimal('100') }],
    source: 'replay',
  };
  const result = evaluateS1Direction({
    base: 'CAKE',
    quote: 'USDT',
    buyMarket,
    sellMarket,
    buyBook,
    sellBook,
    requestedNotional: new Decimal('30'),
    settings,
    now,
    venueHealth: { gateio: 'B', mexc: 'B' },
  });
  expect(result.valid).toBe(true);
  return result;
}

function options(batchId: string) {
  const opportunity = makeOpportunity();
  return {
    opportunity,
    options: {
      batchId,
      buyMarket,
      sellMarket,
      buyBook: {
        venueId: 'gateio',
        exchangeSymbol: 'CAKE/USDT',
        fetchedAt: now,
        asks: [{ price: new Decimal('2.500'), amount: new Decimal('100') }],
        bids: [{ price: new Decimal('2.490'), amount: new Decimal('100') }],
        source: 'replay' as const,
      },
      sellBook: {
        venueId: 'mexc',
        exchangeSymbol: 'CAKE/USDT',
        fetchedAt: now,
        asks: [{ price: new Decimal('2.560'), amount: new Decimal('100') }],
        bids: [{ price: new Decimal('2.550'), amount: new Decimal('100') }],
        source: 'replay' as const,
      },
      riskLimits: defaultPaperRiskLimits(),
      gate: createPaperGate(),
      now,
      health: { buy: 'A' as const, sell: 'A' as const },
      manualConfirmation: true,
    },
  };
}

function gateway(leg1: PaperFillScenario, leg2: PaperFillScenario): ScriptedPaperGateway {
  return new ScriptedPaperGateway({ leg1, leg2 });
}

describe('paper execution state machine', () => {
  it('closes a fully filled batch exactly once', async () => {
    const { opportunity, options: runOptions } = options('batch-full');
    const paper = gateway({ kind: 'full' }, { kind: 'full' });
    const result = await runPaperBatch(opportunity, paper, runOptions);
    expect(result.state).toBe('CLOSED');
    expect(result.closed).toBe(true);
    expect(result.realizedProfit.gt(0)).toBe(true);
    expect(paper.submitCount).toBe(2);
    expect(result.duplicateSubmitAttempts).toBe(0);
  });

  it('fails closed before submission when the limit price is off-grid', async () => {
    const { opportunity, options: runOptions } = options('batch-off-grid');
    const paper = gateway({ kind: 'full' }, { kind: 'full' });
    const result = await runPaperBatch(
      {
        ...opportunity,
        expectedBuyPrice: new Decimal('2.5001'),
      },
      paper,
      runOptions,
    );
    expect(result.state).toBe('PREFLIGHT_FAILED');
    expect(result.safeModeReason).toBe('execution_price_not_aligned');
    expect(paper.submitCount).toBe(0);
  });

  it.each([
    [
      'partial leg1',
      { kind: 'partial' as const, fillRatio: new Decimal('0.5') },
      { kind: 'full' as const },
      'LEG1_PARTIAL',
    ],
    ['unknown leg1', { kind: 'unknown' as const }, { kind: 'full' as const }, 'LEG1_UNKNOWN'],
    ['rejected leg2', { kind: 'full' as const }, { kind: 'reject' as const }, 'LEG2_REJECTED'],
    ['partial leg2', { kind: 'full' as const }, { kind: 'partial' as const }, 'LEG2_PARTIAL'],
    ['unknown leg2', { kind: 'full' as const }, { kind: 'unknown' as const }, 'LEG2_UNKNOWN'],
  ])('enters safe mode after %s', async (_name, leg1, leg2, expectedState) => {
    const { opportunity, options: runOptions } = options(`batch-${_name}`);
    const paper = gateway(leg1, leg2);
    const result = await runPaperBatch(opportunity, paper, runOptions);
    expect(result.state).toBe('SAFE_STOP');
    expect(result.states).toContain(expectedState);
    expect(result.safeMode).toBe(true);
    expect(result.operatorActionRequired).toBe(true);
  });

  it('blocks preflight when the kill switch is enabled', async () => {
    const { opportunity, options: runOptions } = options('batch-kill');
    runOptions.gate.setKillSwitch(true);
    const paper = gateway({ kind: 'full' }, { kind: 'full' });
    const result = await runPaperBatch(opportunity, paper, runOptions);
    expect(result.state).toBe('PREFLIGHT_FAILED');
    expect(paper.submitCount).toBe(0);
  });

  it('deduplicates retries with the same client order id', async () => {
    const { opportunity, options: runOptions } = options('batch-duplicate');
    const paper = gateway({ kind: 'full' }, { kind: 'full' });
    const result = await runPaperBatch(opportunity, paper, runOptions);
    expect(result.closed).toBe(true);
    const first = paper.getSubmittedOrders()[0]!;
    await paper.submit(first);
    expect(paper.duplicateSubmitAttempts).toBe(1);
    expect(paper.submitCount).toBe(2);
  });

  it('accepts explicitly configured zero taker fees', async () => {
    const zeroBuyMarket = { ...buyMarket, feeTakerBps: new Decimal(0) };
    const zeroSellMarket = { ...sellMarket, feeTakerBps: new Decimal(0) };
    const buyBook: OrderBookSnapshot = {
      venueId: 'gateio',
      exchangeSymbol: 'CAKE/USDT',
      fetchedAt: now,
      asks: [{ price: new Decimal('2.500'), amount: new Decimal('100') }],
      bids: [{ price: new Decimal('2.490'), amount: new Decimal('100') }],
      source: 'replay',
    };
    const sellBook: OrderBookSnapshot = {
      venueId: 'mexc',
      exchangeSymbol: 'CAKE/USDT',
      fetchedAt: now,
      asks: [{ price: new Decimal('2.560'), amount: new Decimal('100') }],
      bids: [{ price: new Decimal('2.550'), amount: new Decimal('100') }],
      source: 'replay',
    };
    const opportunity = evaluateS1Direction({
      base: 'CAKE',
      quote: 'USDT',
      buyMarket: zeroBuyMarket,
      sellMarket: zeroSellMarket,
      buyBook,
      sellBook,
      requestedNotional: new Decimal('30'),
      settings,
      now,
      venueHealth: { gateio: 'B', mexc: 'B' },
    });
    expect(opportunity.valid).toBe(true);

    const paper = gateway({ kind: 'full' }, { kind: 'full' });
    const result = await runPaperBatch(opportunity, paper, {
      batchId: 'batch-zero-fee',
      buyMarket: zeroBuyMarket,
      sellMarket: zeroSellMarket,
      buyBook,
      sellBook,
      riskLimits: defaultPaperRiskLimits(),
      gate: createPaperGate(),
      now,
      health: { buy: 'A', sell: 'A' },
      manualConfirmation: true,
    });
    expect(result.state).toBe('CLOSED');
    expect(paper.submitCount).toBe(2);
  });
});
