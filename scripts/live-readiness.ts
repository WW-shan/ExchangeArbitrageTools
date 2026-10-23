import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { createCcxtAdapter, createPublicRuntime } from '@arb/venues-cex';
import { loadConfig } from '../apps/scanner/src/config.js';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { credentialKey, loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';
import {
  impliedProfitFloorBps,
  missingFeeOverrideVenues,
  summarizeReadiness,
  type ReadinessCheck as Check,
  type ReadinessLevel as Level,
} from '../apps/scanner/src/readiness.js';

interface VenueProbe {
  venueId: string;
  restOk: boolean;
  wsOk: boolean;
  markets: number;
  error?: string;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

async function probeVenue(venueId: string, timeoutMs: number): Promise<VenueProbe> {
  const adapter = createCcxtAdapter(venueId, createPublicRuntime(2), { readOnly: true });
  const row: VenueProbe = { venueId, restOk: false, wsOk: false, markets: 0 };
  try {
    const markets = await withTimeout(adapter.loadMarkets(), timeoutMs, 'rest');
    row.markets = markets.length;
    const market =
      markets.find((candidate) => candidate.quote === 'USDT') ??
      markets.find((candidate) => candidate.quote === 'USDC') ??
      markets[0];
    if (!market) throw new Error('no USDT/USDC market');
    await withTimeout(adapter.fetchOrderBook(market.exchangeSymbol, 20), timeoutMs, 'book');
    row.restOk = true;
    if (adapter.watchOrderBook) {
      const controller = new AbortController();
      try {
        await withTimeout(
          new Promise<void>((resolveFirst, rejectFirst) => {
            void adapter.watchOrderBook!(
              market.exchangeSymbol,
              20,
              () => {
                controller.abort();
                resolveFirst();
              },
              controller.signal,
            ).catch(rejectFirst);
          }),
          timeoutMs,
          'ws',
        );
        row.wsOk = true;
      } catch {
        row.wsOk = false;
      } finally {
        controller.abort();
      }
    }
  } catch (error) {
    row.error = String(error).slice(0, 120);
  } finally {
    try {
      await withTimeout(Promise.resolve(adapter.close?.()), 3000, 'close');
    } catch {
      // ignore close errors
    }
  }
  return row;
}

async function main(): Promise<void> {
  const configPath = process.env.ARB_CONFIG ?? 'config/default.toml';
  const config = loadConfig(configPath);
  const checks: Check[] = [];
  const add = (id: string, level: Level, detail: string): void => {
    checks.push({ id, level, detail });
  };

  const executor = (() => {
    try {
      const loaded = loadExecutorConfig(configPath);
      add(
        'execution.safety_bounds',
        'pass',
        'max_open_batches=1, manual_confirmation=true, max_order_notional<=30, daily_max_loss<=20',
      );
      return loaded;
    } catch (error) {
      add('execution.safety_bounds', 'block', String(error));
      return undefined;
    }
  })();

  add(
    'execution.live_enabled',
    config.execution.liveEnabled ? 'warn' : 'pass',
    `live_enabled=${config.execution.liveEnabled} (keep false until the operator flips it)`,
  );
  add(
    'execution.kill_switch',
    config.execution.killSwitch ? 'pass' : 'warn',
    `kill_switch=${config.execution.killSwitch}`,
  );

  const enabled = config.scanner.enabledVenues;
  const missingFees = missingFeeOverrideVenues(enabled, config.fees);
  if (missingFees.length === 0) {
    add('fees.taker_overrides', 'pass', 'all enabled venues have explicit taker_bps');
  } else {
    add(
      'fees.taker_overrides',
      'warn',
      `${missingFees.length}/${enabled.length} venues fall back to CCXT generic fees: ${missingFees
        .slice(0, 10)
        .join(',')}${missingFees.length > 10 ? ',...' : ''}`,
    );
  }

  const maxNotional = executor?.riskLimits.maxOrderNotional ?? config.execution.maxOrderNotional;
  const impliedBps = impliedProfitFloorBps(config.scanner.minProfitUsd, maxNotional);
  add(
    'sizing.min_profit_vs_notional',
    impliedBps.gt(20) ? 'warn' : 'pass',
    `min_profit_usd=${config.scanner.minProfitUsd} / max_order_notional=${maxNotional} implies a ${impliedBps.toFixed(2)}bps floor`,
  );

  const proxy =
    process.env.ARB_SOCKS_PROXY ?? process.env.ARB_HTTPS_PROXY ?? process.env.HTTPS_PROXY;
  add(
    'network.proxy',
    proxy ? 'pass' : 'warn',
    proxy ? 'proxy configured' : 'no ARB_SOCKS_PROXY/HTTPS_PROXY set',
  );

  try {
    const db = openDatabase(config.database.path);
    const repository = new ArbitrageRepository(db);
    const integrity = db.prepare('PRAGMA integrity_check').get() as
      { integrity_check?: string } | undefined;
    add(
      'database.integrity',
      integrity?.integrity_check === 'ok' ? 'pass' : 'block',
      `integrity_check=${integrity?.integrity_check ?? 'unknown'}`,
    );
    const openExecutions = repository.listOpenExecutions();
    const unresolved = repository.listUnresolvedOrders();
    add(
      'database.open_executions',
      openExecutions.length === 0 ? 'pass' : 'block',
      `open_executions=${openExecutions.length}, unresolved_orders=${unresolved.length}`,
    );
    const persistedKill = repository.getSetting('kill_switch');
    add(
      'database.persisted_kill_switch',
      persistedKill === 'true' ? 'pass' : 'warn',
      `kill_switch=${persistedKill ?? 'unset'}`,
    );
    const persistedLive = repository.getSetting('live_enabled');
    add(
      'database.persisted_live',
      persistedLive === 'false' || persistedLive === undefined ? 'pass' : 'warn',
      `live_enabled=${persistedLive ?? 'unset'}`,
    );
    repository.close();
  } catch (error) {
    add('database.open', 'block', String(error));
  }

  const storePath =
    executor?.secretStorePath ?? process.env.ARB_SECRET_STORE_PATH ?? 'data/secrets.enc.json';
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!existsSync(storePath)) {
    add('secrets.store', 'block', `secret store missing at ${storePath}`);
  } else if (!masterKey) {
    add('secrets.master_key', 'block', 'ARB_SECRET_STORE_KEY not set; cannot validate credentials');
  } else {
    try {
      const records = await loadEncryptedSecretStore(storePath, masterKey);
      const keys = new Set([...records.values()].map((record) => credentialKey(record)));
      add(
        'secrets.store',
        'pass',
        `${records.size} credentials loaded; withdrawalPermission=false`,
      );
      const missingTrade = enabled.filter((venue) => !keys.has(`${venue}:trade`));
      add(
        'secrets.trade_coverage',
        missingTrade.length === 0 ? 'pass' : 'block',
        missingTrade.length === 0
          ? 'all enabled venues have trade credentials'
          : `missing trade credentials: ${missingTrade.slice(0, 10).join(',')}${
              missingTrade.length > 10 ? ',...' : ''
            }`,
      );
      const unverifiedIp = [...records.values()]
        .filter((record) => record.role === 'trade' && record.ipWhitelistVerified !== true)
        .map((record) => record.venueId);
      add(
        'secrets.ip_whitelist',
        unverifiedIp.length === 0 ? 'pass' : 'warn',
        unverifiedIp.length === 0
          ? 'all trade keys marked ipWhitelistVerified'
          : `ip whitelist unverified: ${unverifiedIp.slice(0, 10).join(',')}`,
      );
    } catch (error) {
      add('secrets.store', 'block', `cannot load secret store: ${String(error)}`);
    }
  }

  const skipNetwork = process.argv.includes('--skip-network');
  const venueFilter = arg('--venues', '');
  if (skipNetwork) {
    add('network.venues', 'warn', 'skipped (--skip-network)');
  } else {
    const timeoutMs = Math.max(1000, Number(arg('--timeout-ms', '10000')));
    const ids = venueFilter
      ? venueFilter
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : enabled;
    const probes: VenueProbe[] = [];
    for (const venueId of ids) probes.push(await probeVenue(venueId, timeoutMs));
    const restOk = probes.filter((probe) => probe.restOk);
    const wsOk = probes.filter((probe) => probe.wsOk);
    const failed = probes.filter((probe) => !probe.restOk).map((probe) => probe.venueId);
    add(
      'network.venues',
      restOk.length === 0 ? 'block' : restOk.length === ids.length ? 'pass' : 'warn',
      `${restOk.length}/${ids.length} REST ok, ${wsOk.length}/${ids.length} WS ok${
        failed.length > 0 ? `; REST failed: ${failed.join(',')}` : ''
      }`,
    );
    const output = resolve(arg('--out', 'data/live-readiness.json'));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), probes }, null, 2)}\n`,
      'utf8',
    );
  }

  if (config.bsc.enabled) {
    const missing = [
      ...(process.env.ZEROX_API_KEY ? [] : ['ZEROX_API_KEY']),
      ...(process.env.ONEINCH_API_KEY ? [] : ['ONEINCH_API_KEY']),
    ];
    add(
      'bsc.quote_keys',
      missing.length === 0 ? 'pass' : 'block',
      missing.length === 0 ? 'DEX quote keys present' : `missing: ${missing.join(',')}`,
    );
  } else {
    add('bsc.execution', 'pass', 'BSC/DEX execution disabled (no live DEX path in this phase)');
  }

  const summary = summarizeReadiness(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    configPath,
    enabledVenues: enabled.length,
    liveTestReady: summary.liveTestReady,
    blocked: summary.blocked,
    warnings: summary.warnings,
    checks,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(summary.liveTestReady ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
