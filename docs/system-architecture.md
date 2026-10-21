# System Architecture

## Goal

Build a local arbitrage research and execution platform focused on:

1. CEX-to-CEX spot arbitrage.
2. Intra-exchange triangular arbitrage.
3. BNB Smart Chain (BSC) CEX-to-DEX scanning.
4. BSC DEX-to-DEX scanning.

The system is designed for small capital and no latency advantage. It targets slower, structural, cost-aware opportunities rather than high-frequency races.

## Core principles

- Every displayed opportunity must already include all known costs.
- Scanning and execution are separated.
- Each venue is independently rate-limited and health-scored.
- No transaction may rely on frontend-only data.
- Execution state must survive process restarts.
- On uncertain order or transaction outcomes, enter safe mode; never blindly retry.
- Token identity is resolved by BSC contract address, never by ticker alone.
- Only venues that pass health and safety checks may be used for live execution.

## High-level architecture

```text
+--------------------------------------------+
|              Local Web Dashboard            |
|  opportunities / health / inventory / logs |
+--------------------+-----------------------+
                     |
+--------------------+-----------------------+
|              Application API                |
+-------+------------+---------------+-------+
        |            |               |
+-------v------+ +---v--------+ +---v----------+
| Scanner      | | Paper Trade| | Executor      |
| strategies   | | simulator  | | CEX-only MVP  |
+-------+------+ +---+--------+ +---+----------+
        |            |               |
+-------v------------v---------------v-------+
| Core domain: cost, profit, risk, ledger     |
+-------+------------+---------------+-------+
        |            |               |
+-------v------+ +---v--------+ +---v----------+
| CEX adapters | | BSC quotes | | Storage       |
| CCXT/custom  | | aggregators| | SQLite        |
+--------------+ +------------+ +---------------+
```

## Repository layout

```text
apps/
  scanner/          opportunity scanning service
  dashboard/        local web UI
  executor/         live CEX execution service
packages/
  core/             profit, cost, risk, instrument models
  venues/
    cex/            CCXT and custom exchange adapters
    bsc/            aggregator and token registry adapters
  storage/          SQLite migrations and repositories
docs/               design documents
tests/              unit, integration, and simulation tests
```

## Runtime topology

The first implementation runs one local process with separate modules:

```text
scanner worker
scheduler
web API
dashboard
executor worker
```

When volume increases, these can be split into separate processes without changing core interfaces.

## Data flow

### 1. Market discovery

1. Load markets from each enabled CEX.
2. Normalize symbols and quote assets.
3. Resolve shared instruments.
4. For BSC, resolve exchange currency to contract address.
5. Mark unsupported transfer networks and high-risk tokens.

### 2. Market data sampling

1. Poll public order books or WebSocket feeds where supported.
2. Validate order book structure.
3. Cache the latest valid snapshot.
4. Mark snapshots stale after a configured maximum age.
5. Record per-venue latency, errors, and rate-limit events.

### 3. Opportunity evaluation

For each strategy:

1. Compute executable depth for the configured notional.
2. Apply precision and minimum order size.
3. Apply exchange fees.
4. Apply DEX pool fees, price impact, gas, transfer tax, and transfer costs.
5. Apply a safety buffer.
6. Produce `depth_net_profit` and `conservative_net_profit`.
7. Only positive conservative profit becomes an opportunity.

### 4. Persistence and display

The scanner writes opportunities and continuous samples to SQLite. The dashboard reads from the database, never directly triggering venue requests during page refresh.

## Technology stack

- Node.js 20+
- TypeScript
- CCXT for supported exchanges
- Fastify for local API
- SQLite for persistence
- Web frontend using lightweight React or native HTML/JavaScript
- `ethers.js` for BSC read-only calls
- Aggregator APIs for DEX quotes, initially 0x and 1inch where available

## Non-goals for the first version

- No cross-chain bridge execution.
- No automatic withdrawals or deposits.
- No MEV-oriented strategy.
- No private-key automation for BSC swaps.
- No Solana execution.
- No Ethereum mainnet execution.
- No unattended high-frequency trading.

## Failure philosophy

The system optimizes for capital safety rather than opportunity count:

- Fail closed.
- Unknown outcomes block execution.
- One active batch at a time in MVP.
- Global kill switch is always available.
- Every execution decision must be reconstructable from persisted logs.