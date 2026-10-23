# Exchange Adapter Design

## Adapter contract

All exchanges implement one interface regardless of whether they use CCXT or custom code.

```ts
interface CexAdapter {
  readonly venueId: string;
  readonly tier: 'S' | 'A' | 'B' | 'C';
  readonly capabilities: VenueCapabilities;

  loadMarkets(): Promise<MarketMetadata[]>;
  fetchOrderBook(symbol: string, depth: number): Promise<OrderBookSnapshot>;
  fetchCurrencies(): Promise<CurrencyMetadata[]>;
  fetchBalances?(keys: ApiCredentials): Promise<BalanceSnapshot[]>;
  createOrder?(request: OrderRequest): Promise<OrderSubmitResult>;
  fetchOrder?(request: OrderQuery): Promise<OrderState>;
  cancelOrder?(request: OrderQuery): Promise<OrderSubmitResult>;
}
```

## Standard types

### MarketMetadata

```ts
interface MarketMetadata {
  venueId: string;
  exchangeSymbol: string; // venue symbol used by orders and books
  unifiedSymbol: string; // canonical BASE/QUOTE
  base: string; // canonical base, e.g. PEPE for 1000PEPE/PEPE
  exchangeBase?: string; // venue base when it differs, e.g. 1000PEPE
  baseMultiplier?: Decimal; // canonical units per exchange base unit (1000)
  quote: string;
  active: boolean;
  pricePrecision: number;
  amountPrecision: number;
  minAmount?: Decimal;
  minNotional?: Decimal;
  amountStep?: Decimal;
  priceStep?: Decimal;
  feeTakerBps?: Decimal;
}
```

`base` is the canonical S1 asset. When a venue lists a 1000x denomination such as
`kPEPE` or `1000PEPE`, adapters set `exchangeBase` and `baseMultiplier` but keep
`exchangeSymbol` unchanged for market data and order submission. S1 books are
normalized before evaluation; the executor converts canonical amounts and prices
back to exchange units. See `docs/s1-base-multiplier-design.md`.

### OrderBookSnapshot

```ts
interface OrderBookSnapshot {
  venueId: string;
  exchangeSymbol: string;
  fetchedAt: number; // local receive time
  exchangeTimestamp?: number; // venue timestamp if reliable
  asks: Level[];
  bids: Level[];
  source: 'rest' | 'websocket';
}

interface Level {
  price: Decimal;
  amount: Decimal;
}
```

### CurrencyMetadata

```ts
interface CurrencyMetadata {
  venueId: string;
  code: string;
  networks: CurrencyNetwork[];
}

interface CurrencyNetwork {
  network: string; // normalized, e.g. BSC
  nativeName: string; // venue label, e.g. BNB Smart Chain (BEP20)
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee?: Decimal;
  minWithdrawAmount?: Decimal;
  minDepositAmount?: Decimal;
  canArriveQuickly: boolean; // heuristic until measured
}
```

## Supported exchange tiers

### Tier S

| Exchange | Adapter | Notes                                                        |
| -------- | ------- | ------------------------------------------------------------ |
| Gate.io  | CCXT    | Core venue, public API already verified                      |
| MEXC     | CCXT    | Core venue, public API already verified                      |
| WEEX     | CCXT    | Supported by CCXT; verify trading capability before live use |
| Hotcoin  | Custom  | No CCXT support found; read-only adapter first               |

### Tier A

| Exchange | Adapter |
| -------- | ------- |
| Binance  | CCXT    |
| OKX      | CCXT    |
| Bybit    | CCXT    |
| KuCoin   | CCXT    |
| Bitget   | CCXT    |
| HTX      | CCXT    |

### Tier B

| Exchange | Adapter |
| -------- | ------- |
| BitMart  | CCXT    |
| Bitrue   | CCXT    |
| CoinEx   | CCXT    |
| Poloniex | CCXT    |
| LBank    | CCXT    |
| AscendEX | CCXT    |
| XT       | CCXT    |

### Tier C

| Exchange   | Adapter |
| ---------- | ------- |
| Coinbase   | CCXT    |
| Kraken     | CCXT    |
| Crypto.com | CCXT    |

Tier B and C venues are read-only by default.

## Order book validation

Before an order book can be used:

1. Both bids and asks must be non-empty.
2. Prices must be positive and finite.
3. Amounts must be positive and finite.
4. Bids must be sorted descending.
5. Asks must be sorted ascending.
6. Best bid must be lower than best ask.
7. Duplicate price levels must be merged.
8. Exchange timestamp, if present, must not be stale.
9. Symbol must match the requested symbol.
10. Local receive time must be within `max_orderbook_age_ms`.

Invalid order books are cached as errors and never used for opportunity calculation.

## Rate limiting

Each venue has an independent token bucket. Configure limits conservatively:

```ts
interface RateLimitConfig {
  requestsPerSecond: number;
  burst: number;
  costPublic: number;
  costPrivate: number;
  weightLimitPerMinute?: number;
  respectRetryAfter: boolean;
}
```

Rules:

- Public and private endpoints have separate budgets where the exchange distinguishes them.
- 429, 403, and 418 responses trigger backoff and honor `Retry-After`.
- Network errors trigger exponential backoff.
- No request may bypass the scheduler.
- Execution preflight and order placement have highest priority.
- A venue with repeated failures is automatically degraded.

## Venue health score

Each venue is continuously scored.

### Metrics

| Metric                         | Target                            |
| ------------------------------ | --------------------------------- |
| API success rate               | > 99% over 15 minutes             |
| Median request latency         | venue-specific baseline           |
| Order book age                 | < 3 seconds for active candidates |
| Rate-limit events              | no sustained 429s                 |
| Market data completeness       | > 95% for enabled pairs           |
| Currency metadata availability | required for CEX-DEX              |
| Test order support             | preferred                         |
| Balance fetch reliability      | required for execution            |
| Order state consistency        | required for execution            |

### Health states

```text
A = eligible for live execution
B = eligible for scanning and paper trading
C = record only
D = disabled
```

A venue must be in state A before live execution is allowed.

## API credentials

Only execution-capable venues need private credentials.

Requirements:

- Separate read-only and trade keys where supported.
- Withdrawals must be disabled.
- IP whitelist must be enabled where supported.
- Keys stored encrypted locally.
- Secrets are never returned by the API.
- Logs contain only key fingerprints.
- A key is never used for a purpose outside its declared role.

## Execution capability checks

Before enabling live execution for a venue:

1. Public market data works.
2. Markets and precision rules are loaded.
3. Balances can be fetched.
4. Orders can be queried.
5. Cancel order works in test conditions.
6. Minimum order size is known.
7. Fees are known.
8. Rate limits are known.
9. Client order ID behavior is documented.
10. Timeout and unknown-result behavior is tested.
