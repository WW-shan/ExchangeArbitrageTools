import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  networksMatch,
  type ApiCredentials,
  type CexAdapter,
  type TransferRecord,
  type WithdrawalRequest,
} from '@arb/venues-cex';
import type { TransferAllowlistEntry, TransferConfig } from '../src/config.js';
import {
  TRANSFER_BATCH_STATUS,
  TRANSFER_LEG_STATUS,
  executeTransferBatch,
  planTransferBatch,
  preflightTransferBatch,
  type TransferVenue,
} from '../src/transfer-service.js';

const now = 1_700_000_000_000;
const keys: ApiCredentials = { apiKey: 'key', secret: 'secret' };

function allowlistEntry(overrides: Partial<TransferAllowlistEntry> = {}): TransferAllowlistEntry {
  return {
    fromVenue: 'gateio',
    toVenue: 'hotcoin',
    asset: 'INC',
    network: 'BSC',
    address: '0xabc',
    minAmount: new Decimal('1'),
    maxAmount: new Decimal('1000'),
    dailyMaxAmount: new Decimal('10000'),
    withdrawFee: new Decimal('1'),
    ...overrides,
  };
}

function transferConfig(overrides: Partial<TransferConfig> = {}): TransferConfig {
  return {
    enabled: true,
    requireManualConfirmation: true,
    releaseMode: 'manual',
    maxInFlightBatches: 1,
    maxLegsPerBatch: 2,
    maxBalanceAgeMs: 300_000,
    pollIntervalMs: 1,
    withdrawalTimeoutMs: 60_000,
    depositTimeoutMs: 60_000,
    minNetEdgeBps: new Decimal('5'),
    maxCostUsd: new Decimal('0.5'),
    maxArrivalMs: 1_800_000,
    allowlist: [
      allowlistEntry(),
      allowlistEntry({
        fromVenue: 'hotcoin',
        toVenue: 'gateio',
        asset: 'USDT',
        address: '0xdef',
      }),
    ],
    ...overrides,
  };
}

interface FakeVenueOptions {
  venueId: string;
  balances: Array<{ currency: string; free: string }>;
  depositAddresses: Record<string, string>;
  deposits?: TransferRecord[];
  withdrawalStatus?: 'pending' | 'completed' | 'failed';
  withdrawalAddress?: string;
  failWithdrawal?: boolean;
}

function depositRecord(input: {
  venueId: string;
  asset: string;
  address: string;
  txId: string;
  amount: string;
}): TransferRecord {
  return {
    venueId: input.venueId,
    id: `d-${input.txId}`,
    direction: 'deposit',
    currency: input.asset,
    network: 'BSC',
    address: input.address,
    amount: new Decimal(input.amount),
    txId: input.txId,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    raw: {},
  };
}

