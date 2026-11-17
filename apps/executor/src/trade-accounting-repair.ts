import { Decimal, ZERO } from '@arb/core';
import type { ArbitrageRepository } from '@arb/storage';

export interface ClosedTradeOrderRow {
  side: string;
  symbol: string;
  filledAmount: string;
  averagePrice: string | null;
  price: string;
  fee: string | null;
  feeCurrency: string | null;
}

export interface ClosedTradeAccounting {
  baseAsset: string;
  quoteAsset: string;
  grossSpread: Decimal;
  buyFeeQuote: Decimal;
  sellFeeQuote: Decimal;
  netFeesQuote: Decimal;
  realizedProfit: Decimal;
  baseDelta: Decimal;
  quoteDelta: Decimal;
}

function splitSymbol(symbol: string): { base: string; quote: string } {
  const [base, quote] = symbol.split('/');
  if (!base || !quote) throw new Error(`cannot parse symbol: ${symbol}`);
  return { base: base.trim().toUpperCase(), quote: quote.trim().toUpperCase() };
}

function feeInQuote(input: {
  fee: Decimal;
  feeCurrency: string | null;
  base: string;
  quote: string;
  price: Decimal;
}): Decimal {
  if (!input.fee.gt(0)) return ZERO;
  const currency = input.feeCurrency?.trim().toUpperCase();
  if (!currency || currency === input.quote) return input.fee;
  if (currency === input.base) return input.fee.mul(input.price);
  throw new Error(`unsupported fee currency: ${input.feeCurrency}`);
}

function baseFeeAmount(input: { fee: Decimal; feeCurrency: string | null; base: string }): Decimal {
  if (!input.fee.gt(0)) return ZERO;
  return input.feeCurrency?.trim().toUpperCase() === input.base ? input.fee : ZERO;
}

export function computeClosedS1Accounting(
  orders: readonly ClosedTradeOrderRow[],
): ClosedTradeAccounting {
  if (orders.length !== 2) throw new Error('closed S1 repair requires exactly two orders');
  const buy = orders.find((order) => order.side === 'buy');
  const sell = orders.find((order) => order.side === 'sell');
  if (!buy || !sell) throw new Error('closed S1 repair requires one buy and one sell');
  const buyMarket = splitSymbol(buy.symbol);
  const sellMarket = splitSymbol(sell.symbol);
  if (buyMarket.base !== sellMarket.base || buyMarket.quote !== sellMarket.quote) {
    throw new Error('buy and sell legs use different markets');
  }
  const buyFilled = new Decimal(buy.filledAmount);
  const sellFilled = new Decimal(sell.filledAmount);
  if (!buyFilled.gt(0) || !sellFilled.gt(0)) throw new Error('order fill amount is missing');
  const buyPrice = new Decimal(buy.averagePrice ?? buy.price);
  const sellPrice = new Decimal(sell.averagePrice ?? sell.price);
  if (!buyPrice.gt(0) || !sellPrice.gt(0)) throw new Error('order price is missing');
  const buyFee = new Decimal(buy.fee ?? 0);
  const sellFee = new Decimal(sell.fee ?? 0);
  const buyFeeQuote = feeInQuote({
    fee: buyFee,
    feeCurrency: buy.feeCurrency,
    base: buyMarket.base,
    quote: buyMarket.quote,
    price: buyPrice,
  });
  const sellFeeQuote = feeInQuote({
    fee: sellFee,
    feeCurrency: sell.feeCurrency,
    base: sellMarket.base,
    quote: sellMarket.quote,
    price: sellPrice,
  });
  const grossSpread = sellPrice.mul(sellFilled).minus(buyPrice.mul(buyFilled));
  const realizedProfit = grossSpread.minus(buyFeeQuote).minus(sellFeeQuote);
  const baseDelta = buyFilled
    .minus(
      baseFeeAmount({
        fee: buyFee,
        feeCurrency: buy.feeCurrency,
        base: buyMarket.base,
      }),
    )
    .minus(sellFilled);
  return {
    baseAsset: buyMarket.base,
    quoteAsset: buyMarket.quote,
    grossSpread,
    buyFeeQuote,
    sellFeeQuote,
    netFeesQuote: buyFeeQuote.plus(sellFeeQuote),
    realizedProfit,
    baseDelta,
    quoteDelta: realizedProfit,
  };
}

export interface TradeAccountingRepairResult {
  status: 'REPAIRED' | 'ALREADY_CORRECT';
  batchId: string;
  executionId: number;
  previousRealizedProfit: string | null;
  realizedProfit: string;
  netFeesQuote: string;
  inventoryDelta: {
    baseAsset: string;
    baseDelta: string;
    quoteAsset: string;
    quoteDelta: string;
  };
  repairedAt: string;
}

