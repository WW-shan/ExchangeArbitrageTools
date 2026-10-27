import type { VenueTier } from '@arb/core';
import { createCcxtAdapter } from './ccxt-adapter.js';
import type { VenueMarketType } from './catalog.js';
import { HotcoinAdapter } from './hotcoin.js';
import type { AdapterRuntime, ApiCredentials, CexAdapter } from './types.js';

export interface CexAdapterFactoryOptions {
  credentials?: ApiCredentials;
  readOnly?: boolean;
  sandbox?: boolean;
  proxyUrl?: string;
  supportsIoc?: boolean;
  supportsFok?: boolean;
  tier?: VenueTier;
  marketType?: VenueMarketType;
}

/**
 * Construct the correct spot adapter for a venue. Hotcoin is intentionally
 * routed through its dedicated implementation because CCXT has no Hotcoin
 * exchange class; every other venue uses the shared CCXT adapter.
 */
export function createCexAdapter(
  venueId: string,
  runtime: AdapterRuntime,
  options: CexAdapterFactoryOptions = {},
): CexAdapter {
  if (venueId === 'hotcoin') {
    if (options.sandbox) throw new Error('Hotcoin does not expose a sandbox endpoint');
    return new HotcoinAdapter({
      runtime,
      ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
      ...(options.proxyUrl !== undefined ? { proxyUrl: options.proxyUrl } : {}),
      ...(options.supportsIoc !== undefined ? { supportsIoc: options.supportsIoc } : {}),
      ...(options.supportsFok !== undefined ? { supportsFok: options.supportsFok } : {}),
      ...(options.tier !== undefined ? { tier: options.tier } : {}),
    });
  }
  return createCcxtAdapter(venueId, runtime, options);
}
