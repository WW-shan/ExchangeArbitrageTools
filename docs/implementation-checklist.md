# Implementation Acceptance Checklist

Status legend: `[x]` verified, `[~]` partially verified or awaiting implementation,
`[ ]` not implemented, `[!]` requires external/live evidence.

Last verified: 2026-10-27 (Asia/Hong_Kong). The clause-by-clause audit is in
`docs/design-acceptance-matrix.md`; this checklist is the working summary.

## Verification Baseline

- [x] `npm run lint` passed: typecheck, test typecheck, and Prettier check.
- [x] Full suite passed with a single worker: 47 test files / 257 tests.
- [x] `npm run coverage` passed with 80.98% statements, 71.68% branches, 77.90% functions,
      and 84.76% lines.
- [x] `npm run backtest` passed with 20/20 actionable samples and 20/20 consecutive paper
      batches.
- [x] Focused regression set after the S3/S4 and zero-fee fixes passed: 46 tests across
      strategy, adapter, and executor files.
- [x] Synthetic calibration passed: 20/20 actionable samples, 20/20 consecutive paper
      batches, duplicate retry rejected, five failure paths entered `SAFE_STOP`, kill-switch
      preflight blocked, restart recovery blocked.
- [x] Captured-market analysis was generated from `fixtures/backtest/captured-CAKE-USDT.json`:
      20 samples, 0 actionable, 11 stale/invalid books, 9 below profit threshold. This is
      fail-closed evidence, not proof of live profitability.
- [x] Real SQLite is at schema versions 1-5; `PRAGMA integrity_check` returned `ok`.
      Read-only counts: 225 opportunities, 0 episodes, 0 paper trades, 0 executions, 0 orders,
      13 risk events. The database retains `kill_switch=true` and `live_enabled=false`.
- [x] Short real scanner smoke previously completed three cycles. Gate.io discovery
      returned 2,181 markets; MEXC and WEEX discovery timed out but were isolated. S1 remained
      unavailable with only one healthy venue; 14 S2 paths were evaluated and all failed
      closed; no orders were created.
- [x] Real Dashboard process previously served `/health`, `/api/summary`,
      `/api/opportunities`, `/api/episodes`, `/api/venues`, `/api/inventory`,
      `/api/risk-events`, `/api/audit`, and `/` with HTTP 200.
- [x] `npm run verify:tokens` matched all five BSC whitelist contracts and decimals using a
      read-only RPC call.

## Phase 0: Baseline and Safety

- [x] TypeScript build and test typecheck pass.
- [x] Existing automated suite passes.
- [x] Live execution remains locked by default (`live_enabled = false`, kill switch on).
- [x] Decimal arithmetic and UTC epoch-millisecond timestamps are used.
- [x] No BSC signing, transaction broadcast, or withdrawal path exists.

## Phase 1: Storage, Audit, and Venue Backoff

- [x] SQLite schema covers the designed entities.
- [x] Migration v5 adds simulation audit and execution recovery fields.
- [x] Migration and repository methods have direct regression tests.
- [x] Pending migrations create a pre-upgrade database backup; WAL checkpoint failure
      aborts the upgrade.
- [x] Venue backoff is classified for 403/418/429/network failures, persisted, and
      restored on startup.
- [x] Re-registering a venue preserves an operator-set `execution_enabled` flag unless the
      caller explicitly changes it; scanner startup no longer clears the live gate.
- [x] Execution audit can reconstruct opportunity, preflight, order books, requests,
      responses, queries, fills, fees, risk events, and operator confirmation.
- [x] Retention runs at startup and every 24 hours; execution/order/risk audit rows are
      never pruned. Execution-referenced and paper-referenced opportunities are retained.
- [x] Executions are exported to JSONL.
- [x] Encrypted local secret storage (scrypt + AES-256-GCM) and fingerprint-only logging are
      implemented and tested for tampering, wrong keys, dual roles, and duplicates.

## Phase 2: S1 CEX-CEX

- [x] Both directions are evaluated with executable depth, precision, minimums, fees,
      safety buffer, and health.
- [x] Orders use IOC/FOK limit prices at worst executable prices.
- [x] Unknown, partial, canceled, rejected, and zero-fill paths stop safely.
- [x] Second-leg quantity uses actual first-leg fill and rounds down without exceeding it.
- [x] Precision-rounding residue is persisted as unhedged inventory.
- [x] Paper failure scenarios and duplicate-submission checks exist.
- [x] Every paper trade records duration, worst prices, expected failure reasons, and
      simulated fill quality.
