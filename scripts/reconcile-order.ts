import { Decimal } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { adapterMap } from '../apps/executor/src/runtime.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const order = await bundle.adapter.fetchOrder({ clientOrderId, symbol }, bundle.credentials);
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
