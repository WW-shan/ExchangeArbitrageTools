import { existsSync, readFileSync } from 'node:fs';
import {
  createEncryptedSecretStore,
  filterFilledCredentials,
  filterWithdrawalCredentials,
  loadEncryptedSecretStore,
  mergeCredentialRecords,
  type StoredCredential,
} from './secret-store.js';

function usage(): string {
  return [
    'Usage: npm run executor:secrets -- [--path <file>] [--merge | --replace] [--skip-empty] [--skip-withdrawal]',
    '',
    'Reads a JSON array of credentials from stdin. Example record:',
    'Withdrawal records use role=withdrawal, withdrawalPermission=true,',
    'ipWhitelistVerified=true, and may reuse the trade API key.',
    '{"venueId":"gateio","role":"trade","withdrawalPermission":false,"apiKey":"...","secret":"..."}',
    'Hotcoin records additionally require the API passphrase in "password":',
    '{"venueId":"hotcoin","role":"trade","withdrawalPermission":false,"apiKey":"...","secret":"...","password":"..."}',
    'Use --merge to load the existing store and upsert records by venueId:role.',
    'Use --replace to intentionally overwrite an existing store.',
    'Use --skip-empty to ignore template records with blank apiKey or secret.',
    'Use --skip-withdrawal to import read-only/trade records only.',
    '',
    'Set the master key in ARB_SECRET_STORE_KEY (at least 16 characters). The',
    'command prints fingerprints only; it never prints API keys or secrets.',
  ].join('\n');
}

interface CliOptions {
  path: string;
  merge: boolean;
  replace: boolean;
  skipEmpty: boolean;
  skipWithdrawal: boolean;
}

function parseOptions(argv: string[]): CliOptions {
  let path = process.env.ARB_SECRET_STORE_PATH ?? 'data/secrets.enc.json';
  let merge = false;
  let replace = false;
  let skipEmpty = false;
  let skipWithdrawal = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (argv[index] === '--merge') {
      merge = true;
      continue;
    }
    if (argv[index] === '--replace') {
      replace = true;
      continue;
    }
    if (argv[index] === '--skip-empty') {
      skipEmpty = true;
      continue;
    }
    if (argv[index] === '--skip-withdrawal') {
      skipWithdrawal = true;
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
  if (merge && replace) throw new Error('--merge and --replace are mutually exclusive');
  return { path, merge, replace, skipEmpty, skipWithdrawal };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const input = readFileSync(0, 'utf8');
  const parsed = JSON.parse(input) as unknown;
  if (!Array.isArray(parsed)) throw new Error('stdin must contain a JSON array of credentials');
  let incoming = parsed as StoredCredential[];
  if (options.skipEmpty) {
    const before = incoming.length;
    incoming = filterFilledCredentials(incoming);
    const skipped = before - incoming.length;
    if (skipped > 0) console.error(`skipped ${skipped} empty credential record(s)`);
    if (incoming.length === 0) throw new Error('no filled credentials found');
  }
  if (options.skipWithdrawal) {
    const before = incoming.length;
    incoming = filterWithdrawalCredentials(incoming);
    const skipped = before - incoming.length;
    if (skipped > 0) console.error(`skipped ${skipped} withdrawal credential record(s)`);
    if (incoming.length === 0) throw new Error('no non-withdrawal credentials found');
  }
  let records = incoming;
  if (options.merge && existsSync(options.path)) {
    const existing = await loadEncryptedSecretStore(options.path, masterKey);
    records = mergeCredentialRecords(existing.values(), incoming);
  } else if (!options.merge && existsSync(options.path)) {
    if (!options.replace) {
      throw new Error(
        'secret store already exists; use --merge to update it or --replace to overwrite it',
      );
    }
    console.error('replacing existing secret store because --replace was provided');
  }
  const summary = await createEncryptedSecretStore(options.path, masterKey, records);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
