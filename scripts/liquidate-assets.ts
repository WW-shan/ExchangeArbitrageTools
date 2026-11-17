import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Decimal, type MarketMetadata } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  applyFeeOverride,
  mergeAccountFeeFile,
  type ApiCredentials,
  type CexAdapter,
} from '@arb/venues-cex';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { refreshBalances } from '../apps/executor/src/balance-service.js';
import { planAssetLiquidation } from '../apps/executor/src/asset-liquidation.js';
import { adapterMap } from '../apps/executor/src/runtime.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function listArg(name: string, fallback: string): string[] {
  return arg(name, fallback)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isTerminal(status: string): boolean {
  return status === 'closed' || status === 'canceled' || status === 'rejected';
}

function isDefinitiveNoFill(error: unknown): boolean {
  return /FOK_NOT_FILL|cannot be filled completely|ioc[^\n]*not[\n]*fill|fok[^\n]*not[\n]*fill/i.test(
    String(error),
  );
}

interface Bundle {
  venueId: string;
  adapter: CexAdapter;
  credentials: ApiCredentials;
}

async function refresh(repository: ArbitrageRepository, bundles: readonly Bundle[]): Promise<void> {
  const result = await refreshBalances(
    repository,
    bundles.map((bundle) => ({ adapter: bundle.adapter, credentials: bundle.credentials })),
  );
  if (result.errors.length > 0)
    throw new Error(`balance refresh failed: ${result.errors.join('; ')}`);
}

