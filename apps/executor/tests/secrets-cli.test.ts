import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEncryptedSecretStore,
  loadEncryptedSecretStore,
  type StoredCredential,
} from '../src/secret-store.js';

const directories: string[] = [];
const masterKey = 'correct horse battery staple';

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'arb-secrets-cli-'));
  directories.push(directory);
  return join(directory, 'secrets.enc.json');
}

function runCli(
  path: string,
  args: string[],
  input: StoredCredential[],
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
      join(process.cwd(), 'apps/executor/src/secrets-cli.ts'),
      '--path',
      path,
      ...args,
    ],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ARB_SECRET_STORE_KEY: masterKey },
      timeout: 30_000,
    },
  );
}

const existing: StoredCredential = {
  venueId: 'gateio',
  role: 'trade',
  withdrawalPermission: false,
  apiKey: 'gate-api-key',
  secret: 'gate-secret',
};

const incoming: StoredCredential = {
  venueId: 'bitget',
  role: 'trade',
  withdrawalPermission: false,
  apiKey: 'bitget-api-key',
  secret: 'bitget-secret',
  password: 'bitget-passphrase',
};

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('secrets CLI write safety', () => {
  it('refuses to replace an existing store without --merge or --replace', async () => {
    const path = tempPath();
    await createEncryptedSecretStore(path, masterKey, [existing], { scryptN: 2 ** 14 });

    const result = runCli(path, [], [incoming]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('secret store already exists');
    const loaded = await loadEncryptedSecretStore(path, masterKey);
    expect([...loaded.keys()]).toEqual(['gateio:trade']);
  });

  it('merges into an existing store when --merge is explicit', async () => {
    const path = tempPath();
    await createEncryptedSecretStore(path, masterKey, [existing], { scryptN: 2 ** 14 });

    const result = runCli(path, ['--merge'], [incoming]);

    expect(result.status).toBe(0);
    const loaded = await loadEncryptedSecretStore(path, masterKey);
    expect([...loaded.keys()].sort()).toEqual(['bitget:trade', 'gateio:trade']);
  });
});