export function repairClosedS1Accounting(input: {
  repository: ArbitrageRepository;
  batchId: string;
  now?: number;
}): TradeAccountingRepairResult {
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
  if (execution.strategy !== 'S1') throw new Error('execution is not S1');
  if (execution.status !== 'CLOSED' || execution.closed_at === null) {
    throw new Error(`execution is ${execution.status}, not a closed S1`);
  }
  const orders = input.repository.db
    .prepare(
      `SELECT side, symbol, filled_amount, average_price, price, fee, fee_currency
       FROM orders WHERE execution_id = ? ORDER BY id`,
    )
    .all(execution.id) as Array<{
    side: string;
    symbol: string;
    filled_amount: string;
    average_price: string | null;
    price: string;
    fee: string | null;
    fee_currency: string | null;
  }>;
  const accounting = computeClosedS1Accounting(
    orders.map((order) => ({
      side: order.side,
      symbol: order.symbol,
      filledAmount: order.filled_amount,
      averagePrice: order.average_price,
      price: order.price,
      fee: order.fee,
      feeCurrency: order.fee_currency,
    })),
  );
  const inventoryDelta = {
    baseAsset: accounting.baseAsset,
    baseDelta: accounting.baseDelta.toFixed(),
    quoteAsset: accounting.quoteAsset,
    quoteDelta: accounting.quoteDelta.toFixed(),
  };
  const previousRealizedProfit = execution.realized_profit;
  const previousInventoryDelta = execution.inventory_delta_json
    ? (JSON.parse(execution.inventory_delta_json) as unknown)
    : null;
  const metadata = execution.metadata_json
    ? (JSON.parse(execution.metadata_json) as Record<string, unknown>)
    : {};
  const alreadyCorrect =
    previousRealizedProfit !== null &&
    new Decimal(previousRealizedProfit).eq(accounting.realizedProfit) &&
    previousInventoryDelta !== null &&
    JSON.stringify(previousInventoryDelta) === JSON.stringify(inventoryDelta) &&
    metadata.profitAccounting === 'order_fee_repaired';
  if (alreadyCorrect) {
    return {
      status: 'ALREADY_CORRECT',
      batchId: input.batchId,
      executionId: execution.id,
      previousRealizedProfit,
      realizedProfit: accounting.realizedProfit.toFixed(),
      netFeesQuote: accounting.netFeesQuote.toFixed(),
      inventoryDelta,
      repairedAt: new Date(now).toISOString(),
    };
  }
  const previousProfitValue =
    previousRealizedProfit === null ? ZERO : new Decimal(previousRealizedProfit);
  const previousLoss = previousProfitValue.lt(0) ? previousProfitValue.abs() : ZERO;
  const newLoss = accounting.realizedProfit.lt(0) ? accounting.realizedProfit.abs() : ZERO;
  const riskDelta = newLoss.minus(previousLoss);
  input.repository.updateExecutionStatus(execution.id, 'CLOSED', {
    realizedProfit: accounting.realizedProfit,
    grossSpread: accounting.grossSpread,
    fees: accounting.netFeesQuote,
    inventoryDelta,
    metadata: {
      ...metadata,
      profitAccounting: 'order_fee_repaired',
      buyFeeQuote: accounting.buyFeeQuote.toFixed(),
      sellFeeQuote: accounting.sellFeeQuote.toFixed(),
      accountingRepair: {
        repairedAt: new Date(now).toISOString(),
        previousRealizedProfit,
        riskDelta: riskDelta.toFixed(),
        reason: 'fee currency was not converted to quote in the original fallback',
      },
    },
  });
  input.repository.adjustRealizedLoss(riskDelta, execution.closed_at);
  input.repository.recordAudit(
    'executor',
    'trade_accounting_repaired',
    {
      batchId: input.batchId,
      executionId: execution.id,
      previousRealizedProfit,
      realizedProfit: accounting.realizedProfit.toFixed(),
      netFeesQuote: accounting.netFeesQuote.toFixed(),
      inventoryDelta,
    },
    now,
  );
  input.repository.recordRiskEvent(
    'warning',
    'trade_accounting_repaired',
    'closed S1 accounting was repaired from order fees without changing orders or the kill switch',
    {
      batchId: input.batchId,
      executionId: execution.id,
      previousRealizedProfit,
      realizedProfit: accounting.realizedProfit.toFixed(),
    },
    now,
  );
  return {
    status: 'REPAIRED',
    batchId: input.batchId,
    executionId: execution.id,
    previousRealizedProfit,
    realizedProfit: accounting.realizedProfit.toFixed(),
    netFeesQuote: accounting.netFeesQuote.toFixed(),
    inventoryDelta,
    repairedAt: new Date(now).toISOString(),
  };
}

