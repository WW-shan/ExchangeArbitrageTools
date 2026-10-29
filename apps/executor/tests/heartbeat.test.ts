import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { heartbeatIsFresh, readHeartbeat, writeHeartbeat } from '@arb/storage';

describe('rotation heartbeat', () => {
  it('writes the process state for the watchdog', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-heartbeat-'));
    try {
      const path = join(directory, 'nested', 'heartbeat.json');
      writeHeartbeat(path, {
        pid: 1234,
        updatedAt: 1_700_000_000_000,
        state: 'running',
        openExecutions: 0,
        unresolvedOrders: 0,
        lastWaitReasons: ['no_valid_opportunity'],
      });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        pid: 1234,
        updatedAt: 1_700_000_000_000,
        state: 'running',
        openExecutions: 0,
        unresolvedOrders: 0,
        lastWaitReasons: ['no_valid_opportunity'],
      });
      expect(readHeartbeat(path)).toMatchObject({ pid: 1234, state: 'running' });
      expect(heartbeatIsFresh(readHeartbeat(path), 1_700_000_000_010, 30_000)).toBe(true);
      expect(heartbeatIsFresh(readHeartbeat(path), 1_700_000_040_000, 30_000)).toBe(false);
      expect(heartbeatIsFresh(readHeartbeat(path), 1_700_000_000_010, 30_000, { pid: 9999 })).toBe(
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
