import {
  Decimal,
  assessRotationReadiness,
  canonicalAmountFromExchange,
  marketBaseMultiplier,
  marketExchangeBase,
  type MarketMetadata,
  type OpportunityResult,
  type RotationBalances,
} from '@arb/core';
import type { ArbitrageRepository, LoadedOpportunity } from '@arb/storage';
import { applyFeeOverride, mergeAccountFeeFile } from '@arb/venues-cex';
import {
  decideAutoRotation,
  decideAutoRebalance,
  estimateRotationRebalance,
  evaluatePreparationGate,
  rotationPairConfig,
  rotationRebalanceTargets,
  rotationRequirementFromOpportunity,
  scannerDirectionForRotation,
  venuesForRotationDirection,
} from './auto-rotation.js';
import { refreshBalances } from './balance-service.js';
import type { RecoveryVenue } from './bootstrap.js';
import type { ExecutorConfig, RotationPairConfig } from './config.js';
import { CexLiveExecutor, type ExecutionVenue } from './coordinator.js';
import { writeHeartbeat } from './heartbeat.js';
import { s1BatchId } from './handoff.js';
import { executionVenue, healthStates, splitInstrument } from './runtime.js';
import { evaluateAccountPermissions, type AccountPermissionReport } from './account-permissions.js';
import type { StoredCredential } from './secret-store.js';
import {
  TRANSFER_BATCH_STATUS,
  executeTransferBatch,
  planTransferBatch,
  reconcileTransferBatch,
  type TransferVenues,
} from './transfer-service.js';

const EXECUTOR_STARTED_AT = Date.now();

export interface AutoRotationSupervisorOptions {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  engine: CexLiveExecutor;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  accountStatusCredentials?: readonly StoredCredential[];
  transferVenues?: TransferVenues;
}

interface PairBalances {
  readinessBalances: RotationBalances;
  fresh: boolean;
  reasons: string[];
}

interface PreparationCandidate {
  loaded: LoadedOpportunity;
  pair: RotationPairConfig;
  buy: ExecutionVenue;
  sell: ExecutionVenue;
  direction: 'gate->hotcoin' | 'hotcoin->gate';
  opportunity: OpportunityResult;
  batchId: string;
  preparation: {
    maxCostBps: Decimal;
    maxCostUsd: Decimal;
  };
}

interface ExecutionSelection {
  loaded: LoadedOpportunity;
  buy: ExecutionVenue;
  sell: ExecutionVenue;
  batchId: string;
  opportunity: OpportunityResult;
  direction: 'gate->hotcoin' | 'hotcoin->gate';
  intent: 'arbitrage' | 'inventory_preparation';
  preparation?: {
    maxCostBps: Decimal;
    maxCostUsd: Decimal;
  };
}

interface UnfundedCandidate {
  loaded: LoadedOpportunity;
  pair: RotationPairConfig;
  direction: 'gate->hotcoin' | 'hotcoin->gate';
  readiness: ReturnType<typeof assessRotationReadiness>;
  requirement: NonNullable<ReturnType<typeof rotationRequirementFromOpportunity>>;
  balances: PairBalances;
}

export function isRotationExecutionVenue(
  venueId: string,
  pair?: Pick<RotationPairConfig, 'venues'>,
): boolean {
  const venues = pair?.venues ?? ['gateio', 'hotcoin'];
  return venues.includes(venueId.trim().toLowerCase());
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function balanceCurrency(marketBase: string, quote: string): { base: string; quote: string } {
  return { base: marketBase.toUpperCase(), quote: quote.toUpperCase() };
}

export function pairBalances(
  repository: ArbitrageRepository,
  pair: RotationPairConfig,
  markets: Record<string, MarketMetadata[]>,
  now: number,
  maxAgeMs: number,
): PairBalances {
  const reasons: string[] = [];
  const [venueA, venueB] = pair.venues;
  const gateMarket = markets[venueA]?.find(
    (market) =>
      market.active &&
      market.base.toUpperCase() === pair.base &&
      market.quote.toUpperCase() === pair.quote,
  );
  const hotMarket = markets[venueB]?.find(
    (market) =>
      market.active &&
      market.base.toUpperCase() === pair.base &&
      market.quote.toUpperCase() === pair.quote,
  );
  if (!gateMarket) reasons.push(`${venueA}_market_missing`);
  if (!hotMarket) reasons.push(`${venueB}_market_missing`);
  if (!gateMarket || !hotMarket) {
    return {
      readinessBalances: {
        gateBase: new Decimal(0),
        gateQuote: new Decimal(0),
        hotcoinBase: new Decimal(0),
        hotcoinQuote: new Decimal(0),
      },
      fresh: false,
      reasons,
    };
  }
  const gateCurrencies = balanceCurrency(marketExchangeBase(gateMarket), pair.quote);
  const hotCurrencies = balanceCurrency(marketExchangeBase(hotMarket), pair.quote);
  const rows = repository.latestBalances({ maxAgeMs: maxAgeMs + 1, now });
  const venueFresh = (venueId: string): boolean =>
    rows.some((balance) => balance.venueId === venueId && balance.fetchedAt >= now - maxAgeMs);
  if (!venueFresh(venueA)) reasons.push(`${venueA}_balance_snapshot_stale`);
  if (!venueFresh(venueB)) reasons.push(`${venueB}_balance_snapshot_stale`);
  const free = (venueId: string, currency: string): Decimal =>
    rows.find(
      (balance) =>
        balance.venueId === venueId &&
        balance.currency.trim().toUpperCase() === currency.trim().toUpperCase(),
    )?.free ?? new Decimal(0);
  return {
    readinessBalances: {
      gateBase: canonicalAmountFromExchange(
        free(venueA, gateCurrencies.base),
        marketBaseMultiplier(gateMarket),
      ),
      gateQuote: free(venueA, gateCurrencies.quote),
      hotcoinBase: canonicalAmountFromExchange(
        free(venueB, hotCurrencies.base),
        marketBaseMultiplier(hotMarket),
      ),
      hotcoinQuote: free(venueB, hotCurrencies.quote),
    },
    fresh: reasons.length === 0,
    reasons,
  };
}

function logEvent(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), mode: 'auto_rotation', ...payload }));
}

