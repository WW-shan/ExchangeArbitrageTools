# S1 Automatic Two-Sided Rotation Runbook

Status: implemented and live-tested, 2026-10-29. The first automatic TBK round
trip closed successfully. The supervisor uses the persisted scanner signal but
performs its own private-balance and fresh-book checks before every order. It is
not a cross-exchange atomic arbitrage strategy.

## What runs

The automatic path consists of two processes sharing `data/rotation.sqlite`:

1. `apps/scanner/src/main.ts` maintains WebSocket order books, evaluates both
   directions of the whitelisted pair, records venue health, and persists valid
   S1 opportunities.
2. `apps/executor/src/main.ts --auto` reads only valid S1 rows for the
   whitelist, refreshes Gate/Hotcoin private balances, derives the funded
   rotation direction, and submits one serial FOK batch only when the direction
   is funded and the signal is fresh.

The helper `scripts/start-rotation.ps1` starts both and stops the scanner when
the supervisor exits.

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

## Reversion preparation

The supervisor can shift inventory when a funded direction returns to near
breakeven. It does this only when the pair and direction have a positive
calibration in `config/s1-prep-calibration.json`, the reverse probability is at
least `min_reverse_probability`, the median reverse time is within
`max_hold_ms`, and the cost-adjusted expected value is positive.

The 2026-10-29 calibration allows only `TBK/USDT|gate->hotcoin`:

```text
reverse probability: 0.5667 within 60 minutes
median reverse time: 4 minutes
median reverse edge: 47.82 bps
mean no-reverse loss: 36.87 bps
median preparation cost: 2.05 bps
expected value: +9.07 bps at 20 USDT
```

The live profile sets `prefilter_floor_bps = -5` so near-breakeven negative
edges reach the full evaluator. This does not lower the normal S1 entry
threshold; it only lets the preparation gate see the reversion band.

After a preparation closes, another preparation is blocked until a normal S1
round trip closes. If the reverse edge does not arrive, the supervisor logs
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
- daily loss limit not reached and the per-batch cooldown elapsed;
- fresh executable depth and positive net edge after fees and safety buffer.

If leg 1 fills but leg 2 cannot, the existing executor enters SAFE_STOP and
records unhedged inventory. It does not retry blindly and does not transfer
funds automatically.

## Relevant configuration

```toml
[auto_rotation]
enabled = true
poll_interval_ms = 1000
balance_refresh_ms = 5000
max_signal_age_ms = 10000
cooldown_ms = 3000
max_consecutive_failures = 3

[auto_rotation.preparation]
enabled = true
max_notional = '10'
max_cost_bps = 5
max_cost_usd = '0.01'
min_stable_ms = 30000
min_holding_ms = 300000
cooldown_ms = 600000
max_per_day = 6
calibration_file = 'config/s1-prep-calibration.json'
min_reverse_probability = '0.55'
min_expected_value_bps = '0'
min_expected_value_usd = '0'
max_hold_ms = 3600000
reversion_band_bps = 5

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
- Automatic withdrawals and balance transfers remain disabled.
- Reversion preparation is calibrated on OHLCV and is not a guarantee. The
  live executor still re-fetches both books, checks balances, and uses FOK.
