import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RENAME_RETRY_DELAYS_MS = [0, 5, 10, 20, 40, 80] as const;

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function replaceFileWithRetry(temporary: string, destination: string): void {
  let lastError: unknown;
  for (const delay of RENAME_RETRY_DELAYS_MS) {
    sleepSync(delay);
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error)) throw error;
    }
  }
  throw lastError;
}

export interface RotationHeartbeat {
  version?: 1;
  role?: 'executor' | 'scanner';
  runId?: string;
  pid: number;
  startedAt?: number;
  updatedAt: number;
  state: 'running' | 'stopped';
  phase?: string;
  lastProgressAt?: number;
  openExecutions?: number;
  unresolvedOrders?: number;
  account?: {
    capturedAt: number;
    balances: Array<{
      venueId: string;
      asset: string;
      free: string;
      used: string;
      total: string;
      fetchedAt: number;
      ageMs: number;
    }>;
    unhedged: Array<{
      batchId: string;
      venueId: string;
      asset: string;
      amount: string;
      direction: string;
      createdAt: number;
    }>;
    recentExecutions: Array<{
      batchId: string;
      strategy: string;
      status: string;
      realizedProfit: string | null;
      openedAt: number;
      closedAt: number | null;
    }>;
  };
  lastWaitReasons?: string[];
  details?: Record<string, unknown>;
}

export function writeHeartbeat(path: string, heartbeat: RotationHeartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, 'utf8');
    replaceFileWithRetry(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readHeartbeat(path: string): RotationHeartbeat | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RotationHeartbeat>;
    if (
      !Number.isInteger(parsed.pid) ||
      !Number.isInteger(parsed.updatedAt) ||
      (parsed.state !== 'running' && parsed.state !== 'stopped')
    ) {
      return undefined;
    }
    return parsed as RotationHeartbeat;
  } catch {
    return undefined;
  }
}

export function heartbeatIsFresh(
  heartbeat: RotationHeartbeat | undefined,
  now: number,
  maxAgeMs: number,
  expected?: { pid?: number; runId?: string },
): boolean {
  if (!heartbeat || heartbeat.state !== 'running') return false;
  if (now - heartbeat.updatedAt > maxAgeMs || heartbeat.updatedAt > now + 5_000) return false;
  if (expected?.pid !== undefined && heartbeat.pid !== expected.pid) return false;
  if (expected?.runId !== undefined && heartbeat.runId !== expected.runId) return false;
  return true;
}