function logAccountState(
  repository: ArbitrageRepository,
  config: ExecutorConfig,
  markets: Record<string, MarketMetadata[]>,
  now: number,
): void {
  const maxAgeMs = Math.max(config.autoRotation.balanceRefreshMs * 2, 30_000);
  const pairs = config.autoRotation.pairs.map((pair) => {
    const balances = pairBalances(repository, pair, markets, now, maxAgeMs);
    const [venueA, venueB] = pair.venues;
    return {
      pair: `${pair.base}/${pair.quote}`,
      venues: {
        [venueA]: {
          base: balances.readinessBalances.gateBase.toFixed(),
          quote: balances.readinessBalances.gateQuote.toFixed(),
        },
        [venueB]: {
          base: balances.readinessBalances.hotcoinBase.toFixed(),
          quote: balances.readinessBalances.hotcoinQuote.toFixed(),
        },
      },
      gateBase: balances.readinessBalances.gateBase.toFixed(),
      gateQuote: balances.readinessBalances.gateQuote.toFixed(),
      hotcoinBase: balances.readinessBalances.hotcoinBase.toFixed(),
      hotcoinQuote: balances.readinessBalances.hotcoinQuote.toFixed(),
      fresh: balances.fresh,
      reasons: balances.reasons,
    };
  });
  logEvent({
    status: 'account_state',
    openExecutions: repository.countOpenExecutions(),
    unresolvedOrders: repository.countUnresolvedOrders(),
    pairs,
  });
}

function recordHeartbeat(
  repository: ArbitrageRepository,
  config: ExecutorConfig,
  state: 'running' | 'stopped',
  lastWaitReasons?: string[],
  phase?: string,
): void {
  try {
    writeHeartbeat(
      process.env.ARB_ROTATION_EXECUTOR_HEARTBEAT ?? config.autoRotation.heartbeatFile,
      {
        version: 1,
        role: 'executor',
        ...(process.env.ARB_ROTATION_RUN_ID ? { runId: process.env.ARB_ROTATION_RUN_ID } : {}),
        pid: process.pid,
        startedAt: Number(process.env.ARB_ROTATION_STARTED_AT ?? EXECUTOR_STARTED_AT),
        updatedAt: Date.now(),
        state,
        phase: state === 'stopped' ? 'STOPPED' : (phase ?? 'RUNNING'),
        lastProgressAt: Date.now(),
        openExecutions: repository.countOpenExecutions(),
        unresolvedOrders: repository.countUnresolvedOrders(),
        ...(lastWaitReasons ? { lastWaitReasons } : {}),
        details: {
          autoExecutionEnabled: repository.getSetting('auto_execution_enabled'),
          supervised: process.env.ARB_ROTATION_SUPERVISED === '1',
        },
      },
    );
  } catch (error) {
    logEvent({ status: 'heartbeat_failed', error: String(error) });
  }
}

async function loadMarkets(
  adapters: Readonly<Record<string, RecoveryVenue>>,
  config: ExecutorConfig,
): Promise<Record<string, MarketMetadata[]>> {
  const feeOverrides = mergeAccountFeeFile(config.feeOverrides, config.feeFile);
  const result: Record<string, MarketMetadata[]> = {};
  const venueIds = [...new Set(config.autoRotation.pairs.flatMap((pair) => [...pair.venues]))];
  for (const venueId of venueIds) {
    const adapter = adapters[venueId]?.adapter;
    if (!adapter) throw new Error(`missing trade adapter for ${venueId}`);
    result[venueId] = (await adapter.loadMarkets()).map((market) =>
      applyFeeOverride(market, feeOverrides),
    );
  }
  return result;
}

