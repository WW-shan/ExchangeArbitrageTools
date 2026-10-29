import { Decimal } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { ApiCredentials, BalanceSnapshot, CexAdapter, OrderState } from '@arb/venues-cex';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { adapterMap } from '../apps/executor/src/runtime.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isOrderNotFoundError(error: unknown): boolean {
  return /ordernotfound|client_id_not_found|order not found/i.test(String(error));
}

function totalFor(rows: readonly BalanceSnapshot[], currency: string): Decimal | undefined {
  return rows
    .filter((row) => row.currency.trim().toUpperCase() === currency.trim().toUpperCase())
    .reduce<Decimal | undefined>(
      (total, row) => (total ? total.plus(row.total) : row.total),
      undefined,
    );
}

async function confirmNoFill(input: {
  repository: ArbitrageRepository;
  adapter: CexAdapter;
  credentials: ApiCredentials;
  venueId: string;
  symbol: string;
  clientOrderId: string;
  error: unknown;
}): Promise<Record<string, unknown>> {
  const { repository, adapter, credentials, venueId, symbol, clientOrderId, error } = input;
  if (!adapter.fetchBalances) throw new Error(`fetchBalances is unavailable for ${venueId}`);
  const local = repository.getOrder(clientOrderId);
  if (!local) throw new Error(`local order not found: ${clientOrderId}`);
  const markets = await adapter.loadMarkets();
  const market =
    markets.find((candidate) => candidate.exchangeSymbol === local.symbol) ??
    markets.find((candidate) => candidate.unifiedSymbol === symbol.toUpperCase());
  const fallback = local.symbol.split('/');
  const base = market?.base ?? fallback[0]?.trim().toUpperCase();
  const quote = market?.quote ?? fallback[1]?.trim().toUpperCase();
  if (!base || !quote) throw new Error(`cannot resolve base/quote for ${local.symbol}`);

  const currentRows = await adapter.fetchBalances(credentials);
  const current = new Map<string, Decimal>();
  for (const currency of [base, quote]) {
    const total = totalFor(currentRows, currency);
    if (!total) throw new Error(`current ${currency} balance is missing on ${venueId}`);
    current.set(currency, total);
  }

  const baseline = new Map<string, { total: Decimal; fetchedAt: number }>();
  for (const currency of [base, quote]) {
    const row = repository.db
      .prepare(
        `SELECT total, fetched_at FROM balances
         WHERE venue_id = ? AND UPPER(currency) = ? AND fetched_at <= ?
         ORDER BY fetched_at DESC LIMIT 1`,
      )
      .get(venueId, currency, local.createdAt) as { total: string; fetched_at: number } | undefined;
    if (!row) {
      throw new Error(`no persisted ${currency} baseline before order ${clientOrderId}`);
    }
    baseline.set(currency, { total: new Decimal(row.total), fetchedAt: row.fetched_at });
  }

  for (const currency of [base, quote]) {
    const before = baseline.get(currency)!;
    const after = current.get(currency)!;
    if (!after.eq(before.total)) {
      throw new Error(
        `${currency} balance changed for ${clientOrderId}: before ${before.total.toFixed()}, after ${after.toFixed()}; refusing no-fill confirmation`,
      );
    }
  }

  if (typeof adapter.fetchOpenOrders === 'function') {
    const open = await adapter.fetchOpenOrders({ symbol: local.symbol }, credentials);
    if (
      open.some(
        (order) =>
          order.clientOrderId === clientOrderId ||
          order.status === 'open' ||
          order.status === 'unknown',
      )
    ) {
      throw new Error(`open or unresolved order remains for ${clientOrderId}`);
    }
  }

  const now = Date.now();
  repository.recordOrder({
    venueId,
    clientOrderId,
    ...(local.executionId !== null ? { executionId: local.executionId } : {}),
    symbol: local.symbol,
    side: local.side,
    type: local.type,
    price: new Decimal(local.price),
    amount: new Decimal(local.amount),
    filledAmount: new Decimal(0),
    status: 'canceled',
    now,
  });
  repository.updateExecutionLeg(clientOrderId, {
    status: 'canceled',
    filledAmount: new Decimal(0),
    error: 'venue_order_not_found_balance_confirmed_no_fill',
  });
  const context = {
    venueId,
    symbol: local.symbol,
    clientOrderId,
    error: String(error),
    baseline: Object.fromEntries(
      [...baseline].map(([currency, row]) => [
        currency,
        { total: row.total.toFixed(), fetchedAt: row.fetchedAt },
      ]),
    ),
    current: Object.fromEntries(
      [...current].map(([currency, total]) => [currency, total.toFixed()]),
    ),
  };
  repository.recordOrderEvent(
    clientOrderId,
    'venue_order_not_found_no_fill_confirmed',
    context,
    now,
  );
  repository.recordAudit('operator', 'order_no_fill_confirmed', context, now);
  repository.recordRiskEvent(
    'warning',
    'order_not_found_confirmed_no_fill',
    'venue order missing; persisted and current balances are unchanged',
    context,
    now,
  );
  return {
    action: 'confirmed_no_fill',
    ...context,
    unresolvedOrders: repository.countUnresolvedOrders(),
    killSwitch: repository.getSetting('kill_switch'),
  };
}

