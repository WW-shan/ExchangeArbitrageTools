# S1 Two-Sided Inventory Rotation SOP

Status: design baseline, 2026-10-29. Live order submission remains disabled.

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

Primary: `KAT/USDT`.

Secondary: `LIGHT/USDT`, only after KAT has a clean soak.

Watch-only: `ULTIMA/USDT`, because its current 20 USDT fee dust is larger than
the expected edge. See `docs/s1-rotation-backtest-2026-10-29.md`.

Never enable a pair only because its historical median is high. The live book
must show a fresh executable edge after fees, slippage, and dust.

## 3. Seed inventory

Use one side only. Do not buy base on both venues at the start.

At 10 USDT per leg, choose one of:

```text
Option A: start ready for Gate -> Hotcoin
  Gate:    keep about 10.5 USDT
  Hotcoin: buy about 10 USDT of KAT

Option B: start ready for Hotcoin -> Gate
  Gate:    buy about 10 USDT of KAT
  Hotcoin: keep about 10 USDT
```

At the current balances, Option A fits better because Hotcoin already holds
about 19.69 USDT while Gate holds about 10.51 USDT.

Seed rules:

- Order by base quantity, not by spending all quote. A quote-sized market buy
  produces an arbitrary fractional base amount.
- Align the base quantity to the venue step.
- Record the gross fee, net base, and residual dust in the seed audit.
- Start with 10 USDT. Increase to 20 only after 20 clean round trips and a
  verified dust balance.
- Do not seed KAT by market order while the book is wide. Use a post-only or
  bounded limit order, or wait for a calm book.

## 4. Signal and entry gate

The scanner evaluates both directions on every fresh WebSocket book:

```text
net = executable sell proceeds
      - executable buy cost
      - gross fees
      + accrued rebate
      - slippage and safety buffer
      - dust reserve
```

Entry requires all of:

- pair in the rotation whitelist;
- fresh books within 2 seconds, pair skew within 1 second;
- buy and sell depth each cover the planned base amount;
- expected net profit above the live threshold;
- buy venue quote and sell venue base confirmed by a fresh private balance read;
- post-fill residual is zero or a legal future lot;
- residual dust value at or below `max_dust_usd`;
- no open batch, unknown order, balance mismatch, or kill switch;
- per-venue execution flag enabled;
- daily loss and consecutive-loss limits not reached.

For LIGHT, raise the threshold above KAT because its historical stress pass
rate is lower.

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
stop trading and review. Do not force a reverse trade at a negative edge.

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
- Keep one batch in flight and a per-pair cooldown.
- Stop after three consecutive losses or any unknown order.

### Phase 3: unattended

Only after 24 hours of stable read-only capture and 50 clean automated
batches. This phase is not enabled by this design.

## 8. Stop conditions

Enter SAFE_STOP and set the persisted kill switch on when any of these occurs:

- unknown fill or cancel state;
- partial leg 1 with unconfirmed cancel;
- leg 2 rejection or partial fill;
- balance mismatch after reconciliation;
- dust above the pair limit;
- book stale, crossed, or pair skew too high at submission;
- API permission, withdrawal, or account-status change;
- daily loss or consecutive-loss limit;
- two venues disagree about symbol or base identity.

No automatic retry after an unknown order. Reconcile from order history,
trades, and balances first.

## 9. No automatic transfer

The rotation is designed to avoid transfers. KAT has restricted Hotcoin
deposit/withdrawal routes; LIGHT transfers are expensive relative to a
10-20 USDT batch. Therefore:

- do not withdraw as part of the per-trade path;
- do not auto-transfer to fix a normal directional wait;
- only use the separate transfer service with an allowlist, explicit
  confirmation, and measured arrival evidence;
- if a transfer is needed, stop the rotation and treat it as an inventory
  rebalance, not as an arbitrage leg.

## 10. Current gap

The scanner and manual executor already support the two legs, but the
automated rotation supervisor is not yet enabled. Before it can run live it
needs:

1. the pure `packages/core/src/rotation.ts` readiness/seed planner now exists;
   the persisted supervisor still needs to call it before every batch;
2. the fee-charge-asset and dust preflight described above;
3. a supervisor loop with per-pair whitelist and auto-confirm switch;
4. a 24-hour read-only soak and a fresh 15-minute live capture;
5. user-funded seed inventory on exactly one side.

Until those are complete, automatic order submission must remain off.
