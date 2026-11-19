/**
 * Find which pairs are worth trading right now.
 *
 * WARD is the only pair with a long enough window in our recorded history, but
 * it spends most hours with no spread at all. When that happens the system sits
 * idle. This tool answers the obvious follow-up: of the assets that can
 * actually move between Gate and Bitget, which ones currently show a spread,
 * how long does it last, and is there enough depth to take it?
 *
 * It is read-only and safe to run while the executor is live.
 *
 *   npx tsx scripts/discover-candidates.ts [--min-net-bps 30] [--samples 20]
 */
import { Decimal } from '@arb/core';
import { createCexAdapter, createPublicRuntime } from '@arb/venues-cex';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const minNetBps = Number(arg('--min-net-bps', '30'));
const samples = Math.max(1, Number(arg('--samples', '20')));
const intervalMs = Math.max(1000, Number(arg('--interval-ms', '5000')));
const minVolumeUsd = Number(arg('--min-volume-usd', '200'));
const maxVolumeUsd = Number(arg('--max-volume-usd', '5000000'));
const maxBases = Number(arg('--max-bases', '40'));
const proxyUrl = process.env.ARB_PROXY_URL ?? 'socks5://127.0.0.1:10808';
// Withdrawal is disabled by default: a two-venue rotation recycles inventory
// between the venues instead of moving coins, so requiring a transfer route
// excludes exactly the low-liquidity assets that show spreads.
const requireTransfer = process.argv.includes('--require-transfer');
const venues = arg('--venues', 'gateio,bitget')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

// Effective taker fees after confirmed rebates (see config/live-rotation.toml).
// Override with --fees gateio=2.97,bitget=2,weex=10.
const FEES: Record<string, number> = { gateio: 2.97, bitget: 2.0, weex: 10, hotcoin: 10 };
for (const spec of arg('--fees', '').split(',')) {
  const [venueId, bps] = spec.split('=');
  if (venueId && bps !== undefined && Number.isFinite(Number(bps))) {
    FEES[venueId.trim().toLowerCase()] = Number(bps);
  }
}
const feeOf = (venueId: string): number => FEES[venueId] ?? 10;

const runtime = createPublicRuntime(8);
const adapters = new Map(
  venues.map((venueId) => [venueId, createCexAdapter(venueId, runtime, { proxyUrl })]),
);

interface MarketRow {
  symbol: string;
  base: string;
  volume: number;
}

/** Can this asset be withdrawn on one venue and deposited on the other? */
type NetworkRow = { network: string; withdraw: boolean; deposit: boolean };