async function main(): Promise<void> {
  const config = loadExecutorConfig(process.env.ARB_CONFIG ?? 'config/live-rotation.toml');
  const venueId = arg('--venue')?.trim().toLowerCase();
  const symbol = arg('--symbol')?.trim();
  const clientOrderId = arg('--client-order-id')?.trim();
  if (!venueId || !symbol || !clientOrderId) {
    throw new Error('--venue, --symbol and --client-order-id are required');
  }
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const adapters = adapterMap(
    new ArbitrageRepository(openDatabase(':memory:')),
    config,
    credentials,
  );
  const bundle = adapters[venueId];
  if (!bundle?.adapter.fetchOrder) throw new Error(`fetchOrder is unavailable for ${venueId}`);
  const confirmNoFillRequested = process.argv.includes('--confirm-no-fill');
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    let order: OrderState;
    try {
      order = await bundle.adapter.fetchOrder({ clientOrderId, symbol }, bundle.credentials);
    } catch (error) {
      if (!confirmNoFillRequested || !isOrderNotFoundError(error)) throw error;
      const result = await confirmNoFill({
        repository,
        adapter: bundle.adapter,
        credentials: bundle.credentials,
        venueId,
        symbol,
        clientOrderId,
        error,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const now = Date.now();
    repository.recordOrder({
      venueId,
      ...(order.venueOrderId ? { venueOrderId: order.venueOrderId } : {}),
      clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price ?? new Decimal(0),
      amount: order.amount,
      filledAmount: order.filled,
      ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
      ...(order.fee ? { fee: order.fee } : {}),
      status: order.status,
      now,
    });
    repository.recordOrderEvent(
      clientOrderId,
      'venue_reconciled',
      {
        venueOrderId: order.venueOrderId,
        status: order.status,
        amount: order.amount.toFixed(),
        filled: order.filled.toFixed(),
        remaining: order.remaining.toFixed(),
        averagePrice: order.averagePrice?.toFixed() ?? null,
      },
      now,
    );
    repository.recordAudit(
      'operator',
      'order_reconciled',
      {
        venueId,
        symbol,
        clientOrderId,
        venueOrderId: order.venueOrderId,
        status: order.status,
        filled: order.filled.toFixed(),
      },
      now,
    );
    console.log(
      JSON.stringify(
        {
          venueId,
          symbol,
          clientOrderId,
          venueOrderId: order.venueOrderId,
          status: order.status,
          amount: order.amount.toFixed(),
          filled: order.filled.toFixed(),
          remaining: order.remaining.toFixed(),
          averagePrice: order.averagePrice?.toFixed() ?? null,
          unresolvedOrders: repository.countUnresolvedOrders(),
          killSwitch: repository.getSetting('kill_switch'),
        },
        null,
        2,
      ),
    );
  } finally {
    repository.close();
    await bundle.adapter.close?.();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
