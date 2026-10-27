import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  applyFeeOverride,
  createCexAdapter,
  createPublicRuntime,
  mergeAccountFeeFile,
  type CexAdapter,
} from '@arb/venues-cex';
import { costSettings, loadConfig } from '../apps/scanner/src/config.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function capture(adapter: CexAdapter, market: { exchangeSymbol: string }, depth: number) {
  const started = Date.now();
  const book = await adapter.fetchOrderBook(market.exchangeSymbol, depth);
  return {
    venueId: adapter.venueId,
    exchangeSymbol: market.exchangeSymbol,
    fetchedAt: book.fetchedAt,
    ...(book.exchangeTimestamp ? { exchangeTimestamp: book.exchangeTimestamp } : {}),
    asks: book.asks.map((level) => [level.price.toFixed(), level.amount.toFixed()]),
    bids: book.bids.map((level) => [level.price.toFixed(), level.amount.toFixed()]),
    source: book.source,
    latencyMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const configPath = arg('--config', process.env.ARB_CONFIG ?? 'config/default.toml');
  const config = loadConfig(configPath);
  const settings = costSettings(config.scanner);
  const feeOverrides = mergeAccountFeeFile(config.fees, config.scanner.feeFile);
  const pair = arg('--pair', 'CAKE/USDT');
  const count = Number(arg('--samples', '20'));
  const intervalMs = Number(arg('--interval-ms', '5000'));
  const venueIds = [
    ...new Set(
      arg('--venues', 'gateio,hotcoin')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const depth = Number(arg('--depth', '50'));
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(depth) || depth <= 0) {
    throw new Error('samples and depth must be positive integers');
  }
  if (venueIds.length < 2) throw new Error('capture requires at least two venues');
  const adapters = venueIds.map((venueId) =>
    createCexAdapter(venueId, createPublicRuntime(2), { readOnly: true }),
  );
  try {
    const markets: Record<string, unknown> = {};
    const marketByVenue = new Map<string, { exchangeSymbol: string }>();
    for (const adapter of adapters) {
      const all = (await adapter.loadMarkets()).map((market) =>
        applyFeeOverride(market, feeOverrides),
      );
      const market = all.find((candidate) => candidate.unifiedSymbol === pair);
      if (!market) throw new Error(`${adapter.venueId} does not expose ${pair}`);
      if (!market.amountStep || !market.priceStep || market.feeTakerBps === undefined) {
        throw new Error(`${adapter.venueId} ${pair} is missing required execution metadata`);
      }
      marketByVenue.set(adapter.venueId, market);
      markets[adapter.venueId] = {
        venueId: market.venueId,
        exchangeSymbol: market.exchangeSymbol,
        unifiedSymbol: market.unifiedSymbol,
        base: market.base,
        quote: market.quote,
        active: market.active,
        pricePrecision: market.pricePrecision,
        amountPrecision: market.amountPrecision,
        amountStep: market.amountStep.toFixed(),
        priceStep: market.priceStep.toFixed(),
        minAmount: market.minAmount?.toFixed() ?? '0',
        minNotional: market.minNotional?.toFixed() ?? '0',
        feeTakerBps: market.feeTakerBps.toFixed(),
        ...(market.makerFeeBps !== undefined ? { makerFeeBps: market.makerFeeBps.toFixed() } : {}),
        supportsIoc: market.supportsIoc,
        supportsFok: market.supportsFok,
        ...(market.feeProvenance ? { feeProvenance: market.feeProvenance } : {}),
      };
    }
    const samples: Array<Record<string, unknown>> = [];
    for (let index = 0; index < count; index += 1) {
      const sample: Record<string, unknown> = {};
      for (const adapter of adapters) {
        const market = marketByVenue.get(adapter.venueId)!;
        sample[adapter.venueId] = await capture(adapter, market, depth);
      }
      sample.sampledAt = Date.now();
      samples.push(sample);
      if (index + 1 < count) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const [base, quote] = pair.split('/');
    if (!base || !quote) throw new Error('pair must be BASE/QUOTE');
    const fixture = {
      name: `Captured ${pair}`,
      kind: 'captured-market',
      generatedAt: new Date().toISOString(),
      base,
      quote,
      requestedNotional: config.scanner.requestedNotional.toFixed(),
      settings: {
        minProfitUsd: settings.minProfitUsd.toFixed(),
        safetyBufferBps: settings.safetyBufferBps.toFixed(),
        minNetProfitBps: settings.minNetProfitBps.toFixed(),
        maxOrderbookAgeMs: String(settings.maxOrderbookAgeMs),
        maxSlippageBps: settings.maxSlippageBps.toFixed(),
        maxGasCostUsd: settings.maxGasCostUsd.toFixed(),
        maxTransferTaxBps: settings.maxTransferTaxBps.toFixed(),
      },
      markets,
      samples,
    };
    const safePair = pair.replace('/', '-');
    const output = resolve(arg('--out', `fixtures/backtest/captured-${safePair}.json`));
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    console.log(
      JSON.stringify({
        output,
        venues: venueIds,
        pair,
        samples: samples.length,
        requestedNotional: fixture.requestedNotional,
        config: configPath,
      }),
    );
  } finally {
    await Promise.allSettled(adapters.map((adapter) => adapter.close?.()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
