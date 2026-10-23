import { getAddress } from 'ethers';

export interface BscTokenInfo {
  contractAddress: string;
  symbol: string;
  name: string;
  decimals: number;
  verifiedContract: boolean;
  transferTaxBps: string;
  liquidityUsd?: string;
  volume24hUsd?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
}

export const BSC_CHAIN_ID = 56;

const CHECKS = [
  ['WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18, 'Wrapped BNB'],
  ['USDT', '0x55d398326f99059fF775485246999027B3197955', 18, 'Tether USD'],
  ['USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 'USD Coin'],
  ['BUSD', '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', 18, 'Binance USD'],
  ['CAKE', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', 18, 'PancakeSwap Token'],
] as const;

export const STANDARD_BSC_TOKENS: Readonly<Record<string, BscTokenInfo>> = Object.fromEntries(
  CHECKS.map(([symbol, address, decimals, name]) => {
    const checksummed = getAddress(address);
    return [
      checksummed,
      {
        contractAddress: checksummed,
        symbol,
        name,
        decimals,
        verifiedContract: true,
        transferTaxBps: '0',
        riskLevel: 'low',
      } satisfies BscTokenInfo,
    ];
  }),
);

export function findStandardToken(symbolOrAddress: string): BscTokenInfo | undefined {
  const wanted = symbolOrAddress.toUpperCase();
  const direct = STANDARD_BSC_TOKENS[symbolOrAddress];
  if (direct) return direct;
  return Object.values(STANDARD_BSC_TOKENS).find((token) => token.symbol.toUpperCase() === wanted);
}

export function isStandardTokenAddress(address: string): boolean {
  try {
    return Boolean(STANDARD_BSC_TOKENS[getAddress(address)]);
  } catch {
    return false;
  }
}
