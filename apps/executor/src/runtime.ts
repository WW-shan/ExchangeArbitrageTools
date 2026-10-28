import type { Decimal, HealthState, MarketMetadata } from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';
import { CEX_TIERS, createCexAdapter, createPublicRuntime } from '@arb/venues-cex';
import type { ExecutorConfig } from './config.js';
import type { ExecutionVenue } from './coordinator.js';
import type { RecoveryVenue } from './bootstrap.js';
import type { StoredCredential } from './secret-store.js';

export function splitInstrument(key: string): { base: string; quote: string } | undefined {
  const parts = key.split('/');
  if (parts.length !== 2) return undefined;
  const base = parts[0]?.trim().toUpperCase() ?? '';
  const quote = parts[1]?.trim().toUpperCase() ?? '';
  return base && quote ? { base, quote } : undefined;
}

export function healthStates(repository: ArbitrageRepository): Map<string, HealthState> {
  const states = new Map<string, HealthState>();
  for (const row of repository.latestHealth()) {
    const state = row.health_state;
    if (state === 'A' || state === 'B' || state === 'C' || state === 'D') {
      states.set(String(row.venue_id), state);
    }
  }
  return states;
}

export function findMarket(
  markets: MarketMetadata[],
  venueId: string,
  base: string,
  quote: string,
  exchangeSymbol?: string,
): MarketMetadata | undefined {
  const matches = markets.filter(
    (market) =>
      market.active &&
      market.venueId === venueId &&
      market.base.trim().toUpperCase() === base &&
      market.quote.trim().toUpperCase() === quote,
  );
  if (exchangeSymbol) {
    const exact = matches.filter((market) => market.exchangeSymbol === exchangeSymbol);
    return exact.length === 1 ? exact[0] : undefined;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function runtimeFor(
  repository: ArbitrageRepository,
  venueId: string,
): ReturnType<typeof createPublicRuntime> {
  const ensureVenue = (): void => {
    repository.upsertVenue({
      id: venueId,
      type: 'cex',
      name: venueId,
      tier: CEX_TIERS[venueId] ?? 'B',
    });
  };
  return createPublicRuntime(1, undefined, {
    onBackoff: (state) => {
      ensureVenue();
      repository.upsertVenueBackoff({
        venueId,
        backoffUntil: state.backoffUntil,
        reason: state.reason,
        consecutiveFailures: state.consecutiveFailures,
        updatedAt: Date.now(),
      });
      repository.recordRiskEvent('warning', 'venue_backoff', state.reason, {
        venueId,
        backoffUntil: state.backoffUntil,
        retryAfterMs: state.retryAfterMs,
        consecutiveFailures: state.consecutiveFailures,
      });
    },
    onRecover: () => repository.clearVenueBackoff(venueId),
  });
}

export function adapterMap(
  repository: ArbitrageRepository,
  config: ExecutorConfig,
  credentials: ReadonlyMap<string, StoredCredential>,
): Record<string, RecoveryVenue> {
  const venues: Record<string, RecoveryVenue> = {};
  for (const credential of credentials.values()) {
    if (credential.role !== 'trade') continue;
    const venueId = credential.venueId;
    if (!CEX_TIERS[venueId]) {
      repository.recordRiskEvent(
        'warning',
        'executor_venue_unsupported',
        'credential exists for a venue without a supported CCXT execution adapter',
        { venueId },
      );
      continue;
    }
    const runtime = runtimeFor(repository, venueId);
    const adapter = createCexAdapter(venueId, runtime, {
      credentials: credential,
      readOnly: false,
      supportsIoc: config.iocVenues.includes(venueId),
      supportsFok: config.fokVenues.includes(venueId),
    });
    venues[venueId] = {
      adapter,
      credentials: credential,
      applyBackoff: (retryAfterMs) => runtime.rateLimiter.respectRetryAfter(retryAfterMs),
    };
  }
  return venues;
}

export function executionVenue(
  venueId: string,
  markets: MarketMetadata[],
  instrument: { base: string; quote: string },
  adapters: Record<string, RecoveryVenue>,
  states: Map<string, HealthState>,
  feeRebates: Readonly<Record<string, { rebatePct?: Decimal } | undefined>>,
  exchangeSymbol?: string,
): ExecutionVenue {
  const bundle = adapters[venueId];
  if (!bundle) throw new Error(`no trade credential/adapter for ${venueId}`);
  const market = findMarket(markets, venueId, instrument.base, instrument.quote, exchangeSymbol);
  if (!market) {
    throw new Error(
      `no single active market for ${venueId} ${instrument.base}/${instrument.quote}`,
    );
  }
  return {
    adapter: bundle.adapter,
    market,
    credentials: bundle.credentials,
    healthState: states.get(venueId) ?? 'D',
    ...(feeRebates[venueId]?.rebatePct !== undefined
      ? { feeRebatePct: feeRebates[venueId]!.rebatePct! }
      : {}),
  };
}
