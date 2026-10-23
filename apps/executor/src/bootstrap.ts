import { Decimal, assessStartupRecovery, type StartupRecoveryDecision } from '@arb/core';
import type { ArbitrageRepository, RecoveredOrder } from '@arb/storage';
import type { ApiCredentials, CexAdapter, OrderQuery, OrderState } from '@arb/venues-cex';

export interface RecoveryVenue {
  adapter: CexAdapter;
  credentials: ApiCredentials;
  applyBackoff?: (retryAfterMs: number) => void;
}

export interface StartupRecoveryOptions {
  repository: ArbitrageRepository;
  venues: Readonly<Record<string, RecoveryVenue>>;
  confirmBalances?: boolean;
  now?: () => number;
}

export interface StartupRecoveryResult {
  decision: StartupRecoveryDecision;
  queriedOrders: number;
  resolvedOrders: number;
  failedQueries: number;
  openExecutions: number;
  unresolvedOrders: number;
  backoffs: number;
  balancesConfirmed: boolean;
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

  const openExecutions = repository.countOpenExecutions();
  const unresolvedOrders = repository.countUnresolvedOrders();
  const persistedKillSwitch = repository.getSetting('kill_switch') !== 'false';
  const decision = assessStartupRecovery({
    openExecutions,
    unresolvedLegs: unresolvedOrders,
    persistedKillSwitch,
    balancesConfirmed,
  });
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
      backoffs,
      balancesConfirmed,
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
    backoffs,
    balancesConfirmed,
  };
}
