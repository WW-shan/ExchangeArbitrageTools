import { Decimal, type DexQuote } from '@arb/core';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface QuoteRequest {
  sellToken: string;
  buyToken: string;
  sellAmount: Decimal;
  sellTokenDecimals: number;
  buyTokenDecimals: number;
  slippageBps: Decimal;
}

export interface QuoteProvider {
  readonly providerId: string;
  quote(request: QuoteRequest, clock?: () => number): Promise<DexQuote>;
}

export interface AggregatorConfig {
  apiKey?: string;
  baseUrl?: string;
  chainId?: number;
  expectedSlippageBps: Decimal;
  bnbUsd: Decimal;
  fetch?: FetchLike;
  timeoutMs?: number;
  takerAddress?: string;
}

function validatedChainId(value: number | undefined): number {
  const chainId = value ?? 56;
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error('chainId must be a positive integer');
  }
  return chainId;
}

function toBaseUnits(amount: Decimal, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`invalid token decimals: ${decimals}`);
  }
  return amount.mul(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN);
}

function fromBaseUnits(amount: string, decimals: number): Decimal {
  return new Decimal(amount).div(new Decimal(10).pow(decimals));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} response is not an object`);
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`aggregator response missing ${name}`);
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalDecimal(value: unknown): Decimal | undefined {
  const text = optionalText(value);
  if (text === undefined) return undefined;
  try {
    const parsed = new Decimal(text);
    return parsed.isFinite() ? parsed : new Decimal(Number.NaN);
  } catch {
    return new Decimal(Number.NaN);
  }
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`aggregator HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('aggregator returned invalid JSON');
    }
    return record(parsed, 'aggregator');
  } finally {
    clearTimeout(timeout);
  }
}

export class ZeroExQuoteProvider implements QuoteProvider {
  readonly providerId: string;
  readonly #config: AggregatorConfig & { chainId: number; timeoutMs: number };

  constructor(config: AggregatorConfig, providerId = '0x') {
    this.providerId = providerId;
    this.#config = {
      ...config,
      chainId: validatedChainId(config.chainId),
      timeoutMs: config.timeoutMs ?? 10_000,
    };
  }

  async quote(request: QuoteRequest, clock: () => number = Date.now): Promise<DexQuote> {
    const params = new URLSearchParams({
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      chainId: String(this.#config.chainId),
      sellAmount: toBaseUnits(request.sellAmount, request.sellTokenDecimals),
      slippagePercentage: request.slippageBps.div(10_000).toFixed(6),
    });
    if (this.#config.takerAddress) params.set('takerAddress', this.#config.takerAddress);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#config.apiKey) headers['0x-api-key'] = this.#config.apiKey;
    const body = await fetchJson(
      this.#config.fetch ?? (globalThis.fetch as FetchLike),
      `${this.#config.baseUrl ?? 'https://api.0x.org/swap/allowance-holder/quote'}?${params.toString()}`,
      { method: 'GET', headers },
      this.#config.timeoutMs,
    );
    const buyAmount = textField(body.buyAmount ?? body.grossBuyAmount, 'buyAmount');
    const gasEstimate = new Decimal(optionalText(body.estimatedGas ?? body.gas) ?? '0');
    const gasPrice = new Decimal(optionalText(body.gasPrice) ?? '0');
    const priceImpactPercent = optionalDecimal(
      body.estimatedPriceImpact ?? body.priceImpactPercentage ?? body.priceImpact,
    );
    const validTo = optionalText(body.validTo);
    return {
      providerId: this.providerId,
      chain: 'BSC',
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmount: request.sellAmount,
      buyAmount: fromBaseUnits(buyAmount, request.buyTokenDecimals),
      expectedSlippageBps: request.slippageBps,
      // Unknown impact must never be treated as zero. The strategy evaluators
      // reject non-finite impact values before an opportunity can be emitted.
      priceImpactBps: priceImpactPercent ? priceImpactPercent.mul(100) : new Decimal(Number.NaN),
      feeBps: new Decimal(0),
      gasEstimate,
      gasPrice,
      gasCostUsd: gasEstimate.mul(gasPrice).div('1e18').mul(this.#config.bnbUsd),
      quotedAt: clock(),
      ...(validTo ? { validUntil: Number(validTo) * 1000 } : {}),
    };
  }
}

export class OneInchQuoteProvider implements QuoteProvider {
  readonly providerId: string;
  readonly #config: AggregatorConfig & { chainId: number };

  constructor(config: AggregatorConfig & { chainId?: number }, providerId = '1inch') {
    this.providerId = providerId;
    this.#config = {
      ...config,
      chainId: validatedChainId(config.chainId),
      timeoutMs: config.timeoutMs ?? 10_000,
    };
  }

  async quote(request: QuoteRequest, clock: () => number = Date.now): Promise<DexQuote> {
    if (!this.#config.apiKey) throw new Error('1inch API key is required');
    const params = new URLSearchParams({
      src: request.sellToken,
      dst: request.buyToken,
      amount: toBaseUnits(request.sellAmount, request.sellTokenDecimals),
      from: this.#config.takerAddress ?? '0x0000000000000000000000000000000000000000',
      slippage: request.slippageBps.div(100).toFixed(2),
    });
    const body = await fetchJson(
      this.#config.fetch ?? (globalThis.fetch as FetchLike),
      `${this.#config.baseUrl ?? `https://api.1inch.dev/swap/v6.0/${this.#config.chainId}/quote`}?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: `Bearer ${this.#config.apiKey}`,
        },
      },
      this.#config.timeoutMs ?? 10_000,
    );
    const buyAmount = textField(body.dstAmount ?? body.toTokenAmount, 'dstAmount');
    const tx =
      body.tx && typeof body.tx === 'object' && !Array.isArray(body.tx)
        ? (body.tx as Record<string, unknown>)
        : undefined;
    const gasEstimate = new Decimal(optionalText(body.gas ?? body.estimatedGas ?? tx?.gas) ?? '0');
    const gasPrice = new Decimal(
      optionalText(body.gasPrice ?? body.estimatedGasPrice ?? tx?.gasPrice) ?? '0',
    );
    const priceImpactPercent = optionalDecimal(
      body.priceImpactPercentage ?? body.priceImpact ?? body.estimatedPriceImpact,
    );
    return {
      providerId: this.providerId,
      chain: 'BSC',
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      sellAmount: request.sellAmount,
      buyAmount: fromBaseUnits(buyAmount, request.buyTokenDecimals),
      expectedSlippageBps: request.slippageBps,
      priceImpactBps: priceImpactPercent ? priceImpactPercent.mul(100) : new Decimal(Number.NaN),
      feeBps: new Decimal(0),
      gasEstimate,
      gasPrice,
      gasCostUsd: gasEstimate.mul(gasPrice).div('1e18').mul(this.#config.bnbUsd),
      quotedAt: clock(),
    };
  }
}
