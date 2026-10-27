import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createCcxtAdapter, createPublicRuntime, isCcxtShutdownError } from '@arb/venues-cex';
import { loadConfig } from '../apps/scanner/src/config.js';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
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

  const configPath = process.env.ARB_CONFIG ?? 'config/default.toml';
  const config = loadConfig(configPath);
  const executor = loadExecutorConfig(configPath);
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(executor.secretStorePath, masterKey);

  const filter = arg('--venues', '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const venueIds = filter.length > 0 ? filter : config.scanner.enabledVenues;
  const output: Record<string, Record<string, { takerBps?: string; makerBps?: string }>> = {};

  for (const venueId of venueIds) {
    if (venueId === 'hotcoin') {
      console.error(
        'skip hotcoin: account fee endpoint is not verified; set [fees.hotcoin] or data/fees.json manually',
      );
      continue;
    }
    const credential =
      credentials.get(`${venueId}:read_only`) ?? credentials.get(`${venueId}:trade`);
    if (!credential) {
      console.error(`skip ${venueId}: no read_only/trade credential`);
      continue;
    }
    const adapter = createCcxtAdapter(venueId, createPublicRuntime(2), {
      credentials: {
        apiKey: credential.apiKey,
        secret: credential.secret,
        ...(credential.password ? { password: credential.password } : {}),
      },
      readOnly: true,
    });
    try {
      const fees = await adapter.fetchTradingFees?.();
      if (!fees) {
        console.error(`skip ${venueId}: fetchTradingFees unavailable`);
        continue;
      }
      const row: Record<string, { takerBps?: string; makerBps?: string }> = {};
      let zeroTaker = 0;
      for (const [symbol, fee] of Object.entries(fees)) {
        row[symbol] = {
          ...(fee.takerBps !== undefined ? { takerBps: fee.takerBps.toFixed() } : {}),
          ...(fee.makerBps !== undefined ? { makerBps: fee.makerBps.toFixed() } : {}),
        };
        if (fee.takerBps?.eq(0)) zeroTaker += 1;
      }
      output[venueId] = row;
      console.log(JSON.stringify({ venueId, symbols: Object.keys(row).length, zeroTaker }));
    } catch (error) {
      console.error(`failed ${venueId}: ${String(error)}`);
    } finally {
      try {
        await adapter.close?.();
      } catch {
        // ignore shutdown errors
      }
    }
  }

  const outputPath = resolve(arg('--out', 'data/fees.json'));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
