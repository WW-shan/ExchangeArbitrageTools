import { DatabaseSync } from "node:sqlite";
import { Decimal, assessTransferability } from "@arb/core";

const db = new DatabaseSync("data/rotation.sqlite", { readOnly: true });
const rows = db
  .prepare("SELECT venue_id, currency, network, withdraw_enabled, deposit_enabled FROM exchange_currencies")
  .all() as Array<Record<string, unknown>>;

const byVenue = new Map<string, Map<string, any[]>>();
for (const row of rows) {
  const venue = String(row.venue_id);
  const code = String(row.currency).trim().toUpperCase();
  const map = byVenue.get(venue) ?? new Map<string, any[]>();
  const list = map.get(code) ?? [];
  list.push({
    code,
    networks: [
      {
        network: String(row.network),
        withdrawEnabled: Boolean(row.withdraw_enabled),
        depositEnabled: Boolean(row.deposit_enabled),

      },
    ],
  });
  map.set(code, list);
  byVenue.set(venue, map);
}

const volumes = JSON.parse(
  (await import("node:fs")).readFileSync("data/tmp-volumes.json", "utf8"),
) as Record<string, Array<[string, number]>>;
const gate = new Map(volumes.gateio);
const bitget = new Map(volumes.bitget);

function currenciesFor(venue: string, symbol: string) {
  const entries = byVenue.get(venue)?.get(symbol) ?? [];
  const merged = new Map<string, any>();
  for (const entry of entries) {
    const existing = merged.get(symbol);
    const networks = existing ? existing.networks : [];
    networks.push(...entry.networks);
    merged.set(symbol, { code: symbol, networks });
  }
  return merged.size === 0 ? [] : [...merged.values()];
}

const shared = [...gate.keys()].filter((base) => bitget.has(base));
const counts: Record<string, number> = {};
let roundTrip = 0;
let inventoryEligible = 0;
let noSharedChain = 0;
let unlisted = 0;
const recovered: string[] = [];

for (const base of shared) {
  const minVolume = Math.min(gate.get(base)!, bitget.get(base)!);
  if (minVolume < 200 || minVolume > 5_000_000) continue;
  const result = assessTransferability({
    symbol: base,
    leftVenue: "gateio",
    rightVenue: "bitget",
    left: currenciesFor("gateio", base),
    right: currenciesFor("bitget", base),
  });
  counts[result.verdict] = (counts[result.verdict] ?? 0) + 1;
  if (result.verdict === "transferable") {
    roundTrip += 1;
    inventoryEligible += 1;
    continue;
  }
  if (result.verdict === "unknown") {
    unlisted += 1;
    continue;
  }
  if (result.reasons.includes("no_shared_chain")) {
    noSharedChain += 1;
    continue;
  }
  // Listed on both venues with a shared chain, only withdrawal/deposit blocked.
  inventoryEligible += 1;
  if (recovered.length < 20) recovered.push(`${base}(${result.verdict})`);
}

console.log("verdicts:", counts);
console.log("round-trip eligible:", roundTrip);
console.log("inventory-mode eligible:", inventoryEligible);
console.log("rejected: no shared chain (identity risk):", noSharedChain);
console.log("rejected: not listed on both:", unlisted);
console.log("\nunlocked by inventory mode (" + recovered.length + "+):");
console.log("  " + recovered.join(", "));
const pct = ((inventoryEligible - roundTrip) / Math.max(1, roundTrip)) * 100;
console.log(`\ngain: +${inventoryEligible - roundTrip} pairs (+${pct.toFixed(0)}% vs round-trip-only)`);