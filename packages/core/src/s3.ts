import {
  Decimal,
  ZERO,
  calculateNetProfitBps,
  calculateSafetyBuffer,
  bps as toBps,
} from './money.js';
import { calculateBuyDepthByBase, calculateSellDepthByBase } from './depth.js';
import { alignAmountDown, isAligned } from './precision.js';
import { validateOrderBook } from './orderbook.js';
import type {
  CostSettings,
  DexQuote,
  MarketMetadata,
  OpportunityResult,
  OrderBookSnapshot,
  RejectionReason,
  TokenRiskLevel,
} from './types.js';

export interface TokenEligibility {
  mappingStatus: 'candidate' | 'active' | 'rejected';
  riskLevel: TokenRiskLevel;
  verifiedContract: boolean;
  contractAddress: string;
  transferTaxBps: Decimal;
  transferRequired: boolean;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee?: Decimal;
  minWithdrawAmount?: Decimal;
  minDepositAmount?: Decimal;
  canArriveQuickly?: boolean;
  estimatedArrivalMs?: number;
  liquidityUsd?: Decimal;
  volume24hUsd?: Decimal;
}

export interface S3Input {
  direction: 'cex-buy-dex-sell' | 'dex-buy-cex-sell';
  base: string;
  quote: string;
  cexMarket: MarketMetadata;
  cexBook: OrderBookSnapshot;
  dexQuote: DexQuote;
  quoteTokenContractAddress: string;
  requestedNotional: Decimal;
  token: TokenEligibility;
  settings: CostSettings;
  now: number;
  inventoryMode: boolean;
  requireExecutionRisk?: boolean;
  gasCostUsd?: Decimal;
  maxTransferArrivalMs?: number;
}

const DEFAULT_MIN_POOL_LIQUIDITY_USD = new Decimal(50_000);
const DEFAULT_MIN_POOL_VOLUME_USD = new Decimal(50_000);
const GAS_SAFETY_MULTIPLIER = new Decimal('1.25');

function safeNonNegative(value: Decimal): boolean {
  return value.isFinite() && value.gte(0);
}

function safePositive(value: Decimal): boolean {
  return value.isFinite() && value.gt(0);
}

function validContractAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(value.trim());
}

function hasValidSettings(settings: CostSettings): boolean {
  const nonNegative = [
    settings.safetyBufferBps,
    settings.minProfitUsd,
    settings.maxSlippageBps,
    settings.maxGasCostUsd,
    settings.maxTransferTaxBps,
    settings.minPoolLiquidityUsd,
    settings.minPool24hVolumeUsd,
    settings.transferRiskBufferBps,
    settings.depositRiskBufferBps,
  ];
  return (
    Number.isFinite(settings.maxOrderbookAgeMs) &&
    settings.maxOrderbookAgeMs >= 0 &&
    settings.minNetProfitBps.isFinite() &&
    settings.minNetProfitBps.gte(0) &&
    nonNegative.every((value) => value === undefined || safeNonNegative(value))
  );
}

function quoteFresh(quote: DexQuote, now: number, maxAgeMs: number): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(quote.quotedAt) || quote.quotedAt <= 0) {
    return false;
  }
  if (
    quote.validUntil !== undefined &&
    (!Number.isFinite(quote.validUntil) || quote.validUntil <= 0)
  ) {
    return false;
  }
  if (now - quote.quotedAt > maxAgeMs || now < quote.quotedAt - 250) return false;
  if (quote.validUntil !== undefined && now > quote.validUntil) return false;
  return true;
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function quoteReasons(input: S3Input, reasons: RejectionReason[]): void {
  const quote = input.dexQuote;
  if (quote.chain !== 'BSC') reasons.push('quote_mismatch');
  if (!quoteFresh(quote, input.now, input.settings.maxOrderbookAgeMs)) {
    reasons.push('quote_not_fresh');
  }
  if (!safeNonNegative(quote.expectedSlippageBps)) {
    reasons.push('slippage_too_high');
  } else if (quote.expectedSlippageBps.gt(input.settings.maxSlippageBps)) {
    reasons.push('slippage_too_high');
  }
  if (!safeNonNegative(quote.priceImpactBps)) {
    reasons.push('price_impact_unavailable');
  } else if (quote.priceImpactBps.gt(input.settings.maxSlippageBps)) {
    reasons.push('price_impact_too_high');
  }
  if (!safeNonNegative(quote.feeBps)) reasons.push('fee_not_configured');
  if (!safePositive(quote.sellAmount) || !safePositive(quote.buyAmount)) {
    reasons.push('quote_mismatch');
  }
  if (
    !safePositive(quote.gasEstimate) ||
    !safePositive(quote.gasPrice) ||
    !safePositive(quote.gasCostUsd)
  ) {
    reasons.push('gas_estimate_missing');
  }

  const tokenAddress = normalized(input.token.contractAddress);
  const quoteAddress = normalized(input.quoteTokenContractAddress);
  if (!validContractAddress(tokenAddress) || !validContractAddress(quoteAddress)) {
    reasons.push('quote_mismatch');
  }
  if (input.direction === 'cex-buy-dex-sell') {
    if (
      normalized(quote.sellToken) !== tokenAddress ||
      normalized(quote.buyToken) !== quoteAddress
    ) {
      reasons.push('quote_mismatch');
    }
  } else if (
    normalized(quote.sellToken) !== quoteAddress ||
    normalized(quote.buyToken) !== tokenAddress
  ) {
    reasons.push('quote_mismatch');
  }
}

