# Automated Inventory Transfer Design

Status: implementation baseline for 2026-10-27.

This document defines the automated inventory-transfer loop for S1 between
Gate.io and Hotcoin. It is deliberately separate from the S1 order executor.
The order executor performs the two trading legs; this service restores the
inventory needed for the next opportunity.

## 1. Goal and non-goals

### Goal

Given a target free balance per venue and asset, the service must:

1. read fresh balances and compute the required transfers;
2. validate both the source withdrawal and the destination deposit address;
3. submit one withdrawal, observe the source withdrawal record, and confirm the
   matching destination deposit record;
4. move on to the second direction only after the first direction has arrived;
5. persist enough evidence to reconstruct every decision and transfer.

The normal S1 inventory loop is:

```text
target inventory -> buy on venue A -> sell on venue B
-> inventory offset -> automated transfer -> target inventory restored
```

The loop may need two transfer directions in one batch:

```text
Gate.io   --base-->  Hotcoin    (restore the sell-leg base)
Hotcoin   --quote--> Gate.io    (restore the buy-leg quote)
```

### Non-goals

- A cross-exchange transfer is **not atomic**. The implementation never claims
  that both withdrawals succeed or fail together.
- The service does not prove that a spread will converge. It only restores the
  inventory required to attempt an independently discovered S1 opportunity.
- The service does not bypass exchange address allowlists, 2FA, email
  confirmation, risk review, or withdrawal limits.
- A source-side `Completed` status is not treated as destination arrival.
  Arrival requires a matching destination deposit record.
- The service never re-submits a withdrawal after an unknown result.

## 2. Scope

### First route

The first supported pair is:

- Gate.io (CCXT exchange id `gate`)
- Hotcoin (native adapter)
- spot assets quoted in USDT
- matching networks when both venues expose the same chain (BSC/BEP20 is preferred for speed, but never assumed)

Network selection is per asset. The adapter compares the live
`fetchCurrencies()` result and the destination deposit address before creating a
withdrawal. As of 2026-10-28, Gate's live public currency data lists `INC` only
on ERC20, `TBK`/`HTX` only on TRC20, and `CAKE`/`ETH`/`USDT` on BSC/BEP20.
Therefore an `INC/BSC` allowlist entry is invalid for Gate even if the two
venues both list INC. The first live route must be an asset/network pair that
both venues actually expose.

The route is data-driven. Adding another pair requires an allowlist entry and
adapter support; it does not change the state machine.

### Transfer quantities

The planner works with same-asset transfers only. It does not swap one asset
into another. Quote restoration is therefore planned in USDT, and base
restoration in the traded base asset.

## 3. Safety model

Automated withdrawal is a higher privilege than trading. The following
controls are mandatory:

1. `transfers.enabled` defaults to `false`.
2. `execution.live_enabled` defaults to `false` and `execution.kill_switch`
   defaults to `true`.
3. The existing `read_only` and `trade` credentials keep
   `withdrawalPermission=false`.
4. A separate `withdrawal` credential is required. It must:
   - declare `withdrawalPermission=true`;
   - be a different API key from the venue's trade key;
   - declare `ipWhitelistVerified=true` (operator attestation);
   - have the minimum exchange permissions and IP allowlist.
5. A destination address is used only when all of the following match:
   - the configured allowlist entry;
   - the destination venue's live deposit-address response;
   - normalized network;
   - normalized address (EVM addresses are case-insensitive);
   - address tag/memo exactly;
   - the allowlist entry's asset and direction.
6. Each allowlist entry has `min_amount`, `max_amount`, and
   `daily_max_amount`.
7. At most one transfer batch may be in flight, and at most two legs may be
   planned in a batch.
8. A live batch requires an explicit `--execute` and
   `--confirm-batch <batch-id>`.
9. If a withdrawal result is unknown, the batch enters `SAFE_STOP` and no
   retry is attempted. The operator must reconcile with the exchange UI/API.
10. The next leg is not submitted until the previous leg is confirmed as
    arrived at the destination.

## 4. Credentials and adapter capabilities

### Credential roles

```text
read_only : balances, deposit history, optional deposit address
trade     : orders only; cannot withdraw
withdrawal: withdrawals and their history; separate key
```

