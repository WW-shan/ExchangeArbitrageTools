import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEncryptedSecretStore,
  credentialFingerprint,
  filterFilledCredentials,
  filterWithdrawalCredentials,
  loadEncryptedSecretStore,
  mergeCredentialRecords,
  type StoredCredential,
} from '../src/secret-store.js';

const directories: string[] = [];

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'arb-secrets-'));
  directories.push(directory);
  return join(directory, 'secrets.enc.json');
}

const records: StoredCredential[] = [
  {
    venueId: 'gateio',
    role: 'trade',
    withdrawalPermission: false,
    apiKey: 'gate-api-key-plain',
    secret: 'gate-secret-plain',
  },
  {
    venueId: 'mexc',
    role: 'read_only',
    withdrawalPermission: false,
    ipWhitelistVerified: true,
    apiKey: 'mexc-api-key-plain',
    secret: 'mexc-secret-plain',
  },
];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('encrypted local secret store', () => {
  it('round-trips credentials without writing plaintext and exposes only fingerprints', async () => {
    const path = tempPath();
    const summary = await createEncryptedSecretStore(
      path,
      'correct horse battery staple',
      records,
      {
        scryptN: 2 ** 14,
      },
    );
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('gate-api-key-plain');
    expect(raw).not.toContain('gate-secret-plain');
    expect(summary.fingerprints['gateio:trade']).toBe(credentialFingerprint(records[0]!));
    expect(summary.fingerprints['gateio:trade']).not.toContain('gate-api-key-plain');

    const loaded = await loadEncryptedSecretStore(path, 'correct horse battery staple');
    expect(loaded.get('gateio:trade')).toMatchObject({
      role: 'trade',
      withdrawalPermission: false,
      apiKey: 'gate-api-key-plain',
    });
    expect(loaded.get('mexc:read_only')?.ipWhitelistVerified).toBe(true);
  });

  it('stores read-only and trade credentials for the same venue side by side', async () => {
    const path = tempPath();
    const dualRole: StoredCredential[] = [
      {
        venueId: 'gateio',
        role: 'read_only',
        withdrawalPermission: false,
        apiKey: 'gate-read-key',
        secret: 'gate-read-secret',
      },
      {
        venueId: 'gateio',
        role: 'trade',
        withdrawalPermission: false,
        apiKey: 'gate-trade-key',
        secret: 'gate-trade-secret',
      },
    ];
    const summary = await createEncryptedSecretStore(
      path,
      'correct horse battery staple',
      dualRole,
      { scryptN: 2 ** 14 },
    );
    expect(Object.keys(summary.fingerprints).sort()).toEqual(['gateio:read_only', 'gateio:trade']);
    const loaded = await loadEncryptedSecretStore(path, 'correct horse battery staple');
    expect(loaded.get('gateio:read_only')?.apiKey).toBe('gate-read-key');
    expect(loaded.get('gateio:trade')?.apiKey).toBe('gate-trade-key');
  });

  it('rejects duplicate trade credentials for the same venue', async () => {
    const path = tempPath();
    await expect(
      createEncryptedSecretStore(
        path,
        'correct horse battery staple',
        [
          records[0]!,
          {
            venueId: 'gateio',
            role: 'trade',
            withdrawalPermission: false,
            apiKey: 'gate-second-key',
            secret: 'gate-second-secret',
          },
        ],
        { scryptN: 2 ** 14 },
      ),
    ).rejects.toThrow('duplicate trade credential for gateio');
  });

  it('merges incoming credentials without dropping existing venue roles', () => {
    const incoming: StoredCredential[] = [
      {
        venueId: 'hotcoin',
        role: 'read_only',
        withdrawalPermission: false,
        apiKey: 'hotcoin-read-key',
        secret: 'hotcoin-read-secret',
        password: 'hotcoin-passphrase',
      },
    ];
    const merged = mergeCredentialRecords(records, incoming);
    expect(merged.map((record) => `${record.venueId}:${record.role}`).sort()).toEqual([
      'gateio:trade',
      'hotcoin:read_only',
      'mexc:read_only',
    ]);
  });

  it('rejects duplicate venue roles inside a merge input', () => {
    expect(() => mergeCredentialRecords([], [records[0]!, records[0]!])).toThrow(
      'duplicate trade credential for gateio',
    );
  });

  it('filters blank template records before import', () => {
    const blank: StoredCredential = {
      venueId: 'gateio',
      role: 'read_only',
      withdrawalPermission: false,
      apiKey: '',
      secret: '',
    };
    expect(filterFilledCredentials([blank, records[0]!])).toEqual([records[0]]);
  });

  it('filters withdrawal credentials for non-withdrawal imports', () => {
    const withdrawal: StoredCredential = {
      venueId: 'gateio',
      role: 'withdrawal',
      withdrawalPermission: true,
      ipWhitelistVerified: true,
      apiKey: 'gate-withdraw-key',
      secret: 'gate-withdraw-secret',
    };
    expect(filterWithdrawalCredentials([records[0]!, withdrawal])).toEqual([records[0]]);
  });

  it('rejects an explicitly empty passphrase', async () => {
    const path = tempPath();
    await expect(
      createEncryptedSecretStore(
        path,
        'correct horse battery staple',
        [{ ...records[0]!, password: '' }],
        { scryptN: 2 ** 14 },
      ),
    ).rejects.toThrow('empty password');
  });

  it('fails closed on a wrong master key or tampered ciphertext', async () => {
    const path = tempPath();
    await createEncryptedSecretStore(path, 'correct horse battery staple', records, {
      scryptN: 2 ** 14,
    });
    await expect(loadEncryptedSecretStore(path, 'wrong master key material')).rejects.toThrow(
      'authentication failed',
    );

    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { ciphertext: string };
    const tampered = Buffer.from(envelope.ciphertext, 'base64');
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    envelope.ciphertext = tampered.toString('base64');
    const tamperedPath = `${path}.tampered`;
    const fs = await import('node:fs/promises');
    await fs.writeFile(tamperedPath, JSON.stringify(envelope));
    await expect(
      loadEncryptedSecretStore(tamperedPath, 'correct horse battery staple'),
    ).rejects.toThrow('authentication failed');
  });

  it('rejects withdrawal-enabled or malformed credentials', async () => {
    const path = tempPath();
    await expect(
      createEncryptedSecretStore(
        path,
        'correct horse battery staple',
        [{ ...records[0]!, withdrawalPermission: true as false }],
        { scryptN: 2 ** 14 },
      ),
    ).rejects.toThrow('withdrawalPermission=false');
    await expect(
      createEncryptedSecretStore(path, 'short', records, { scryptN: 2 ** 14 }),
    ).rejects.toThrow('at least 16 characters');
  });
});
