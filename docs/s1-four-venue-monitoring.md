# S1 Four-Venue Public Monitoring

Status: implemented 2026-10-29.

## Scope

The S1 scanner monitors four spot venues in the live-rotation profile:

```text
Gate.io
Hotcoin
WEEX
Bitget
```

All four venues contribute public market data, order books, ticker volume,
venue health and S1 signals. Live execution remains limited to Gate.io and
Hotcoin. WEEX and Bitget are monitor-only because this repository does not yet
hold their private credentials, verified account fee tiers, or execution
permission checks.

This is deliberate defense in depth:

- The scanner marks every route touching WEEX or Bitget with
  `monitorOnly=true` and `balanceCapIgnored=true`.
- Monitor-only routes ignore private balance snapshots entirely, so a small or
  missing balance cannot hide a public-market opportunity.
- The scanner does not create paper simulations for monitor-only routes.
- The automatic executor independently rejects any route whose buy or sell
  venue is not `gateio` or `hotcoin`, even if a malformed or stale database row
  claims the route is valid.

## Configuration

`config/live-rotation.toml`:

```toml
[scanner]
enabled_venues = ['gateio', 'hotcoin', 'weex', 'bitget']
monitor_only_venues = ['weex', 'bitget']

[fees.weex]
taker_bps = 10
maker_bps = 10

[fees.bitget]
taker_bps = 10
maker_bps = 10
```

`monitor_only_venues` must be a subset of `enabled_venues`. Configuration
loading fails closed when it is not.

The 10 bps WEEX/Bitget rates are conservative placeholders for signal
visibility, not verified account fees. They must be replaced with real account
tiers before either venue can be considered for execution. Because WEEX and
Bitget are monitor-only, these placeholders cannot cause an order.

`config/discovery.toml` and `config/longtail.toml` also include all four venues
for read-only discovery. The long-tail universe still requires at least two
venues for a pair; it does not require all four venues to list the same token.

## Venue coverage

The checked-in explicit universe is `LIGHT/USDT` and `TBK/USDT`:

| Pair         | Gate.io | Hotcoin | WEEX | Bitget |
| ------------ | ------- | ------- | ---- | ------ |
| `LIGHT/USDT` | yes     | yes     | yes  | yes    |
| `TBK/USDT`   | yes     | yes     | yes  | no     |

A missing pair on one venue is normal. S1 compares every pair present on at
least two enabled venues, so Bitget can still contribute LIGHT routes without
requiring TBK.

## Connectivity check

Public REST and WebSocket connectivity can be checked without credentials:

```powershell
. .\scripts\load-env.ps1
npm run probe:venues -- --venues gateio,hotcoin,weex,bitget --pair BTC/USDT
```

The probe must show successful REST market loading, ticker retrieval and
WebSocket order-book data for all four venues. A REST-only result is not enough
to claim WebSocket coverage.

## Runtime verification

After restarting the rotation supervisor, verify the scanner loaded all four
venues:

```powershell
npm run rotation:status
Get-ChildItem data/logs -Filter 'scanner-*.out.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  ForEach-Object { Get-Content $_.FullName -Tail 100 }
```

The scanner log must contain a market-discovery record for `gateio`,
`hotcoin`, `weex` and `bitget`.

Verify WEEX/Bitget signals are marked monitor-only:

```powershell
@'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/rotation.sqlite');
const rows = db
  .prepare('SELECT venue_buy, venue_sell, valid, metadata_json FROM opportunities WHERE strategy = ? ORDER BY sampled_at DESC LIMIT 20')
  .all('S1');
console.log(rows);
db.close();
'@ | node
```

Every row involving `weex` or `bitget` must contain a true `monitorOnly` flag.
There must be no live execution or open order for those venues. The executor
heartbeat wait reason should show `monitor_only_route:<buy>-><sell>` when such
a route is the best available signal and no Gate/Hotcoin route is actionable.

## Failure behavior

- WEEX/Bitget public feed failure: venue health degrades and S1 routes touching
  that venue stop producing fresh signals; Gate/Hotcoin scanning continues.
- WEEX/Bitget private balance missing or stale: ignored for monitor-only routes.
- WEEX/Bitget signal reaches the executor: rejected with
  `monitor_only_route:<buy>-><sell>`.
- A Gate/Hotcoin SAFE_STOP is reconciled with `execution:reconcile`; see
  `docs/s1-auto-rotation-runbook.md`.
- Unknown or malformed monitor-only configuration: startup fails.
- Gate/Hotcoin execution safety checks are unchanged.

## Enabling execution later

Do not simply remove a venue from `monitor_only_venues`. Execution enablement
requires all of the following:

1. Private API credentials with the minimum required permissions and an IP
   whitelist.
2. Verified account fee tier, rebate and maker/taker behavior.
3. Private balance and open-order reconciliation.
4. FOK/IOC capability verification and a no-fill probe.
5. Exact market minimum amount and minimum notional handling.
6. Account-permission, clock-drift, stale-feed and daily-loss gates.
7. A small manually confirmed live batch before automatic execution.

Until those checks exist, the four-venue scanner is a discovery tool for
Gate/Hotcoin execution, not a four-venue trading system.