function actionableCandidate(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  markets: Awaited<ReturnType<typeof loadMarkets>>;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  candidates: readonly LoadedOpportunity[];
  now: number;
  lastAttemptAt?: number;
}):
  | {
      loaded: LoadedOpportunity;
      pair: RotationPairConfig;
      buy: ExecutionVenue;
      sell: ExecutionVenue;
      decision: ReturnType<typeof decideAutoRotation>;
    }
  | { waitReasons: string[]; unfunded?: UnfundedCandidate } {
  const { repository, config, markets, adapters, candidates, now, lastAttemptAt } = input;
  const states = healthStates(repository);
  let lastWait: string[] = ['no_valid_opportunity'];
  let bestUnfunded: UnfundedCandidate | undefined;
  for (const loaded of candidates) {
    const opportunity = loaded.opportunity;
    const pair = rotationPairConfig(config.autoRotation.pairs, opportunity.instrumentKey);
    const instrument = splitInstrument(opportunity.instrumentKey);
    if (!pair || !instrument) {
      lastWait = ['pair_not_whitelisted'];
      continue;
    }
    if (
      !isRotationExecutionVenue(opportunity.venueBuy, pair) ||
      !isRotationExecutionVenue(opportunity.venueSell, pair)
    ) {
      lastWait = [`monitor_only_route:${opportunity.venueBuy}->${opportunity.venueSell}`];
      continue;
    }
    const buyHealth = states.get(opportunity.venueBuy) ?? 'D';
    const sellHealth = states.get(opportunity.venueSell) ?? 'D';
    if ((buyHealth !== 'A' && buyHealth !== 'B') || (sellHealth !== 'A' && sellHealth !== 'B')) {
      lastWait = [
        `venue_health_blocked:${opportunity.venueBuy}=${buyHealth},${opportunity.venueSell}=${sellHealth}`,
      ];
      continue;
    }
    const requirement = rotationRequirementFromOpportunity(loaded);
    if (!requirement) {
      lastWait = ['buy_depth_price_missing'];
      continue;
    }
    const balances = pairBalances(
      repository,
      pair,
      markets,
      now,
      Math.max(config.autoRotation.balanceRefreshMs * 2, 30_000),
    );
    if (!balances.fresh) {
      lastWait = balances.reasons;
      continue;
    }
    let buy: ExecutionVenue;
    let sell: ExecutionVenue;
    try {
      buy = executionVenue(
        opportunity.venueBuy,
        markets[opportunity.venueBuy] ?? [],
        instrument,
        adapters,
        states,
        config.feeOverrides,
        opportunity.metadata?.buySymbol,
      );
      sell = executionVenue(
        opportunity.venueSell,
        markets[opportunity.venueSell] ?? [],
        instrument,
        adapters,
        states,
        config.feeOverrides,
        opportunity.metadata?.sellSymbol,
      );
    } catch (error) {
      lastWait = [`market_resolution_failed:${String(error)}`];
      continue;
    }
    const readiness = assessRotationReadiness(balances.readinessBalances, requirement);
    const decision = decideAutoRotation({
      loaded,
      ageMs: Math.max(0, now - opportunity.sampledAt),
      pair,
      readiness,
      liveEnabled: config.liveEnabled,
      autoExecutionEnabled: config.autoRotation.enabled,
      persistedAutoExecutionEnabled: repository.getSetting('auto_execution_enabled') === 'true',
      killSwitch: repository.getSetting('kill_switch') !== 'false',
      openExecutions: repository.countOpenExecutions(),
      unresolvedOrders: repository.countUnresolvedOrders(),
      alreadyExecuted: repository.executionForOpportunity(loaded.id) !== undefined,
      dailyRealizedLoss: repository.riskSnapshot(now).dailyRealizedLoss,
      dailyMaxLoss: config.riskLimits.dailyMaxLoss,
      maxOrderNotional: config.riskLimits.maxOrderNotional,
      maxSignalAgeMs: config.autoRotation.maxSignalAgeMs,
      ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
      now,
      cooldownMs: config.autoRotation.cooldownMs,
    });
    if (decision.action === 'EXECUTE') {
      return { loaded, pair, buy, sell, decision };
    }
    if (
      !bestUnfunded &&
      decision.action === 'WAIT' &&
      decision.reasons.includes('direction_not_funded') &&
      decision.direction
    ) {
      bestUnfunded = {
        loaded,
        pair,
        direction: decision.direction,
        readiness,
        requirement,
        balances,
      };
    }
    lastWait = [...decision.reasons];
  }
  return { waitReasons: lastWait, ...(bestUnfunded ? { unfunded: bestUnfunded } : {}) };
}

