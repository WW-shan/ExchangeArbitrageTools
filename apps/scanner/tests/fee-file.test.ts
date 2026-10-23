import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@arb/core';
import { mergeAccountFeeFile } from '../src/fee-file.js';

describe('mergeAccountFeeFile', () => {
  it('returns the base overrides when the file is absent', () => {
    const base = { gateio: { takerBps: new Decimal(10) } };
    expect(mergeAccountFeeFile(base, undefined)).toBe(base);
    expect(mergeAccountFeeFile(base, 'data/does-not-exist.json')).toBe(base);
  });

  it('merges per-symbol account fees and marks the source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-fee-file-'));
    const path = join(directory, 'fees.json');
    try {
      writeFileSync(
        path,
        JSON.stringify({
          gateio: { 'BTC/USDT': { takerBps: '7.5', makerBps: '1.5' } },
          mexc: { 'ETH/USDT': { takerBps: 0 } },
        }),
      );
      const merged = mergeAccountFeeFile({ weex: { takerBps: new Decimal(10) } }, path);
      expect(merged.gateio?.source).toBe('account');
      expect(merged.gateio?.symbols?.['BTC/USDT']?.takerBps?.toFixed()).toBe('7.5');
      expect(merged.gateio?.symbols?.['BTC/USDT']?.makerBps?.toFixed()).toBe('1.5');
      expect(merged.mexc?.symbols?.['ETH/USDT']?.takerBps?.toFixed()).toBe('0');
      expect(merged.weex?.takerBps?.toFixed()).toBe('10');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
