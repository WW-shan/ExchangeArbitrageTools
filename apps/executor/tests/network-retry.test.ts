import { describe, expect, it } from 'vitest';
import {
  isTransientNetworkError,
  retryOpenOrderResult,
  retryTransient,
} from '../src/network-retry.js';

describe('read-only network retry', () => {
  it('retries transient TLS disconnects and then succeeds', async () => {
    let calls = 0;
    const value = await retryTransient(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error(
            'Client network socket disconnected before secure TLS connection was established',
          );
        }
        return 'ok';
      },
      { attempts: 3, delayMs: 1 },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient application error', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls += 1;
          throw new Error('invalid api key');
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).rejects.toThrow('invalid api key');
    expect(calls).toBe(1);
  });

  it('retries transient errors returned by the open-order result', async () => {
    let calls = 0;
    const result = await retryOpenOrderResult(
      async () => {
        calls += 1;
        return calls === 1
          ? { errors: ['open_orders_fetch_failed:ETIMEDOUT'], orders: [] }
          : { errors: [], orders: [] };
      },
      { attempts: 3, delayMs: 1 },
    );
    expect(result.errors).toEqual([]);
    expect(calls).toBe(2);
  });

  it('classifies the known proxy failure text', () => {
    expect(isTransientNetworkError('fetch failed: socket hang up')).toBe(true);
    expect(isTransientNetworkError('invalid api key')).toBe(false);
  });
});
