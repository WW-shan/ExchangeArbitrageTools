# CEX Execution State Machine and Risk Control

## MVP execution scope

Only S1 CEX-CEX spot arbitrage is live-enabled.

Initial limits:

```text
max_order_notional = 30 USDT
daily_max_loss = 20 USDT
max_open_batches = 1
min_net_profit_bps = 20
max_stale_orderbook_ms = 3000
max_slippage_bps = 50
kill_switch_default = ON
```

All live orders require manual confirmation until the system has completed at least 20 successful paper batches and 10 successful manually confirmed live batches.

## Batch state machine

```text
IDLE
  v
OPPORTUNITY_FOUND
  v
PREFLIGHT_CHECK
  v
LEG1_SUBMITTING
  v
LEG1_RECONCILING
  v
HEDGE_DECISION
  v
LEG2_SUBMITTING
  v
LEG2_RECONCILING
  v
CLOSED
```

## Exception states

```text
PREFLIGHT_FAILED
LEG1_REJECTED
LEG1_PARTIAL
LEG1_UNKNOWN
LEG2_REJECTED
LEG2_PARTIAL
LEG2_UNKNOWN
BALANCE_MISMATCH
SAFE_STOP
```

## State definitions

### IDLE

No active batch. Scanner may propose opportunities.

### OPPORTUNITY_FOUND

A valid opportunity passes all cost and freshness checks.

No API trading action occurs in this state.

### PREFLIGHT_CHECK

Before submission:

1. Refresh both order books.
2. Refresh balances on both venues.
3. Verify precision and minimum order rules.
4. Recalculate executable depth.
5. Recalculate conservative profit.
6. Verify no unresolved orders.
7. Verify only one active batch.
8. Verify venue health is A.
9. Verify API keys are valid.
10. Verify daily loss limit is not breached.
11. Verify kill switch is off.
12. Persist the planned batch and both legs.

If any check fails, transition to `PREFLIGHT_FAILED`.

### LEG1_SUBMITTING

Submit the first leg as IOC or FOK where supported.

- Buy limit price = worst executable ask price.
- Requested quantity is calculated from configured notional and precision rules.
- Record request, response, and latency.
- Set a submission timeout.

Possible transitions:

- `LEG1_RECONCILING`
- `LEG1_REJECTED`
- `LEG1_UNKNOWN`

### LEG1_RECONCILING

The exchange response is not treated as proof of fill.

Reconcile:

1. Query order by exchange order ID or client order ID.
2. Read filled amount, average price, and fee.
3. Query user trades if available.
4. Compare with balance changes when possible.
5. Persist the reconciled state.

Possible transitions:

- `HEDGE_DECISION` if filled amount is valid and positive.
- `LEG1_PARTIAL` if partially filled.
- `LEG1_UNKNOWN` if state cannot be resolved.
- `CLOSED` if filled amount is zero and no open quantity remains.

### HEDGE_DECISION

Determine second-leg quantity.

```text
leg2 quantity = leg1 actual filled base amount, adjusted to venue precision
```

Rules:

- Never use requested quantity for the second leg.
- Never round up.
- If rounded quantity is below minimum order, transition to `LEG1_PARTIAL`.
- If profit after actual first-leg fill is no longer positive, enter safe unwind workflow rather than automatically hedging.

### LEG2_SUBMITTING

Submit the second leg as IOC or FOK where supported.

- Sell limit price = worst executable bid price.
- Quantity equals reconciled first-leg fill.
- Record request, response, and latency.

Possible transitions:

- `LEG2_RECONCILING`
- `LEG2_REJECTED`
- `LEG2_UNKNOWN`

### LEG2_RECONCILING

Query order and trades to establish actual fill.

Possible final states:

- `CLOSED`
- `LEG2_PARTIAL`
- `LEG2_UNKNOWN`

### CLOSED

Batch is complete and all ledger entries are written.

Record:

- gross spread
- fees
- actual fill prices
- realized net profit
- inventory delta
- latency
- exchange errors

## Unknown submission handling

A request timeout, connection reset, or ambiguous response means the order may exist at the exchange.

Required behavior:

1. Mark leg as `UNKNOWN`.
2. Do not submit another order.
3. Do not switch API keys and retry.
4. Do not automatically cancel unless the query path is reliable and idempotent.
5. Query by client order ID or exchange order ID.
6. Persist every query response.
7. Enter safe mode.
8. Require manual resolution.

Safe mode blocks:

- new batches
- duplicate submissions
- automatic rebalancing
- automatic retries

## Partial fill handling

### First leg partial

If remaining first-leg quantity cannot be canceled reliably:

1. Enter safe mode.
2. Wait for reconciliation.
3. Do not hedge an amount larger than actual fill.

If the remaining order is reliably canceled:

1. Cancel remaining quantity.
2. Wait for final order state.
3. Hedge only actual filled quantity.
4. If filled quantity is below the second venue minimum, enter safe mode.

### Second leg partial

1. Cancel remaining quantity if reliable.
2. Record unhedged inventory.
3. Do not automatically buy more inventory.
4. Mark batch as `LEG2_PARTIAL`.
5. Require manual or rule-based inventory rebalance.

## Risk rules

### Kill switch

A global kill switch blocks all new submissions.

It must trigger on:

- daily loss limit reached
- unknown order
- balance mismatch
- exchange API failure threshold
- stale market data during execution
- unsafe token or instrument detected
- manual command

### Daily loss limit

```text
realized_loss + realized_rebalance_cost + unhedged_inventory_risk
```

The system must use conservative inventory valuation when calculating risk.

### Venue eligibility

Live execution requires:

```text
venue_health = A
execution_enabled = true
fee configured
precision configured
IOC or FOK supported
order query supported
cancel supported
API key valid
no unresolved unknown orders
```

### Instrument eligibility

Live execution requires:

- active on both venues
- known precision
- known minimum order
- known fees
- fresh order books
- compatible withdraw/deposit status if inventory rebalance is required
- no exchange trading halt
- no abnormal spread or depth anomaly

### BSC execution rules

BSC swaps remain manual in MVP. Automatic signing requires:

- isolated hot wallet
- encrypted key store
- simulation before broadcast
- gas upper bound
- slippage bound
- nonce manager
- broadcast timeout handling
- transaction receipt reconciliation
- manual approval for every transaction initially

## Restart recovery

On startup:

1. Load all non-closed executions.
2. Reconcile every submitted leg.
3. For each unknown leg, query venue order state.
4. Block execution until unknown legs are resolved or manually acknowledged.
5. Restore risk counters and kill switch state.
6. Restore venue backoff states.
7. Confirm balances before enabling any new batch.

## Audit requirements

Every execution must persist:

- opportunity ID
- preflight calculations
- order book snapshots
- order requests
- raw exchange responses
- reconciliation queries
- final order state
- fees
- fills
- net profit
- risk events
- operator actions

The system must be able to reconstruct any executed batch from the database.