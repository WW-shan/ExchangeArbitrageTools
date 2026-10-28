import {
  Decimal,
  assessRotationReadiness,
  canonicalAmountFromExchange,
  marketBaseMultiplier,
  marketExchangeBase,
  type MarketMetadata,
  type RotationBalances,
} from '@arb/core';
import type { ArbitrageRepository, LoadedOpportunity } from '@arb/storage';
import { applyFeeOverride, mergeAccountFeeFile } from '@arb/venues-cex';
import {
  decideAutoRotation,
  rotationPairConfig,
  rotationRequirementFromOpportunity,
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
  let consecutiveFailures = 0;
  let lastWaitLogAt = 0;
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
    const selection = actionableCandidate({
      repository,
      config,
      markets,
      adapters,
      candidates,
      now,
      ...(lastAttemptAt !== undefined ? { lastAttemptAt } : {}),
    });
    if ('waitReasons' in selection) {
      if (now - lastWaitLogAt >= 15_000) {
        logEvent({
          status: 'waiting',
          reasons: selection.waitReasons,
          candidates: candidates.length,
        });
        lastWaitLogAt = now;
      }
      await sleep(config.autoRotation.pollIntervalMs);
      continue;
    }

    const { loaded, buy, sell, decision } = selection;
    const batchId = s1BatchId(loaded);
    lastAttemptAt = now;
    repository.recordAudit(
      'executor',
      'auto_rotation_attempt',
      {
        batchId,
        opportunityId: loaded.id,
        direction: decision.direction,
        netProfitBps: loaded.opportunity.netProfitBps.toFixed(),
        requestedNotional: loaded.opportunity.requestedNotional.toFixed(),
      },
      now,
    );
    logEvent({
      status: 'executing',
      batchId,
      opportunityId: loaded.id,
      direction: decision.direction,
      netProfitBps: loaded.opportunity.netProfitBps.toFixed(),
    });
    try {
      const result = await engine.execute({
        batchId,
        opportunity: loaded.opportunity,
        opportunityId: loaded.id,
        buy,
        sell,
        confirmedBatchId: batchId,
        confirmationMode: 'automatic',
      });
      lastBalanceAt = 0;
      repository.recordAudit(
        'executor',
        'auto_rotation_result',
        {
          batchId,
          outcome: result.outcome,
          reasons: result.reasons,
          realizedProfit: result.realizedProfit?.toFixed() ?? null,
        },
        clock(),
      );
      logEvent({
        status: 'result',
        batchId,
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
