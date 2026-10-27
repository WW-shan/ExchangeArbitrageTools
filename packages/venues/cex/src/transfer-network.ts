/**
 * Normalize a venue network identifier for transfer matching.
 *
 * BSC has many venue spellings. Other networks are compared by their
 * alphanumeric identity; callers must still require an exact allowlist match
 * for networks that are not explicitly aliased here.
 */
export function normalizeCurrencyNetwork(network: string): string {
  const normalized = network
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (
    normalized.includes('BSC') ||
    normalized.includes('BEP20') ||
    normalized.includes('BNBSMARTCHAIN') ||
    normalized.includes('BINANCESMARTCHAIN')
  ) {
    return 'BSC';
  }
  return normalized;
}

export function networksMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return normalizeCurrencyNetwork(left) === normalizeCurrencyNetwork(right);
}

export function normalizeAddressTag(tag: string | undefined | null): string {
  return (tag ?? '').trim();
}

/**
 * EVM addresses are case-insensitive. Non-EVM addresses keep exact case.
 */
export function transferAddressesMatch(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return false;
  if (/^0x[0-9a-f]{40}$/i.test(a) && /^0x[0-9a-f]{40}$/i.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
