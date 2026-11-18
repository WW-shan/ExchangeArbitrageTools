import type { CurrencyMetadata } from './types.js';
import { isUsableAddress, normalizeAddress, normalizeChain } from './asset-identity.js';

/**
 * Can this asset actually move between the two venues?
 *
 * A cross-venue spread only converges if you can move the asset from the cheap
 * venue to the expensive one. When a withdrawal is suspended the spread does
 * not close; it becomes a permanent price difference, and anyone who buys the
 * "cheap" side is left holding an asset they cannot deliver.
 *
 * Measured on Gate x Bitget (2026-11-19): of 1,866 shared tickers only 425
 * allow withdrawal *and* deposit on both sides. Every one of the large
 * spreads we found was in the blocked 1,441:
 *
 *   BREV   Gate withdraws on ERC20/BSC, Bitget has ERC20 but withdrawals are
 *          suspended. The spread sat at 600-1,800 bps for a whole day.
 *
 * So a travel route is a hard requirement, not a risk adjustment.
 */

export interface TransferRoute {
  /** Chain both venues agree on (normalised). */
  chain: string;
  /** Contract address when the chain has one; native coins have none. */
  address?: string;
  /** Venue that can send. */
  from: string;
  /** Venue that can receive. */
  to: string;
  /** Withdrawal fee, when the venue publishes one. */
  withdrawFee?: string;
  /** Minimum withdrawal, when the venue publishes one. */
  minWithdrawAmount?: string;
}

export type TransferVerdict = 'transferable' | 'one-way' | 'blocked' | 'unknown';

export interface TransferabilityResult {
  symbol: string;
  verdict: TransferVerdict;
  reasons: string[];
  /** Routes that work in at least one direction. */
  routes: TransferRoute[];
}

interface VenueNetwork {
  venueId: string;
  chain: string;
  address?: string;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee?: string;
  minWithdrawAmount?: string;
}

function networksFor(venueId: string, currencies: readonly CurrencyMetadata[], symbol: string): VenueNetwork[] {
  const wanted = symbol.trim().toUpperCase();
  const rows: VenueNetwork[] = [];
  for (const currency of currencies) {
    if (currency.code.trim().toUpperCase() !== wanted) continue;
    for (const network of currency.networks) {
      const chain = normalizeChain(network.network);
      rows.push({
        venueId,
        chain,
        ...(isUsableAddress(network.address)
          ? { address: normalizeAddress(network.address, chain) }
          : {}),
        withdrawEnabled: network.withdrawEnabled,
        depositEnabled: network.depositEnabled,
        ...(network.withdrawFee ? { withdrawFee: network.withdrawFee.toString() } : {}),
        ...(network.minWithdrawAmount
          ? { minWithdrawAmount: network.minWithdrawAmount.toString() }
          : {}),
      });
    }
  }
  return rows;
}

function sameNetwork(left: VenueNetwork, right: VenueNetwork): boolean {
  if (left.chain !== right.chain) return false;
  // Native coins carry no contract address on either side; a chain match is
  // then the best identity we have.
  if (!left.address || !right.address) return !left.address && !right.address;
  return left.address === right.address;
}

/**
 * Decide whether `symbol` can move between the two venue currency lists.
 *
 * Only chains present on both venues count. A chain listed by one venue is not
 * a route: the receiving side would reject the deposit or credit a different
 * asset.
 */
export function assessTransferability(input: {
  symbol: string;
  leftVenue: string;
  rightVenue: string;
  left: readonly CurrencyMetadata[];
  right: readonly CurrencyMetadata[];
}): TransferabilityResult {
  const symbol = input.symbol.trim().toUpperCase();
  const left = networksFor(input.leftVenue, input.left, symbol);
  const right = networksFor(input.rightVenue, input.right, symbol);
  const reasons: string[] = [];
  const routes: TransferRoute[] = [];

  if (left.length === 0) reasons.push(`${input.leftVenue}_does_not_list_asset`);
  if (right.length === 0) reasons.push(`${input.rightVenue}_does_not_list_asset`);
  if (left.length === 0 || right.length === 0) {
    return { symbol, verdict: 'unknown', reasons, routes };
  }

  let sharedChain = false;
  let canSendLeft = false;
  let canSendRight = false;

  for (const leftNet of left) {
    for (const rightNet of right) {
      if (!sameNetwork(leftNet, rightNet)) continue;
      sharedChain = true;
      if (leftNet.withdrawEnabled && rightNet.depositEnabled) {
        canSendLeft = true;
        routes.push({
          chain: leftNet.chain,
          ...(leftNet.address ? { address: leftNet.address } : {}),
          from: input.leftVenue,
          to: input.rightVenue,
          ...(leftNet.withdrawFee ? { withdrawFee: leftNet.withdrawFee } : {}),
          ...(leftNet.minWithdrawAmount ? { minWithdrawAmount: leftNet.minWithdrawAmount } : {}),
        });
      }
      if (rightNet.withdrawEnabled && leftNet.depositEnabled) {
        canSendRight = true;
        routes.push({
          chain: rightNet.chain,
          ...(rightNet.address ? { address: rightNet.address } : {}),
          from: input.rightVenue,
          to: input.leftVenue,
          ...(rightNet.withdrawFee ? { withdrawFee: rightNet.withdrawFee } : {}),
          ...(rightNet.minWithdrawAmount ? { minWithdrawAmount: rightNet.minWithdrawAmount } : {}),
        });
      }
    }
  }

  if (!sharedChain) {
    reasons.push('no_shared_chain');
    return { symbol, verdict: 'blocked', reasons, routes };
  }
  if (canSendLeft && canSendRight) {
    return { symbol, verdict: 'transferable', reasons, routes };
  }
  if (canSendLeft || canSendRight) {
    reasons.push(canSendLeft ? 'cannot_return_from_right' : 'cannot_return_from_left');
    return { symbol, verdict: 'one-way', reasons, routes };
  }
  reasons.push('withdrawal_or_deposit_disabled');
  return { symbol, verdict: 'blocked', reasons, routes };
}

/**
 * The invariant we trade on: a spread is only an opportunity when capital can
 * round-trip. A one-way route is enough to *enter* a position and never leave
 * it, which is exactly the trap the large spreads hide.
 */
export function requiresRoundTrip(result: TransferabilityResult): boolean {
  return result.verdict === 'transferable';
}

