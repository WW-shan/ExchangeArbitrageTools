import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEncryptedSecretStore,
  loadEncryptedSecretStore,
  type StoredCredential,
} from '../src/secret-store.js';

const masterKey = 'correct horse battery staple';

function tempPath(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'arb-withdrawal-secrets-'));
  return {
    path: join(directory, 'secrets.enc.json'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('withdrawal credential isolation', () => {
  it('accepts a separate withdrawal key with explicit IP attestation', async () => {
    const { path, cleanup } = tempPath();
    try {
      const records: StoredCredential[] = [
        {
          venueId: 'gateio',
          role: 'trade',
          withdrawalPermission: false,
          apiKey: 'gate-trade-key',
          secret: 'gate-trade-secret',
        },
        {
          venueId: 'gateio',
          role: 'withdrawal',
          withdrawalPermission: true,
          ipWhitelistVerified: true,
          apiKey: 'gate-withdraw-key',
          secret: 'gate-withdraw-secret',
        },
      ];
      await createEncryptedSecretStore(path, masterKey, records, { scryptN: 2 ** 14 });
      const loaded = await loadEncryptedSecretStore(path, masterKey);
      expect(loaded.get('gateio:withdrawal')).toMatchObject({
        role: 'withdrawal',
        withdrawalPermission: true,
        ipWhitelistVerified: true,
      });
      expect(loaded.get('gateio:trade')?.withdrawalPermission).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('rejects a withdrawal key without IP attestation', async () => {
    const { path, cleanup } = tempPath();
    try {
      await expect(
        createEncryptedSecretStore(
          path,
          masterKey,
          [
            {
              venueId: 'hotcoin',
              role: 'withdrawal',
              withdrawalPermission: true,
              apiKey: 'hotcoin-withdraw-key',
              secret: 'secret',
              password: 'passphrase',
            },
          ],
          { scryptN: 2 ** 14 },
        ),
      ).rejects.toThrow('ipWhitelistVerified=true');
    } finally {
      cleanup();
    }
  });

  it('rejects reusing a trade key as the withdrawal key', async () => {
    const { path, cleanup } = tempPath();
    try {
      await expect(
        createEncryptedSecretStore(
          path,
          masterKey,
          [
            {
              venueId: 'gateio',
              role: 'trade',
              withdrawalPermission: false,
              apiKey: 'same-key',
              secret: 'trade-secret',
            },
            {
              venueId: 'gateio',
              role: 'withdrawal',
              withdrawalPermission: true,
              ipWhitelistVerified: true,
              apiKey: 'same-key',
              secret: 'withdraw-secret',
            },
          ],
          { scryptN: 2 ** 14 },
        ),
      ).rejects.toThrow('different API key');
    } finally {
      cleanup();
    }
  });
});