- [x] Startup recovery reconciles submitted and unresolved legs, persists every query
      result or error, confirms balances, restores backoff, and blocks execution.
- [x] Execution persistence includes opportunity ID, preflight, gross spread, fees,
      latency, inventory delta, state history, risk events, and manual confirmation audit.
- [x] 20 consecutive successful paper batches are verified by an automated synthetic
      backtest.
- [x] `apps/executor/src/main.ts` loads the latest persisted S1 opportunity, validates
      freshness/duplicates, loads encrypted credentials, runs startup recovery, and only
      executes with live config, released kill switch, `--execute`, and an exact
      `--confirm-batch`. Default CLI smoke exits `no_s1_opportunity` without submitting.
- [x] `npm run executor:venue -- --enable|--disable <venue>` updates the persisted
      `execution_enabled` gate and writes an operator audit row; `--status` lists venues.
- [!] 24-hour read-only soak and 10 manually confirmed live batches require real
  credentials, an operator, and actual market opportunities.

## Phase 3: S2 Triangular

- [x] USDT-starting/ending paths with at most three trades and two intermediates are
      enumerated.
- [x] Each edge uses order-book depth and exchange fees, including explicitly zero fees.
- [x] `grossSpread`, `depthNetProfit`, and `totalCost` have distinct fee-consistent
      semantics.
- [x] CEX minimum amount/notional and amount precision are enforced on every edge.
- [x] Opportunity duration and simulated fill quality are persisted.
- [x] No execution path exists for S2.
- [x] The configured path budget is enforced across venues.

## Phase 4: S3 CEX-DEX and BSC Safety

- [x] Tokens are identified by verified BSC contract address, never ticker alone.
- [x] Both CEX-buy/DEX-sell and DEX-buy/CEX-sell are evaluated.
- [x] Each enabled venue that lists a whitelist token receives an independent mapping
      with risk metadata.
- [x] Quote token identity, direction, amount, and BNB-to-WBNB contract identity are
      checked.
- [x] Unknown price impact fails closed.
- [x] Opportunity gas uses a 1.25x safety multiplier and a configured maximum.
- [x] CEX precision, minimum amount/notional, tick alignment, withdrawal fee, minimum
      withdrawal/deposit, transfer risk, deposit risk, availability, arrival estimate, and
      transfer-expiry window are enforced by direction.
- [x] Unknown or insufficient pool liquidity and 24-hour volume fail closed
      (`>= 50,000 USD` defaults).
- [x] Valid S3 opportunities persist a paper simulation, including gas and simulated fill
      quality.
- [x] Scanner mapping reads CEX withdrawal/deposit state, fee, minimums, and estimated
      arrival, and passes transfer metadata plus `maxTransferArrivalMs` in both S3 directions.
- [!] Real 0x/1inch quotes, a verified liquidity/24-hour-volume source, BSC wallet balance
  reads, and swap simulation are unavailable. The standard whitelist intentionally fails
  closed with `liquidity_data_unavailable` and `volume_data_unavailable` until those
  sources are connected.
- [!] Execution-time gas revalidation and BSC signing/broadcast remain intentionally
  absent.

## Phase 5: S4 DEX-DEX

- [x] Two independent directional quotes are compared.
- [x] Buy and sell providers must be independent.
- [x] Unknown price impact fails closed.
- [x] Both swap legs are simulated against fresh quotes and recorded separately.
- [x] Opportunity duration and simulated fill quality are persisted.
- [x] Inconsistent buy amount and round-trip quote amount fail closed.
- [x] No signing or transaction broadcast code exists.
- [!] Real 0x/1inch quotes and wallet simulation require provider access and external
  verification.

## Phase 6: Scanner, Dashboard, and Operations

- [x] Scanner persists opportunities, episodes, health, currencies, mappings, quotes, and
      snapshots.
- [x] Scanner integration tests assert real writes to health, currencies, paper trades,
      and risk events.
- [x] S2/S3/S4 persistence is wired end to end.
- [x] BSC mapping covers multiple venues and carries risk metadata.
- [x] Dashboard smoke tests cover opportunities, health, inventory, risk, audit, kill
      switch, summary recovery, and episodes.
