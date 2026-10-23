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

## Custom adapter requirement

Hotcoin must implement the standard `CexAdapter` interface:

- load markets
- fetch order book
- fetch tickers
- fetch currencies/networks
- fetch balances
- create order
- fetch order
- cancel order
- fetch trading rules
- report rate limits

No live execution is enabled until the custom adapter has integration tests and a successful read-only soak test.

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
