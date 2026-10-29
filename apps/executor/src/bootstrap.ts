import {
  Decimal,
  assessStartupRecovery,
  type MarketMetadata,
  type StartupRecoveryDecision,
} from '@arb/core';
import type { ArbitrageRepository, RecoveredOrder } from '@arb/storage';
import type { ApiCredentials, CexAdapter, OrderQuery, OrderState } from '@arb/venues-cex';
import { fetchOpenOrdersForSymbols } from './open-orders.js';
import { evaluateAccountPermissions, type AccountPermissionReport } from './account-permissions.js';
import type { AccountStatusConfig } from './config.js';
import type { StoredCredential } from './secret-store.js';

export interface RecoveryVenue {
  adapter: CexAdapter;
  credentials: ApiCredentials;
  applyBackoff?: (retryAfterMs: number) => void;
}

export interface StartupRecoveryOptions {
  repository: ArbitrageRepository;
  venues: Readonly<Record<string, RecoveryVenue>>;
  confirmBalances?: boolean;
  pairs?: readonly { base: string; quote: string }[];
  accountStatus?: {
    config: AccountStatusConfig;
    credentials: readonly StoredCredential[];
  };
  now?: () => number;
}

export interface StartupRecoveryResult {
  decision: StartupRecoveryDecision;
  queriedOrders: number;
  resolvedOrders: number;
  failedQueries: number;
  openExecutions: number;
  unresolvedOrders: number;
  openOrdersQueried: number;
  openOrdersFound: number;
  openOrderQueryFailures: number;
  backoffs: number;
  balancesConfirmed: boolean;
  accountStatus?: AccountPermissionReport;
}

interface RecoveryCandidate {
  clientOrderId: string;
  venueId: string;
  symbol: string;
  venueOrderId?: string;
  executionId: number | null;
  order?: RecoveredOrder;
  leg?: {
    requestedAmount: string;
    requestedPrice: string;
  };
}

function finalState(order: OrderState): boolean {
  return order.status === 'closed' || order.status === 'canceled' || order.status === 'rejected';
}

function legStatus(order: OrderState): string {
  if (order.status === 'closed') {
    return order.filled.gt(0) && order.filled.lt(order.amount) ? 'partial' : 'filled';
  }
  if (order.status === 'canceled') return order.filled.gt(0) ? 'partial' : 'canceled';
  if (order.status === 'rejected') return 'rejected';
  if (order.status === 'open') return order.filled.gt(0) ? 'partial' : 'submitted';
  return 'unknown';
}

function openOrderSymbols(
  markets: readonly MarketMetadata[],
  venueId: string,
  pairs: readonly { base: string; quote: string }[],
): { symbols: string[]; missing: string[] } {
  const symbols = new Set<string>();
  const missing: string[] = [];
  for (const pair of pairs) {
    const matches = markets.filter(
      (market) =>
        market.active &&
        market.venueId === venueId &&
        market.base.trim().toUpperCase() === pair.base.trim().toUpperCase() &&
        market.quote.trim().toUpperCase() === pair.quote.trim().toUpperCase(),
    );
    if (matches.length === 1) symbols.add(matches[0]!.exchangeSymbol);
    else missing.push(`${pair.base.toUpperCase()}/${pair.quote.toUpperCase()}`);
  }
  return { symbols: [...symbols], missing };
}

function decimal(value: string | undefined, fallback = '0'): Decimal {
  try {
    return new Decimal(value ?? fallback);
  } catch {
    return new Decimal(fallback);
  }
}

function candidates(repository: ArbitrageRepository): Map<string, RecoveryCandidate> {
  const result = new Map<string, RecoveryCandidate>();
  const add = (candidate: RecoveryCandidate): void => {
    if (!result.has(candidate.clientOrderId)) result.set(candidate.clientOrderId, candidate);
  };

  for (const order of repository.listUnresolvedOrders()) {
    add({
      clientOrderId: order.clientOrderId,
      venueId: order.venueId,
      symbol: order.symbol,
      ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
      executionId: order.executionId,
      order,
    });
  }
  for (const execution of repository.listOpenExecutions()) {
    for (const leg of execution.legs) {
      if (!leg.clientOrderId || !['submitted', 'unknown'].includes(leg.status)) continue;
      const existing = repository.getOrder(leg.clientOrderId);
      const venueOrderId = leg.orderId ?? existing?.venueOrderId ?? undefined;
      add({
        clientOrderId: leg.clientOrderId,
        venueId: leg.venueId,
        symbol: existing?.symbol ?? '',
        ...(venueOrderId ? { venueOrderId } : {}),
        executionId: execution.id,
        ...(existing ? { order: existing } : {}),
        leg: {
          requestedAmount: leg.requestedAmount,
          requestedPrice: leg.requestedPrice,
        },
      });
    }
  }
  return result;
}