- [x] Historical cleanup is scheduled without deleting permanent audit data.
- [x] Market discovery failure for one venue is isolated, persisted as a critical risk
      event, and does not stop healthy venues.
- [x] Dashboard exposes the full rollout metric set: fill rate, first-leg partial rate,
      second-leg failure rate, unknown-order/query-error rates, paper/live profit, gas,
      rebalance, inventory drift, max transfer tax, risk events, and operator actions.
- [x] The dashboard only reads SQLite; page refresh does not call a venue.

## Phase 7: Final Verification

- [x] All unit, integration, type, formatting, and synthetic backtest checks pass.
- [x] Synthetic calibration proves 20/20 paper batches and all five failure paths.
- [x] Captured-market report is generated and its limitations are recorded above.
- [x] S1-S4 completion is recalculated from the detailed matrix, not copied from the old
      checklist.
- [!] Stage 0 credentials, 24-hour soak, real quote validation, long-running Dashboard
  smoke, and all live rollout stages require user participation or external data.

## S1-S4 Completion

Internal items require code plus automated evidence. External items require credentials,
real market data, time, capital, or operator action. These percentages are not a live-
readiness claim.

| Goal           |     Internal | External |       Overall | Status                                       |
| -------------- | -----------: | -------: | ------------: | -------------------------------------------- |
| S1: CEX-CEX    | 10/10 (100%) |      0/4 | 10/14 (71.4%) | `[~]` all live gates pending                 |
| S2: Triangular |   7/7 (100%) |      0/0 |    7/7 (100%) | `[x]` design/paper scope complete            |
| S3: CEX-DEX    | 11/11 (100%) |      0/4 | 11/15 (73.3%) | `[~]` real BSC data and live batches pending |
| S4: DEX-DEX    |   6/6 (100%) |      0/1 |   6/7 (85.7%) | `[~]` real provider validation pending       |
| Total          | 34/34 (100%) |      0/9 | 34/43 (79.1%) | `[~]`                                        |

S2 is complete only for its designed read-only/paper scope. No live order, signature,
broadcast, withdrawal, or real credential test was performed.

## Discovery Optimization (post-MVP)

- [x] P0-1 market universe expansion: volume-ranked top-N assets per quote per venue,
      USDT/USDC support, tiered scanning (hot/top100/top500), bounded-concurrency book
      prefetch, and persisted `market_universe`. Evidence:
      `docs/discovery-p0-1-universe.md`.
- [x] P0-2 two-stage candidate ranking: top-of-book estimate sorts candidates, exact
      simulation runs only for the top `max_candidates_per_cycle`, and `s2Candidates` /
      `s2Evaluated` expose the conversion rate. Evidence:
      `docs/discovery-p0-2-ranking.md`.
- [x] P0-3 intra-venue multi-hop search: 2-5 legs, any intermediate currency, top-K branch
      pruning, ranking and top-N exact simulation, with a hard five-hop cap. Evidence:
      `docs/discovery-p0-3-multihop.md`.
- [x] P0-4a automatic balance refresh: read-only encrypted credentials,
      `npm run executor:balances -- [--loop]`, persisted balances/inventory snapshots,
      latest-value and age-limited queries, and per-venue failure isolation. Evidence:
      `docs/discovery-p0-4a-balance-refresh.md`.
- [x] P0-4b cross-venue multi-hop in inventory mode: `(venue, currency)` graph,
      balance-backed inventory edges, 2-5 legs with a bounded venue-switch count,
      top-of-book ranking plus top-N exact simulation, `insufficient_inventory`
      rejection, `variant=cross_venue_inventory`, and scanner counters. Evidence:
      `docs/discovery-p0-4b-crossvenue.md`.
- [x] P1-1 optimal notional sizing: deterministic bounded search over the real
      simulator, S1/S2/cross-venue wrappers, inventory-capped sizing, and an
      estimate-gated per-cycle optimisation budget. Evidence:
      `docs/discovery-p1-1-optimal-notional.md`.
- [x] P1-2 opportunity lifetime and historical replay: true episode duration,
      per-strategy lifetime and decay summaries, a replay adapter over the real
      scanner pipeline, and `npm run replay`. Evidence:
      `docs/discovery-p1-2-lifetime-replay.md`.
- [!] P0-5 real 0x/1inch quotes, BSC liquidity/volume feeds, and wallet simulation.

