import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/rotation.sqlite", { readOnly: true });
const symbol = process.argv[2] ?? "WARD/USDT";
const rows = db
  .prepare(
    `SELECT venue_id, fetched_at, bids_json, asks_json FROM orderbooks
     WHERE exchange_symbol = ? AND valid = 1 ORDER BY fetched_at`,
  )
  .all(symbol) as Array<Record<string, unknown>>;

const byVenue = new Map<string, Array<{ at: number; bid: number; ask: number }>>();
for (const row of rows) {
  const bids = JSON.parse(String(row.bids_json));
  const asks = JSON.parse(String(row.asks_json));
  if (!bids.length || !asks.length) continue;
  const venue = String(row.venue_id);
  const list = byVenue.get(venue) ?? [];
  list.push({ at: Number(row.fetched_at), bid: Number(bids[0][0]), ask: Number(asks[0][0]) });
  byVenue.set(venue, list);
}

console.log(`${symbol} venues: ${[...byVenue.keys()].join(",")}`);
for (const [venue, list] of byVenue) {
  const span = (list[list.length - 1]!.at - list[0]!.at) / 3600_000;
  console.log(`  ${venue.padEnd(7)} samples=${String(list.length).padStart(4)} span=${span.toFixed(1)}h`);
}

const venues = [...byVenue.keys()];
const bands = [50, 100, 200, 300, 500, 800, 1000, 2000];
const hits = new Map<number, number>();
let joined = 0;
let positives = 0;
const windows: Array<{ dir: string; bps: number; start: number; end: number }> = [];

for (let i = 0; i < venues.length; i += 1) {
  for (let j = i + 1; j < venues.length; j += 1) {
    const a = venues[i]!;
    const b = venues[j]!;
    const rowsA = byVenue.get(a)!;
    const rowsB = byVenue.get(b)!;
    let p = 0;
    let q = 0;
    const open = new Map<string, { start: number; end: number; best: number }>();
    while (p < rowsA.length && q < rowsB.length) {
      const gap = Math.abs(rowsA[p]!.at - rowsB[q]!.at);
      if (gap > 5000) {
        if (rowsA[p]!.at < rowsB[q]!.at) p += 1;
        else q += 1;
        continue;
      }
      const at = Math.max(rowsA[p]!.at, rowsB[q]!.at);
      joined += 1;
      for (const [buyV, sellV, buyRow, sellRow] of [
        [a, b, rowsA[p]!, rowsB[q]!],
        [b, a, rowsB[q]!, rowsA[p]!],
      ] as const) {
        const bps = ((sellRow.bid - buyRow.ask) / buyRow.ask) * 10_000;
        if (bps <= 0) continue;
        positives += 1;
        for (const band of bands) if (bps >= band) hits.set(band, (hits.get(band) ?? 0) + 1);
        const key = `${buyV}->${sellV}`;
        const cur = open.get(key);
        if (cur && at - cur.end <= 10_000) {
          cur.end = at;
          cur.best = Math.max(cur.best, bps);
        } else {
          if (cur) windows.push({ dir: key, bps: cur.best, start: cur.start, end: cur.end });
          open.set(key, { start: at, end: at, best: bps });
        }
      }
      p += 1;
      q += 1;
    }
    for (const [dir, cur] of open) windows.push({ dir, bps: cur.best, start: cur.start, end: cur.end });
  }
}

console.log(`\nstrict joins (<=5s): ${joined}, positive-spread samples: ${positives}`);
console.log("positive samples above threshold:");
for (const band of bands) console.log(`  >=${String(band).padStart(4)} bps: ${hits.get(band) ?? 0}`);

const strong = windows.filter((w) => w.bps >= 500).sort((x, y) => y.bps - x.bps);
console.log(`\nwindows >=500 bps: ${strong.length}`);
for (const w of strong.slice(0, 15)) {
  const seconds = (w.end - w.start) / 1000;
  console.log(
    `  ${new Date(w.start).toISOString()} ${w.dir.padEnd(20)} ${w.bps.toFixed(0).padStart(6)} bps  lasted ${seconds.toFixed(1)}s`,
  );
}