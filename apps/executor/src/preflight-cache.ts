import type { BalanceSnapshot, OrderState } from '@arb/venues-cex';

export interface CachedOpenOrderResult {
  ok: boolean;
  orders: OrderState[];
  errors: string[];
}

interface TimedOpenOrderResult extends CachedOpenOrderResult {
  checkedAt: number;
}

function uniqueOrders(orders: readonly OrderState[]): OrderState[] {
  const unique = new Map<string, OrderState>();
  for (const order of orders) {
    const key = `${order.venueOrderId}|${order.clientOrderId ?? ''}`;
    if (!unique.has(key)) unique.set(key, order);
  }
  return [...unique.values()];
}

/**
 * Process-local snapshots populated by the background preflight refresher.
 * The execution hot path may only use them while they are inside the configured
 * freshness window; otherwise it falls back to the venue REST endpoints.
 */
export class PreflightCache {
  readonly #balances = new Map<string, BalanceSnapshot[]>();
  readonly #openOrders = new Map<string, TimedOpenOrderResult>();

  recordBalances(rows: readonly BalanceSnapshot[]): void {
    const grouped = new Map<string, BalanceSnapshot[]>();
    for (const row of rows) {
      const venueRows = grouped.get(row.venueId) ?? [];
      venueRows.push(row);
      grouped.set(row.venueId, venueRows);
    }
    for (const [venueId, venueRows] of grouped) {
      this.#balances.set(venueId, venueRows);
    }
  }

  balancesForVenue(
    venueId: string,
    options: { maxAgeMs: number; now?: number; currencies?: readonly string[] },
  ): BalanceSnapshot[] | undefined {
    const rows = this.#balances.get(venueId);
    if (!rows || rows.length === 0 || options.maxAgeMs < 0) return undefined;
    const now = options.now ?? Date.now();
    const cutoff = now - options.maxAgeMs;
    const required = (options.currencies ?? [])
      .map((currency) => currency.trim().toUpperCase())
      .filter((currency) => currency.length > 0);
    if (required.length === 0) {
      return rows.every((row) => row.fetchedAt >= cutoff) ? rows : undefined;
    }
    // Only the currencies this execution actually spends need to be fresh.
    // A long-tail balance that no longer moves must not invalidate the whole
    // venue snapshot, because that forces the hot path back onto a blocking
    // private REST call and burns the spread while it waits.
    const byCurrency = new Map<string, BalanceSnapshot>();
    for (const row of rows) byCurrency.set(row.currency.trim().toUpperCase(), row);
    const requiredRows = required.map((currency) => byCurrency.get(currency));
    if (requiredRows.some((row) => row === undefined)) return undefined;
    return requiredRows.every((row) => row!.fetchedAt >= cutoff) ? rows : undefined;
  }

  recordOpenOrders(
    keys: readonly string[],
    result: CachedOpenOrderResult,
    checkedAt: number,
  ): void {
    const snapshot: TimedOpenOrderResult = {
      ok: result.ok,
      orders: [...result.orders],
      errors: [...result.errors],
      checkedAt,
    };
    for (const key of new Set(keys)) this.#openOrders.set(key, snapshot);
  }

  openOrdersFor(
    keys: readonly string[],
    options: { maxAgeMs: number; now?: number },
  ): CachedOpenOrderResult | undefined {
    if (keys.length === 0 || options.maxAgeMs < 0) return undefined;
    const now = options.now ?? Date.now();
    const orders: OrderState[] = [];
    const errors: string[] = [];
    let ok = true;
    for (const key of new Set(keys)) {
      const entry = this.#openOrders.get(key);
      if (!entry || entry.checkedAt < now - options.maxAgeMs) return undefined;
      ok = ok && entry.ok;
      orders.push(...entry.orders);
      errors.push(...entry.errors);
    }
    return { ok, orders: uniqueOrders(orders), errors: [...new Set(errors)] };
  }

  invalidateOpenOrders(keys?: readonly string[]): void {
    if (!keys) {
      this.#openOrders.clear();
      return;
    }
    for (const key of keys) this.#openOrders.delete(key);
  }
}
