import type { Decimal } from '@arb/core';
import { getAddress } from 'ethers';
import type { BscTokenInfo } from './tokens.js';

export type MappingStatus = 'candidate' | 'active' | 'rejected';

export interface TokenMappingCandidate {
  id: string;
  cexVenueId: string;
  cexCurrency: string;
  chain: 'BSC';
  contractAddress: string;
  token: BscTokenInfo;
  verification: string[];
  manualApproval: boolean;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee?: Decimal;
  minWithdrawAmount?: Decimal;
  minDepositAmount?: Decimal;
  canArriveQuickly?: boolean;
  estimatedArrivalMs?: number;
  status: MappingStatus;
  notes?: string;
}

export interface MappingEvidence {
  cexCurrency: string;
  chain: string;
  contractAddress: string;
  source: string;
}

export class TokenMappingService {
  readonly #mappings = new Map<string, TokenMappingCandidate>();

  candidate(input: {
    id: string;
    cexVenueId: string;
    cexCurrency: string;
    contractAddress: string;
    token: BscTokenInfo;
    evidences: MappingEvidence[];
    manualApproval?: boolean;
    withdrawEnabled: boolean;
    depositEnabled: boolean;
    withdrawFee?: Decimal;
    minWithdrawAmount?: Decimal;
    minDepositAmount?: Decimal;
    canArriveQuickly?: boolean;
    estimatedArrivalMs?: number;
    notes?: string;
  }): TokenMappingCandidate {
    if (!input.contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(input.contractAddress)) {
      throw new Error(
        'a verified BSC contract address is required; ticker-only mappings are unsafe',
      );
    }
    const address = getAddress(input.contractAddress);
    const conflicting = input.evidences.filter(
      (evidence) =>
        evidence.cexCurrency.toUpperCase() !== input.cexCurrency.toUpperCase() ||
        evidence.chain !== 'BSC' ||
        evidence.contractAddress.toLowerCase() !== address.toLowerCase(),
    );
    if (conflicting.length > 0)
      throw new Error('mapping evidence contains conflicting token identities');
    const sources = [...new Set(input.evidences.map((evidence) => evidence.source))];
    if (sources.length === 0) throw new Error('at least one verification source is required');
    const active = Boolean(input.manualApproval) || sources.length >= 2;
    const mapping: TokenMappingCandidate = {
      id: input.id,
      cexVenueId: input.cexVenueId,
      cexCurrency: input.cexCurrency.toUpperCase(),
      chain: 'BSC',
      contractAddress: address,
      token: { ...input.token, contractAddress: address },
      verification: sources,
      manualApproval: Boolean(input.manualApproval),
      withdrawEnabled: input.withdrawEnabled,
      depositEnabled: input.depositEnabled,
      ...(input.withdrawFee ? { withdrawFee: input.withdrawFee } : {}),
      ...(input.minWithdrawAmount ? { minWithdrawAmount: input.minWithdrawAmount } : {}),
      ...(input.minDepositAmount ? { minDepositAmount: input.minDepositAmount } : {}),
      ...(input.canArriveQuickly !== undefined ? { canArriveQuickly: input.canArriveQuickly } : {}),
      ...(input.estimatedArrivalMs !== undefined
        ? { estimatedArrivalMs: input.estimatedArrivalMs }
        : {}),
      status: active ? 'active' : 'candidate',
      ...(input.notes ? { notes: input.notes } : {}),
    };
    this.#mappings.set(mapping.id, mapping);
    return mapping;
  }

  approve(id: string): TokenMappingCandidate {
    const mapping = this.#mappings.get(id);
    if (!mapping) throw new Error(`mapping not found: ${id}`);
    const approved: TokenMappingCandidate = {
      ...mapping,
      manualApproval: true,
      status: 'active',
    };
    this.#mappings.set(id, approved);
    return approved;
  }

  reject(id: string, reason: string): TokenMappingCandidate {
    const mapping = this.#mappings.get(id);
    if (!mapping) throw new Error(`mapping not found: ${id}`);
    const rejected: TokenMappingCandidate = { ...mapping, status: 'rejected', notes: reason };
    this.#mappings.set(id, rejected);
    return rejected;
  }

  get(id: string): TokenMappingCandidate | undefined {
    return this.#mappings.get(id);
  }

  list(): TokenMappingCandidate[] {
    return [...this.#mappings.values()];
  }

  findActive(
    venueId: string,
    currency: string,
    contractAddress?: string,
  ): TokenMappingCandidate | undefined {
    return this.list().find(
      (mapping) =>
        mapping.status === 'active' &&
        mapping.cexVenueId === venueId &&
        mapping.cexCurrency.toUpperCase() === currency.toUpperCase() &&
        (!contractAddress ||
          mapping.contractAddress.toLowerCase() === contractAddress.toLowerCase()),
    );
  }
}
