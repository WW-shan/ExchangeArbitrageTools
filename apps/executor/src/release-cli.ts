import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from './config.js';

const confirmation = 'RELEASE-KILL-SWITCH';

function requestedConfirmation(): string | undefined {
  const index = process.argv.indexOf('--confirm');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  if (requestedConfirmation() !== confirmation) {
    throw new Error(`--confirm ${confirmation} is required`);
  }
  const config = loadExecutorConfig();
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const now = Date.now();
    const reasons: string[] = [];
    if (repository.countOpenExecutions() > 0) reasons.push('open_execution');
    if (repository.countUnresolvedOrders() > 0) reasons.push('unresolved_order');
    if (repository.activeTransferBatches().length > 0) reasons.push('active_transfer');
    const risk = repository.riskSnapshot(now);
    if (risk.dailyRealizedLoss.gte(config.riskLimits.dailyMaxLoss)) {
      reasons.push('daily_loss_limit');
    }
    if (risk.unhedgedInventoryRisk.gt(0)) reasons.push('unhedged_inventory');
    if (reasons.length > 0) {
      throw new Error(`release blocked: ${reasons.join(',')}`);
    }
    repository.setSetting('kill_switch', 'false', now);
    repository.setSetting('auto_execution_enabled', 'false', now);
    repository.recordAudit('operator', 'kill_switch_released', { confirmation }, now);
    console.log(
      JSON.stringify(
        {
          at: new Date(now).toISOString(),
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

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
