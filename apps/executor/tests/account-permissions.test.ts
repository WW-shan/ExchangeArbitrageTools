import { describe, expect, it } from 'vitest';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import type { AccountStatusSnapshot, CexAdapter } from '@arb/venues-cex';
import {
  evaluateAccountPermissions,
  type AccountStatusConfig,
} from '../src/account-permissions.js';
import type { StoredCredential } from '../src/secret-store.js';

const now = 1_700_000_000_000;

const config: AccountStatusConfig = {
  enabled: true,
  refreshMs: 60_000,
  staleMs: 180_000,
  requireIpWhitelist: false,
  allowSharedTradeWithdrawalKey: true,
  blockOnIpWhitelistChange: true,
  blockOnAccountIdChange: true,
  blockOnAccountModeChange: true,
};

function credential(role: StoredCredential['role'], apiKey = 'shared-key'): StoredCredential {
  return {
    venueId: 'gateio',
    role,
    apiKey,
    secret: 'secret',
    withdrawalPermission: role === 'withdrawal',
    ipWhitelistVerified: true,
  };
}

function snapshot(overrides: Partial<AccountStatusSnapshot> = {}): AccountStatusSnapshot {
  return {
    venueId: 'gateio',
    observedAt: now,
    authenticated: true,
    accountIdHash: 'sha256:aaaaaaaaaaaaaaaa',
    accountMode: 'classic',
    ipWhitelist: {
      supported: true,
      present: true,
      count: 1,
      digest: 'sha256:ip-one',
      currentIpAccepted: true,
    },
    pairWhitelist: {
      supported: true,
      count: 2,
      digest: 'sha256:pairs-one',
      requiredPairsAllowed: true,
    },
    capabilities: {
      balancesRead: 'observed_allowed',
      openOrdersRead: 'unknown',
      trading: 'unknown',
      withdrawal: 'unknown',
    },
    errors: [],
    ...overrides,
  };
}

function adapter(result: AccountStatusSnapshot): CexAdapter {
  return {
    venueId: 'gateio',
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: true,
      createOrder: true,
      fetchOrder: true,
      cancelOrder: true,
      websocket: false,
      ioc: false,
      fok: true,
    },
    loadMarkets: async () => [],
    fetchOrderBook: async () => {
      throw new Error('not used');
    },
    fetchAccountStatus: async () => result,
  };
}

function repository(): ArbitrageRepository {
  return new ArbitrageRepository(openDatabase(':memory:'));
}

describe('account permission observations', () => {
  it('reports shared-key and unknown capability risks as WARN instead of a false PASS', async () => {
    const db = repository();
    const trade = credential('trade');
    const report = await evaluateAccountPermissions({
      repository: db,
      credentials: [trade, credential('withdrawal')],
      venues: { gateio: { adapter: adapter(snapshot()), credentials: trade } },
      requiredPairs: ['LIGHT/USDT'],
      config,
      now,
    });
    expect(report.health).toBe('WARN');
    expect(report.reasons).toContain('gateio:shared_trade_withdrawal_key');
    expect(report.reasons).toContain('gateio:trading_permission_unverified');
    expect(report.reasons).toContain('gateio:withdrawal_permission_unverified');
    expect(report.baselineUpdated).toBe(true);
    expect(db.getSetting('account_status_baseline_v1')).toContain('sha256:aaaaaaaaaaaaaaaa');
    db.close();
  });

  it('blocks when an attested IP whitelist is empty', async () => {
    const db = repository();
    const trade = credential('trade');
    const report = await evaluateAccountPermissions({
      repository: db,
      credentials: [trade],
      venues: {
        gateio: {
          adapter: adapter(
            snapshot({
              ipWhitelist: {
                supported: true,
                present: true,
                count: 0,
                digest: 'sha256:empty',
                currentIpAccepted: false,
              },
            }),
          ),
          credentials: trade,
        },
      },
      requiredPairs: ['LIGHT/USDT'],
      config: { ...config, requireIpWhitelist: true },
      now,
    });
    expect(report.health).toBe('BLOCK');
    expect(report.reasons).toContain('gateio:ip_whitelist_declared_but_empty');
    expect(report.baselineUpdated).toBe(false);
    db.close();
  });

  it('blocks when a required trading pair is excluded', async () => {
    const db = repository();
    const trade = credential('trade');
    const report = await evaluateAccountPermissions({
      repository: db,
      credentials: [trade],
      venues: {
        gateio: {
          adapter: adapter(
            snapshot({
              pairWhitelist: {
                supported: true,
                count: 1,
                digest: 'sha256:one-pair',
                requiredPairsAllowed: false,
              },
            }),
          ),
          credentials: trade,
        },
      },
      requiredPairs: ['LIGHT/USDT', 'TBK/USDT'],
      config,
      now,
    });
    expect(report.health).toBe('BLOCK');
    expect(report.reasons).toContain('gateio:required_pair_not_whitelisted');
    db.close();
  });

  it('blocks after the account identity changes from the persisted baseline', async () => {
    const db = repository();
    const trade = credential('trade');
    await evaluateAccountPermissions({
      repository: db,
      credentials: [trade],
      venues: { gateio: { adapter: adapter(snapshot()), credentials: trade } },
      requiredPairs: [],
      config,
      now,
    });
    const report = await evaluateAccountPermissions({
      repository: db,
      credentials: [trade],
      venues: {
        gateio: {
          adapter: adapter(snapshot({ accountIdHash: 'sha256:bbbbbbbbbbbbbbbb' })),
          credentials: trade,
        },
      },
      requiredPairs: [],
      config,
      now: now + 60_000,
    });
    expect(report.health).toBe('BLOCK');
    expect(report.reasons).toContain('gateio:account_id_changed');
    db.close();
  });

  it('blocks on query failure and when shared keys are disabled', async () => {
    const db = repository();
    const trade = credential('trade');
    const failing = adapter(snapshot());
    failing.fetchAccountStatus = async () => {
      throw new Error('timeout');
    };
    const queryFailure = await evaluateAccountPermissions({
      repository: db,
      credentials: [trade],
      venues: { gateio: { adapter: failing, credentials: trade } },
      requiredPairs: [],
      config,
      now,
    });
    expect(queryFailure.health).toBe('BLOCK');
    expect(
      queryFailure.reasons.some((reason) => reason.includes('account_status_query_failed')),
    ).toBe(true);

    const sharedBlocked = await evaluateAccountPermissions({
      repository: db,
      credentials: [trade, credential('withdrawal')],
      venues: { gateio: { adapter: adapter(snapshot()), credentials: trade } },
      requiredPairs: [],
      config: { ...config, allowSharedTradeWithdrawalKey: false },
      now,
    });
    expect(sharedBlocked.health).toBe('BLOCK');
    expect(sharedBlocked.reasons).toContain('gateio:shared_trade_withdrawal_key_not_allowed');
    db.close();
  });
});
