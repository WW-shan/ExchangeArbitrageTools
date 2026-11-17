import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal, type MarketMetadata } from '@arb/core';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFeeOverride, mergeAccountFeeFile } from '../src/index.js';

const directories: string[] = [];

function market(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    venueId: 'hotcoin',
    exchangeSymbol: 'cake_usdt',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 3,
    amountPrecision: 2,
    ...overrides,
  };
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('venue fee overrides', () => {
  it('applies venue-level and symbol-level fees with provenance', () => {
    const effective = applyFeeOverride(market(), {
      hotcoin: { takerBps: new Decimal(10), makerBps: new Decimal(2), source: 'config' },
    });
    expect(effective.feeTakerBps?.toFixed()).toBe('10');
    expect(effective.makerFeeBps?.toFixed()).toBe('2');
    expect(effective.feeProvenance).toBe('config');

    const symbolEffective = applyFeeOverride(market(), {
      hotcoin: {
        takerBps: new Decimal(10),
        symbols: { cake_usdt: { takerBps: new Decimal(4), makerBps: new Decimal(-1) } },
        source: 'account',
      },
    });
    expect(symbolEffective.feeTakerBps?.toFixed()).toBe('4');
    expect(symbolEffective.makerFeeBps?.toFixed()).toBe('-1');
    expect(symbolEffective.feeProvenance).toBe('account');
  });

  it('applies the rebate to gross venue and account fees', () => {
    const gateway = applyFeeOverride(market(), {
      hotcoin: {
        takerBps: new Decimal(20),
        makerBps: new Decimal(20),
        rebatePct: new Decimal(80),
        source: 'config',
      },
    });
    expect(gateway.feeTakerBps?.toFixed()).toBe('4');
    expect(gateway.makerFeeBps?.toFixed()).toBe('4');

    const account = applyFeeOverride(market(), {
      hotcoin: {
        takerBps: new Decimal(20),
        symbols: { cake_usdt: { takerBps: new Decimal(20), makerBps: new Decimal(20) } },
        rebatePct: new Decimal(80),
        source: 'account',
      },
    });
    expect(account.feeTakerBps?.toFixed()).toBe('4');
    expect(account.makerFeeBps?.toFixed()).toBe('4');
  });

  it('fails closed for an invalid rebate percentage', () => {
    expect(() =>
      applyFeeOverride(market(), {
        hotcoin: { takerBps: new Decimal(20), rebatePct: new Decimal(101) },
      }),
    ).toThrow('between 0 and 100');
  });

  it('merges account fee files and preserves configured values for other symbols', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-fee-overrides-'));
    directories.push(directory);
    const path = join(directory, 'fees.json');
    writeFileSync(
      path,
      JSON.stringify({
        gateio: {
          CAKE_USDT: { takerBps: '7', makerBps: '1' },
        },
      }),
    );
    const merged = mergeAccountFeeFile(
      {
        gateio: { takerBps: new Decimal(10), rebatePct: new Decimal(70), source: 'config' },
        hotcoin: { takerBps: new Decimal(12), source: 'config' },
      },
      path,
    );
    expect(merged.gateio?.source).toBe('account');
    expect(merged.gateio?.takerBps?.toFixed()).toBe('10');
    expect(merged.gateio?.rebatePct?.toFixed()).toBe('70');
    expect(merged.gateio?.symbols?.CAKE_USDT?.takerBps?.toFixed()).toBe('7');
    expect(merged.hotcoin?.takerBps?.toFixed()).toBe('12');
  });

  it('returns the original override object when the fee file is absent', () => {
    const base = { hotcoin: { takerBps: new Decimal(12) } };
    expect(mergeAccountFeeFile(base, 'missing-fees.json')).toBe(base);
  });

  it.each([
    { account: { takerBps: '10' }, taker: '5', maker: '1' },
    { account: { makerBps: '6' }, taker: '2', maker: '3' },
    { account: { takerBps: '0' }, taker: '0', maker: '1' },
    { account: { makerBps: '-1' }, taker: '2', maker: '-0.5' },
  ])('preserves missing symbol fees when merging $account', ({ account, taker, maker }) => {
    const directory = mkdtempSync(join(tmpdir(), 'arb-fee-overrides-'));
    directories.push(directory);
    const path = join(directory, 'fees.json');
    writeFileSync(path, JSON.stringify({ hotcoin: { cake_usdt: account } }));
    const base = {
      hotcoin: {
        takerBps: new Decimal(20),
        makerBps: new Decimal(20),
        rebatePct: new Decimal(50),
        symbols: { cake_usdt: { takerBps: new Decimal(4), makerBps: new Decimal(2) } },
      },
    };

    const merged = mergeAccountFeeFile(base, path);
    const effective = applyFeeOverride(market(), merged);

    expect(effective.feeTakerBps?.toFixed()).toBe(taker);
    expect(effective.makerFeeBps?.toFixed()).toBe(maker);
    expect(effective.feeProvenance).toBe('account');
    expect(base.hotcoin.symbols.cake_usdt.takerBps.toFixed()).toBe('4');
    expect(base.hotcoin.symbols.cake_usdt.makerBps.toFixed()).toBe('2');
  });
});
