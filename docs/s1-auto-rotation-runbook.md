# S1 Automatic Two-Sided Rotation Runbook

Status: implemented and live-tested, 2026-10-29. The first automatic TBK round
trip closed successfully. The supervisor uses the persisted scanner signal but
performs its own private-balance and fresh-book checks before every order. It is
not a cross-exchange atomic arbitrage strategy.

## What runs

The automatic path consists of two processes sharing `data/rotation.sqlite`:

1. `apps/scanner/src/main.ts` maintains WebSocket order books, evaluates both
   directions of the whitelisted pair on Gate.io, Hotcoin, WEEX and Bitget,
   records venue health, and persists valid S1 opportunities. WEEX signals are
   explicitly marked `monitorOnly`; Gate.io and Bitget have private execution
   credentials in this profile.
2. `apps/executor/src/main.ts --auto` reads only valid S1 rows for the
   whitelist, rejects monitor-only routes, refreshes Gate/Bitget private
   balances, derives the funded rotation direction, and submits one FOK batch
   only when the direction is funded and the signal is fresh. See
   `docs/s1-four-venue-monitoring.md`.

`scripts/watch-rotation.ps1` is the sole lifecycle manager. It starts the
executor first, waits for a fresh executor heartbeat, then starts the scanner.
It owns a process lock, independent heartbeats, restart/backoff, duplicate
detection and structured status files. `scripts/start-rotation.ps1` is only a
thin launcher.

## Automatic account-state check

The `--auto` path does not require a manual balance command. At startup it
fetches both venues' private balances, queries open orders for the configured
pair symbols, reconciles local open executions, and blocks if any of those
checks fail. During the loop it refreshes balances every `balance_refresh_ms`
and checks both venues for open orders immediately before every batch.

For a read-only snapshot, run:

```powershell
. .\scripts\load-env.ps1 -Path .env.live-test
$env:ARB_CONFIG = 'config/live-rotation.toml'
npm run account:state
```

The command prints the funded pair amounts, non-zero pair balances, exchange
open orders, local open executions/unresolved orders, and any query errors. It
also prints declared versus observed account permissions, transfer state, and
the account-status baseline decision. It does not submit or cancel orders.

## Inventory state

Only one direction can be funded at a time:

```text
Gate quote + Hotcoin base  -> buy Gate, sell Hotcoin
Hotcoin quote + Gate base  -> buy Hotcoin, sell Gate
```

After a completed round trip the inventory naturally becomes ready for the
opposite direction. No withdrawal or deposit is part of the trade path. If the
market only offers the unfunded direction, the supervisor waits.

The inventory state is tracked per pair. The current TBK state after the first
live round trip is:

```text
Gate USDT + Hotcoin TBK -> ready for Gate buy / Hotcoin sell
```

The LIGHT seed remains separate and is still ready for Gate buy / Hotcoin sell.

## Automatic inventory seeding

When neither direction is executable because one side lacks base inventory, the
supervisor can create a small `SEED` execution. It does not pretend this is an
arbitrage trade:

- normal S1 and calibrated preparation always take priority;
- only one pair is checked per `check_interval_ms`;
- both books must be fresh and the candidate ask must remain stable for
  `min_stable_ms`;
- if both sides lack useful inventory, buy the cheaper ask;
- if one side already has inventory, top up the missing side only when it is
  cheaper or within `max_pair_deviation_bps` of the other ask;
- spend at most `seed_notional_usd`, keep `min_quote_reserve_usd`, and require
  the resulting base value to reach `min_useful_notional_usd`;
- submit one FOK limit buy and record `strategy=SEED`, `side=buy`, inventory
  delta, order events, audit and balance snapshots.

The live profile uses 5 USDT per seed, keeps at least 5 USDT quote, requires 3
USDT of useful base, and uses a 30 bps near-parity band and a 100 bps stability
window. Unknown or partial seed
fills open the kill switch and require manual reconciliation. A rejected FOK
does not open the kill switch; it waits for the retry cooldown.

For a `SEED_UNKNOWN` caused by a pre-submission rejection, verify the exchange
has no open order and the free balances still match the recorded pre-seed
snapshot, then run:

```powershell
npm run seed:reconcile -- --batch <batchId> --confirm <batchId>
```

The command never submits an order and never clears the kill switch.

Full design: `docs/s1-automatic-inventory-2026-10-30.md`.

## Reversion preparation

The supervisor can shift inventory when a funded direction returns to near
breakeven. It does this only when the pair and direction have a positive
calibration in `config/s1-prep-calibration.json`, the reverse probability is at
least `min_reverse_probability`, the median reverse time is within
`max_hold_ms`, and the cost-adjusted expected value is positive.

The 2026-10-29 calibration allows two TBK combinations:

