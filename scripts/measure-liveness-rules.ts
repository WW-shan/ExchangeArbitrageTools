/**
 * Measure real turnover per pair, then ask which pairs each liveness rule
 * would accept.
 *
 * Samples every venue ticker twice, `--gap-ms` apart, and compares the
 * observed 24h-volume delta against (a) an absolute USDT floor and (b) a
 * fraction of the venue's own 24h rate. Read-only, no credentials.
 *
 *   npx tsx scripts/measure-liveness-rules.ts --gap-ms 90000
 */
import { Decimal } from "@arb/core";
import { createCexAdapter, createPublicRuntime } from "@arb/venues-cex";

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const gapMs = Math.max(5_000, Number(arg("--gap-ms", "90000")));
const floorUsd = new Decimal(arg("--floor-usd", "10"));
const fraction = new Decimal(arg("--fraction", "0.3"));
const minVolume = new Decimal(arg("--min-volume-usd", "200"));
const maxVolume = new Decimal(arg("--max-volume-usd", "5000000"));
const proxyUrl = process.env.ARB_PROXY_URL ?? "socks5://127.0.0.1:10808";
const venues = ["gateio", "bitget"] as const;

const runtime = createPublicRuntime(8);
const adapters = new Map(
  venues.map((venueId) => [venueId, createCexAdapter(venueId, runtime, { proxyUrl })]),
);

type Snapshot = Map<string, Decimal>;

async function snapshot(): Promise<{ at: number; rows: Map<string, Snapshot> }> {
  const at = Date.now();
  const rows = new Map<string, Snapshot>();
  await Promise.all(
    venues.map(async (venueId) => {
      const adapter = adapters.get(venueId)!;
      const tickers = adapter.fetchTickers ? await adapter.fetchTickers() : [];
      const by = new Map<string, Decimal>();
      for (const ticker of tickers) {
        if (!ticker.quoteVolume || !ticker.quoteVolume.isFinite()) continue;
        if (ticker.quoteVolume.lt(minVolume) || ticker.quoteVolume.gt(maxVolume)) continue;
        by.set(ticker.exchangeSymbol, ticker.quoteVolume);
      }
      rows.set(venueId, by);
    }),
  );
  return { at, rows };
}

try {
  console.log(`sampling ${venues.join("+")} twice, ${gapMs / 1000}s apart...`);
  const first = await snapshot();
  await new Promise((resolve) => setTimeout(resolve, gapMs));
  const second = await snapshot();
  const spanMs = second.at - first.at;

  let total = 0;
  let liveAbsolute = 0;
  let liveRelative = 0;
  let liveEither = 0;
  const recovered: string[] = [];
  const killed: string[] = [];

  for (const venueId of venues) {
    const before = first.rows.get(venueId)!;
    const after = second.rows.get(venueId)!;
    for (const [symbol, endVolume] of after) {
      const startVolume = before.get(symbol);
      if (startVolume === undefined) continue;
      total += 1;
      const delta = endVolume.minus(startVolume);
      const expected = endVolume.mul(spanMs).div(86_400_000);
      const absoluteLive = delta.gte(floorUsd);
      const relativeLive = delta.gt(0) && delta.gte(expected.mul(fraction));
      if (absoluteLive) liveAbsolute += 1;
      if (relativeLive) liveRelative += 1;
      if (absoluteLive || relativeLive) liveEither += 1;
      const label = `${venueId}:${symbol}`;
      if (!absoluteLive && relativeLive && recovered.length < 20) recovered.push(label);
      if (absoluteLive && !relativeLive && killed.length < 10) killed.push(label);
    }
  }

  console.log(`span=${(spanMs / 1000).toFixed(0)}s books=${total}`);
  console.log(`live under absolute (>=${floorUsd} USDT/span): ${liveAbsolute}`);
  console.log(`live under relative (>=${fraction.mul(100)}% of 24h rate): ${liveRelative}`);
  console.log(`live under either rule: ${liveEither}`);
  console.log(`\nnewly admitted by the relative rule (${recovered.length}):`);
  for (const row of recovered) console.log(`  ${row}`);
  console.log(`\nrejected by the relative rule but accepted by the floor (${killed.length}):`);
  for (const row of killed) console.log(`  ${row}`);
} finally {
  await Promise.all([...adapters.values()].map((adapter) => adapter.close?.().catch(() => undefined)));
}