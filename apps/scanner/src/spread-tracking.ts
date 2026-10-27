import { Decimal } from '@arb/core';

export interface SpreadSample {
  direction: string;
  timestamp: number;
  grossBps?: Decimal;
  netBps: Decimal;
  maxFeeBreakEvenNotional?: Decimal;
  maxEligibleNotional?: Decimal;
  bindingReason: string;
  flags: string[];
}

export interface SpreadDirectionSummary {
  direction: string;
  samples: number;
  positiveGrossSamples: number;
  feeBreakEvenSamples: number;
  eligibleSamples: number;
  eligibleRatio: number;
  maxGrossBps?: Decimal;
  minGrossBps?: Decimal;
  p50GrossBps?: Decimal;
  p95GrossBps?: Decimal;
  maxEligibleNotional?: Decimal;
  longestPositiveStreakMs: number;
  longestFeeBreakEvenStreakMs: number;
  longestEligibleStreakMs: number;
  totalEligibleDurationMs: number;
  firstEligibleAt?: number;
  lastEligibleAt?: number;
  firstNonEligibleAfterFirstEligibleAt?: number;
  timeToFirstLossAfterEligibleMs?: number;
}

function percentile(values: readonly Decimal[], fraction: number): Decimal | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left.comparedTo(right));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function streakStats(
  samples: ReadonlyArray<{ timestamp: number; ok: boolean }>,
  intervalMs: number,
): { longestMs: number; totalMs: number } {
  const sorted = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  let longestMs = 0;
  let totalMs = 0;
  let start: number | undefined;
  let last: number | undefined;
  const close = (): void => {
    if (start === undefined || last === undefined) return;
    const duration = Math.max(0, last - start + intervalMs);
    longestMs = Math.max(longestMs, duration);
    totalMs += duration;
    start = undefined;
    last = undefined;
  };
  for (const sample of sorted) {
    if (!sample.ok) {
      close();
      continue;
    }
    if (start === undefined) start = sample.timestamp;
    last = sample.timestamp;
  }
  close();
  return { longestMs, totalMs };
}

function summarizeDirection(
  direction: string,
  samples: readonly SpreadSample[],
  intervalMs: number,
): SpreadDirectionSummary {
  const sorted = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const gross = sorted.flatMap((sample) => (sample.grossBps ? [sample.grossBps] : []));
  const eligible = sorted.filter((sample) => sample.maxEligibleNotional !== undefined);
  const feeBreakEven = sorted.filter((sample) => sample.maxFeeBreakEvenNotional !== undefined);
  const positive = gross.filter((value) => value.gt(0));
  const eligibleStreak = streakStats(
    sorted.map((sample) => ({
      timestamp: sample.timestamp,
      ok: sample.maxEligibleNotional !== undefined,
    })),
    intervalMs,
  );
  const positiveStreak = streakStats(
    sorted.map((sample) => ({
      timestamp: sample.timestamp,
      ok: sample.grossBps?.gt(0) ?? false,
    })),
    intervalMs,
  );
  const feeStreak = streakStats(
    sorted.map((sample) => ({
      timestamp: sample.timestamp,
      ok: sample.maxFeeBreakEvenNotional !== undefined,
    })),
    intervalMs,
  );
  const firstEligible = eligible[0];
  const lastEligible = eligible[eligible.length - 1];
  const firstNonEligibleAfterEligible = firstEligible
    ? sorted.find(
        (sample) =>
          sample.timestamp > firstEligible.timestamp && sample.maxEligibleNotional === undefined,
      )
    : undefined;
  const maxEligibleNotional = eligible.reduce<Decimal | undefined>((best, sample) => {
    const value = sample.maxEligibleNotional;
    if (!value) return best;
    return !best || value.gt(best) ? value : best;
  }, undefined);
  const p50GrossBps = percentile(gross, 0.5);
  const p95GrossBps = percentile(gross, 0.95);
  return {
    direction,
    samples: sorted.length,
    positiveGrossSamples: positive.length,
    feeBreakEvenSamples: feeBreakEven.length,
    eligibleSamples: eligible.length,
    eligibleRatio: sorted.length > 0 ? eligible.length / sorted.length : 0,
    ...(gross.length > 0
      ? {
          maxGrossBps: gross.reduce((max, value) => (value.gt(max) ? value : max)),
          minGrossBps: gross.reduce((min, value) => (value.lt(min) ? value : min)),
          ...(p50GrossBps ? { p50GrossBps } : {}),
          ...(p95GrossBps ? { p95GrossBps } : {}),
        }
      : {}),
    ...(maxEligibleNotional ? { maxEligibleNotional } : {}),
    longestPositiveStreakMs: positiveStreak.longestMs,
    longestFeeBreakEvenStreakMs: feeStreak.longestMs,
    longestEligibleStreakMs: eligibleStreak.longestMs,
    totalEligibleDurationMs: eligibleStreak.totalMs,
    ...(firstEligible ? { firstEligibleAt: firstEligible.timestamp } : {}),
    ...(lastEligible ? { lastEligibleAt: lastEligible.timestamp } : {}),
    ...(firstNonEligibleAfterEligible
      ? { firstNonEligibleAfterFirstEligibleAt: firstNonEligibleAfterEligible.timestamp }
      : {}),
    ...(firstEligible && firstNonEligibleAfterEligible
      ? {
          timeToFirstLossAfterEligibleMs:
            firstNonEligibleAfterEligible.timestamp - firstEligible.timestamp,
        }
      : {}),
  };
}

export function summarizeSpreadSamples(
  samples: readonly SpreadSample[],
  intervalMs: number,
): SpreadDirectionSummary[] {
  const groups = new Map<string, SpreadSample[]>();
  for (const sample of samples) {
    const rows = groups.get(sample.direction) ?? [];
    rows.push(sample);
    groups.set(sample.direction, rows);
  }
  return [...groups.entries()]
    .map(([direction, rows]) => summarizeDirection(direction, rows, intervalMs))
    .sort((left, right) => {
      if (right.eligibleSamples !== left.eligibleSamples) {
        return right.eligibleSamples - left.eligibleSamples;
      }
      return (right.maxGrossBps ?? new Decimal(0)).comparedTo(left.maxGrossBps ?? new Decimal(0));
    });
}
