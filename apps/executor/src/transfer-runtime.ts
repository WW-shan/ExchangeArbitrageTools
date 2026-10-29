import { CEX_TIERS, createCexAdapter, createPublicRuntime, type CexAdapter } from '@arb/venues-cex';
import type { StoredCredential } from './secret-store.js';
import type { TransferVenue, TransferVenues } from './transfer-service.js';

export interface LoadedTransferVenues {
  venues: TransferVenues;
  adapters: CexAdapter[];
}

export function transferVenuesFromCredentials(
  records: Iterable<StoredCredential>,
): LoadedTransferVenues {
  const byVenue = new Map<string, Partial<Record<StoredCredential['role'], StoredCredential>>>();
  for (const record of records) {
    const roles = byVenue.get(record.venueId) ?? {};
    roles[record.role] = record;
    byVenue.set(record.venueId, roles);
  }
  const venues: Record<string, TransferVenue> = {};
  const adapters: CexAdapter[] = [];
  for (const [venueId, roles] of byVenue) {
    if (!CEX_TIERS[venueId]) continue;
    const readCredential = roles.read_only ?? roles.trade;
    const withdrawalCredential = roles.withdrawal;
    const runtime = createPublicRuntime(1);
    const readAdapter = readCredential
      ? createCexAdapter(venueId, runtime, {
          credentials: readCredential,
          readOnly: true,
        })
      : undefined;
    if (readAdapter) adapters.push(readAdapter);
    const withdrawalAdapter = withdrawalCredential
      ? createCexAdapter(venueId, runtime, {
          credentials: withdrawalCredential,
          readOnly: false,
        })
      : undefined;
    if (withdrawalAdapter) adapters.push(withdrawalAdapter);
    venues[venueId] = {
      ...(readAdapter && readCredential
        ? { read: { adapter: readAdapter, credentials: readCredential } }
        : {}),
      ...(withdrawalAdapter && withdrawalCredential
        ? { withdrawal: { adapter: withdrawalAdapter, credentials: withdrawalCredential } }
        : {}),
    };
  }
  return { venues, adapters };
}
