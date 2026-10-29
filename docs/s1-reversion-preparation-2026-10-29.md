# S1 Reversion-Triggered Inventory Preparation

Date: 2026-10-29

## 1. Decision

Yes, the executor can prepare inventory when the funded direction returns to
near breakeven. It must not treat that reversion as a promise that the reverse
spread will appear. The preparation is allowed only when a historical
calibration says the reverse opportunity is frequent enough, fast enough, and
large enough to pay for the preparation cost.

This is an inventory shift, not a mean-reversion position:

```text
state A: Gate USDT + Hotcoin base
  prep trade: buy Gate, sell Hotcoin at near breakeven
state B: Gate base + Hotcoin USDT
  wait for a normal S1 Hotcoin -> Gate edge
```

If the reverse edge never appears, the account keeps the base inventory and
waits. The executor does not force a losing reverse trade and does not assume
that price must return.

## 2. Trigger

A preparation candidate must satisfy all of the following:

1. No normal S1 opportunity is executable.
2. The preparation direction is fully funded by fresh balances.
3. The scanner opportunity is fresh and its only rejection reasons are profit
   thresholds. Depth, freshness, precision, fees, health, and balance failures
   are never overridden.
4. The current executable net edge is at or below zero but within
   `reversion_band_bps` (default 5 bps). A small positive edge below the normal
   entry threshold is also accepted; a wide negative spread is not.
5. A calibration row exists for `PAIR|direction`.
6. `reverse_probability >= min_reverse_probability` (default 0.55).
7. `median_time_to_reverse_ms <= max_hold_ms` (default 1 hour).
8. The cost-adjusted expected value is positive after replacing the historical
   median preparation cost with the current preparation cost.
9. `max_notional`, `max_cost_bps`, and `max_cost_usd` pass for this trade.

There is no daily preparation count cap, no daily preparation cost cap, and no
preparation cooldown. Every repeat must pass the same fresh calibration,
expected-value, cost, balance, and market checks. `min_stable_ms` is a signal
stability check, not a cooldown.

The candidate must remain stable for `min_stable_ms` before submission.

The live rotation profile also sets `prefilter_floor_bps = -5`; otherwise the
scanner would discard the near-breakeven negative rows before the preparation
gate can evaluate them. The normal S1 threshold remains unchanged.

## 3. Calibration math

For each pair and preparation direction, the backtest scans 1-minute candles
for near-breakeven preparation samples. After a preparation it simulates:

- the reverse direction's executable net edge;
- time until that edge reaches `reverse_target_bps`;
- an adverse stop on the base held on the buy venue;
- the mark-to-market loss if neither the reverse edge nor the stop occurs.

The expected value is:

```text
p             = reverse hits / preparation samples
reverse_bps   = median reverse net edge at hit
no_reverse_bps = mean loss of stopped and no-reverse samples
prep_cost_bps = median preparation cost

EV_bps = p * reverse_bps
         - (1 - p) * no_reverse_bps
         - prep_cost_bps
```

The stop check is deliberately conservative: if a candle touches both the stop
and the reverse target, the stop is counted first because OHLCV cannot tell us
the intrabar order.

## 4. 2026-10-29 backtest result

Data: Gate.io and Hotcoin, `1m`, 6 days, 20 USDT reference notional, 2 bps
safety buffer, 10 bps extra slippage, 5 bps preparation band, 5 bps reverse
target, 50 bps adverse stop.

| Pair       | Preparation direction | Horizon | Samples | P(reverse) | Median time | Reverse bps | No-reverse loss bps | Prep cost bps | EV bps |  EV USD |
| ---------- | --------------------- | ------: | ------: | ---------: | ----------: | ----------: | ------------------: | ------------: | -----: | ------: |
| TBK/USDT   | Gate -> Hotcoin       |     60m |      30 |     0.5667 |        4.0m |       47.82 |               36.87 |          2.05 |  +9.07 | +0.0181 |
| TBK/USDT   | Hotcoin -> Gate       |     60m |      29 |     0.5172 |        3.0m |       38.13 |               42.86 |          2.56 |  -3.52 | -0.0070 |
| LIGHT/USDT | Gate -> Hotcoin       |     60m |     100 |     0.3800 |        7.0m |       11.03 |               45.45 |          2.32 | -26.31 | -0.0526 |
| LIGHT/USDT | Hotcoin -> Gate       |     15m |     167 |     0.3892 |        6.0m |       15.32 |               32.02 |          2.35 | -15.95 | -0.0319 |

Runtime result with `min_reverse_probability = 0.55`:

- `TBK/USDT|gate->hotcoin` is allowed.
- The other three directions are rejected by the probability gate.

This is intentionally narrow. LIGHT's raw spread frequency is high, but its
conditional probability of a reverse opportunity is not high enough to pay for
the preparation and adverse inventory risk.

Generated file: `config/s1-prep-calibration.json`.

## 5. No-reverse handling

A preparation that does not get a reverse edge within `max_hold_ms` is not
automatically flattened. The account still holds base inventory on the buy
venue and quote on the sell venue. The supervisor:

- logs `preparation_carrying` once per minute after the holding window;
- keeps the normal S1 path active for the now-funded reverse direction;
- may prepare again immediately when a fresh candidate passes the same gate;
- never assumes convergence and never submits a losing reverse trade to
  complete the rotation.

If the base price falls, the position is marked by the existing risk and
unhedged-inventory accounting. A SAFE_STOP still sets the persisted kill switch.

## 6. Regeneration

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npx tsx scripts/backtest-history.ts `
  --config config/longtail.toml `
  --venues gateio,hotcoin `
  --quote USDT `
  --timeframe 1m `
  --days 6 `
  --bases LIGHT,TBK `
  --min-volume 1 `
  --max-volume 5000000 `
  --notional 20 `
  --min-net-profit-bps 5 `
  --min-profit-usd 0.01 `
  --safety-buffer-bps 2 `
  --extra-slippage-bps 10 `
  --min-candle-volume-usd 20 `
  --max-sane-spread-bps 3000 `
  --prep `
  --prep-horizons-ms 900000,1800000,3600000 `
  --prep-band-bps 5 `
  --prep-target-bps 5 `
  --prep-stop-bps 50 `
  --prep-min-samples 20 `
  --out data/prep-backtest-2026-10-29.json `
  --prep-out config/s1-prep-calibration.json
```

Do not hand-edit probabilities. Regenerate after changing fees, pair list,
notional, venue behavior, or the historical window.

## 7. Limitations

- The calibration uses OHLCV, not full historical order books. It is a
  candidate filter, not an execution guarantee.
- The six-day window is short. Require a fresh live book and the executor's
  own depth, balance, fee, and precision checks before every order.
- Queue position, partial fills, exchange freezes, and the order of intrabar
  touches are not modeled.
- Rebates are accounted after the fact. The account must still fund gross fees.
- Removing the daily and cooldown caps makes calibration freshness important.
  Regenerate the calibration after any fee, pair, venue, or market-regime change.

## 8. Related files

- `apps/scanner/src/preparation-backtest.ts`
- `scripts/backtest-history.ts`
- `apps/executor/src/auto-rotation.ts`
- `apps/executor/src/auto-supervisor.ts`
- `config/s1-prep-calibration.json`