function tokenReasons(
  token: TokenEligibility,
  settings: CostSettings,
  direction: S3Input['direction'],
  inventoryMode: boolean,
  requireExecutionRisk: boolean,
  maxTransferArrivalMs: number | undefined,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (token.mappingStatus !== 'active' || !token.verifiedContract) {
    reasons.push('token_not_verified');
  }
  if (token.riskLevel === 'high' || token.riskLevel === 'blocked') {
    reasons.push('token_risk_too_high');
  }
  if (requireExecutionRisk && token.riskLevel !== 'low') reasons.push('token_risk_too_high');
  if (
    !safeNonNegative(token.transferTaxBps) ||
    token.transferTaxBps.gt(settings.maxTransferTaxBps) ||
    token.transferTaxBps.gt(10_000)
  ) {
    reasons.push('transfer_tax_too_high');
  }

  const minLiquidity = settings.minPoolLiquidityUsd ?? DEFAULT_MIN_POOL_LIQUIDITY_USD;
  const minVolume = settings.minPool24hVolumeUsd ?? DEFAULT_MIN_POOL_VOLUME_USD;
  if (token.liquidityUsd === undefined || !safeNonNegative(token.liquidityUsd)) {
    reasons.push('liquidity_data_unavailable');
  } else if (token.liquidityUsd.lt(minLiquidity)) reasons.push('liquidity_below_minimum');
  if (token.volume24hUsd === undefined || !safeNonNegative(token.volume24hUsd)) {
    reasons.push('volume_data_unavailable');
  } else if (token.volume24hUsd.lt(minVolume)) reasons.push('volume_below_minimum');

  if (token.transferRequired) {
    if (inventoryMode) reasons.push('transfer_disabled');
    if (direction === 'cex-buy-dex-sell' && !token.withdrawEnabled) {
      reasons.push('transfer_disabled');
    }
    if (direction === 'dex-buy-cex-sell' && !token.depositEnabled) {
      reasons.push('transfer_disabled');
    }
    if (
      direction === 'cex-buy-dex-sell' &&
      (token.withdrawFee === undefined || !safeNonNegative(token.withdrawFee))
    ) {
      reasons.push('withdrawal_fee_unavailable');
    }
    if (
      token.minWithdrawAmount !== undefined &&
      (!safeNonNegative(token.minWithdrawAmount) || token.minWithdrawAmount.lte(0))
    ) {
      reasons.push('invalid_request');
    }
    if (token.canArriveQuickly !== true) reasons.push('transfer_disabled');
    if (
      maxTransferArrivalMs === undefined ||
      !Number.isFinite(maxTransferArrivalMs) ||
      maxTransferArrivalMs < 0
    ) {
      reasons.push('invalid_request');
    } else if (
      token.estimatedArrivalMs === undefined ||
      !Number.isFinite(token.estimatedArrivalMs) ||
      token.estimatedArrivalMs < 0 ||
      token.estimatedArrivalMs > maxTransferArrivalMs
    ) {
      reasons.push('opportunity_expired');
    }
    if (
      direction === 'cex-buy-dex-sell' &&
      (token.minWithdrawAmount === undefined || !safePositive(token.minWithdrawAmount))
    ) {
      reasons.push('invalid_request');
    }
    if (
      direction === 'dex-buy-cex-sell' &&
      (token.minDepositAmount === undefined || !safePositive(token.minDepositAmount))
    ) {
      reasons.push('invalid_request');
    }
  }
  return reasons;
}

