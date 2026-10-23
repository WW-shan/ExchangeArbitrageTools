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
  let refreshed = 0;
  const errors: string[] = [];
  for (const venue of venues) {
    if (!venue.adapter.fetchBalances) {
      errors.push(`${venue.adapter.venueId}: fetchBalances not supported`);
      continue;
    }
    try {
      const balances = await venue.adapter.fetchBalances(venue.credentials);
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
        refreshed += 1;
      }
    } catch (error) {
      const message = `${venue.adapter.venueId}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      repository.recordRiskEvent(
        'warning',
        'balance_refresh_failed',
        message,
        { venueId: venue.adapter.venueId },
        now,
      );
    }
  }
  return { refreshed, errors };
}
