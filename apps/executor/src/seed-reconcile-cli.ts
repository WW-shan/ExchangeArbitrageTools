import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { reconcileAutomaticInventoryNoFill } from './auto-inventory.js';
import { loadExecutorConfig } from './config.js';
import { adapterMap } from './runtime.js';
import { loadEncryptedSecretStore } from './secret-store.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): string {
  return [
    'Usage: npm run seed:reconcile -- --batch <batchId> --confirm <batchId>',
    '',
    'Closes a SEED_UNKNOWN execution only after the exchange order is absent or',
    'terminal with zero fill, no open orders exist, and both base and quote free',
    'balances still match the pre-seed snapshot. It never submits an order and',
    'never clears the kill switch.',
  ].join('\n');
}

async function main(): Promise<void> {
  const batchId = arg('--batch');
  const confirm = arg('--confirm');
  if (!batchId || confirm !== batchId) throw new Error(usage());
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const config = loadExecutorConfig();
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const adapters = adapterMap(repository, config, credentials);
    const result = await reconcileAutomaticInventoryNoFill({ repository, adapters, batchId });
    console.log(
      JSON.stringify(
        {
          ...result,
          killSwitch: repository.getSetting('kill_switch'),
          autoExecutionEnabled: repository.getSetting('auto_execution_enabled'),
          next: 'Review the result, then release the kill switch only after confirming the exchange account is flat.',
        },
        null,
        2,
      ),
    );
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
