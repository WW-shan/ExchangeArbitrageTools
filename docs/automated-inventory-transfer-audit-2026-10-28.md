# Automated Inventory Transfer and S1 Audit - 2026-10-28

## 1. Verdict

The S1 engineering chain and the automated inventory-transfer chain are internally
complete and automated-tested. They are **not** live-accepted: no real private API
key was used in this audit, no withdrawal was submitted, and no live two-leg
inventory loop has been observed.

Current accounting from `docs/design-acceptance-matrix.md`:

| Area                           | Internal | External |                     Overall |
| ------------------------------ | -------: | -------: | --------------------------: |
| S1 CEX-CEX                     |    15/15 |      0/6 |               15/21 (71.4%) |
| S2 Triangular                  |      7/7 |      0/0 | 7/7 (100%, paper/read-only) |
| S3 CEX-DEX                     |    11/11 |      0/4 |               11/15 (73.3%) |
| S4 DEX-DEX                     |      6/6 |      0/1 |                 6/7 (85.7%) |
| Four-goal total                |    39/39 |     0/11 |               39/50 (78.0%) |
| Automated transfers (separate) |    19/19 |      0/5 |               19/24 (79.2%) |

The percentages are engineering accounting, not a live-readiness claim.

## 2. Verification evidence

- Full `npm run check` passed: 314 tests, typecheck, test typecheck, Prettier and
  synthetic backtest.
- Gate public probe through `socks5://127.0.0.1:10808`: 2,182 spot markets,
  2,183 tickers, REST order book, WS order book, all readable.
- Hotcoin public probe through the same proxy: 374 markets, 374 tickers, REST
  order book, WS order book, all readable.
- Gate live currency probe on 2026-10-28:
  - `INC`: ERC20 only.
  - `TBK`, `HTX`: TRC20 only.
  - `CAKE`, `ETH`, `USDT`: BSC/BEP20 is listed.
  - This means `INC/BSC` is not a valid Gate transfer route.
- Low-liquidity scans: an 80-book pass found 2 fee-break-even routes, both
  rejected as `extreme_spread` + `price_outlier`; a wider pass over all 74
  current volume-band candidates (148 books, 0 book errors) found 0
  fee-break-even, 0 clean and 0 eligible routes. INC remained `stale_book`.
- WS S1 smoke with the live-test latency budget (3,000ms): 3 cycles, 0 book
  errors; 24-26 directions were prefiltered and no edge survived fees. The
  earlier 500ms smoke errors were correct fail-closed behavior, not a broken feed.
- Gate WS through the proxy was usable but slower; Hotcoin WS was faster in this
  sample. Proxy p95 feed latency was roughly 1.8s for Gate and 0.7s for Hotcoin.

## 3. Layer-by-layer check

### 3.1 Repository and build

- `tsconfig.build.json`, test typecheck, Vitest and synthetic backtest are wired.
- Decimal is used for money; timestamps are UTC epoch milliseconds.
- SQLite migrations are versioned and backed up before pending migrations.
- Migration v9 adds the transfer execution lease.

### 3.2 Gate adapter

- CCXT 4.5.89 is pinned.
- Spot-only market loading avoids Gate delivery endpoints.
- Market/ticker/order-book/WS reads were verified through the proxy.
- Gate's CCXT deposit-address selector uses unified code `BEP20`, while the
  transfer layer normalizes the chain to `BSC`. The adapter now translates
  `BSC -> BEP20` for deposit-address and withdrawal calls. Without this, Gate
  deposit-address selection can throw `network not found`.
- Gate exposes currency network flags but no reliable per-network fee/minimum in
  the live `fetchCurrencies()` payload used here. The allowlist fee remains a
  mandatory manual attestation.

### 3.3 Hotcoin adapter

- Native signed REST, public REST and WebSocket are implemented.
- Transfer status mapping was corrected:
  - Deposit `5-risk frozen` -> failed.
  - Withdrawal `5-processing` -> processing, not failed.
- Same-chain deposit-address ambiguity now fails closed unless exactly one
  address is selected.
- `selected` is accepted as boolean, numeric 1, string `"1"` or string `"true"`.
- Hotcoin does not expose a public currency-network/minimum metadata method in
  this adapter. Preflight validates the live deposit address and chain, but
  withdrawal enablement, minimum and fee require manual configuration and real
  key verification.

### 3.4 S1 discovery and capacity

- Low-liquidity universe uses the two-venue intersection and a volume band; it
  does not fill quotas with unrelated top-volume bases.
- Capacity is computed by consuming visible book levels, not by inferring hidden
  liquidity.
- Fee scenarios, break-even notional, profitable notional, eligible notional,
  balance caps, stale books, price outliers and extreme spreads are reported.
- Current live result: no clean/eligible S1 route. TBK/EDGE large spreads were
  correctly classified as suspicious, not as opportunities.
