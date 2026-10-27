import { existsSync, readFileSync } from 'node:fs';
import { Decimal, type MarketMetadata } from '@arb/core';

export interface SymbolFeeOverride {
  takerBps?: Decimal;
  makerBps?: Decimal;
}

export interface VenueFeeOverride extends SymbolFeeOverride {
  source?: 'config' | 'account' | 'ccxt' | 'default';
  symbols?: Record<string, SymbolFeeOverride>;
}

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
 * Merge per-symbol fees produced by `npm run fees:fetch` into configured venue
 * overrides. Account fees take precedence over static `[fees.<venue>]` values
 * for the same symbol and are marked `source=account`.
 */
export function mergeAccountFeeFile(
  base: Record<string, VenueFeeOverride>,
  path: string | undefined,
): Record<string, VenueFeeOverride> {
  if (!path || !existsSync(path)) return base;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    Record<string, AccountFeeFileEntry>
  >;
  const merged: Record<string, VenueFeeOverride> = { ...base };
  for (const [venueId, symbols] of Object.entries(raw)) {
    if (!symbols || typeof symbols !== 'object' || Array.isArray(symbols)) continue;
    const existing = merged[venueId] ?? {};
    const symbolOverrides: Record<string, SymbolFeeOverride> = {
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

export function applyFeeOverride(
  market: MarketMetadata,
  overrides: Readonly<Record<string, VenueFeeOverride>>,
): MarketMetadata {
  const override = overrides[market.venueId];
  if (!override) return market;
  const symbolOverride =
    override.symbols?.[market.exchangeSymbol] ?? override.symbols?.[market.unifiedSymbol];
  const taker = symbolOverride?.takerBps ?? override.takerBps;
  const maker = symbolOverride?.makerBps ?? override.makerBps;
  if (taker === undefined && maker === undefined) return market;
  return {
    ...market,
    ...(taker !== undefined ? { feeTakerBps: taker } : {}),
    ...(maker !== undefined ? { makerFeeBps: maker } : {}),
    feeProvenance: override.source ?? 'config',
  };
}
