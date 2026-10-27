import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { ArbitrageRepository, openDatabase } from '../src/index.js';

const now = 1_700_000_000_000;

describe('transfer batch persistence', () => {
  it('stores two legs, blocks duplicates and tracks daily requested amount', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    try {
      repo.createTransferBatch({
        id: 'xfer-1',
        status: 'PLANNED',
        plan: { targets: ['gateio:INC=40'] },
        dryRun: false,
        createdAt: now,
        legs: [
          {
            legNumber: 1,
            fromVenue: 'gateio',
            toVenue: 'hotcoin',
            asset: 'INC',
            network: 'BSC',
            amount: new Decimal('20'),
            address: '0xabc',
            status: 'PLANNED',
          },
          {
            legNumber: 2,
            fromVenue: 'hotcoin',
            toVenue: 'gateio',
            asset: 'USDT',
            network: 'BSC',
            amount: new Decimal('15'),
            address: '0xdef',
            status: 'PLANNED',
          },
        ],
      });

      const batch = repo.getTransferBatch('xfer-1');
      expect(batch).toMatchObject({ id: 'xfer-1', status: 'PLANNED', dryRun: false });
      expect(batch?.legs).toHaveLength(2);
      expect(batch?.legs[0]?.amount.toFixed()).toBe('20');
      expect(repo.activeTransferBatches()).toHaveLength(1);
      expect(repo.countActiveTransferBatches()).toBe(1);
      expect(repo.countActiveTransferBatches('xfer-1')).toBe(0);
      expect(repo.dailyTransferAmount('gateio', 'INC', now - 1).toFixed()).toBe('0');

      repo.updateTransferLeg('xfer-1', 1, {
        status: 'WITHDRAWING',
        sourceRecordId: 'w-1',
        requestedAt: now,
        fee: new Decimal('1'),
        metadata: { network: 'BSC' },
        updatedAt: now + 1,
      });
      repo.updateTransferBatch('xfer-1', {
        status: 'EXECUTING',
        confirmation: 'operator',
        updatedAt: now + 2,
      });

      const updated = repo.getTransferBatch('xfer-1');
      expect(updated?.status).toBe('EXECUTING');
      expect(updated?.confirmation).toBe('operator');
      expect(updated?.legs[0]).toMatchObject({
        status: 'WITHDRAWING',
        sourceRecordId: 'w-1',
      });
      expect(updated?.legs[0]?.fee?.toFixed()).toBe('1');
      expect(repo.dailyTransferAmount('gateio', 'INC', now - 1).toFixed()).toBe('20');
      expect(repo.listTransferBatches(1)).toHaveLength(1);
      expect(() =>
        repo.updateTransferBatch('missing', { status: 'READY', updatedAt: now }),
      ).toThrow('transfer batch not found');
      expect(() => repo.updateTransferLeg('xfer-1', 99, { status: 'READY' })).toThrow(
        'transfer leg not found',
      );

      expect(() =>
        repo.createTransferBatch({
          id: 'xfer-bad',
          status: 'PLANNED',
          plan: {},
          dryRun: false,
          legs: [
            {
              legNumber: 1,
              fromVenue: 'gateio',
              toVenue: 'hotcoin',
              asset: 'INC',
              network: 'BSC',
              amount: new Decimal('0'),
              address: '0xabc',
              status: 'PLANNED',
            },
          ],
        }),
      ).toThrow('positive');
      expect(repo.getTransferBatch('xfer-bad')).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it('claims transfer execution atomically and honours the lease', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    try {
      const createBatch = (id: string): void =>
        repo.createTransferBatch({
          id,
          status: 'PLANNED',
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
              amount: new Decimal('10'),
              address: '0xabc',
              status: 'PLANNED',
            },
          ],
        });
      createBatch('xfer-lock-1');
      expect(
        repo.claimTransferExecution({
          id: 'xfer-lock-1',
          token: 'owner-a',
          now,
          leaseUntil: now + 100,
          confirmation: 'operator-a',
        }),
      ).toEqual({ claimed: true });
      expect(repo.getTransferBatch('xfer-lock-1')?.status).toBe('EXECUTING');
      expect(
        repo.claimTransferExecution({
          id: 'xfer-lock-1',
          token: 'owner-b',
          now: now + 1,
          leaseUntil: now + 200,
        }),
      ).toEqual({ claimed: false, reason: 'batch_execution_locked' });

      createBatch('xfer-lock-2');
      expect(
        repo.claimTransferExecution({
          id: 'xfer-lock-2',
          token: 'owner-c',
          now: now + 2,
          leaseUntil: now + 200,
        }),
      ).toEqual({ claimed: false, reason: 'another_transfer_batch_active' });
      repo.updateTransferBatch('xfer-lock-2', { status: 'BLOCKED', updatedAt: now + 2 });

      expect(
        repo.claimTransferExecution({
          id: 'xfer-lock-1',
          token: 'owner-b',
          now: now + 101,
          leaseUntil: now + 300,
        }),
      ).toEqual({ claimed: true });
      expect(repo.releaseTransferExecution('xfer-lock-1', 'owner-a', now + 102)).toBe(false);
      expect(repo.releaseTransferExecution('xfer-lock-1', 'owner-b', now + 102)).toBe(true);
    } finally {
      repo.close();
    }
  });

  it('applies preflight atomically only while the batch is idle', () => {
    const repo = new ArbitrageRepository(openDatabase(':memory:'));
    try {
      const createBatch = (id: string): void =>
        repo.createTransferBatch({
          id,
          status: 'PLANNED',
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
              amount: new Decimal('10'),
              address: '0xabc',
              status: 'PLANNED',
            },
          ],
        });
      const preflight = (id: string) => ({
        id,
        status: 'READY',
        safeModeReason: null,
        now: now + 1,
        legs: [
          {
            legNumber: 1,
            status: 'READY',
            error: null,
            metadata: { preflightReasons: [] },
          },
        ],
      });

      createBatch('xfer-pf-idle');
      expect(repo.applyTransferPreflight(preflight('xfer-pf-idle'))).toBe(true);
      expect(repo.getTransferBatch('xfer-pf-idle')?.status).toBe('READY');
      expect(repo.getTransferBatch('xfer-pf-idle')?.legs[0]?.status).toBe('READY');
      repo.updateTransferBatch('xfer-pf-idle', { status: 'COMPLETED', updatedAt: now });

      createBatch('xfer-pf-executing');
      expect(
        repo.claimTransferExecution({
          id: 'xfer-pf-executing',
          token: 'owner',
          now,
          leaseUntil: now + 100,
        }),
      ).toEqual({ claimed: true });
      expect(repo.applyTransferPreflight(preflight('xfer-pf-executing'))).toBe(false);
      expect(repo.getTransferBatch('xfer-pf-executing')?.status).toBe('EXECUTING');
      expect(repo.getTransferBatch('xfer-pf-executing')?.legs[0]?.status).toBe('PLANNED');
    } finally {
      repo.close();
    }
  });
});
