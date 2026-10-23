import { ExecutionGate, type HealthState, type MarketMetadata } from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import {
  CEX_TIERS,
  createCcxtAdapter,
  createPublicRuntime,
  isCcxtShutdownError,
} from '@arb/venues-cex';
import { loadExecutorConfig } from './config.js';
import { CexLiveExecutor, type ExecutionVenue } from './coordinator.js';
import { recoverExecutorStartup, type RecoveryVenue } from './bootstrap.js';
import {
  buildS1ExecutionRequest,
  runS1Handoff,
  selectS1Handoff,
  type S1HandoffSelection,
} from './handoff.js';
import { loadEncryptedSecretStore, type StoredCredential } from './secret-store.js';

interface CliOptions {
  execute: boolean;
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
    '  --opportunity <id>       Select a specific valid S1 opportunity row',
    '  --confirm-batch <id>     Exact manual confirmation for the prepared batch',
    '  --execute                Request submission when all live gates are open',
    '  --help                   Show this message',
    '',
    'Live submission also requires live_enabled=true in config, a released persisted',
    'kill switch, clean startup recovery, and a matching --confirm-batch value.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { execute: false, help: false };
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
  return options;
}

function splitInstrument(key: string): { base: string; quote: string } | undefined {
  const parts = key.split('/');
  if (parts.length !== 2) return undefined;
  const base = parts[0]?.trim().toUpperCase() ?? '';
  const quote = parts[1]?.trim().toUpperCase() ?? '';
  return base && quote ? { base, quote } : undefined;
}

function healthStates(repository: ArbitrageRepository): Map<string, HealthState> {
  const states = new Map<string, HealthState>();
  for (const row of repository.latestHealth()) {
    const state = row.health_state;
    if (state === 'A' || state === 'B' || state === 'C' || state === 'D') {
      states.set(String(row.venue_id), state);
    }
  }
  return states;
}

function findMarket(
  markets: MarketMetadata[],
  venueId: string,
  base: string,
  quote: string,
  exchangeSymbol?: string,
): MarketMetadata | undefined {
  const matches = markets.filter(
    (market) =>
      market.active &&
      market.venueId === venueId &&
      market.base.trim().toUpperCase() === base &&
      market.quote.trim().toUpperCase() === quote,
  );
  if (exchangeSymbol) {
    const exact = matches.filter((market) => market.exchangeSymbol === exchangeSymbol);
    return exact.length === 1 ? exact[0] : undefined;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function runtimeFor(
  repository: ArbitrageRepository,
  venueId: string,
): ReturnType<typeof createPublicRuntime> {
  const ensureVenue = (): void => {
    repository.upsertVenue({
      id: venueId,
      type: 'cex',
      name: venueId,
      tier: CEX_TIERS[venueId] ?? 'B',
    });
  };
  return createPublicRuntime(1, undefined, {
    onBackoff: (state) => {
      ensureVenue();
      repository.upsertVenueBackoff({
        venueId,
        backoffUntil: state.backoffUntil,
        reason: state.reason,
        consecutiveFailures: state.consecutiveFailures,
        updatedAt: Date.now(),
      });
      repository.recordRiskEvent('warning', 'venue_backoff', state.reason, {
        venueId,
        backoffUntil: state.backoffUntil,
        retryAfterMs: state.retryAfterMs,
        consecutiveFailures: state.consecutiveFailures,
      });
    },
    onRecover: () => repository.clearVenueBackoff(venueId),
  });
}

function adapterMap(
  repository: ArbitrageRepository,
  config: ReturnType<typeof loadExecutorConfig>,
  credentials: ReadonlyMap<string, StoredCredential>,
): Record<string, RecoveryVenue> {
  const venues: Record<string, RecoveryVenue> = {};
  for (const credential of credentials.values()) {
    if (credential.role !== 'trade') continue;
    const venueId = credential.venueId;
    if (!CEX_TIERS[venueId]) {
      repository.recordRiskEvent(
        'warning',
        'executor_venue_unsupported',
        'credential exists for a venue without a supported CCXT execution adapter',
        { venueId },
      );
      continue;
    }
    const runtime = runtimeFor(repository, venueId);
    const adapter = createCcxtAdapter(venueId, runtime, {
      credentials: credential,
      readOnly: false,
      supportsIoc: config.iocVenues.includes(venueId),
      supportsFok: config.fokVenues.includes(venueId),
    });
    venues[venueId] = {
      adapter,
      credentials: credential,
      applyBackoff: (retryAfterMs) => runtime.rateLimiter.respectRetryAfter(retryAfterMs),
    };
  }
  return venues;
}

function executionVenue(
  venueId: string,
  markets: MarketMetadata[],
  instrument: { base: string; quote: string },
  adapters: Record<string, RecoveryVenue>,
  states: Map<string, HealthState>,
  exchangeSymbol?: string,
): ExecutionVenue {
  const bundle = adapters[venueId];
  if (!bundle) throw new Error(`no trade credential/adapter for ${venueId}`);
  const market = findMarket(markets, venueId, instrument.base, instrument.quote, exchangeSymbol);
  if (!market)
    throw new Error(
      `no single active market for ${venueId} ${instrument.base}/${instrument.quote}`,
    );
  return {
    adapter: bundle.adapter,
    market,
    credentials: bundle.credentials,
    healthState: states.get(venueId) ?? 'D',
  };
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

    const opportunity = selection.selection.loaded.opportunity;
    const instrument = splitInstrument(opportunity.instrumentKey);
    if (!instrument) throw new Error('stored opportunity instrument is malformed');
    const buyBundle = adapters[opportunity.venueBuy];
    const sellBundle = adapters[opportunity.venueSell];
    if (!buyBundle || !sellBundle) {
      throw new Error('trade credentials are missing for one side of the opportunity');
    }
    const [buyMarkets, sellMarkets] = await Promise.all([
      buyBundle.adapter.loadMarkets(),
      sellBundle.adapter.loadMarkets(),
    ]);
    const states = healthStates(repository);
    const buy = executionVenue(
      opportunity.venueBuy,
      buyMarkets,
      instrument,
      adapters,
      states,
      opportunity.metadata?.buySymbol,
    );
    const sell = executionVenue(
      opportunity.venueSell,
      sellMarkets,
      instrument,
      adapters,
      states,
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

    const gate = new ExecutionGate(config.riskLimits);
    const persistedKillSwitchNow = repository.getSetting('kill_switch') !== 'false';
    gate.setKillSwitch(persistedKillSwitchNow, 'persisted_kill_switch_on');
    const engine = new CexLiveExecutor({
      repository,
      gate,
      limits: config.riskLimits,
      liveEnabled: config.liveEnabled,
      settings: config.settings,
    });
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
