import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Decimal } from 'decimal.js';
import {
  planLongInventoryHedges,
  planRebalance,
  type BalancePosition,
  type RebalanceTarget,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadConfig } from '../apps/scanner/src/config.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function parseTargets(value: string): RebalanceTarget[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([^:]+):([^=]+)=(.+)$/);
      if (!match) throw new Error(`invalid target ${entry}; expected venue:CCY=amount`);
      return {
        venueId: match[1]!.trim(),
        currency: match[2]!.trim().toUpperCase(),
        targetFree: new Decimal(match[3]!.trim()),
      };
    });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env.ARB_CONFIG ?? 'config/default.toml');
  const targets = parseTargets(arg('--target', 'gateio:USDT=1000,mexc:USDT=1000,weex:USDT=1000'));
  const maxAgeMs = Number(arg('--max-age-ms', '300000'));
  const minTransferAmount = new Decimal(arg('--min-transfer', '0'));
  const costBps = new Decimal(arg('--cost-bps', '0'));
  const minHedgeNotional = new Decimal(
    arg('--min-hedge-notional', config.scanner.minSizingNotional.toFixed()),
  );
  const hedgeStep = new Decimal(arg('--hedge-step', config.scanner.sizingStep.toFixed()));
  const repository = new ArbitrageRepository(openDatabase(config.database.path));
  const balances = repository.latestBalances({ maxAgeMs, now: Date.now() });
  const positions: BalancePosition[] = balances.map((balance) => ({
    venueId: balance.venueId,
    currency: balance.currency,
    free: balance.free,
  }));
  const plan = planRebalance(positions, targets, { minTransferAmount, costBps });
  const unhedged = repository.openUnhedgedInventory();
  const hedgePlans = planLongInventoryHedges(
    unhedged.map((row) => ({
      venueId: String(row.venue_id),
      asset: String(row.asset),
      amount: new Decimal(String(row.amount)),
      usdValue: new Decimal(String(row.usd_value)),
    })),
    { minHedgeNotional, qtyStep: hedgeStep },
  );
  const report = {
    generatedAt: Date.now(),
    maxAgeMs,
    balanceRows: balances.length,
    targets: targets.map((target) => ({
      venueId: target.venueId,
      currency: target.currency,
      targetFree: target.targetFree.toFixed(),
    })),
    positions: positions.map((position) => ({
      venueId: position.venueId,
      currency: position.currency,
      free: position.free.toFixed(),
    })),
    transfers: plan.transfers.map((transfer) => ({
      currency: transfer.currency,
      fromVenue: transfer.fromVenue,
      toVenue: transfer.toVenue,
      amount: transfer.amount.toFixed(),
      estimatedCost: transfer.estimatedCost.toFixed(),
    })),
    shortfalls: plan.shortfalls.map((shortfall) => ({
      currency: shortfall.currency,
      venueId: shortfall.venueId,
      missing: shortfall.missing.toFixed(),
    })),
    totalEstimatedCost: plan.totalEstimatedCost.toFixed(),
    unhedgedRows: unhedged.length,
    hedgeOrders: hedgePlans.map((hedge) => ({
      venueId: hedge.venueId,
      asset: hedge.asset,
      qty: hedge.qty.toFixed(),
      referencePrice: hedge.referencePrice.toFixed(),
      side: hedge.hedgeSide,
      reduceOnlyQty: hedge.hedgeQty.toFixed(),
    })),
  };
  const output = resolve(arg('--out', 'data/rebalance-plan.json'));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  repository.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
