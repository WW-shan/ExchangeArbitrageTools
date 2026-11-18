import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/money.js';
import type { CurrencyMetadata } from '../src/types.js';
import { assessTransferability } from '../src/transferability.js';

const WARD = '0x174a0de0fa1c4771ca980a42553c0041016e5a67';
const BREV = '0x0000000000000000000000000000000000000abc';

function currency(
  venueId: string,
  code: string,
  networks: {
    network: string;
    address?: string;
    withdrawEnabled: boolean;
    depositEnabled: boolean;
    withdrawFee?: string;
    minWithdrawAmount?: string;
  }[],
): CurrencyMetadata {
  return {
    venueId,
    code,
    networks: networks.map((row) => ({
      network: row.network,
      nativeName: row.network,
      ...(row.address ? { address: row.address } : {}),
      withdrawEnabled: row.withdrawEnabled,
      depositEnabled: row.depositEnabled,
      ...(row.withdrawFee ? { withdrawFee: new Decimal(row.withdrawFee) } : {}),
      ...(row.minWithdrawAmount ? { minWithdrawAmount: new Decimal(row.minWithdrawAmount) } : {}),
      canArriveQuickly: false,
    })),
  };
}

describe('assessTransferability', () => {
  it('accepts an asset that can move both ways on the same chain and address', () => {
    const result = assessTransferability({
      symbol: 'WARD',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'WARD', [
        { network: 'BASEEVM', address: WARD, withdrawEnabled: true, depositEnabled: true, withdrawFee: '58.24' },
      ])],
      right: [currency('bitget', 'WARD', [
        { network: 'BASE', address: WARD.toUpperCase().replace('0X', '0x'), withdrawEnabled: true, depositEnabled: true },
      ])],
    });
    expect(result.verdict).toBe('transferable');
    expect(result.routes).toHaveLength(2);
    expect(result.routes[0]?.chain).toBe('base');
    expect(result.routes[0]?.withdrawFee).toBe('58.24');
  });

  it('blocks BREV: shared chain but Bitget withdrawals are suspended', () => {
    // The measured trap. Gate can withdraw on ERC20 and BSC; Bitget lists
    // ERC20 with deposit enabled but withdrawal disabled.
    const result = assessTransferability({
      symbol: 'BREV',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'BREV', [
        { network: 'ERC20', address: BREV, withdrawEnabled: true, depositEnabled: true },
        { network: 'BSC', address: BREV, withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [currency('bitget', 'BREV', [
        { network: 'ERC20', address: BREV, withdrawEnabled: false, depositEnabled: true },
      ])],
    });
    expect(result.verdict).toBe('one-way');
    expect(result.reasons).toContain('cannot_return_from_right');
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]?.from).toBe('gateio');
  });

  it('blocks assets with no shared chain even when tickers match', () => {
    const result = assessTransferability({
      symbol: 'CRO',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'CRO', [
        { network: 'ERC20', address: BREV, withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [currency('bitget', 'CRO', [
        { network: 'CRONOS', address: BREV, withdrawEnabled: true, depositEnabled: true },
      ])],
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasons).toContain('no_shared_chain');
  });

  it('rejects same chain with different contract addresses', () => {
    const result = assessTransferability({
      symbol: 'RAIN',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'RAIN', [
        { network: 'ERC20', address: BREV, withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [currency('bitget', 'RAIN', [
        { network: 'ERC20', address: WARD, withdrawEnabled: true, depositEnabled: true },
      ])],
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasons).toContain('no_shared_chain');
  });

  it('reports unknown when one venue does not list the asset', () => {
    const result = assessTransferability({
      symbol: 'TBK',
      leftVenue: 'gateio',
      rightVenue: 'hotcoin',
      left: [currency('gateio', 'TBK', [
        { network: 'ERC20', address: BREV, withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [],
    });
    expect(result.verdict).toBe('unknown');
    expect(result.reasons).toContain('hotcoin_does_not_list_asset');
  });

  it('keeps native coins matchable by chain alone', () => {
    const result = assessTransferability({
      symbol: 'ETH',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'ETH', [
        { network: 'ERC20', withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [currency('bitget', 'ETH', [
        { network: 'ETH', withdrawEnabled: true, depositEnabled: true },
      ])],
    });
    expect(result.verdict).toBe('transferable');
    expect(result.routes).toHaveLength(2);
  });

  it('rejects a chain that only one venue supports', () => {
    const result = assessTransferability({
      symbol: 'KAT',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'KAT', [
        { network: 'BSC', address: BREV, withdrawEnabled: true, depositEnabled: true },
        { network: 'ERC20', address: WARD, withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [currency('bitget', 'KAT', [
        { network: 'BSC', address: BREV, withdrawEnabled: false, depositEnabled: false },
      ])],
    });
    expect(result.verdict).toBe('blocked');
    expect(result.reasons).toContain('withdrawal_or_deposit_disabled');
  });

  it('treats placeholder addresses as no identity', () => {
    const result = assessTransferability({
      symbol: 'LIT',
      leftVenue: 'gateio',
      rightVenue: 'bitget',
      left: [currency('gateio', 'LIT', [
        { network: 'ERC20', address: 'invalid-TWST-1', withdrawEnabled: true, depositEnabled: true },
      ])],
      right: [currency('bitget', 'LIT', [
        { network: 'ERC20', address: BREV, withdrawEnabled: true, depositEnabled: true },
      ])],
    });
    expect(result.verdict).toBe('blocked');
  });
});
