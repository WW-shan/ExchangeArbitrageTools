import { Decimal } from '@arb/core';

export interface ClosedTradeBalances {
  base: Decimal;
  quote: Decimal;
}

export interface ClosedTradeAccountingInput {
  buyBaseFilled: Decimal;
  sellBaseFilled: Decimal;
  buyPrice: Decimal;
  sellPrice: Decimal;
  buyBaseline: ClosedTradeBalances;
  buyFinal: ClosedTradeBalances;
  sellBaseline: ClosedTradeBalances;
  sellFinal: ClosedTradeBalances;
  buyRebatePct: Decimal;
  sellRebatePct: Decimal;
}

export interface ClosedTradeAccounting {
  buyBaseDelta: Decimal;
  buyQuoteDelta: Decimal;
  sellBaseDelta: Decimal;
  sellQuoteDelta: Decimal;
  baseDelta: Decimal;
  quoteDelta: Decimal;
  expectedBuyCost: Decimal;
  expectedSellProceeds: Decimal;
  grossSpread: Decimal;
  markPrice: Decimal;
  cashProfit: Decimal;
  buyGrossFeeQuote: Decimal;
  sellGrossFeeQuote: Decimal;
  grossFeesQuote: Decimal;
  rebateReceivableQuote: Decimal;
  netFeesQuote: Decimal;
  economicProfit: Decimal;
}

function validatePercentage(value: Decimal, label: string): void {
  if (!value.isFinite() || value.lt(0) || value.gt(100)) {
    throw new Error(`${label} must be between 0 and 100`);
  }
}

/**
 * Reconcile a closed two-leg trade from actual balance deltas. Venue fees can be
 * charged in the base asset, the quote asset, or both; balance deltas capture
 * all of them without assuming a fee currency. Rebates are accrued separately
 * because venues may settle them later.
 */
export function accountClosedTrade(input: ClosedTradeAccountingInput): ClosedTradeAccounting {
  if (!input.buyBaseFilled.gt(0) || !input.sellBaseFilled.gt(0)) {
    throw new Error('filled base amounts must be positive');
  }
  if (!input.buyPrice.gt(0) || !input.sellPrice.gt(0)) {
    throw new Error('fill prices must be positive');
  }
  validatePercentage(input.buyRebatePct, 'buy rebate');
  validatePercentage(input.sellRebatePct, 'sell rebate');

  const expectedBuyCost = input.buyPrice.mul(input.buyBaseFilled);
  const expectedSellProceeds = input.sellPrice.mul(input.sellBaseFilled);
  const buyBaseDelta = input.buyFinal.base.minus(input.buyBaseline.base);
  const buyQuoteDelta = input.buyFinal.quote.minus(input.buyBaseline.quote);
  const sellBaseDelta = input.sellFinal.base.minus(input.sellBaseline.base);
  const sellQuoteDelta = input.sellFinal.quote.minus(input.sellBaseline.quote);
  const baseDelta = buyBaseDelta.plus(sellBaseDelta);
  const quoteDelta = buyQuoteDelta.plus(sellQuoteDelta);
  const markPrice = baseDelta.lt(0) ? input.buyPrice : input.sellPrice;
  const cashProfit = quoteDelta.plus(baseDelta.mul(markPrice));
  const grossSpread = expectedSellProceeds.minus(expectedBuyCost);

  const buyGrossFeeQuote = Decimal.max(0, buyQuoteDelta.plus(expectedBuyCost).negated()).plus(
    Decimal.max(0, input.buyBaseFilled.minus(buyBaseDelta)).mul(input.buyPrice),
  );
  const sellGrossFeeQuote = Decimal.max(0, expectedSellProceeds.minus(sellQuoteDelta)).plus(
    Decimal.max(0, sellBaseDelta.plus(input.sellBaseFilled).negated()).mul(input.sellPrice),
  );
  const grossFeesQuote = buyGrossFeeQuote.plus(sellGrossFeeQuote);
  const rebateReceivableQuote = buyGrossFeeQuote
    .mul(input.buyRebatePct)
    .div(100)
    .plus(sellGrossFeeQuote.mul(input.sellRebatePct).div(100));
  const netFeesQuote = grossFeesQuote.minus(rebateReceivableQuote);
  const economicProfit = grossSpread.minus(netFeesQuote);

  return {
    buyBaseDelta,
    buyQuoteDelta,
    sellBaseDelta,
    sellQuoteDelta,
    baseDelta,
    quoteDelta,
    expectedBuyCost,
    expectedSellProceeds,
    grossSpread,
    markPrice,
    cashProfit,
    buyGrossFeeQuote,
    sellGrossFeeQuote,
    grossFeesQuote,
    rebateReceivableQuote,
    netFeesQuote,
    economicProfit,
  };
}
