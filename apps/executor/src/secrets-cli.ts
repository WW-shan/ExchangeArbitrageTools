import { readFileSync } from 'node:fs';
import { createEncryptedSecretStore, type StoredCredential } from './secret-store.js';

function usage(): string {
  return [
    'Usage: npm run executor:secrets -- [--path <file>]',
    '',
    'Reads a JSON array of credentials from stdin. Example record:',
    'Withdrawal records use role=withdrawal, withdrawalPermission=true,',
    'ipWhitelistVerified=true, and a separate API key from the trade key.',
    '{"venueId":"gateio","role":"trade","withdrawalPermission":false,"apiKey":"...","secret":"..."}',
    'Hotcoin records additionally require the API passphrase in "password":',
    '{"venueId":"hotcoin","role":"trade","withdrawalPermission":false,"apiKey":"...","secret":"...","password":"..."}',
    '',
    'Set the master key in ARB_SECRET_STORE_KEY (at least 16 characters). The',
    'command prints fingerprints only; it never prints API keys or secrets.',
  ].join('\n');
}

function parsePath(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (argv[index] === '--path') {
      const value = argv[index + 1];
      if (!value) throw new Error('--path requires a value');
      return value;
    }
  }
  return process.env.ARB_SECRET_STORE_PATH ?? 'data/secrets.enc.json';
}

async function main(): Promise<void> {
  const path = parsePath(process.argv.slice(2));
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const input = readFileSync(0, 'utf8');
  const parsed = JSON.parse(input) as unknown;
  if (!Array.isArray(parsed)) throw new Error('stdin must contain a JSON array of credentials');
  const summary = await createEncryptedSecretStore(path, masterKey, parsed as StoredCredential[]);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
