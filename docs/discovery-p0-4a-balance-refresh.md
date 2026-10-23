# Discovery P0-4a: Automatic Balance Refresh

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Automatically recognise per-venue balances so cross-venue inventory-mode discovery can
know which assets are actually available on each exchange, without manual snapshots.

## Design

### 1. Credentials

- Uses the existing encrypted secret store (`ARB_SECRET_STORE_PATH`,
  `ARB_SECRET_STORE_KEY`).
- Only credentials with `role = "read_only"` are used for balance refresh.
- Trade credentials are never used by this command.
- If no read-only credential exists, the command fails closed with a clear error.

### 2. Refresh service

`apps/executor/src/balance-service.ts`:

```ts
refreshBalances(repository, venues, now): { refreshed, errors }
```

- Calls `adapter.fetchBalances(credentials)` for each venue.
- Persists every balance to `balances` and records an inventory snapshot.
- Isolates failures per venue: one venue failing does not stop the others.
- Records a `balance_refresh_failed` risk event for each failed venue.

### 3. CLI

`npm run executor:balances -- [--loop] [--interval-ms <ms>]`

- One-shot by default.
- `--loop` refreshes continuously (default interval 60s), which is the automatic mode.
- Prints only counts and errors, never API keys or secrets.
- Writes an operator audit row for each refresh.

### 4. Storage queries

New repository methods:

- `latestBalances({ maxAgeMs, now })`: latest balance per venue/account/currency, with an
  age filter.
- `balanceFor(venueId, asset, { maxAgeMs, now })`: latest free amount for one asset.

These are the read path used by P0-4b inventory edges.

## Usage

```powershell
# one-shot
npm run executor:balances

# automatic continuous refresh every 60 seconds
npm run executor:balances -- --loop --interval-ms 60000
```

## Verification

- `npm run check`: 22 test files / 146 tests, typecheck, test typecheck, Prettier, and
  synthetic backtest pass.
- Coverage: 79.94% statements, 72.09% branches, 76.92% functions, 83.43% lines.
- Tests cover persistence, latest-value lookup, age expiry, and per-venue failure
  isolation with a recorded risk event.

## Next step

P0-4b: cross-venue multi-hop in inventory mode, using `(venue, currency)` nodes and the
balances persisted here. Transfers remain disabled.
