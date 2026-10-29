import { existsSync } from 'node:fs';
import { ExecutionGate } from '@arb/core';
import { ArbitrageRepository, openDatabase, writeHeartbeat } from '@arb/storage';
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
import { transferVenuesFromCredentials, type LoadedTransferVenues } from './transfer-runtime.js';
import { TRANSFER_BATCH_STATUS, reconcileTransferBatch } from './transfer-service.js';

interface CliOptions {
  execute: boolean;
  auto: boolean;
  confirmBatchId?: string;
  opportunityId?: number;
  help: boolean;
  allowUnsupervised: boolean;
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
    '  --allow-unsupervised     Allow --auto outside the Windows watchdog (debug only)',
    '',
    'Manual live submission requires live_enabled=true, a released persisted kill',
    'switch, clean startup recovery, and a matching --confirm-batch value. The',
    '--auto path uses its own persisted automatic-execution gate instead.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    auto: false,
    help: false,
    allowUnsupervised: false,
  };
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
    if (value === '--allow-unsupervised') {
      options.allowUnsupervised = true;
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
  const heartbeatPath =
    process.env.ARB_ROTATION_EXECUTOR_HEARTBEAT ?? config.autoRotation.heartbeatFile;
  const writeTerminalHeartbeat = (reason: string): void => {
    try {
      writeHeartbeat(heartbeatPath, {
        version: 1,
        role: 'executor',
        ...(process.env.ARB_ROTATION_RUN_ID ? { runId: process.env.ARB_ROTATION_RUN_ID } : {}),
        pid: process.pid,
        startedAt: Number(process.env.ARB_ROTATION_STARTED_AT ?? Date.now()),
        updatedAt: Date.now(),
        state: 'stopped',
        phase: 'STOPPED',
        lastWaitReasons: [reason],
        details: { terminal: 'blocked', reason },
      });
    } catch {
      // The watchdog still sees the process exit and will retry with backoff.
    }
  };
  let transferRuntime: LoadedTransferVenues | undefined;
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
      writeTerminalHeartbeat('secret_store_key_missing');
      process.exitCode = 2;
      return;
    }
    let credentials: ReadonlyMap<string, StoredCredential>;
    try {
      credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
    } catch (error) {
      repository.recordRiskEvent('critical', 'executor_secret_store_unavailable', String(error));
      console.error(`executor locked: encrypted credential store unavailable: ${String(error)}`);
      writeTerminalHeartbeat('secret_store_unavailable');
      process.exitCode = 2;
      return;
    }
    const adapters = adapterMap(repository, config, credentials);
    const activeTransfersAtStart = repository.activeTransferBatches();
    if (config.transfers.enabled || activeTransfersAtStart.length > 0) {
      transferRuntime = transferVenuesFromCredentials(credentials.values());
    }
    const recovery = await recoverExecutorStartup({
      repository,
      venues: adapters,
      pairs: config.autoRotation.pairs,
      accountStatus: {
        config: config.accountStatus,
        credentials: [...credentials.values()],
      },
    });
    console.log(JSON.stringify({ mode: 'startup_recovery', ...recovery }, null, 2));
    if (recovery.decision.blockExecution) {
      repository.recordAudit('executor', 'execution_blocked_after_recovery', recovery.decision);
      console.error(`executor locked: ${recovery.decision.reasons.join(',')}`);
      writeTerminalHeartbeat('startup_recovery_blocked');
      process.exitCode = 2;
      return;
    }

    if (activeTransfersAtStart.length > 0) {
      if (!transferRuntime || Object.keys(transferRuntime.venues).length === 0) {
        repository.recordRiskEvent(
          'critical',
          'startup_transfer_venues_unavailable',
          'active transfer requires read and withdrawal credentials',
        );
        repository.setSetting('kill_switch', 'true');
        console.error('executor locked: active transfer cannot be reconciled');
        writeTerminalHeartbeat('active_transfer_unreconciled');
        process.exitCode = 2;
        return;
      }
      for (const batch of activeTransfersAtStart) {
        const reconciled = await reconcileTransferBatch({
          repository,
          config: config.transfers,
          venues: transferRuntime.venues,
          batchId: batch.id,
        });
        repository.recordAudit('executor', 'startup_transfer_reconciled', reconciled);
        if (reconciled.status === TRANSFER_BATCH_STATUS.SAFE_STOP) {
          repository.setSetting('kill_switch', 'true');
          console.error(`executor locked: transfer ${batch.id} is SAFE_STOP`);
          writeTerminalHeartbeat('transfer_safe_stop');
          process.exitCode = 2;
          return;
        }
      }
      if (repository.activeTransferBatches().length > 0 && !options.auto) {
        console.error('executor locked: an inventory transfer is still in progress');
        writeTerminalHeartbeat('transfer_in_progress');
        process.exitCode = 2;
        return;
      }
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
      if (process.env.ARB_ROTATION_SUPERVISED !== '1' && !options.allowUnsupervised) {
        repository.recordRiskEvent(
          'critical',
          'auto_execution_unsupervised',
          '--auto must be started by scripts/watch-rotation.ps1',
        );
        console.error('executor locked: --auto requires ARB_ROTATION_SUPERVISED=1');
        writeTerminalHeartbeat('unsupervised');
        process.exitCode = 2;
        return;
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
        accountStatusCredentials: [...credentials.values()],
        ...(transferRuntime ? { transferVenues: transferRuntime.venues } : {}),
        shouldStop: () =>
          stopping || existsSync(process.env.ARB_ROTATION_STOP_FILE ?? 'data/rotation.stop'),
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
    for (const adapter of transferRuntime?.adapters ?? []) {
      try {
        await adapter.close?.();
      } catch {}
    }
    repository.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
