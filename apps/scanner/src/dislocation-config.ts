import { readFileSync } from 'node:fs';
import { Decimal } from '@arb/core';
import { parse } from 'smol-toml';

export interface DislocationConfig {
  venues: string[];
  quoteCurrency: string;
  proxyUrl?: string;
  maxBases: number;
  minLegQuoteVolumeUsd: Decimal;
  maxLegQuoteVolumeUsd: Decimal;
  detection: {
    minDislocationBps: Decimal;
    minVenueDeviationBps: Decimal;
    maxCounterDeviationBps: Decimal;
    baselineWindowMs: number;
    baselineCapacity: number;
    minBaselineSamples: number;
    maxQuoteAgeMs: number;
  };
  liveness: {
    maxRepeatCount: number;
    staleMs: number;
    /** Quote volume that must accumulate before a market counts as live. */
    minQuoteVolumeDelta: Decimal;
    /**
     * Fraction of the venue's own 24h turnover rate that must be observed.
     * This is what keeps thin-but-live books eligible; an absolute floor
     * alone permanently excludes them.
     */
    minTurnoverFraction: Decimal;
    /** How long to observe before the volume verdict is trusted. */
    activityWarmupMs: number;
  };
  sampling: {
    tickerIntervalMs: number;
    deepCheckMultiplier: Decimal;
    maxDeepChecks: number;
    orderbookDepth: number;
    minExecutableNotionalUsd: Decimal;
  };
  output: {
    dir: string;
    summaryEveryRounds: number;
  };
}

type Table = Record<string, unknown>;

function table(value: unknown, name: string): Table {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`config section [${name}] is missing or not a table`);
  }
  return value as Table;
}

function stringValue(source: Table, key: string, fallback?: string): string {
  const value = source[key];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`config key ${key} is required`);
  }
  if (typeof value !== 'string') throw new Error(`config key ${key} must be a string`);
  return value;
}

function optionalString(source: Table, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`config key ${key} must be a string`);
  return value;
}

function numberValue(source: Table, key: string, fallback: number): number {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`config key ${key} must be a finite number`);
  }
  return value;
}

function decimalValue(source: Table, key: string, fallback?: string): Decimal {
  const raw = source[key] ?? fallback;
  if (raw === undefined) throw new Error(`config key ${key} is required`);
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error(`config key ${key} must be a string or number`);
  }
  const value = new Decimal(raw as Decimal.Value);
  if (!value.isFinite()) throw new Error(`config key ${key} must be finite`);
  return value;
}

function stringArray(source: Table, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.some((row) => typeof row !== 'string')) {
    throw new Error(`config key ${key} must be an array of strings`);
  }
  return value.map((row) => (row as string).trim()).filter(Boolean);
}

export function loadDislocationConfig(path: string): DislocationConfig {
  const document = parse(readFileSync(path, 'utf8')) as Table;
  const scanner = table(document.scanner, 'scanner');
  const detection = table(document.detection, 'detection');
  const liveness = table(document.liveness, 'liveness');
  const sampling = table(document.sampling, 'sampling');
  const output = table(document.output, 'output');

  const venues = stringArray(scanner, 'venues');
  if (venues.length < 2) throw new Error('at least two venues are required');

  const config: DislocationConfig = {
    venues,
    quoteCurrency: stringValue(scanner, 'quote_currency', 'USDT').toUpperCase(),
    maxBases: Math.max(1, numberValue(scanner, 'max_bases', 400)),
    minLegQuoteVolumeUsd: decimalValue(scanner, 'min_leg_quote_volume_usd', '0'),
    maxLegQuoteVolumeUsd: decimalValue(scanner, 'max_leg_quote_volume_usd', '100000000'),
    detection: {
      minDislocationBps: decimalValue(detection, 'min_dislocation_bps', '500'),
      minVenueDeviationBps: decimalValue(detection, 'min_venue_deviation_bps', '300'),
      maxCounterDeviationBps: decimalValue(detection, 'max_counter_deviation_bps', '150'),
      baselineWindowMs: Math.max(1000, numberValue(detection, 'baseline_window_ms', 300_000)),
      baselineCapacity: Math.max(5, numberValue(detection, 'baseline_capacity', 61)),
      minBaselineSamples: Math.max(3, numberValue(detection, 'min_baseline_samples', 5)),
      maxQuoteAgeMs: Math.max(1000, numberValue(detection, 'max_quote_age_ms', 30_000)),
    },
    liveness: {
      maxRepeatCount: Math.max(0, numberValue(liveness, 'max_repeat_count', 8)),
      staleMs: Math.max(1000, numberValue(liveness, 'stale_ms', 300_000)),
      minQuoteVolumeDelta: decimalValue(liveness, 'min_quote_volume_delta_usd', '0'),
      minTurnoverFraction: decimalValue(liveness, 'min_turnover_fraction', '0.3'),
      activityWarmupMs: Math.max(0, numberValue(liveness, 'activity_warmup_ms', 60_000)),
    },
    sampling: {
      tickerIntervalMs: Math.max(500, numberValue(sampling, 'ticker_interval_ms', 5000)),
      deepCheckMultiplier: decimalValue(sampling, 'deep_check_multiplier', '3'),
      maxDeepChecks: Math.max(0, numberValue(sampling, 'max_deep_checks', 12)),
      orderbookDepth: Math.max(1, numberValue(sampling, 'orderbook_depth', 20)),
      minExecutableNotionalUsd: decimalValue(sampling, 'min_executable_notional_usd', '3'),
    },
    output: {
      dir: stringValue(output, 'dir', 'data/dislocation'),
      summaryEveryRounds: Math.max(1, numberValue(output, 'summary_every_rounds', 12)),
    },
  };
  const proxyUrl = optionalString(scanner, 'proxy_url') ?? process.env.ARB_PROXY_URL;
  if (proxyUrl) config.proxyUrl = proxyUrl;
  return config;
}

