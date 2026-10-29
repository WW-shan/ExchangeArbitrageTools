# S1 Two-Sided Inventory Rotation SOP

Status: automatic supervisor implemented and live-tested, 2026-10-29. The first
TBK round trip closed with both FOK legs filled. Manual live entry remains
separately gated.

## 1. What this is

S1 is not a cross-exchange atomic transfer. It is a two-venue inventory
strategy:

```text
state A: Gate USDT + Hotcoin base
  -> buy on Gate, sell on Hotcoin
state B: Gate base + Hotcoin USDT
  -> buy on Hotcoin, sell on Gate
```

After state A, the account is ready for the reverse trade without a
withdrawal. After state B it is ready for the original direction again. This is
the two-sided rotation. A transfer is needed only when the inventory becomes
structurally imbalanced, not after every fill.

Two conditions are mandatory:

1. The buy venue has enough quote.
2. The sell venue has enough base.

If the signal points in the direction that is not funded, skip it. Do not
buy on one venue and wait for a transfer.

## 2. Pair selection

Primary: `LIGHT/USDT`.

Secondary live rotation: `TBK/USDT`. TBK has the highest raw historical episode
count, and the existing inventory now supports the two-sided rotation. It is
outlier-heavy, so it is limited to small batches and a 10% suspicious-spread
cap. The first live TBK round trip is documented in
`docs/s1-tbk-live-rotation-2026-10-29.md`.

Reserve / watch-only: `KAT/USDT`.

Never enable a pair only because its historical median is high. The live book
must show a fresh executable edge after fees, slippage, and live depth.

## 3. Seed inventory

Use one side only. Do not buy base on both venues at the start.

At 10 USDT per leg, choose one of:

```text
Option A: start ready for Gate -> Hotcoin
  Gate:    keep about 10.5 USDT
  Hotcoin: buy about 10 USDT of LIGHT

Option B: start ready for Hotcoin -> Gate
  Gate:    buy about 10 USDT of LIGHT
  Hotcoin: keep about 10 USDT
```

Seed rules:

- Order by base quantity, not by spending all quote. A quote-sized market buy
  produces an arbitrary fractional base amount.
- Align the base quantity to the venue step.
- Record the gross fee, net base, and residual dust in the seed audit.
- Start with 10 USDT. Increase to 20 only after clean round trips.
- Do not seed by unbounded market order while the book is wide. Use a bounded
  FOK limit order, or wait for a calm book.

The first 2026-10-29 seed used 37.5 LIGHT on Hotcoin at 0.26596, leaving the
account ready for Gate -> Hotcoin.

The first TBK rotation used existing inventory instead of a new seed:

```text
before: Gate 39.9604 TBK + Hotcoin 9.707534 USDT
trade:  Hotcoin buy 39 TBK at 0.22799, Gate sell 39 TBK at 0.23346
after:  Gate 0.9604 TBK + Hotcoin 39.836 TBK
state:  Gate USDT + Hotcoin TBK, ready for Gate -> Hotcoin
```

## 4. Signal and entry gate

The scanner evaluates both directions on every fresh book, using WebSocket
updates when available and REST fallback for thin markets:

```text
net = executable sell proceeds
      - executable buy cost
      - gross fees
      + accrued rebate
      - slippage and safety buffer
```

Entry requires all of:

- pair in the rotation whitelist;
- books within the configured received-at and exchange-timestamp windows;
  the live low-liquidity profile uses 5 seconds for WebSocket freshness and
  20 seconds for the exchange timestamp, with pair skew up to 5 seconds;
- buy and sell depth each cover the planned base amount;
- expected net profit above the live threshold;
- buy venue quote and sell venue base confirmed by a fresh private balance read;
- post-fill quantity remains aligned to the venue steps for future sells;
- no open batch, unknown order, balance mismatch, or kill switch;
- per-venue execution flag enabled;
- daily loss and consecutive-loss limits not reached.

Residual step fragments are recorded in the audit but are not a pair-selection
filter; every low-priced symbol can produce them after a base-charged fee.

### 4.1 Reversion preparation

When no normal S1 edge is available and the funded direction returns to near
breakeven, the supervisor may submit a small preparation trade to shift
inventory to the opposite side. This is allowed only for a direction with a
positive historical calibration. It is not a promise that the reverse spread
will return.

The current calibration allows `TBK/USDT|gate->hotcoin` in the 5 bps band and
`TBK/USDT|hotcoin->gate` in the 12 bps band. LIGHT fails the conditional
reverse-probability or expected-value gate in both bands. Details, formulas,
and the exact backtest result are in
`docs/s1-reversion-preparation-2026-10-29.md`.

There is no separate fixed cost cap. The allowed cost is the calibration-derived
break-even cost, converted to USDT in proportion to the selected notional. A
larger notional therefore gets a proportionally larger USDT allowance; the
basis-point limit does not change. The calibration band is not a policy cap:
it records the cost range in which the probability was actually measured.

There is no daily preparation count cap and no preparation cooldown. Every
repeat must pass a fresh calibration, expected-value, and per-trade cost check.
If the reverse edge never appears, the supervisor logs `preparation_carrying`,
keeps waiting, and does not force a losing exit.

### 4.2 Automatic inventory seeding

If neither direction is funded because one side lacks base, the supervisor can
submit one small FOK buy as a `SEED` execution. This is inventory preparation,
not arbitrage profit.

Rules:

- normal S1 and calibrated preparation are checked first;
- both venue books must be fresh and valid;
- the candidate ask must remain within `max_price_drift_bps` for
  `min_stable_ms`;
