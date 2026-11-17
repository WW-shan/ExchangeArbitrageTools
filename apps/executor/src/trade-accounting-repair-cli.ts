import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from './config.js';
import { repairClosedS1Accounting, repairS1RiskAdjustment } from './trade-accounting-repair.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): string {
  return [
    'Usage: npm run trade:repair-accounting -- --batch <batchId> --confirm <batchId> [--config <path>] [--reconcile-risk]',
    '',
    'Repairs only the fee/P&L attribution of an already-closed, fully-filled S1',
    'execution. It converts base-asset fees to quote before subtracting them. It',
    'never submits or cancels an order and never changes the kill switch.',
  ].join('\n');
}

async function main(): Promise<void> {
  const batchId = arg('--batch');
  const confirm = arg('--confirm');
  if (!batchId || confirm !== batchId) throw new Error(usage());
  const config = loadExecutorConfig(
    arg('--config') ?? process.env.ARB_CONFIG ?? 'config/live-rotation.toml',
  );
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const result = process.argv.includes('--reconcile-risk')
      ? repairS1RiskAdjustment({ repository, batchId })
      : repairClosedS1Accounting({ repository, batchId });
    console.log(
      JSON.stringify(
        {
          ...result,
          killSwitch: repository.getSetting('kill_switch'),
          autoExecutionEnabled: repository.getSetting('auto_execution_enabled'),
        },
        null,
        2,
      ),
    );
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