- S1 is an inventory-relative strategy: both venues need pre-positioned assets.
  It is not atomic cross-exchange arbitrage and cannot wait for a transfer after
  seeing a short-lived edge.

### 3.5 Transfer planning

- Same-asset transfers only; no hidden swaps.
- Fresh balances are required. A missing currency row can mean zero if the venue
  returned other fresh balances, but a stale row for the target currency now
  fails planning instead of being silently treated as zero.
- Daily limits are aggregated across all legs with the same source venue, asset
  and network in one plan and in one preflight. Two individually legal legs can
  no longer combine into an over-limit batch.
- `withdraw_fee` is a reserve for source-balance checking. Whether the exchange
  deducts the fee from the requested amount or charges it on top must be measured
  on the first live transfer; target balances can otherwise undershoot by the fee.

### 3.6 Execution state machine

- One SQLite execution lease prevents two processes from executing the same
  batch. A second process gets `batch_execution_locked` and submits nothing.
- Preflight results are applied in one transaction. If the batch starts executing
  while a second preflight is still in flight, the late preflight is discarded
  instead of overwriting `WITHDRAWING`/`ARRIVED` legs.
- At most one transfer batch is active.
- The second leg is not submitted until the first leg is `ARRIVED`.
- Unknown withdrawal results enter `SAFE_STOP`; there is no re-submit.
- Source withdrawal records are rechecked for currency, address, tag and network
  before their status is trusted.
- Withdrawal and deposit timeouts are independent: a stuck source becomes
  `UNKNOWN`; a completed source with no destination credit becomes
  `DEPOSIT_TIMEOUT`.
- In-flight batches cannot be manually resolved; reconcile first.
- Arrival requires a matching destination deposit record and a received amount
  no lower than the requested amount minus the known fee.

### 3.7 Security and audit

- Read-only and trade credentials are forced to `withdrawalPermission=false`.
- Withdrawal credentials require `withdrawalPermission=true` and
  `ipWhitelistVerified=true`; the trade API key may be reused.
- Secrets use scrypt + AES-256-GCM and are stored outside SQLite.
- Transfer batches, legs, source/destination record IDs, tx IDs, errors, risk
  events and operator actions are persisted.
- Live execution remains closed by default: `live_enabled=false`,
  `kill_switch=true`, `transfers.enabled=false`, manual confirmation required.

## 4. Fixed in this audit

1. Gate `BSC -> BEP20` translation for CCXT deposit-address and withdrawal.
2. Hotcoin withdrawal `5-processing` status classification; deposit `5-risk`
   remains failed.
3. Hotcoin ambiguous same-chain deposit-address fail-closed behavior.
4. Atomic transfer execution lease (migration v9).
5. Atomic preflight writeback that cannot clobber an executing batch.
6. Cumulative daily-limit enforcement across legs.
7. Stale target-currency balances fail planning instead of becoming zero.
8. Source withdrawal record identity checks.
9. Independent withdrawal/deposit timeouts.
10. In-flight transfer resolution guard.

## 5. What is still missing

### P0 - required before real money

- Real read-only, trade and withdrawal credentials for Gate.io and Hotcoin,
  with IP whitelists. Shared trade/withdrawal keys are allowed by default and
  increase the blast radius if the shared key is compromised.
- One exact asset/network pair supported by both venues. Do not use `INC/BSC`;
  Gate currently exposes INC on ERC20 only.
- Hotcoin live deposit address, chain/tag, withdrawal enabled state, fee and
  minimum. The adapter cannot read all of this without a real key.
- First single-leg withdrawal at the minimum amount, with arrival evidence.
- First supervised two-direction inventory loop.
- 24-hour read-only soak, 20 real paper batches and 10 manual live batches.

### P1 - engineering follow-ups

- Measure whether each venue deducts the withdrawal fee from the amount or charges
  it on top; only then can target balances be grossed up exactly.
- Hotcoin currency-network metadata or a documented manual verification file.
- Historical tick capture and walk-forward backtesting; current backtest is
  synthetic plus captured fixture replay.
- Alerts, structured logs, Prometheus/Grafana, Docker and CI.
- Multi-account allocation and KMS/Vault rotation.
- Multi-hop graph routing is outside S1; S1 remains a two-venue pair strategy.

## 6. Next exact checkpoints

1. Supply real keys and run `npm run live:readiness` with `config/live-test.toml`.
2. Choose one asset/network pair and verify both live deposit addresses.
3. Run `rebalance:execute --targets ...`, then `--preflight`, then `--dry-run`.
4. Execute one minimum-size single leg with `--execute --confirm-batch <id>`.
5. Reconcile to `ARRIVED`, record the actual fee and latency.
6. Add the reverse leg only after the first leg is proven.
7. Run the 24-hour soak and manual live batches before enabling automated
   transfers without close supervision.

## 7. Commands used in this audit

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run probe:venues -- --venues gateio,hotcoin --timeout-ms 30000
npm run scan:longtail:test
npm run smoke:discovery
npm run check
```
