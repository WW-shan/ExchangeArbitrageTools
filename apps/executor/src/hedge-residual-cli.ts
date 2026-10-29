import { Decimal } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from './config.js';
import { adapterMap } from './runtime.js';
import { loadEncryptedSecretStore } from './secret-store.js';
import {
  executeResidualHedge,
  planResidualHedge,
  reconcileResidualHedgeFill,
  type ResidualHedgePlan,
} from './residual-hedge.js';

interface CliOptions {
  batchId?: string;
  confirm?: string;
  dryRun: boolean;
  minProfitUsd: Decimal;
  reconcileHedgeId?: string;
  configPath?: string;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: npm run hedge:residual -- --batch <batchId> --confirm <batchId> [--dry-run]',
    '       [--min-profit-usd 0.01]',
    '       (a negative --min-profit-usd explicitly accepts a bounded loss)',
    '       [--config config/live-rotation.toml]',
    '       npm run hedge:residual -- --reconcile-hedge <hedgeBatchId>',
    '',
    'Plans and optionally submits one FOK order to flatten a long residual left by',
    'a SAFE_STOP execution. The order is recorded as a separate HEDGE execution and',
    'the original execution is reconciled only after a confirmed fill. This command',
    'never clears the kill switch and never retries an unknown order.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    minProfitUsd: new Decimal('0.01'),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }
    if (value === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (
      value === '--batch' ||
      value === '--confirm' ||
      value === '--min-profit-usd' ||
      value === '--config'
    ) {
      const argument = argv[index + 1];
      if (!argument) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === '--batch') options.batchId = argument;
      else if (value === '--confirm') options.confirm = argument;
      else if (value === '--config') options.configPath = argument;
      else {
        const parsed = new Decimal(argument);
        if (!parsed.isFinite() || parsed.lt(-5)) {
          throw new Error('--min-profit-usd must be a finite decimal at or above -5');
        }
        options.minProfitUsd = parsed;
      }
      continue;
    }
    if (value === '--reconcile-hedge') {
      const argument = argv[index + 1];
      if (!argument) throw new Error('--reconcile-hedge requires a hedge batch id');
      index += 1;
      options.reconcileHedgeId = argument;
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return options;
}

function planSummary(plan: ResidualHedgePlan) {
  return {
    originalBatchId: plan.originalBatchId,
    originalExecutionId: plan.originalExecutionId,
    direction: plan.direction,
    base: plan.base,
    quote: plan.quote,
    residualCanonical: plan.residualCanonical.toFixed(),
    costPerCanonical: plan.costPerCanonical.toFixed(),
    costQuote: plan.costQuote.toFixed(),
    hedgeVenue: plan.venueId,
    exchangeSymbol: plan.exchangeSymbol,
    exchangeAmount: plan.exchangeAmount.toFixed(),
    canonicalAmount: plan.canonicalAmount.toFixed(),
    exchangePrice: plan.exchangePrice.toFixed(),
    executableQuote: plan.executableQuote.toFixed(),
    grossFeeQuote: plan.grossFeeQuote.toFixed(),
    netHedgeQuote: plan.netHedgeQuote.toFixed(),
    projectedProfit: plan.projectedProfit.toFixed(),
    freeBase: plan.freeBase.toFixed(),
    freeQuote: plan.freeQuote.toFixed(),
    bookFetchedAt: plan.book.fetchedAt,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.reconcileHedgeId && (!options.batchId || options.confirm !== options.batchId)) {
    throw new Error(usage());
  }
  const batchId = options.batchId;
  const config = loadExecutorConfig(
    options.configPath ?? process.env.ARB_CONFIG ?? 'config/live-rotation.toml',
  );
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const adapters = adapterMap(repository, config, credentials);
    if (options.reconcileHedgeId) {
      const result = await reconcileResidualHedgeFill({
        repository,
        adapters,
        hedgeBatchId: options.reconcileHedgeId,
      });
      console.log(
        JSON.stringify(
          {
            status: result.status,
            reasons: result.reasons,
            hedgeBatchId: result.hedgeBatchId,
            hedgeExecutionId: result.hedgeExecutionId,
            realizedProfit: result.realizedProfit?.toFixed() ?? null,
            order: result.order
              ? {
                  venueOrderId: result.order.venueOrderId,
                  status: result.order.status,
                  filled: result.order.filled.toFixed(),
                  averagePrice: result.order.averagePrice?.toFixed() ?? null,
                  remaining: result.order.remaining.toFixed(),
                }
              : null,
            openExecutions: repository.countOpenExecutions(),
            unresolvedOrders: repository.countUnresolvedOrders(),
            killSwitch: repository.getSetting('kill_switch'),
          },
          null,
          2,
        ),
      );
      if (result.status !== 'HEDGED') process.exitCode = 1;
      return;
    }
    const planned = await planResidualHedge({
      repository,
      config,
      adapters,
      batchId: batchId!,
      minProfitUsd: options.minProfitUsd,
    });
    if (planned.status !== 'PLANNED' || !planned.plan) {
      console.log(JSON.stringify({ status: planned.status, reasons: planned.reasons }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ status: 'PLANNED', plan: planSummary(planned.plan) }, null, 2));
    if (options.dryRun) return;
    const result = await executeResidualHedge({
      repository,
      config,
      adapters,
      batchId: batchId!,
      plan: planned.plan,
    });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          reasons: result.reasons,
          hedgeBatchId: result.hedgeBatchId,
          hedgeExecutionId: result.hedgeExecutionId,
          realizedProfit: result.realizedProfit?.toFixed() ?? null,
          order: result.order
            ? {
                venueOrderId: result.order.venueOrderId,
                status: result.order.status,
                filled: result.order.filled.toFixed(),
                averagePrice: result.order.averagePrice?.toFixed() ?? null,
                remaining: result.order.remaining.toFixed(),
              }
            : null,
          killSwitch: repository.getSetting('kill_switch'),
          autoExecutionEnabled: repository.getSetting('auto_execution_enabled'),
        },
        null,
        2,
      ),
    );
    if (result.status !== 'HEDGED') process.exitCode = 1;
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
