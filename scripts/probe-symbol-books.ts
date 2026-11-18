/**
 * Read-only probe: sample the top of book on several venues and report how
 * often it actually changes.
 *
 *   npx tsx scripts/probe-symbol-books.ts --base BREV --samples 40 --interval 2000
 *
 * A venue whose best bid/ask never moves is either genuinely dead or serving a
 * frozen snapshot. Either way, a cross-venue spread involving it is not
 * tradeable, and the dislocation detector must reject it.
 */
import { Decimal } from '@arb/core';
import { createCexAdapter, createPublicRuntime } from '@arb/venues-cex';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const base = arg('--base', 'BREV').toUpperCase();
const samples = Math.max(2, Number(arg('--samples', '30')));
const intervalMs = Math.max(250, Number(arg('--interval', '2000')));
const venues = arg('--venues', 'gateio,bitget,weex')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const proxyUrl = process.env.ARB_PROXY_URL;

interface Sample {
  bid: Decimal;
  ask: Decimal;
  at: number;
}

const runtime = createPublicRuntime(6);
const adapters = venues.map((venueId) =>
  createCexAdapter(venueId, runtime, proxyUrl ? { proxyUrl } : {}),
);

const state = new Map<string, { symbol?: string; rows: Sample[]; errors: number }>();
for (const adapter of adapters) state.set(adapter.venueId, { rows: [], errors: 0 });

try {
  for (let round = 0; round < samples; round += 1) {
    await Promise.all(
      adapters.map(async (adapter) => {
        const entry = state.get(adapter.venueId)!;
        try {
          if (!entry.symbol) {
            const markets = await adapter.loadMarkets();
            const market = markets.find(
              (row) =>
                row.base.trim().toUpperCase() === base && row.quote.trim().toUpperCase() === 'USDT',
            );
            if (!market) throw new Error('market_missing');
            entry.symbol = market.exchangeSymbol;
          }
          const book = await adapter.fetchOrderBook(entry.symbol, 5);
          const bid = book.bids[0]?.price;
          const ask = book.asks[0]?.price;
          if (bid && ask) entry.rows.push({ bid, ask, at: Date.now() });
        } catch (error) {
          entry.errors += 1;
          if (entry.errors <= 2) console.error(`${adapter.venueId}: ${String(error)}`);
        }
      }),
    );
    if (round < samples - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
} finally {
  await Promise.all(adapters.map((adapter) => adapter.close?.().catch(() => undefined)));
}

console.log(`\n${base}/USDT, ${samples} samples, ${intervalMs} ms apart\n`);
for (const [venueId, entry] of state) {
  if (entry.rows.length === 0) {
    console.log(`${venueId.padEnd(8)} no books (errors=${entry.errors})`);
    continue;
  }
  const unique = new Set(entry.rows.map((row) => `${row.bid}|${row.ask}`));
  const first = entry.rows[0]!;
  const last = entry.rows[entry.rows.length - 1]!;
  const spanMs = last.at - first.at;
  const changes = entry.rows.reduce(
    (total, row, index) =>
      index === 0
        ? 0
        : total + (row.bid.eq(entry.rows[index - 1]!.bid) && row.ask.eq(entry.rows[index - 1]!.ask) ? 0 : 1),
    0,
  );
  console.log(
    `${venueId.padEnd(8)} books=${String(entry.rows.length).padStart(3)} ` +
      `unique=${String(unique.size).padStart(3)} changes=${String(changes).padStart(3)} ` +
      `span=${(spanMs / 1000).toFixed(1)}s errors=${entry.errors}`,
  );
  console.log(
    `         first ${first.bid.toString()}/${first.ask.toString()} -> ` +
      `last ${last.bid.toString()}/${last.ask.toString()}`,
  );
}
