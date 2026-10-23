import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  BscTokenRegistry,
  OneInchQuoteProvider,
  STANDARD_BSC_TOKENS,
  TokenMappingService,
  ZeroExQuoteProvider,
  findStandardToken,
  type FetchLike,
} from '../src/index.js';

const cake = findStandardToken('CAKE')!;
const usdt = findStandardToken('USDT')!;

function response(body: unknown): Awaited<ReturnType<FetchLike>> {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}

function abiString(value: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return `0x${'20'.padStart(64, '0')}${(hex.length / 2).toString(16).padStart(64, '0')}${padded}`;
}

describe('BSC token mapping', () => {
  it('never activates a ticker-only mapping', () => {
    const service = new TokenMappingService();
    expect(() =>
      service.candidate({
        id: 'cake-gateio',
        cexVenueId: 'gateio',
        cexCurrency: 'CAKE',
        contractAddress: 'CAKE',
        token: cake,
        evidences: [],
        withdrawEnabled: true,
        depositEnabled: true,
      }),
    ).toThrow(/contract address/);
  });

  it('requires manual approval or two independent agreeing sources', () => {
    const service = new TokenMappingService();
    const base = {
      id: 'cake-gateio',
      cexVenueId: 'gateio',
      cexCurrency: 'CAKE',
      contractAddress: cake.contractAddress,
      token: cake,
      withdrawEnabled: true,
      depositEnabled: true,
    };
    const candidate = service.candidate({
      ...base,
      evidences: [
        {
          cexCurrency: 'CAKE',
          chain: 'BSC',
          contractAddress: cake.contractAddress,
          source: 'cex-api',
        },
      ],
    });
    expect(candidate.status).toBe('candidate');
    const active = service.candidate({
      ...base,
      evidences: [
        {
          cexCurrency: 'CAKE',
          chain: 'BSC',
          contractAddress: cake.contractAddress,
          source: 'cex-api',
        },
        {
          cexCurrency: 'CAKE',
          chain: 'BSC',
          contractAddress: cake.contractAddress,
          source: 'bscscan',
        },
      ],
    });
    expect(active.status).toBe('active');
    expect(service.approve('cake-gateio').status).toBe('active');
  });

  it('keeps a verified static whitelist for the first BSC tests', () => {
    const registry = new BscTokenRegistry();
    expect(Object.values(STANDARD_BSC_TOKENS)).toHaveLength(5);
    expect(registry.getKnownToken(usdt.contractAddress)?.symbol).toBe('USDT');
    expect(registry.getKnownToken('CAKE')?.contractAddress).toBe(cake.contractAddress);
  });

  it('rejects invalid addresses and contracts without bytecode', async () => {
    const unknownAddress = '0x1111111111111111111111111111111111111111';
    const registry = new BscTokenRegistry();
    await expect(registry.inspect('not-an-address')).rejects.toThrow(/invalid BSC contract/);
    await expect(registry.inspect(unknownAddress)).rejects.toThrow(/metadata provider unavailable/);

    const emptyContract = new BscTokenRegistry({
      getCode: async () => '0x',
      call: async () => '0x',
    });
    await expect(emptyContract.inspect(unknownAddress)).rejects.toThrow(/no contract code/);
  });

  it('reads verified metadata and leaves unknown liquidity and volume absent', async () => {
    const unknownAddress = '0x1111111111111111111111111111111111111111';
    const provider = {
      getCode: async () => '0x6000',
      call: async (transaction: { to: string; data: string }) => {
        if (transaction.data === '0x313ce567') return `0x${'12'.padStart(64, '0')}`;
        if (transaction.data === '0x95d89b41') return abiString('TEST');
        if (transaction.data === '0x06fdde03') return abiString('Test Token');
        throw new Error('unexpected selector');
      },
    };
    const token = await new BscTokenRegistry(provider).inspect(unknownAddress);
    expect(token).toMatchObject({
      symbol: 'TEST',
      name: 'Test Token',
      decimals: 18,
      verifiedContract: true,
      transferTaxBps: '0',
      riskLevel: 'high',
    });
    expect(token.liquidityUsd).toBeUndefined();
    expect(token.volume24hUsd).toBeUndefined();
  });
});