```text
TBK/USDT gate->hotcoin, 5 bps band:
  reverse probability: 0.5667 within 60 minutes
  median reverse time: 4 minutes
  median reverse edge: 47.82 bps
  mean no-reverse loss: 36.87 bps
  median preparation cost: 2.05 bps
  expected value: +9.07 bps at 20 USDT

TBK/USDT hotcoin->gate, 12 bps band:
  reverse probability: 0.5522 within 30 minutes
  median reverse time: 3 minutes
  median reverse edge: 51.50 bps
  mean no-reverse loss: 43.33 bps
  median preparation cost: 6.21 bps
  expected value: +2.82 bps at 20 USDT
```

LIGHT is rejected in both bands because its conditional reverse probability
and expected value are negative.

## Automatic inventory rebalance

When a fresh valid signal exists in the unfunded direction, the supervisor can
now plan the missing base/quote transfers from the opposite venue. The path is
still protected by all of the following:

- `transfers.enabled=true` and a complete `[[transfers.allowlist]]` route;
- exact withdrawal fee and `fee_mode=deducted` for automatic release;
- expected arrival time within `max_arrival_ms`;
- transfer cost below `max_cost_usd` and below the opportunity edge minus
  `min_net_edge_bps`;
- no open execution, unresolved order or active transfer;
- `release_mode='automatic'` plus the persisted
  `transfer_auto_release_enabled=true` arm switch;
- the existing preflight, source-balance, address, tag, network, daily-limit,
  arrival-evidence and unknown-withdrawal checks.

`release_mode='manual'` only creates a `PLANNED` batch and prints its id. The
operator must run `rebalance:execute --execute --confirm-batch <id>`.

The live profile currently keeps transfers disabled because real destination
addresses and measured withdrawal fees are not committed to Git. Do not arm
automatic release until a one-leg manual transfer has been reconciled on both
venues.

The live profile sets `prefilter_floor_bps = -12` so both calibrated bands
reach the full evaluator. This does not lower the normal S1 entry threshold;
it only lets the preparation gate see the reversion bands.

There is no separate fixed cost cap. The limit is derived from the calibration
and scales with notional:

```text
break_even_cost_bps = EV_bps + median_prep_cost_bps
max_cost_bps        = break_even_cost_bps - min_expected_value_bps
max_cost_usd        = notional * max_cost_bps / 10_000
```

The `prep_band_bps` is the range in which the probability was measured. A cost
inside that band is accepted only if the remaining expected value is still at
least `min_expected_value`; a cost above the largest measured band has no
calibration and fails closed rather than extrapolating the estimate.

There is no daily preparation count cap and no preparation cooldown. Every
repeat must pass the same fresh calibration, expected-value, and per-trade cost
checks. If the reverse edge does not arrive, the supervisor logs
`preparation_carrying` after `max_hold_ms` and keeps waiting. It does not force
an exit and does not assume convergence. See
`docs/s1-reversion-preparation-2026-10-29.md`.

## Low-liquidity book timestamps

Gate TBK can go 2-15 seconds without a new order-book update. The exchange
timestamp is the last update time, not the HTTP response time. The live rotation
profile therefore uses a wider exchange-age window:

```toml
max_orderbook_age_ms = 20000
max_feed_latency_ms = 20000
max_freeze_ms = 10000
ws_max_book_age_ms = 5000
max_pair_skew_ms = 5000
```

This does not weaken execution safety: the executor re-fetches both books,
refreshes both private balances, re-evaluates depth and net edge, and submits
FOK limit orders. A stale or wrong price cannot be chased with an unbounded
market order.

## One-time seed

Seed exactly one side with a bounded limit order. The seed script sizes by base
quantity, aligns to the common Gate/Hotcoin amount step, and uses FOK at the
worst executable ask.

```powershell
. .\scripts\load-env.ps1
$env:ARB_CONFIG = 'config/live-rotation.toml'
npm run seed:rotation -- --base LIGHT --notional 10 --buy-venue hotcoin
```

Use `--buy-venue hotcoin` to make Gate -> Hotcoin the first funded direction;
that direction has the larger historical episode count. Remove `--buy-venue`
to let the script choose the venue with sufficient quote and the lower gross
fee. The command is a dry run unless `--execute` is added.
The execution form is:

```powershell
npm run seed:rotation -- --base LIGHT --notional 10 --buy-venue hotcoin --execute
```

After the seed fills, the opposite direction is funded. There is no recurring
manual confirmation in the supervisor path. `execution.manual_confirmation`
remains true only for the separate manual CLI; automatic confirmation is a
distinct code path guarded by `[auto_rotation] enabled` and the persisted
`auto_execution_enabled` setting.

## Start and stop

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-rotation.ps1
```

Scanner stdout/stderr are written to `data/rotation-scanner.*.log`. Supervisor
events are JSON lines on stdout with `mode=auto_rotation`.

Stop with Ctrl+C. The supervisor removes `auto_execution_enabled` on a clean
exit. A SAFE_STOP sets the persisted kill switch, so restarting the scanner does
not silently clear it.

If it was started in the background, stop only this repository's scanner and
supervisor with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-rotation.ps1
```

