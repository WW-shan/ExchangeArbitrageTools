import { getAddress, type Provider } from 'ethers';
import { findStandardToken, STANDARD_BSC_TOKENS } from './tokens.js';
import type { BscTokenInfo } from './tokens.js';

export interface TokenMetadataProvider {
  getCode(address: string): Promise<string>;
  call(transaction: { to: string; data: string }): Promise<string>;
}

const DECIMALS_SELECTOR = '0x313ce567';
const SYMBOL_SELECTOR = '0x95d89b41';
const NAME_SELECTOR = '0x06fdde03';

function decodeAbiString(value: string): string {
  if (!value || value === '0x') return '';
  const body = value.slice(2);
  if (body.length < 128) return '';
  const offset = Number.parseInt(body.slice(0, 64), 16) * 2;
  if (!Number.isFinite(offset) || offset + 64 > body.length) return '';
  const length = Number.parseInt(body.slice(offset, offset + 64), 16) * 2;
  const data = body.slice(offset + 64, offset + 64 + length);
  if (data.length === 0) return '';
  return Buffer.from(data, 'hex').toString('utf8').replace(/\0+$/g, '');
}

export class BscTokenRegistry {
  constructor(
    private readonly provider?: Provider | TokenMetadataProvider,
    private readonly overrides: Readonly<Record<string, BscTokenInfo>> = {},
  ) {}

  getWhitelist(): BscTokenInfo[] {
    return Object.values({ ...STANDARD_BSC_TOKENS, ...this.overrides });
  }

  getKnownToken(symbolOrAddress: string): BscTokenInfo | undefined {
    const override = Object.values(this.overrides).find(
      (token) =>
        token.contractAddress.toLowerCase() === symbolOrAddress.toLowerCase() ||
        token.symbol.toUpperCase() === symbolOrAddress.toUpperCase(),
    );
    return override ?? findStandardToken(symbolOrAddress);
  }

  async inspect(address: string): Promise<BscTokenInfo> {
    let checksummed: string;
    try {
      checksummed = getAddress(address);
    } catch {
      throw new Error(`invalid BSC contract address: ${address}`);
    }
    const known = this.getKnownToken(checksummed);
    if (!this.provider) {
      if (!known) throw new Error(`token metadata provider unavailable for ${checksummed}`);
      return known;
    }
    const code = await this.provider.getCode(checksummed);
    if (!code || code === '0x') throw new Error(`no contract code at ${checksummed}`);
    const decimalsRaw = await this.provider.call({ to: checksummed, data: DECIMALS_SELECTOR });
    const decimals = Number.parseInt(decimalsRaw.slice(2, 66), 16);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`invalid token decimals at ${checksummed}`);
    }
    let symbol = known?.symbol ?? '';
    let name = known?.name ?? '';
    try {
      symbol = decodeAbiString(
        await this.provider.call({ to: checksummed, data: SYMBOL_SELECTOR }),
      );
      name = decodeAbiString(await this.provider.call({ to: checksummed, data: NAME_SELECTOR }));
    } catch {
      // Some tokens use bytes32 metadata. Keep curated values when available.
    }
    return {
      contractAddress: checksummed,
      symbol: symbol || known?.symbol || 'UNKNOWN',
      name: name || known?.name || 'Unknown token',
      decimals,
      verifiedContract: true,
      transferTaxBps: known?.transferTaxBps ?? '0',
      ...(known?.liquidityUsd ? { liquidityUsd: known.liquidityUsd } : {}),
      ...(known?.volume24hUsd ? { volume24hUsd: known.volume24hUsd } : {}),
      riskLevel: known?.riskLevel ?? 'high',
    };
  }
}
