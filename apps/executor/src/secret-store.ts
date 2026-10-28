import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApiCredentials } from '@arb/venues-cex';

export type CredentialRole = 'read_only' | 'trade' | 'withdrawal';

export interface StoredCredential extends ApiCredentials {
  venueId: string;
  role: CredentialRole;
  withdrawalPermission: boolean;
  ipWhitelistVerified?: boolean;
}

export interface SecretStoreCreateOptions {
  scryptN?: number;
  scryptR?: number;
  scryptP?: number;
}

export interface SecretStoreSummary {
  path: string;
  fingerprints: Record<string, string>;
}

export function credentialKey(record: Pick<StoredCredential, 'venueId' | 'role'>): string {
  return `${record.venueId}:${record.role}`;
}

interface SecretStoreEnvelope {
  version: 1;
  kdf: 'scrypt';
  salt: string;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface SecretStorePayload {
  records: StoredCredential[];
}

const VERSION = 1;
const AAD = Buffer.from('arb-secret-store:v1', 'utf8');
const MIN_MASTER_KEY_LENGTH = 16;
const DEFAULT_SCRYPT_N = 2 ** 15;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

function validateMasterKey(masterKey: string): void {
  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(`secret store master key must be at least ${MIN_MASTER_KEY_LENGTH} characters`);
  }
}

function validateCredential(record: StoredCredential): void {
  if (!record.venueId.trim()) throw new Error('credential venueId is required');
  if (!record.apiKey.trim() || !record.secret.trim()) {
    throw new Error(`credential for ${record.venueId} is incomplete`);
  }
  if (record.role !== 'read_only' && record.role !== 'trade' && record.role !== 'withdrawal') {
    throw new Error(`credential for ${record.venueId} has an invalid role`);
  }
  if (record.role === 'withdrawal') {
    if (record.withdrawalPermission !== true) {
      throw new Error(
        `withdrawal credential for ${record.venueId} must declare withdrawalPermission=true`,
      );
    }
    if (record.ipWhitelistVerified !== true) {
      throw new Error(
        `withdrawal credential for ${record.venueId} requires ipWhitelistVerified=true`,
      );
    }
  } else if (record.withdrawalPermission !== false) {
    throw new Error(
      `${record.role} credential for ${record.venueId} must declare withdrawalPermission=false`,
    );
  }
}

function validateRecords(records: StoredCredential[]): StoredCredential[] {
  if (records.length === 0) throw new Error('at least one credential is required');
  const seen = new Set<string>();
  const validated = records.map((record) => {
    validateCredential(record);
    const venueId = record.venueId.trim();
    const key = credentialKey({ venueId, role: record.role });
    if (seen.has(key)) throw new Error(`duplicate ${record.role} credential for ${venueId}`);
    seen.add(key);
    return {
      ...record,
      venueId,
      role: record.role,
      withdrawalPermission: record.role === 'withdrawal',
    };
  });

  const keysByVenue = new Map<string, StoredCredential[]>();
  for (const record of validated) {
    const key = `${record.venueId}\u0000${record.apiKey}`;
    const existing = keysByVenue.get(key) ?? [];
    existing.push(record);
    keysByVenue.set(key, existing);
  }
  for (const owners of keysByVenue.values()) {
    if (owners.length < 2) continue;
    if (owners.some((record) => record.role === 'withdrawal')) {
      const venueId = owners[0]!.venueId;
      throw new Error(`withdrawal credential for ${venueId} must use a different API key`);
    }
  }
  return validated;
}

function deriveKey(
  masterKey: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(masterKey, salt, KEY_BYTES, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function envelopeNumbers(envelope: SecretStoreEnvelope): {
  n: number;
  r: number;
  p: number;
} {
  const values = [envelope.scryptN, envelope.scryptR, envelope.scryptP];
  if (
    envelope.version !== VERSION ||
    envelope.kdf !== 'scrypt' ||
    !values.every((value) => Number.isInteger(value) && value > 0) ||
    envelope.scryptN < 2 ** 14 ||
    envelope.scryptN !== 2 ** Math.round(Math.log2(envelope.scryptN))
  ) {
    throw new Error('unsupported secret store format');
  }
  return { n: envelope.scryptN, r: envelope.scryptR, p: envelope.scryptP };
}

function decodeField(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('secret store field is missing');
  }
  const decoded = Buffer.from(value, 'base64');
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error('secret store field has an invalid length');
  }
  return decoded;
}

