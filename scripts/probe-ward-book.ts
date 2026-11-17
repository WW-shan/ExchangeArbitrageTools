import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { adapterMap } from '../apps/executor/src/runtime.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';

async function main(): Promise<void> {
  const config = loadExecutorConfig(process.env.ARB_CONFIG ?? 'config/live-rotation.toml');
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  const adapters = adapterMap(repository, config, credentials);
  try {
    for (const venueId of ['gateio', 'bitget']) {
      const bundle = adapters[venueId];
      if (!bundle) continue;
      const markets = await bundle.adapter.loadMarkets();
      const market = markets.find(
        (entry) => entry.base.toUpperCase() === 'WARD' && entry.quote.toUpperCase() === 'USDT',
      );
      if (!market) {
        console.log(JSON.stringify({ venueId, error: 'market_missing' }));
        continue;
      }
      const fetchStartedAt = Date.now();
      const book = await bundle.adapter.fetchOrderBook(market.exchangeSymbol, 20);
      const fetchMs = Date.now() - fetchStartedAt;
      const now = Date.now();
      const hot = repository.latestHotOrderbook(bundle.adapter.venueId, market.exchangeSymbol, {
        maxAgeMs: config.settings.preflightHotBookMaxAgeMs ?? 3000,
        now,
      });
      console.log(
        JSON.stringify({
          venueId,
          symbol: market.exchangeSymbol,
          now,
          restFetchMs: fetchMs,
          fetchedAt: book.fetchedAt,
          receivedAt: book.receivedAt,
          exchangeTimestamp: book.exchangeTimestamp,
          receivedAgeMs: book.receivedAt === undefined ? null : now - book.receivedAt,
          exchangeAgeMs: book.exchangeTimestamp === undefined ? null : now - book.exchangeTimestamp,
          source: book.source,
          bestBid: book.bids[0]?.price.toFixed() ?? null,
          bestAsk: book.asks[0]?.price.toFixed() ?? null,
          hotAgeMs: hot ? now - hot.fetchedAt : null,
          hotBestBid: hot?.bids[0]?.price.toFixed() ?? null,
          hotBestAsk: hot?.asks[0]?.price.toFixed() ?? null,
          hotSource: hot?.source ?? null,
        }),
      );
    }
  } finally {
    await Promise.all(
      Object.values(adapters).map((bundle) => bundle.adapter.close?.().catch(() => undefined)),
    );
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
