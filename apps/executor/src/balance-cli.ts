import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { CEX_TIERS, createCcxtAdapter, createPublicRuntime } from '@arb/venues-cex';
import { loadExecutorConfig } from './config.js';
import { loadEncryptedSecretStore } from './secret-store.js';
import { refreshBalances, type BalanceVenue } from './balance-service.js';

interface CliOptions {
  loop: boolean;
  intervalMs: number;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: npm run executor:balances -- [--loop] [--interval-ms <ms>]',
    '',
    'Loads read-only credentials from the encrypted secret store, fetches balances from',
    'every supported venue, and persists them for inventory-mode cross-venue discovery.',
    'Requires ARB_SECRET_STORE_KEY and at least one read_only credential.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { loop: false, intervalMs: 60_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }
    if (value === '--loop') {
      options.loop = true;
      continue;
    }
    if (value === '--interval-ms') {
      const argument = argv[index + 1];
      if (!argument) throw new Error('--interval-ms requires a value');
      const parsed = Number(argument);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--interval-ms must be a positive integer');
      }
      options.intervalMs = parsed;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const config = loadExecutorConfig();
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const venues: BalanceVenue[] = [];
    for (const credential of credentials.values()) {
      if (credential.role !== 'read_only') continue;
      if (!CEX_TIERS[credential.venueId]) continue;
      const runtime = createPublicRuntime(1);
      venues.push({
        adapter: createCcxtAdapter(credential.venueId, runtime, {
          credentials: credential,
          readOnly: true,
        }),
        credentials: credential,
      });
    }
    if (venues.length === 0) {
      throw new Error(
        'no read-only credentials found; add read_only records with npm run executor:secrets',
      );
    }
    do {
      const result = await refreshBalances(repository, venues);
      const payload = { refreshedAt: Date.now(), ...result };
      repository.recordAudit('operator', 'balance_refresh', payload);
      console.log(JSON.stringify(payload, null, 2));
      if (!options.loop) break;
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    } while (true);
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