The secret store remains encrypted with scrypt + AES-256-GCM. It still prints
only fingerprints. The new role is not a permission escalation of an existing
trade key.

### Adapter surface

The CEX adapter gains the following optional methods:

```ts
fetchDepositAddress(currency, network, keys): Promise<DepositAddress>
fetchDeposits(query, keys): Promise<TransferRecord[]>
fetchWithdrawals(query, keys): Promise<TransferRecord[]>
createWithdrawal(request, keys): Promise<WithdrawalSubmission>
```

Capabilities expose these independently:

```ts
(depositAddress, depositHistory, withdrawalHistory, createWithdrawal);
```

Read-only and trade adapters must report `createWithdrawal=false`, even when
the underlying exchange library technically exposes a withdraw method.

### Gate.io mapping

CCXT 4.5.89 / Gate exposes:

- `fetchDepositAddress(code, { network })`
- `fetchDeposits(code, since, limit, params)`
- `fetchWithdrawals(code, since, limit, params)`
- `withdraw(code, amount, address, { network, tag })`

Gate's CCXT deposit-address selector is indexed by unified network code
(`BEP20`), not the raw chain id (`BSC`). The adapter translates the normalized
transfer network back to `BEP20` before calling CCXT; withdraw responses are
normalized back to the same transfer-network alias.

The adapter normalizes CCXT transaction statuses:

```text
ok/completed/success -> completed
pending/new          -> pending
processing           -> processing
canceled/revoked     -> canceled
failed/rejected      -> failed
anything else        -> unknown
```

### Hotcoin mapping

Official API additions dated 2025-07-02:

```text
GET  /v1/asset/deposit/address
GET  /v1/asset/deposit/history
GET  /v1/asset/withdrawal/address
POST /v1/asset/withdrawal/apply
POST /v1/asset/withdrawal/cancel
GET  /v1/asset/withdrawal/history
```

Deposit history statuses:

```text
0-confirming -> pending
3-completed  -> completed
4-failed     -> failed
5-risk frozen-> failed
```

Withdrawal history statuses:

```text
1-pending, 2-processing, 5-processing -> pending/processing
3-completed -> completed
4-revoked   -> canceled
6-remitted  -> processing (not arrival)
7-rejected, 8-failed -> failed
```

Hotcoin requires `XH-PASSPHRASE` on the withdrawal-apply endpoint. The
adapter uses the existing signed-query implementation and does not put secrets
in logs.

Hotcoin does not currently expose a public currency-network metadata method in
this adapter. Source withdrawal enablement, minimum amount and fee therefore
cannot all be re-read from Hotcoin at preflight time. The allowlist fee and
manual checks are mandatory, and the destination deposit address is still
validated live.

## 5. Planning

The operator supplies target free balances, for example:

```text
gateio:CAKE=40,hotcoin:CAKE=40,gateio:USDT=100,hotcoin:USDT=100
```

`CAKE` is only a structural example. Replace it with the traded base after
checking the destination venue's live deposit address and network.

The planner:

1. loads balances no older than `max_balance_age_ms`;
2. applies the existing same-asset `planRebalance` algorithm;
3. maps each transfer direction to one allowlist entry;
4. rejects the batch if any direction has no allowlist entry;
5. validates `min_amount`, `max_amount`, and `daily_max_amount`;
6. writes a `PLANNED` batch with one row per direction.

The persisted plan contains the target snapshot and the allowlist identity used
at planning time. Live execution re-reads the allowlist and destination address;
config drift blocks the batch instead of silently using a new address.

## 6. State machine

### Batch

```text
PLANNED
  -> READY
  -> EXECUTING
  -> COMPLETED

PLANNED -> BLOCKED
READY   -> BLOCKED
EXECUTING -> SAFE_STOP
EXECUTING -> DRY_RUN
SAFE_STOP -> (operator reconciliation only)
```

### Leg

```text
PLANNED
  -> READY
  -> WITHDRAWING
  -> WITHDRAWN
  -> WAITING_DEPOSIT
  -> ARRIVED

PLANNED -> BLOCKED
WITHDRAWING -> WITHDRAW_FAILED
WITHDRAWING -> UNKNOWN
WAITING_DEPOSIT -> DEPOSIT_TIMEOUT
WAITING_DEPOSIT -> DEPOSIT_FAILED
```

