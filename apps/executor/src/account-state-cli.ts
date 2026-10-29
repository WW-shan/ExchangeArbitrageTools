import { applyFeeOverride, mergeAccountFeeFile } from '@arb/venues-cex';
import type { MarketMetadata } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { refreshBalances } from './balance-service.js';
import { evaluateAccountPermissions } from './account-permissions.js';
import { pairBalances } from './auto-supervisor.js';
import { loadExecutorConfig } from './config.js';
import { fetchOpenOrdersForSymbols } from './open-orders.js';
import { adapterMap, findMarket } from './runtime.js';
import { loadEncryptedSecretStore } from './secret-store.js';

async function main(): Promise<void> {
  const config = loadExecutorConfig();
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  if (config.autoRotation.pairs.length === 0) {
    throw new Error('auto_rotation.pairs is empty; account state has no configured pairs');
  }
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  const adapters = adapterMap(repository, config, credentials);
  if (Object.keys(adapters).length === 0) {
    repository.close();
    throw new Error('no trade credentials found for account state');
  }
  const now = Date.now();
  const errors: string[] = [];
  const markets: Record<string, MarketMetadata[]> = {};
  const feeOverrides = mergeAccountFeeFile(config.feeOverrides, config.feeFile);
  try {
    const balanceVenues = Object.values(adapters).map((bundle) => ({
      adapter: bundle.adapter,
      credentials: bundle.credentials,
    }));
    const refreshed = await refreshBalances(repository, balanceVenues, now);
    errors.push(...refreshed.errors);

    for (const [venueId, bundle] of Object.entries(adapters)) {
      try {
        markets[venueId] = (await bundle.adapter.loadMarkets()).map((market) =>
          applyFeeOverride(market, feeOverrides),
        );
      } catch (error) {
        errors.push(`market_load_failed:${venueId}:${String(error)}`);
        markets[venueId] = [];
      }
    }

    const openOrders: Record<string, unknown[]> = {};
    for (const [venueId, bundle] of Object.entries(adapters)) {
      const symbols = [
        ...new Set(
          config.autoRotation.pairs.flatMap((pair) => {
            const market = findMarket(markets[venueId] ?? [], venueId, pair.base, pair.quote);
            return market ? [market.exchangeSymbol] : [];
          }),
        ),
      ];
      if (symbols.length === 0) {
        openOrders[venueId] = [];
        continue;
      }
      const result = await fetchOpenOrdersForSymbols(bundle.adapter, bundle.credentials, symbols);
      errors.push(...result.errors);
      openOrders[venueId] = result.orders.map((order) => ({
        venueOrderId: order.venueOrderId,
        ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        amount: order.amount.toFixed(),
        filled: order.filled.toFixed(),
        remaining: order.remaining.toFixed(),
        ...(order.price ? { price: order.price.toFixed() } : {}),
        status: order.status,
      }));
    }

    const permissionVenues = Object.fromEntries(
      [...credentials.values()]
        .filter((credential) => credential.role === 'trade')
        .flatMap((credential) => {
          const bundle = adapters[credential.venueId];
          return bundle
            ? [[credential.venueId, { adapter: bundle.adapter, credentials: credential }]]
            : [];
        }),
    );
    const accountStatus = await evaluateAccountPermissions({
      repository,
      credentials: [...credentials.values()],
      venues: permissionVenues,
      requiredPairs: config.autoRotation.pairs.map((pair) => `${pair.base}/${pair.quote}`),
      config: config.accountStatus,
      now,
    });

    const maxAgeMs = Math.max(config.autoRotation.balanceRefreshMs * 2, 30_000);
    const pairs = config.autoRotation.pairs.map((pair) => {
      const balances = pairBalances(repository, pair, markets, now, maxAgeMs);
      const [venueA, venueB] = pair.venues;
      return {
        pair: `${pair.base}/${pair.quote}`,
        venues: {
          [venueA]: {
            base: balances.readinessBalances.gateBase.toFixed(),
            quote: balances.readinessBalances.gateQuote.toFixed(),
          },
          [venueB]: {
            base: balances.readinessBalances.hotcoinBase.toFixed(),
            quote: balances.readinessBalances.hotcoinQuote.toFixed(),
          },
        },
        gateBase: balances.readinessBalances.gateBase.toFixed(),
        gateQuote: balances.readinessBalances.gateQuote.toFixed(),
        hotcoinBase: balances.readinessBalances.hotcoinBase.toFixed(),
        hotcoinQuote: balances.readinessBalances.hotcoinQuote.toFixed(),
        fresh: balances.fresh,
        reasons: balances.reasons,
      };
    });

    const pairAssets = new Set(
      config.autoRotation.pairs.flatMap((pair) => [
        pair.base.trim().toUpperCase(),
        pair.quote.trim().toUpperCase(),
      ]),
    );
    const balances = repository
      .latestBalances({ now })
      .filter(
        (balance) =>
          pairAssets.has(balance.currency.trim().toUpperCase()) &&
          (balance.free.gt(0) || balance.used.gt(0)),
      )
      .map((balance) => ({
        venueId: balance.venueId,
        accountId: balance.accountId,
        currency: balance.currency,
        free: balance.free.toFixed(),
        used: balance.used.toFixed(),
        total: balance.total.toFixed(),
        fetchedAt: balance.fetchedAt,
      }));

    console.log(
      JSON.stringify(
        {
          capturedAt: new Date(now).toISOString(),
          local: {
            openExecutions: repository.countOpenExecutions(),
            unresolvedOrders: repository.countUnresolvedOrders(),
            killSwitch: repository.getSetting('kill_switch'),
            liveEnabled: repository.getSetting('live_enabled'),
            autoExecutionEnabled: repository.getSetting('auto_execution_enabled'),
            transferAutoReleaseEnabled: repository.getSetting('transfer_auto_release_enabled'),
            activeTransferBatches: repository.activeTransferBatches().map((batch) => ({
              id: batch.id,
              status: batch.status,
              updatedAt: batch.updatedAt,
            })),
          },
          pairs,
          balances,
          openOrders,
          accountStatus,
          errors,
        },
        null,
        2,
      ),
    );
    if (errors.length > 0 || accountStatus.health === 'BLOCK') process.exitCode = 1;
  } finally {
    for (const bundle of Object.values(adapters)) {
      await bundle.adapter.close?.();
    }
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
