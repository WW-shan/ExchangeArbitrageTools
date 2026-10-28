import { existsSync, readFileSync } from 'node:fs';
import {
  createEncryptedSecretStore,
  loadEncryptedSecretStore,
  mergeCredentialRecords,
  type StoredCredential,
} from './secret-store.js';

function usage(): string {
  return [
    'Usage: npm run executor:secrets -- [--path <file>] [--merge]',
    '',
    'Reads a JSON array of credentials from stdin. Example record:',
    'Withdrawal records use role=withdrawal, withdrawalPermission=true,',
    'ipWhitelistVerified=true, and a separate API key from the trade key.',
    '{"venueId":"gateio","role":"trade","withdrawalPermission":false,"apiKey":"...","secret":"..."}',
    'Hotcoin records additionally require the API passphrase in "password":',
    '{"venueId":"hotcoin","role":"trade","withdrawalPermission":false,"apiKey":"...","secret":"...","password":"..."}',
    'Use --merge to load the existing store and upsert records by venueId:role.',
    '',
    'Set the master key in ARB_SECRET_STORE_KEY (at least 16 characters). The',
    'command prints fingerprints only; it never prints API keys or secrets.',
  ].join('\n');
}

interface CliOptions {
  path: string;
  merge: boolean;
}

function parseOptions(argv: string[]): CliOptions {
  let path = process.env.ARB_SECRET_STORE_PATH ?? 'data/secrets.enc.json';
  let merge = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (argv[index] === '--merge') {
      merge = true;
      continue;
    }
    if (argv[index] === '--path') {
      const value = argv[index + 1];
      if (!value) throw new Error('--path requires a value');
      path = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argv[index]}`);
  }
  return { path, merge };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const input = readFileSync(0, 'utf8');
  const parsed = JSON.parse(input) as unknown;
  if (!Array.isArray(parsed)) throw new Error('stdin must contain a JSON array of credentials');
  const incoming = parsed as StoredCredential[];
  let records = incoming;
  if (options.merge && existsSync(options.path)) {
    const existing = await loadEncryptedSecretStore(options.path, masterKey);
    records = mergeCredentialRecords(existing.values(), incoming);
  } else if (!options.merge && existsSync(options.path)) {
    console.error('replacing existing secret store; use --merge to keep existing records');
  }
  const summary = await createEncryptedSecretStore(options.path, masterKey, records);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
