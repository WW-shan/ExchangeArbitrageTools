export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE venues (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('cex', 'dex', 'aggregator', 'chain')),
        name TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C')),
        execution_enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE venue_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue_id TEXT NOT NULL,
        measured_at INTEGER NOT NULL,
        success_rate REAL NOT NULL,
        median_latency_ms INTEGER NOT NULL,
        p95_latency_ms INTEGER NOT NULL,
        rate_limit_events INTEGER NOT NULL,
        stale_data_events INTEGER NOT NULL,
        health_state TEXT NOT NULL CHECK (health_state IN ('A', 'B', 'C', 'D')),
        score REAL NOT NULL,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );
      CREATE INDEX venue_health_venue_time_idx ON venue_health(venue_id, measured_at DESC);

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

      CREATE TABLE token_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cex_venue_id TEXT NOT NULL,
        cex_currency TEXT NOT NULL,
        chain TEXT NOT NULL DEFAULT 'BSC',
        contract_address TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'rejected')),
        verification_sources TEXT NOT NULL,
        transfer_tax_bps TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        notes TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE (cex_venue_id, cex_currency, chain, contract_address),
        FOREIGN KEY (cex_venue_id) REFERENCES venues(id),
        FOREIGN KEY (contract_address) REFERENCES bsc_tokens(contract_address)
      );

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
      CREATE INDEX orderbooks_time_idx ON orderbooks(fetched_at);

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
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        UNIQUE (strategy, opportunity_key, direction, episode_start)
      );
      CREATE INDEX opportunity_episodes_open_idx ON opportunity_episodes(status, opportunity_key);

      CREATE TABLE opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episode_id INTEGER,
        strategy TEXT NOT NULL,
        opportunity_key TEXT NOT NULL,
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
        metadata_json TEXT NOT NULL DEFAULT '{}',
        sampled_at INTEGER NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES opportunity_episodes(id)
      );
      CREATE INDEX opportunities_sampled_idx ON opportunities(sampled_at DESC);
      CREATE INDEX opportunities_valid_idx ON opportunities(valid, sampled_at DESC);

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
        safe_mode_reason TEXT
      );
      CREATE INDEX executions_open_idx ON executions(status) WHERE closed_at IS NULL;

      CREATE TABLE execution_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id INTEGER NOT NULL,
        leg_number INTEGER NOT NULL,
        venue_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'swap')),
        requested_amount TEXT NOT NULL,
        requested_price TEXT NOT NULL,
        submitted_at INTEGER,
        status TEXT NOT NULL,
        filled_amount TEXT,
        average_fill_price TEXT,
        fee_paid TEXT,
        order_id TEXT,
        client_order_id TEXT,
        error TEXT,
        UNIQUE (execution_id, leg_number),
        FOREIGN KEY (execution_id) REFERENCES executions(id),
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

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

      CREATE TABLE risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
        rule TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'inventory_snapshots',
    sql: `
      CREATE TABLE inventory_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        chain TEXT,
        asset TEXT NOT NULL,
        contract_address TEXT,
        free TEXT NOT NULL,
        used TEXT NOT NULL,
        total TEXT NOT NULL,
        usd_value TEXT,
        captured_at INTEGER NOT NULL,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );
      CREATE INDEX inventory_snapshots_venue_time_idx
        ON inventory_snapshots(venue_id, captured_at DESC);
      CREATE INDEX inventory_snapshots_asset_time_idx
        ON inventory_snapshots(asset, captured_at DESC);
    `,
  },
  {
    version: 3,
    name: 'execution_risk_state',
    sql: `
      CREATE TABLE daily_risk_state (
        trading_day TEXT PRIMARY KEY,
        realized_loss TEXT NOT NULL DEFAULT '0',
        rebalance_cost TEXT NOT NULL DEFAULT '0',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE unhedged_inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id INTEGER NOT NULL,
        batch_id TEXT NOT NULL,
        venue_id TEXT NOT NULL,
        asset TEXT NOT NULL,
        amount TEXT NOT NULL,
        usd_value TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (execution_id) REFERENCES executions(id),
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );
      CREATE INDEX unhedged_inventory_status_idx
        ON unhedged_inventory(status, created_at);
      CREATE INDEX unhedged_inventory_batch_idx
        ON unhedged_inventory(batch_id);
    `,
  },
  {
    version: 4,
    name: 'venue_backoff_state',
    sql: `
      CREATE TABLE venue_backoff (
        venue_id TEXT PRIMARY KEY,
        backoff_until INTEGER NOT NULL,
        reason TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );
    `,
  },
  {
    version: 5,
    name: 'simulation_and_recovery_audit',
    sql: `
      ALTER TABLE paper_trades ADD COLUMN buy_price_worst TEXT;
      ALTER TABLE paper_trades ADD COLUMN sell_price_worst TEXT;
      ALTER TABLE paper_trades ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE paper_trades ADD COLUMN expected_failure_reasons TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE paper_trades ADD COLUMN fill_quality_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE executions ADD COLUMN opportunity_id INTEGER;
      ALTER TABLE executions ADD COLUMN preflight_json TEXT;
      ALTER TABLE executions ADD COLUMN gross_spread TEXT;
      ALTER TABLE executions ADD COLUMN fees TEXT;
      ALTER TABLE executions ADD COLUMN latency_ms INTEGER;
      ALTER TABLE executions ADD COLUMN inventory_delta_json TEXT;
      ALTER TABLE executions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE orders ADD COLUMN execution_id INTEGER;

      CREATE INDEX venue_backoff_until_idx ON venue_backoff(backoff_until);
      CREATE INDEX orders_execution_idx ON orders(execution_id);
    `,
  },
  {
    version: 6,
    name: 'market_universe',
    sql: `
      CREATE TABLE market_universe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        venue_id TEXT NOT NULL,
        exchange_symbol TEXT NOT NULL,
        base TEXT NOT NULL,
        quote TEXT NOT NULL,
        quote_volume_24h TEXT,
        tier TEXT NOT NULL CHECK (tier IN ('hot', 'top100', 'top500')),
        updated_at INTEGER NOT NULL,
        UNIQUE (venue_id, exchange_symbol),
        FOREIGN KEY (venue_id) REFERENCES venues(id)
      );

      CREATE INDEX market_universe_tier_idx ON market_universe(venue_id, tier);
      CREATE INDEX market_universe_quote_idx ON market_universe(venue_id, quote, tier);
    `,
  },
  {
    version: 7,
    name: 'unhedged_inventory_direction',
    sql: `
      ALTER TABLE unhedged_inventory
        ADD COLUMN direction TEXT NOT NULL DEFAULT 'long'
        CHECK (direction IN ('long', 'short'));
    `,
  },
  {
    version: 8,
    name: 'automated_inventory_transfers',
    sql: `
      CREATE TABLE transfer_batches (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        confirmation TEXT,
        dry_run INTEGER NOT NULL DEFAULT 1,
        safe_mode_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX transfer_batches_status_idx ON transfer_batches(status, updated_at DESC);
      CREATE INDEX transfer_batches_created_idx ON transfer_batches(created_at DESC);

      CREATE TABLE transfer_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        leg_number INTEGER NOT NULL,
        from_venue TEXT NOT NULL,
        to_venue TEXT NOT NULL,
        asset TEXT NOT NULL,
        network TEXT NOT NULL,
        amount TEXT NOT NULL,
        fee TEXT,
        address TEXT NOT NULL,
        address_tag TEXT,
        status TEXT NOT NULL,
        source_record_id TEXT,
        source_tx_id TEXT,
        destination_record_id TEXT,
        destination_tx_id TEXT,
        requested_at INTEGER,
        source_observed_at INTEGER,
        destination_observed_at INTEGER,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        UNIQUE (batch_id, leg_number),
        FOREIGN KEY (batch_id) REFERENCES transfer_batches(id) ON DELETE CASCADE
      );

      CREATE INDEX transfer_legs_batch_idx ON transfer_legs(batch_id, leg_number);
      CREATE INDEX transfer_legs_route_idx
        ON transfer_legs(from_venue, asset, requested_at);
    `,
  },
  {
    version: 9,
    name: 'transfer_execution_lease',
    sql: `
      ALTER TABLE transfer_batches ADD COLUMN execution_token TEXT;
      ALTER TABLE transfer_batches ADD COLUMN execution_lease_until INTEGER;
      CREATE INDEX transfer_batches_execution_idx
        ON transfer_batches(execution_token, execution_lease_until);
    `,
  },
  {
    version: 10,
    name: 'order_fee_currency',
    sql: `
      ALTER TABLE orders ADD COLUMN fee_currency TEXT;
    `,
  },
] as const;
