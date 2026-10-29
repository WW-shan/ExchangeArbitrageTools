import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from './config.js';

function main(): void {
  const config = loadExecutorConfig();
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const now = Date.now();
    repository.setSetting('kill_switch', 'true', now);
    repository.setSetting('auto_execution_enabled', 'false', now);
    repository.recordRiskEvent(
      'critical',
      'operator_halt',
      'rotation halt requested; new execution is disabled',
      {},
      now,
    );
    repository.recordAudit('operator', 'rotation_halt', {}, now);
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