function fakeVenue(options: FakeVenueOptions): {
  adapter: CexAdapter;
  createRequests: WithdrawalRequest[];
  attempts: number;
} {
  const withdrawals: TransferRecord[] = [];
  const createRequests: WithdrawalRequest[] = [];
  let attempts = 0;
  const adapter = {
    venueId: options.venueId,
    tier: 'S',
    capabilities: {
      publicMarketData: true,
      orderBook: true,
      privateBalances: true,
      createOrder: false,
      fetchOrder: false,
      cancelOrder: false,
      depositAddress: true,
      depositHistory: true,
      withdrawalHistory: true,
      createWithdrawal: true,
      websocket: false,
      ioc: false,
      fok: false,
    },
    loadMarkets: async () => [],
    fetchOrderBook: async () => {
      throw new Error('not used in transfer tests');
    },
    fetchBalances: async () =>
      options.balances.map((balance) => ({
        venueId: options.venueId,
        accountId: 'default',
        currency: balance.currency,
        free: new Decimal(balance.free),
        used: new Decimal(0),
        total: new Decimal(balance.free),
        fetchedAt: now,
      })),
    fetchDepositAddress: async (asset: string, network: string) => {
      const address = options.depositAddresses[asset];
      if (!address) throw new Error(`no fake address for ${asset}`);
      return {
        venueId: options.venueId,
        currency: asset,
        network,
        address,
        fetchedAt: now,
        raw: {},
      };
    },
    fetchDeposits: async (query: { network?: string; txId?: string }) =>
      (options.deposits ?? []).filter(
        (row) =>
          (!query.txId || row.txId === query.txId) &&
          (!query.network || networksMatch(row.network, query.network)),
      ),
    fetchWithdrawals: async (query: { id?: string; network?: string }) =>
      withdrawals.filter(
        (row) =>
          (!query.id || row.id === query.id) &&
          (!query.network || networksMatch(row.network, query.network)),
      ),
    createWithdrawal: async (request: WithdrawalRequest) => {
      attempts += 1;
      createRequests.push(request);
      if (options.failWithdrawal) throw new Error('simulated ambiguous network failure');
      const txId = `tx-${options.venueId}-${request.currency.toUpperCase()}`;
      const record: TransferRecord = {
        venueId: options.venueId,
        id: `w-${options.venueId}-${request.currency.toUpperCase()}`,
        direction: 'withdrawal',
        currency: request.currency.toUpperCase(),
        network: request.network,
        address: options.withdrawalAddress ?? request.address,
        amount: request.amount,
        fee: new Decimal('1'),
        txId,
        status: options.withdrawalStatus ?? 'completed',
        createdAt: now,
        updatedAt: now,
        raw: {},
      };
      withdrawals.push(record);
      return {
        venueId: options.venueId,
        id: record.id,
        currency: record.currency,
        network: record.network,
        address: record.address,
        amount: record.amount,
        fee: record.fee,
        txId: record.txId,
        status: record.status,
        raw: {},
      };
    },
  } as CexAdapter;
  return {
    adapter,
    createRequests,
    get attempts() {
      return attempts;
    },
  };
}

function recordBalances(
  repository: ArbitrageRepository,
  rows: Array<{ venueId: string; currency: string; free: string }>,
): void {
  for (const row of rows) {
    repository.recordBalance({
      venueId: row.venueId,
      accountId: 'default',
      currency: row.currency,
      free: new Decimal(row.free),
      used: new Decimal(0),
      total: new Decimal(row.free),
      fetchedAt: now,
    });
  }
}

function venueAccess(adapter: CexAdapter): TransferVenue {
  return {
    read: { adapter, credentials: keys },
    withdrawal: { adapter, credentials: keys },
  };
}

function setup(
  options: {
    hotcoinAddress?: string;
    arrivalAmount?: string;
    noHotcoinDeposit?: boolean;
    failGateWithdrawal?: boolean;
    gateWithdrawalStatus?: 'pending' | 'completed' | 'failed';
    gateWithdrawalAddress?: string;
  } = {},
) {
  const repository = new ArbitrageRepository(openDatabase(':memory:'));
  repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
  repository.upsertVenue({ id: 'hotcoin', type: 'cex', name: 'Hotcoin', tier: 'S', now });
  recordBalances(repository, [
    { venueId: 'gateio', currency: 'INC', free: '50' },
    { venueId: 'gateio', currency: 'USDT', free: '50' },
    { venueId: 'hotcoin', currency: 'INC', free: '10' },
    { venueId: 'hotcoin', currency: 'USDT', free: '100' },
  ]);
  const hotcoinDeposits = options.noHotcoinDeposit
    ? []
    : [
        depositRecord({
          venueId: 'hotcoin',
          asset: 'INC',
          address: options.hotcoinAddress ?? '0xabc',
          txId: 'tx-gateio-INC',
          amount: options.arrivalAmount ?? '19',
        }),
      ];
  const gateDeposits = [
    depositRecord({
      venueId: 'gateio',
      asset: 'USDT',
      address: '0xdef',
      txId: 'tx-hotcoin-USDT',
      amount: '49',
    }),
  ];
  const gate = fakeVenue({
    venueId: 'gateio',
    balances: [
      { currency: 'INC', free: '50' },
      { currency: 'USDT', free: '50' },
    ],
    depositAddresses: { INC: '0xabc', USDT: '0xdef' },
    deposits: gateDeposits,
    failWithdrawal: options.failGateWithdrawal ?? false,
    ...(options.gateWithdrawalStatus ? { withdrawalStatus: options.gateWithdrawalStatus } : {}),
    ...(options.gateWithdrawalAddress ? { withdrawalAddress: options.gateWithdrawalAddress } : {}),
  });
  const hotcoin = fakeVenue({
    venueId: 'hotcoin',
    balances: [
      { currency: 'INC', free: '10' },
      { currency: 'USDT', free: '100' },
    ],
    depositAddresses: { INC: options.hotcoinAddress ?? '0xabc', USDT: '0xdef' },
    deposits: hotcoinDeposits,
  });
  return {
    repository,
    gate,
    hotcoin,
    venues: { gateio: venueAccess(gate.adapter), hotcoin: venueAccess(hotcoin.adapter) },
  };
}

