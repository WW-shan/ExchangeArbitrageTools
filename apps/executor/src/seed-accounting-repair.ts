import { Decimal } from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';
import { extractOrderFee } from '@arb/venues-cex';
import { accountSeedFill, usableSeedAccounting } from './auto-inventory.js';

function metadataObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('execution metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function metadataDecimal(
  metadata: Record<string, unknown>,
  key: string,
  fallback?: Decimal,
): Decimal {
  const value = metadata[key];
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Decimal(String(value));
    if (parsed.isFinite()) return parsed;
  }
  if (fallback) return fallback;
  throw new Error(`seed metadata is missing ${key}`);
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`seed metadata is missing ${key}`);
  }
  return value.trim();
}

export interface SeedAccountingRepairResult {
  status: 'REPAIRED' | 'ALREADY_CORRECT';
  batchId: string;
  executionId: number;
  orderId: string | null;
  feeAmount: string;
  feeCurrency: string | null;
  feeTreatment: string;
  previousInventoryDelta: unknown;
  inventoryDelta: {
    baseAsset: string;
    baseDelta: string;
    quoteAsset: string;
    quoteDelta: string;
  };
  repairedAt: string;
}

/**
 * Repair only the accounting metadata of an already-closed SEED execution.
 * The order must already be terminal and fully filled. This function never
 * submits, cancels, retries, or clears a kill switch.
 */
