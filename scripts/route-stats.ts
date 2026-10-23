import { ArbitrageRepository, openDatabase } from '@arb/storage';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function text(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function numberText(value: number, width: number): string {
  return value.toFixed(0).padStart(width);
}

async function main(): Promise<void> {
  const databasePath = arg('--db', 'data/arbitrage.sqlite');
  const sinceHours = Math.max(0, Number(arg('--since-hours', '24')));
  const limit = Math.max(1, Number(arg('--limit', '30')));
  const minValid = Math.max(0, Number(arg('--min-valid', '0')));
  const asJson = process.argv.includes('--json');
  const db = openDatabase(databasePath);
  const repository = new ArbitrageRepository(db);
  try {
    const routes = repository
      .s1RouteStats({ sinceMs: sinceHours * 60 * 60 * 1000, limit: 1000 })
      .filter((route) => route.validSamples >= minValid)
      .slice(0, limit);
    if (asJson) {
      console.log(
        JSON.stringify(
          routes.map((route) => ({
            ...route,
            avgNetBps: route.avgNetBps.toFixed(2),
            maxNetBps: route.maxNetBps.toFixed(2),
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (routes.length === 0) {
      console.log(`no S1 routes in the last ${sinceHours}h (${databasePath})`);
      return;
    }
    const header = [
      text('instrument', 16),
      text('buy->sell', 26),
      'samples'.padStart(8),
      'evaluated'.padStart(9),
      'eval%'.padStart(6),
      'valid'.padStart(6),
      'rate%'.padStart(6),
      'avgNetBps'.padStart(9),
      'maxNetBps'.padStart(9),
      'episodes'.padStart(8),
      'p50ms'.padStart(8),
      'p90ms'.padStart(8),
    ].join(' ');
    console.log(header);
    for (const route of routes) {
      console.log(
        [
          text(route.instrument, 16),
          text(`${route.venueBuy}->${route.venueSell}`, 26),
          numberText(route.samples, 8),
          numberText(route.evaluatedSamples, 9),
          `${(route.evaluationRate * 100).toFixed(1)}%`.padStart(6),
          numberText(route.validSamples, 6),
          `${(route.validRate * 100).toFixed(1)}%`.padStart(6),
          route.avgNetBps.toFixed(2).padStart(9),
          route.maxNetBps.toFixed(2).padStart(9),
          numberText(route.episodes, 8),
          numberText(route.medianDurationMs, 8),
          numberText(route.p90DurationMs, 8),
        ].join(' '),
      );
    }
  } finally {
    repository.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
