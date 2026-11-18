import { describe, expect, it } from 'vitest';
import {
  matchAssetAcrossVenues,
  normalizeAddress,
  normalizeChain,
  type CurrencyMetadata,
} from '../src/index.js';

const WARD_ADDRESS = '0x174a0de0fa1c4771ca980a42553c0041016e5a67';

function currency(
  code: string,
  networks: Array<{ network: string; address?: string }>,
): CurrencyMetadata {
  return {
    venueId: 'test',
    code,
    networks: networks.map((row) => ({
      network: row.network,
      nativeName: row.network,
      ...(row.address === undefined ? {} : { address: row.address }),
      withdrawEnabled: true,
      depositEnabled: true,
      canArriveQuickly: false,
    })),
  };
}

describe('chain and address normalisation', () => {
  it('collapses venue spellings of the same chain', () => {
    expect(normalizeChain('BASEEVM')).toBe('base');
    expect(normalizeChain('BASE')).toBe('base');
    expect(normalizeChain('BSC')).toBe('bsc');
    expect(normalizeChain('BEP20')).toBe('bsc');
    expect(normalizeChain('ERC20')).toBe('ethereum');
    expect(normalizeChain('eth')).toBe('ethereum');
  });

  it('lowercases EVM addresses but preserves case-sensitive chains', () => {
    expect(normalizeAddress(WARD_ADDRESS.toUpperCase(), 'base')).toBe(WARD_ADDRESS);
    const solana = '9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump';
    expect(normalizeAddress(solana, 'solana')).toBe(solana);
  });
});

describe('cross-venue asset identity', () => {
  it('matches the same token listed under different chain spellings', () => {
    const result = matchAssetAcrossVenues({
      symbol: 'WARD',
      left: [currency('WARD', [{ network: 'BASEEVM', address: WARD_ADDRESS }])],
      right: [currency('WARD', [{ network: 'BASE', address: WARD_ADDRESS }])],
    });
    expect(result.kind).toBe('same-asset');
    expect(result.shared).toEqual({ chain: 'base', address: WARD_ADDRESS });
  });

  it('rejects an unrelated token that happens to share the ticker', () => {
    const result = matchAssetAcrossVenues({
      symbol: 'RAIN',
      left: [currency('RAIN', [{ network: 'ETH', address: '0x' + '11'.repeat(20) }])],
      right: [currency('RAIN', [{ network: 'SOL', address: 'RainTokenAddressXXXXXXXXXXXXXXXXXXXXXX' }])],
    });
    expect(result.kind).toBe('different-asset');
    expect(result.reasons).toContain('no_shared_chain_and_address');
  });

  it('refuses to guess when a venue publishes no contract address', () => {
    const result = matchAssetAcrossVenues({
      symbol: 'WARD',
      left: [currency('WARD', [{ network: 'BASEEVM', address: WARD_ADDRESS }])],
      right: [currency('WARD', [{ network: 'BASE' }])],
    });
    expect(result.kind).toBe('unknown');
    expect(result.reasons).toContain('right_venue_has_no_contract_address');
  });

  it('ignores placeholder addresses that venues use for non-transferable tokens', () => {
    const result = matchAssetAcrossVenues({
      symbol: 'TWST',
      left: [currency('TWST', [{ network: 'ETH', address: 'invalid-TWST-8701074-380' }])],
      right: [currency('TWST', [{ network: 'ETH', address: 'invalid-TWST-8701074-380' }])],
    });
    expect(result.kind).toBe('unknown');
  });

  it('matches when the token exists on several chains and one overlaps', () => {
    const result = matchAssetAcrossVenues({
      symbol: 'USDT',
      left: [
        currency('USDT', [
          { network: 'TRC20', address: 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj' },
          { network: 'ERC20', address: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
        ]),
      ],
      right: [
        currency('USDT', [
          { network: 'ETH', address: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
        ]),
      ],
    });
    expect(result.kind).toBe('same-asset');
    expect(result.shared?.chain).toBe('ethereum');
  });
});