describe('aggregator quote normalization', () => {
  it('parses a 0x BSC quote and converts base units into human amounts', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return response({
        buyAmount: '31000000000000000000',
        sellAmount: '12000000000000000000',
        estimatedPriceImpact: '0.1',
        estimatedGas: '200000',
        gasPrice: '1000000000',
        validTo: '1700000300',
      });
    };
    const provider = new ZeroExQuoteProvider({
      fetch: fetchImpl,
      expectedSlippageBps: new Decimal(10),
      bnbUsd: new Decimal(600),
    });
    const quote = await provider.quote(
      {
        sellToken: cake.contractAddress,
        buyToken: usdt.contractAddress,
        sellAmount: new Decimal(12),
        sellTokenDecimals: cake.decimals,
        buyTokenDecimals: usdt.decimals,
        slippageBps: new Decimal(10),
      },
      () => 1_700_000_000_000,
    );
    expect(quote.buyAmount.toFixed()).toBe('31');
    expect(quote.priceImpactBps.toFixed()).toBe('10');
    expect(quote.gasCostUsd.toFixed()).toBe('0.12');
    expect(calls[0]).toContain('sellAmount=12000000000000000000');
    expect(calls[0]).toContain('chainId=56');
  });

  it('parses a 1inch quote and requires its API key', async () => {
    let quoteUrl = '';
    const provider = new OneInchQuoteProvider({
      apiKey: 'test-key',
      expectedSlippageBps: new Decimal(10),
      bnbUsd: new Decimal(600),
      fetch: async (url) => {
        quoteUrl = url;
        return response({
          dstAmount: '30000000000000000000',
          gas: '180000',
          gasPrice: '1000000000',
        });
      },
    });
    const quote = await provider.quote({
      sellToken: usdt.contractAddress,
      buyToken: cake.contractAddress,
      sellAmount: new Decimal(30),
      sellTokenDecimals: usdt.decimals,
      buyTokenDecimals: cake.decimals,
      slippageBps: new Decimal(10),
    });
    expect(quote.buyAmount.toFixed()).toBe('30');
    expect(quote.gasCostUsd.toFixed()).toBe('0.108');
    expect(quote.priceImpactBps.isNaN()).toBe(true);
    expect(quoteUrl).toContain('/56/quote');
    expect(quoteUrl).not.toContain('disableEstimate');
    const missingKey = new OneInchQuoteProvider({
      expectedSlippageBps: new Decimal(10),
      bnbUsd: new Decimal(600),
    });
    await expect(
      missingKey.quote({
        sellToken: usdt.contractAddress,
        buyToken: cake.contractAddress,
        sellAmount: new Decimal(30),
        sellTokenDecimals: usdt.decimals,
        buyTokenDecimals: cake.decimals,
        slippageBps: new Decimal(10),
      }),
    ).rejects.toThrow(/API key/);
  });

  it('rejects invalid aggregator chain ids instead of silently using another network', () => {
    expect(
      () =>
        new ZeroExQuoteProvider({
          chainId: 0,
          expectedSlippageBps: new Decimal(10),
          bnbUsd: new Decimal(600),
        }),
    ).toThrow(/chainId/);
    expect(
      () =>
        new OneInchQuoteProvider({
          chainId: -1,
          expectedSlippageBps: new Decimal(10),
          bnbUsd: new Decimal(600),
        }),
    ).toThrow(/chainId/);
  });

  it('fails closed when a quote provider omits price impact', async () => {
    const zeroEx = new ZeroExQuoteProvider({
      fetch: async () =>
        response({
          buyAmount: '31000000000000000000',
          estimatedGas: '200000',
          gasPrice: '1000000000',
        }),
      expectedSlippageBps: new Decimal(10),
      bnbUsd: new Decimal(600),
    });
    const quote = await zeroEx.quote({
      sellToken: cake.contractAddress,
      buyToken: usdt.contractAddress,
      sellAmount: new Decimal(12),
      sellTokenDecimals: cake.decimals,
      buyTokenDecimals: usdt.decimals,
      slippageBps: new Decimal(10),
    });
    expect(quote.priceImpactBps.isNaN()).toBe(true);
  });
});
