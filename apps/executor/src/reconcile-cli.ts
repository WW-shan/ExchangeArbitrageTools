import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from './config.js';
import { reconcileCarriedInventory, reconcileNoFillExecution } from './execution-reconcile.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): string {
  return [
    'Usage: npm run execution:reconcile -- --batch <batchId> --carry-inventory --confirm <batchId>',
    '       npm run execution:reconcile -- --batch <batchId> --close-no-fill --confirm <batchId>',
    '',
    'Closes a SAFE_STOP execution by carrying verified long inventory or by',
    'closing an execution whose legs were all confirmed as zero-fill.',
    'This does not submit orders or clear the kill switch. Run account:state first,',
    'then release the kill switch only after reviewing the reconciliation output.',
  ].join('\n');
}

function main(): void {
  const batchId = arg('--batch');
  const confirm = arg('--confirm');
  const carryInventory = process.argv.includes('--carry-inventory');
  const closeNoFill = process.argv.includes('--close-no-fill');
  if (
    !batchId ||
    confirm !== batchId ||
    carryInventory === closeNoFill ||
    (!carryInventory && !closeNoFill)
  ) {
    throw new Error(usage());
  }
  const config = loadExecutorConfig();
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const result = carryInventory
      ? reconcileCarriedInventory({
          db: repository.db,
          repository,
          batchId,
        })
      : reconcileNoFillExecution({
          db: repository.db,
          repository,
          batchId,
        });
    console.log(
      JSON.stringify(
        {
          ...result,
          killSwitch: repository.getSetting('kill_switch'),
          autoExecutionEnabled: repository.getSetting('auto_execution_enabled'),
          next: 'Review the result, then run npm run rotation:release -- --confirm RELEASE-KILL-SWITCH',
        },
        null,
        2,
      ),
    );
  } finally {
    repository.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
