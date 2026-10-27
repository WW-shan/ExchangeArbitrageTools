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
    expect(config.legMode).toBe('serial');
    expect(config.iocVenues).toEqual([]);
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
  });

  it('accepts an explicitly selected parallel FOK mode', () => {
    const path = configWith([`leg_mode = 'serial'`, `leg_mode = 'parallel_fok'`]);
    expect(loadExecutorConfig(path, {}).legMode).toBe('parallel_fok');
  });
});
