# Discovery P1-1: Optimal Notional Sizing

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Replace "always trade the configured notional" with "trade the size that maximises
conservative net profit under the real book, fee, precision and inventory limits".

This fixes two problems at once:

- a large order can walk into worse depth and turn a profitable top-of-book signal
  into a loss;
- a path limited by destination inventory was previously rejected outright instead
  of being sized down to what is actually executable.

## Why not an LP/CPLEX solver

The strategy simulators walk discrete order-book levels with decimal precision
rounding. The profit curve is therefore piecewise linear, not a smooth continuous
program. A linear program would need a continuous approximation of the book and
could select a size that does not exist after rounding. Instead the implementation
searches the actual simulator, so every candidate size is checked against the same
depth, fee, precision, minimum-notional, health and inventory rules used in
production.

## Algorithm

`packages/core/src/optimal.ts` exposes `searchOptimalNotional`:

1. Clamp the search interval to `[minNotional, maxNotional]` and quantise to `step`.
2. Evaluate a coarse grid (default 16 samples) through the caller's exact evaluator.
3. Keep the best feasible size, then run three local grid refinements around the
   current best bracket (10 samples each). The final precision is bounded by
   `step`, so the result is deterministic.
4. Feasibility is strict: only `gross_profit_below_threshold` and
   `conservative_profit_below_threshold` are soft rejections. Depth, inventory,
   precision, staleness, health, fee and request errors are hard failures.
5. If no size is feasible, return the best overall evaluation so the opportunity is
   still recorded as rejected with its real reasons.

The evaluator runs twice per candidate, gross and net, exactly like the fixed-size
path, so the safety buffer and minimum net-profit threshold scale with the chosen
notional.

## Strategy wrappers

- `evaluateS1DirectionOptimal` in `packages/core/src/s1.ts`.
- `evaluateTriangularPathOptimal` in `packages/core/src/s2.ts`.
- `evaluateCrossVenuePathOptimal` in `packages/core/src/crossvenue.ts`; the upper
  bound is additionally capped by the start venue's free quote balance.

Every result keeps `requestedNotional` equal to the chosen size and adds
`metadata.sizing = "optimal"`, `metadata.sizingEvaluated` and
`metadata.sizingBoundary` (`min`, `max` or `interior`).

## Scanner integration

- S1, S2 and cross-venue candidates are optimised only when a cheap top-of-book
  estimate is positive.
- The number of optimised candidates per cycle is capped by
  `max_sizing_candidates_per_cycle`, so the search cannot multiply the scan cost
  without bound.
- `ScanSummary.sizingCandidates` reports how many candidates were optimised.

Configuration:

```toml
[scanner]
optimal_sizing = true
min_sizing_notional = "1"
sizing_step = "0.01"
max_sizing_candidates_per_cycle = 40
sizing_samples = 16
```

## Implementation files

- `packages/core/src/optimal.ts`: bounded search and feasibility rules.
- `packages/core/src/s1.ts`, `s2.ts`, `crossvenue.ts`: strategy wrappers.
- `apps/scanner/src/scanner-service.ts`: estimate-gated optimisation and counters.
- `apps/scanner/src/config.ts`, `apps/scanner/src/main.ts`, `config/default.toml`.

## Verification

- `npm run check` passes: typecheck, test typecheck, Prettier, 25 test files /
  167 tests, and the synthetic backtest.
- Coverage: 81.55% statements, 72.62% branches, 79.59% functions, 84.88% lines.
- Core tests cover: interior maximum, min/max boundaries, hard depth rejection,
  S1 depth-cliff sizing, S2 bid-level sizing, and the cross-venue inventory cap.
- Scanner integration test proves the same books are rejected at a fixed 30 USDT
  but accepted after sizing down, and that `requested_notional` and
  `metadata.sizing` are persisted.

## Limitations

- The search is a deterministic bounded grid, not a proof of the global optimum.
  With `step = 0.01` the size error is at most one cent of quote currency.
- Ranking still uses top-of-book; only the chosen candidates are exactly simulated.
- The per-cycle cap can defer optimisation of lower-ranked candidates to a later
  cycle.
