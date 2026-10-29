import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
  lastWaitReasons?: string[];
  details?: Record<string, unknown>;
}

export function writeHeartbeat(path: string, heartbeat: RotationHeartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(heartbeat)}\n`, 'utf8');
    renameSync(temporary, path);
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
