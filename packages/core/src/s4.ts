import {
  Decimal,
  ZERO,
  calculateNetProfitBps,
  calculateSafetyBuffer,
  bps as toBps,
} from './money.js';
import type {
  CostSettings,
  DexQuote,
  OpportunityResult,
  RejectionReason,
  TokenRiskLevel,
} from './types.js';

export interface S4Input {
  base: string;
  quote: string;
  baseTokenContractAddress: string;
  quoteTokenContractAddress: string;
  buyQuote: DexQuote;
  sellQuote: DexQuote;
  tokenRisk: TokenRiskLevel;
  verifiedContract: boolean;
  transferTaxBps: Decimal;
  requestedNotional: Decimal;
  settings: CostSettings;
  now: number;
}

const GAS_SAFETY_MULTIPLIER = new Decimal('1.25');
const QUOTE_AMOUNT_TOLERANCE = new Decimal('0.0001');

function safeNonNegative(value: Decimal): boolean {
  return value.isFinite() && value.gte(0);
}

function safePositive(value: Decimal): boolean {
  return value.isFinite() && value.gt(0);
}

function hasValidSettings(settings: CostSettings): boolean {
  const nonNegative = [
    settings.safetyBufferBps,
    settings.minProfitUsd,
    settings.maxSlippageBps,
    settings.maxGasCostUsd,
    settings.maxTransferTaxBps,
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

function normalizedAddress(value: string): string {
  return value.trim().toLowerCase();
}

function isContractAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/.test(value);
}

function applyBps(amount: Decimal, values: Decimal[]): Decimal {
  return values.reduce((current, value) => current.mul(new Decimal(1).minus(toBps(value))), amount);
}

function quoteReasons(
  quote: DexQuote,
  maxAgeMs: number,
  now: number,
  maxSlippageBps: Decimal,
): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  if (quote.chain !== 'BSC') reasons.push('quote_mismatch');
  if (!Number.isFinite(quote.quotedAt) || quote.quotedAt <= 0) {
    reasons.push('quote_not_fresh');
  }
  if (
    quote.validUntil !== undefined &&
    (!Number.isFinite(quote.validUntil) || quote.validUntil <= 0)
  ) {
    reasons.push('quote_not_fresh');
  }
  if (
    now - quote.quotedAt > maxAgeMs ||
    now < quote.quotedAt - 250 ||
    (quote.validUntil !== undefined && now > quote.validUntil)
  ) {
    reasons.push('quote_not_fresh');
  }
  if (!safeNonNegative(quote.expectedSlippageBps)) reasons.push('slippage_too_high');
  else if (quote.expectedSlippageBps.gt(maxSlippageBps)) reasons.push('slippage_too_high');
  if (!safeNonNegative(quote.priceImpactBps)) reasons.push('price_impact_unavailable');
  else if (quote.priceImpactBps.gt(maxSlippageBps)) reasons.push('price_impact_too_high');
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
  return reasons;
}

