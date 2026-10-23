# Design Acceptance Matrix

Last verified: 2026-10-21 (Asia/Hong_Kong).

This file is the audit trail for the design documents. A row is `[x]` only when the
implementation and an automated check were both inspected. `[~]` means the code path
exists but a design clause is only partially satisfied. `[!]` means verification needs
real credentials, real market data, an operator, or an external service. A green row
does not mean the system is live-ready.

## Acceptance plan and checkpoints

- [x] P0. Re-read `system-architecture.md`, `strategy-cost-model.md`,
      `exchange-adapter-design.md`, `execution-risk-design.md`, `bsc-token-mapping-design.md`,
      `data-model.md`, and `live-rollout-plan.md`; map clauses to code and tests.
- [x] P1. Lock the safety baseline: decimal arithmetic, UTC timestamps, kill switch,
      manual confirmation, and no BSC signing/broadcast path.
- [x] P2. Verify S1 opportunity evaluation, preflight, state transitions, partial/unknown
      handling, persistence, and restart recovery.
- [x] P3. Verify S2 path construction, sequential depth, fee semantics, precision,
      opportunity duration, and persistence.
- [x] P4. Verify S3 contract mapping, both directions, quote identity, gas, transfer
      rules, liquidity/volume fail-closed behavior, and paper persistence.
- [x] P5. Verify S4 independent quotes, two simulated legs, gas/impact costs, and absence
      of transaction signing.
- [x] P6. Verify adapter contracts, order-book validation, rate limiting, health scoring,
      and the deliberately read-only Hotcoin adapter.
- [x] P7. Verify schema, decimal storage, retention, migration backup, JSONL export, and
      audit links.
- [x] P8. Run typecheck, test typecheck, full test suite, formatter, synthetic backtest,
      coverage, and read-only database queries.
- [!] P9. Execute Stage 0-6 live rollout work. This requires user-supplied credentials,
  real quotes/liquidity/volume data, BSC wallet simulation, and manual live approval. It
  was intentionally not attempted.

## Cross-cutting design clauses

| ID  | Design clause                                                                   | Evidence                                                                 | Status |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| X1  | Four strategies S1-S4 exist.                                                    | `packages/core/src/s1.ts` through `s4.ts`; strategy tests                | [x]    |
| X2  | Every opportunity carries gross spread, depth net, conservative net, costs.     | `OpportunityResult`, `money.ts`, strategy evaluators                     | [x]    |
| X3  | Scanning and execution are separated.                                           | scanner service has no live order path; executor coordinator is separate | [x]    |
| X4  | Each venue is rate-limited and health-scored independently.                     | per-venue runtime, token bucket, health tracker; rate/health tests       | [x]    |
| X5  | Execution state survives process restarts.                                      | `bootstrap.ts`, repository recovery methods, startup recovery tests      | [x]    |
| X6  | Unknown order outcomes enter safe mode and are never blindly retried.           | coordinator unknown-submission tests and state machine                   | [x]    |
| X7  | BSC identity is resolved by contract address, never ticker alone.               | `TokenMappingService`, token registry, mapping tests                     | [x]    |
| X8  | The dashboard reads persisted data and never calls a venue on refresh.          | dashboard server/repository; dashboard API tests                         | [x]    |
| X9  | Kill switch, one active batch, and manual confirmation are default constraints. | `ExecutionGate`, coordinator preflight, dashboard kill-switch endpoint   | [x]    |
| X10 | No cross-chain, automatic withdrawal, MEV, BSC private-key, or signing path.    | source search; no signing/broadcast implementation                       | [x]    |
| X11 | Executions are reconstructable from audit data.                                 | execution audit-chain test; JSONL export test                            | [x]    |
| X12 | Credentials use an encrypted local secret store.                                | `secret-store.ts` (scrypt + AES-256-GCM); fingerprint-only summary test  | [x]    |

## S1: CEX-CEX spot arbitrage

