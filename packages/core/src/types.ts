import type { Decimal } from 'decimal.js';

export type StrategyId = 'S1' | 'S2' | 'S3' | 'S4';
export type VenueTier = 'S' | 'A' | 'B' | 'C';
export type HealthState = 'A' | 'B' | 'C' | 'D';
export type OrderSide = 'buy' | 'sell';
export type TokenRiskLevel = 'low' | 'medium' | 'high' | 'blocked';
export type ExecutionMode = 'taker_taker' | 'maker_buy_taker_sell' | 'taker_buy_maker_sell';
export type FeeChargeAsset = 'base' | 'quote' | 'unknown';

export type RejectionReason =
  | 'insufficient_depth'
  | 'below_min_notional'
  | 'amount_precision_invalid'
  | 'stale_orderbook'
  | 'crossed_orderbook'
  | 'invalid_orderbook'
  | 'symbol_mismatch'
  | 'fee_not_configured'
  | 'gas_too_high'
  | 'transfer_tax_too_high'
  | 'transfer_disabled'
  | 'token_not_verified'
  | 'token_risk_too_high'
  | 'conservative_profit_below_threshold'
  | 'venue_health_below_threshold'
  | 'gross_profit_below_threshold'
  | 'quote_not_fresh'
  | 'slippage_too_high'
  | 'gas_estimate_missing'
  | 'opportunity_expired'
  | 'quote_mismatch'
  | 'price_impact_too_high'
  | 'price_impact_unavailable'
  | 'liquidity_data_unavailable'
  | 'volume_data_unavailable'
  | 'liquidity_below_minimum'
  | 'volume_below_minimum'
  | 'withdrawal_fee_unavailable'
  | 'provider_not_independent'
  | 'venue_mismatch'
  | 'price_precision_invalid'
  | 'market_inactive'
  | 'insufficient_inventory'
  | 'insufficient_balance'
  | 'price_outlier'
  | 'suspicious_spread'
  | 'pair_skew_too_high'
  | 'venue_reliability_low'
  | 'below_percentile_gate'
  | 'book_sanity_blocked'
  | 'preparation_cost_above_limit'
  | 'invalid_request';

export interface Level {
  price: Decimal;
  amount: Decimal;
}

export interface OrderBookSnapshot {
  venueId: string;
  exchangeSymbol: string;
  fetchedAt: number;
  receivedAt?: number;
  exchangeTimestamp?: number;
  sequence?: number;
  asks: Level[];
  bids: Level[];
  source: 'rest' | 'websocket' | 'replay';
}

export interface MarketMetadata {
  venueId: string;
  exchangeSymbol: string;
  unifiedSymbol: string;
  /** Canonical base asset; e.g. PEPE even when the venue lists 1000PEPE. */
  base: string;
  /** Venue currency code when it differs from the canonical base. */
  exchangeBase?: string;
  /** Canonical base units represented by one exchange base unit. */
  baseMultiplier?: Decimal;
  quote: string;
  active: boolean;
  pricePrecision: number;
  amountPrecision: number;
  minAmount?: Decimal;
  minNotional?: Decimal;
  amountStep?: Decimal;
  priceStep?: Decimal;
  feeTakerBps?: Decimal;
  makerFeeBps?: Decimal;
  feeProvenance?: 'config' | 'account' | 'ccxt' | 'default';
  supportsIoc?: boolean;
  supportsFok?: boolean;
}

export interface TickerSnapshot {
  venueId: string;
  exchangeSymbol: string;
  last?: Decimal;
  bid?: Decimal;
  ask?: Decimal;
  baseVolume?: Decimal;
  quoteVolume?: Decimal;
  timestamp: number;
}

export interface OhlcvCandle {
  /** Candle open time in UTC milliseconds. */
  timestamp: number;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  /** Base-asset volume. */
  volume: Decimal;
  /** Quote-asset turnover when the venue provides it. */
  quoteVolume?: Decimal;
}

export interface CurrencyNetwork {
  network: string;
  nativeName: string;
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee?: Decimal;
  minWithdrawAmount?: Decimal;
  minDepositAmount?: Decimal;
  canArriveQuickly: boolean;
  estimatedArrivalMs?: number;
}

export interface CurrencyMetadata {
  venueId: string;
  code: string;
  networks: CurrencyNetwork[];
}

export interface DepthResult {
  side: OrderSide;
  requestedNotional: Decimal;
  executableBaseAmount: Decimal;
  executableQuoteAmount: Decimal;
  averagePrice: Decimal;
  worstPrice: Decimal;
  levelsConsumed: number;
  insufficientDepth: boolean;
}

export interface OpportunityResult {
  strategy: StrategyId;
  opportunityKey: string;
  instrumentKey: string;
  direction: string;
  venueBuy: string;
  venueSell: string;
  instrumentBuy: string;
  instrumentSell: string;
  requestedNotional: Decimal;
  grossSpread: Decimal;
  totalCost: Decimal;
  depthNetProfit: Decimal;
  conservativeNetProfit: Decimal;
  netProfitBps: Decimal;
  dataAgeMs: number;
  valid: boolean;
  rejectionReasons: RejectionReason[];
  sampledAt: number;
  buyDepth?: DepthResult;
  sellDepth?: DepthResult;
  expectedBuyPrice?: Decimal;
  expectedSellPrice?: Decimal;
  metadata?: Record<string, string>;
  fillQuality?: Record<string, unknown>;
}

export interface CostSettings {
  minProfitUsd: Decimal;
  safetyBufferBps: Decimal;
  minNetProfitBps: Decimal;
  maxOrderbookAgeMs: number;
  maxSlippageBps: Decimal;
  maxGasCostUsd: Decimal;
  maxTransferTaxBps: Decimal;
  minPoolLiquidityUsd?: Decimal;
  minPool24hVolumeUsd?: Decimal;
  transferRiskBufferBps?: Decimal;
  depositRiskBufferBps?: Decimal;
  minTopDepthQty?: Decimal;
  liquidityTopLevels?: number;
  rebalanceCostBps?: Decimal;
  executionMode?: ExecutionMode;
  makerFillProbability?: Decimal;
  maxPriceDeviationBps?: Decimal;
  suspiciousSpreadBps?: Decimal;
  maxPairSkewMs?: number;
  minReliabilityScore?: Decimal;
}

export interface DexQuote {
  providerId: string;
  chain: 'BSC';
  sellToken: string;
  buyToken: string;
  sellAmount: Decimal;
  buyAmount: Decimal;
  expectedSlippageBps: Decimal;
  priceImpactBps: Decimal;
  feeBps: Decimal;
  gasEstimate: Decimal;
  gasPrice: Decimal;
  gasCostUsd: Decimal;
  quotedAt: number;
  validUntil?: number;
}

export interface DexQuoteResult {
  quote: DexQuote;
  fresh: boolean;
  reasons: RejectionReason[];
}