export async function recoverExecutorStartup(
  options: StartupRecoveryOptions,
): Promise<StartupRecoveryResult> {
  const { repository } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const pending = candidates(repository);
  let queriedOrders = 0;
  let resolvedOrders = 0;
  let failedQueries = 0;
  let openOrdersQueried = 0;
  let openOrdersFound = 0;
  let openOrderQueryFailures = 0;
  let accountStatus: AccountPermissionReport | undefined;

  for (const candidate of pending.values()) {
    const venue = options.venues[candidate.venueId];
    if (!venue || typeof venue.adapter.fetchOrder !== 'function') {
      failedQueries += 1;
      repository.recordRiskEvent(
        'critical',
        'startup_recovery_adapter_missing',
        `no order-query adapter for ${candidate.venueId}`,
        { clientOrderId: candidate.clientOrderId, venueId: candidate.venueId },
        now(),
      );
      continue;
    }
    const symbol = candidate.symbol || candidate.order?.symbol || '';
    const query: OrderQuery = {
      clientOrderId: candidate.clientOrderId,
      ...(symbol ? { symbol } : {}),
      ...(candidate.venueOrderId ? { venueOrderId: candidate.venueOrderId } : {}),
    };
    queriedOrders += 1;
    try {
      const order = await venue.adapter.fetchOrder(query, venue.credentials);
      const at = now();
      const price = decimal(candidate.order?.price ?? candidate.leg?.requestedPrice);
      const amount = decimal(candidate.order?.amount ?? candidate.leg?.requestedAmount);
      repository.recordOrder({
        venueId: candidate.venueId,
        venueOrderId: order.venueOrderId,
        clientOrderId: candidate.clientOrderId,
        executionId: candidate.executionId ?? undefined,
        symbol: order.symbol || symbol,
        side: order.side,
        type: order.type,
        price: order.price ?? price,
        amount: order.amount.gt(0) ? order.amount : amount,
        filledAmount: order.filled,
        ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
        ...(order.fee ? { fee: order.fee } : {}),
        status: order.status,
        now: at,
      });
      repository.recordOrderEvent(
        candidate.clientOrderId,
        'startup_recovery_query',
        {
          at,
          status: order.status,
          filled: order.filled.toFixed(),
          remaining: order.remaining.toFixed(),
          raw: order.raw,
        },
        at,
      );
      repository.updateExecutionLeg(candidate.clientOrderId, {
        status: legStatus(order),
        filledAmount: order.filled,
        ...(order.averagePrice ? { averageFillPrice: order.averagePrice } : {}),
        ...(order.fee ? { feePaid: order.fee } : {}),
        orderId: order.venueOrderId,
      });
      if (finalState(order)) resolvedOrders += 1;
    } catch (error) {
      failedQueries += 1;
      try {
        repository.recordOrderEvent(
          candidate.clientOrderId,
          'startup_recovery_query_error',
          { query, error: String(error) },
          now(),
        );
      } catch {
        // The order row can itself be missing; the risk event below remains the audit record.
      }
      repository.recordRiskEvent(
        'critical',
        'startup_recovery_query_failed',
        String(error),
        { clientOrderId: candidate.clientOrderId, venueId: candidate.venueId, query },
        now(),
      );
    }
  }

  let backoffs = 0;
  for (const backoff of repository.activeVenueBackoffs(now())) {
    options.venues[backoff.venueId]?.applyBackoff?.(Math.max(0, backoff.backoffUntil - now()));
    backoffs += 1;
  }

  let balancesConfirmed = false;
  if (options.confirmBalances ?? true) {
    balancesConfirmed = true;
    const venueIds = new Set([
      ...Object.keys(options.venues),
      ...repository
        .listOpenExecutions()
        .flatMap((execution) => execution.legs.map((leg) => leg.venueId)),
    ]);
    for (const venueId of venueIds) {
      const venue = options.venues[venueId];
      if (!venue || typeof venue.adapter.fetchBalances !== 'function') {
        balancesConfirmed = false;
        repository.recordRiskEvent(
          'critical',
          'startup_balance_unavailable',
          `balance confirmation unavailable for ${venueId}`,
          { venueId },
          now(),
        );
        continue;
      }
      try {
        const balances = await venue.adapter.fetchBalances(venue.credentials);
        for (const balance of balances) {
          repository.recordBalance(balance);
          repository.recordInventorySnapshot({
            venueId: balance.venueId,
            accountId: balance.accountId,
            asset: balance.currency,
            free: balance.free,
            used: balance.used,
            total: balance.total,
            capturedAt: balance.fetchedAt,
          });
        }
      } catch (error) {
        balancesConfirmed = false;
        repository.recordRiskEvent(
          'critical',
          'startup_balance_confirmation_failed',
          String(error),
          { venueId },
          now(),
        );
      }
    }
  }

  if (options.pairs && options.pairs.length > 0) {
    for (const [venueId, venue] of Object.entries(options.venues)) {
      let markets: MarketMetadata[];
      try {
        markets = await venue.adapter.loadMarkets();
      } catch (error) {
        openOrderQueryFailures += 1;
        repository.recordRiskEvent(
          'critical',
          'startup_open_orders_market_load_failed',
          String(error),
          { venueId },
          now(),
        );
        continue;
      }
      const { symbols, missing } = openOrderSymbols(markets, venueId, options.pairs);
      if (symbols.length === 0) continue;
      if (missing.length > 0) {
        openOrderQueryFailures += 1;
        repository.recordRiskEvent(
          'critical',
          'startup_open_orders_symbol_missing',
          missing.join(','),
          { venueId, missing },
          now(),
        );
      }
      if (typeof venue.adapter.fetchOpenOrders !== 'function') {
        openOrderQueryFailures += 1;
        repository.recordRiskEvent(
          'critical',
          'startup_open_orders_unsupported',
          `open-order query is unavailable for ${venueId}`,
          { venueId },
          now(),
        );
        continue;
      }
      for (const symbol of symbols) {
        openOrdersQueried += 1;
        const result = await fetchOpenOrdersForSymbols(venue.adapter, venue.credentials, [symbol]);
        openOrdersFound += result.orders.length;
        if (result.errors.length > 0) {
          openOrderQueryFailures += result.errors.length;
          repository.recordRiskEvent(
            'critical',
            'startup_open_orders_query_failed',
            result.errors.join('; '),
            { venueId, symbol },
            now(),
          );
        }
      }
    }
    if (openOrdersFound > 0) {
      repository.recordRiskEvent(
        'critical',
        'startup_open_orders_found',
        `found ${openOrdersFound} open order(s) during startup reconciliation`,
        { openOrdersFound },
        now(),
      );
    }
  }

  if (options.accountStatus?.config.enabled) {
    const tradeCredentials = options.accountStatus.credentials.filter(
      (credential) => credential.role === 'trade',
    );
    const byVenue = new Map(tradeCredentials.map((credential) => [credential.venueId, credential]));
    const statusVenues: Record<string, { adapter: CexAdapter; credentials: StoredCredential }> = {};
    for (const [venueId, venue] of Object.entries(options.venues)) {
      const credential = byVenue.get(venueId);
      if (credential) statusVenues[venueId] = { adapter: venue.adapter, credentials: credential };
    }
    accountStatus = await evaluateAccountPermissions({
      repository,
      credentials: options.accountStatus.credentials,
      venues: statusVenues,
      requiredPairs: (options.pairs ?? []).map(
        (pair) => `${pair.base.trim().toUpperCase()}/${pair.quote.trim().toUpperCase()}`,
      ),
      config: options.accountStatus.config,
      now: now(),
    });
  }

  const openExecutions = repository.countOpenExecutions();
  const unresolvedOrders = repository.countUnresolvedOrders();
  const persistedKillSwitch = repository.getSetting('kill_switch') !== 'false';
  const recoveryDecision = assessStartupRecovery({
    openExecutions,
    unresolvedLegs: unresolvedOrders,
    persistedKillSwitch,
    balancesConfirmed,
    openOrders: openOrdersFound,
    openOrderQueryFailures,
  });
  const decision =
    accountStatus?.health === 'BLOCK'
      ? {
          blockExecution: true,
          killSwitch: true,
          reasons: [
            ...recoveryDecision.reasons,
            'account_status_blocked',
            ...accountStatus.reasons,
          ],
        }
      : recoveryDecision;
  if (decision.killSwitch) {
    repository.setSetting('kill_switch', 'true', now());
  }
  repository.recordAudit(
    'executor',
    'startup_recovery',
    {
      startedAt,
      finishedAt: now(),
      queriedOrders,
      resolvedOrders,
      failedQueries,
      openExecutions,
      unresolvedOrders,
      openOrdersQueried,
      openOrdersFound,
      openOrderQueryFailures,
      backoffs,
      balancesConfirmed,
      accountStatus,
      decision,
    },
    now(),
  );
  if (decision.blockExecution) {
    repository.recordRiskEvent(
      'critical',
      'startup_recovery_blocked',
      decision.reasons.join(','),
      decision,
      now(),
    );
  }
  return {
    decision,
    queriedOrders,
    resolvedOrders,
    failedQueries,
    openExecutions,
    unresolvedOrders,
    openOrdersQueried,
    openOrdersFound,
    openOrderQueryFailures,
    backoffs,
    balancesConfirmed,
    ...(accountStatus ? { accountStatus } : {}),
  };
}
