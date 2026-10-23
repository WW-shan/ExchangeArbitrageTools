# Discovery P0-2: Two-Stage Candidate Ranking

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Stop spending the exact depth-simulation budget on arbitrary path order. Rank triangular
candidates cheaply from the top of the book, then run exact simulation only for the best
`max_candidates_per_cycle` paths.

## Design

### 1. Cheap estimate

New function in `packages/core/src/s2.ts`:

```ts
estimateTriangularPathReturn(path: TriangularPath): Decimal
```

- Sell leg: `bestBid * (1 - feeBps / 10000)`.
- Buy leg: `(1 / bestAsk) * (1 - feeBps / 10000)`.
- Multiplies the rates across the path and returns the net fraction (for example `0.001`
  means 0.1%).
- Returns zero when a book side is missing or a fee is invalid.

This is a ranking filter only; it does not decide validity.

### 2. Scanner flow

For each venue and quote:

1. Enumerate triangular paths.
2. Deduplicate by currency path.
3. Attach `estimateTriangularPathReturn`.
4. Sort descending by estimate.
5. Cap the candidate list at `max_triangular_paths`.
6. Run exact `evaluateTriangularPath` only for the top `max_candidates_per_cycle`.

`ScanSummary` now records `s2Candidates` (ranked candidates) and `s2Evaluated` (paths that
reached exact simulation), so the candidate-to-exact conversion rate is observable.

### 3. Configuration

```toml
[scanner]
max_candidates_per_cycle = 100
```

Default `100`. In tests, omitting the option keeps the legacy behaviour of evaluating all
enumerated candidates.

## Implementation files

- `packages/core/src/s2.ts`: `estimateTriangularPathReturn`.
- `apps/scanner/src/scanner-service.ts`: ranking, top-N exact simulation, summary counters.
- `apps/scanner/src/config.ts`, `apps/scanner/src/main.ts`, `config/default.toml`: config.

## Verification

- `npm run check`: 21 test files / 143 tests, typecheck, test typecheck, Prettier, and
  synthetic backtest pass.
- Coverage: 79.58% statements, 72.25% branches, 76.65% functions, 82.95% lines.
- Core test asserts the top-of-book estimate is positive for a profitable triangular path.
- Scanner test sets `max_candidates_per_cycle = 1` and verifies two candidates are ranked
  but only one is exact-simulated.
- Existing S1-S4 tests remain green.

## Next step

P0-3: intra-venue multi-hop path search (2-5 legs, any intermediate currency) using the
same ranking and top-N exact-simulation flow.
