import type { CurrencyMetadata } from './types.js';

/**
 * Canonical chain ids. Venues publish dozens of spellings for the same chain
 * (`BASE`, `BASEEVM`, `BSC`, `BEP20`, `ERC20`, `ETH`, ...), so identity must
 * compare a normalised chain name plus the contract address.
 */
const CHAIN_ALIASES: Readonly<Record<string, string>> = {
  BASE: 'base',
  BASEEVM: 'base',
  BASECHAIN: 'base',
  ETH: 'ethereum',
  ERC20: 'ethereum',
  ERC: 'ethereum',
  ETHEREUM: 'ethereum',
  BSC: 'bsc',
  BEP20: 'bsc',
  BSCC: 'bsc',
  BNB: 'bsc',
  BNBSMARTCHAIN: 'bsc',
  OP: 'optimism',
  OPETH: 'optimism',
  OPTIMISM: 'optimism',
  ARB: 'arbitrum',
  ARBITRUM: 'arbitrum',
  ARBITRUMONE: 'arbitrum',
  MATIC: 'polygon',
  POLYGON: 'polygon',
  POL: 'polygon',
  AVAX: 'avalanche',
  AVALANCHE: 'avalanche',
  AVAXC: 'avalanche',
  SOL: 'solana',
  SOLANA: 'solana',
  TRON: 'tron',
  TRC20: 'tron',
  TON: 'ton',
  SUI: 'sui',
  APT: 'aptos',
  APTOS: 'aptos',
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function normalizeChain(raw: string): string {
  const key = raw.trim().toUpperCase().replace(/[\s_-]/g, '');
  return CHAIN_ALIASES[key] ?? raw.trim().toLowerCase();
}

/**
 * EVM addresses are case-insensitive, Solana/base58 ones are not.
 */
export function normalizeAddress(raw: string, chain: string): string {
  const trimmed = raw.trim();
  if (EVM_ADDRESS.test(trimmed)) return trimmed.toLowerCase();
  if (chain === 'solana' || chain === 'tron' || chain === 'ton') return trimmed;
  return trimmed.toLowerCase();
}

export function isUsableAddress(raw: string | undefined): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  // Venues use placeholders such as invalid-TWST-8701074-380 for tokens they
  // list but cannot actually transfer. Treat those as no identity at all.
  if (/^invalid/i.test(trimmed)) return false;
  return true;
}

export interface AssetIdentity {
  symbol: string;
  chain: string;
  address: string;
  nativeChain: string;
  nativeAddress: string;
}

function identitiesFor(currency: CurrencyMetadata): AssetIdentity[] {
  const rows: AssetIdentity[] = [];
  for (const network of currency.networks) {
    if (!isUsableAddress(network.address)) continue;
    const chain = normalizeChain(network.network);
    rows.push({
      symbol: currency.code.trim().toUpperCase(),
      chain,
      address: normalizeAddress(network.address, chain),
      nativeChain: network.nativeName,
      nativeAddress: network.address,
    });
  }
  return rows;
}

export function identitiesForSymbol(
  currencies: readonly CurrencyMetadata[],
  symbol: string,
): AssetIdentity[] {
  const wanted = symbol.trim().toUpperCase();
  return currencies
    .filter((currency) => currency.code.trim().toUpperCase() === wanted)
    .flatMap(identitiesFor);
}

export type AssetMatchKind = 'same-asset' | 'different-asset' | 'unknown';

export interface AssetMatchResult {
  kind: AssetMatchKind;
  /** Chain + address shared by both venues, when a match was found. */
  shared?: { chain: string; address: string };
  left: AssetIdentity[];
  right: AssetIdentity[];
  reasons: string[];
}

/**
 * Decide whether two venues list the *same* token, using contract identity.
 *
 * A ticker match alone is never enough: RAIN, LIT, CRO and WEETH all appear on
 * both Gate and Bitget as completely different assets, and trading them as one
 * pair loses money on every round trip.
 */
export function matchAssetAcrossVenues(input: {
  symbol: string;
  left: readonly CurrencyMetadata[];
  right: readonly CurrencyMetadata[];
}): AssetMatchResult {
  const left = identitiesForSymbol(input.left, input.symbol);
  const right = identitiesForSymbol(input.right, input.symbol);
  const reasons: string[] = [];
  if (left.length === 0) reasons.push('left_venue_has_no_contract_address');
  if (right.length === 0) reasons.push('right_venue_has_no_contract_address');
  if (left.length === 0 || right.length === 0) {
    return { kind: 'unknown', left, right, reasons };
  }
  const rightKeys = new Set(right.map((row) => `${row.chain}|${row.address}`));
  for (const candidate of left) {
    const key = `${candidate.chain}|${candidate.address}`;
    if (rightKeys.has(key)) {
      return {
        kind: 'same-asset',
        shared: { chain: candidate.chain, address: candidate.address },
        left,
        right,
        reasons,
      };
    }
  }
  reasons.push('no_shared_chain_and_address');
  return { kind: 'different-asset', left, right, reasons };
}
