import { Decimal } from '@arb/core';

export type ReadinessLevel = 'pass' | 'warn' | 'block';

export interface ReadinessCheck {
  id: string;
  level: ReadinessLevel;
  detail: string;
}

export interface ReadinessSummary {
  liveTestReady: boolean;
  blocked: string[];
  warnings: string[];
}

/**
 * Minimum bps a trade must clear purely to satisfy the absolute-profit floor at
 * the executor's real order notional. A high value silently hides small edges.
 */
export function impliedProfitFloorBps(minProfitUsd: Decimal, maxNotional: Decimal): Decimal {
  if (!maxNotional.isFinite() || maxNotional.lte(0)) return new Decimal(0);
  return minProfitUsd.div(maxNotional).mul(10_000);
}

/** Enabled venues without any explicit taker fee (venue-level or per-symbol). */
export function missingFeeOverrideVenues(
  enabled: readonly string[],
  fees: Record<
    string,
    | {
        takerBps?: Decimal;
        symbols?: Record<string, { takerBps?: Decimal; makerBps?: Decimal }>;
      }
    | undefined
  >,
): string[] {
  return enabled.filter((venue) => {
    const fee = fees[venue];
    if (fee?.takerBps !== undefined) return false;
    return !Object.values(fee?.symbols ?? {}).some((symbol) => symbol.takerBps !== undefined);
  });
}

export function summarizeReadiness(checks: readonly ReadinessCheck[]): ReadinessSummary {
  const blocked = checks.filter((check) => check.level === 'block').map((check) => check.id);
  const warnings = checks.filter((check) => check.level === 'warn').map((check) => check.id);
  return { liveTestReady: blocked.length === 0, blocked, warnings };
}
