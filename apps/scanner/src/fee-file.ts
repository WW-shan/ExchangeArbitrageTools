import { existsSync, readFileSync } from 'node:fs';
import { Decimal } from '@arb/core';
import type { FeeOverride } from './config.js';

export interface AccountFeeFileEntry {
  takerBps?: string | number;
  makerBps?: string | number;
}

function decimalOrUndefined(value: string | number | undefined): Decimal | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge per-symbol fees produced by `npm run fees:fetch` into the config fee
 * overrides. Account fees take precedence over static `[fees.<venue>]` values
 * for the same symbol, and are marked `source=account` so the scanner can set
 * the market's fee provenance.
 */
export function mergeAccountFeeFile(
  base: Record<string, FeeOverride>,
  path: string | undefined,
): Record<string, FeeOverride> {
  if (!path || !existsSync(path)) return base;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    Record<string, AccountFeeFileEntry>
  >;
  const merged: Record<string, FeeOverride> = { ...base };
  for (const [venueId, symbols] of Object.entries(raw)) {
    if (!symbols || typeof symbols !== 'object' || Array.isArray(symbols)) continue;
    const existing = merged[venueId] ?? {};
    const symbolOverrides: Record<string, { takerBps?: Decimal; makerBps?: Decimal }> = {
      ...(existing.symbols ?? {}),
    };
    for (const [symbol, fee] of Object.entries(symbols)) {
      const taker = decimalOrUndefined(fee?.takerBps);
      const maker = decimalOrUndefined(fee?.makerBps);
      if (taker === undefined && maker === undefined) continue;
      symbolOverrides[symbol] = {
        ...(taker !== undefined ? { takerBps: taker } : {}),
        ...(maker !== undefined ? { makerBps: maker } : {}),
      };
    }
    merged[venueId] = {
      ...existing,
      ...(Object.keys(symbolOverrides).length > 0 ? { symbols: symbolOverrides } : {}),
      source: 'account',
    };
  }
  return merged;
}