function preparationCandidate(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  markets: Awaited<ReturnType<typeof loadMarkets>>;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  candidates: readonly LoadedOpportunity[];
  now: number;
}): { candidate: PreparationCandidate } | { waitReasons: string[] } {
  const { repository, config, markets, adapters, candidates, now } = input;
  const preparation = config.autoRotation.preparation;
  if (!preparation.enabled) return { waitReasons: ['preparation_disabled'] };
  if (repository.getSetting('balance_mismatch') === 'true') {
    return { waitReasons: ['preparation_balance_mismatch'] };
  }
  if (repository.countOpenExecutions() > 0) {
    return { waitReasons: ['preparation_open_execution'] };
  }
  if (repository.countUnresolvedOrders() > 0) {
    return { waitReasons: ['preparation_unresolved_order'] };
  }
  if (repository.riskSnapshot(now).dailyRealizedLoss.gte(config.riskLimits.dailyMaxLoss)) {
    return { waitReasons: ['preparation_daily_loss_limit'] };
  }
  const states = healthStates(repository);
  const profitOnly = new Set([
    'gross_profit_below_threshold',
    'conservative_profit_below_threshold',
  ]);
  let lastReason = 'preparation_not_available';
  for (const pair of config.autoRotation.pairs) {
    const balances = pairBalances(
      repository,
      pair,
      markets,
      now,
      Math.max(config.autoRotation.balanceRefreshMs * 2, 30_000),
    );
    if (!balances.fresh) continue;
    for (const direction of ['gate->hotcoin', 'hotcoin->gate'] as const) {
      const scannerDirection = scannerDirectionForRotation(direction, pair);
      const loaded = candidates.find(
        (candidate) =>
          candidate.opportunity.instrumentKey === `${pair.base}/${pair.quote}` &&
          candidate.opportunity.direction === scannerDirection &&
          now - candidate.opportunity.sampledAt <= config.autoRotation.maxSignalAgeMs,
      );
      if (!loaded) continue;
      const reasons = loaded.opportunity.rejectionReasons;
      if (reasons.length === 0 || !reasons.every((reason) => profitOnly.has(reason))) continue;
      const depthNetBps = loaded.opportunity.requestedNotional.gt(0)
        ? loaded.opportunity.depthNetProfit.div(loaded.opportunity.requestedNotional).mul(10_000)
        : new Decimal(Number.NEGATIVE_INFINITY);
      const requestedNotional = Decimal.min(
        loaded.opportunity.requestedNotional,
        preparation.maxNotional,
        pair.maxNotional,
      );
      if (requestedNotional.lt(config.minSizingNotional)) continue;
      const costBps = depthNetBps.lt(0) ? depthNetBps.abs() : new Decimal(0);
      const costUsd = costBps.div(10_000).mul(requestedNotional);
      const matchingCalibrations = Object.values(preparation.calibration)
        .filter(
          (entry) =>
            entry.pair === `${pair.base}/${pair.quote}` &&
            entry.direction === direction &&
            entry.prepBandBps.gte(costBps),
        )
        .sort((left, right) => left.prepBandBps.comparedTo(right.prepBandBps));
      const calibration = matchingCalibrations[0];
      if (!calibration) {
        lastReason = Object.values(preparation.calibration).some(
          (entry) => entry.pair === `${pair.base}/${pair.quote}` && entry.direction === direction,
        )
          ? 'preparation_cost_above_calibrated_band'
          : 'preparation_calibration_missing';
        continue;
      }
      const gate = evaluatePreparationGate({
        calibration,
        requestedNotional,
        costBps,
        minReverseProbability: preparation.minReverseProbability,
        maxHoldMs: preparation.maxHoldMs,
        minExpectedValueBps: preparation.minExpectedValueBps,
        minExpectedValueUsd: preparation.minExpectedValueUsd,
      });
      if (!gate.allowed) {
        lastReason = gate.reasons[0] ?? lastReason;
        continue;
      }
      const maxCostBps = gate.breakEvenCostBps!.minus(preparation.minExpectedValueBps);
      const maxCostUsd = requestedNotional.mul(maxCostBps).div(10_000);
      const adjustedExpectedValueBps = gate.adjustedExpectedValueBps!;
      const adjustedExpectedValueUsd = gate.adjustedExpectedValueUsd!;
      const opportunity: OpportunityResult = {
        ...loaded.opportunity,
        requestedNotional,
        valid: true,
        rejectionReasons: [],
        metadata: {
          ...(loaded.opportunity.metadata ?? {}),
          intent: 'inventory_preparation',
          preparationCostBps: costBps.toFixed(),
          preparationCostUsd: costUsd.toFixed(),
          preparationBreakEvenCostBps: gate.breakEvenCostBps!.toFixed(),
          preparationMaxCostBps: maxCostBps.toFixed(),
          preparationMaxCostUsd: maxCostUsd.toFixed(),
          reversionProbability: calibration!.reverseProbability.toFixed(),
          reversionHorizonMs: String(calibration!.horizonMs),
          calibrationExpectedValueBps: calibration!.expectedValueBps.toFixed(),
          adjustedExpectedValueBps: adjustedExpectedValueBps.toFixed(),
          adjustedExpectedValueUsd: adjustedExpectedValueUsd.toFixed(),
          calibrationSamples: String(calibration!.candidateSamples),
        },
      };
      const requirement = rotationRequirementFromOpportunity({ id: loaded.id, opportunity });
      if (!requirement) continue;
      const readiness = assessRotationReadiness(balances.readinessBalances, requirement);
      const funded = direction === 'gate->hotcoin' ? readiness.gateToHot : readiness.hotToGate;
      if (!funded) continue;
      const [venueBuy, venueSell] = venuesForRotationDirection(direction, pair);
      if (states.get(venueBuy) !== 'A' || states.get(venueSell) !== 'A') continue;
      let buy: ExecutionVenue;
      let sell: ExecutionVenue;
      try {
        buy = executionVenue(
          venueBuy,
          markets[venueBuy] ?? [],
          { base: pair.base, quote: pair.quote },
          adapters,
          states,
          config.feeOverrides,
          opportunity.metadata?.buySymbol,
        );
        sell = executionVenue(
          venueSell,
          markets[venueSell] ?? [],
          { base: pair.base, quote: pair.quote },
          adapters,
          states,
          config.feeOverrides,
          opportunity.metadata?.sellSymbol,
        );
      } catch {
        continue;
      }
      if (repository.executionForOpportunity(loaded.id) !== undefined) continue;
      return {
        candidate: {
          loaded,
          pair,
          buy,
          sell,
          direction,
          opportunity,
          batchId: `PREP-${pair.base}-${now}-${venueBuy}-${venueSell}`,
          preparation: {
            maxCostBps,
            maxCostUsd,
          },
        },
      };
    }
  }
  return { waitReasons: [lastReason] };
}

type RebalanceAttempt =
  | { action: 'NOOP' | 'WAIT' | 'BLOCKED'; reasons: string[] }
  | { action: 'PLANNED'; batchId: string; reasons: string[] }
  | { action: 'COMPLETED' | 'SAFE_STOP'; batchId: string; reasons: string[] };

