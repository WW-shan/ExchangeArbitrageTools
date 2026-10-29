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
  evaluatePreparationGate,
  rotationPairConfig,
  rotationRequirementFromOpportunity,
  scannerDirectionForRotation,
} from './auto-rotation.js';
import { refreshBalances } from './balance-service.js';
import type { RecoveryVenue } from './bootstrap.js';
import type { ExecutorConfig, RotationPairConfig } from './config.js';
import { CexLiveExecutor, type ExecutionVenue } from './coordinator.js';
import { s1BatchId } from './handoff.js';
import { executionVenue, healthStates, splitInstrument } from './runtime.js';

export interface AutoRotationSupervisorOptions {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  engine: CexLiveExecutor;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
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
  const gateMarket = markets.gateio?.find(
    (market) =>
      market.active &&
      market.base.toUpperCase() === pair.base &&
      market.quote.toUpperCase() === pair.quote,
  );
  const hotMarket = markets.hotcoin?.find(
    (market) =>
      market.active &&
      market.base.toUpperCase() === pair.base &&
      market.quote.toUpperCase() === pair.quote,
  );
  if (!gateMarket) reasons.push('gate_market_missing');
  if (!hotMarket) reasons.push('hotcoin_market_missing');
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
  if (!venueFresh('gateio')) reasons.push('gate_balance_snapshot_stale');
  if (!venueFresh('hotcoin')) reasons.push('hotcoin_balance_snapshot_stale');
  const free = (venueId: string, currency: string): Decimal =>
    rows.find(
      (balance) =>
        balance.venueId === venueId &&
        balance.currency.trim().toUpperCase() === currency.trim().toUpperCase(),
    )?.free ?? new Decimal(0);
  return {
    readinessBalances: {
      gateBase: canonicalAmountFromExchange(
        free('gateio', gateCurrencies.base),
        marketBaseMultiplier(gateMarket),
      ),
      gateQuote: free('gateio', gateCurrencies.quote),
      hotcoinBase: canonicalAmountFromExchange(
        free('hotcoin', hotCurrencies.base),
        marketBaseMultiplier(hotMarket),
      ),
      hotcoinQuote: free('hotcoin', hotCurrencies.quote),
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
    return {
      pair: `${pair.base}/${pair.quote}`,
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

async function loadMarkets(
  adapters: Readonly<Record<string, RecoveryVenue>>,
  config: ExecutorConfig,
): Promise<Record<string, MarketMetadata[]>> {
  const feeOverrides = mergeAccountFeeFile(config.feeOverrides, config.feeFile);
  const result: Record<string, MarketMetadata[]> = {};
  for (const venueId of ['gateio', 'hotcoin']) {
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
  | { waitReasons: string[] } {
  const { repository, config, markets, adapters, candidates, now, lastAttemptAt } = input;
  const states = healthStates(repository);
  let lastWait: string[] = ['no_valid_opportunity'];
  for (const loaded of candidates) {
    const opportunity = loaded.opportunity;
    const pair = rotationPairConfig(config.autoRotation.pairs, opportunity.instrumentKey);
    const instrument = splitInstrument(opportunity.instrumentKey);
    if (!pair || !instrument) {
      lastWait = ['pair_not_whitelisted'];
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
    lastWait = [...decision.reasons];
  }
  return { waitReasons: lastWait };
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
      const scannerDirection = scannerDirectionForRotation(direction);
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
      const venueBuy = direction === 'gate->hotcoin' ? 'gateio' : 'hotcoin';
      const venueSell = direction === 'gate->hotcoin' ? 'hotcoin' : 'gateio';
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
          batchId: `PREP-${pair.base}-${now}-${direction.replace('->', '-')}`,
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

export async function runAutoRotationSupervisor(
  options: AutoRotationSupervisorOptions,
): Promise<void> {
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? sleepDefault;
  const { repository, config, adapters, engine } = options;
  if (!config.autoRotation.enabled) throw new Error('auto_rotation.enabled is false');
  const markets = await loadMarkets(adapters, config);
  const instruments = config.autoRotation.pairs.map((pair) => `${pair.base}/${pair.quote}`);
  const balanceVenues = ['gateio', 'hotcoin'].flatMap((venueId) => {
    const adapter = adapters[venueId];
    return adapter ? [{ adapter: adapter.adapter, credentials: adapter.credentials }] : [];
  });
  if (balanceVenues.length !== 2)
    throw new Error('auto rotation requires both gateio and hotcoin trade credentials');
  let lastBalanceAt = 0;
  let lastAttemptAt: number | undefined;
  let lastPreparationAt: number | undefined;
  let lastExecutionClosedAt = repository.latestClosedExecutionAt();
  let lastCarryLogAt = 0;
  let preparationKey: string | undefined;
  let preparationFirstSeenAt = 0;
  let consecutiveFailures = 0;
  let lastWaitLogAt = 0;
  let accountStateLogged = false;
  repository.setSetting('auto_execution_enabled', 'true');
  repository.recordAudit('executor', 'auto_rotation_started', {
    pairs: instruments,
    maxSignalAgeMs: config.autoRotation.maxSignalAgeMs,
    cooldownMs: config.autoRotation.cooldownMs,
  });
  logEvent({ status: 'started', pairs: instruments });

  while (!(options.shouldStop?.() ?? false)) {
    const now = clock();
    if (repository.getSetting('kill_switch') !== 'false') {
      logEvent({ status: 'stopped', reason: 'kill_switch_on' });
      break;
    }
    if (!config.liveEnabled || repository.getSetting('live_enabled') !== 'true') {
      logEvent({ status: 'stopped', reason: 'live_disabled' });
      break;
    }
    if (repository.getSetting('auto_execution_enabled') !== 'true') {
      logEvent({ status: 'stopped', reason: 'auto_execution_disabled' });
      break;
    }
    if (now - lastBalanceAt >= config.autoRotation.balanceRefreshMs) {
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
    const candidates = repository.recentValidS1Opportunities({
      now,
      maxAgeMs: config.autoRotation.maxSignalAgeMs,
      instruments,
      maxCandidates: 200,
    });
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
      logEvent({ status: 'stopped', reason, direction });
      break;
    }
    lastAttemptAt = now;
    if (intent === 'inventory_preparation') lastPreparationAt = now;
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
      lastBalanceAt = 0;
      lastExecutionClosedAt = clock();
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
          realizedProfit: result.realizedProfit?.toFixed() ?? null,
        },
        clock(),
      );
      logEvent({
        status: 'result',
        batchId,
        intent,
        direction,
        outcome: result.outcome,
        reasons: result.reasons,
        realizedProfit: result.realizedProfit?.toFixed() ?? null,
      });
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
      logEvent({ status: 'stopped', reason: 'unexpected_error', error: String(error), batchId });
      break;
    }
    await sleep(config.autoRotation.cooldownMs);
  }
  repository.setSetting('auto_execution_enabled', 'false', clock());
  repository.recordAudit('executor', 'auto_rotation_stopped', { at: clock() }, clock());
  logEvent({ status: 'ended' });
}