## S1 Discovery Optimization (2026-10-22)

- [x] S1-O1 WebSocket event-driven market data: `BookStore` keeps one live L2 book per
      `(venue, symbol)`, `CcxtCexAdapter.watchOrderBook` uses `ccxt.pro` with `gateio -> gate`
      mapping, reconnect backoff, and graceful close. The scanner prefers fresh WS books,
      falls back to REST, evaluates hot/top100 every short cycle in WS mode, and exposes
      `feed_mode`, `ws_max_book_age_ms`, `ws_scan_interval_ms`, `ws_reconnect_*`. Evidence:
      `docs/s1-optimization-research.md`; `packages/venues/cex/tests/book-store.test.ts`;
      `apps/scanner/tests/scanner-ws.test.ts`.
- [x] S1-O2 real fee profiles and maker/taker execution modes: `executionMode`, maker fee
      rebates, maker fill probability, and fail-closed missing-maker-fee handling. Evidence:
      `packages/core/tests/s1.test.ts`; `[fees.<venue>]` config overrides are applied at
      market load (`apps/scanner/tests/fee-overrides.test.ts`).
- [x] S1-O3 balance-aware S1 sizing: balance-capped notional, `insufficient_balance`, and
      optional `require_balances_for_s1`. Evidence:
      `apps/scanner/tests/scanner-balance-sizing.test.ts`.
- [x] S1-O4 real-opportunity filters: cross-venue price deviation, suspicious spread,
      pair skew, and venue reliability floor. Evidence: `packages/core/tests/s1.test.ts`.
- [x] S1-O5 best-now ranking and lifetime gate: `bestValidS1Opportunity` scores
      profit × fill probability × freshness, skips opportunities beyond measured episode
      lifetime, and the executor handoff selects the best fresh row. Evidence:
      `packages/storage/tests/opportunity-ranking.test.ts`,
      `apps/executor/tests/handoff.test.ts`.
- [x] S1-O6 venue connectivity probe: `npm run probe:venues` checks REST market discovery,
      one REST book, and one WebSocket book per configured venue with per-venue timeout
      isolation and writes `data/venue-probe.json`. Real run: gateio 2,181 markets,
      REST 1,737ms, book 46ms, WS 2,473ms; MEXC/WEEX timed out on this network.
- [x] S1-O7 WS feed recording and real-data analysis: `record_feed` writes normalized L2
      snapshots as JSONL via `FeedRecorder`; `npm run analyze:feed` computes raw vs net
      opportunity frames, false-positive rate, book age percentiles, best route, and
      rejection counts; `npm run replay:feed` feeds recordings through the full scanner
      pipeline (episodes, lifetime, persistence). Synthetic two-venue check produced
      rawEdge=3, net=2, falsePositiveRate=1/3, best=179.8bps, episode 500ms.
- [x] S1-O8 inventory rebalance planner: `planRebalance` computes greedy same-currency
      transfers toward per-venue targets with minimum-transfer and cost-bps handling;
      `npm run rebalance:plan` reads latest balances and writes a read-only plan with
      shortfalls. No transfer, withdrawal, or signing path exists. Evidence:
      `packages/core/tests/rebalance.test.ts`.
- [x] S1-O9 SOCKS5 proxy and real-data validation: CCXT REST and WebSocket proxy support
      (`ARB_SOCKS_PROXY`), `http/https/socks-proxy-agent` + `protobufjs` dependencies, real
      MEXC/WEEX soak, and real opportunity evidence on INJ/APT. Evidence:
      `docs/s1-real-data-findings-2026-10-22.md`.
- [x] S1-O10 mainstream CEX/DEX expansion: 42-venue catalog (34 CEX + 8 DEX), 37 spot
      venues enabled by default, per-venue market type/tier/CCXT id, depth and timestamp
      normalization, WS reconnect cap, and a connectivity matrix for 37 spot venues.
      Evidence: `docs/venue-expansion-2026-10-22.md`.
- [x] S1-O11 multi-venue discovery: shared-base WebSocket subscription pruning, tier-ordered
      allocation, per-venue REST fallback cap, per-base evaluation time, and WS-mode prefetch
      skip. 8-venue/4-major scan is 32 WS books per cycle with zero stale; a 16-mid-cap/2bps
      research run surfaced 15 valid S1 rows (up to 1.68bps). Evidence:
      `docs/s1-multivenue-findings-2026-10-22.md`.
