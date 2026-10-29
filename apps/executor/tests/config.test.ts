import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadExecutorConfig } from '../src/config.js';

const directories: string[] = [];

function configWith(replacement: [string, string]): string {
  const directory = mkdtempSync(join(tmpdir(), 'arb-executor-config-'));
  directories.push(directory);
  const source = readFileSync(resolve('config/default.toml'), 'utf8');
  const path = join(directory, 'config.toml');
  writeFileSync(path, source.replace(replacement[0], replacement[1]));
  return path;
}

function configWithAppendix(appendix: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'arb-executor-config-'));
  directories.push(directory);
  const source = readFileSync(resolve('config/default.toml'), 'utf8');
  const path = join(directory, 'config.toml');
  writeFileSync(path, `${source}\n${appendix}\n`);
  return path;
}

function configWithLiveTransfers(appendix: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'arb-executor-config-'));
  directories.push(directory);
  const source = readFileSync(resolve('config/default.toml'), 'utf8')
    .replace('[transfers]\nenabled = false', '[transfers]\nenabled = true')
    .replace('live_enabled = false', 'live_enabled = true')
    .replace('kill_switch = true', 'kill_switch = false');
  const path = join(directory, 'config.toml');
  writeFileSync(path, `${source}\n${appendix}\n`);
  return path;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('executor configuration', () => {
  it('keeps the live locks and MVP limits closed by default', () => {
    const config = loadExecutorConfig(resolve('config/default.toml'), {});
    expect(config.liveEnabled).toBe(false);
    expect(config.killSwitch).toBe(true);
    expect(config.manualConfirmation).toBe(true);
    expect(config.maxOpenBatches).toBe(1);
    expect(config.riskLimits.maxOrderNotional.toFixed()).toBe('30');
    expect(config.riskLimits.dailyMaxLoss.toFixed()).toBe('20');
    expect(config.handoffMaxAgeMs).toBe(15_000);
    expect(config.executionRequestsPerSecond).toBe(5);
    expect(config.legMode).toBe('serial');
    expect(config.iocVenues).toEqual([]);
    expect(config.transfers.enabled).toBe(false);
    expect(config.transfers.requireManualConfirmation).toBe(true);
    expect(config.transfers.maxInFlightBatches).toBe(1);
    expect(config.transfers.maxLegsPerBatch).toBe(2);
    expect(config.transfers.releaseMode).toBe('manual');
    expect(config.transfers.minNetEdgeBps.toFixed()).toBe('5');
    expect(config.transfers.maxCostUsd.toFixed()).toBe('0.5');
    expect(config.accountStatus.enabled).toBe(false);
    expect(config.autoRotation.residualHedge.enabled).toBe(false);
    expect(config.autoRotation.residualHedge.maxLossUsd.toFixed()).toBe('0');
    expect(config.autoRotation.residualHedge.maxBaselineAgeMs).toBe(60_000);
    expect(config.transfers.allowlist).toEqual([]);
  });

  it('allows an explicitly configured live flag but still requires manual confirmation and one batch', () => {
    const path = configWith(['live_enabled = false', 'live_enabled = true']);
    const config = loadExecutorConfig(path, { ARB_SECRET_STORE_PATH: 'custom/secrets.json' });
    expect(config.liveEnabled).toBe(true);
    expect(config.secretStorePath).toBe('custom/secrets.json');
    expect(config.manualConfirmation).toBe(true);
    expect(config.maxOpenBatches).toBe(1);
  });

  it('rejects unsafe or ambiguous execution limits', () => {
    expect(() =>
      loadExecutorConfig(configWith(['max_open_batches = 1', 'max_open_batches = 2']), {}),
    ).toThrow('max_open_batches');
    expect(() =>
      loadExecutorConfig(
        configWith(['manual_confirmation = true', 'manual_confirmation = false']),
        {},
      ),
    ).toThrow('manual_confirmation');
    expect(() =>
      loadExecutorConfig(
        configWith(['max_order_notional = "30"', 'max_order_notional = "31"']),
        {},
      ),
    ).toThrow('30 USDT');
    expect(() =>
      loadExecutorConfig(
        configWith(['daily_max_loss_usd = "20"', 'daily_max_loss_usd = "21"']),
        {},
      ),
    ).toThrow('20 USDT');
    expect(() =>
      loadExecutorConfig(configWith([`leg_mode = 'serial'`, `leg_mode = 'parallel'`]), {}),
    ).toThrow('serial or parallel_fok');
    expect(() =>
      loadExecutorConfig(configWith(['max_open_batches = 1', 'requests_per_second = 0']), {}),
    ).toThrow('requests_per_second');
  });

  it('accepts an explicitly selected parallel FOK mode', () => {
    const path = configWith([`leg_mode = 'serial'`, `leg_mode = 'parallel_fok'`]);
    expect(loadExecutorConfig(path, {}).legMode).toBe('parallel_fok');
  });

  it('parses a whitelisted automatic rotation profile without disabling manual confirmation', () => {
    const config = loadExecutorConfig(
      configWithAppendix(`
[auto_rotation]
enabled = true
poll_interval_ms = 1000
balance_refresh_ms = 5000
max_signal_age_ms = 5000
cooldown_ms = 3000
max_consecutive_failures = 3

[auto_rotation.preparation]
enabled = true
max_notional = '10'
min_stable_ms = 30000
calibration_file = 'apps/executor/tests/fixtures/prep-calibration.json'
min_reverse_probability = '0.5'
min_expected_value_bps = '0'
max_hold_ms = 3600000

[[auto_rotation.pairs]]
base = 'KAT'
quote = 'USDT'
max_notional = '20'
`),
      {},
    );
    expect(config.autoRotation.enabled).toBe(true);
    expect(config.autoRotation.pairs).toHaveLength(1);
    expect(config.autoRotation.pairs[0]!.base).toBe('KAT');
    expect(config.autoRotation.pairs[0]!.maxNotional.toFixed()).toBe('20');
    expect(config.autoRotation.pairs[0]!.venues).toEqual(['gateio', 'hotcoin']);
    expect(config.autoRotation.preparation.enabled).toBe(true);
    expect(
      config.autoRotation.preparation.calibration[
        'KAT/USDT|gate->hotcoin|5'
      ]?.reverseProbability.toFixed(),
    ).toBe('0.6');
    expect(config.manualConfirmation).toBe(true);
  });

  it('rejects an automatic profile without a whitelist or with a stale signal window', () => {
    expect(() =>
      loadExecutorConfig(
        configWithAppendix(`
[auto_rotation]
enabled = true
max_signal_age_ms = 5000
`),
        {},
      ),
    ).toThrow('whitelist');
    expect(() =>
      loadExecutorConfig(
        configWithAppendix(`
[auto_rotation]
enabled = true
max_signal_age_ms = 31000

[[auto_rotation.pairs]]
base = 'KAT'
quote = 'USDT'
max_notional = '20'
`),
        {},
      ),
    ).toThrow('30000');
  });

  it('parses a bounded automatic residual hedge', () => {
    const appendix = `
[auto_rotation]
enabled = true
max_signal_age_ms = 5000
[auto_rotation.residual_hedge]
enabled = true
max_loss_usd = '0.05'
max_baseline_age_ms = 60000
[[auto_rotation.pairs]]
base = 'KAT'
quote = 'USDT'
max_notional = '20'
`;
    const config = loadExecutorConfig(configWithAppendix(appendix), {});
    expect(config.autoRotation.residualHedge.enabled).toBe(true);
    expect(config.autoRotation.residualHedge.maxLossUsd.toFixed()).toBe('0.05');
    expect(config.autoRotation.residualHedge.maxBaselineAgeMs).toBe(60_000);
  });

  it('rejects an automatic residual hedge outside the loss and baseline bounds', () => {
    const section = (loss: string, baseline: number): string => `
[auto_rotation]
enabled = true
max_signal_age_ms = 5000
[auto_rotation.residual_hedge]
enabled = true
max_loss_usd = '${loss}'
max_baseline_age_ms = ${baseline}
[[auto_rotation.pairs]]
base = 'KAT'
quote = 'USDT'
max_notional = '20'
`;
    expect(() => loadExecutorConfig(configWithAppendix(section('21', 60000)), {})).toThrow(
      'max_loss_usd',
    );
    expect(() => loadExecutorConfig(configWithAppendix(section('0.05', 500)), {})).toThrow(
      'max_baseline_age_ms',
    );
  });

  it('fails closed when reversion preparation is enabled without calibration', () => {
    expect(() =>
      loadExecutorConfig(
        configWithAppendix(`
[auto_rotation]
enabled = true
max_signal_age_ms = 5000

[auto_rotation.preparation]
enabled = true

[[auto_rotation.pairs]]
base = 'KAT'
quote = 'USDT'
max_notional = '20'
`),
        {},
      ),
    ).toThrow('calibration_file');
  });

  it('parses gross venue fees with a rebate percentage', () => {
    const path = configWithAppendix(`
[fees.hotcoin]
taker_bps = 20
maker_bps = 20
rebate_pct = 80
`);
    const fee = loadExecutorConfig(path, {}).feeOverrides.hotcoin;
    expect(fee?.takerBps?.toFixed()).toBe('20');
    expect(fee?.makerBps?.toFixed()).toBe('20');
    expect(fee?.rebatePct?.toFixed()).toBe('80');
  });

  it('parses explicit transfer allowlist limits without enabling transfers', () => {
    const path = configWithAppendix(`
[[transfers.allowlist]]
from_venue = 'gateio'
to_venue = 'hotcoin'
asset = 'inc'
network = 'BEP20'
address = '0xAbC0000000000000000000000000000000000001'
address_tag = ''
venue_currency = 'INC(BSC)'
min_amount = '15'
max_amount = '200'
daily_max_amount = '400'
withdraw_fee = '1'
`);
    const config = loadExecutorConfig(path, {});
    expect(config.transfers.enabled).toBe(false);
    expect(config.transfers.allowlist[0]).toMatchObject({
      fromVenue: 'gateio',
      toVenue: 'hotcoin',
      asset: 'INC',
      network: 'BEP20',
      address: '0xAbC0000000000000000000000000000000000001',
      venueCurrency: 'INC(BSC)',
    });
    expect(config.transfers.allowlist[0]?.maxAmount.toFixed()).toBe('200');
  });

  it('rejects duplicate or unsafe transfer settings', () => {
    const duplicate = configWithAppendix(`
[[transfers.allowlist]]
from_venue = 'gateio'
to_venue = 'hotcoin'
asset = 'INC'
network = 'BSC'
address = '0x1'
min_amount = '1'
max_amount = '10'
daily_max_amount = '20'
[[transfers.allowlist]]
from_venue = 'gateio'
to_venue = 'hotcoin'
asset = 'INC'
network = 'BEP20'
address = '0x2'
min_amount = '1'
max_amount = '10'
daily_max_amount = '20'
`);
    expect(() => loadExecutorConfig(duplicate, {})).toThrow('duplicate transfer allowlist');
    expect(() =>
      loadExecutorConfig(
        configWith(['[transfers]\nenabled = false', '[transfers]\nenabled = true']),
        {},
      ),
    ).toThrow('live_enabled');
    expect(() =>
      loadExecutorConfig(configWith(['max_legs_per_batch = 2', 'max_legs_per_batch = 3']), {}),
    ).toThrow('max_legs_per_batch');
  });

  it('accepts enabled transfers only with live execution and an allowlist', () => {
    const allowlist = `
[[transfers.allowlist]]
from_venue = 'gateio'
to_venue = 'hotcoin'
asset = 'INC'
network = 'BSC'
address = '0xabc'
min_amount = '10'
max_amount = '100'
daily_max_amount = '200'
withdraw_fee = '1'
`;
    const config = loadExecutorConfig(configWithLiveTransfers(allowlist), {});
    expect(config.transfers.enabled).toBe(true);
    expect(config.liveEnabled).toBe(true);
    expect(config.killSwitch).toBe(false);
    expect(config.transfers.allowlist).toHaveLength(1);
    expect(() => loadExecutorConfig(configWithLiveTransfers(''), {})).toThrow('allowlist');
  });
});
