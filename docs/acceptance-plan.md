# Acceptance Plan

This plan is the execution order for verifying the repository against the design
documents. A checklist item is only marked complete after its code path and automated
evidence are both verified. The clause-by-clause record lives in
`docs/design-acceptance-matrix.md`.

## Acceptance protocol

1. Map each design clause to implementation, test, and environment evidence.
2. Complete one work package, run its focused tests, then update the matrix and
   `docs/implementation-checklist.md`.
3. Do not infer live readiness from synthetic or replay evidence.
4. Stop before any real order submission, signing, broadcast, withdrawal, or live
   credential test; ask the user before entering that stage.

## Work packages

- [x] P0. Baseline: confirm build, typecheck, test typecheck, full tests, formatter, and
      default live locks.
- [x] P1. Execution safety: persisted kill switch, venue execution flags, manual
      confirmation audit, state machine, and restart recovery.
- [x] P2. Strategy identity: S1 asset identity, S2 path budget/key isolation, S3 BNB/WBNB
      mapping, S4 token-contract identity.
- [x] P3. Cost and risk: S1 executable depth/fees/precision, S2 sequential depth/fees,
      S3 gas/transfer/arrival/liquidity/volume, S4 two-leg gas/impact.
- [x] P4. Persistence: migrations, audit, retention, JSONL export, opportunity episodes,
      paper simulations, and recovery state.
- [x] P5. Integration: scanner S2/S3/S4 persistence, BSC mapping, dashboard
      episodes/recovery, and isolated venue failures.
- [x] P6. Automated verification: targeted tests, type tests, full suite, synthetic and
      captured-market backtests, formatter, and coverage.
- [x] P7. Runtime verification: read-only database integrity/count checks and short
      read-only scanner/dashboard smoke tests recorded in the checklist.
- [x] P8. Final accounting: recalculate S1-S4 from the detailed matrix and list
      external/live blockers.
- [!] P9. Live rollout: Stage 0-6 credentials, 24-hour soak, real quotes/liquidity/volume,
  BSC wallet simulation, and manual live batches. Requires user participation.

## Four primary goals

| Goal           |     Internal | External |       Overall | Status                                       |
| -------------- | -----------: | -------: | ------------: | -------------------------------------------- |
| S1: CEX-CEX    | 10/10 (100%) |      0/4 | 10/14 (71.4%) | `[~]` all live gates pending                 |
| S2: Triangular |   7/7 (100%) |      0/0 |    7/7 (100%) | `[x]` design/paper scope complete            |
| S3: CEX-DEX    | 11/11 (100%) |      0/4 | 11/15 (73.3%) | `[~]` real BSC data and live batches pending |
| S4: DEX-DEX    |   6/6 (100%) |      0/1 |   6/7 (85.7%) | `[~]` real provider validation pending       |
| Total          | 34/34 (100%) |      0/9 | 34/43 (79.1%) | `[~]`                                        |

Internal verification is 34/34 (100%). Including external acceptance items, completion
is 34/43 (79.1%). No strategy is accepted for live trading yet.

## Current blocker policy

Real credentials and key permissions, real aggregator quotes, BSC liquidity/volume feeds,
BSC wallet simulation, a 24-hour soak, long-running dashboard smoke, and all Stage 0-6
rollout criteria require user participation or external market data. They remain `[!]`
until independently verified.
