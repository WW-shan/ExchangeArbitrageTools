import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCcxtAdapter, createPublicRuntime, type CexAdapter } from '@arb/venues-cex';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function capture(adapter: CexAdapter, symbol: string, depth: number) {
  const started = Date.now();
  const book = await adapter.fetchOrderBook(symbol, depth);
  return {
    venueId: adapter.venueId,
    exchangeSymbol: symbol,
    fetchedAt: book.fetchedAt,
    ...(book.exchangeTimestamp ? { exchangeTimestamp: book.exchangeTimestamp } : {}),
    asks: book.asks.map((level) => [level.price.toFixed(), level.amount.toFixed()]),
    bids: book.bids.map((level) => [level.price.toFixed(), level.amount.toFixed()]),
    source: book.source,
    latencyMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  const pair = arg('--pair', 'CAKE/USDT');
  const count = Number(arg('--samples', '20'));
  const intervalMs = Number(arg('--interval-ms', '5000'));
  const venueIds = arg('--venues', 'gateio,mexc')
    .split(',')
    .map((value) => value.trim());
  const depth = Number(arg('--depth', '50'));
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(depth) || depth <= 0) {
    throw new Error('samples and depth must be positive integers');
  }
  const adapters = venueIds.map((venueId) =>
    createCcxtAdapter(venueId, createPublicRuntime(2), { readOnly: true }),
  );
  const markets: Record<string, unknown> = {};
  for (const adapter of adapters) {
    const all = await adapter.loadMarkets();
    const market = all.find((candidate) => candidate.unifiedSymbol === pair);
    if (!market) throw new Error(`${adapter.venueId} does not expose ${pair}`);
    if (!market.amountStep || !market.priceStep || !market.feeTakerBps) {
      throw new Error(`${adapter.venueId} ${pair} is missing required execution metadata`);
    }
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
      minAmount: market.minAmount?.toFixed(),
      minNotional: market.minNotional?.toFixed(),
      feeTakerBps: market.feeTakerBps.toFixed(),
      supportsIoc: market.supportsIoc,
      supportsFok: market.supportsFok,
    };
  }
  const samples: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const sample: Record<string, unknown> = {};
    for (const adapter of adapters) sample[adapter.venueId] = await capture(adapter, pair, depth);
    sample.sampledAt = Date.now();
    samples.push(sample);
    if (index + 1 < count) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const [base, quote] = pair.split('/');
  const fixture = {
    name: `Captured ${pair}`,
    kind: 'captured-market',
    generatedAt: new Date().toISOString(),
    base,
    quote,
    requestedNotional: '30',
    settings: {
      minProfitUsd: '0.25',
      safetyBufferBps: '15',
      minNetProfitBps: '20',
      maxOrderbookAgeMs: '3000',
      maxSlippageBps: '50',
      maxGasCostUsd: '0.50',
      maxTransferTaxBps: '0',
    },
    markets,
    samples,
  };
  const safePair = pair.replace('/', '-');
  const output = resolve(`fixtures/backtest/captured-${safePair}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`captured ${samples.length} samples to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