- [x] S1-O12 live-readiness preflight: `npm run live:readiness` checks execution safety
      bounds, live/kill-switch gates, fee-override coverage, min-profit-vs-notional floor,
      DB integrity and open executions, encrypted secret-store coverage, per-venue REST/WS
      connectivity, and BSC quote keys. It never signs or places orders. The 2026-10-22 run
      blocked on missing `data/secrets.enc.json` and warned on generic fees and the 83bps
      `min_profit_usd` floor. Current status is in `docs/live-readiness-gate.md`.
- [x] S1-O13 live-test profile and runbook (historical; current Gate/Hotcoin profile is
      S1-O21): `config/live-test.toml` (gateio/mexc/weex, 10 USDT max, 5 USDT daily loss,
      manual confirmation, S1-only) plus
      `docs/live-test-runbook.md` covering fees, encrypted credentials, balances,
      readiness, scanner, read-only executor rehearsal, and manual `--execute`. Readiness
      against this profile reports 3 venues, a 5.00bps min-profit floor, and blocks only on
      the missing secret store. Evidence: `config/live-test.toml`,
      `docs/live-test-runbook.md`.
- [x] S1-O14 latest-code S1 review and adaptive entry gate: compared our S1 against
      recent GitHub projects (`djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST`,
      `flp1/bot-arb-cripto`, `HurbetAlex/crypto-arbitrage-bot`,
      `charlie-hk/crypto-arbitrage-scanners`, `q0821/cross-exchange-arbitrage-bot`,
      `bsomar16/crypto-arb-scanner`, `hummingbot/hummingbot`). Added an opt-in
      `PercentileEntryGate` (`entry_gate_mode=off|percentile`) that admits only edges at or
      above a rolling percentile of the same route's recent net-edge history, with bounded
      memory and `below_percentile_gate` rejection. Evidence:
      `docs/s1-latest-code-review-2026-10-22.md`, `apps/scanner/tests/entry-gate.test.ts`.
- [x] S1-O15 full latest-code optimization pass: per-symbol account fees
      (`fetchTradingFees` + `npm run fees:fetch` + `fee_file` + per-symbol overrides),
      fee provenance (`config|account|ccxt|default`), WS-vs-REST book sanity with
      failure-streak circuit breaker, `liquidity_multiple` depth buffer and depth metrics,
      f64 top-of-book prefilter, version-aware incremental evaluation, route-level
      duplicate suppression, and long-inventory netting/reduce-only hedge planning
      (`npm run rebalance:plan` now emits `hedgeOrders`). Config keys:
      `fee_file`, `liquidity_multiple`, `book_sanity_*`, `prefilter_*`,
      `incremental_evaluation`, `route_cooldown_ms`. Evidence:
      `docs/s1-latest-code-review-2026-10-22.md`, `apps/scanner/tests/book-sanity.test.ts`,
      `apps/scanner/tests/depth.test.ts`, `apps/scanner/tests/fee-file.test.ts`,
      `apps/scanner/tests/scanner-optimizations.test.ts`,
      `packages/core/tests/inventory-netting.test.ts`.
- [x] S1-O16 true event-driven S1 hot path: `BookStore.onBook` marks dirty
      `(venue, symbol)` keys and wakes `ScannerService.scanUpdates()`; the main loop
      alternates between a periodic full `scanOnce()` (universe/S2/S3/REST fallback)
      and event-driven hot scans that evaluate only affected `base/quote` groups.
      `hot_scan_debounce_ms` coalesces bursts; `ws_scan_interval_ms` is only the
      fallback wake-up; `hot_scan_budget_ms` defers excess groups back to the dirty set
      (`summary.deferredGroups`). Evidence: `apps/scanner/tests/scanner-hot-scan.test.ts`.
- [x] S1-O17 top-N depth wake and hot/near-miss subscription priority: a fingerprint of
      the first `hot_depth_levels` (default 3) levels suppresses deeper updates; valid or
      within-`hot_near_miss_bps`
      routes promote both legs to hot, and `syncSubscriptions()` prioritizes hot
      symbols (including hot top500). Evidence: `scanner-hot-scan.test.ts`,
      `scanner-ws.test.ts`.
