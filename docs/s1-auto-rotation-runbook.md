# S1 Automatic Two-Sided Rotation Runbook

Status: implemented in code, 2026-10-29. The supervisor uses the persisted
scanner signal but performs its own private-balance and fresh-book checks
before every order. It is not a cross-exchange atomic arbitrage strategy.

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
max_signal_age_ms = 5000
cooldown_ms = 3000
max_consecutive_failures = 3

[[auto_rotation.pairs]]
base = 'LIGHT'
quote = 'USDT'
max_notional = '20'
```

`execution.live_enabled` must be true and the persisted kill switch must be
false. The scanner and supervisor both read the same database path.

## Known limitations

- Historical frequency is not a guarantee of a live executable edge.
- The strategy holds base inventory on one venue between round trips, so it is
  exposed to the base token price.
- The two venue legs are not atomic. A fast reversal or a venue rejection can
  leave inventory unhedged.
- The first seed is a deliberate inventory purchase, not an arbitrage trade.
- Automatic withdrawals and balance transfers remain disabled.
