# Discovery P0-1: Market Universe Expansion and Tiered Scanning

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Expand the opportunity search space from the fixed MVP set (four base assets, USDT only,
three venues) to a volume-ranked universe of markets across all enabled CEX venues, while
keeping the scan cycle bounded through tiered scheduling and bounded-concurrency fetching.

## Why this is first

The previous scanner only evaluated:

- `base_assets = ["CAKE", "BNB", "ETH", "BTC"]`
- `quote_currency = "USDT"`

That is a very small fraction of the listed markets. Before adding multi-hop or
cross-venue logic, the scanner must first see a meaningful market universe.

## Recent references

- `m1amgn/cex_dex_arbitrager` (pushed 2026-09-10): `quote_currencies = ["USDT", "USDC"]`,
  tiered scanning (`hot 30s / top100 120s / top500 600s`), `signal_cooldown = 300s`,
  `get_hot()` prioritisation.
- `kanekoshoyu/kucoin_arbitrage` (pushed 2026-05-28): quote-based symbol filtering,
  requiring both quote legs for triangular paths, and a gatekeeper for exchange limits.
- `banbox/banexg` (pushed 2026-10-04): multi-account and WebSocket dump/playback for
  replay (reserved for the data-layer phase).

## Design

### 1. Universe builder

New module `apps/scanner/src/universe.ts`:

- Input: active markets, ticker snapshots, quote currencies, max base assets, minimum 24h
  quote volume, and optional explicit base assets.
- Uses `ticker.quoteVolume` when available; otherwise falls back to
  `baseVolume * last`.
- Filters: active market, quote in configured quotes, volume above threshold.
- Groups by quote, sorts by volume descending, keeps the top `max_base_assets`.
- Assigns tier: rank `< 100` -> `top100`, otherwise `top500`.
- Keeps markets with no ticker data as a fail-open fallback for venues without tickers.

### 2. Ticker capability

- `TickerSnapshot` added to `packages/core/src/types.ts`.
- `CexAdapter.fetchTickers?()` added to the adapter contract.
- `CcxtCexAdapter.fetchTickers()` normalises CCXT tickers to decimal fields.

### 3. Persistence

Migration v6 creates `market_universe`:

```sql
market_universe(
  venue_id, exchange_symbol, base, quote, quote_volume_24h, tier, updated_at
)
```

Repository methods:

- `replaceMarketUniverse(venueId, entries, updatedAt)` replaces a venue's universe
  atomically.
- `listMarketUniverse(venueId?)` returns entries ordered by quote and numeric volume.

### 4. Tiered scanning

Scanner keeps an in-memory universe per venue and scans due tiers:

- `hot`: assets with a recent valid opportunity (promoted for `signal_cooldown_ms`).
- `top100`: ranked 1-100 by 24h quote volume.
- `top500`: ranked 101-500.

Intervals and cooldown are configurable. If all intervals are zero (test/default legacy
mode), every tier is scanned on each cycle.

### 5. Quote currencies

- S1 evaluates every configured quote currency independently.
- S2 builds triangular paths per venue and per quote, using all selected base assets plus
  the quote as the asset set.

### 6. Bounded concurrency

- Books are prefetched with a bounded worker pool (`fetch_concurrency`, default 8).
- The existing per-venue rate limiter and backoff still apply to every adapter call.

## Configuration

```toml
[scanner]
asset_universe_mode = "top_volume"   # top_volume | explicit
max_base_assets = 100
quote_currencies = ["USDT", "USDC"]
min_24h_quote_volume_usd = "1000000"
universe_refresh_ms = 3600000
scan_interval_hot_ms = 30000
scan_interval_top100_ms = 120000
scan_interval_top500_ms = 600000
signal_cooldown_ms = 300000
fetch_concurrency = 8
```

## Implementation files

- `packages/core/src/types.ts`: `TickerSnapshot`.
- `packages/venues/cex/src/types.ts`: `fetchTickers?`.
- `packages/venues/cex/src/ccxt-adapter.ts`: CCXT ticker normalisation.
- `packages/storage/src/schema.ts`: migration v6.
- `packages/storage/src/repository.ts`: universe persistence.
- `apps/scanner/src/universe.ts`: ranking, filtering, tier assignment.
- `apps/scanner/src/scanner-service.ts`: universe-driven S1/S2, tier scheduling,
  bounded-concurrency prefetch.
- `apps/scanner/src/config.ts` and `config/default.toml`: new settings.
- `apps/scanner/src/main.ts`: wiring.

## Verification

- `npm run check`: 21 test files / 142 tests, typecheck, test typecheck, Prettier, and
  synthetic backtest all pass.
- Coverage: 79.49% statements, 72.20% branches, 76.49% functions, 82.83% lines.
- Unit tests cover volume ranking, minimum-volume filtering, tier assignment, explicit
  mode, and missing-ticker fallback.
- Storage tests cover atomic replacement and numeric ordering of the universe.
- Scanner integration test verifies a volume-ranked universe is persisted and S1 scans
  every selected base and quote.

## Known limitations and next step

- Ticker-based ranking depends on each venue exposing `fetchTickers`; venues without it
  fall back to unranked markets.
- Tier promotion is in-memory and resets on process restart.
- Next: P0-2 two-stage ranking and top-N exact simulation, then P0-3 multi-hop path search.
