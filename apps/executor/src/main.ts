import { ExecutionGate } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { applyFeeOverride, isCcxtShutdownError, mergeAccountFeeFile } from '@arb/venues-cex';
import { loadExecutorConfig } from './config.js';
import { CexLiveExecutor } from './coordinator.js';
import { recoverExecutorStartup } from './bootstrap.js';
import {
  buildS1ExecutionRequest,
  runS1Handoff,
  selectS1Handoff,
  type S1HandoffSelection,
} from './handoff.js';
import { loadEncryptedSecretStore, type StoredCredential } from './secret-store.js';
import { adapterMap, executionVenue, healthStates, splitInstrument } from './runtime.js';
import { runAutoRotationSupervisor } from './auto-supervisor.js';

interface CliOptions {
  execute: boolean;
  auto: boolean;
  confirmBatchId?: string;
  opportunityId?: number;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: npm run executor -- [options]',
    '',
    'Default mode is read-only: it loads the latest persisted S1 opportunity, checks',
    'credentials/recovery state, and prints the exact batch confirmation string.',
    '',
    'Options:',
    '  --auto                    Run the whitelisted automatic two-sided rotation supervisor',
    '  --opportunity <id>       Select a specific valid S1 opportunity row',
    '  --confirm-batch <id>     Exact manual confirmation for the prepared batch',
    '  --execute                Request submission when all live gates are open',
    '  --help                   Show this message',
    '',
    'Manual live submission requires live_enabled=true, a released persisted kill',
    'switch, clean startup recovery, and a matching --confirm-batch value. The',
    '--auto path uses its own persisted automatic-execution gate instead.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { execute: false, auto: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }
    if (value === '--execute') {
      options.execute = true;
      continue;
    }
    if (value === '--auto') {
      options.auto = true;
      continue;
    }
    if (value === '--opportunity' || value === '--confirm-batch') {
      const argument = argv[index + 1];
      if (!argument) throw new Error(`${value} requires a value`);
      index += 1;
      if (value === '--opportunity') {
        const parsed = Number(argument);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error('--opportunity must be a positive integer');
        }
        options.opportunityId = parsed;
      } else {
        options.confirmBatchId = argument;
      }
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  if (options.auto && (options.execute || options.confirmBatchId || options.opportunityId)) {
    throw new Error('--auto cannot be combined with manual handoff options');
  }
  return options;
}