| ID    | Requirement                                                                    | Evidence                                                              | Status |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------ |
| S1-1  | Evaluate both directions using executable depth, fees, safety, and health.     | `evaluateS1Direction`; S1 tests; scanner S1 tests                     | [x]    |
| S1-2  | Enforce amount/price precision, minimum amount/notional, and pair identity.    | `precision.ts`; S1 off-grid/minimum/identity tests                    | [x]    |
| S1-3  | Use IOC/FOK and worst executable ask/bid as limit prices.                      | coordinator order construction; paper/coordinator tests               | [x]    |
| S1-4  | Preflight refreshes books/balances, recalculates profit, and checks all gates. | coordinator preflight; persisted preflight tests                      | [x]    |
| S1-5  | Reconcile leg 1 and size leg 2 from actual filled base amount.                 | coordinator reconciliation; partial-fill tests                        | [x]    |
| S1-6  | Zero leg-1 fill closes without submitting leg 2.                               | coordinator partial/cancel branch and state machine                   | [x]    |
| S1-7  | Unknown/partial leg outcomes stop safely and record unhedged inventory.        | coordinator failure tests; precision-residual regression test         | [x]    |
| S1-8  | Persist orders, queries, fills, fees, risk events, and restart recovery.       | repository audit tests; bootstrap recovery tests                      | [x]    |
| S1-9  | Complete 20 consecutive synthetic paper batches and failure paths.             | `npm run backtest`: 20/20; five failure scenarios entered `SAFE_STOP` | [x]    |
| S1-10 | Provide the production executor entry and scanner-to-executor handoff.         | `main.ts`, `handoff.ts`, `config.ts`; handoff/config tests; CLI smoke | [x]    |
| S1-E1 | Real API keys with no withdrawal permission and encrypted storage.             | requires user credentials and secret-store setup                      | [!]    |
| S1-E2 | 24-hour read-only soak with all configured venues healthy.                     | requires time and live public endpoints                               | [!]    |
| S1-E3 | 10 manually confirmed live batches with 80% full reconciliation.               | requires real capital, operator, and opportunities                    | [!]    |
| S1-E4 | Stage 3-4 automation limits and daily profit criteria.                         | requires live execution history                                       | [!]    |

## S2: Intra-CEX triangular arbitrage

| ID   | Requirement                                                               | Evidence                                                 | Status |
| ---- | ------------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| S2-1 | Enumerate directed USDT paths of two or three trades.                     | `enumerateTriangularPaths`; path tests                   | [x]    |
| S2-2 | Enforce USDT start/end and at most two intermediate currencies.           | path enumeration and path-budget tests                   | [x]    |
| S2-3 | Apply sequential order-book depth and exchange fees, including zero fees. | `simulateChain`; zero-fee and fee-semantics tests        | [x]    |
| S2-4 | Apply amount precision and minimum amount/notional on every edge.         | S2 minimum/precision tests                               | [x]    |
| S2-5 | Provide no S2 execution path.                                             | scanner only records/simulates; executor accepts only S1 | [x]    |
| S2-6 | Record opportunity duration and simulated fill quality.                   | episode duration and `persistSimulatedOpportunity` tests | [x]    |
| S2-7 | Keep path evaluation within the configured path budget per scan.          | scanner path-budget test                                 | [x]    |

S2 is complete for the designed read-only/paper scope. It has no live external gate by
design.

## S3: BSC CEX-DEX arbitrage

| ID    | Requirement                                                                  | Evidence                                                             | Status |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| S3-1  | Require a verified, active BSC contract mapping.                             | mapping service, registry, token verification tests                  | [x]    |
| S3-2  | Evaluate CEX-buy/DEX-sell and DEX-buy/CEX-sell independently.                | S3 tests and BSC scanner tests                                       | [x]    |
| S3-3  | Create a mapping per CEX venue that lists the whitelist token.               | `bsc-mappings.ts`; multi-venue mapping test                          | [x]    |
| S3-4  | Check quote token addresses, direction, amount, and BNB/WBNB identity.       | S3 quote-mismatch and BNB contract tests                             | [x]    |
| S3-5  | Reject stale quotes, excessive slippage, and unknown/excessive price impact. | `quoteReasons`; S3 tests                                             | [x]    |
| S3-6  | Apply the 1.25 gas multiplier and maximum gas cost.                          | S3 gas tests                                                         | [x]    |
| S3-7  | Enforce CEX fee, precision, amount/notional, and tick alignment.             | S3 price-step and minimum tests                                      | [x]    |
| S3-8  | Enforce transfer direction, fee, minimums, availability, and arrival expiry. | S3 transfer/arrival tests                                            | [x]    |
| S3-9  | Fail closed on unavailable or insufficient liquidity/24h volume.             | missing-data tests; defaults are 50,000 USD                          | [x]    |
| S3-10 | Persist valid S3 paper simulations and fill quality.                         | scanner persistence test and `persistSimulatedOpportunity`           | [x]    |
| S3-11 | Wire transfer-mode scanner configuration end to end.                         | `bsc-mappings.ts` + `bsc-scanner.ts` transfer metadata/arrival tests | [x]    |
| S3-E1 | Validate real 0x/1inch quotes against the live BSC aggregator APIs.          | mocked normalization only; no real provider evidence                 | [!]    |
| S3-E2 | Connect a verified BSC liquidity and 24h-volume source.                      | standard whitelist deliberately has no liquidity/volume values       | [!]    |
| S3-E3 | Read BSC wallet balances and simulate swaps before manual confirmation.      | no signing/broadcast; no wallet simulation path                      | [!]    |
| S3-E4 | Run Stage 5 manual CEX-DEX batches.                                          | requires operator, capital, gas, and manual confirmation             | [!]    |

## S4: BSC DEX-DEX arbitrage