function parseEnvelope(raw: string): SecretStoreEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('secret store is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('secret store envelope is invalid');
  }
  const envelope = parsed as SecretStoreEnvelope;
  envelopeNumbers(envelope);
  decodeField(envelope.salt, SALT_BYTES);
  decodeField(envelope.iv, IV_BYTES);
  decodeField(envelope.authTag, AUTH_TAG_BYTES);
  decodeField(envelope.ciphertext);
  return envelope;
}

export function credentialFingerprint(record: Pick<StoredCredential, 'apiKey'>): string {
  return `sha256:${createHash('sha256').update(record.apiKey, 'utf8').digest('hex').slice(0, 16)}`;
}

export function credentialFingerprints(records: StoredCredential[]): Record<string, string> {
  return Object.fromEntries(
    records.map((record) => [credentialKey(record), credentialFingerprint(record)]),
  );
}

export function mergeCredentialRecords(
  existing: Iterable<StoredCredential>,
  incoming: StoredCredential[],
): StoredCredential[] {
  const merged = new Map<string, StoredCredential>();
  for (const record of existing) merged.set(credentialKey(record), record);

  const seen = new Set<string>();
  for (const record of incoming) {
    const key = credentialKey(record);
    if (seen.has(key)) {
      throw new Error(`duplicate ${record.role} credential for ${record.venueId}`);
    }
    seen.add(key);
    merged.set(key, record);
  }
  return [...merged.values()];
}

export async function createEncryptedSecretStore(
  path: string,
  masterKey: string,
  records: StoredCredential[],
  options: SecretStoreCreateOptions = {},
): Promise<SecretStoreSummary> {
  validateMasterKey(masterKey);
  const validated = validateRecords(records);
  const n = options.scryptN ?? DEFAULT_SCRYPT_N;
  const r = options.scryptR ?? DEFAULT_SCRYPT_R;
  const p = options.scryptP ?? DEFAULT_SCRYPT_P;
  if (!Number.isInteger(n) || n < 2 ** 14 || n !== 2 ** Math.round(Math.log2(n))) {
    throw new Error('scryptN must be a power of two of at least 16384');
  }
  if (!Number.isInteger(r) || r <= 0 || !Number.isInteger(p) || p <= 0) {
    throw new Error('scrypt parameters must be positive integers');
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(masterKey, salt, n, r, p);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(
    JSON.stringify({ records: validated } satisfies SecretStorePayload),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: SecretStoreEnvelope = {
    version: VERSION,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    scryptN: n,
    scryptR: r,
    scryptP: p,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
  return { path, fingerprints: credentialFingerprints(validated) };
}

export async function loadEncryptedSecretStore(
  path: string,
  masterKey: string,
): Promise<ReadonlyMap<string, StoredCredential>> {
  validateMasterKey(masterKey);
  const envelope = parseEnvelope(await readFile(path, 'utf8'));
  const { n, r, p } = envelopeNumbers(envelope);
  const salt = decodeField(envelope.salt, SALT_BYTES);
  const iv = decodeField(envelope.iv, IV_BYTES);
  const authTag = decodeField(envelope.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeField(envelope.ciphertext);
  const key = await deriveKey(masterKey, salt, n, r, p);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(authTag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('secret store authentication failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('secret store payload is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('secret store payload is invalid');
  }
  const payload = parsed as SecretStorePayload;
  if (!Array.isArray(payload.records)) throw new Error('secret store payload is invalid');
  const records = validateRecords(payload.records);
  return new Map(records.map((record) => [credentialKey(record), record]));
}
