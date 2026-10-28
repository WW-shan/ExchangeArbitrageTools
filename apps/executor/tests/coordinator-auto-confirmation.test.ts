import { describe, expect, it } from 'vitest';
import { Decimal, ExecutionGate, type MarketMetadata, type OpportunityResult } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, CexAdapter } from '@arb/venues-cex';
import { CexLiveExecutor, type ExecutionVenue } from '../src/coordinator.js';

const now = 1_700_000_000_000;
const credentials: ApiCredentials = { apiKey: 'key', secret: 'secret' };

function market(venueId: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: `${venueId}:KAT/USDT`,
    unifiedSymbol: 'KAT/USDT',
    base: 'KAT',
    quote: 'USDT',
    active: true,
    pricePrecision: 5,
    amountPrecision: 0,
    amountStep: new Decimal('1'),
    priceStep: new Decimal('0.00001'),
    feeTakerBps: new Decimal('10'),
  };
}

function adapter(venueId: string): CexAdapter {
  return {
    venueId,
    tier: 'B',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: true,
      createOrder: true,
      fetchOrder: true,
      cancelOrder: true,
      websocket: false,
      ioc: false,
      fok: true,
    },
    loadMarkets: async () => [market(venueId)],
    fetchOrderBook: async () => {
      throw new Error('not reached');
    },
  } as CexAdapter;
}

function venue(venueId: string): ExecutionVenue {
  return {
    adapter: adapter(venueId),
    market: market(venueId),
    credentials,
    healthState: 'A',
  };
}

function opportunity(): OpportunityResult {
  return {
    strategy: 'S1',
    opportunityKey: 'S1|KAT/USDT|gateio|hotcoin',
    instrumentKey: 'KAT/USDT',
    direction: 'gateio->hotcoin',
    venueBuy: 'gateio',
    venueSell: 'hotcoin',
    instrumentBuy: 'KAT/USDT',
    instrumentSell: 'KAT/USDT',
    requestedNotional: new Decimal(10),
    grossSpread: new Decimal('0.1'),
    totalCost: new Decimal('0.05'),
    depthNetProfit: new Decimal('0.05'),
    conservativeNetProfit: new Decimal('0.02'),
    netProfitBps: new Decimal(20),
    dataAgeMs: 100,
    valid: true,
    rejectionReasons: [],
    sampledAt: now,
    metadata: { buySymbol: 'gateio:KAT/USDT', sellSymbol: 'hotcoin:KAT/USDT' },
  };
}

function engine(repository: ArbitrageRepository, autoExecutionEnabled: boolean) {
  const limits = {
    maxOrderNotional: new Decimal(20),
    dailyMaxLoss: new Decimal(5),
    maxOpenBatches: 1 as const,
    minNetProfitBps: new Decimal(5),
    maxStaleOrderbookMs: 3000,
    maxSlippageBps: new Decimal(30),
    killSwitchDefault: false,
  };
  const gate = new ExecutionGate(limits);
  gate.setKillSwitch(false, 'test');
  return new CexLiveExecutor({
    repository,
    gate,
    limits,
    liveEnabled: true,
    autoExecutionEnabled,
    legMode: 'serial',
    settings: {
      maxOrderbookAgeMs: 3000,
      minNetProfitBps: new Decimal(5),
      maxSlippageBps: new Decimal(30),
      minProfitUsd: new Decimal('0.01'),
      safetyBufferBps: new Decimal(2),
      maxGasCostUsd: new Decimal('0'),
      maxTransferTaxBps: new Decimal('0'),
    },
  });
}

function request() {
  return {
    batchId: 'S1-1-1700000000000',
    opportunity: opportunity(),
    opportunityId: 1,
    buy: venue('gateio'),
    sell: venue('hotcoin'),
    confirmedBatchId: 'S1-1-1700000000000',
    confirmationMode: 'automatic' as const,
  };
}

describe('automatic confirmation gates', () => {
  it('cannot bypass the persisted automatic execution flag', async () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    repository.setSetting('kill_switch', 'false', now);
    const result = await engine(repository, true).execute(request());
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('persisted_automatic_execution_disabled');
    repository.close();
  });

  it('requires the engine auto flag even when the persisted flag is on', async () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    repository.setSetting('kill_switch', 'false', now);
    repository.setSetting('auto_execution_enabled', 'true', now);
    const result = await engine(repository, false).execute(request());
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('automatic_execution_disabled');
    repository.close();
  });

  it('records an automatic confirmation before later execution gates block', async () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    repository.setSetting('kill_switch', 'false', now);
    repository.setSetting('auto_execution_enabled', 'true', now);
    const result = await engine(repository, true).execute(request());
    expect(result.outcome).toBe('BLOCKED');
    expect(result.reasons).toContain('venue_execution_disabled');
    const automatic = repository
      .listAuditLogs(20)
      .find((row) => String(row.action) === 'automatic_batch_confirmation');
    expect(automatic).toBeDefined();
    repository.close();
  });
});
