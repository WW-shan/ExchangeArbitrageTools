# Data Model Design

## Storage choice

Use SQLite locally.

Reasons:

- Simple operation on a local machine.
- Reliable persistence and recovery.
- Adequate for one scanner process and moderate opportunity history.
- Easy backup as a single file.

All monetary and quantity values are stored as exact decimal strings. Timestamps are stored as UTC epoch milliseconds.

## Entity overview

```text
venues
venue_health
exchange_markets
exchange_currencies
token_mappings
bsc_tokens
orderbooks
dex_quotes
opportunities
opportunity_episodes
paper_trades
executions
execution_legs
orders
order_events
balances
inventory_snapshots
risk_events
settings
audit_logs
```

## Table designs

### venues

```sql
CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- cex | dex | aggregator | chain
  name TEXT NOT NULL,
  tier TEXT NOT NULL,             -- S | A | B | C
  execution_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### venue_health

```sql
CREATE TABLE venue_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  measured_at INTEGER NOT NULL,
  success_rate REAL NOT NULL,
  median_latency_ms INTEGER NOT NULL,
  p95_latency_ms INTEGER NOT NULL,
  rate_limit_events INTEGER NOT NULL,
  stale_data_events INTEGER NOT NULL,
  health_state TEXT NOT NULL,       -- A | B | C | D
  score REAL NOT NULL,
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);
```

### exchange_markets

```sql
CREATE TABLE exchange_markets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  exchange_symbol TEXT NOT NULL,
  unified_symbol TEXT NOT NULL,
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  active INTEGER NOT NULL,
  price_precision INTEGER NOT NULL,
  amount_precision INTEGER NOT NULL,
  amount_step TEXT,
  price_step TEXT,
  min_amount TEXT,
  min_notional TEXT,
  taker_fee_bps TEXT,
  maker_fee_bps TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (venue_id, exchange_symbol),
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);
```

### exchange_currencies

```sql
CREATE TABLE exchange_currencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  network TEXT NOT NULL,
  native_network_name TEXT,
  withdraw_enabled INTEGER NOT NULL,
  deposit_enabled INTEGER NOT NULL,
  withdraw_fee TEXT,
  min_withdraw_amount TEXT,
  min_deposit_amount TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (venue_id, currency, network),
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);
```

### bsc_tokens

```sql
CREATE TABLE bsc_tokens (
  contract_address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  name TEXT,
  verified_contract INTEGER NOT NULL DEFAULT 0,
  transfer_tax_bps TEXT NOT NULL DEFAULT '0',
  liquidity_usd TEXT,
  volume_24h_usd TEXT,
  risk_level TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### token_mappings

```sql
CREATE TABLE token_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cex_venue_id TEXT NOT NULL,
  cex_currency TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'BSC',
  contract_address TEXT NOT NULL,
  status TEXT NOT NULL,           -- candidate | active | rejected
  verification_sources TEXT NOT NULL,
  transfer_tax_bps TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  notes TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (cex_venue_id, cex_currency, chain, contract_address),
  FOREIGN KEY (cex_venue_id) REFERENCES venues(id),
  FOREIGN KEY (contract_address) REFERENCES bsc_tokens(contract_address)
);
```

### orderbooks

Stores snapshots only when needed for audit or opportunity reconstruction.

```sql
CREATE TABLE orderbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  exchange_symbol TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  exchange_timestamp INTEGER,
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL,
  valid INTEGER NOT NULL,
  validation_error TEXT,
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);
```

### dex_quotes

```sql
CREATE TABLE dex_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  sell_token TEXT NOT NULL,
  buy_token TEXT NOT NULL,
  sell_amount TEXT NOT NULL,
  buy_amount TEXT NOT NULL,
  fee_bps TEXT NOT NULL,
  price_impact_bps TEXT NOT NULL,
  gas_estimate TEXT NOT NULL,
  gas_price TEXT NOT NULL,
  gas_cost_usd TEXT NOT NULL,
  quoted_at INTEGER NOT NULL,
  valid_until INTEGER,
  FOREIGN KEY (provider_id) REFERENCES venues(id)
);
```

### opportunities

```sql
CREATE TABLE opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER,
  strategy TEXT NOT NULL,
  venue_buy TEXT NOT NULL,
  venue_sell TEXT NOT NULL,
  instrument_buy TEXT NOT NULL,
  instrument_sell TEXT NOT NULL,
  direction TEXT NOT NULL,
  requested_notional TEXT NOT NULL,
  gross_spread TEXT NOT NULL,
  total_cost TEXT NOT NULL,
  depth_net_profit TEXT NOT NULL,
  conservative_net_profit TEXT NOT NULL,
  net_profit_bps TEXT NOT NULL,
  data_age_ms INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  rejection_reasons TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES opportunity_episodes(id)
);
```

### opportunity_episodes

```sql
CREATE TABLE opportunity_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  opportunity_key TEXT NOT NULL,
  direction TEXT NOT NULL,
  episode_start INTEGER NOT NULL,
  episode_end INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  max_profit TEXT NOT NULL,
  median_profit TEXT NOT NULL,
  min_profit TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,          -- open | closed
  UNIQUE (strategy, opportunity_key, direction, episode_start)
);
```

### paper_trades

```sql
CREATE TABLE paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id INTEGER NOT NULL,
  requested_notional TEXT NOT NULL,
  simulated_base_amount TEXT NOT NULL,
  buy_price_average TEXT NOT NULL,
  sell_price_average TEXT NOT NULL,
  fees TEXT NOT NULL,
  gas_cost TEXT NOT NULL,
  net_profit TEXT NOT NULL,
  result TEXT NOT NULL,
  executed_at INTEGER NOT NULL,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
);
```

### executions

```sql
CREATE TABLE executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  planned_notional TEXT NOT NULL,
  expected_profit TEXT NOT NULL,
  realized_profit TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  safe_mode_reason TEXT,
  FOREIGN KEY (strategy) REFERENCES opportunities(strategy)
);
```

### execution_legs

```sql
CREATE TABLE execution_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL,
  leg_number INTEGER NOT NULL,
  venue_id TEXT NOT NULL,
  side TEXT NOT NULL,             -- buy | sell | swap
  requested_amount TEXT NOT NULL,
  requested_price TEXT NOT NULL,
  submitted_at INTEGER,
  status TEXT NOT NULL,           -- planned | submitted | filled | partial | unknown | failed | canceled
  filled_amount TEXT,
  average_fill_price TEXT,
  fee_paid TEXT,
  order_id TEXT,
  client_order_id TEXT,
  error TEXT,
  FOREIGN KEY (execution_id) REFERENCES executions(id),
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);
```

### orders and order_events

```sql
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  venue_order_id TEXT,
  client_order_id TEXT UNIQUE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  price TEXT NOT NULL,
  amount TEXT NOT NULL,
  filled_amount TEXT NOT NULL DEFAULT '0',
  average_price TEXT,
  fee TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
```

### balances

```sql
CREATE TABLE balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  free TEXT NOT NULL,
  used TEXT NOT NULL,
  total TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (venue_id, account_id, currency, fetched_at),
  FOREIGN KEY (venue_id) REFERENCES venues(id)
);
```

### risk_events

```sql
CREATE TABLE risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,          -- info | warning | critical
  rule TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

## Retention

Recommended initial retention:

- Raw order books: 3 days
- Valid opportunities: 90 days
- Opportunity episodes: 1 year
- Paper trades: 1 year
- Executions and order events: permanent
- Risk events: permanent

Raw market snapshots should not grow unbounded. Persist only snapshots attached to valid opportunities or executions.

## Backup

- SQLite database file is backed up before every app upgrade.
- Executions are exported to JSONL nightly.
- API keys are not stored in SQLite; use the local encrypted secret store.