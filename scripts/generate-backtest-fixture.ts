import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sampleCount = 20;
const start = 1_762_000_000_000;
const markets = {
  gateio: {
    venueId: 'gateio',
    exchangeSymbol: 'CAKE/USDT',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 4,
    amountPrecision: 3,
    amountStep: '0.001',
    priceStep: '0.0001',
    minAmount: '0.01',
    minNotional: '1',
    feeTakerBps: '10',
    supportsIoc: true,
    supportsFok: false,
  },
  mexc: {
    venueId: 'mexc',
    exchangeSymbol: 'CAKE/USDT',
    unifiedSymbol: 'CAKE/USDT',
    base: 'CAKE',
    quote: 'USDT',
    active: true,
    pricePrecision: 4,
    amountPrecision: 3,
    amountStep: '0.001',
    priceStep: '0.0001',
    minAmount: '0.01',
    minNotional: '1',
    feeTakerBps: '10',
    supportsIoc: true,
    supportsFok: false,
  },
};

const samples = Array.from({ length: sampleCount }, (_, index) => {
  const sampledAt = start + index * 5000;
  const gateAsk = (2.5 + index * 0.0004).toFixed(4);
  const gateBid = (Number(gateAsk) - 0.01).toFixed(4);
  const mexcBid = (Number(gateAsk) + 0.06).toFixed(4);
  const mexcAsk = (Number(mexcBid) + 0.01).toFixed(4);
  return {
    sampledAt,
    gateio: {
      venueId: 'gateio',
      exchangeSymbol: 'CAKE/USDT',
      fetchedAt: sampledAt,
      exchangeTimestamp: sampledAt,
      asks: [
        [gateAsk, '5'],
        [(Number(gateAsk) + 0.0005).toFixed(4), '50'],
      ],
      bids: [
        [gateBid, '5'],
        [(Number(gateBid) - 0.0005).toFixed(4), '50'],
      ],
      source: 'replay',
    },
    mexc: {
      venueId: 'mexc',
      exchangeSymbol: 'CAKE/USDT',
      fetchedAt: sampledAt,
      exchangeTimestamp: sampledAt,
      asks: [
        [mexcAsk, '5'],
        [(Number(mexcAsk) + 0.0005).toFixed(4), '50'],
      ],
      bids: [
        [mexcBid, '5'],
        [(Number(mexcBid) - 0.0005).toFixed(4), '50'],
      ],
      source: 'replay',
    },
  };
});

const fixture = {
  name: 'S1 CAKE/USDT depth replay',
  kind: 'synthetic-calibration',
  note: 'Deterministic order-book replay for paper-engine regression and execution-path testing. Replace with a captured market fixture for venue-specific calibration.',
  generatedAt: new Date('2026-10-21T00:00:00.000Z').toISOString(),
  base: 'CAKE',
  quote: 'USDT',
  requestedNotional: '30',
  settings: {
    minProfitUsd: '0.25',
    safetyBufferBps: '15',
    minNetProfitBps: '20',
    maxOrderbookAgeMs: 3000,
    maxSlippageBps: '50',
    maxGasCostUsd: '0.50',
    maxTransferTaxBps: '0',
  },
  markets,
  samples,
};

const output = resolve('fixtures/backtest/s1-cake-usdt.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`wrote ${sampleCount} samples to ${output}`);