- both sides missing: buy the cheaper ask;
- one side missing: buy the missing side only when it is cheaper or within
  `max_pair_deviation_bps` of the other ask;
- spend no more than `seed_notional_usd`, preserve `min_quote_reserve_usd`, and
  require the resulting base value to reach `min_useful_notional_usd`;
- use a FOK limit at the worst executable ask, never an unbounded market order.

The live profile uses 5 USDT, a 5 USDT reserve, a 3 USDT useful floor and a 30
bps near-parity band. A full fill closes the `SEED` execution and records the
inventory delta. A definitive no-fill is `SEED_REJECTED`. A partial or unknown
fill opens the kill switch and must be reconciled manually; unknown submissions
are never retried. See `docs/s1-automatic-inventory-2026-10-30.md`.

## 5. Order execution

Keep serial FOK as the default:

1. Fetch both books concurrently.
2. Re-evaluate depth, fees, rebate accrual, and dust.
3. Submit leg 1 on the buy venue with a limit price equal to the worst
   executable ask and FOK.
4. Reconcile the actual fill from the order and the balance delta.
5. Re-fetch the sell book.
6. Align the sell quantity to the sell venue step.
7. Submit leg 2 with FOK at the worst executable bid.
8. Reconcile both legs and the final balances.
9. Update the rotation state from balances, not from an in-memory flag.

Do not use an unbounded market order. It has no worst-price protection and is
dangerous on the low-volume side.

If leg 1 fills and leg 2 cannot, the batch is a long-inventory event. Enter
SAFE_STOP, keep the kill switch on, and reconcile before the next attempt. Do
not assume the spread will revert.

## 6. Rotation state

Derive the state from free balances:

```text
LONG_HOT: Gate quote >= N and Hotcoin base >= sell lot
LONG_GATE: Hotcoin quote >= N and Gate base >= sell lot
WAIT: neither side is fully funded
BLOCKED: both sides incomplete or dust above limit
```

Only the ready direction may trade. If the market offers the opposite
direction, wait. This is the cost of avoiding transfers.

After a fill, refresh both balances before evaluating the next opportunity.
The next eligible direction is normally the reverse one. A same-direction
signal is skipped until the inventory is replenished.

If the account stays one-sided for more than the configured holding window,
stop trading and review. Do not force a reverse trade at a negative edge. A
repeat preparation is allowed only when it passes a fresh expected-value and
cost check.

## 7. Automatic execution phases

### Phase 0: read-only

- Scanner and balance refresher run continuously.
- Supervisor prints WOULD_BUY, WOULD_SELL, WAIT, or BLOCKED.
- No private order endpoint is called.

### Phase 1: manual live

- Seed one side with a bounded order.
- Execute 10 manually confirmed round trips.
- Require 100% clean reconciliation, zero unknown orders, and dust below the
  pair limit.

### Phase 2: supervisory auto

- Auto-submit only when the rotation state is ready.
- Keep manual confirmation available as a kill path.
- Keep one batch in flight; preparation has no artificial cooldown, but every
  repeat must pass a fresh gate.
- Stop after three consecutive losses or any unknown order.

### Phase 3: unattended

The current account runs the supervisor unattended after the one-time seed.
Any SAFE_STOP sets the persisted kill switch and requires reconciliation before
the operator clears it.

## 8. Stop conditions

Enter SAFE_STOP and set the persisted kill switch on when any of these occurs:

- unknown fill or cancel state;
- partial leg 1 with unconfirmed cancel;
- leg 2 rejection or partial fill;
- balance mismatch after reconciliation;
- book stale, crossed, or pair skew too high at submission;
- exchange open-order query fails or returns an order not owned by the current
  batch;
- API permission, withdrawal, or account-status change;
- daily loss or consecutive-loss limit;
- two venues disagree about symbol or base identity.

No automatic retry after an unknown order. Reconcile from order history,
trades, and balances first.

## 9. No automatic transfer

The rotation is designed to avoid transfers. LIGHT and TBK are both available
on Gate and Hotcoin, and TBK is active in the live rotation. KAT remains
watch-only and has restricted Hotcoin deposit/withdrawal routes. Transfers are
unnecessary for the normal rotation and would be expensive relative to a
10-20 USDT batch. Therefore:

- do not withdraw as part of the per-trade path;
- do not auto-transfer to fix a normal directional wait;
- only use the separate transfer service with an allowlist, explicit
  confirmation, and measured arrival evidence;
- if a transfer is needed, stop the rotation and treat it as an inventory
  rebalance, not as an arbitrage leg.

## 10. Current implementation status

Implemented and wired:

1. `assessRotationReadiness` derives the funded direction from fresh balances.
2. `planRotationSeed` sizes the one-time seed by base quantity.
3. `apps/executor/src/auto-supervisor.ts` implements the whitelist, one-batch,
   automatic-confirmation gate, balance refresh, and SAFE_STOP flow.
4. `scripts/seed-rotation.ts` performs the bounded one-time seed.
5. `scripts/start-rotation.ps1` starts the scanner and supervisor together.
6. `apps/scanner/src/preparation-backtest.ts` calibrates conditional reverse
   probability and expected value; `config/s1-prep-calibration.json` is loaded
   by the executor.

The remaining limitation is market-driven: each pair must show a fresh
executable edge in the direction that is currently funded. The supervisor waits
when it does not. On 2026-10-29 the TBK `Hotcoin -> Gate` direction met the
condition and closed at `0.20706918882 USDT` economic profit.