function applyBps(amount: Decimal, bpsValues: Decimal[]): Decimal {
  return bpsValues.reduce(
    (current, value) => current.mul(new Decimal(1).minus(toBps(value))),
    amount,
  );
}

export function evaluateS3(input: S3Input): OpportunityResult {
  const reasons = tokenReasons(
    input.token,
    input.settings,
    input.direction,
    input.inventoryMode,
    input.requireExecutionRisk ?? false,
    input.maxTransferArrivalMs,
  );
  if (input.inventoryMode === input.token.transferRequired) {
    reasons.push('invalid_request');
  }
  if (!input.requestedNotional.isFinite() || input.requestedNotional.lte(0)) {
    reasons.push('invalid_request');
  }
  if (!Number.isFinite(input.now) || input.now <= 0) reasons.push('invalid_request');
  if (!hasValidSettings(input.settings)) reasons.push('invalid_request');
  if (!input.cexMarket.active) reasons.push('market_inactive');
  if (
    input.cexMarket.amountStep &&
    (!input.cexMarket.amountStep.isFinite() || input.cexMarket.amountStep.lte(0))
  ) {
    reasons.push('amount_precision_invalid');
  }
  if (
    !input.cexMarket.priceStep ||
    !input.cexMarket.priceStep.isFinite() ||
    input.cexMarket.priceStep.lte(0)
  ) {
    reasons.push('price_precision_invalid');
  }
  if (
    (input.cexMarket.minAmount &&
      (!safeNonNegative(input.cexMarket.minAmount) || input.cexMarket.minAmount.lte(0))) ||
    (input.cexMarket.minNotional &&
      (!safeNonNegative(input.cexMarket.minNotional) || input.cexMarket.minNotional.lte(0)))
  ) {
    reasons.push('invalid_request');
  }
  quoteReasons(input, reasons);
  if (
    input.cexMarket.base.trim().toUpperCase() !== input.base.trim().toUpperCase() ||
    input.cexMarket.quote.trim().toUpperCase() !== input.quote.trim().toUpperCase() ||
    input.base.trim() === '' ||
    input.quote.trim() === ''
  ) {
    reasons.push('quote_mismatch');
  }
  if (input.cexMarket.feeTakerBps === undefined || !safeNonNegative(input.cexMarket.feeTakerBps)) {
    reasons.push('fee_not_configured');
  }

  const bookValidation = validateOrderBook(input.cexBook, {
    expectedVenueId: input.cexMarket.venueId,
    expectedSymbol: input.cexMarket.exchangeSymbol,
    maxAgeMs: input.settings.maxOrderbookAgeMs,
    now: input.now,
  });
  if (!bookValidation.valid) {
    reasons.push('invalid_orderbook');
    if (
      bookValidation.reasons.some(
        (reason) => reason === 'stale_orderbook' || reason === 'exchange_timestamp_stale',
      )
    ) {
      reasons.push('stale_orderbook');
    }
    if (bookValidation.reasons.includes('crossed_orderbook')) reasons.push('crossed_orderbook');
  }

  const rawGas = input.gasCostUsd ?? input.dexQuote.gasCostUsd;
  const gas = rawGas.mul(GAS_SAFETY_MULTIPLIER);
  if (!safePositive(rawGas) || !gas.isFinite()) {
    reasons.push('gas_estimate_missing');
  } else if (gas.gt(input.settings.maxGasCostUsd)) {
    reasons.push('gas_too_high');
  }

  const baseResult: OpportunityResult = {
    strategy: 'S3',
    opportunityKey: `S3|${input.base}/${input.quote}|${input.direction}|${input.cexMarket.venueId}|${input.dexQuote.providerId}`,
    instrumentKey: `${input.base}/${input.quote}`,
    direction: input.direction,
    venueBuy:
      input.direction === 'cex-buy-dex-sell' ? input.cexMarket.venueId : input.dexQuote.providerId,
    venueSell:
      input.direction === 'cex-buy-dex-sell' ? input.dexQuote.providerId : input.cexMarket.venueId,
    instrumentBuy: input.base,
    instrumentSell: input.base,
    requestedNotional: input.requestedNotional,
    grossSpread: ZERO,
    totalCost: ZERO,
    depthNetProfit: ZERO,
    conservativeNetProfit: ZERO,
    netProfitBps: ZERO,
    dataAgeMs: Math.max(
      Math.max(0, input.now - input.cexBook.fetchedAt),
      Math.max(0, input.now - input.dexQuote.quotedAt),
    ),
    valid: false,
    rejectionReasons: [...new Set(reasons)],
    sampledAt: input.now,
    metadata: {
      inventoryMode: String(input.inventoryMode),
      transferRequired: String(input.token.transferRequired),
      gasCostUsd: gas.toFixed(),
      rawGasCostUsd: rawGas.toFixed(),
      gasMultiplier: GAS_SAFETY_MULTIPLIER.toFixed(),
    },
  };
  if (reasons.length > 0) return baseResult;

  const feeBps = input.cexMarket.feeTakerBps!;
  const validatedBook = bookValidation.valid ? bookValidation.book : input.cexBook;
  const tokenTransferTax = new Decimal(1).minus(toBps(input.token.transferTaxBps));
  const transferRiskBps = input.settings.transferRiskBufferBps ?? ZERO;
  const depositRiskBps = input.settings.depositRiskBufferBps ?? transferRiskBps;
  let grossSpread = ZERO;
  let depthNet = ZERO;
  let expectedBuyPrice: Decimal | undefined;
  let expectedSellPrice: Decimal | undefined;
  let cexFill: Record<string, unknown> = {};
  let dexFill: Record<string, unknown> = {};
  let transferCosts: Record<string, unknown> = {};

  if (input.direction === 'cex-buy-dex-sell') {
    const amountStep = input.cexMarket.amountStep ?? new Decimal(1);
    const requestedBase = alignAmountDown(input.dexQuote.sellAmount, amountStep);
    if (!requestedBase.gt(0)) reasons.push('amount_precision_invalid');
    const cexBuy = calculateBuyDepthByBase(validatedBook, requestedBase);
    if (cexBuy.insufficientDepth) reasons.push('insufficient_depth');
    if (!isAligned(cexBuy.worstPrice, input.cexMarket.priceStep!)) {
      reasons.push('price_precision_invalid');
    }
    if (cexBuy.executableQuoteAmount.gt(input.requestedNotional)) {
      reasons.push('quote_mismatch');
    }
    if (input.cexMarket.minAmount && requestedBase.lt(input.cexMarket.minAmount)) {
      reasons.push('below_min_notional');
    }
    if (
      input.cexMarket.minNotional &&
      cexBuy.executableQuoteAmount.lt(input.cexMarket.minNotional)
    ) {
      reasons.push('below_min_notional');
    }

    const withdrawFee = input.token.transferRequired ? (input.token.withdrawFee ?? ZERO) : ZERO;
    if (
      input.token.transferRequired &&
      input.token.minWithdrawAmount &&
      requestedBase.lt(input.token.minWithdrawAmount)
    ) {
      reasons.push('below_min_notional');
    }
    const tokenAfterSwap = requestedBase.mul(tokenTransferTax).minus(withdrawFee);
    if (!tokenAfterSwap.gt(0)) reasons.push('insufficient_depth');
    const quoteScale = input.dexQuote.sellAmount.gt(0)
      ? tokenAfterSwap.div(input.dexQuote.sellAmount)
      : ZERO;
    const dexGross = input.dexQuote.buyAmount.mul(quoteScale);
    const dexNet = applyBps(dexGross, [
      input.dexQuote.feeBps,
      input.dexQuote.priceImpactBps,
      input.dexQuote.expectedSlippageBps,
    ]);
    const riskBuffer = input.token.transferRequired
      ? input.requestedNotional.mul(toBps(transferRiskBps))
      : ZERO;
    const cexFee = cexBuy.executableQuoteAmount.mul(toBps(feeBps));
    const cexCost = cexBuy.executableQuoteAmount.plus(cexFee);

    grossSpread = dexGross.minus(cexBuy.executableQuoteAmount);
    depthNet = dexNet.minus(cexCost).minus(gas).minus(riskBuffer);
    expectedBuyPrice = cexBuy.averagePrice;
    expectedSellPrice = tokenAfterSwap.gt(0) ? dexNet.div(tokenAfterSwap) : undefined;
    cexFill = {
      venueId: input.cexMarket.venueId,
      symbol: input.cexMarket.exchangeSymbol,
      side: 'buy',
      requestedBaseAmount: input.dexQuote.sellAmount.toFixed(),
      executableBaseAmount: cexBuy.executableBaseAmount.toFixed(),
      executableQuoteAmount: cexBuy.executableQuoteAmount.toFixed(),
      averagePrice: cexBuy.averagePrice.toFixed(),
      worstPrice: cexBuy.worstPrice.toFixed(),
      levelsConsumed: cexBuy.levelsConsumed,
      feeUsd: cexFee.toFixed(),
    };
    dexFill = {
      providerId: input.dexQuote.providerId,
      sellToken: input.dexQuote.sellToken,
      buyToken: input.dexQuote.buyToken,
      sellAmount: input.dexQuote.sellAmount.toFixed(),
      buyAmount: input.dexQuote.buyAmount.toFixed(),
      adjustedTokenInput: tokenAfterSwap.toFixed(),
      grossQuoteOutput: dexGross.toFixed(),
      netQuoteOutput: dexNet.toFixed(),
      feeBps: input.dexQuote.feeBps.toFixed(),
      priceImpactBps: input.dexQuote.priceImpactBps.toFixed(),
      expectedSlippageBps: input.dexQuote.expectedSlippageBps.toFixed(),
      gasEstimate: input.dexQuote.gasEstimate.toFixed(),
      gasPrice: input.dexQuote.gasPrice.toFixed(),
      gasCostUsd: input.dexQuote.gasCostUsd.toFixed(),
    };
    transferCosts = {
      transferRequired: input.token.transferRequired,
      transferTaxBps: input.token.transferTaxBps.toFixed(),
      withdrawFee: withdrawFee.toFixed(),
      withdrawFeeCurrency: input.base,
      canArriveQuickly: input.token.canArriveQuickly === true,
      estimatedArrivalMs: input.token.estimatedArrivalMs ?? null,
      maxTransferArrivalMs: input.maxTransferArrivalMs ?? null,
      transferRiskBufferBps: transferRiskBps.toFixed(),
      transferRiskBufferUsd: riskBuffer.toFixed(),
    };
  } else {
    if (input.dexQuote.sellAmount.minus(input.requestedNotional).abs().gt('0.000001')) {
      reasons.push('quote_mismatch');
    }
    const dexTokenOutput = applyBps(input.dexQuote.buyAmount.mul(tokenTransferTax), [
      input.dexQuote.feeBps,
      input.dexQuote.priceImpactBps,
      input.dexQuote.expectedSlippageBps,
    ]);
    const amountStep = input.cexMarket.amountStep ?? new Decimal(1);
    const sellAmount = alignAmountDown(dexTokenOutput, amountStep);
    if (!sellAmount.gt(0)) reasons.push('amount_precision_invalid');
    if (
      input.token.transferRequired &&
      input.token.minDepositAmount &&
      dexTokenOutput.lt(input.token.minDepositAmount)
    ) {
      reasons.push('below_min_notional');
    }
    if (input.cexMarket.minAmount && sellAmount.lt(input.cexMarket.minAmount)) {
      reasons.push('below_min_notional');
    }
    const cexSell = calculateSellDepthByBase(validatedBook, sellAmount);
    if (cexSell.insufficientDepth) reasons.push('insufficient_depth');
    if (!isAligned(cexSell.worstPrice, input.cexMarket.priceStep!)) {
      reasons.push('price_precision_invalid');
    }
    if (
      input.cexMarket.minNotional &&
      cexSell.executableQuoteAmount.lt(input.cexMarket.minNotional)
    ) {
      reasons.push('below_min_notional');
    }
    const cexFee = cexSell.executableQuoteAmount.mul(toBps(feeBps));
    const cexNet = cexSell.executableQuoteAmount.minus(cexFee);
    const riskBuffer = input.token.transferRequired
      ? input.requestedNotional.mul(toBps(depositRiskBps))
      : ZERO;
    grossSpread = cexSell.executableQuoteAmount.minus(input.dexQuote.sellAmount);
    depthNet = cexNet.minus(input.dexQuote.sellAmount).minus(gas).minus(riskBuffer);
    expectedBuyPrice = input.dexQuote.buyAmount.gt(0)
      ? input.dexQuote.sellAmount.div(input.dexQuote.buyAmount)
      : undefined;
    expectedSellPrice = cexSell.averagePrice;
    cexFill = {
      venueId: input.cexMarket.venueId,
      symbol: input.cexMarket.exchangeSymbol,
      side: 'sell',
      executableBaseAmount: cexSell.executableBaseAmount.toFixed(),
      executableQuoteAmount: cexSell.executableQuoteAmount.toFixed(),
      averagePrice: cexSell.averagePrice.toFixed(),
      worstPrice: cexSell.worstPrice.toFixed(),
      levelsConsumed: cexSell.levelsConsumed,
      feeUsd: cexFee.toFixed(),
    };
    dexFill = {
      providerId: input.dexQuote.providerId,
      sellToken: input.dexQuote.sellToken,
      buyToken: input.dexQuote.buyToken,
      sellAmount: input.dexQuote.sellAmount.toFixed(),
      buyAmount: input.dexQuote.buyAmount.toFixed(),
      tokenOutputAfterTaxAndFees: dexTokenOutput.toFixed(),
      cexSellAmount: sellAmount.toFixed(),
      feeBps: input.dexQuote.feeBps.toFixed(),
      priceImpactBps: input.dexQuote.priceImpactBps.toFixed(),
      expectedSlippageBps: input.dexQuote.expectedSlippageBps.toFixed(),
      gasEstimate: input.dexQuote.gasEstimate.toFixed(),
      gasPrice: input.dexQuote.gasPrice.toFixed(),
      gasCostUsd: input.dexQuote.gasCostUsd.toFixed(),
    };
    transferCosts = {
      transferRequired: input.token.transferRequired,
      transferTaxBps: input.token.transferTaxBps.toFixed(),
      canArriveQuickly: input.token.canArriveQuickly === true,
      estimatedArrivalMs: input.token.estimatedArrivalMs ?? null,
      maxTransferArrivalMs: input.maxTransferArrivalMs ?? null,
      depositRiskBufferBps: depositRiskBps.toFixed(),
      depositRiskBufferUsd: riskBuffer.toFixed(),
    };
  }

  const safety = calculateSafetyBuffer(
    input.requestedNotional,
    input.settings.safetyBufferBps,
    input.settings.minProfitUsd,
  );
  const conservative = depthNet.minus(safety);
  const totalCost = grossSpread.minus(depthNet).plus(safety);
  const netBps = calculateNetProfitBps(conservative, input.requestedNotional);
  if (reasons.length === 0 && conservative.lte(0)) reasons.push('gross_profit_below_threshold');
  else if (reasons.length === 0 && netBps.lt(input.settings.minNetProfitBps)) {
    reasons.push('conservative_profit_below_threshold');
  }
  const unique = [...new Set(reasons)];
  return {
    ...baseResult,
    grossSpread,
    totalCost,
    depthNetProfit: depthNet,
    conservativeNetProfit: conservative,
    netProfitBps: netBps,
    valid: unique.length === 0,
    rejectionReasons: unique,
    ...(expectedBuyPrice ? { expectedBuyPrice } : {}),
    ...(expectedSellPrice ? { expectedSellPrice } : {}),
    metadata: {
      inventoryMode: String(input.inventoryMode),
      transferRequired: String(input.token.transferRequired),
      transferAssumption: input.inventoryMode
        ? 'existing_inventory_on_both_venues'
        : 'withdraw_or_deposit_required',
      canArriveQuickly: String(input.token.canArriveQuickly === true),
      estimatedArrivalMs: input.token.estimatedArrivalMs?.toString() ?? '',
      maxTransferArrivalMs: input.maxTransferArrivalMs?.toString() ?? '',
      gasCostUsd: gas.toFixed(),
      rawGasCostUsd: rawGas.toFixed(),
      gasMultiplier: GAS_SAFETY_MULTIPLIER.toFixed(),
    },
    fillQuality: {
      strategy: 'S3',
      direction: input.direction,
      cex: cexFill,
      dex: dexFill,
      transfer: transferCosts,
      costs: {
        grossSpread: grossSpread.toFixed(),
        depthNetProfit: depthNet.toFixed(),
        safetyBufferUsd: safety.toFixed(),
        totalCostUsd: totalCost.toFixed(),
        gasCostUsd: gas.toFixed(),
      },
    },
  };
}