export function evaluateS4(input: S4Input): OpportunityResult {
  const inputReasons: RejectionReason[] = [];
  if (!input.requestedNotional.isFinite() || input.requestedNotional.lte(0)) {
    inputReasons.push('invalid_request');
  }
  if (!Number.isFinite(input.now) || input.now <= 0) inputReasons.push('invalid_request');
  if (!hasValidSettings(input.settings)) inputReasons.push('invalid_request');
  if (!safeNonNegative(input.transferTaxBps) || input.transferTaxBps.gt(10_000)) {
    inputReasons.push('transfer_tax_too_high');
  }
  if (input.base.trim() === '' || input.quote.trim() === '') inputReasons.push('quote_mismatch');
  const reasons: RejectionReason[] = [
    ...inputReasons,
    ...quoteReasons(
      input.buyQuote,
      input.settings.maxOrderbookAgeMs,
      input.now,
      input.settings.maxSlippageBps,
    ),
    ...quoteReasons(
      input.sellQuote,
      input.settings.maxOrderbookAgeMs,
      input.now,
      input.settings.maxSlippageBps,
    ),
  ];
  if (input.buyQuote.providerId === input.sellQuote.providerId) {
    reasons.push('provider_not_independent');
  }
  if (
    input.requestedNotional.isFinite() &&
    input.requestedNotional.gt(0) &&
    input.buyQuote.sellAmount.isFinite() &&
    input.buyQuote.sellAmount.minus(input.requestedNotional).abs().gt(QUOTE_AMOUNT_TOLERANCE)
  ) {
    reasons.push('quote_mismatch');
  }
  const baseContract = normalizedAddress(input.baseTokenContractAddress);
  const quoteContract = normalizedAddress(input.quoteTokenContractAddress);
  const buySellToken = normalizedAddress(input.buyQuote.sellToken);
  const buyBuyToken = normalizedAddress(input.buyQuote.buyToken);
  const sellSellToken = normalizedAddress(input.sellQuote.sellToken);
  const sellBuyToken = normalizedAddress(input.sellQuote.buyToken);
  if (
    !isContractAddress(baseContract) ||
    !isContractAddress(quoteContract) ||
    buySellToken !== quoteContract ||
    buyBuyToken !== baseContract ||
    sellSellToken !== baseContract ||
    sellBuyToken !== quoteContract ||
    buyBuyToken !== sellSellToken
  ) {
    reasons.push('quote_mismatch');
  }
  if (
    input.sellQuote.sellAmount.gt(0) &&
    input.sellQuote.sellAmount
      .minus(input.buyQuote.buyAmount)
      .abs()
      .div(input.sellQuote.sellAmount)
      .gt(QUOTE_AMOUNT_TOLERANCE)
  ) {
    reasons.push('quote_mismatch');
  }
  if (input.tokenRisk !== 'low' && input.tokenRisk !== 'medium') {
    reasons.push('token_risk_too_high');
  }
  if (!input.verifiedContract) reasons.push('token_not_verified');
  if (input.transferTaxBps.gt(input.settings.maxTransferTaxBps)) {
    reasons.push('transfer_tax_too_high');
  }

  const buyGas = input.buyQuote.gasCostUsd.mul(GAS_SAFETY_MULTIPLIER);
  const sellGas = input.sellQuote.gasCostUsd.mul(GAS_SAFETY_MULTIPLIER);
  const gas = buyGas.plus(sellGas);
  if (!gas.isFinite() || gas.lt(0)) {
    reasons.push('gas_estimate_missing');
  } else if (gas.gt(input.settings.maxGasCostUsd)) {
    reasons.push('gas_too_high');
  }

  const baseResult: OpportunityResult = {
    strategy: 'S4',
    opportunityKey: `S4|${input.base}/${input.quote}|${input.buyQuote.providerId}|${input.sellQuote.providerId}`,
    instrumentKey: `${input.base}/${input.quote}`,
    direction: `${input.buyQuote.providerId}->${input.sellQuote.providerId}`,
    venueBuy: input.buyQuote.providerId,
    venueSell: input.sellQuote.providerId,
    instrumentBuy: input.base,
    instrumentSell: input.base,
    requestedNotional: input.requestedNotional,
    grossSpread: ZERO,
    totalCost: ZERO,
    depthNetProfit: ZERO,
    conservativeNetProfit: ZERO,
    netProfitBps: ZERO,
    dataAgeMs: Math.max(
      Math.max(0, input.now - input.buyQuote.quotedAt),
      Math.max(0, input.now - input.sellQuote.quotedAt),
    ),
    valid: false,
    rejectionReasons: [...new Set(reasons)],
    sampledAt: input.now,
    metadata: {
      gasCostUsd: gas.toFixed(),
      rawGasCostUsd: input.buyQuote.gasCostUsd.plus(input.sellQuote.gasCostUsd).toFixed(),
      gasMultiplier: GAS_SAFETY_MULTIPLIER.toFixed(),
      independentProviders: String(input.buyQuote.providerId !== input.sellQuote.providerId),
    },
  };
  if (reasons.length > 0) return baseResult;

  const transferTax = new Decimal(1).minus(toBps(input.transferTaxBps));
  const buyTokenAfterTax = input.buyQuote.buyAmount.mul(transferTax);
  const buyNetToken = applyBps(buyTokenAfterTax, [
    input.buyQuote.feeBps,
    input.buyQuote.priceImpactBps,
    input.buyQuote.expectedSlippageBps,
  ]);
  const sellInput = input.sellQuote.sellAmount.gt(0)
    ? buyNetToken.div(input.sellQuote.sellAmount)
    : ZERO;
  const sellGrossAdjusted = input.sellQuote.buyAmount.mul(sellInput);
  const sellNet = applyBps(sellGrossAdjusted, [
    input.sellQuote.feeBps,
    input.sellQuote.priceImpactBps,
    input.sellQuote.expectedSlippageBps,
  ]);
  const grossSpread = sellGrossAdjusted.minus(input.buyQuote.sellAmount);
  const depthNet = sellNet.minus(input.buyQuote.sellAmount).minus(gas);
  const safety = calculateSafetyBuffer(
    input.requestedNotional,
    input.settings.safetyBufferBps,
    input.settings.minProfitUsd,
  );
  const conservative = depthNet.minus(safety);
  const netBps = calculateNetProfitBps(conservative, input.requestedNotional);
  if (conservative.lte(0)) reasons.push('gross_profit_below_threshold');
  else if (netBps.lt(input.settings.minNetProfitBps)) {
    reasons.push('conservative_profit_below_threshold');
  }
  const unique = [...new Set(reasons)];
  return {
    ...baseResult,
    grossSpread,
    totalCost: grossSpread.minus(depthNet).plus(safety),
    depthNetProfit: depthNet,
    conservativeNetProfit: conservative,
    netProfitBps: netBps,
    valid: unique.length === 0,
    rejectionReasons: unique,
    expectedBuyPrice: buyNetToken.gt(0) ? input.buyQuote.sellAmount.div(buyNetToken) : ZERO,
    expectedSellPrice: buyNetToken.gt(0) ? sellNet.div(buyNetToken) : ZERO,
    metadata: {
      gasCostUsd: gas.toFixed(),
      rawGasCostUsd: input.buyQuote.gasCostUsd.plus(input.sellQuote.gasCostUsd).toFixed(),
      gasMultiplier: GAS_SAFETY_MULTIPLIER.toFixed(),
      independentProviders: 'true',
    },
    fillQuality: {
      strategy: 'S4',
      buyLeg: {
        providerId: input.buyQuote.providerId,
        sellToken: input.buyQuote.sellToken,
        buyToken: input.buyQuote.buyToken,
        inputAmount: input.buyQuote.sellAmount.toFixed(),
        quotedOutput: input.buyQuote.buyAmount.toFixed(),
        outputAfterTaxAndFees: buyNetToken.toFixed(),
        feeBps: input.buyQuote.feeBps.toFixed(),
        priceImpactBps: input.buyQuote.priceImpactBps.toFixed(),
        expectedSlippageBps: input.buyQuote.expectedSlippageBps.toFixed(),
        gasEstimate: input.buyQuote.gasEstimate.toFixed(),
        gasPrice: input.buyQuote.gasPrice.toFixed(),
        gasCostUsd: buyGas.toFixed(),
      },
      sellLeg: {
        providerId: input.sellQuote.providerId,
        sellToken: input.sellQuote.sellToken,
        buyToken: input.sellQuote.buyToken,
        inputAmount: input.sellQuote.sellAmount.toFixed(),
        adjustedInput: buyNetToken.toFixed(),
        quotedOutput: input.sellQuote.buyAmount.toFixed(),
        outputAfterFees: sellNet.toFixed(),
        feeBps: input.sellQuote.feeBps.toFixed(),
        priceImpactBps: input.sellQuote.priceImpactBps.toFixed(),
        expectedSlippageBps: input.sellQuote.expectedSlippageBps.toFixed(),
        gasEstimate: input.sellQuote.gasEstimate.toFixed(),
        gasPrice: input.sellQuote.gasPrice.toFixed(),
        gasCostUsd: sellGas.toFixed(),
      },
      transferTaxBps: input.transferTaxBps.toFixed(),
      costs: {
        grossSpread: grossSpread.toFixed(),
        depthNetProfit: depthNet.toFixed(),
        safetyBufferUsd: safety.toFixed(),
        totalCostUsd: grossSpread.minus(depthNet).plus(safety).toFixed(),
        gasCostUsd: gas.toFixed(),
      },
    },
  };
}
