import { CEX_TIERS } from '@arb/venues-cex';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { loadExecutorConfig } from './config.js';

export type VenueAction = 'enable' | 'disable' | 'status';

export interface VenueCommand {
  action: VenueAction;
  venueId?: string;
  help: boolean;
}

export interface VenueCommandResult {
  action: VenueAction;
  venueId?: string;
  changed?: boolean;
  venues?: Array<{ id: string; tier: string; executionEnabled: boolean }>;
}

function usage(): string {
  return [
    'Usage: npm run executor:venue -- [--status | --enable <venue> | --disable <venue>]',
    '',
    'Reads and updates the persisted per-venue execution_enabled gate. Every change is',
    'written to the audit log as an operator action. Enabling a venue is not enough to',
    'trade: config live_enabled, the persisted kill switch, manual confirmation, and the',
    'executor --execute/--confirm-batch gates must also pass.',
  ].join('\n');
}

export function parseVenueArgs(argv: string[]): VenueCommand {
  const command: VenueCommand = { action: 'status', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      command.help = true;
      continue;
    }
    if (value === '--status') {
      command.action = 'status';
      continue;
    }
    if (value === '--enable' || value === '--disable') {
      const venueId = argv[index + 1];
      if (!venueId) throw new Error(`${value} requires a venue id`);
      index += 1;
      command.action = value === '--enable' ? 'enable' : 'disable';
      command.venueId = venueId.trim().toLowerCase();
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return command;
}

export function applyVenueCommand(
  repository: ArbitrageRepository,
  command: VenueCommand,
): VenueCommandResult {
  if (command.action === 'status') {
    return {
      action: 'status',
      venues: repository.latestHealth().map((row) => ({
        id: String(row.venue_id),
        tier: String(row.tier),
        executionEnabled: Number(row.execution_enabled) === 1,
      })),
    };
  }
  const venueId = command.venueId;
  if (!venueId) throw new Error(`${command.action} requires a venue id`);
  if (!CEX_TIERS[venueId]) throw new Error(`unsupported CEX venue: ${venueId}`);
  const enabled = command.action === 'enable';
  if (!repository.setVenueExecutionEnabled(venueId, enabled)) {
    throw new Error(`venue is not registered yet: ${venueId}`);
  }
  repository.recordAudit(
    'operator',
    enabled ? 'venue_execution_enabled' : 'venue_execution_disabled',
    { venueId },
  );
  return { action: command.action, venueId, changed: true };
}

async function main(): Promise<void> {
  const command = parseVenueArgs(process.argv.slice(2));
  if (command.help) {
    console.log(usage());
    return;
  }
  const config = loadExecutorConfig();
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    console.log(JSON.stringify(applyVenueCommand(repository, command), null, 2));
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
