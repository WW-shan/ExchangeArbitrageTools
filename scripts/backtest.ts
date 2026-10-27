import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Decimal } from 'decimal.js';
import {
  assessStartupRecovery,
  createPaperGate,
  defaultPaperRiskLimits,
  evaluateS1Direction,
  runPaperBatch,
  ScriptedPaperGateway,
  type CostSettings,
  type HealthState,
  type MarketMetadata,
  type OpportunityResult,
  type OrderBookSnapshot,
  type PaperFillScenario,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';

interface FixtureBook {
  venueId: string;
  exchangeSymbol: string;
  fetchedAt: number;
  exchangeTimestamp?: number;
  asks: Array<[string, string]>;
  bids: Array<[string, string]>;
  source: 'rest' | 'websocket' | 'replay';
}

interface FixtureMarket {
  venueId: string;
  exchangeSymbol: string;
  unifiedSymbol: string;
  base: string;
  quote: string;
  active: boolean;
  pricePrecision: number;
  amountPrecision: number;
  amountStep: string;
  priceStep: string;
  minAmount: string;
  minNotional: string;
  feeTakerBps: string;
  supportsIoc: boolean;
  supportsFok: boolean;
}

type FixtureSample = { sampledAt: number } & Record<string, FixtureBook | number>;

interface Fixture {
  name: string;
  kind: string;
  base: string;
  quote: string;
  requestedNotional: string;
  settings: Record<string, string>;
  markets: Record<string, FixtureMarket>;
  samples: FixtureSample[];
}

function sampleBook(sample: FixtureSample, venueId: string): FixtureBook {
  const value = sample[venueId];
  if (!value || typeof value !== 'object') {
    throw new Error(`fixture sample is missing a book for ${venueId}`);
  }
  return value;
}

function snapshot(book: FixtureBook): OrderBookSnapshot {
  return {
    venueId: book.venueId,
    exchangeSymbol: book.exchangeSymbol,
    fetchedAt: book.fetchedAt,
    ...(book.exchangeTimestamp ? { exchangeTimestamp: book.exchangeTimestamp } : {}),
    asks: book.asks.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    bids: book.bids.map(([price, amount]) => ({
      price: new Decimal(price),
      amount: new Decimal(amount),
    })),
    source: book.source,
  };
}

function market(value: FixtureMarket): MarketMetadata {
  return {
    venueId: value.venueId,
    exchangeSymbol: value.exchangeSymbol,
    unifiedSymbol: value.unifiedSymbol,
    base: value.base,
    quote: value.quote,
    active: value.active,
    pricePrecision: value.pricePrecision,
    amountPrecision: value.amountPrecision,
    amountStep: new Decimal(value.amountStep),
    priceStep: new Decimal(value.priceStep),
    minAmount: new Decimal(value.minAmount),
    minNotional: new Decimal(value.minNotional),
    feeTakerBps: new Decimal(value.feeTakerBps),
    supportsIoc: value.supportsIoc,
    supportsFok: value.supportsFok,
  };
}

function settingsFrom(fixture: Fixture): CostSettings {
  return {
    minProfitUsd: new Decimal(fixture.settings.minProfitUsd!),
    safetyBufferBps: new Decimal(fixture.settings.safetyBufferBps!),
    minNetProfitBps: new Decimal(fixture.settings.minNetProfitBps!),
    maxOrderbookAgeMs: Number(fixture.settings.maxOrderbookAgeMs),
    maxSlippageBps: new Decimal(fixture.settings.maxSlippageBps!),
    maxGasCostUsd: new Decimal(fixture.settings.maxGasCostUsd!),
    maxTransferTaxBps: new Decimal(fixture.settings.maxTransferTaxBps!),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`BACKTEST FAILED: ${message}`);
}

const fixturePath = resolve(process.argv[2] ?? 'fixtures/backtest/s1-cake-usdt.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
assert(
  fixture.kind === 'synthetic-calibration' || fixture.kind === 'captured-market',
  'unknown fixture kind',
);
assert(fixture.samples.length >= 20, 'fixture must contain at least 20 samples');
const venueIds = Object.keys(fixture.markets);
assert(venueIds.length === 2, 'fixture must contain exactly two venues for S1 backtest');
const [firstVenueId, secondVenueId] = venueIds as [string, string];
for (const sample of fixture.samples) {
  assert(
    sample.sampledAt >= sampleBook(sample, firstVenueId).fetchedAt - 250,
    `sample ${sample.sampledAt} was recorded before its ${firstVenueId} book`,
  );
  assert(
    sample.sampledAt >= sampleBook(sample, secondVenueId).fetchedAt - 250,
    `sample ${sample.sampledAt} was recorded before its ${secondVenueId} book`,
  );
}
const settings = settingsFrom(fixture);
const firstMarket = market(fixture.markets[firstVenueId]!);
const secondMarket = market(fixture.markets[secondVenueId]!);
const venueHealth: Record<string, HealthState> = {
  [firstVenueId]: 'B',
  [secondVenueId]: 'B',
};
const marketFor = (venueId: string): MarketMetadata => {
  if (venueId === firstVenueId) return firstMarket;
  if (venueId === secondVenueId) return secondMarket;
  throw new Error(`fixture does not contain venue ${venueId}`);
};
const requestedNotional = new Decimal(fixture.requestedNotional);

const db = openDatabase(':memory:');
const repo = new ArbitrageRepository(db);
repo.upsertVenue({ id: firstVenueId, type: 'cex', name: firstVenueId, tier: 'S' });
repo.upsertVenue({ id: secondVenueId, type: 'cex', name: secondVenueId, tier: 'S' });

let consecutiveSuccesses = 0;
let realizedProfit = new Decimal(0);
let lastGateway: ScriptedPaperGateway | undefined;
let lastOpportunity: OpportunityResult | undefined;
let lastBooks: { buy: OrderBookSnapshot; sell: OrderBookSnapshot } | undefined;
let validSamples = 0;
let bestNetProfitBps: Decimal | undefined;
const rejectionCounts: Record<string, number> = {};

for (const sample of fixture.samples) {
  const firstBook = snapshot(sampleBook(sample, firstVenueId));
  const secondBook = snapshot(sampleBook(sample, secondVenueId));
  const forward = evaluateS1Direction({
    base: fixture.base,
    quote: fixture.quote,
    buyMarket: firstMarket,
    sellMarket: secondMarket,
    buyBook: firstBook,
    sellBook: secondBook,
    requestedNotional,
    settings,
    now: sample.sampledAt,
    venueHealth,
  });
  const reverse = evaluateS1Direction({
    base: fixture.base,
    quote: fixture.quote,
    buyMarket: secondMarket,
    sellMarket: firstMarket,
    buyBook: secondBook,
    sellBook: firstBook,
    requestedNotional,
    settings,
    now: sample.sampledAt,
    venueHealth,
  });
  const opportunity =
    forward.valid !== reverse.valid
      ? forward.valid
        ? forward
        : reverse
      : forward.conservativeNetProfit.gte(reverse.conservativeNetProfit)
        ? forward
        : reverse;
  bestNetProfitBps =
    bestNetProfitBps === undefined || opportunity.netProfitBps.gt(bestNetProfitBps)
      ? opportunity.netProfitBps
      : bestNetProfitBps;
  const stored = repo.recordOpportunity(opportunity, 60_000);
  if (!opportunity.valid) {
    for (const reason of opportunity.rejectionReasons) {
      rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
    }
    if (fixture.kind === 'synthetic-calibration') {
      assert(opportunity.valid, `sample ${sample.sampledAt} did not produce a valid opportunity`);
    }
    continue;
  }
  validSamples += 1;
  const buyBook = opportunity.venueBuy === firstVenueId ? firstBook : secondBook;
  const sellBook = opportunity.venueSell === secondVenueId ? secondBook : firstBook;
  const paper = new ScriptedPaperGateway({ leg1: { kind: 'full' }, leg2: { kind: 'full' } });
  const result = await runPaperBatch(opportunity, paper, {
    batchId: `backtest-${sample.sampledAt}`,
    buyMarket: marketFor(opportunity.venueBuy),
    sellMarket: marketFor(opportunity.venueSell),
    buyBook,
    sellBook,
    riskLimits: defaultPaperRiskLimits(new Decimal('30')),
    gate: createPaperGate(new Decimal('30')),
    now: sample.sampledAt,
    health: { buy: 'A', sell: 'A' },
    manualConfirmation: true,
  });
  assert(result.closed && result.state === 'CLOSED', `batch ${result.batchId} did not close`);
  assert(result.realizedProfit.gt(0), `batch ${result.batchId} was not profitable`);
  assert(
    result.duplicateSubmitAttempts === 0,
    `batch ${result.batchId} attempted a duplicate order`,
  );
  assert(paper.submitCount === 2, `batch ${result.batchId} did not submit exactly two legs`);
  repo.recordPaperTrade({
    opportunityId: stored.id,
    requestedNotional: opportunity.requestedNotional,
    simulatedBaseAmount: result.filledBaseAmount,
    buyPriceAverage: opportunity.buyDepth!.averagePrice,
    sellPriceAverage: opportunity.sellDepth!.averagePrice,
    buyPriceWorst: opportunity.buyDepth!.worstPrice,
    sellPriceWorst: opportunity.sellDepth!.worstPrice,
    fees: result.fees,
    gasCost: new Decimal(0),
    netProfit: result.realizedProfit,
    result: result.state,
    executedAt: sample.sampledAt + 1,
    durationMs: stored.episodeId ? repo.episodeDuration(stored.episodeId) : 0,
    expectedFailureReasons: opportunity.rejectionReasons,
    fillQuality: {
      strategy: 'S1',
      closed: result.closed,
      safeMode: result.safeMode,
      ...(result.safeModeReason ? { safeModeReason: result.safeModeReason } : {}),
      leg1: result.leg1Fill
        ? {
            requestedAmount: result.leg1Fill.requestedAmount.toFixed(),
            filledAmount: result.leg1Fill.filledAmount.toFixed(),
            averagePrice: result.leg1Fill.averagePrice.toFixed(),
            limitPrice: result.leg1Fill.limitPrice.toFixed(),
            fee: result.leg1Fill.fee.toFixed(),
            status: result.leg1Fill.status,
          }
        : null,
      leg2: result.leg2Fill
        ? {
            requestedAmount: result.leg2Fill.requestedAmount.toFixed(),
            filledAmount: result.leg2Fill.filledAmount.toFixed(),
            averagePrice: result.leg2Fill.averagePrice.toFixed(),
            limitPrice: result.leg2Fill.limitPrice.toFixed(),
            fee: result.leg2Fill.fee.toFixed(),
            status: result.leg2Fill.status,
          }
        : null,
    },
  });
  realizedProfit = realizedProfit.plus(result.realizedProfit);
  consecutiveSuccesses += 1;
  lastGateway = paper;
  lastOpportunity = opportunity;
  lastBooks = { buy: buyBook, sell: sellBook };
}

const stage2 = fixture.kind === 'synthetic-calibration';
assert(
  !stage2 || consecutiveSuccesses >= 20,
  `only ${consecutiveSuccesses} consecutive successful batches`,
);
let duplicateAttemptsRejected: number | null = null;
let killSwitchPreflight: string[] | null = null;
let restartRecovery: Record<string, unknown> | null = null;
const failureResults: Array<Record<string, unknown>> = [];
if (stage2) {
  assert(
    lastGateway && lastOpportunity && lastBooks,
    'no successful batch available for duplicate test',
  );
  const firstRequest = lastGateway.getSubmittedOrders()[0]!;
  await lastGateway.submit(firstRequest);
  assert(lastGateway.duplicateSubmitAttempts === 1, 'duplicate client order id was not rejected');
  duplicateAttemptsRejected = lastGateway.duplicateSubmitAttempts;
}

const failureScenarios: Array<{
  name: string;
  leg1: PaperFillScenario;
  leg2: PaperFillScenario;
  expectedState: string;
}> = [
  {
    name: 'partial-first-leg',
    leg1: { kind: 'partial', fillRatio: new Decimal('0.5') },
    leg2: { kind: 'full' },
    expectedState: 'LEG1_PARTIAL',
  },
  {
    name: 'request-timeout-leg1',
    leg1: { kind: 'unknown' },
    leg2: { kind: 'full' },
    expectedState: 'LEG1_UNKNOWN',
  },
  {
    name: 'second-leg-rejected',
    leg1: { kind: 'full' },
    leg2: { kind: 'reject' },
    expectedState: 'LEG2_REJECTED',
  },
  {
    name: 'second-leg-partial',
    leg1: { kind: 'full' },
    leg2: { kind: 'partial', fillRatio: new Decimal('0.5') },
    expectedState: 'LEG2_PARTIAL',
  },
  {
    name: 'second-leg-timeout',
    leg1: { kind: 'full' },
    leg2: { kind: 'unknown' },
    expectedState: 'LEG2_UNKNOWN',
  },
];

if (stage2) {
  assert(lastOpportunity && lastBooks, 'no successful batch available for failure-path tests');
  for (const scenario of failureScenarios) {
    const paper = new ScriptedPaperGateway({ leg1: scenario.leg1, leg2: scenario.leg2 });
    const gate = createPaperGate(new Decimal('30'));
    const result = await runPaperBatch(lastOpportunity, paper, {
      batchId: `fault-${scenario.name}`,
      buyMarket: marketFor(lastOpportunity.venueBuy),
      sellMarket: marketFor(lastOpportunity.venueSell),
      buyBook: lastBooks.buy,
      sellBook: lastBooks.sell,
      riskLimits: defaultPaperRiskLimits(new Decimal('30')),
      gate,
      now: fixture.samples.at(-1)!.sampledAt,
      health: { buy: 'A', sell: 'A' },
      manualConfirmation: true,
    });
    assert(result.state === 'SAFE_STOP', `${scenario.name} did not enter SAFE_STOP`);
    assert(
      result.states.includes(scenario.expectedState as never),
      `${scenario.name} skipped ${scenario.expectedState}`,
    );
    assert(result.operatorActionRequired, `${scenario.name} did not require operator action`);
    assert(paper.duplicateSubmitAttempts === 0, `${scenario.name} attempted duplicate submission`);
    failureResults.push({
      scenario: scenario.name,
      state: result.state,
      path: result.states,
      reason: result.safeModeReason,
      killSwitch: gate.killSwitch,
      submittedOrders: paper.submitCount,
    });
  }

  const killGate = createPaperGate(new Decimal('30'));
  killGate.setKillSwitch(true);
  const killPaper = new ScriptedPaperGateway({ leg1: { kind: 'full' }, leg2: { kind: 'full' } });
  const killResult = await runPaperBatch(lastOpportunity, killPaper, {
    batchId: 'preflight-kill-switch',
    buyMarket: marketFor(lastOpportunity.venueBuy),
    sellMarket: marketFor(lastOpportunity.venueSell),
    buyBook: lastBooks.buy,
    sellBook: lastBooks.sell,
    riskLimits: defaultPaperRiskLimits(new Decimal('30')),
    gate: killGate,
    now: fixture.samples.at(-1)!.sampledAt,
    health: { buy: 'A', sell: 'A' },
    manualConfirmation: true,
  });
  assert(killResult.state === 'PREFLIGHT_FAILED', 'kill switch did not block preflight');
  assert(killPaper.submitCount === 0, 'kill switch allowed an order submission');
  killSwitchPreflight = killResult.states;

  const restartExecutionId = repo.createExecution({
    strategy: 'S1',
    batchId: 'restart-simulation',
    status: 'LEG1_UNKNOWN',
    plannedNotional: requestedNotional,
    expectedProfit: lastOpportunity.conservativeNetProfit,
    openedAt: fixture.samples.at(-1)!.sampledAt + 2,
  });
  repo.addExecutionLeg({
    executionId: restartExecutionId,
    legNumber: 1,
    venueId: lastOpportunity.venueBuy,
    side: 'buy',
    requestedAmount: lastOpportunity.buyDepth!.executableBaseAmount,
    requestedPrice: lastOpportunity.expectedBuyPrice!,
    status: 'unknown',
    submittedAt: fixture.samples.at(-1)!.sampledAt + 2,
    clientOrderId: 'restart-simulation-L1',
  });
  const recoveryCounts = repo.recoveryCounts();
  const recovery = assessStartupRecovery({
    openExecutions: recoveryCounts.openExecutions,
    unresolvedLegs: recoveryCounts.unresolvedLegs,
    persistedKillSwitch: true,
    balancesConfirmed: false,
  });
  assert(recovery.blockExecution, 'restart recovery did not block execution');
  assert(recovery.killSwitch, 'restart recovery did not restore kill switch');
  restartRecovery = { counts: recoveryCounts, decision: recovery };
}

repo.closeStaleEpisodes(fixture.samples.at(-1)!.sampledAt + 120_000, 60_000);
const averageProfit =
  consecutiveSuccesses > 0 ? realizedProfit.div(consecutiveSuccesses).toFixed(8) : '0.00000000';
const summary = {
  fixture: fixturePath,
  fixtureKind: fixture.kind,
  validationScope: stage2 ? 'stage2-paper-simulation' : 'captured-market-analysis',
  samples: fixture.samples.length,
  actionableSamples: validSamples,
  invalidSamples: fixture.samples.length - validSamples,
  rejectionCounts,
  bestNetProfitBps: bestNetProfitBps?.toFixed(8) ?? null,
  paperBatches: consecutiveSuccesses,
  consecutiveSuccesses,
  realizedProfit: realizedProfit.toFixed(8),
  averageProfit,
  stage2PaperValidated: stage2,
  duplicateAttemptsRejected,
  failureScenarios: failureResults,
  killSwitchPreflight,
  restartRecovery,
  persistence: {
    opportunities: repo.listOpportunities({ limit: 1000 }).length,
    episodes: repo.listEpisodes(1000).length,
    paperTrades: repo.paperTradeSummary(),
  },
  passed: true,
};
const reportPath = resolve(
  stage2
    ? 'data/backtest-report.json'
    : `data/backtest-report-${fixture.base}-${fixture.quote}.json`,
);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
repo.close();
