import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('scanner configuration', () => {
  it('loads the checked-in safe defaults with the live gate closed', () => {
    const config = loadConfig('config/default.toml');
    expect(config.execution.liveEnabled).toBe(false);
    expect(config.execution.killSwitch).toBe(true);
    expect(config.scanner.baseAssets).toContain('CAKE');
    expect(config.scanner.assetUniverseMode).toBe('top_volume');
    expect(config.scanner.maxBaseAssets).toBe(100);
    expect(config.scanner.quoteCurrencies).toEqual(['USDT', 'USDC']);
    expect(config.scanner.fetchConcurrency).toBe(16);
    expect(config.scanner.requestedNotional.toFixed()).toBe('30');
    expect(config.bsc.enabled).toBe(false);
  });

  it('loads the long-tail volume band', () => {
    const config = loadConfig('config/longtail.toml');
    expect(config.scanner.min24hQuoteVolumeUsd.toFixed()).toBe('1000');
    expect(config.scanner.max24hQuoteVolumeUsd?.toFixed()).toBe('500000');
    expect(config.execution.liveEnabled).toBe(false);
    expect(config.execution.killSwitch).toBe(true);
  });

  it('can run the scanner while the separate executor live flag is enabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-config-live-'));
    const path = join(directory, 'live.toml');
    try {
      writeFileSync(
        path,
        readFileSync('config/default.toml', 'utf8').replace(
          'live_enabled = false',
          'live_enabled = true',
        ),
      );
      const config = loadConfig(path);
      expect(config.execution.liveEnabled).toBe(true);
      expect(config.execution.manualConfirmation).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects non-finite decimal configuration values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-config-'));
    const path = join(directory, 'invalid.toml');
    try {
      writeFileSync(
        path,
        `
[scanner]
max_order_notional = 'NaN'

[execution]
live_enabled = false
kill_switch = true

[database]
path = ':memory:'

[api]
host = '127.0.0.1'
port = 8787
`,
      );
      expect(() => loadConfig(path)).toThrow(/must be finite/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses per-venue fee overrides', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-config-fees-'));
    const path = join(directory, 'fees.toml');
    try {
      writeFileSync(
        path,
        `
[scanner]
max_order_notional = '30'

[execution]
live_enabled = false
kill_switch = true

[database]
path = ':memory:'

[api]
host = '127.0.0.1'
port = 8787

[fees.gateio]
taker_bps = 2
maker_bps = -1
rebate_pct = 70
`,
      );
      const config = loadConfig(path);
      expect(config.fees.gateio?.takerBps?.toFixed()).toBe('2');
      expect(config.fees.gateio?.makerBps?.toFixed()).toBe('-1');
      expect(config.fees.gateio?.rebatePct?.toFixed()).toBe('70');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses four monitored venues with an explicit monitor-only subset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-config-monitor-only-'));
    const path = join(directory, 'monitor-only.toml');
    try {
      writeFileSync(
        path,
        `
[scanner]
enabled_venues = ['gateio', 'hotcoin', 'weex', 'bitget']
monitor_only_venues = ['weex', 'bitget']

[execution]
live_enabled = false
kill_switch = true

[database]
path = ':memory:'

[api]
host = '127.0.0.1'
port = 8787

[fees.weex]
taker_bps = 10
maker_bps = 10

[fees.bitget]
taker_bps = 10
maker_bps = 10
`,
      );
      const config = loadConfig(path);
      expect(config.scanner.enabledVenues).toEqual(['gateio', 'hotcoin', 'weex', 'bitget']);
      expect(config.scanner.monitorOnlyVenues).toEqual(['weex', 'bitget']);
      expect(config.fees.weex?.takerBps?.toFixed()).toBe('10');
      expect(config.fees.bitget?.takerBps?.toFixed()).toBe('10');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects monitor-only venues that are not enabled', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-config-monitor-only-invalid-'));
    const path = join(directory, 'monitor-only.toml');
    try {
      writeFileSync(
        path,
        `
[scanner]
enabled_venues = ['gateio', 'hotcoin']
monitor_only_venues = ['weex']

[execution]
live_enabled = false
kill_switch = true

[database]
path = ':memory:'

[api]
host = '127.0.0.1'
port = 8787
`,
      );
      expect(() => loadConfig(path)).toThrow(
        'monitor_only_venues must be a subset of enabled_venues: weex',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an out-of-range fee rebate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-config-rebate-'));
    const path = join(directory, 'fees.toml');
    try {
      writeFileSync(
        path,
        `
[scanner]
max_order_notional = '30'

[execution]
live_enabled = false
kill_switch = true

[database]
path = ':memory:'

[api]
host = '127.0.0.1'
port = 8787

[fees.hotcoin]
taker_bps = 20
rebate_pct = 101
`,
      );
      expect(() => loadConfig(path)).toThrow('rebate_pct must be between 0 and 100');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