async function rebalanceUnfundedCandidate(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  transferVenues?: TransferVenues;
  unfunded: UnfundedCandidate;
  now: number;
}): Promise<RebalanceAttempt> {
  const { repository, config, transferVenues, unfunded, now } = input;
  if (!transferVenues) return { action: 'WAIT', reasons: ['transfer_venues_unavailable'] };
  const opportunity = unfunded.loaded.opportunity;
  const basePrice = opportunity.expectedBuyPrice ?? opportunity.expectedSellPrice;
  if (!basePrice || basePrice.lte(0)) {
    return { action: 'WAIT', reasons: ['rebalance_asset_price_unknown'] };
  }
  const quote = unfunded.pair.quote.toUpperCase();
  const assetPricesUsd: Record<string, Decimal> = {
    [unfunded.pair.base.toUpperCase()]: basePrice,
    ...(['USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI'].includes(quote)
      ? { [quote]: new Decimal(1) }
      : {}),
  };
  const estimate = estimateRotationRebalance({
    direction: unfunded.direction,
    base: unfunded.pair.base,
    quote: unfunded.pair.quote,
    balances: unfunded.balances.readinessBalances,
    requirement: unfunded.requirement,
    venues: unfunded.pair.venues,
    allowlist: config.transfers.allowlist,
    assetPricesUsd,
  });
  if (estimate.legs.length === 0) return { action: 'NOOP', reasons: ['no_transfer_required'] };

  const gate = decideAutoRebalance({
    transfersEnabled: config.transfers.enabled,
    releaseMode: config.transfers.releaseMode,
    autoReleaseArmed: repository.getSetting('transfer_auto_release_enabled') === 'true',
    openExecutions: repository.countOpenExecutions(),
    unresolvedOrders: repository.countUnresolvedOrders(),
    activeTransferBatches: repository.countActiveTransferBatches(),
    signalAgeMs: Math.max(0, now - opportunity.sampledAt),
    maxSignalAgeMs: config.autoRotation.maxSignalAgeMs,
    expectedTransferCostUsd: estimate.totalCostUsd,
    maxCostUsd: config.transfers.maxCostUsd,
    minNetEdgeBps: config.transfers.minNetEdgeBps,
    conservativeNetProfit: opportunity.conservativeNetProfit,
    requestedNotional: opportunity.requestedNotional,
    expectedArrivalMs: estimate.expectedArrivalMs,
    maxArrivalMs: config.transfers.maxArrivalMs,
  });
  if (gate.action === 'WAIT' || gate.action === 'BLOCKED') {
    return {
      action: gate.action,
      reasons: [...gate.reasons, ...estimate.reasons],
    };
  }

  const pending = repository
    .listTransferBatches(20)
    .find(
      (batch) =>
        batch.status === TRANSFER_BATCH_STATUS.PLANNED ||
        batch.status === TRANSFER_BATCH_STATUS.READY,
    );
  if (pending) {
    return { action: 'WAIT', reasons: [`transfer_plan_pending:${pending.id}`] };
  }

  const targets = rotationRebalanceTargets({
    direction: unfunded.direction,
    base: unfunded.pair.base,
    quote: unfunded.pair.quote,
    balances: unfunded.balances.readinessBalances,
    requirement: unfunded.requirement,
    venues: unfunded.pair.venues,
    withdrawFees: estimate.withdrawFees,
  });
  if (targets.length === 0) return { action: 'NOOP', reasons: ['no_transfer_targets'] };
  const batch = planTransferBatch({
    repository,
    config: config.transfers,
    targets,
    assetPricesUsd,
    batchId: `ROT-${unfunded.pair.base}-${now}-${unfunded.direction.replace('->', '-')}`,
    now,
  });
  if (batch.status === TRANSFER_BATCH_STATUS.BLOCKED) {
    return { action: 'BLOCKED', reasons: [batch.safeModeReason ?? 'transfer_plan_blocked'] };
  }
  if (gate.action === 'PLAN_MANUAL') {
    return { action: 'PLANNED', batchId: batch.id, reasons: ['manual_release_plan_created'] };
  }
  const result = await executeTransferBatch({
    repository,
    config: config.transfers,
    venues: transferVenues,
    batchId: batch.id,
    liveEnabled: config.liveEnabled,
    killSwitch: repository.getSetting('kill_switch') !== 'false',
    confirmBatchId: batch.id,
    confirmationMode: 'automatic',
    operator: 'auto_supervisor',
    now: () => now,
  });
  if (result.status === TRANSFER_BATCH_STATUS.COMPLETED) {
    return { action: 'COMPLETED', batchId: batch.id, reasons: [] };
  }
  if (result.status === TRANSFER_BATCH_STATUS.SAFE_STOP) {
    return { action: 'SAFE_STOP', batchId: batch.id, reasons: result.reasons };
  }
  return { action: 'WAIT', reasons: [`transfer_${result.status}`, ...result.reasons] };
}