| ID    | Requirement                                                        | Evidence                                     | Status |
| ----- | ------------------------------------------------------------------ | -------------------------------------------- | ------ |
| S4-1  | Compare two independent providers.                                 | `providerId` independence check and S4 tests | [x]    |
| S4-2  | Verify both contract directions and the round-trip token identity. | S4 quote-identity and wrong-contract tests   | [x]    |
| S4-3  | Deduct both gas legs with the safety multiplier and maximum.       | S4 gas tests                                 | [x]    |
| S4-4  | Reject stale quotes, excessive slippage, and unknown price impact. | S4 quote/impact tests                        | [x]    |
| S4-5  | Simulate two separate swap legs and persist fill quality.          | S4 `fillQuality`; persistence path           | [x]    |
| S4-6  | Reject inconsistent buy quote amount and round-trip quote amount.  | new quote-mismatch regression test           | [x]    |
| S4-E1 | Validate real independent provider quotes and pool behavior.       | provider tests use mocked HTTP responses     | [!]    |

## Adapter, storage, and rollout clauses

| ID  | Design clause                                                                  | Evidence                                                         | Status |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------ |
| A1  | One CEX adapter interface and standard market/order/currency types.            | `packages/venues/cex/src/types.ts`; adapter tests                | [x]    |
| A2  | Exchange tiers and CCXT/custom adapters are represented.                       | `CEX_TIERS`, CCXT adapter, Hotcoin adapter                       | [x]    |
| A3  | Validate order books before use: shape, sorting, crossing, staleness, symbol.  | `orderbook.ts`; market-data tests                                | [x]    |
| A4  | Apply independent rate limits, Retry-After, and venue backoff.                 | token bucket/backoff tests; scanner persistence                  | [x]    |
| A5  | Score venue health over the configured window.                                 | `health.ts`; venue health tests; dashboard health API            | [x]    |
| A6  | Hotcoin is read-only until a verified depth/private feed exists.               | Hotcoin adapter and tests                                        | [x]    |
| A7  | Store credentials encrypted locally and expose only fingerprints.              | `secret-store.ts`; tamper/wrong-key/dual-role tests              | [x]    |
| A8  | Check all live capability requirements before enabling execution.              | coordinator preflight and startup recovery tests                 | [~]    |
| D1  | SQLite schema covers all designed entities, including execution/order/audit.   | `schema.ts` and repository tests                                 | [x]    |
| D2  | Monetary values are decimal strings and timestamps are UTC epoch milliseconds. | repository serialization and database tests                      | [x]    |
| D3  | Back up before pending migrations and fail closed on WAL checkpoint failure.   | database migration and backup tests                              | [x]    |
| D4  | Apply the designed retention periods while preserving execution audit data.    | retention tests                                                  | [x]    |
| D5  | Export executions to JSONL.                                                    | JSONL export test                                                | [x]    |
| D6  | Keep API keys out of SQLite.                                                   | schema/search; no key columns                                    | [x]    |
| R1  | Dashboard exposes health, opportunities, episodes, inventory, risk, audit.     | dashboard API tests                                              | [x]    |
| R2  | Dashboard tracks fill rate, unknown-order rate, rebalance cost, and gas.       | `rolloutMetrics()`, `/api/metrics`, 12 dashboard tiles + id test | [x]    |
| R3  | Stop conditions include unknown order, balance mismatch, and stale data.       | coordinator/gate tests; some live conditions remain unobserved   | [~]    |
| R4  | Stage 0 credentials, 24h soak, and live rollout stages are executed.           | requires user participation                                      | [!]    |

## Current four-goal accounting

Internal items below require code plus automated evidence. External items require real
credentials, live quotes, time, capital, or operator action. The percentages are not a
claim of live readiness.

| Goal          | Internal evidence | External evidence | Overall accounting                                   |
| ------------- | ----------------- | ----------------- | ---------------------------------------------------- |
| S1 CEX-CEX    | 10/10 (100%)      | 0/4               | 10/14 (71.4%); all live gates remain                 |
| S2 Triangular | 7/7 (100%)        | 0/0               | 7/7 (100%); paper/read-only scope only               |
| S3 CEX-DEX    | 11/11 (100%)      | 0/4               | 11/15 (73.3%); real BSC data and live batches remain |
| S4 DEX-DEX    | 6/6 (100%)        | 0/1               | 6/7 (85.7%); real provider validation remains        |
| Total         | 34/34 (100%)      | 0/9               | 34/43 (79.1%)                                        |

The important distinction is: all 34 internal design items now have code plus automated
evidence. None of the 9 external/live items has been executed, so no strategy is accepted
against the live rollout plan yet.

## Remaining blockers and next checkpoints

- S3 needs a real 0x/1inch quote check, verified liquidity/volume feeds, and BSC wallet
  simulation. Standard tokens intentionally fail closed until those feeds exist.
- S4 needs real independent-provider quotes and pool/route validation.
- No live order, signature, transaction broadcast, withdrawal, or real credential test
  has been performed, and none should be performed without the user's explicit approval.
