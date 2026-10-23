import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { VenueHealthTracker, type CurrencyMetadata, type MarketMetadata } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { CexAdapter } from '@arb/venues-cex';
import { BscTokenRegistry } from '@arb/venues-bsc';
import { bscMappings } from '../src/bsc-mappings.js';
import type { ScannerVenue } from '../src/scanner-service.js';

function market(venueId: string, base: string): MarketMetadata {
  return {
    venueId,
    exchangeSymbol: `${base}/USDT`,
    unifiedSymbol: `${base}/USDT`,
    base,
    quote: 'USDT',
    active: true,
    pricePrecision: 3,
    amountPrecision: 3,
    amountStep: new Decimal('0.001'),
    priceStep: new Decimal('0.001'),
    feeTakerBps: new Decimal(10),
  };
}

function venue(
  venueId: string,
  markets: MarketMetadata[],
  currencies?: CurrencyMetadata[],
): ScannerVenue {
  const adapter: CexAdapter = {
    venueId,
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: false,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      websocket: false,
      ioc: false,
      fok: false,
    },
    loadMarkets: async () => markets,
    fetchOrderBook: async () => {
      throw new Error('not used');
    },
  };
  return {
    adapter,
    health: new VenueHealthTracker(),
    markets,
    ...(currencies ? { currencies } : {}),
  };
}

describe('BSC mapping construction', () => {
  it('maps each enabled venue that lists the token and persists risk metadata', () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    for (const venueId of ['gateio', 'mexc', 'weex']) {
      repository.upsertVenue({ id: venueId, type: 'cex', name: venueId, tier: 'S' });
    }
    const registry = new BscTokenRegistry();
    const mappings = bscMappings(
      { tokenSymbols: ['CAKE'], quoteCurrency: 'USDT' },
      [
        venue('gateio', [market('gateio', 'CAKE')]),
        venue('mexc', [market('mexc', 'CAKE')]),
        venue('weex', [market('weex', 'BTC')]),
      ],
      registry,
      repository,
    );

    expect(mappings.map((entry) => entry.mapping.cexVenueId)).toEqual(['gateio', 'mexc']);
    expect(mappings.every((entry) => entry.mapping.status === 'active')).toBe(true);
    const rows = db
      .prepare(
        `SELECT cex_venue_id, cex_currency, status, risk_level, transfer_tax_bps,
                verification_sources, notes
         FROM token_mappings ORDER BY cex_venue_id`,
      )
      .all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      cex_venue_id: 'gateio',
      cex_currency: 'CAKE',
      status: 'active',
      risk_level: 'low',
      transfer_tax_bps: '0',
    });
    expect(JSON.parse(rows[0]!.verification_sources!)).toEqual(['manual-whitelist']);
    expect(rows[0]!.notes).toContain('Inventory mode only');
    expect((db.prepare('SELECT COUNT(*) AS n FROM bsc_tokens').get() as { n: number }).n).toBe(1);
    repository.close();
  });

  it('carries CEX network transfer metadata into a venue mapping', () => {
    const db = openDatabase(':memory:');
    const repository = new ArbitrageRepository(db);
    repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'gateio', tier: 'S' });
    const registry = new BscTokenRegistry();
    const currencies: CurrencyMetadata[] = [
      {
        venueId: 'gateio',
        code: 'CAKE',
        networks: [
          {
            network: 'BSC',
            nativeName: 'BEP20',
            withdrawEnabled: true,
            depositEnabled: true,
            withdrawFee: new Decimal('0.1'),
            minWithdrawAmount: new Decimal('2'),
            minDepositAmount: new Decimal('3'),
            canArriveQuickly: true,
          },
        ],
      },
    ];
    const [entry] = bscMappings(
      {
        tokenSymbols: ['CAKE'],
        quoteCurrency: 'USDT',
        estimatedTransferArrivalMs: 600_000,
      },
      [venue('gateio', [market('gateio', 'CAKE')], currencies)],
      registry,
      repository,
    );
    expect(entry?.mapping).toMatchObject({
      withdrawEnabled: true,
      depositEnabled: true,
      minWithdrawAmount: new Decimal('2'),
      minDepositAmount: new Decimal('3'),
      canArriveQuickly: true,
      estimatedArrivalMs: 600_000,
    });
    expect(entry?.mapping.withdrawFee?.toFixed()).toBe('0.1');
    expect(entry?.mapping.notes).toContain('CEX currency/network API');
    repository.close();
  });
});
