import type { ArbitrageRepository } from '@arb/storage';
import type { ApiCredentials, CexAdapter } from '@arb/venues-cex';

export interface BalanceVenue {
  adapter: CexAdapter;
  credentials: ApiCredentials;
}

export interface BalanceRefreshResult {
  refreshed: number;
  errors: string[];
}

export async function refreshBalances(
  repository: ArbitrageRepository,
  venues: readonly BalanceVenue[],
  now = Date.now(),
): Promise<BalanceRefreshResult> {
  const results = await Promise.all(
    venues.map(async (venue): Promise<BalanceRefreshResult> => {
      if (!venue.adapter.fetchBalances) {
        return {
          refreshed: 0,
          errors: [`${venue.adapter.venueId}: fetchBalances not supported`],
        };
      }
      try {
        const balances = await venue.adapter.fetchBalances(venue.credentials);
        repository.ensureVenue({
          id: venue.adapter.venueId,
          type: 'cex',
          name: venue.adapter.venueId,
          tier: venue.adapter.tier,
          now,
        });
        for (const balance of balances) {
          const fetchedAt = balance.fetchedAt > 0 ? balance.fetchedAt : now;
          repository.recordBalance({ ...balance, fetchedAt });
          repository.recordInventorySnapshot({
            venueId: balance.venueId,
            accountId: balance.accountId,
            asset: balance.currency,
            free: balance.free,
            used: balance.used,
            total: balance.total,
            capturedAt: fetchedAt,
          });
        }
        return { refreshed: balances.length, errors: [] };
      } catch (error) {
        const message = `${venue.adapter.venueId}: ${error instanceof Error ? error.message : String(error)}`;
        repository.recordRiskEvent(
          'warning',
          'balance_refresh_failed',
          message,
          { venueId: venue.adapter.venueId },
          now,
        );
        return { refreshed: 0, errors: [message] };
      }
    }),
  );
  return {
    refreshed: results.reduce((sum, result) => sum + result.refreshed, 0),
    errors: results.flatMap((result) => result.errors),
  };
}