function transferable(
  currencyMaps: Map<string, Map<string, unknown>>,
  base: string,
  fromVenue: string,
  toVenue: string,
): boolean {
  const left = currencyMaps.get(fromVenue)?.get(base) as NetworkRow[] | undefined;
  const right = currencyMaps.get(toVenue)?.get(base) as NetworkRow[] | undefined;
  if (!left || !right) return false;
  const ALIAS: Record<string, string> = {
    BASE: 'base',
    BASEEVM: 'base',
    ERC20: 'ethereum',
    ETH: 'ethereum',
    BSC: 'bsc',
    BEP20: 'bsc',
  };
  const norm = (c: string) => ALIAS[c.toUpperCase()] ?? c.toLowerCase();
  for (const l of left) {
    for (const r of right) {
      if (norm(l.network) !== norm(r.network)) continue;
      if (l.withdraw && r.deposit && r.withdraw && l.deposit) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  const markets = new Map<string, Map<string, MarketRow>>();
  const currencies = new Map<string, Map<string, unknown>>();

  await Promise.all(
    venues.map(async (venueId) => {
      const adapter = adapters.get(venueId)!;
      const [loaded, tickers, currencyRows] = await Promise.all([
        adapter.loadMarkets(),
        adapter.fetchTickers ? adapter.fetchTickers() : Promise.resolve([]),
        adapter.fetchCurrencies ? adapter.fetchCurrencies() : Promise.resolve([]),
      ]);
      const tickerBySymbol = new Map(tickers.map((t) => [t.exchangeSymbol, t]));
      const rows = new Map<string, MarketRow>();
      for (const market of loaded) {
        if (!market.active || market.quote.trim().toUpperCase() !== 'USDT') continue;
        const ticker = tickerBySymbol.get(market.exchangeSymbol);
        const volume = Number(ticker?.quoteVolume ?? 0);
        if (!Number.isFinite(volume)) continue;
        if (volume < minVolumeUsd || volume > maxVolumeUsd) continue;
        const base = market.base.trim().toUpperCase();
        const existing = rows.get(base);
        if (!existing || volume > existing.volume) {
          rows.set(base, { symbol: market.exchangeSymbol, base, volume });
        }
      }
      markets.set(venueId, rows);
      currencies.set(
        venueId,
        new Map(
          currencyRows.map((c) => [
            c.code.trim().toUpperCase(),
            c.networks.map((n) => ({
              network: n.network,
              withdraw: n.withdrawEnabled,
              deposit: n.depositEnabled,
            })),
          ]),
        ),
      );
    }),
  );

  // Every base that at least two venues list, with the venues that list it.
  const listings = new Map<string, string[]>();
  for (const venueId of venues) {
    for (const base of markets.get(venueId)?.keys() ?? []) {
      const rows = listings.get(base) ?? [];
      rows.push(venueId);
      listings.set(base, rows);
    }
  }
  const shared = [...listings.entries()].filter(([, listedOn]) => listedOn.length >= 2);
  const filtered = shared.filter(
    ([base, listedOn]) =>
      !requireTransfer ||
      listedOn.some((from) =>
        listedOn.some((to) => from !== to && transferable(currencies, base, from, to)),
      ),
  );
  // Prefer bases listed on the most venues, then the busiest.
  filtered.sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    const vol = (base: string) =>
      Math.max(...venues.map((v) => markets.get(v)?.get(base)?.volume ?? 0));
    return vol(b[0]) - vol(a[0]);
  });
  const tradeable = filtered.slice(0, maxBases).map(([base]) => base);
  console.log(
    `venues: ${venues.join(',')} | shared USDT bases: ${shared.length}` +
      `, candidates: ${tradeable.length}${requireTransfer ? ' (transfer required)' : ''}`,
  );

  // Track every candidate across the observation window.
  const hits = new Map<
    string,
    { base: string; bestBps: number; direction: string; seen: number; bestSizeUsd: number }
  >();

  for (let round = 1; round <= samples; round += 1) {
    for (const base of tradeable) {
      for (const buyVenue of venues) {
        for (const sellVenue of venues) {
          if (buyVenue === sellVenue) continue;
          const buyMarket = markets.get(buyVenue)?.get(base);
          const sellMarket = markets.get(sellVenue)?.get(base);
          if (!buyMarket || !sellMarket) continue;
          try {
            const [buyBook, sellBook] = await Promise.all([
              adapters.get(buyVenue)!.fetchOrderBook(buyMarket.symbol, 10),
              adapters.get(sellVenue)!.fetchOrderBook(sellMarket.symbol, 10),
            ]);
            const bestAsk = buyBook.asks[0]?.price;
            const bestBid = sellBook.bids[0]?.price;
            if (!bestAsk || !bestBid) continue;
            const gross = bestBid.minus(bestAsk).div(bestAsk).mul(10_000).toNumber();
            const net = gross - feeOf(buyVenue) - feeOf(sellVenue);
            if (net < minNetBps) continue;

            // Walk both books at 5 USDT to see what is actually takeable.
            const requested = new Decimal(5);
            let spend = requested;
            let bought = new Decimal(0);
            for (const level of buyBook.asks) {
              if (spend.lte(0)) break;
              const take = Decimal.min(spend, level.price.mul(level.amount));
              bought = bought.plus(take.div(level.price));
              spend = spend.minus(take);
            }
            let remaining = bought;
            let proceeds = new Decimal(0);
            for (const level of sellBook.bids) {
              if (remaining.lte(0)) break;
              const take = Decimal.min(remaining, level.amount);
              proceeds = proceeds.plus(take.mul(level.price));
              remaining = remaining.minus(take);
            }
            if (proceeds.lte(0)) continue;
            const executable = proceeds.minus(requested);

            const key = `${base}/${buyVenue}->${sellVenue}`;
            const row = hits.get(key) ?? {
              base,
              bestBps: net,
              direction: `${buyVenue}->${sellVenue}`,
              seen: 0,
              bestSizeUsd: 0,
            };
            row.seen += 1;
            row.bestBps = Math.max(row.bestBps, net);
            row.bestSizeUsd = Math.max(row.bestSizeUsd, Math.min(5, executable.toNumber() + 5));
            hits.set(key, row);
          } catch {
            // A venue rejecting one symbol must not abort the sweep.
          }
        }
      }
    }
    if (round % 5 === 0) console.log(`  round ${round}/${samples}: ${hits.size} candidates seen`);
    if (round < samples) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const ranked = [...hits.values()].sort((a, b) => b.seen - a.seen || b.bestBps - a.bestBps);
  console.log(`\ncandidates with >= ${minNetBps} bps net, over ${samples} rounds:`);
  if (ranked.length === 0) {
    console.log(`  none. Nothing across ${venues.join('/')} clears fees right now.`);
  }
  for (const row of ranked.slice(0, 20)) {
    console.log(
      `  ${(row.base + '/USDT').padEnd(14)} ${row.direction.padEnd(20)} ` +
        `hit ${String(row.seen).padStart(2)}/${samples}  best ${row.bestBps.toFixed(0)} bps`,
    );
  }
}

try {
  await main();
} finally {
  await Promise.all([...adapters.values()].map((a) => a.close?.().catch(() => undefined)));
}
