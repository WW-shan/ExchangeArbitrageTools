# Discovery P0-3: Intra-Venue Multi-Hop Search

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Generalise the S2 triangular search from exactly three legs to two-to-five legs inside a
single venue, with any intermediate currency and a bounded branch factor so the search
does not explode.

## Design

### 1. Bounded cyclic enumeration

New function in `packages/core/src/s2.ts`:

```ts
enumerateCyclicPaths(edges, {
  startCurrency,
  maxHops,
  maxLegsPerCurrency,
  maxPaths,
}): TriangularPath[]
```

- Builds a directed adjacency list from each market:
  - sell base -> quote at the best bid, fee-adjusted;
  - buy base with quote at the best ask, fee-adjusted.
- Sorts each currency's outgoing edges by rate and keeps only the top
  `maxLegsPerCurrency`.
- Depth-first search from the start currency, never revisiting a currency except to close
  the loop, and never reusing the same market inside one path.
- Collects closed loops of two to `maxHops` legs, deduplicated by currency path.

`MAX_PATH_HOPS = 5` is the hard cap used by exact simulation.

### 2. Exact simulation length

`simulateChain` now accepts paths of two to five edges. Longer paths are rejected with
`quote_mismatch`, so a misconfigured caller cannot silently evaluate an unbounded path.

### 3. Scanner integration

The scanner replaces `enumerateTriangularPaths(edges, quote, 3, 2)` with
`enumerateCyclicPaths` using the configured `max_hops` and `max_legs_per_currency`, then
applies the P0-2 ranking and top-N exact simulation.

### 4. Configuration

```toml
[scanner]
max_hops = 5
max_legs_per_currency = 4
```

## Implementation files

- `packages/core/src/s2.ts`: directed adjacency, bounded cyclic enumeration, length cap.
- `apps/scanner/src/scanner-service.ts`: multi-hop enumeration wiring.
- `apps/scanner/src/config.ts`, `apps/scanner/src/main.ts`, `config/default.toml`: config.

## Verification

- `npm run check`: 21 test files / 144 tests, typecheck, test typecheck, Prettier, and
  synthetic backtest pass.
- Coverage: 79.96% statements, 72.30% branches, 76.73% functions, 83.35% lines.
- Core test builds a four-leg profitable cycle and verifies it is enumerated and evaluated
  as valid; a six-leg path is rejected.
- Existing triangular, scanner, and storage tests remain green.
- A same-market reverse two-leg cycle is rejected because a market may appear only once in
  a path.

## Next step

P0-4: cross-venue multi-hop in inventory mode, using `(venue, currency)` nodes and
inventory edges, with transfers disabled by default.