export interface RiskAdjustmentRepairResult {
  status: 'REPAIRED' | 'ALREADY_CORRECT';
  batchId: string;
  executionId: number;
  previousRealizedProfit: string;
  realizedProfit: string;
  wrongAdjustment: string;
  correctAdjustment: string;
  remainingAdjustment: string;
  repairedAt: string;
}

/**
 * Correct a daily realized-loss adjustment that was previously applied with
 * `newProfit - oldProfit` instead of `newLoss - oldLoss`. This is only for
 * records that already contain accountingRepair.previousRealizedProfit.
 */
export function repairS1RiskAdjustment(input: {
  repository: ArbitrageRepository;
  batchId: string;
  now?: number;
}): RiskAdjustmentRepairResult {
  const now = input.now ?? Date.now();
  const execution = input.repository.db
    .prepare(
      `SELECT id, strategy, status, closed_at, realized_profit, metadata_json
       FROM executions WHERE batch_id = ?`,
    )
    .get(input.batchId) as
    | {
        id: number;
        strategy: string;
        status: string;
        closed_at: number | null;
        realized_profit: string | null;
        metadata_json: string | null;
      }
    | undefined;
  if (!execution) throw new Error(`execution not found: ${input.batchId}`);
  if (execution.strategy !== 'S1') throw new Error('execution is not S1');
  if (execution.status !== 'CLOSED' || execution.closed_at === null) {
    throw new Error(`execution is ${execution.status}, not a closed S1`);
  }
  if (execution.realized_profit === null) throw new Error('realized profit is missing');
  const metadata = execution.metadata_json
    ? (JSON.parse(execution.metadata_json) as Record<string, unknown>)
    : {};
  const repair = metadata.accountingRepair as Record<string, unknown> | undefined;
  if (!repair || typeof repair.previousRealizedProfit !== 'string') {
    throw new Error('accounting repair metadata is missing');
  }
  if (repair.riskCorrected === true) {
    return {
      status: 'ALREADY_CORRECT',
      batchId: input.batchId,
      executionId: execution.id,
      previousRealizedProfit: repair.previousRealizedProfit,
      realizedProfit: execution.realized_profit,
      wrongAdjustment: '0',
      correctAdjustment: '0',
      remainingAdjustment: '0',
      repairedAt: new Date(now).toISOString(),
    };
  }
  const previousProfit = new Decimal(repair.previousRealizedProfit);
  const currentProfit = new Decimal(execution.realized_profit);
  const previousLoss = previousProfit.lt(0) ? previousProfit.abs() : ZERO;
  const newLoss = currentProfit.lt(0) ? currentProfit.abs() : ZERO;
  const wrongAdjustment = currentProfit.minus(previousProfit);
  const correctAdjustment = newLoss.minus(previousLoss);
  const remainingAdjustment = correctAdjustment.minus(wrongAdjustment);
  input.repository.adjustRealizedLoss(remainingAdjustment, execution.closed_at);
  input.repository.updateExecutionStatus(execution.id, 'CLOSED', {
    metadata: {
      ...metadata,
      accountingRepair: {
        ...repair,
        riskCorrected: true,
        riskCorrection: remainingAdjustment.toFixed(),
        riskCorrectedAt: new Date(now).toISOString(),
      },
    },
  });
  input.repository.recordAudit(
    'executor',
    'trade_risk_adjustment_repaired',
    {
      batchId: input.batchId,
      executionId: execution.id,
      wrongAdjustment: wrongAdjustment.toFixed(),
      correctAdjustment: correctAdjustment.toFixed(),
      remainingAdjustment: remainingAdjustment.toFixed(),
    },
    now,
  );
  input.repository.recordRiskEvent(
    'warning',
    'trade_risk_adjustment_repaired',
    'daily realized loss was corrected from profit delta to loss delta',
    {
      batchId: input.batchId,
      executionId: execution.id,
      remainingAdjustment: remainingAdjustment.toFixed(),
    },
    now,
  );
  return {
    status: 'REPAIRED',
    batchId: input.batchId,
    executionId: execution.id,
    previousRealizedProfit: repair.previousRealizedProfit,
    realizedProfit: execution.realized_profit,
    wrongAdjustment: wrongAdjustment.toFixed(),
    correctAdjustment: correctAdjustment.toFixed(),
    remainingAdjustment: remainingAdjustment.toFixed(),
    repairedAt: new Date(now).toISOString(),
  };
}