export function repairClosedSeedAccounting(input: {
  repository: ArbitrageRepository;
  batchId: string;
  now?: number;
}): SeedAccountingRepairResult {
  const now = input.now ?? Date.now();
  const execution = input.repository.db
    .prepare(
      `SELECT id, strategy, status, closed_at, realized_profit, inventory_delta_json, metadata_json
       FROM executions WHERE batch_id = ?`,
    )
    .get(input.batchId) as
    | {
        id: number;
        strategy: string;
        status: string;
        closed_at: number | null;
        realized_profit: string | null;
        inventory_delta_json: string | null;
        metadata_json: string | null;
      }
    | undefined;
  if (!execution) throw new Error(`execution not found: ${input.batchId}`);
  if (execution.strategy !== 'SEED') throw new Error('execution is not SEED');
  if (execution.status !== 'CLOSED' || execution.closed_at === null) {
    throw new Error(`execution is ${execution.status}, not a closed SEED`);
  }

  const order = input.repository.db
    .prepare(
      `SELECT id, venue_id, venue_order_id, client_order_id, symbol, side, type, price,
              amount, filled_amount, average_price, fee, fee_currency, status
       FROM orders WHERE execution_id = ? ORDER BY id LIMIT 1`,
    )
    .get(execution.id) as
    | {
        id: number;
        venue_id: string;
        venue_order_id: string | null;
        client_order_id: string;
        symbol: string;
        side: string;
        type: string;
        price: string;
        amount: string;
        filled_amount: string;
        average_price: string | null;
        fee: string | null;
        fee_currency: string | null;
        status: string;
      }
    | undefined;
  if (!order) throw new Error('seed order row is missing');
  if (order.status !== 'closed') throw new Error(`seed order is ${order.status}, not closed`);

  const metadata = metadataObject(execution.metadata_json);
  const base = metadataString(metadata, 'base').toUpperCase();
  const quote = metadataString(metadata, 'quote').toUpperCase();
  const exchangeBase =
    typeof metadata.exchangeBase === 'string' && metadata.exchangeBase.trim() !== ''
      ? metadata.exchangeBase.trim().toUpperCase()
      : base;
  const filled = new Decimal(order.filled_amount);
  if (!filled.gt(0)) throw new Error('seed order has no fill');
  const filledCanonical = metadataDecimal(
    metadata,
    'filledCanonical',
    filled.mul(
      typeof metadata.baseMultiplier === 'string' || typeof metadata.baseMultiplier === 'number'
        ? new Decimal(String(metadata.baseMultiplier))
        : new Decimal(1),
    ),
  );
  const baseMultiplier = filled.gt(0) ? filledCanonical.div(filled) : new Decimal(1);
  const averagePrice = order.average_price
    ? new Decimal(order.average_price)
    : metadataDecimal(metadata, 'averagePrice');
  const limitPrice = metadataDecimal(metadata, 'limitPrice', new Decimal(order.price));

  let fee = order.fee ? new Decimal(order.fee) : undefined;
  let feeCurrency = order.fee_currency?.trim().toUpperCase() || undefined;
  if (!fee) {
    const events = input.repository.db
      .prepare('SELECT raw_response FROM order_events WHERE order_id = ? ORDER BY id DESC')
      .all(order.id) as Array<{ raw_response: string }>;
    for (const event of events) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.raw_response) as unknown;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const raw = (parsed as Record<string, unknown>).raw;
      const rawRecord =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : undefined;
      const normalizedFee = rawRecord?.normalizedFee;
      if (normalizedFee && typeof normalizedFee === 'object' && !Array.isArray(normalizedFee)) {
        const normalized = normalizedFee as Record<string, unknown>;
        if (normalized.cost !== undefined) fee = new Decimal(String(normalized.cost));
        if (typeof normalized.currency === 'string' && normalized.currency.trim() !== '') {
          feeCurrency = normalized.currency.trim().toUpperCase();
        }
      }
      if (!fee && rawRecord?.info) {
        const extracted = extractOrderFee({ info: rawRecord.info });
        if (extracted) {
          fee = extracted.cost;
          feeCurrency = extracted.currency;
        }
      }
      if (fee) break;
    }
  }

  const accounting = accountSeedFill({
    base,
    exchangeBase,
    quote,
    baseMultiplier,
    filled: filledCanonical,
    averagePrice,
    limitPrice,
    fee,
    feeCurrency,
  });
  if (!usableSeedAccounting(accounting)) {
    throw new Error(
      accounting.known
        ? 'net inventory delta is invalid; refusing automatic repair'
        : `fee accounting is ${accounting.feeTreatment}; refusing automatic repair`,
    );
  }

  const inventoryDelta = {
    baseAsset: base,
    baseDelta: accounting.baseDeltaCanonical.toFixed(),
    quoteAsset: quote,
    quoteDelta: accounting.quoteDelta.toFixed(),
  };
  const previousInventoryDelta = execution.inventory_delta_json
    ? (JSON.parse(execution.inventory_delta_json) as unknown)
    : null;
  const alreadyCorrect =
    previousInventoryDelta !== null &&
    JSON.stringify(previousInventoryDelta) === JSON.stringify(inventoryDelta) &&
    metadata.feeAmount === (fee?.toFixed() ?? null) &&
    metadata.feeCurrency === (feeCurrency ?? null);
  if (alreadyCorrect) {
    return {
      status: 'ALREADY_CORRECT',
      batchId: input.batchId,
      executionId: execution.id,
      orderId: order.venue_order_id,
      feeAmount: fee?.toFixed() ?? '0',
      feeCurrency: feeCurrency ?? null,
      feeTreatment: accounting.feeTreatment,
      previousInventoryDelta,
      inventoryDelta,
      repairedAt: new Date(now).toISOString(),
    };
  }

  input.repository.recordOrder({
    venueId: order.venue_id,
    ...(order.venue_order_id ? { venueOrderId: order.venue_order_id } : {}),
    clientOrderId: order.client_order_id,
    executionId: execution.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    price: new Decimal(order.price),
    amount: new Decimal(order.amount),
    filledAmount: filled,
    averagePrice,
    ...(fee ? { fee } : {}),
    ...(feeCurrency ? { feeCurrency } : {}),
    status: order.status,
    now,
  });
  input.repository.updateExecutionLeg(order.client_order_id, {
    status: 'filled',
    filledAmount: filled,
    averageFillPrice: averagePrice,
    ...(fee ? { feePaid: fee } : {}),
    ...(order.venue_order_id ? { orderId: order.venue_order_id } : {}),
  });
  input.repository.updateExecutionStatus(execution.id, 'CLOSED', {
    fees: accounting.feeValueQuote,
    inventoryDelta,
    metadata: {
      ...metadata,
      netBaseCanonical: accounting.baseDeltaCanonical.toFixed(),
      grossQuote: accounting.grossQuote.toFixed(),
      quoteSpent: accounting.quoteDelta.negated().toFixed(),
      feeAmount: fee?.toFixed() ?? null,
      feeCurrency: feeCurrency ?? null,
      feeTreatment: accounting.feeTreatment,
      feeValueQuote: accounting.feeValueQuote.toFixed(),
      accountingSource: 'order_fee',
      accountingRepair: {
        repairedAt: new Date(now).toISOString(),
        previousInventoryDelta,
        reason: 'seed fee asset was not included in original inventory attribution',
      },
    },
  });
  input.repository.recordAudit(
    'executor',
    'inventory_seed_accounting_repaired',
    {
      batchId: input.batchId,
      executionId: execution.id,
      orderId: order.venue_order_id,
      previousInventoryDelta,
      inventoryDelta,
      feeAmount: fee?.toFixed() ?? null,
      feeCurrency: feeCurrency ?? null,
      feeTreatment: accounting.feeTreatment,
    },
    now,
  );
  input.repository.recordRiskEvent(
    'warning',
    'inventory_seed_accounting_repaired',
    'closed SEED accounting was repaired without changing the order or kill switch',
    {
      batchId: input.batchId,
      executionId: execution.id,
      orderId: order.venue_order_id,
      feeAmount: fee?.toFixed() ?? null,
      feeCurrency: feeCurrency ?? null,
      baseDelta: inventoryDelta.baseDelta,
      quoteDelta: inventoryDelta.quoteDelta,
    },
    now,
  );
  return {
    status: 'REPAIRED',
    batchId: input.batchId,
    executionId: execution.id,
    orderId: order.venue_order_id,
    feeAmount: fee?.toFixed() ?? '0',
    feeCurrency: feeCurrency ?? null,
    feeTreatment: accounting.feeTreatment,
    previousInventoryDelta,
    inventoryDelta,
    repairedAt: new Date(now).toISOString(),
  };
}
