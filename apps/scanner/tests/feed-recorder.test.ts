import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal, type OrderBookSnapshot } from '@arb/core';
import { FeedRecorder } from '../src/feed-recorder.js';

function snapshot(venueId: string, at: number): OrderBookSnapshot {
  return {
    venueId,
    exchangeSymbol: 'CAKE/USDT',
    fetchedAt: at,
    receivedAt: at,
    exchangeTimestamp: at - 10,
    sequence: 42,
    asks: [{ price: new Decimal('2.5'), amount: new Decimal('100') }],
    bids: [{ price: new Decimal('2.49'), amount: new Decimal('100') }],
    source: 'websocket',
  };
}

describe('FeedRecorder', () => {
  it('writes normalized JSONL snapshots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'feed-recorder-'));
    try {
      const recorder = new FeedRecorder({
        directory,
        clock: () => 1_700_000_000_000,
        flushEvery: 1,
      });
      recorder.record(snapshot('gateio', 1_700_000_000_000));
      recorder.record(snapshot('mexc', 1_700_000_000_500));
      recorder.close();
      const lines = readFileSync(recorder.path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(first.venueId).toBe('gateio');
      expect(first.asks).toEqual([['2.5', '100']]);
      expect(first.receivedAt).toBe(1_700_000_000_000);
      expect(first.sequence).toBe(42);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
