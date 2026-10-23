# Discovery P1-2: Opportunity Lifetime and Historical Replay

Status: implemented and verified on 2026-10-22 (Asia/Hong_Kong).

## Goal

Measure how long an opportunity actually lasts and replay captured order books
through the real scanner pipeline, instead of only checking one synthetic sample.

## Opportunity lifetime

The existing `opportunity_episodes` table already groups consecutive valid samples.
P1-2 makes it usable for analysis:

- `closeOpenEpisode` now keeps `episode_end` at the last sample where the
  opportunity was still valid. It no longer extends the episode to the first invalid
  sample, so `duration_ms` is the true observed lifetime.
- `ArbitrageRepository.episodeSummary()` returns per strategy: episode count, open
  episodes, total samples, median / p90 / max duration, and median maximum profit.
- `ArbitrageRepository.opportunityDecay()` returns per strategy: episode count,
  median duration, median first-to-last profit change in basis points, and the
  number of improving versus decaying episodes.
- `ArbitrageRepository.opportunityCountsByStrategy()` returns total and valid
  opportunity counts for replay reports.

## Historical replay

`apps/scanner/src/replay.ts` implements `runReplay(fixture, options)`:

- `ReplayCexAdapter` serves a fixture market and swaps in the order books for the
  current sample.
- A real `ScannerService` is constructed with a mutable clock. Each sample sets the
  books and the clock, then calls `scanOnce()`. This means replay exercises the
  same universe, S1, S2, cross-venue, optimal-sizing, episode and persistence code
  as production.
- Samples are sorted by `sampledAt`; a non-positive or non-finite timestamp aborts
  the replay.
- Balances in the fixture switch cross-venue mode to `inventory`, so multi-hop
  cross-venue opportunities can be replayed too.
- At the end, stale episodes are closed and the report aggregates lifetime, decay,
  per-strategy counts and optional paper-trade totals.

The fixture format matches `fixtures/backtest/*.json`:

```json
{
  "requestedNotional": "30",
  "settings": { "minProfitUsd": "0.25", "...": "..." },
  "markets": { "gateio": { "...": "..." }, "mexc": { "...": "..." } },
  "samples": [{ "sampledAt": 1762000000000, "gateio": { "...": "..." }, "mexc": { "...": "..." } }],
  "balances": [{ "venueId": "gateio", "currency": "USDT", "free": "1000" }]
}
```

## Usage

```powershell
npm run replay -- --fixture fixtures/backtest/s1-cake-usdt.json
npm run replay -- --fixture fixtures/backtest/captured-CAKE-USDT.json --paper
```

The report is written to `data/replay-report-<name>.json` and printed to stdout.

## Implementation files

- `packages/storage/src/repository.ts`: lifetime, decay and count queries; episode
  close semantics.
- `apps/scanner/src/replay.ts`: replay adapter and `runReplay`.
- `scripts/replay.ts`: CLI wrapper and report writer.
- `package.json`: `npm run replay`.

## Verification

- `npm run check` passes: typecheck, test typecheck, Prettier, 25 test files /
  167 tests, and the synthetic backtest.
- Coverage: 81.55% statements, 72.62% branches, 79.59% functions, 84.88% lines.
- Storage test records three valid samples plus one invalid sample and asserts a
  10-second lifetime, three samples, one decaying episode and -4000 bps decay.
- Replay test asserts a five-sample replay produces one S1 episode with a
  10-second lifetime, negative median decay, and a cross-venue S2 opportunity when
  balances are supplied.
- `npm run replay -- --fixture fixtures/backtest/s1-cake-usdt.json` reports
  20 samples, 20 valid opportunities, one closed episode of 95 seconds and
  -52.8 bps median decay.

## Limitations

- Replay fidelity is limited by the captured fixture. It does not model queue
  position, exchange latency, or order rejection probabilities.
- Paper simulation during replay uses the existing scripted gateway, so it is a
  regression check, not a live fill model.
- Long-horizon historical tick storage is still an external data problem.
