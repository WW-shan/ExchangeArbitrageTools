# Open Source Reuse Plan

The project should reuse proven open-source components where possible, but reuse must follow licensing, security, and maintenance rules.

## Reuse tiers

### Tier 1: direct dependency

Use as a library or package.

| Component      | License | Purpose                                                             |
| -------------- | ------- | ------------------------------------------------------------------- |
| CCXT           | MIT     | Exchange market data, markets, order books, trading where supported |
| ethers.js      | MIT     | BSC RPC reads, token metadata, decimals, transfer-tax checks        |
| Fastify        | MIT     | Local API server                                                    |
| better-sqlite3 | MIT     | Local persistence                                                   |
| Decimal.js     | MIT     | Monetary and quantity arithmetic                                    |
| Vitest         | MIT     | Testing                                                             |

These packages are appropriate dependencies because they have clear permissive licenses and maintain a stable public API.

### Tier 2: architecture reference

Study design and selectively implement equivalent behavior. Do not vendor source unless the license is explicitly verified.

| Project    | License    | What to reuse                                                                                                  |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| Hummingbot | Apache-2.0 | Order tracker, in-flight order model, trading rule validation, rate limiter, cross-exchange strategy structure |
| CCXT       | MIT        | Exchange response normalization, precision handling, market metadata conventions                               |

Apache-2.0 and MIT permit code reuse under their terms, but Hummingbot is large and mostly useful as an architectural reference. Copying entire modules would add maintenance burden.

### Tier 3: ideas only

Do not copy code.

| Project                           | License      | Useful ideas                                                                                                |
| --------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| m1amgn/cex_dex_arbitrager         | None found   | Unified venue abstraction, tiered scanning, cost-aware thresholds, token verification, signal deduplication |
| solidquant/whack-a-mole           | None found   | CEX-DEX research framing, AMM simulation concepts                                                           |
| hzjken/crypto-arbitrage-framework | None found   | Path optimization and amount optimization for triangular arbitrage                                          |
| rexonelo/barbotine-arbitrage-bot  | Non-standard | Orderbook-depth opportunity simulation and fake-money mode                                                  |

Projects without a clear license are not safe to copy. We may independently implement the same ideas, but must not reproduce their source.

## Recommended CCXT venues

CCXT already supports many exchanges, including:

- Gate.io
- MEXC
- WEEX
- Binance
- OKX
- Bybit
- KuCoin
- Bitget
- HTX
- BitMart
- Bitrue
- CoinEx
- Poloniex
- Coinbase
- Kraken

Hotcoin was not found in CCXT and requires a custom adapter.

## Exchange tiers

### Tier S: core focus

- Gate.io
- MEXC
- WEEX
- Hotcoin

These are prioritized for scanning and live testing.

### Tier A: reference and expansion

- Binance
- OKX
- Bybit
- KuCoin
- Bitget
- HTX

These provide reference prices and structural spreads against smaller venues.

### Tier B: read-only long tail

- BitMart
- Bitrue
- CoinEx
- Poloniex
- LBank
- AscendEX
- XT
- Other CCXT-supported venues

These are scanned opportunistically and only promoted to live testing after stable health scores.

### Tier C: global reference

- Coinbase
- Kraken
- Crypto.com

These are mainly for major-asset reference pricing.

## Custom adapter status

Hotcoin is implemented through the standard `CexAdapter` interface:

- [x] load markets and precision/minimum metadata
- [x] REST order-book snapshots
- [x] gzip WebSocket depth with keepalive
- [x] signed balance reads (`/v3/balance`, `/v1/balance` fallback)
- [x] bulk tickers (`/v1/market/ticker`) for `top_volume` discovery
- [x] create order (`matchType=8` FOK, `matchType=9` IOC)
- [x] fetch order by venue id or official `detailByClOrdId`, with bounded pagination fallback
- [x] cancel order by venue id or `clOrdId`
- [x] documented status mapping, HTTP 418/429 backoff, and bounded clientOrderId pagination
- [ ] fetch currencies/networks (not required while BSC is disabled)
- [ ] venue-specific rate-limit verification with real keys

The public REST/WS/ticker path has integration tests and real probe evidence. Private
endpoints are implemented but have not been exercised with real keys. No live
execution is enabled until private-key integration tests, FOK/IOC verification,
and a read-only soak pass.

Reference used for the private endpoint names and request shape:
`hotcoinexchange/hotcoin-api-java` (official SDK, pushed 2026-01-20). The SDK's
examples use signed GET for order placement/cancel and expose
`/v1/order/detailByClOrdId`; this project keeps signed POST for those operations
because the public endpoint accepts both, but private POST behavior still needs
real-key verification. It uses the direct client-order-id lookup before falling
back to pagination.

## Legal and compliance notes

- Retain upstream license notices when copying or adapting MIT/Apache-2.0 code.
- Do not copy code from repositories with unclear licenses.
- Do not use closed-source bot binaries from unknown GitHub repositories.
- Do not trust private-key-handling code without an independent security review.
- Never run third-party bot code directly with funded API keys or wallets.

## Security rule for third-party bots

Open source does not imply safe. Many arbitrage repositories are abandoned, unaudited, malicious, or designed for different market conditions. Before any third-party code is executed:

1. Read the source.
2. Verify dependencies.
3. Search for network calls and key exfiltration.
4. Run without secrets first.
5. Run in isolation.
6. Never grant withdrawal permissions.

For this project, use established libraries for infrastructure and implement the arbitrage-specific execution path ourselves.
