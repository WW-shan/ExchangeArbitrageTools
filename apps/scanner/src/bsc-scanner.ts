import { Decimal } from 'decimal.js';
import {
  calculateBuyDepthByQuote,
  evaluateS3,
  evaluateS4,
  validateOrderBook,
  type CostSettings,
  type DexQuote,
  type MarketMetadata,
  type OpportunityResult,
  type OrderBookSnapshot,
  type TokenRiskLevel,
} from '@arb/core';
import type { CexAdapter } from '@arb/venues-cex';
import { findStandardToken, type BscTokenInfo } from '@arb/venues-bsc';
import type { QuoteProvider, TokenMappingCandidate } from '@arb/venues-bsc';

export interface BscTokenLookup {
  getKnownToken(symbolOrAddress: string): BscTokenInfo | undefined;
}

export interface BscScanInput {
  cexAdapter: CexAdapter;
  cexMarket: MarketMetadata;
  mapping: TokenMappingCandidate;
  primaryProvider: QuoteProvider;
  backupProvider?: QuoteProvider;
  requestedNotional: Decimal;
  settings: CostSettings;
  slippageBps: Decimal;
  inventoryMode: boolean;
  maxTransferArrivalMs?: number;
  registry?: BscTokenLookup;
  clock?: () => number;
}

export interface BscScanResult {
  opportunities: OpportunityResult[];
  quotes: DexQuote[];
  book?: OrderBookSnapshot;
  errors: string[];
}

function eligibility(mapping: TokenMappingCandidate, inventoryMode: boolean) {
  return {
    mappingStatus: mapping.status,
    riskLevel: mapping.token.riskLevel as TokenRiskLevel,
    verifiedContract: mapping.token.verifiedContract,
    contractAddress: mapping.token.contractAddress,
    transferTaxBps: new Decimal(mapping.token.transferTaxBps),
    transferRequired: !inventoryMode,
    withdrawEnabled: mapping.withdrawEnabled,
    depositEnabled: mapping.depositEnabled,
    ...(mapping.withdrawFee ? { withdrawFee: mapping.withdrawFee } : {}),
    ...(mapping.minWithdrawAmount ? { minWithdrawAmount: mapping.minWithdrawAmount } : {}),
    ...(mapping.minDepositAmount ? { minDepositAmount: mapping.minDepositAmount } : {}),
    ...(mapping.canArriveQuickly !== undefined
      ? { canArriveQuickly: mapping.canArriveQuickly }
      : {}),
    ...(mapping.estimatedArrivalMs !== undefined
      ? { estimatedArrivalMs: mapping.estimatedArrivalMs }
      : {}),
    ...(mapping.token.liquidityUsd
      ? { liquidityUsd: new Decimal(mapping.token.liquidityUsd) }
      : {}),
    ...(mapping.token.volume24hUsd
      ? { volume24hUsd: new Decimal(mapping.token.volume24hUsd) }
      : {}),
  };
}

