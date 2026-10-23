import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../apps/scanner/src/config.js';
import {
  HotcoinReadOnlyAdapter,
  createCcxtAdapter,
  createPublicRuntime,
  type CexAdapter,
} from '@arb/venues-cex';

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

async function firstWsBook(
  adapter: CexAdapter,
  symbol: string,
  timeoutMs: number,
): Promise<{ latencyMs: number }> {
  if (!adapter.watchOrderBook) throw new Error('websocket not supported');
  const controller = new AbortController();
  const started = Date.now();
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        void adapter.watchOrderBook!(
          symbol,
          5,
          () => {
            controller.abort();
            resolve();
          },
          controller.signal,
        ).catch(reject);
      }),
      timeoutMs,
      'ws',
    );
    return { latencyMs: Date.now() - started };
  } finally {
    controller.abort();
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.ARB_CONFIG ?? 'config/default.toml');
  const timeoutMs = Number(arg('--timeout-ms', '10000'));
  const symbol = arg('--pair', 'BTC/USDT');
  const venueFilter = arg('--venues', '');
  const venueIds = venueFilter
    ? venueFilter
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : config.scanner.enabledVenues;
  const results: Array<Record<string, unknown>> = [];
  for (const venueId of venueIds) {
    const runtime = createPublicRuntime(2);
    const adapter: CexAdapter =
      venueId === 'hotcoin'
        ? new HotcoinReadOnlyAdapter()
        : createCcxtAdapter(venueId, runtime, { readOnly: true });
    const row: Record<string, unknown> = { venueId };
    try {
      const started = Date.now();
      const markets = await withTimeout(adapter.loadMarkets(), timeoutMs, 'rest');
      row.restMs = Date.now() - started;
      row.markets = markets.length;
      const market =
        markets.find((candidate) => candidate.unifiedSymbol === symbol) ??
        markets.find((candidate) => ['USDT', 'USDC', 'USD'].includes(candidate.quote)) ??
        markets[0];
      if (!market) throw new Error(`no ${symbol} or USDT market`);
      row.pair = market.unifiedSymbol;
      const bookStarted = Date.now();
      await withTimeout(adapter.fetchOrderBook(market.exchangeSymbol, 5), timeoutMs, 'book');
      row.bookMs = Date.now() - bookStarted;
      row.restOk = true;
      if (adapter.watchOrderBook) {
        try {
          const ws = await firstWsBook(adapter, market.exchangeSymbol, timeoutMs);
          row.wsMs = ws.latencyMs;
          row.wsOk = true;
        } catch (error) {
          row.wsOk = false;
          row.wsError = String(error);
        }
      }
    } catch (error) {
      row.restOk = false;
      row.error = String(error);
    } finally {
      try {
        await withTimeout(Promise.resolve(adapter.close?.()), 3000, 'close');
      } catch {
        // ignore
      }
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const output = resolve(arg('--out', 'data/venue-probe.json'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(`wrote ${output}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
