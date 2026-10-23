import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { runReplay, type ReplayFixture } from '../apps/scanner/src/replay.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function main(): Promise<void> {
  const fixturePath = resolve(arg('--fixture', 'fixtures/backtest/s1-cake-usdt.json'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as ReplayFixture;
  const paperSimulation = process.argv.includes('--paper');
  const db = openDatabase(':memory:');
  const repository = new ArbitrageRepository(db);
  const report = await runReplay(fixture, { repository, paperSimulation });
  const slug = (fixture.name ?? 'replay')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const output = resolve(arg('--out', `data/replay-report-${slug || 'fixture'}.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  repository.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
