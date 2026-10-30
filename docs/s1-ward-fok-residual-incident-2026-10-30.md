# S1 WARD FOK Residual Incident — 2026-10-30

## Summary

`execution 31` bought WARD on Gate.io but the Bitget sell leg did not fill.
The incident was not caused by missing Bitget inventory and it was not an
automatic SEED. It was a normal S1 batch whose sell-side liquidity disappeared
between the executor's book snapshot and FOK submission.

The failed automatic residual hedge (`execution 32`) was a separate defect:
Gate rejected the hedge `clientOrderId` before submission because it exceeded
28 characters. The executor recorded that definitive rejection as `HEDGE_UNKNOWN`.

## Execution 31 evidence

```text
batchId        S1-755006-1793321780763
status         REDUCED / RECONCILED
Gate buy       1392 WARD @ 0.003762, filled 1392
Gate fee       1.37808 WARD
Bitget sell    1392 WARD @ 0.003784, filled 0, canceled (normal_cancel)
Bitget WARD    3972.41584 before and after the batch
net long       1390.62192 WARD
```

The Bitget book at preflight showed 20 bid levels of roughly 416 WARD each at
`0.003787` down to `0.003768`. That is more than enough nominal depth for 1392
WARD. By the time the FOK order reached Bitget, those equal-sized levels had
been withdrawn. FOK requires the full amount, so Bitget canceled the whole
sell order instead of filling a partial amount.

This was not a SEED top-up. The last actual WARD seed on Bitget was
`execution 16`, when Bitget held only `24.5369` WARD. Its balance stayed at
`3972.41584` through execution 31.

## Execution 32 evidence

```text
clientOrderId  HEDGE-S1-755006-1793321780763-1793321786338-H1
Gate response  clientOrderId or text param must be up to 28 characters
actual order   none
```

The request never reached the exchange order book. The original implementation
treated any create-order exception as an ambiguous submission and persisted
`HEDGE_UNKNOWN`, which blocked the kill-switch release until manual
reconciliation.

## Reconciliation

- The replacement hedge client id is `HD-<base36-time>-<8 hex>`, at most 28
  characters including the prefix.
- A historical `HEDGE_UNKNOWN` can now be closed as `HEDGE_REJECTED` only when
  order lookup reports an invalid/not-found client id, both venues report no
  open orders, and the base/quote balances still match the pre-hedge baseline.
- `execution 32` was reconciled with no order and no balance delta.
- The real 1390 WARD residual from execution 31 was sold with a fresh FOK at
  `0.003601`. The realized loss was `-0.233927354498214232089768871182470645939`
  USDT. The original execution is `RECONCILED`; the unhedged row is closed.

## Timing evidence

Recent S1 batches took approximately:

```text
signalAgeMs    2.1s - 2.9s
bookFetchMs    0.8s - 1.5s
preflightMs    1.4s - 2.0s
```

The private balance/open-order checks dominate the critical path. Scanner and
executor both sit behind a proxy in this environment. The failed batch had
`signalAgeMs=2947`, `bookFetchMs=906`, and `preflightMs=1471`.

The depth wall was visible only about 0.6 seconds before submission. A larger
nominal depth multiplier would not have prevented this failure because the
wall itself was pulled. The useful direction is to shorten the private
preflight path without reusing stale balances as reconciliation baselines.

## Inventory fixes

Two additional defects were found while validating the incident:

1. CCXT returns only non-zero assets. `balanceView` previously required both
   the base and quote rows, so a zero-balance coin looked like a missing
   snapshot forever. Missing currencies are now treated as zero when the venue
   returned a complete balance response.
2. When both sides lacked base inventory, the planner selected the cheaper
   venue even if that venue had no quote to buy with. It now chooses a funded
   venue when the price difference is inside `max_pair_deviation_bps`, and
   otherwise waits instead of buying the expensive side.

## Current live constraints

- At the time of this record, Gate held about `8.3 USDT` and Bitget about
  `0.09 USDT`. A positive `Bitget buy -> Gate sell` WARD spread therefore
  collapses to about `0.09 USDT` of executable notional and cannot meet the
  minimum order/profit floor.
- The opposite `Gate buy -> Bitget sell` direction was negative for more than
  five minutes.
- WEEX repeatedly showed positive spreads, but it remains public-monitor-only
  because no WEEX trade credentials are configured.

## Remaining work

- Build a fail-closed fast preflight path using freshly stamped shared balance
  and open-order snapshots; do not use cached balances as fill baselines.
- Decide whether to fund Bitget with a small USDT reserve so both directions
  can be captured, or add WEEX trade credentials.
- Keep FOK as the default. IOC partial fills would reduce residual size but
  create dust and split-fill accounting on every thin-book failure.
