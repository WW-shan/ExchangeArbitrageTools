# S1 Account-State Automation Design

Date: 2026-10-29

## 1. Goal

The live rotation must not depend on an operator running `executor:balances` or
manually deciding which side is funded. At startup and during every loop it
must:

1. read the real account state from both venues;
2. reconcile that state with local executions and orders;
3. derive the only funded rotation direction;
4. wait when no direction is funded;
5. enter SAFE_STOP when the account state is ambiguous;
6. execute automatically only after a fresh scanner signal passes the normal
   market, balance, precision, fee, and expected-value gates.

The current supervisor already performs the balance part of this loop. This
document defines the complete state machine and the missing pieces.

## 2. Current implementation

The `--auto` path already has these behaviors:

- `apps/executor/src/main.ts` loads the encrypted credential store and calls
  `recoverExecutorStartup` before starting the supervisor.
- `recoverExecutorStartup` queries known unresolved orders, fetches private
  balances for both venues, persists them, and blocks execution if balances
  cannot be confirmed or if an open execution/unresolved order remains.
- `runAutoRotationSupervisor` refreshes both venues' balances every
  `balance_refresh_ms` (currently 5 seconds).
- `pairBalances` converts the stored balances into canonical base/quote
  amounts for each whitelisted pair.
- `assessRotationReadiness` derives `READY_GATE_TO_HOT`,
  `READY_HOTCOIN_TO_GATE`, `BOTH_READY`, `WAIT`, or `BLOCKED`.
- The supervisor selects only a candidate whose direction is funded, and the
  executor refreshes both books and private balances again before submitting.
- A completed round trip changes the balances, so the next loop naturally
  derives the opposite direction without an operator action.

Therefore the program does not need a manual balance command for normal
automatic operation. The manual command is only a diagnostic.

## 3. P0 implemented

The first account-state layer is implemented:

- `CexAdapter.fetchOpenOrders` is available for Gate through CCXT and for
  Hotcoin through its current-order endpoint.
- Startup recovery queries open orders for every configured pair symbol and
  blocks when an order is found or when the query cannot be completed.
- The executor checks both venues for open orders immediately before every
  batch. An external open order triggers `SAFE_STOP`; a failed query blocks the
  preflight.
- The auto supervisor refuses to run if either venue cannot verify open orders.
- `npm run account:state` is a read-only diagnostic that prints balances,
  funded pair amounts, open orders, local execution counts, and query errors.
- The supervisor writes an `account_state` log entry after its first successful
  balance refresh.

The Hotcoin response shape is normalized from `entrutsCur` (current orders) and
`entrutsHis` (history). Only `entrutsCur` is used for open-order safety checks.

## 4. Remaining pieces

### P1: permissions and account status

The secret store records whether a credential is declared as trade-only. That
is not the same as the exchange's current permission state. Where the venue
exposes it, query the account's trading/withdrawal permissions at startup and
periodically. A newly enabled withdrawal permission, disabled trading
permission, or IP-whitelist change must block automatic execution until an
operator reviews it.

### P1: process supervision

The current PowerShell launcher starts scanner and supervisor but does not
restart them after a crash or a reboot. Add a Windows Scheduled Task or service
wrapper with:

- start at logon/boot;
- restart on abnormal exit;
- one instance only;
- heartbeat file or database timestamp;
- alert when the heartbeat is stale.

Restarting the process must always run the same startup reconciliation before
any order is allowed.

### P2: automatic rebalancing

Automatic withdrawal/deposit is deliberately out of scope for the normal trade
path. If the funded direction is unavailable, the supervisor waits. A future
rebalance service may transfer inventory only with an allowlist, explicit
arrival evidence, transfer-cost accounting, and a separate manual release.

## 5. State machine

```text
STARTING
  -> RECONCILING
       -> SAFE_STOP          unknown order, balance mismatch, API/auth failure
       -> WAIT               no funded direction or stale market signal
       -> READY_GATE_TO_HOT  Gate quote + Hotcoin base are sufficient
       -> READY_HOTCOIN_TO_GATE  Hotcoin quote + Gate base are sufficient
       -> BOTH_READY         both directions funded; choose best net edge

READY_* + fresh valid S1 signal
  -> PREFLIGHT
       -> EXECUTING          one serial FOK batch
       -> WAIT               signal or balance became stale
       -> SAFE_STOP          any execution ambiguity

EXECUTING
  -> refresh both balances and open orders
  -> CLOSED -> RECONCILING
  -> SAFE_STOP
```