`ARRIVED` means a destination deposit record matched the source withdrawal's
transaction id and the configured destination address/network. It does not
mean that the source record's `Completed` status alone was accepted.

## 7. Execution sequence

For each leg, in leg order:

1. Re-read the source free balance; do not trust the planning-time snapshot.
2. Re-read the destination deposit address; compare it with the allowlist.
3. Re-read the source withdrawal settings (fee, minimum, enabled) when the
   adapter exposes them. If they are unavailable, a configured reserve is
   required for live execution.
4. Check the daily amount and in-flight batch limits.
5. Submit exactly one withdrawal with a stable local leg id.
6. Persist the source record id before polling. If the submission is ambiguous,
   mark `UNKNOWN` and `SAFE_STOP`; never re-submit.
7. Poll source withdrawal history until `completed`, `failed`, or timeout.
8. Require a transaction id. Poll destination deposit history by that tx id.
9. Persist the destination record and mark `ARRIVED` only on a matching
   completed deposit.
10. Continue with the next leg only after `ARRIVED`.

After all legs are `ARRIVED`, the batch is `COMPLETED`.

## 8. Failure handling

| Failure                                  | Batch                                             | Leg             | Action                                         |
| ---------------------------------------- | ------------------------------------------------- | --------------- | ---------------------------------------------- |
| allowlist missing or changed             | BLOCKED                                           | BLOCKED         | no withdrawal                                  |
| destination address mismatch             | BLOCKED                                           | BLOCKED         | no withdrawal                                  |
| insufficient source balance              | BLOCKED before first leg; SAFE_STOP after one leg | BLOCKED/UNKNOWN | no further withdrawal                          |
| withdrawal request throws                | SAFE_STOP                                         | UNKNOWN         | reconcile only; no retry                       |
| withdrawal response has no id            | SAFE_STOP                                         | UNKNOWN         | query history by amount/address/time; no retry |
| source reports failed/canceled           | SAFE_STOP                                         | WITHDRAW_FAILED | no further withdrawal                          |
| source completed but no tx id            | SAFE_STOP                                         | WAITING_DEPOSIT | manual reconciliation                          |
| destination deposit not found by timeout | SAFE_STOP                                         | DEPOSIT_TIMEOUT | query only; no retry                           |
| destination deposit failed               | SAFE_STOP                                         | DEPOSIT_FAILED  | manual reconciliation                          |
| daily cap or in-flight cap reached       | BLOCKED                                           | BLOCKED         | no withdrawal                                  |

All failures are written to `risk_events` and `audit_logs`.

## 9. Persistence

Migration v8 adds:

### `transfer_batches`

```text
id, status, plan_json, confirmation, dry_run, safe_mode_reason,
created_at, updated_at
```

### `transfer_legs`

```text
id, batch_id, leg_number, from_venue, to_venue, asset, network,
amount, fee, address, address_tag, status,
source_record_id, source_tx_id,
destination_record_id, destination_tx_id,
requested_at, source_observed_at, destination_observed_at,
error, metadata_json, updated_at
```

`source_record_id` and `destination_record_id` are exchange record ids, not
local ids. The local leg number is unique within a batch.

## 10. CLI and configuration

### CLI

```text
npm run rebalance:execute -- --targets ...
npm run rebalance:execute -- --batch <id> --preflight
npm run rebalance:execute -- --batch <id> --reconcile
npm run rebalance:execute -- --batch <id> --execute --confirm-batch <id>
```

`--targets` only creates a plan. It cannot submit a withdrawal.

### Configuration