export async function runAutoRotationSupervisor(
  options: AutoRotationSupervisorOptions,
): Promise<void> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? sleepDefault;
  const { repository, config, adapters, engine } = options;
  const transferVenues = options.transferVenues;
  if (!config.autoRotation.enabled) throw new Error('auto_rotation.enabled is false');
  const markets = await loadMarkets(adapters, config);
  const instruments = config.autoRotation.pairs.map((pair) => `${pair.base}/${pair.quote}`);
  const executionVenueIds = [
    ...new Set(config.autoRotation.pairs.flatMap((pair) => [...pair.venues])),
  ];
  const balanceVenues = executionVenueIds.flatMap((venueId) => {
    const adapter = adapters[venueId];
    return adapter ? [{ adapter: adapter.adapter, credentials: adapter.credentials }] : [];
  });
  if (balanceVenues.length !== executionVenueIds.length) {
    const missing = executionVenueIds.filter((venueId) => !adapters[venueId]);
    throw new Error(`auto rotation requires trade credentials for: ${missing.join(', ')}`);
  }
  const statusCredentials = options.accountStatusCredentials ?? [];
  const statusTradeCredentials = statusCredentials.filter(
    (credential) => credential.role === 'trade',
  );
  const accountStatusVenues = Object.fromEntries(
    statusTradeCredentials.flatMap((credential) => {
      const bundle = adapters[credential.venueId];
      return bundle
        ? [[credential.venueId, { adapter: bundle.adapter, credentials: credential }]]
        : [];
    }),
  );
  let lastBalanceAt = 0;
  let lastAccountStatusAt = 0;
  let lastAccountStatusSuccessAt = 0;
  let accountStatusReport: AccountPermissionReport | undefined;
  let lastAttemptAt: number | undefined;
  let lastPreparationAt: number | undefined;
  let lastExecutionClosedAt = repository.latestClosedExecutionAt();
  let lastCarryLogAt = 0;
  let preparationKey: string | undefined;
  let preparationFirstSeenAt = 0;
  let consecutiveFailures = 0;
  let lastWaitLogAt = 0;
  let lastTransferReconcileAt = 0;
  let lastRebalanceLogAt = 0;
  let accountStateLogged = false;
  let heartbeatPhase = 'STARTING';
  let heartbeatWaitReasons: string[] | undefined;
  const failedOpportunityUntil = new Map<number, number>();
  repository.setSetting('auto_execution_enabled', 'true');
  repository.recordAudit('executor', 'auto_rotation_started', {
    pairs: instruments,
    maxSignalAgeMs: config.autoRotation.maxSignalAgeMs,
    cooldownMs: config.autoRotation.cooldownMs,
  });
  logEvent({ status: 'started', pairs: instruments });
  recordHeartbeat(repository, config, 'running');
  const heartbeatTimer = setInterval(() => {
    recordHeartbeat(repository, config, 'running', heartbeatWaitReasons, heartbeatPhase);
  }, 5000);
  heartbeatTimer.unref?.();

  while (!(options.shouldStop?.() ?? false)) {
    const now = clock();
    recordHeartbeat(repository, config, 'running', heartbeatWaitReasons, heartbeatPhase);
    if (repository.getSetting('kill_switch') !== 'false') {
      recordHeartbeat(repository, config, 'stopped', ['kill_switch_on']);
      logEvent({ status: 'stopped', reason: 'kill_switch_on' });
      break;
    }
    if (!config.liveEnabled || repository.getSetting('live_enabled') !== 'true') {
      recordHeartbeat(repository, config, 'stopped', ['live_disabled']);
      logEvent({ status: 'stopped', reason: 'live_disabled' });
      break;
    }
    if (repository.getSetting('auto_execution_enabled') !== 'true') {
      recordHeartbeat(repository, config, 'stopped', ['auto_execution_disabled']);
      logEvent({ status: 'stopped', reason: 'auto_execution_disabled' });
      break;
    }
    if (now - lastBalanceAt >= config.autoRotation.balanceRefreshMs) {
      heartbeatPhase = 'BALANCING';
      const refreshed = await refreshBalances(repository, balanceVenues, now);
      lastBalanceAt = now;
      if (refreshed.errors.length > 0) {
        logEvent({ status: 'balance_refresh_failed', errors: refreshed.errors });
        await sleep(config.autoRotation.pollIntervalMs);
        continue;
      }
      if (!accountStateLogged) {
        logAccountState(repository, config, markets, now);
        accountStateLogged = true;
      }
    }
    heartbeatPhase = 'CHECKING_ACCOUNT';
    if (
      config.accountStatus.enabled &&
      now - lastAccountStatusAt >= config.accountStatus.refreshMs
    ) {
      lastAccountStatusAt = now;
      accountStatusReport = await evaluateAccountPermissions({
        repository,
        credentials: statusCredentials,
        venues: accountStatusVenues,
        requiredPairs: instruments,
        config: config.accountStatus,
        now,
      });
      repository.recordAudit('executor', 'account_status_checked', accountStatusReport, now);
      logEvent({
        status: 'account_status',
        health: accountStatusReport.health,
        reasons: accountStatusReport.reasons,
      });
      if (accountStatusReport.health !== 'BLOCK') {
        lastAccountStatusSuccessAt = now;
      } else {
        const transient = accountStatusReport.reasons.every((reason) =>
          /account_status_query_failed/.test(reason),
        );
        const stale = now - lastAccountStatusSuccessAt > config.accountStatus.staleMs;
        if (!transient || stale) {
          const reason = transient ? 'account_status_stale' : 'account_status_blocked';
          repository.setSetting('kill_switch', 'true', now);
          repository.recordRiskEvent(
            'critical',
            reason,
            accountStatusReport.reasons.join(','),
            accountStatusReport,
            now,
          );
          recordHeartbeat(repository, config, 'stopped', [reason]);
          logEvent({ status: 'stopped', reason, health: accountStatusReport.health });
          break;
        }
        await sleep(config.autoRotation.pollIntervalMs);
        continue;
      }
    }
    if (
      config.accountStatus.enabled &&
      (lastAccountStatusSuccessAt === 0 ||
        now - lastAccountStatusSuccessAt > config.accountStatus.staleMs)
    ) {
      const reason = 'account_status_stale';
      repository.setSetting('kill_switch', 'true', now);
      repository.recordRiskEvent('critical', reason, 'account status snapshot is stale', {}, now);
      recordHeartbeat(repository, config, 'stopped', [reason]);
      logEvent({ status: 'stopped', reason });
      break;
    }
    const activeTransfers = repository.activeTransferBatches();
    if (activeTransfers.length > 0) {
      if (!transferVenues) {
        heartbeatWaitReasons = ['active_transfer_without_transfer_venues'];
        await sleep(config.autoRotation.pollIntervalMs);
        continue;
      }
      if (now - lastTransferReconcileAt >= config.transfers.pollIntervalMs) {
        lastTransferReconcileAt = now;
        for (const batch of activeTransfers) {
          const reconciled = await reconcileTransferBatch({
            repository,
            config: config.transfers,
            venues: transferVenues,
            batchId: batch.id,
            now,
          });
          logEvent({
            status: 'transfer_reconciled',
            batchId: batch.id,
            transferStatus: reconciled.status,
            reasons: reconciled.reasons,
          });
          if (reconciled.status === TRANSFER_BATCH_STATUS.SAFE_STOP) {
            repository.setSetting('kill_switch', 'true', now);
            recordHeartbeat(repository, config, 'stopped', ['transfer_safe_stop']);
            logEvent({ status: 'stopped', reason: 'transfer_safe_stop', batchId: batch.id });
            return;
          }
          if (reconciled.status === TRANSFER_BATCH_STATUS.COMPLETED) {
            lastBalanceAt = 0;
          }
        }
      }
      heartbeatWaitReasons = ['active_transfer'];
      await sleep(config.autoRotation.pollIntervalMs);
      continue;
    }

    for (const [opportunityId, until] of failedOpportunityUntil) {
      if (until <= now) failedOpportunityUntil.delete(opportunityId);
    }
    const candidates = repository
      .recentValidS1Opportunities({
        now,
        maxAgeMs: config.autoRotation.maxSignalAgeMs,
        instruments,
        maxCandidates: 200,
      })
      .filter((candidate) => (failedOpportunityUntil.get(candidate.id) ?? 0) <= now);
    candidates.sort((left, right) => {
      const byProfit = right.opportunity.netProfitBps.comparedTo(left.opportunity.netProfitBps);
      return byProfit !== 0 ? byProfit : right.opportunity.sampledAt - left.opportunity.sampledAt;
    });
    let executionSelection: ExecutionSelection | undefined;
    const normalSelection = actionableCandidate({
      repository,
      config,
      markets,
      adapters,
      candidates,
      now,
      ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    });
    if ('waitReasons' in normalSelection) {
      heartbeatPhase = 'WAIT';
      heartbeatWaitReasons = normalSelection.waitReasons;
      if (normalSelection.unfunded && config.transfers.enabled && transferVenues) {
        try {
          const attempt = await rebalanceUnfundedCandidate({
            repository,
            config,
            transferVenues,
            unfunded: normalSelection.unfunded,
            now,
          });
          if (attempt.action === 'PLANNED') {
            repository.recordAudit(
              'system',
              'rotation_rebalance_planned',
              { batchId: attempt.batchId, direction: normalSelection.unfunded.direction },
              now,
            );
            logEvent({
              status: 'rebalance_planned',
              batchId: attempt.batchId,
              direction: normalSelection.unfunded.direction,
              reasons: attempt.reasons,
            });
            await sleep(config.autoRotation.pollIntervalMs);
            continue;
          }
          if (attempt.action === 'COMPLETED') {
            logEvent({
              status: 'rebalance_completed',
              batchId: attempt.batchId,
              direction: normalSelection.unfunded.direction,
            });
            lastBalanceAt = 0;
            await sleep(config.autoRotation.pollIntervalMs);
            continue;
          }
          if (attempt.action === 'SAFE_STOP') {
            repository.setSetting('kill_switch', 'true', now);
            recordHeartbeat(repository, config, 'stopped', ['transfer_safe_stop']);
            logEvent({
              status: 'stopped',
              reason: 'transfer_safe_stop',
              batchId: attempt.batchId,
              details: attempt.reasons,
            });
            return;
          }
          if (now - lastRebalanceLogAt >= 15_000) {
            lastRebalanceLogAt = now;
            logEvent({
              status: 'rebalance_waiting',
              action: attempt.action,
              direction: normalSelection.unfunded.direction,
              reasons: attempt.reasons,
            });
          }
        } catch (error) {
          repository.recordRiskEvent(
            'warning',
            'rotation_rebalance_plan_failed',
            error instanceof Error ? error.message : String(error),
            { direction: normalSelection.unfunded.direction },
            now,
          );
          if (now - lastRebalanceLogAt >= 15_000) {
            lastRebalanceLogAt = now;
            logEvent({
              status: 'rebalance_waiting',
              action: 'BLOCKED',
              direction: normalSelection.unfunded.direction,
              reasons: [error instanceof Error ? error.message : String(error)],
            });
          }
        }
      }
      const prepCandidates = repository.recentS1Opportunities({
        now,
        maxAgeMs: config.autoRotation.maxSignalAgeMs,
        instruments,
        maxCandidates: 400,
      });
      const preparation = preparationCandidate({
        repository,
        config,
        markets,
        adapters,
        candidates: prepCandidates,
        now,
      });
      if ('candidate' in preparation) {
        const key = `${preparation.candidate.pair.base}|${preparation.candidate.direction}`;
        if (preparationKey !== key) {
          preparationKey = key;
          preparationFirstSeenAt = now;
        }
        if (now - preparationFirstSeenAt >= config.autoRotation.preparation.minStableMs) {
          executionSelection = {
            ...preparation.candidate,
            intent: 'inventory_preparation',
          };
          heartbeatPhase = 'PREPARING';
        } else if (now - lastWaitLogAt >= 15_000) {
          logEvent({
            status: 'preparation_waiting',
            pair: key,
            stableForMs: now - preparationFirstSeenAt,
            requiredMs: config.autoRotation.preparation.minStableMs,
          });
          lastWaitLogAt = now;
        }
      } else {
        preparationKey = undefined;
        if (now - lastWaitLogAt >= 15_000) {
          logEvent({
            status: 'waiting',
            reasons: normalSelection.waitReasons,
            preparation: preparation.waitReasons,
            candidates: candidates.length,
          });
          lastWaitLogAt = now;
        }
      }
      if (!executionSelection) {
        if (
          lastPreparationAt !== undefined &&
          (lastExecutionClosedAt === undefined || lastExecutionClosedAt <= lastPreparationAt) &&
          now - lastPreparationAt >= config.autoRotation.preparation.maxHoldMs &&
          now - lastCarryLogAt >= 60_000
        ) {
          logEvent({
            status: 'preparation_carrying',
            preparationAt: lastPreparationAt,
            carriedForMs: now - lastPreparationAt,
            maxHoldMs: config.autoRotation.preparation.maxHoldMs,
          });
          lastCarryLogAt = now;
        }
        await sleep(config.autoRotation.pollIntervalMs);
        continue;
      }
    } else {
      executionSelection = {
        loaded: normalSelection.loaded,
        buy: normalSelection.buy,
        sell: normalSelection.sell,
        batchId: s1BatchId(normalSelection.loaded),
        opportunity: normalSelection.loaded.opportunity,
        direction: normalSelection.decision.direction!,
        intent: 'arbitrage',
      };
    }

    const { loaded, buy, sell, batchId, opportunity, direction, intent, preparation } =
      executionSelection;
    if (repository.countActiveTransferBatches() > 0) {
      heartbeatWaitReasons = ['active_transfer'];
      await sleep(config.autoRotation.pollIntervalMs);
      continue;
    }
    if (
      typeof buy.adapter.fetchOpenOrders !== 'function' ||
      typeof sell.adapter.fetchOpenOrders !== 'function'
    ) {
      const reason = 'open_orders_query_unsupported';
      repository.recordRiskEvent(
        'critical',
        'auto_open_orders_unsupported',
        reason,
        { direction, buyVenue: buy.adapter.venueId, sellVenue: sell.adapter.venueId },
        now,
      );
      repository.setSetting('kill_switch', 'true', now);
      recordHeartbeat(repository, config, 'stopped', [reason]);
      logEvent({ status: 'stopped', reason, direction });
      break;
    }
    lastAttemptAt = now;
    if (intent === 'inventory_preparation') lastPreparationAt = now;
    heartbeatPhase = intent === 'inventory_preparation' ? 'PREPARING' : 'EXECUTING';
    repository.recordAudit(
      'executor',
      intent === 'inventory_preparation'
        ? 'inventory_preparation_attempt'
        : 'auto_rotation_attempt',
      {
        batchId,
        opportunityId: loaded.id,
        direction,
        netProfitBps: opportunity.netProfitBps.toFixed(),
        requestedNotional: opportunity.requestedNotional.toFixed(),
        ...(preparation
          ? {
              preparationMaxCostBps: preparation.maxCostBps.toFixed(),
              preparationMaxCostUsd: preparation.maxCostUsd.toFixed(),
            }
          : {}),
      },
      now,
    );
    logEvent({
      status: intent === 'inventory_preparation' ? 'preparing' : 'executing',
      batchId,
      opportunityId: loaded.id,
      direction,
      signalAgeMs: Math.max(0, now - opportunity.sampledAt),
      netProfitBps: opportunity.netProfitBps.toFixed(),
      requestedNotional: opportunity.requestedNotional.toFixed(),
      ...(preparation
        ? {
            preparationMaxCostBps: preparation.maxCostBps.toFixed(),
            preparationMaxCostUsd: preparation.maxCostUsd.toFixed(),
          }
        : {}),
    });
    try {
      const executionStartedAt = clock();
      const result = await engine.execute({
        batchId,
        opportunity,
        opportunityId: loaded.id,
        buy,
        sell,
        confirmedBatchId: batchId,
        confirmationMode: 'automatic',
        ...(intent === 'inventory_preparation'
          ? {
              intent,
              preparation,
            }
          : {}),
      });
      const resultAt = clock();
      if (result.outcome === 'CLOSED' || result.ordersSubmitted > 0) {
        lastBalanceAt = 0;
      }
      lastExecutionClosedAt = resultAt;
      preparationKey = undefined;
      repository.recordAudit(
        'executor',
        intent === 'inventory_preparation'
          ? 'inventory_preparation_result'
          : 'auto_rotation_result',
        {
          batchId,
          intent,
          direction,
          outcome: result.outcome,
          reasons: result.reasons,
          signalAgeMs: Math.max(0, now - opportunity.sampledAt),
          executionDurationMs: Math.max(0, resultAt - executionStartedAt),
          endToEndLatencyMs: Math.max(0, resultAt - opportunity.sampledAt),
          realizedProfit: result.realizedProfit?.toFixed() ?? null,
        },
        resultAt,
      );
      logEvent({
        status: 'result',
        batchId,
        intent,
        direction,
        outcome: result.outcome,
        reasons: result.reasons,
        signalAgeMs: Math.max(0, now - opportunity.sampledAt),
        executionDurationMs: Math.max(0, resultAt - executionStartedAt),
        endToEndLatencyMs: Math.max(0, resultAt - opportunity.sampledAt),
        realizedProfit: result.realizedProfit?.toFixed() ?? null,
      });
      if (result.outcome === 'CLOSED' || result.ordersSubmitted > 0) {
        failedOpportunityUntil.delete(loaded.id);
      } else {
        failedOpportunityUntil.set(loaded.id, clock() + 5000);
      }
      if (result.outcome === 'CLOSED') {
        consecutiveFailures = 0;
      } else if (result.outcome === 'SAFE_STOP') {
        logEvent({ status: 'stopped', reason: 'safe_stop', batchId });
        break;
      } else if (result.ordersSubmitted > 0) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= config.autoRotation.maxConsecutiveFailures) {
          repository.setSetting('kill_switch', 'true', clock());
          repository.recordRiskEvent(
            'critical',
            'auto_rotation_failure_limit',
            'consecutive execution failures',
            {
              consecutiveFailures,
              batchId,
            },
            clock(),
          );
          logEvent({ status: 'stopped', reason: 'failure_limit', batchId });
          break;
        }
      } else {
        consecutiveFailures = 0;
      }
    } catch (error) {
      consecutiveFailures += 1;
      repository.setSetting('kill_switch', 'true', clock());
      repository.recordRiskEvent(
        'critical',
        'auto_rotation_unexpected_error',
        String(error),
        {
          batchId,
          consecutiveFailures,
        },
        clock(),
      );
      recordHeartbeat(repository, config, 'stopped', ['unexpected_error']);
      logEvent({ status: 'stopped', reason: 'unexpected_error', error: String(error), batchId });
      break;
    }
    await sleep(config.autoRotation.cooldownMs);
  }
  clearInterval(heartbeatTimer);
  repository.setSetting('auto_execution_enabled', 'false', clock());
  repository.recordAudit('executor', 'auto_rotation_stopped', { at: clock() }, clock());
  recordHeartbeat(repository, config, 'stopped', ['ended']);
  logEvent({ status: 'ended' });
}
