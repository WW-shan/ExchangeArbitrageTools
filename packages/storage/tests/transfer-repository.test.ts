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
});
