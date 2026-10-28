# Live Rollout Plan

## Budget and capital allocation

Initial test capital:

```text
Gate.io:     60 USDT
Hotcoin:     60 USDT
BSC wallet:  50 USDT + 0.05 BNB
Reserve:     100 USDT
Total:       270 USDT
```

Only allocate live funds after the corresponding venue adapter passes health checks.
Hotcoin minimums are per symbol; verify market.minNotional. TBK is currently 0 and
other symbols may require 15 USDT, so allocation must support the chosen symbol.

## Stage 0: environment and credentials

Duration: 0.5 day

Tasks:

1. Create trade and read-only API keys.
2. Disable withdrawal permission.
3. Enable IP whitelist where supported.
4. Create isolated BSC hot wallet.
5. Fund the BSC wallet with small test capital.
6. Configure encrypted local secret storage.

Exit criteria:

- All keys can fetch account information.
- No key has withdrawal permission.
- BSC wallet can read balance but has not been used for automated signing.

## Stage 1: read-only scanner

Duration: 1-2 days

Scope:

- Gate.io
- Hotcoin
- Tier A reference venues if rate limits allow

Tasks:

1. Load markets and execution metadata.
2. Scan S1 CEX-CEX opportunities only.
3. Record venue health and feed latency.
4. Persist opportunity episodes.
5. Validate that Gate.io and Hotcoin WebSocket books are fresh under the configured limits.

Exit criteria:

- 24-hour continuous operation without crash.
- No sustained rate-limit violations.
- Order books and quotes are correctly marked stale.
- Conservative profit calculations are available for every opportunity.
- At least one actionable S1 opportunity is identified.

## Stage 2: paper batch validation

Duration: 1 day

Tasks:

1. Simulate S1 batches against actual depth.
2. Simulate partial first-leg fills.
3. Simulate second-leg failure.
4. Simulate request timeout.
5. Simulate restart with open batches.
6. Confirm state machine transitions.

Exit criteria:

- 20 consecutive successful simulated batches.
- All simulated failure paths enter the correct safe state.
- No simulated path produces duplicate orders.

## Stage 3: small manual live CEX execution

Duration: 2-3 days

Initial pair:

```text
CAKE/USDT on Gate.io and Hotcoin
```

Fallback pair:

```text
A medium-cap token listed on Gate.io and Hotcoin with acceptable depth
```

Limits:

```text
notional per batch: 15-20 USDT
max batches per day: 5
max concurrent batches: 1
manual confirmation: required
daily max loss: 5 USDT
```

The lower bound comes from each Hotcoin market's minOrderAmount/minNotional. Do not
run a leg below the selected market's actual minimum.

Exit criteria:

- 10 manually confirmed live batches.
- At least 80% of batches close with both legs fully reconciled.
- No unknown-order incident.
- Actual net profit is within the expected range after fees.
- Inventory drift is measured.

## Stage 4: controlled CEX automation

Duration: 5-7 days

Limits:

```text
notional per batch: 20-30 USDT
max batches per day: 20
max concurrent batches: 1
daily max loss: 20 USDT
```

Exit criteria:

- 50 successful automated batches.
- Unknown-order rate below 0.5%.
- No unexplained balance mismatch.
- Daily net profit is positive after all costs over at least 5 days.
- Inventory rebalancing cost is measured.

## Stage 5: BSC manual CEX-DEX tests

Duration: 3-5 days

Only after S1 is stable.

Scope:

- Whitelist tokens only: CAKE, BNB/WBNB, USDT, USDC.
- Inventory mode only.
- Manual swap confirmation.
- No automated signing.

Limits:

```text
max swap notional: 20 USDT
max gas cost: 0.50 USDT
max slippage: 0.5%
manual confirmation: required
```

Exit criteria:

- 10 manual CEX-DEX batches.
- Swap simulation matches actual output within expected tolerance.
- No failed transactions caused by gas or slippage misconfiguration.
- CEX and BSC inventory reconciliation is correct.

## Stage 6: expansion decision

Expand only if the previous stages meet exit criteria.

Possible expansions:

- more exchanges
- more pairs
- S3 automation
- BSC DEX-DEX execution
- lower-liquidity tokens with higher risk limits

Do not expand more than one risk dimension at a time.

## Metrics dashboard

Track:

- conservative profit per opportunity
- opportunity duration
- fill rate
- first-leg partial fill rate
- second-leg failure rate
- unknown-order rate
- API error rate
- rate-limit events
- venue latency
- actual net profit
- inventory drift
- rebalance cost
- BSC gas cost
- token transfer tax
- operator interventions

## Stop conditions

Immediately stop live execution if:

- unknown order cannot be reconciled
- balance mismatch is detected
- exchange reports an order not present in local database
- API key permissions change unexpectedly
- withdrawal permission is detected
- venue suspends deposits or withdrawals for an execution asset
- daily loss limit is reached
- market data becomes persistently stale
- system clock drift is detected
- repeated order failures occur on one venue
- any BSC simulation differs materially from the aggregator quote