`BOTH_READY` is allowed only when both directions satisfy the full quote/base
requirement. It still submits one batch at a time and picks the higher
risk-adjusted net edge. It never submits both directions concurrently.

## 6. Startup sequence

1. Load `ARB_CONFIG`, the encrypted secret store, and the master key.
2. Validate credential roles and declared withdrawal permissions.
3. Load markets for the whitelisted pairs.
4. Fetch open orders for both venues and the whitelisted symbols.
5. Query every local open execution and unresolved order.
6. Fetch and persist balances for both venues.
7. Reconcile:
   - exchange open order with no local owner -> `SAFE_STOP`;
   - local open execution with no exchange order and no terminal fill ->
     query order history and trades; if still ambiguous -> `SAFE_STOP`;
   - missing or stale balance -> `WAIT`;
   - clean state -> derive inventory state.
8. Persist an audit record with counts and state, but no secrets.
9. Start the supervisor only if the state is not `SAFE_STOP`.

## 7. Runtime sequence

Each loop:

1. Refresh balances when `balance_refresh_ms` has elapsed.
2. Refresh open orders when the open-order interval has elapsed and always
   before a submission.
3. Drop stale scanner signals.
4. Recompute the funded direction from fresh balances.
5. If no funded direction, log `waiting` with the exact missing amounts and
   sleep for `poll_interval_ms`.
6. If a normal S1 candidate exists, evaluate it with the normal net-profit,
   depth, fee, precision, freshness, and balance gates.
7. If no normal candidate exists, evaluate the reversion-preparation path.
8. Before submitting, re-fetch both books and both balances, and query open
   orders for both legs.
9. Submit one serial FOK batch.
10. After each fill, refresh balances and open orders immediately; derive the
    next state from the account, not from an in-memory flag.

## 8. Failure policy

- Balance API failure: do not trade; retry with backoff.
- Open-order query failure: do not trade; retry with backoff.
- Unknown open order: `SAFE_STOP` and set the persisted kill switch.
- Local open execution with unknown fill: `SAFE_STOP`; never retry.
- Partial first leg: `SAFE_STOP`; reconcile before clearing.
- Partial second leg: `SAFE_STOP`; record unhedged inventory.
- Account permission change: `SAFE_STOP`.
- Stale book or stale balance: `WAIT`, not an order.
- Both directions unfunded: `WAIT`; do not force a transfer or a losing trade.

## 9. Configuration

The state machine uses existing values where possible:

```toml
[auto_rotation]
poll_interval_ms = 1000
balance_refresh_ms = 5000
max_signal_age_ms = 10000
cooldown_ms = 0

[auto_rotation.preparation]
enabled = true
max_notional = '10'
min_stable_ms = 30000
```

Add only two operational values for the account-state layer:

```toml
open_orders_refresh_ms = 10000
account_state_stale_ms = 30000
```

These are freshness checks, not opportunity caps. They do not reduce the
number of valid signals; they prevent an order from being submitted against an
unknown account state.

## 10. Observability

Log one JSON event per state transition:

```json
{
  event: account_state,
  pair: TBK/USDT,
  state: READY_GATE_TO_HOT,
  direction: gate->hotcoin,
  gateQuote: ...,
  hotcoinBase: ...,
  openOrders: 0,
  openExecutions: 0,
  unresolvedOrders: 0,
  reason: []
}
```

The dashboard should show the same state, the last balance refresh time, the
last open-order refresh time, and any SAFE_STOP reason. Telegram/Discord alerts
are a separate P1 item.

## 11. Implementation order

1. [x] Add the adapter-level open-order query and tests for Gate and Hotcoin.
2. [x] Add startup reconciliation for exchange open orders.
3. [x] Add the pre-submission open-order check.
4. [x] Add account-state logging and a read-only `account:state` diagnostic.
5. [ ] Add the Windows watchdog/service and heartbeat.
6. [ ] Add permission/account-status checks where the venues expose them.
7. [ ] Keep automatic transfers deferred until the rebalance design is
       separately approved.

## 12. Acceptance criteria

- A cold start with valid credentials reaches `READY_*` or `WAIT` without a
  manual balance command.
- The program logs the exact funded direction and missing amounts.
- An unknown exchange open order blocks all submissions.
- A stale balance or failed balance refresh blocks all submissions.
- After a completed round trip, the next funded direction is derived
  automatically.
- A restart during an open batch either recovers cleanly or enters
  `SAFE_STOP`; it never retries an unknown order.
- No secret, API key, passphrase, or signed request appears in logs or audit
  records.
