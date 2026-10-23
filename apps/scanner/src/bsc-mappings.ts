import { Decimal, marketBaseMultiplier } from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';
import {
  TokenMappingService,
  type BscTokenInfo,
  type BscTokenRegistry,
  type TokenMappingCandidate,
} from '@arb/venues-bsc';
import type { ScannerVenue } from './scanner-service.js';

export interface BscMappingOptions {
  tokenSymbols: string[];
  quoteCurrency: string;
  estimatedTransferArrivalMs?: number;
}

export interface BscMappingEntry {
  mapping: TokenMappingCandidate;
  venue: ScannerVenue;
}

export function persistBscToken(repository: ArbitrageRepository, token: BscTokenInfo): void {
  repository.upsertBscToken({
    contractAddress: token.contractAddress,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    verifiedContract: token.verifiedContract,
    transferTaxBps: new Decimal(token.transferTaxBps),
    ...(token.liquidityUsd ? { liquidityUsd: new Decimal(token.liquidityUsd) } : {}),
    ...(token.volume24hUsd ? { volume24hUsd: new Decimal(token.volume24hUsd) } : {}),
    riskLevel: token.riskLevel,
  });
}

export function bscMappings(
  options: BscMappingOptions,
  venues: ScannerVenue[],
  registry: Pick<BscTokenRegistry, 'getKnownToken'>,
  repository: ArbitrageRepository,
): BscMappingEntry[] {
  const service = new TokenMappingService();
  const result: BscMappingEntry[] = [];
  for (const symbol of options.tokenSymbols) {
    const token = registry.getKnownToken(symbol === 'BNB' ? 'WBNB' : symbol);
    if (!token) continue;
    persistBscToken(repository, token);
    for (const venue of venues) {
      const hasMarket = venue.markets.some(
        (market) =>
          market.base === symbol &&
          market.quote === options.quoteCurrency &&
          market.active &&
          marketBaseMultiplier(market).eq(1),
      );
      if (!hasMarket) continue;
      const currency = venue.currencies?.find(
        (candidate) => candidate.code.trim().toUpperCase() === symbol.trim().toUpperCase(),
      );
      const bscNetwork = currency?.networks.find((network) => network.network === 'BSC');
      const estimatedArrivalMs =
        bscNetwork?.canArriveQuickly && options.estimatedTransferArrivalMs !== undefined
          ? options.estimatedTransferArrivalMs
          : undefined;
      const mapping = service.candidate({
        id: `${venue.adapter.venueId}:${symbol}:BSC`,
        cexVenueId: venue.adapter.venueId,
        cexCurrency: symbol,
        contractAddress: token.contractAddress,
        token,
        evidences: [
          {
            cexCurrency: symbol,
            chain: 'BSC',
            contractAddress: token.contractAddress,
            source: 'manual-whitelist',
          },
        ],
        manualApproval: true,
        withdrawEnabled: bscNetwork?.withdrawEnabled ?? false,
        depositEnabled: bscNetwork?.depositEnabled ?? false,
        ...(bscNetwork?.withdrawFee ? { withdrawFee: bscNetwork.withdrawFee } : {}),
        ...(bscNetwork?.minWithdrawAmount
          ? { minWithdrawAmount: bscNetwork.minWithdrawAmount }
          : {}),
        ...(bscNetwork?.minDepositAmount ? { minDepositAmount: bscNetwork.minDepositAmount } : {}),
        canArriveQuickly: bscNetwork?.canArriveQuickly ?? false,
        ...(estimatedArrivalMs !== undefined ? { estimatedArrivalMs } : {}),
        notes: bscNetwork
          ? 'Transfer metadata was read from the CEX currency/network API; verify it before live use.'
          : 'Inventory mode only; transfer metadata is unavailable.',
      });
      repository.upsertTokenMapping({
        cexVenueId: mapping.cexVenueId,
        cexCurrency: mapping.cexCurrency,
        contractAddress: mapping.contractAddress,
        status: mapping.status,
        verificationSources: mapping.verification,
        transferTaxBps: new Decimal(mapping.token.transferTaxBps),
        riskLevel: mapping.token.riskLevel,
        ...(mapping.notes ? { notes: mapping.notes } : {}),
      });
      result.push({ mapping, venue });
    }
  }
  return result;
}
