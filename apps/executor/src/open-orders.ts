import type { ApiCredentials, CexAdapter, OrderState } from '@arb/venues-cex';

export interface OpenOrderVenue {
  adapter: CexAdapter;
  credentials: ApiCredentials;
  symbol: string;
}

export interface OpenOrderQueryResult {
  orders: OrderState[];
  errors: string[];
}

export interface OpenOrderCheckOptions {
  requireSupported?: boolean;
}

export function isOpenOrder(order: OrderState): boolean {
  return order.status === 'open' || order.status === 'unknown';
}

function uniqueOpenOrders(adapter: CexAdapter, orders: readonly OrderState[]): OrderState[] {
  const result = new Map<string, OrderState>();
  for (const order of orders) {
    if (!isOpenOrder(order)) continue;
    const key = `${adapter.venueId}|${order.venueOrderId}`;
    if (!result.has(key)) result.set(key, order);
  }
  return [...result.values()];
}

export async function fetchOpenOrdersForSymbols(
  adapter: CexAdapter,
  credentials: ApiCredentials,
  symbols: readonly string[],
): Promise<OpenOrderQueryResult> {
  if (typeof adapter.fetchOpenOrders !== 'function') {
    return {
      orders: [],
      errors: [`open_orders_query_unsupported:${adapter.venueId}`],
    };
  }
  const uniqueSymbols = [
    ...new Set(symbols.map((symbol) => symbol.trim()).filter((symbol) => symbol.length > 0)),
  ];
  if (uniqueSymbols.length === 0) {
    return {
      orders: [],
      errors: [`open_orders_symbol_missing:${adapter.venueId}`],
    };
  }
  const orders: OrderState[] = [];
  const errors: string[] = [];
  for (const symbol of uniqueSymbols) {
    try {
      const rows = await adapter.fetchOpenOrders({ symbol }, credentials);
      orders.push(...rows);
    } catch (error) {
      errors.push(`open_orders_fetch_failed:${adapter.venueId}:${symbol}:${String(error)}`);
    }
  }
  return { orders: uniqueOpenOrders(adapter, orders), errors };
}

export async function checkNoOpenOrders(
  venues: readonly OpenOrderVenue[],
  options: OpenOrderCheckOptions = {},
): Promise<{ ok: boolean; orders: OrderState[]; errors: string[] }> {
  const results = await Promise.all(
    venues.map(async (venue): Promise<OpenOrderQueryResult> => {
      if (typeof venue.adapter.fetchOpenOrders !== 'function') {
        return {
          orders: [],
          errors:
            options.requireSupported === true
              ? [`open_orders_query_unsupported:${venue.adapter.venueId}`]
              : [],
        };
      }
      return fetchOpenOrdersForSymbols(venue.adapter, venue.credentials, [venue.symbol]);
    }),
  );
  const orders: OrderState[] = [];
  const errors: string[] = [];
  for (const result of results) {
    orders.push(...result.orders);
    errors.push(...result.errors);
  }
  if (orders.length > 0) errors.push('open_orders_present');
  return { ok: errors.length === 0, orders, errors };
}