- [x] S1-O18 route density/lifetime feedback: `s1RouteStats()` groups S1 opportunities
      by instrument and buy->sell route, reporting samples, valid rate, avg/max net bps,
      episode count and p50/p90 lifetime; `npm run routes:stats` prints the ranking.
      On startup `seedHotFromRoutes()` promotes both legs of recent routes with at least
      one valid sample, so WS subscriptions survive a restart. Evidence:
      `packages/storage/tests/route-stats.test.ts`, `scripts/route-stats.ts`,
      `apps/scanner/tests/scanner-hot-scan.test.ts`.
- [x] S1-O19 denomination multipliers/aliases: explicit `k*` and `1000*` aliases resolve
      to one canonical asset; scanner/paper evaluate normalized books, and the executor
      converts canonical quantity/price back to exchange units. A 2% normalized-mid guard
      prevents wrong-asset pairing. Evidence: `docs/s1-base-multiplier-design.md`,
      `packages/core/tests/market-units.test.ts`,
      `apps/scanner/tests/scanner-alias.test.ts`,
      `apps/executor/tests/coordinator-alias.test.ts`.
- [x] S1-O20 scanner-to-executor pipeline tests: a discovered S1 opportunity is persisted,
      selected by handoff, manually confirmed, and executed through the real coordinator;
      the suite verifies a CLOSED two-leg batch and a leg-2 partial fill that enters
      `SAFE_STOP`, persists the unhedged remainder, and turns the kill switch on. Evidence:
      `apps/executor/tests/s1-pipeline.test.ts`.
- [x] S1-O21 Gate.io + Hotcoin live-test integration: Hotcoin now has a custom REST/WS
      adapter with gzip depth, ping/pong keepalive, server-clock correction, signed
      balances/order/cancel, documented status mapping, FOK/IOC request construction, and
      bounded clientOrderId pagination. All callers use `createCexAdapter`; the shared fee
      override implementation is used by scanner and executor. `config/live-test.toml` uses
      Gate.io + Hotcoin with a 20 USDT cap and 15 USDT minimum sizing. Readiness now checks
      Hotcoin minimum sizing, IOC/FOK coverage, venue execution gates, and requires WS when
      `feed_mode=websocket`. Real public probe: Gate.io 2,181 markets and Hotcoin 374 markets;
      both REST/WS succeeded through the proxy. Five-cycle zero-fee smoke produced S1 rows
      in the `gateio->hotcoin` direction, proving the public pipeline; it is not evidence of
      post-fee profitability. A three-cycle 10bps/leg placeholder run produced zero valid
      S1 rows, with `gross_profit_below_threshold`, `invalid_orderbook`, and
      `stale_orderbook` rejections. Evidence: `packages/venues/cex/tests/hotcoin.test.ts`,
      `packages/venues/cex/tests/catalog.test.ts`, `scripts/live-readiness.ts`,
      `data/venue-probe-hotcoin.json`, `data/live-readiness-hotcoin.json`.

Detailed design: `docs/s1-event-driven-hot-path.md`.
Clause-by-clause S1 audit: `docs/s1-completion-audit-2026-10-22.md`.

## External Blockers

- [x] Proxy connectivity: `ARB_SOCKS_PROXY=socks5://127.0.0.1:10808` reaches Gate.io and
      Hotcoin REST and WebSocket. Gate.io 2,181 markets; Hotcoin 374 markets; both WS feeds
      produced books. Evidence: `data/venue-probe-hotcoin.json`.
- [ ] Real API keys with withdrawal permission disabled and IP-whitelist verification.
- [ ] Hotcoin private endpoints: balance, order placement, order query, cancel, status
      mapping, clientOrderId lookup, and 15 USDT minimum order.
- [ ] Gate.io and Hotcoin FOK/IOC behavior verified with real orders before enabling
      `ioc_venues` / `fok_venues`.
- [ ] Real account fee tiers for both venues; Hotcoin has no verified fee endpoint.
- [ ] 24-hour continuous read-only soak; a 4-minute soak and 3-minute INJ-focused run are
      recorded, but the full 24-hour gate is not yet complete.
- At least one real actionable S1 opportunity, 20 real-market paper batches, and 10
  manually confirmed live batches.
- Real 0x/1inch read-only quotes and provider agreement.
- Verified BSC liquidity and 24-hour volume feeds for the whitelist tokens.
- BSC wallet balance reads, swap simulation, and manual swap confirmation.
- Long-running Dashboard smoke and Stage 0-6 rollout criteria.
