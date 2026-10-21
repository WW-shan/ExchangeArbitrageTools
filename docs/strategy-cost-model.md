# Strategy and Cost Model Design

## Strategies

| ID | Strategy | MVP status |
|---|---|---|
| S1 | CEX-CEX spot arbitrage | Read-only, paper, then small live |
| S2 | Intra-CEX triangular arbitrage | Read-only and paper only |
| S3 | BSC CEX-DEX arbitrage | Read-only, then manual live |
| S4 | BSC DEX-DEX arbitrage | Read-only only |

## Common concepts

### Depth result

```ts
interface DepthResult {
  side: 'buy' | 'sell';
  requestedNotional: Decimal;
  executableBaseAmount: Decimal;
  executableQuoteAmount: Decimal;
  averagePrice: Decimal;
  worstPrice: Decimal;
  levelsConsumed: number;
  insufficientDepth: boolean;
}
```

### Opportunity result

```ts
interface OpportunityResult {
  strategy: 'S1' | 'S2' | 'S3' | 'S4';
  instrumentKey: string;
  direction: string;
  requestedNotional: Decimal;
  depthNetProfit: Decimal;
  conservativeNetProfit: Decimal;
  netProfitBps: Decimal;
  dataAgeMs: number;
  valid: boolean;
  rejectionReasons: string[];
}
```

### Rejection reasons

Every rejected opportunity must expose a machine-readable reason, for example:

- `insufficient_depth`
- `below_min_notional`
- `stale_orderbook`
- `crossed_orderbook`
- `fee_not_configured`
- `gas_too_high`
- `transfer_tax_too_high`
- `transfer_disabled`
- `token_not_verified`
- `conservative_profit_below_threshold`
- `venue_health_below_threshold`

## S1: CEX-CEX spot arbitrage

### Direction A

Buy on venue A, sell on venue B.

```text
buyCost =
  venueA ask depth cost
+ venueA taker fee

sellProceeds =
  venueB bid depth proceeds
- venueB taker fee

grossSpread = sellProceeds - buyCost
depthNetProfit = grossSpread
conservativeNetProfit =
  grossSpread
- safetyBufferUsd
- minimumProfitUsd
```

### Direction B

Buy on venue B, sell on venue A.

The same formula is evaluated in both directions. Only one direction is eligible at a time.

### Required checks

- Both order books are valid and fresh.
- Notional is above both minimum order values.
- Amount is valid under both precision and step rules.
- Fees are configured or fetched.
- Venue health is at least B for scanning and A for execution.
- Net profit is positive after all costs.
- The same asset identity is confirmed.

### Execution method

MVP uses two IOC/FOK limit orders where supported. If only GTC is supported, the venue cannot be used for automated execution in MVP.

Order prices:

- Buy limit price = worst executable ask price
- Sell limit price = worst executable bid price

Before submitting:

1. Refresh both order books.
2. Refresh balances.
3. Recalculate depth and conservative profit.
4. Verify no active batch or unresolved order.
5. Verify kill switch is off.

After the first leg returns:

1. Reconcile actual filled amount.
2. Second leg quantity must equal the first leg actual filled base amount.
3. If first leg fill is zero, cancel remaining order and close batch.
4. If first leg result is unknown, enter safe mode and do not submit the second leg automatically.

## S2: Intra-CEX triangular arbitrage

### Path construction

Build a directed graph:

```text
nodes = currencies
edges = active markets
```

Enumerate paths of length two or three:

```text
USDT -> BTC -> ETH -> USDT
USDT -> ETH -> BTC -> USDT
USDT -> X -> Y -> USDT
```

### Calculation

For each edge:

1. Apply the actual order book depth.
2. Apply exchange fee.
3. Apply amount precision.
4. Respect minimum order size.

Final profit:

```text
outputUsdt - inputUsdt - safetyBuffer - minimumProfit
```

### MVP constraints

- Start and end currency must be USDT.
- Maximum path length is three trades.
- Maximum two candidate intermediate currencies initially.
- No execution.
- Record opportunity duration and simulated fill quality.

## S3: BSC CEX-DEX arbitrage

### Inventory mode

Both sides already hold inventory.

Direction A:

```text
Buy on CEX
Sell on BSC aggregator
```

Direction B:

```text
Buy on BSC aggregator
Sell on CEX
```

### Transfer mode

Requires enabled CEX withdrawal or deposit and includes:

- withdrawal fee
- estimated arrival time
- transfer risk buffer
- token transfer tax

Transfer mode is not live-enabled in MVP.

### Required checks

- CEX and BSC token mapping is active.
- Token risk level is low for execution.
- Aggregator quote is fresh.
- Gas estimate is fresh and below maximum.
- CEX order book is fresh.
- Slippage and price impact are within limits.
- If transfer is required, transfer status is enabled.
- Net profit is positive after all costs.

## S4: BSC DEX-DEX arbitrage

Compare independent aggregator or pool quotes for the same token pair.

```text
profit =
  sell proceeds on venue B
- buy cost on venue A
- both pool fees
- gas
- price impact
- slippage buffer
- transfer tax
- safety buffer
```

MVP behavior:

- Scan only.
- Record opportunity duration.
- Simulate two separate swaps.
- Do not automatically sign or broadcast transactions.
- Do not implement atomic contract arbitrage yet.

## Safety buffer

Use both absolute and percentage buffers:

```text
safety_buffer =
  max(
    min_profit_usd,
    notional * safety_buffer_bps / 10_000
  )
```

Initial defaults:

```text
min_profit_usd = 0.25
safety_buffer_bps = 15
min_net_profit_bps = 20
max_orderbook_age_ms = 3000
max_slippage_bps = 50
max_gas_cost_usd = 0.50
```

## Opportunity persistence

Each opportunity is persisted with:

- strategy
- venues
- instruments
- direction
- notional
- raw spread
- all costs
- depth net profit
- conservative net profit
- data timestamps
- validation result
- rejection reasons

Repeated observations are grouped into an opportunity episode:

```text
episode_start
episode_end
sample_count
max_profit
median_profit
min_profit
duration_ms
```

This distinguishes persistent opportunities from transient flickers.

## Paper trading model

Paper trading executes against the same depth calculation used for scanning.

For each paper trade, record:

- requested notional
- simulated executable amount
- average prices
- worst prices
- fees
- gas where applicable
- net profit
- opportunity duration before paper execution
- expected failure reasons

Paper trades are used to calibrate safety buffer and minimum profit thresholds, not to prove live execution works.