async function main(): Promise<void> {
  const config = loadExecutorConfig(process.env.ARB_CONFIG ?? 'config/live-rotation.toml');
  const venueIds = listArg('--venues', 'gateio,bitget');
  const quote = arg('--quote', 'USDT').trim().toUpperCase();
  const keep = new Set(
    arg('--keep', 'WARD,USDT')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  const execute = has('--execute');
  const confirmation = arg('--confirm', '');
  const maxSlippageBps = new Decimal(arg('--max-slippage-bps', '300'));
  const minQuoteUsd = new Decimal(arg('--min-quote-usd', '1'));
  const outputPath = arg('--out', 'data/asset-liquidation-plan.json');
  if (!maxSlippageBps.isFinite() || maxSlippageBps.lte(0)) throw new Error('invalid max slippage');
  if (!minQuoteUsd.isFinite() || minQuoteUsd.lte(0)) throw new Error('invalid min quote');
  if (execute && confirmation !== 'LIQUIDATE-ASSETS') {
    throw new Error('--execute requires --confirm LIQUIDATE-ASSETS');
  }
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  const adapters = adapterMap(repository, config, credentials);
  const feeOverrides = mergeAccountFeeFile(config.feeOverrides, config.feeFile);
  const report = {
    generatedAt: new Date().toISOString(),
    execute,
    venues: venueIds,
    quote,
    keep: [...keep],
    maxSlippageBps: maxSlippageBps.toFixed(),
    minQuoteUsd: minQuoteUsd.toFixed(),
    sells: [] as Array<Record<string, unknown>>,
    skipped: [] as Array<Record<string, unknown>>,
    errors: [] as Array<Record<string, unknown>>,
    finalBalances: [] as Array<Record<string, unknown>>,
  };
  try {
    if (execute) {
      if (!config.liveEnabled) throw new Error('live execution is disabled');
      if (repository.getSetting('kill_switch') !== 'false')
        throw new Error('kill_switch must be false');
      if (repository.getSetting('auto_execution_enabled') === 'true') {
        throw new Error('stop the automatic rotation supervisor before liquidating assets');
      }
      if (repository.countOpenExecutions() > 0 || repository.countUnresolvedOrders() > 0) {
        throw new Error('open execution or unresolved order exists');
      }
    }
    const bundles: Bundle[] = venueIds.map((venueId) => {
      const bundle = adapters[venueId];
      if (!bundle) throw new Error(`missing trade credentials for ${venueId}`);
      if (
        !bundle.adapter.capabilities.createOrder ||
        !bundle.adapter.capabilities.fetchOrder ||
        !bundle.adapter.capabilities.openOrders
      ) {
        throw new Error(`missing order capabilities for ${venueId}`);
      }
      return { venueId, adapter: bundle.adapter, credentials: bundle.credentials };
    });
    const marketsByVenue = new Map<string, MarketMetadata[]>();
    for (const bundle of bundles) {
      marketsByVenue.set(
        bundle.venueId,
        (await bundle.adapter.loadMarkets()).map((market) =>
          applyFeeOverride(market, feeOverrides),
        ),
      );
    }
    await refresh(repository, bundles);
    let balances = repository.latestBalances({ maxAgeMs: 60_000 });
    const free = (venueId: string, asset: string): Decimal =>
      balances.find(
        (row) =>
          row.venueId === venueId &&
          row.currency.trim().toUpperCase() === asset.trim().toUpperCase(),
      )?.free ?? new Decimal(0);

    const plans: Array<{
      venueId: string;
      asset: string;
      market: MarketMetadata;
      plan: ReturnType<typeof planAssetLiquidation>;
    }> = [];
    for (const bundle of bundles) {
      const markets = marketsByVenue.get(bundle.venueId) ?? [];
      const candidates = balances.filter(
        (row) =>
          row.venueId === bundle.venueId &&
          row.free.gt(0) &&
          !keep.has(row.currency.trim().toUpperCase()),
      );
      for (const balance of candidates) {
        const asset = balance.currency.trim().toUpperCase();
        const market = markets.find(
          (entry) =>
            entry.active &&
            entry.quote.trim().toUpperCase() === quote &&
            entry.base.trim().toUpperCase() === asset,
        );
        if (!market) {
          report.skipped.push({ venueId: bundle.venueId, asset, reason: 'market_missing' });
          continue;
        }
        const book = await bundle.adapter.fetchOrderBook(market.exchangeSymbol, 50);
        const plan = planAssetLiquidation({
          free: balance.free,
          market,
          book,
          maxSlippageBps,
        });
        if (plan.action === 'SKIP') {
          report.skipped.push({ venueId: bundle.venueId, asset, reason: plan.reason });
          continue;
        }
        if (plan.expectedQuote.lt(minQuoteUsd)) {
          report.skipped.push({
            venueId: bundle.venueId,
            asset,
            reason: 'below_quote_floor',
            expectedQuote: plan.expectedQuote.toFixed(),
          });
          continue;
        }
        plans.push({ venueId: bundle.venueId, asset, market, plan });
        report.sells.push({
          venueId: bundle.venueId,
          asset,
          amount: plan.amount.toFixed(),
          limitPrice: plan.limitPrice.toFixed(),
          expectedQuote: plan.expectedQuote.toFixed(),
          slippageBps: plan.slippageBps.toFixed(2),
          partial: plan.partial,
        });
      }
    }
    if (execute) {
      for (const entry of plans) {
        if (entry.plan.action !== 'SELL') continue;
        const bundle = bundles.find((value) => value.venueId === entry.venueId)!;
        const freshBook = await bundle.adapter.fetchOrderBook(entry.market.exchangeSymbol, 50);
        const fresh = planAssetLiquidation({
          free: free(entry.venueId, entry.asset),
          market: entry.market,
          book: freshBook,
          maxSlippageBps,
        });
        if (fresh.action === 'SKIP') {
          report.errors.push({
            venueId: entry.venueId,
            asset: entry.asset,
            error: `replan_rejected:${fresh.reason}`,
          });
          continue;
        }
        if (fresh.expectedQuote.lt(minQuoteUsd)) {
          report.errors.push({
            venueId: entry.venueId,
            asset: entry.asset,
            error: 'replan_below_quote_floor',
          });
          continue;
        }
        const clientOrderId = `LIQ-${entry.venueId.slice(0, 3)}-${entry.asset.slice(0, 5)}-${randomUUID().slice(0, 8)}`;
        const now = Date.now();
        repository.recordOrder({
          venueId: entry.venueId,
          clientOrderId,
          symbol: entry.market.exchangeSymbol,
          side: 'sell',
          type: 'limit',
          price: fresh.limitPrice,
          amount: fresh.amount,
          filledAmount: new Decimal(0),
          status: 'pending',
          now,
        });
        repository.recordAudit(
          'operator',
          'asset_liquidation_submit',
          {
            venueId: entry.venueId,
            asset: entry.asset,
            amount: fresh.amount.toFixed(),
            limitPrice: fresh.limitPrice.toFixed(),
            expectedQuote: fresh.expectedQuote.toFixed(),
            slippageBps: fresh.slippageBps.toFixed(2),
            clientOrderId,
          },
          now,
        );
        let order;
        try {
          order = await bundle.adapter.createOrder!(
            {
              symbol: entry.market.exchangeSymbol,
              side: 'sell',
              type: 'limit',
              amount: fresh.amount,
              price: fresh.limitPrice,
              timeInForce: 'FOK',
              clientOrderId,
            },
            bundle.credentials,
          );
        } catch (error) {
          const definitive = isDefinitiveNoFill(error);
          repository.recordOrder({
            venueId: entry.venueId,
            clientOrderId,
            symbol: entry.market.exchangeSymbol,
            side: 'sell',
            type: 'limit',
            price: fresh.limitPrice,
            amount: fresh.amount,
            filledAmount: new Decimal(0),
            status: definitive ? 'canceled' : 'unknown',
            now: Date.now(),
          });
          if (!definitive) {
            repository.setSetting('kill_switch', 'true', Date.now());
            repository.recordRiskEvent(
              'critical',
              'asset_liquidation_unknown_order',
              String(error),
              { venueId: entry.venueId, asset: entry.asset, clientOrderId },
              Date.now(),
            );
            report.errors.push({
              venueId: entry.venueId,
              asset: entry.asset,
              error: `unknown_submit:${String(error)}`,
            });
            break;
          }
          report.errors.push({
            venueId: entry.venueId,
            asset: entry.asset,
            error: 'definitive_no_fill',
          });
          continue;
        }
        let finalOrder = order;
        for (let attempt = 0; attempt < 8 && !isTerminal(finalOrder.status); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          try {
            finalOrder = await bundle.adapter.fetchOrder!(
              {
                clientOrderId,
                venueOrderId: finalOrder.venueOrderId,
                symbol: entry.market.exchangeSymbol,
              },
              bundle.credentials,
            );
          } catch {
            continue;
          }
        }
        if (finalOrder.status === 'open') {
          finalOrder = await bundle.adapter.cancelOrder!(
            {
              clientOrderId,
              venueOrderId: finalOrder.venueOrderId,
              symbol: entry.market.exchangeSymbol,
            },
            bundle.credentials,
          );
        }
        repository.recordOrder({
          venueId: entry.venueId,
          venueOrderId: finalOrder.venueOrderId,
          clientOrderId,
          symbol: finalOrder.symbol,
          side: finalOrder.side,
          type: finalOrder.type,
          price: finalOrder.price ?? fresh.limitPrice,
          amount: finalOrder.amount,
          filledAmount: finalOrder.filled,
          ...(finalOrder.averagePrice ? { averagePrice: finalOrder.averagePrice } : {}),
          ...(finalOrder.fee ? { fee: finalOrder.fee } : {}),
          ...(finalOrder.feeCurrency ? { feeCurrency: finalOrder.feeCurrency } : {}),
          status: finalOrder.status,
          now: Date.now(),
        });
        repository.recordAudit(
          'operator',
          'asset_liquidation_result',
          {
            venueId: entry.venueId,
            asset: entry.asset,
            clientOrderId,
            status: finalOrder.status,
            filled: finalOrder.filled.toFixed(),
            remaining: finalOrder.remaining.toFixed(),
            averagePrice: finalOrder.averagePrice?.toFixed() ?? null,
          },
          Date.now(),
        );
        report.sells.push({
          venueId: entry.venueId,
          asset: entry.asset,
          status: finalOrder.status,
          filled: finalOrder.filled.toFixed(),
          remaining: finalOrder.remaining.toFixed(),
          averagePrice: finalOrder.averagePrice?.toFixed() ?? null,
          fee: finalOrder.fee?.toFixed() ?? null,
          feeCurrency: finalOrder.feeCurrency ?? null,
        });
        if (finalOrder.status === 'unknown') {
          repository.setSetting('kill_switch', 'true', Date.now());
          report.errors.push({
            venueId: entry.venueId,
            asset: entry.asset,
            error: 'unknown_order_state_after_reconcile',
          });
          break;
        }
        if (finalOrder.remaining.gt(0)) {
          report.errors.push({
            venueId: entry.venueId,
            asset: entry.asset,
            error: 'partially_unfilled',
            remaining: finalOrder.remaining.toFixed(),
          });
        }
        await refresh(repository, bundles);
        balances = repository.latestBalances({ maxAgeMs: 60_000 });
      }
    }
    report.finalBalances = balances
      .filter((row) => row.free.gt(0))
      .map((row) => ({ venueId: row.venueId, asset: row.currency, free: row.free.toFixed() }));
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    console.log(serialized);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, 'utf8');
  } finally {
    repository.close();
    for (const bundle of Object.values(adapters)) await bundle.adapter.close?.();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