function printSelection(selection: S1HandoffSelection): void {
  const opportunity = selection.loaded.opportunity;
  console.log(
    JSON.stringify(
      {
        mode: 'handoff_check',
        opportunityId: selection.loaded.id,
        batchId: selection.batchId,
        ageMs: selection.ageMs,
        route: `${opportunity.venueBuy} -> ${opportunity.venueSell}`,
        instrument: opportunity.instrumentKey,
        requestedNotional: opportunity.requestedNotional.toFixed(),
        conservativeNetProfit: opportunity.conservativeNetProfit.toFixed(),
        netProfitBps: opportunity.netProfitBps.toFixed(),
        sampledAt: opportunity.sampledAt,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  process.on('uncaughtException', (error) => {
    if (isCcxtShutdownError(error)) return;
    console.error(error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    if (isCcxtShutdownError(error)) return;
    console.error(error);
    process.exit(1);
  });
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const config = loadExecutorConfig();
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    const persistedKillSwitch = repository.getSetting('kill_switch');
    if (config.killSwitch || persistedKillSwitch === undefined) {
      repository.setSetting('kill_switch', String(config.killSwitch));
    }
    repository.setSetting('live_enabled', String(config.liveEnabled));
    repository.recordAudit('executor', 'startup', {
      liveEnabled: config.liveEnabled,
      persistedKillSwitch: repository.getSetting('kill_switch') !== 'false',
      executeRequested: options.execute,
    });

    const masterKey = process.env.ARB_SECRET_STORE_KEY;
    if (!masterKey) {
      repository.recordRiskEvent(
        'critical',
        'executor_secret_store_key_missing',
        'ARB_SECRET_STORE_KEY is required before the executor can validate credentials',
      );
      console.error('executor locked: ARB_SECRET_STORE_KEY is not set');
      process.exitCode = 2;
      return;
    }
    let credentials: ReadonlyMap<string, StoredCredential>;
    try {
      credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
    } catch (error) {
      repository.recordRiskEvent('critical', 'executor_secret_store_unavailable', String(error));
      console.error(`executor locked: encrypted credential store unavailable: ${String(error)}`);
      process.exitCode = 2;
      return;
    }
    const adapters = adapterMap(repository, config, credentials);
    const recovery = await recoverExecutorStartup({ repository, venues: adapters });
    console.log(JSON.stringify({ mode: 'startup_recovery', ...recovery }, null, 2));
    if (recovery.decision.blockExecution) {
      repository.recordAudit('executor', 'execution_blocked_after_recovery', recovery.decision);
      console.error(`executor locked: ${recovery.decision.reasons.join(',')}`);
      process.exitCode = 2;
      return;
    }

    const gate = new ExecutionGate(config.riskLimits);
    const persistedKillSwitchNow = repository.getSetting('kill_switch') !== 'false';
    gate.setKillSwitch(persistedKillSwitchNow, 'persisted_kill_switch_on');
    const engine = new CexLiveExecutor({
      repository,
      gate,
      limits: config.riskLimits,
      liveEnabled: config.liveEnabled,
      autoExecutionEnabled: config.autoRotation.enabled,
      legMode: config.legMode,
      settings: config.settings,
    });

    if (options.auto) {
      if (!config.autoRotation.enabled) {
        throw new Error('--auto requires auto_rotation.enabled=true in the config');
      }
      let stopping = false;
      const stop = (): void => {
        stopping = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await runAutoRotationSupervisor({
        repository,
        config,
        adapters,
        engine,
        shouldStop: () => stopping,
      });
      return;
    }

    const selection = selectS1Handoff(repository, {
      maxAgeMs: config.handoffMaxAgeMs,
      ...(options.opportunityId !== undefined ? { opportunityId: options.opportunityId } : {}),
    });
    if (!selection.ok) {
      repository.recordRiskEvent(
        'warning',
        `execution_handoff_${selection.reason}`,
        selection.reason,
        {
          ...(selection.batchId ? { batchId: selection.batchId } : {}),
          ...(selection.ageMs !== undefined ? { ageMs: selection.ageMs } : {}),
          ...(selection.priorExecution ? { priorExecution: selection.priorExecution } : {}),
        },
      );
      console.error(JSON.stringify(selection, null, 2));
      process.exitCode = 2;
      return;
    }
    printSelection(selection.selection);

    const opportunity = selection.selection.loaded.opportunity;
    const instrument = splitInstrument(opportunity.instrumentKey);
    if (!instrument) throw new Error('stored opportunity instrument is malformed');
    const buyBundle = adapters[opportunity.venueBuy];
    const sellBundle = adapters[opportunity.venueSell];
    if (!buyBundle || !sellBundle) {
      throw new Error('trade credentials are missing for one side of the opportunity');
    }
    const feeOverrides = mergeAccountFeeFile(config.feeOverrides, config.feeFile);
    const [rawBuyMarkets, rawSellMarkets] = await Promise.all([
      buyBundle.adapter.loadMarkets(),
      sellBundle.adapter.loadMarkets(),
    ]);
    const buyMarkets = rawBuyMarkets.map((market) => applyFeeOverride(market, feeOverrides));
    const sellMarkets = rawSellMarkets.map((market) => applyFeeOverride(market, feeOverrides));
    const states = healthStates(repository);
    const buy = executionVenue(
      opportunity.venueBuy,
      buyMarkets,
      instrument,
      adapters,
      states,
      feeOverrides,
      opportunity.metadata?.buySymbol,
    );
    const sell = executionVenue(
      opportunity.venueSell,
      sellMarkets,
      instrument,
      adapters,
      states,
      feeOverrides,
      opportunity.metadata?.sellSymbol,
    );
    const build = buildS1ExecutionRequest({
      selection: selection.selection,
      buy,
      sell,
      ...(options.confirmBatchId ? { confirmedBatchId: options.confirmBatchId } : {}),
    });
    if (!build.ok) {
      repository.recordRiskEvent('critical', 'execution_handoff_invalid', build.reasons.join(','), {
        batchId: selection.selection.batchId,
      });
      console.error(JSON.stringify({ status: 'INVALID_HANDOFF', reasons: build.reasons }, null, 2));
      process.exitCode = 2;
      return;
    }

    const result = await runS1Handoff({
      repository,
      request: build.request,
      batchId: selection.selection.batchId,
      liveEnabled: config.liveEnabled,
      executeRequested: options.execute,
      ...(options.confirmBatchId ? { confirmedBatchId: options.confirmBatchId } : {}),
      engine,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'EXECUTED' && result.status !== 'AWAITING_CONFIRMATION') {
      process.exitCode = 2;
    } else if (result.execution && result.execution.outcome !== 'CLOSED') {
      process.exitCode = 2;
    }
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