describe('automated inventory transfer service', () => {
  it('plans two directions, preflights both and never withdraws in dry-run', async () => {
    const { repository, gate, hotcoin, venues } = setup();
    try {
      const config = transferConfig();
      const batch = planTransferBatch({
        repository,
        config,
        assetPricesUsd: { INC: new Decimal('0.25'), USDT: new Decimal('1') },
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'gateio', currency: 'USDT', targetFree: new Decimal('100') },
          { venueId: 'hotcoin', currency: 'USDT', targetFree: new Decimal('50') },
        ],
        now,
      });
      expect(batch.status).toBe(TRANSFER_BATCH_STATUS.PLANNED);
      expect(batch.legs.map((leg) => `${leg.fromVenue}->${leg.toVenue}:${leg.asset}`)).toEqual([
        'gateio->hotcoin:INC',
        'hotcoin->gateio:USDT',
      ]);

      const preflight = await preflightTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        now,
      });
      expect(preflight.status).toBe(TRANSFER_BATCH_STATUS.READY);
      expect(preflight.legs.every((leg) => leg.status === TRANSFER_LEG_STATUS.READY)).toBe(true);

      const dryRun = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        dryRun: true,
        now: () => now,
      });
      expect(dryRun.status).toBe(TRANSFER_BATCH_STATUS.DRY_RUN);
      expect(dryRun.withdrawalsSubmitted).toBe(0);
      expect(gate.attempts).toBe(0);
      expect(hotcoin.attempts).toBe(0);
    } finally {
      repository.close();
    }
  });

  it('executes base then quote only after the first arrival is confirmed', async () => {
    const { repository, gate, hotcoin, venues } = setup();
    try {
      const config = transferConfig();
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'gateio', currency: 'USDT', targetFree: new Decimal('100') },
          { venueId: 'hotcoin', currency: 'USDT', targetFree: new Decimal('50') },
        ],
        now,
      });
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        operator: 'test',
        now: () => now,
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.COMPLETED);
      expect(result.withdrawalsSubmitted).toBe(2);
      expect(gate.createRequests.map((request) => request.currency)).toEqual(['INC']);
      expect(hotcoin.createRequests.map((request) => request.currency)).toEqual(['USDT']);
      expect(repository.getTransferBatch(batch.id)?.legs.map((leg) => leg.status)).toEqual([
        TRANSFER_LEG_STATUS.ARRIVED,
        TRANSFER_LEG_STATUS.ARRIVED,
      ]);
    } finally {
      repository.close();
    }
  });

  it('stops safely on an ambiguous withdrawal and never submits the second leg', async () => {
    const { repository, gate, hotcoin, venues } = setup({ failGateWithdrawal: true });
    try {
      const base = transferConfig();
      const config = {
        ...base,
        allowlist: [{ ...base.allowlist[0]!, venueCurrency: 'INC(BSC)' }, base.allowlist[1]!],
      };
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'gateio', currency: 'USDT', targetFree: new Decimal('100') },
          { venueId: 'hotcoin', currency: 'USDT', targetFree: new Decimal('50') },
        ],
        now,
      });
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        now: () => now,
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.SAFE_STOP);
      expect(result.withdrawalsSubmitted).toBe(0);
      expect(gate.attempts).toBe(1);
      expect(gate.createRequests[0]?.currency).toBe('INC(BSC)');
      expect(hotcoin.attempts).toBe(0);
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.status).toBe(
        TRANSFER_LEG_STATUS.UNKNOWN,
      );
      expect(repository.getSetting('kill_switch')).toBe('true');
    } finally {
      repository.close();
    }
  });

  it('blocks when the live destination address differs from the allowlist', async () => {
    const { repository, gate, hotcoin, venues } = setup({ hotcoinAddress: '0xevil' });
    try {
      const config = transferConfig();
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'gateio', currency: 'USDT', targetFree: new Decimal('100') },
          { venueId: 'hotcoin', currency: 'USDT', targetFree: new Decimal('50') },
        ],
        now,
      });
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        now: () => now,
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.BLOCKED);
      expect(result.reasons.join(',')).toContain('deposit_address_mismatch');
      expect(gate.attempts).toBe(0);
      expect(hotcoin.attempts).toBe(0);
    } finally {
      repository.close();
    }
  });

  it('times out when the source completed but no matching destination deposit exists', async () => {
    const { repository, gate, hotcoin, venues } = setup({ noHotcoinDeposit: true });
    try {
      const config = transferConfig({
        maxLegsPerBatch: 1,
        withdrawalTimeoutMs: 5,
        depositTimeoutMs: 5,
        allowlist: [allowlistEntry()],
      });
      recordBalances(repository, [
        { venueId: 'gateio', currency: 'INC', free: '50' },
        { venueId: 'hotcoin', currency: 'INC', free: '10' },
      ]);
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      let clock = now;
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.SAFE_STOP);
      expect(result.withdrawalsSubmitted).toBe(1);
      expect(gate.attempts).toBe(1);
      expect(hotcoin.attempts).toBe(0);
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.status).toBe(
        TRANSFER_LEG_STATUS.DEPOSIT_TIMEOUT,
      );
    } finally {
      repository.close();
    }
  });

  it('marks a stuck source withdrawal UNKNOWN at the withdrawal timeout', async () => {
    const { repository, gate, hotcoin, venues } = setup({ gateWithdrawalStatus: 'pending' });
    try {
      const config = transferConfig({
        maxLegsPerBatch: 1,
        withdrawalTimeoutMs: 5,
        depositTimeoutMs: 1_000,
        allowlist: [allowlistEntry()],
      });
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      let clock = now;
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.SAFE_STOP);
      expect(gate.attempts).toBe(1);
      expect(hotcoin.attempts).toBe(0);
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.status).toBe(
        TRANSFER_LEG_STATUS.UNKNOWN,
      );
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.error).toContain(
        'transfer_timeout:WITHDRAWING',
      );
    } finally {
      repository.close();
    }
  });

  it('rejects a source withdrawal record whose address differs from the plan', async () => {
    const { repository, gate, hotcoin, venues } = setup({
      gateWithdrawalAddress: '0xdifferent',
    });
    try {
      const config = transferConfig({
        maxLegsPerBatch: 1,
        allowlist: [allowlistEntry()],
      });
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        now: () => now,
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.SAFE_STOP);
      expect(gate.attempts).toBe(1);
      expect(hotcoin.attempts).toBe(0);
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.status).toBe(
        TRANSFER_LEG_STATUS.UNKNOWN,
      );
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.error).toContain(
        'source_record_address_mismatch',
      );
    } finally {
      repository.close();
    }
  });

  it('treats a missing target currency as zero when the venue has fresh balances', () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    try {
      repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
      repository.upsertVenue({ id: 'hotcoin', type: 'cex', name: 'Hotcoin', tier: 'S', now });
      recordBalances(repository, [
        { venueId: 'gateio', currency: 'INC', free: '60' },
        { venueId: 'hotcoin', currency: 'USDT', free: '100' },
      ]);
      const config = transferConfig({
        maxLegsPerBatch: 1,
        allowlist: [allowlistEntry()],
      });
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      expect(batch.status).toBe(TRANSFER_BATCH_STATUS.PLANNED);
      expect(batch.legs[0]?.amount.toFixed()).toBe('30');
    } finally {
      repository.close();
    }
  });

  it('refuses to treat a stale target-currency balance as zero', () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    try {
      repository.upsertVenue({ id: 'gateio', type: 'cex', name: 'Gate.io', tier: 'S', now });
      repository.upsertVenue({ id: 'hotcoin', type: 'cex', name: 'Hotcoin', tier: 'S', now });
      recordBalances(repository, [
        { venueId: 'gateio', currency: 'INC', free: '60' },
        { venueId: 'hotcoin', currency: 'USDT', free: '100' },
      ]);
      repository.recordBalance({
        venueId: 'hotcoin',
        accountId: 'default',
        currency: 'INC',
        free: new Decimal('10'),
        used: new Decimal(0),
        total: new Decimal('10'),
        fetchedAt: now - 1_000_000,
      });
      const config = transferConfig({ maxLegsPerBatch: 1, allowlist: [allowlistEntry()] });
      expect(() =>
        planTransferBatch({
          repository,
          config,
          targets: [
            { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
            { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
          ],
          now,
        }),
      ).toThrow(/stale/);
    } finally {
      repository.close();
    }
  });

  it('aggregates the daily limit across same-source legs in one plan', () => {
    const repository = new ArbitrageRepository(openDatabase(':memory:'));
    try {
      for (const [id, name] of [
        ['gateio', 'Gate.io'],
        ['hotcoin', 'Hotcoin'],
        ['mexc', 'MEXC'],
      ] as const) {
        repository.upsertVenue({ id, type: 'cex', name, tier: 'S', now });
      }
      recordBalances(repository, [
        { venueId: 'gateio', currency: 'INC', free: '120' },
        { venueId: 'hotcoin', currency: 'USDT', free: '10' },
        { venueId: 'mexc', currency: 'USDT', free: '10' },
      ]);
      const config = transferConfig({
        maxLegsPerBatch: 2,
        allowlist: [
          allowlistEntry({ dailyMaxAmount: new Decimal('100') }),
          allowlistEntry({
            fromVenue: 'gateio',
            toVenue: 'mexc',
            address: '0xmexc',
            dailyMaxAmount: new Decimal('100'),
          }),
        ],
      });
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('0') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('60') },
          { venueId: 'mexc', currency: 'INC', targetFree: new Decimal('60') },
        ],
        now,
      });
      expect(batch.status).toBe(TRANSFER_BATCH_STATUS.BLOCKED);
      expect(batch.safeModeReason).toContain('daily_allowlist_limit_exceeded');
    } finally {
      repository.close();
    }
  });

  it('aggregates the daily limit across legs during preflight', async () => {
    const { repository, venues } = setup();
    try {
      const config = transferConfig({
        maxLegsPerBatch: 2,
        allowlist: [allowlistEntry({ dailyMaxAmount: new Decimal('30') })],
      });
      repository.createTransferBatch({
        id: 'xfer-daily-preflight',
        status: TRANSFER_BATCH_STATUS.PLANNED,
        plan: {},
        dryRun: false,
        createdAt: now,
        legs: [1, 2].map((legNumber) => ({
          legNumber,
          fromVenue: 'gateio',
          toVenue: 'hotcoin',
          asset: 'INC',
          network: 'BSC',
          amount: new Decimal('20'),
          address: '0xabc',
          status: TRANSFER_LEG_STATUS.PLANNED,
        })),
      });
      const result = await preflightTransferBatch({
        repository,
        config,
        venues,
        batchId: 'xfer-daily-preflight',
        now,
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.BLOCKED);
      expect(
        result.legs.every((leg) => leg.reasons.includes('daily_allowlist_limit_exceeded')),
      ).toBe(true);
    } finally {
      repository.close();
    }
  });

  it('fails arrival when the received amount is below requested minus fee', async () => {
    const { repository, gate, hotcoin, venues } = setup({ arrivalAmount: '5' });
    try {
      const config = transferConfig({
        maxLegsPerBatch: 1,
        allowlist: [allowlistEntry()],
      });
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      const result = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        now: () => now,
      });
      expect(result.status).toBe(TRANSFER_BATCH_STATUS.SAFE_STOP);
      expect(result.withdrawalsSubmitted).toBe(1);
      expect(gate.attempts).toBe(1);
      expect(hotcoin.attempts).toBe(0);
      expect(repository.getTransferBatch(batch.id)?.legs[0]?.status).toBe(
        TRANSFER_LEG_STATUS.DEPOSIT_FAILED,
      );
    } finally {
      repository.close();
    }
  });

  it('blocks a plan that would exceed the per-route daily limit', () => {
    const { repository } = setup();
    try {
      const config = transferConfig({
        maxLegsPerBatch: 1,
        allowlist: [allowlistEntry({ dailyMaxAmount: new Decimal('20') })],
      });
      repository.createTransferBatch({
        id: 'prior',
        status: TRANSFER_BATCH_STATUS.COMPLETED,
        plan: {},
        dryRun: false,
        createdAt: now,
        legs: [
          {
            legNumber: 1,
            fromVenue: 'gateio',
            toVenue: 'hotcoin',
            asset: 'INC',
            network: 'BSC',
            amount: new Decimal('15'),
            address: '0xabc',
            status: TRANSFER_LEG_STATUS.ARRIVED,
          },
        ],
      });
      repository.updateTransferLeg('prior', 1, { requestedAt: now, updatedAt: now });
      const batch = planTransferBatch({
        repository,
        config,
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      expect(batch.status).toBe(TRANSFER_BATCH_STATUS.BLOCKED);
      expect(batch.safeModeReason).toContain('daily_allowlist_limit_exceeded');
    } finally {
      repository.close();
    }
  });

  it('requires the automatic arm switch and audits an armed release', async () => {
    const { repository, gate, venues } = setup();
    try {
      const edge = allowlistEntry({
        feeMode: 'deducted',
        expectedArrivalMs: 60_000,
      });
      const config = transferConfig({
        releaseMode: 'automatic',
        maxLegsPerBatch: 1,
        allowlist: [edge],
      });
      const batch = planTransferBatch({
        repository,
        config,
        assetPricesUsd: { INC: new Decimal('0.25'), USDT: new Decimal('1') },
        targets: [
          { venueId: 'gateio', currency: 'INC', targetFree: new Decimal('30') },
          { venueId: 'hotcoin', currency: 'INC', targetFree: new Decimal('30') },
        ],
        now,
      });
      const blocked = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        confirmationMode: 'automatic',
        now: () => now,
      });
      expect(blocked.status).toBe(TRANSFER_BATCH_STATUS.BLOCKED);
      expect(blocked.reasons).toContain('transfer_auto_release_not_armed');
      expect(gate.attempts).toBe(0);

      repository.setSetting('transfer_auto_release_enabled', 'true', now);
      const released = await executeTransferBatch({
        repository,
        config,
        venues,
        batchId: batch.id,
        liveEnabled: true,
        killSwitch: false,
        confirmBatchId: batch.id,
        confirmationMode: 'automatic',
        now: () => now,
      });
      expect(released.status).toBe(TRANSFER_BATCH_STATUS.COMPLETED);
      expect(gate.attempts).toBe(1);
    } finally {
      repository.close();
    }
  });
});