```toml
[transfers]
enabled = false
require_manual_confirmation = true
max_in_flight_batches = 1
max_legs_per_batch = 2
max_balance_age_ms = 300000
poll_interval_ms = 15000
withdrawal_timeout_ms = 900000
deposit_timeout_ms = 1800000

[[transfers.allowlist]]
from_venue = "gateio"
to_venue = "hotcoin"
asset = "CAKE"
network = "BSC"
address = "0x..."
address_tag = ""
# Optional when the venue withdrawal endpoint requires a chain-qualified code.
venue_currency = "CAKE(BSC)"
min_amount = "15"
max_amount = "200"
daily_max_amount = "400"
withdraw_fee = "1"

[[transfers.allowlist]]
from_venue = "hotcoin"
to_venue = "gateio"
asset = "USDT"
network = "BSC"
address = "0x..."
address_tag = ""
min_amount = "10"
max_amount = "200"
daily_max_amount = "400"
withdraw_fee = "1"
```

`withdraw_fee` is a conservative reserve used to confirm that the source free
balance also covers the fee. It must be verified against the venue UI/API
before live use.

## 11. Acceptance criteria

| ID   | Requirement                                                              | Test / evidence                |
| ---- | ------------------------------------------------------------------------ | ------------------------------ |
| T-1  | All monetary amounts use Decimal                                         | type review and transfer tests |
| T-2  | Trade/read-only keys cannot withdraw                                     | secret-store tests             |
| T-3  | Withdrawal key must be separate and IP-whitelisted                       | secret-store tests             |
| T-4  | Destination address must match allowlist and live response               | preflight tests                |
| T-5  | Network aliases match only when safe                                     | network tests                  |
| T-6  | Unknown withdrawal result becomes SAFE_STOP, never retried               | transfer-service test          |
| T-7  | Second leg waits for first leg arrival                                   | two-leg test                   |
| T-8  | Source completion alone is insufficient                                  | arrival test                   |
| T-9  | Batch and leg states are persisted atomically                            | repository tests               |
| T-10 | Cumulative daily caps are enforced across legs in one batch              | planning/preflight tests       |
| T-11 | Gate methods are normalized from CCXT transactions                       | CCXT adapter tests             |
| T-12 | Hotcoin methods sign and parse official payloads                         | Hotcoin adapter tests          |
| T-13 | `enabled=false`, `kill_switch=true`, manual confirmation remain defaults | config tests                   |
| T-14 | Dry-run/preflight performs no withdrawal call                            | transfer-service test          |
| T-15 | One atomic execution claim prevents two processes from submitting        | migration v9; lease tests      |
| T-16 | Preflight cannot overwrite an executing batch                            | atomic preflight tests         |
| T-17 | Source withdrawal record identity is rechecked                           | transfer-service test          |
| T-18 | Withdrawal/deposit timeouts are independent; stale balances are not zero | timeout/stale-balance tests    |
| T-19 | Gate BSC maps to CCXT BEP20 and live network data is checked             | adapter tests; live probe      |

## 12. Live rollout

### Phase A: local/mock

- All tests pass.
- No withdrawal credentials are required.
- The batch can be planned and dry-run with mock adapters.

### Phase B: read-only venue verification

- Add separate withdrawal keys with no IP mismatch.
- Fetch both deposit addresses; compare against allowlist.
- Fetch both currency networks and withdrawal fees where the venue exposes
  them; otherwise require manual attestation and a configured fee.
- Do not submit a withdrawal.

### Phase C: one-leg live test

- Use the smallest allowed amount.
- Execute one leg only.
- Confirm source withdrawal id, tx id, destination deposit id, received
  amount, fee, and elapsed time.

### Phase D: two-leg loop

- Enable the second direction only after Phase C succeeds.
- Run one two-leg batch under operator supervision.
- The second leg must wait for the first leg's `ARRIVED` state.

### Phase E: automation

- Only after repeated supervised batches, schedule the command.
- Keep `max_in_flight_batches=1`, allowlist checks, caps, and manual
  confirmation for the first automation window.

## 13. Known external prerequisites

- Withdrawal-enabled API keys for Gate.io and Hotcoin, separate from trade
  keys, with IP allowlist.
- Hotcoin API passphrase.
- Verified deposit addresses for the exact asset/network pair on both venues.
- Verified withdrawal fee and minimum for each asset/network.
- Confirmation that both venues still support the exact asset contract on that
  network (BSC is not valid for Gate INC/TBK/HTX as of 2026-10-28).
- A small funded test balance.

Until these are supplied, the implementation remains in mock/preflight mode.