export async function scanBscToken(input: BscScanInput): Promise<BscScanResult> {
  const errors: string[] = [];
  const opportunities: OpportunityResult[] = [];
  const quotes: DexQuote[] = [];
  const clock = input.clock ?? Date.now;
  let book: OrderBookSnapshot | undefined;
  if (
    input.mapping.cexVenueId !== input.cexAdapter.venueId ||
    input.mapping.cexCurrency.trim().toUpperCase() !== input.cexMarket.base.trim().toUpperCase()
  ) {
    return {
      opportunities,
      quotes,
      errors: ['token mapping does not match the CEX venue and currency'],
    };
  }
  try {
    book = await input.cexAdapter.fetchOrderBook(input.cexMarket.exchangeSymbol, 50);
    const validation = validateOrderBook(book, {
      expectedVenueId: input.cexAdapter.venueId,
      expectedSymbol: input.cexMarket.exchangeSymbol,
      maxAgeMs: input.settings.maxOrderbookAgeMs,
      now: clock(),
    });
    if (!validation.valid) return { opportunities, quotes, book, errors: validation.reasons };
    book = validation.book;
  } catch (error) {
    return { opportunities, quotes, errors: [`cex order book failed: ${String(error)}`] };
  }

  const cexBuy = calculateBuyDepthByQuote(book, input.requestedNotional);
  if (cexBuy.insufficientDepth)
    return { opportunities, quotes, book, errors: ['insufficient CEX depth'] };

  const token = input.mapping.token;
  const quoteToken =
    input.registry?.getKnownToken(input.cexMarket.quote) ??
    findStandardToken(input.cexMarket.quote);
  if (!quoteToken)
    return {
      opportunities,
      quotes,
      book,
      errors: ['quote token is not in the verified BSC whitelist'],
    };
  try {
    const dexSell: DexQuote = await input.primaryProvider.quote(
      {
        sellToken: token.contractAddress,
        buyToken: quoteToken.contractAddress,
        sellTokenDecimals: token.decimals,
        buyTokenDecimals: quoteToken.decimals,
        sellAmount: cexBuy.executableBaseAmount,
        slippageBps: input.slippageBps,
      },
      clock,
    );
    quotes.push(dexSell);
    opportunities.push(
      evaluateS3({
        direction: 'cex-buy-dex-sell',
        base: input.cexMarket.base,
        quote: input.cexMarket.quote,
        cexMarket: input.cexMarket,
        cexBook: book,
        dexQuote: dexSell,
        quoteTokenContractAddress: quoteToken.contractAddress,
        requestedNotional: input.requestedNotional,
        token: eligibility(input.mapping, input.inventoryMode),
        settings: input.settings,
        now: clock(),
        inventoryMode: input.inventoryMode,
        ...(input.maxTransferArrivalMs !== undefined
          ? { maxTransferArrivalMs: input.maxTransferArrivalMs }
          : {}),
      }),
    );
  } catch (error) {
    errors.push(`dex sell quote failed: ${String(error)}`);
  }

  try {
    const dexBuy: DexQuote = await input.primaryProvider.quote(
      {
        sellToken: quoteToken.contractAddress,
        buyToken: token.contractAddress,
        sellTokenDecimals: quoteToken.decimals,
        buyTokenDecimals: token.decimals,
        sellAmount: input.requestedNotional,
        slippageBps: input.slippageBps,
      },
      clock,
    );
    quotes.push(dexBuy);
    opportunities.push(
      evaluateS3({
        direction: 'dex-buy-cex-sell',
        base: input.cexMarket.base,
        quote: input.cexMarket.quote,
        cexMarket: input.cexMarket,
        cexBook: book,
        dexQuote: dexBuy,
        quoteTokenContractAddress: quoteToken.contractAddress,
        requestedNotional: input.requestedNotional,
        token: eligibility(input.mapping, input.inventoryMode),
        settings: input.settings,
        now: clock(),
        inventoryMode: input.inventoryMode,
        ...(input.maxTransferArrivalMs !== undefined
          ? { maxTransferArrivalMs: input.maxTransferArrivalMs }
          : {}),
      }),
    );

    if (!input.backupProvider) return { opportunities, quotes, book, errors };
    const sellQuote = await input.backupProvider.quote(
      {
        sellToken: token.contractAddress,
        buyToken: quoteToken.contractAddress,
        sellTokenDecimals: token.decimals,
        buyTokenDecimals: quoteToken.decimals,
        sellAmount: dexBuy.buyAmount,
        slippageBps: input.slippageBps,
      },
      clock,
    );
    quotes.push(sellQuote);
    opportunities.push(
      evaluateS4({
        base: input.cexMarket.base,
        quote: input.cexMarket.quote,
        baseTokenContractAddress: token.contractAddress,
        quoteTokenContractAddress: quoteToken.contractAddress,
        buyQuote: dexBuy,
        sellQuote,
        tokenRisk: token.riskLevel,
        verifiedContract: token.verifiedContract,
        transferTaxBps: new Decimal(token.transferTaxBps),
        requestedNotional: input.requestedNotional,
        settings: input.settings,
        now: clock(),
      }),
    );
  } catch (error) {
    errors.push(`dex buy/S4 quote failed: ${String(error)}`);
  }

  return { opportunities, quotes, book, errors };
}