## Entry gates

The executor still re-evaluates the books after the scanner signal. It requires:

- pair in `[[auto_rotation.pairs]]` and notional at or below its limit;
- valid S1 signal no older than `max_signal_age_ms`;
- Gate and Hotcoin health A or B;
- fresh private balance snapshots on both venues;
- the direction implied by the signal to be fully funded;
- exchange timestamps within the configured low-liquidity window, with
  received-at and WebSocket freshness checked separately;
- no open execution, unresolved order, balance mismatch, or kill switch;
- daily loss limit not reached;
- fresh executable depth and positive net edge after fees and safety buffer.

If leg 1 fills but leg 2 cannot, the existing executor enters SAFE_STOP and
records unhedged inventory. It does not retry blindly and does not transfer
funds automatically. A confirmed long residual may receive one automatic FOK
flatten on the same venue when `[auto_rotation.residual_hedge]` is enabled.
Unknown orders, mixed assets, stale baselines, partial-only quantity and losses
above `max_loss_usd` never reach the automatic path.

## SAFE_STOP reconciliation

A SAFE_STOP deliberately leaves the kill switch on and leaves the execution
open. It may also leave a separate HEDGE execution when the automatic flatten
attempted an order whose result was unknown. Do not edit the database by hand.
First refresh private balances and open orders:

```powershell
. .\scripts\load-env.ps1
$env:ARB_CONFIG = 'config/live-rotation.toml'
npm run account:state
```

If the filled long inventory is present and you intend to keep it for the next
rotation, close the batch with the exact batch id:

```powershell
npm run execution:reconcile -- --batch <batchId> --carry-inventory --confirm <batchId>
```

The command verifies that there is exactly one open execution, no unresolved
orders, a filled leg, open long inventory, and a fresh balance large enough to
cover that inventory. It then marks the execution `RECONCILED`, closes the
unhedged row, and writes risk/audit records. It never submits an order and never
clears the kill switch. If the balance check fails, refresh balances and inspect
the account before retrying.

After reviewing the output, release the kill switch:

```powershell
npm run rotation:release -- --confirm RELEASE-KILL-SWITCH
npm run rotation:start
```

The carried base becomes ordinary inventory. The next funded rotation can sell
it on the same venue; this is not a guaranteed hedge and does not realize the
original trade's expected profit.

## Relevant configuration

```toml
[auto_rotation]
enabled = true
poll_interval_ms = 1000
balance_refresh_ms = 5000
max_signal_age_ms = 10000
cooldown_ms = 0
max_consecutive_failures = 3

[auto_rotation.preparation]
enabled = true
max_notional = '10'
min_stable_ms = 30000
calibration_file = 'config/s1-prep-calibration.json'
min_reverse_probability = '0.55'
min_expected_value_bps = '0'
min_expected_value_usd = '0'
max_hold_ms = 3600000

[[auto_rotation.pairs]]
base = 'LIGHT'
quote = 'USDT'
max_notional = '20'

[[auto_rotation.pairs]]
base = 'TBK'
quote = 'USDT'
max_notional = '20'
```

`execution.live_enabled` must be true and the persisted kill switch must be
false. The scanner and supervisor both read the same database path.

The live profile also uses `min_sizing_notional = '3'`. Hotcoin TBK has
`minOrderAmount = 0`, and a 1 TBK FOK sell has been verified. Do not hardcode a
15 USDT minimum for TBK; 15 USDT applies to some other Hotcoin symbols only.

## First live TBK execution

```text
batch:            S1-111631-1793244608063
execution id:     1
direction:        Hotcoin buy -> Gate sell
quantity:         39 TBK
buy price:        0.22799 USDT
sell price:       0.23346 USDT
status:           CLOSED
realized profit:  0.20706918882 USDT
cash profit:      0.1865328894 USDT
rebate receivable:0.02053629942 USDT
net fees:         0.00626081118 USDT
```

Both legs filled, the execution is reconciled, and there are no open batches or
unhedged rows. Full evidence is in
`docs/s1-tbk-live-rotation-2026-10-29.md`.

## Known limitations

- Historical frequency is not a guarantee of a live executable edge.
- TBK is low-liquidity and outlier-heavy; keep the 10% suspicious-spread cap and
  small batch size rather than treating the backtest count as a profit promise.
- The strategy holds base inventory on one venue between round trips, so it is
  exposed to the base token price.
- The two venue legs are not atomic. A fast reversal or a venue rejection can
  leave inventory unhedged.
- The first seed is a deliberate inventory purchase, not an arbitrage trade.
- Automatic residual hedging is reduce-only and same-venue only. It keeps the
  kill switch on and cannot recover an unknown order by retrying.
- Automatic withdrawal/balance-transfer execution is implemented but disabled
  in the live profile until allowlist addresses and measured fees are supplied.
- Reversion preparation is calibrated on OHLCV and is not a guarantee. The
  live executor still re-fetches both books, checks balances, and uses FOK.
