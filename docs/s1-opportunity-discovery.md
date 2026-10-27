# S1 Opportunity Discovery: Gate.io + Hotcoin

Last verified: 2026-10-27 (Asia/Hong_Kong).

This document covers the read-only discovery path only. It does not enable live
execution and does not claim that a gross spread is a tradable profit.

## 1. Why this layer exists

The earlier live-test profile only scanned `CAKE`, `ETH`, and `BTC`. That was
useful for a first execution rehearsal, but it is too small to answer whether
Gate.io + Hotcoin contains actual S1 opportunities. The discovery profile
therefore expands the universe by 24-hour quote volume and exposes near misses
instead of only printing valid rows.

## 2. Implemented pieces

- Hotcoin `fetchTickers()` uses the official `GET /v1/market/ticker` endpoint.
  It normalizes `last`, `buy`, `sell`, `vol`, `amount`, and `ts` into
  `TickerSnapshot`. `amount` is treated as 24-hour quote volume.
- `config/discovery.toml` scans the top 30 USDT markets per venue with at least
  100,000 USD 24-hour quote volume. Fees are conservative 10 bps/leg
  placeholders and are labelled as screening values, not account rates.
- `scripts/smoke-s1.ts` supports `--universe top_volume`, `--max-bases`, and
  `--min-24h-volume`. It also prints `topNetRows` and `topGrossRows` so a
  rejected near miss remains visible.
- `scripts/capture-fixture.ts` now uses `createCexAdapter`, applies the shared
  fee overrides, reads notional/settings from the selected config, and closes
  every adapter. Its output is generic over venue ids.
- `scripts/backtest.ts` now accepts any two venue ids, so a captured
  Gate.io + Hotcoin fixture can be replayed through the same S1 evaluator.

## 3. Commands

```powershell
$env:ARB_CONFIG = 'config/discovery.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'

# Public REST/WS/ticker probe.
npx tsx scripts/probe-venues.ts --venues gateio,hotcoin --pair BTC/USDT --timeout-ms 30000 --out data/venue-probe-hotcoin-tickers.json

# Volume-ranked discovery. Placeholder fees are applied by the profile.
npm run smoke:discovery

# Capture 20 real books and replay them through the generic S1 backtest.
npx tsx scripts/capture-fixture.ts --config config/discovery.toml --venues gateio,hotcoin --pair CAKE/USDT --samples 20 --interval-ms 1000 --out data/captured-gateio-hotcoin-CAKE-USDT.json
npm run backtest -- data/captured-gateio-hotcoin-CAKE-USDT.json
npm run replay -- --fixture data/captured-gateio-hotcoin-CAKE-USDT.json --out data/replay-captured-gateio-hotcoin.json
```

## 4. Observed public results

### Probe

- Gate.io: 2,181 markets, REST/WS/tickers succeeded; 2,183 ticker rows.
- Hotcoin: 374 markets, REST/WS/tickers succeeded; 374 ticker rows.
- Gate.io's first WS book was slow (about 23 seconds in this run); Hotcoin's
  first WS book was about 3.7 seconds. The 30-second readiness timeout covered
  both.

### Volume-ranked smoke

Three hot cycles with 30 bases and 10 bps/leg:

- Universe: 12 base/quote groups with fresh books.
- S1 evaluations: 4-24 per cycle; 52 total rejection events.
- Best gross edge observed: 2.0000 bps.
- Best net edge observed: -22.4595 bps after 20 bps round-trip fees and the
  configured safety buffer.
- `validS1Rows`: none.

This is the important result: expanding the universe found more gross edges,
but none survived a realistic 10 bps/leg fee assumption in this short window.
The zero-fee smoke is only a plumbing test and must not be presented as profit.

### Captured replay

Twenty one-second CAKE/USDT samples:

- `capture-fixture`: Gate.io + Hotcoin, requested notional 20 USDT, discovery
  fee overrides applied.
- Generic backtest: 0 actionable samples; 16 `gross_profit_below_threshold`
  and 4 stale/invalid book samples.
- Replay: 20 frames, 0 valid opportunities, p50 feed latency 757 ms and p95
  2,238 ms. These are public-feed measurements, not execution latency.

### Low-liquidity follow-up

The top-volume profile above is useful as a plumbing check, but it is the
wrong place to look for meaty S1 edges. A later low-liquidity scan built the
Gate.io/Hotcoin intersection first, then filtered by a 1,000 to 500,000 USD
24-hour quote-volume band. It found 122 dual-venue candidates and 244 books:

- 1 clean eligible route: INC/USDT, about 86 bps gross and 63 USDT eligible
  capacity in the final snapshot.
- 1 review route: TBK/USDT, about 368 bps gross and 104 USDT eligible
  capacity. It persisted across three independent scans but carries the
  extreme_spread review flag. By 20:31 HKT the same direction had reversed to
  about -367 bps, so this was a short-lived opportunity, not a durable edge.
- 1 near miss: HTX/USDT, about 34 bps gross in the final snapshot.
- Anomalies such as EDGE/USDT and FAI/USDT were rejected as price outliers,
  despite enormous displayed gross spreads.

Full method, capacity definitions, curves, and caveats are in
docs/low-liquidity-capacity-discovery.md. These numbers use 10 bps/leg
placeholder fees and do not prove live profitability.

## 5. Readiness

With `config/discovery.toml` and the public proxy:

- `network.venues`: `2/2 REST ok, 2/2 WS ok, 2/2 tickers ok`.
- The only block remains `secrets.store`, because no API key has been supplied.
- `live_enabled=false`, `kill_switch=true`, and both execution venue gates remain
  closed.

## 6. Remaining gaps that limit real discovery

1. Hotcoin does not expose a verified account-fee endpoint. The discovery
   profile therefore uses placeholders; only the exchange account UI can provide
   the real tier.
2. Hotcoin depth updates are roughly 1-3 seconds apart. Gate.io can update much
   faster. The `max_pair_skew_ms=2500` and feed-latency gates intentionally
   reject the resulting stale pairs rather than treating them as profit.
3. The Hotcoin adapter currently opens one WebSocket per subscribed symbol.
   The discovery profile limits this to 30 bases; multiplexing many topics over
   the official `trade/multiple` socket is a future scale improvement.
4. The current S1 path is two-leg, same base/quote only. Multi-hop and
   cross-quote paths are S2 work and remain disabled in this profile.
5. No real private key, order, cancel, balance, FOK/IOC, or 24-hour soak has
   been verified. Those remain external/live gates.
6. The top-volume profile is explicitly a screening profile. It should not be
   used to conclude that S1 has no opportunities. Use config/longtail.toml and
   scan:longtail for low-liquidity discovery.

## 7. What would actually increase the chance of finding a tradable edge

- Use real VIP/maker rates and include maker rebates; at 10 bps/leg, a 2 bps
  gross edge cannot become positive.
- Scan the Gate.io/Hotcoin low-volume intersection instead of each venue's
  top-volume list. The low-volume profile found 50-368 bps gross edges where
  top30 found about 2 bps.
- Add more healthy venues or liquid pairs where the same base has deeper,
  faster books. A wider universe alone cannot overcome a 20 bps round trip.
- Record a longer read-only feed and run `analyze:feed`/`replay:feed` with
  arrival-latency and opportunity-window analysis before changing execution
  parameters.
- Keep the `topGrossRows` output as the discovery signal. A gross edge is a
  candidate for further investigation, not an executable opportunity.
