# Discovery P0-4b: Cross-Venue Multi-Hop in Inventory Mode

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Find price dislocations that span more than one venue without moving funds between
venues. The scanner uses balances that are already sitting on each exchange
(inventory mode), so an opportunity is a sequence of trades whose inventory
requirements are satisfied by pre-positioned balances.

## Model

### Nodes and edges

- Node: `(venueId, currency)`.
- Trade edge: a buy or sell inside one venue, priced from the top of book and
  fee-adjusted. Each market can be used at most once inside a path.
- Inventory edge: `(venueA, currency) -> (venueB, currency)`. It costs nothing and
  represents "use the currency that is already free on venue B". Its capacity is
  venue B's free balance of that currency. Transfers, withdrawals, and chain
  settlement are not modelled here.

### Path shape

A cross-venue opportunity is an open path that starts and ends in the scan quote
currency (for example USDT) but may end on a different venue:

```
USDT @ gateio -> CAKE @ gateio -> CAKE @ mecx -> USDT @ mecx
```

This is deliberate. In inventory mode the profit physically lands on the ending
venue and the starting venue is left holding the intermediate asset; rebalancing is
a separate process. Requiring the path to return to the exact starting node would
force an artificial extra inventory edge and would hide real two-venue trades.

Constraints enforced by the core:

- 2 to 5 total legs, with a hard five-leg cap.
- At least 2 trade legs.
- At least 1 inventory edge and at least 2 distinct trade venues.
- No leading inventory edge and no consecutive inventory edges.
- `venueSwitches` may not exceed `max_venue_switches`.
- Start venue must have at least the requested notional in free quote balance.
- Every inventory edge must have enough free balance at its destination.

### Simulation

`simulateCrossVenuePath` replays the path with real depth, precision, minimum
notional, fees, and order-book freshness checks. It produces two runs, gross and
net, exactly like the triangular simulator, so the safety buffer and minimum net
profit threshold are applied consistently. Health below `A`/`B` rejects the path.

Results use `strategy = "S2"` and `metadata.variant = "cross_venue_inventory"`, so
the four-goal accounting stays intact while the dashboard and audit trail can tell
cross-venue paths apart. `metadata.pathClass` is `two_venue_bridge` for a two-trade
path (the balance-checked equivalent of S1) and `multi_hop` for three or more trades.

## Search control

- Trade branch factor per node: `max_legs_per_currency`.
- Venue switches per path: `max_venue_switches` (default 1, i.e. two venues).
- Paths are ranked by a top-of-book estimate and only the top
  `max_candidates_per_cycle` are simulated exactly.
- Enumeration is capped at `max(500, max_triangular_paths)` paths.
- Inventory edges are only built for currencies that actually have a trade market,
  so unrelated balances cannot bloat the graph.

## Configuration

```toml
[scanner]
cross_venue_mode = "inventory"
max_venue_switches = 1
balance_max_age_ms = 300000
```

`cross_venue_mode = "off"` disables the whole cross-venue phase. Balance snapshots
older than `balance_max_age_ms` are ignored, so a stale refresh cannot create
phantom inventory.

## Implementation files

- `packages/core/src/crossvenue.ts`: graph construction, bounded path enumeration,
  exact simulation, evaluation.
- `packages/core/src/types.ts`: `insufficient_inventory` rejection reason.
- `apps/scanner/src/scanner-service.ts`: balance-driven cross-venue scan phase and
  `s2CrossVenueCount` / `crossVenueCandidates` / `crossVenueEvaluated` counters.
- `apps/scanner/src/config.ts`, `apps/scanner/src/main.ts`, `config/default.toml`:
  configuration plumbing.

## Verification

- `npm run check` passes: typecheck, test typecheck, Prettier, 23 test files /
  156 tests, and the synthetic backtest.
- Coverage: 80.55% statements, 72.52% branches, 77.95% functions, 83.85% lines.
- Core tests cover: a profitable two-venue inventory path, rejection when the
  destination has no inventory, rejection when destination inventory is too small,
  the venue-switch limit, an unfunded start venue, suppression of single-venue
  triangular loops, a three-venue two-switch chain, and malformed path rejection.
- Scanner integration tests cover: an opportunity appears with fresh balances, no
  opportunity appears without balances, and stale balance snapshots are ignored.

## Known limitations

- Rebalancing cost and transfer latency are not included. Results are marked
  `rebalanceDeferred = true`. P1 will add the rebalance workflow and cost.
- When destination inventory is smaller than the desired size, the path is rejected
  instead of being resized. P1-1 optimal notional sizing will fix this.
- Ranking uses top-of-book only; the exact simulation still walks full depth.

## Next step

P1-1 optimal notional sizing, then P1-2 opportunity lifetime and historical replay.
Real BSC quote/liquidity work remains P0-5 and still requires external data.
