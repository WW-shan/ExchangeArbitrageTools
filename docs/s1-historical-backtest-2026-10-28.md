# S1 Historical Backtest: Small-Cap Gate.io / Hotcoin Pairs (2026-10-28)

Read-only quantitative research. No orders, withdrawals, or transfers were
submitted. This document records the historical data, the candidate-selection
logic, the transfer economics, and the live order-book checks performed before
adding a pair to the active S1 watchlist.

## Conclusion

The strongest repeatable candidate is **ULTIMA/USDT**. It is the only pair that
remained strong in all three timeframes and had both directions survive the
stress test:

- `15m / 30d`: 459 eligible windows, 85 stress samples, median net `20.25` bps
  (`Gate -> Hotcoin`) and `15.89` bps (`Hotcoin -> Gate`).
- `5m / 14d`: 570 eligible windows, 296 stress samples, vector flips `207`.
- `1m / 6d`: 435 eligible windows, 548 stress samples, median net `23.93` bps
  (`Gate -> Hotcoin`) and `18.11` bps (`Hotcoin -> Gate`).

The 1-minute ULTIMA windows had a median duration of `60` seconds (p90 `180-240`
seconds). The median time between episodes was about `10` minutes in the
`Gate -> Hotcoin` direction and `30` minutes in the reverse direction. This is
fast enough that a 3-second REST tracker can observe the window, but a manual
workflow must have both venues and both order forms ready before the signal.

The next tier is `LIGHT`, `KAT`, `KAIA`, `BREV`, `AEON`, and `LA`. They appear
often enough to monitor, but either the stress-pass rate is lower, one direction
dominates, or the live order book has not yet confirmed an executable edge.

No pair was profitable in the five-minute live book sample taken immediately
after the backtests. Historical frequency is not a standing order: the scanner
must still observe a fresh, executable spread.

## Recent Open-Source Cross-Check

The follow-up implementation was checked against recent public projects rather
than only older POC examples:

- `nicolasMazuryk/cross-exchange-arbitrage` mirrors WebSocket order books,
  persists ticks, and ranks opportunities with freshness, spread quality, and
  venue health. Its most relevant lesson is that a persistent quote stream and
  live depth matter more than another offline threshold.
- `trokhim03/gap-scanner` explicitly kills ideas at the fee, depth, and latency
  layers before a paper fill. Our tracker already checks fees and depth; the
  missing piece is measuring whether the two legs can land before the book
  moves.
- `atj-khactu/atjte` isolates credentials behind per-venue gateways and keeps a
  dry-run path. We already keep credentials encrypted and execution read-only
  by default; no credential or execution architecture change is needed for this
  research.

The practical conclusion is to keep the new historical screener, but make live
order-book capture the next engineering task. More historical tests alone will
not turn a K-line close into a fill.

## Data And Method

### Sources and windows

| Timeframe | Requested |                          Actual coverage | Candidates | Notes                                                      |
| --------- | --------: | ---------------------------------------: | ---------: | ---------------------------------------------------------- |
| `15m`     |   30 days | 2026-09-28 10:34 to 2026-10-28 10:34 UTC |        188 | Full 30-day sweep of low-volume Gate/Hotcoin intersections |
| `5m`      |   14 days | 2026-10-14 10:51 to 2026-10-28 10:51 UTC |         35 | Focused rerun of the coarse-screen shortlist               |
| `1m`      |    6 days | 2026-10-22 11:00 to 2026-10-28 11:00 UTC |         12 | Final shortlist                                            |

Gate rejects a 1-minute request whose start is more than 10,000 candles ago.
The CLI now rejects an impossible request instead of silently returning no
results. The safe maximum lookbacks are 6 days for `1m`, 34 days for `5m`, and
104 days for `15m`.

### Signal and fill convention

- The signal uses the current candle close on both venues.
- A trade is simulated at the **next candle open**, not at the signal close.
- A `Gate -> Hotcoin` result means buy on Gate.io and sell on Hotcoin.
- Round-trip cost is:

```text
Gate taker fee + Hotcoin taker fee + extra slippage + safety buffer
```

The current effective fees used are `2.97` bps on Gate.io and `4.00` bps on
Hotcoin after the configured `70%` and `80%` spot rebates. The backtest also
charges `10` bps extra slippage, `2` bps safety, and requires at least `5` bps
net profit (`0.01 USDT` at a `20 USDT` notional). The combined gross-spread
threshold is therefore about `23.97` bps.

### Filters

- Both current and next candles must have at least `20 USDT` quote turnover on
  the coarse 30-day sweep and `50 USDT` on the focused 5m/1m runs.
- Cross-venue spreads above `3,000` bps are treated as outliers.
- Eligible samples are grouped into episodes; a gap longer than `1.5` candles
  starts a new episode.
- **Stress samples** require the trade to remain profitable when the buy fills
  at the next candle high and the sell fills at the next candle low. This is
  deliberately pessimistic and is the most useful filter for low-liquidity
  pairs.
- A pair is two-sided when both directions have at least one eligible episode.
  Direction flips count non-overlapping alternations between the two directions.

## Candidate Funnel

1. The 30-day sweep analyzed 188 Gate/Hotcoin `USDT` markets with fresh tickers
   and complete candle history in the `1` to `5,000,000 USDT` volume band. A
   later discovery pass in the same band found 198 names; the additional
   low-volume markets were checked separately, and ULTIMA was rerun at all three
   timeframes. Universe membership changes with ticker freshness, so the list
   is a snapshot, not a permanent exchange universe.
2. Removed stablecoins, leveraged tokens, pairs with no aligned candles, and
   pairs with only one tradable venue.
3. Ranked by recurring episodes, stress samples, direction flips, and median net
   edge after real rebated fees.
4. Re-ran the top 35 at `5m / 14d` and the top 12 at `1m / 6d`.
5. Checked deposit/withdrawal status, withdrawal fees, minimum withdrawals, and
   live order-book depth before creating the watchlist.

## Multi-Period Results

`G -> H` means Gate.io buy / Hotcoin sell. `H -> G` is the reverse. Stress
counts are samples that remain profitable at the next candle high/low.

| Pair        | Period    | G->H episodes | H->G episodes | Stress G->H | Stress H->G | Median net G->H | Median net H->G | Flips |
| ----------- | --------- | ------------: | ------------: | ----------: | ----------: | --------------: | --------------: | ----: |
| ULTIMA/USDT | 15m / 30d |           290 |           169 |          84 |           1 |           20.25 |           15.89 |   194 |
| ULTIMA/USDT | 5m / 14d  |           380 |           190 |         280 |          16 |           17.74 |           12.62 |   207 |
| ULTIMA/USDT | 1m / 6d   |           291 |           144 |         410 |         138 |           23.93 |           18.11 |   148 |
| LIGHT/USDT  | 15m / 30d |           291 |           174 |           9 |           0 |           16.21 |           13.37 |   202 |
| LIGHT/USDT  | 5m / 14d  |           315 |           159 |           8 |           2 |           14.48 |           13.55 |   191 |
| LIGHT/USDT  | 1m / 6d   |           514 |           415 |          20 |           3 |           16.86 |           17.12 |   463 |
| KAT/USDT    | 15m / 30d |           475 |            87 |           6 |           0 |            9.17 |            8.46 |   148 |
| KAT/USDT    | 5m / 14d  |           514 |           115 |          15 |           0 |            9.10 |            8.62 |   184 |
| KAT/USDT    | 1m / 6d   |           470 |           152 |          37 |          11 |           11.14 |           17.59 |   230 |
| KAIA/USDT   | 15m / 30d |           429 |           100 |           7 |           2 |           12.05 |           13.10 |   157 |
| KAIA/USDT   | 5m / 14d  |           389 |            69 |           8 |           4 |           10.53 |            9.33 |   100 |
| KAIA/USDT   | 1m / 6d   |           139 |            36 |          29 |           8 |           11.74 |           11.25 |    54 |
| BREV/USDT   | 15m / 30d |           128 |           113 |           6 |           5 |           21.89 |           22.13 |   139 |
| BREV/USDT   | 5m / 14d  |            77 |            68 |           7 |           9 |           27.73 |           22.44 |    84 |
| BREV/USDT   | 1m / 6d   |            69 |            70 |           6 |           8 |           31.54 |           22.48 |    71 |
| AEON/USDT   | 15m / 30d |           362 |           303 |           2 |           0 |           23.34 |           19.54 |   422 |
| AEON/USDT   | 5m / 14d  |           185 |           141 |           3 |           3 |           20.97 |           19.49 |   186 |
| AEON/USDT   | 1m / 6d   |            67 |            65 |           3 |           5 |           19.42 |           16.63 |    68 |
| LA/USDT     | 15m / 30d |           143 |           163 |           1 |           4 |           21.01 |           25.47 |   149 |
| LA/USDT     | 5m / 14d  |            47 |            76 |           1 |           7 |           23.24 |           24.65 |    52 |
| LA/USDT     | 1m / 6d   |            40 |            52 |           6 |          22 |           59.49 |           22.70 |    35 |

Median net values are in basis points after fees, extra slippage, and safety
buffer. Stress counts are not a promise of fills; they only show that the candle
high/low did not erase the edge.

## Active Watchlist

The machine-readable list is `config/s1-watchlist.json`. Run it with:

```powershell
npm run watch:s1
```

| Pair        | Role      | Why it stays                                                   | Main caveat                                                           |
| ----------- | --------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| ULTIMA/USDT | Primary   | Only pair strong in all three timeframes with two-sided stress | Current book can remain negative for long stretches                   |
| LIGHT/USDT  | Secondary | Highest 1m window count, strong two-sided flip rate            | Only 23 stress samples in 6 days                                      |
| KAT/USDT    | Secondary | High frequency, both directions, low Hotcoin minimum           | Hotcoin deposit/withdrawal disabled; use two-sided inventory rotation |
| KAIA/USDT   | Secondary | Consistent two-sided edges, Gate withdrawal is almost free     | Hotcoin withdrawal is about `1.30 USDT`, so avoid frequent transfers  |
| BREV/USDT   | Secondary | Balanced directions and high median net edge                   | Lower frequency (`~23/day` across both directions)                    |
| AEON/USDT   | Secondary | Balanced directions, 1m median net about `19/17` bps           | Stress-pass rate is low                                               |
| LA/USDT     | Secondary | Strong stress rate and wider edges                             | Lower frequency and a larger Hotcoin minimum withdrawal               |

Removed from the active list:

- `JASMY`, `RAVE`, `THETA`: deposit/withdrawal restrictions or transfer costs
  make inventory recycling impractical.
- `LUNC`, `CORE`, `MYX`, `TRADOOR`: strong on coarse candles but collapsed at
  `1m` or lacked stress confirmation.
- `APEPE`: looked strong at `15m` (41 stress samples) but only 11 windows at
  `5m` and 3 at `1m`; not repeatable enough.
- `TBK`: the apparent edge is not executable. At the live check, Hotcoin's best
  bid/ask was about `0.2400 / 0.2547` (roughly 600 bps wide), so a K-line close
  is not a sellable bid. The five-minute 1m rerun also collapsed.
- `BONK`, `PHA`, `MARSCOIN`, `CHIP`: mostly one-sided or too few stress samples
  for a two-sided inventory rotation.

## Transfer And Inventory Economics

Withdrawal fees are quoted in base units and converted at the market price on
2026-10-28. A `20 USDT` batch cannot recover these costs from a handful of
10-30 bps trades, so **do not withdraw after every trade**.

| Pair   |    Price |            Gate withdrawal |         Hotcoin withdrawal | Hotcoin deposit | Minimum Hotcoin withdrawal |
| ------ | -------: | -------------------------: | -------------------------: | --------------- | -------------------------: |
| ULTIMA |  1238.70 | 0.0003 ULTIMA (~0.37 USDT) | 0.0006 ULTIMA (~0.74 USDT) | Open            |                 ~7.43 USDT |
| LIGHT  |  0.26957 |    1.83 LIGHT (~0.49 USDT) |       7 LIGHT (~1.89 USDT) | Open            |                ~18.87 USDT |
| KAT    | 0.004271 |     11.84 KAT (~0.05 USDT) |       100 KAT (~0.43 USDT) | **Closed**      |                 ~0.43 USDT |
| KAIA   |  0.03502 |  0.0292 KAIA (~0.001 USDT) |       37 KAIA (~1.30 USDT) | Open            |                 ~1.30 USDT |
| BREV   |  0.08463 |    12.14 BREV (~1.03 USDT) |      8.4 BREV (~0.71 USDT) | Open            |                 ~0.71 USDT |
| AEON   |  0.02843 |    17.34 AEON (~0.49 USDT) |       36 AEON (~1.02 USDT) | Open            |                 ~2.84 USDT |
| LA     |  0.05929 |      17.27 LA (~1.02 USDT) |         26 LA (~1.54 USDT) | Open            |                 ~4.15 USDT |

At the current account size, the correct model is **two-sided inventory
rotation**:

1. Buy the base asset once on the venue that will be the sell leg.
2. Keep USDT on the other venue for the buy leg.
3. After `Gate -> Hotcoin`, the account has base on Gate and USDT on Hotcoin.
4. The next `Hotcoin -> Gate` trade uses that inventory without a withdrawal.
5. Only transfer or resize inventory when the imbalance becomes structural.

The account can support roughly `20 USDT` per leg if it holds about `20 USDT` of
base on one venue and `20 USDT` of quote on the other. A full two-sided rotation
does **not** need four separate balances after the initial inventory purchase,
but the initial purchase is a market exposure and must be manually confirmed.

## Live Validation

### One-shot book scan

`scan-longtail.ts` checked 60 shortlisted bases against the real order book at
about 10:52 UTC. 120 books and 120 directed routes were evaluated with zero book
errors. Only `HTX/USDT Gate -> Hotcoin` was clean in that single snapshot:

The `balance_incomplete` flag in the `watch:s1` output is expected until a fresh
balance snapshot is loaded. It does not reject the market-data route; it only
means the executor has not yet verified the base and quote balances.

- Gross `25.36` bps, best net `13.38` bps at `20 USDT`.
- Maximum eligible notional `20 USDT`, no stale-book flag.
- Caveat: Gate 24-hour volume was only about `821 USDT`, the edge was one-way,
  and the 1-minute history had only 5 windows in 3 days. It is a one-off
  inventory-sale signal, not an active rotation pair.

`INC/USDT Gate -> Hotcoin` reached `24.33` bps gross but only `0.47` bps net and
failed the profit threshold. `ULTIMA/USDT` was `6.52` bps gross and negative
after costs at that instant.

### Five-minute tracking

REST order books were sampled every 3 seconds for 100 samples per direction:

| Pair        | G->H max gross | H->G max gross | Eligible samples |
| ----------- | -------------: | -------------: | ---------------: |
| ULTIMA/USDT |      -1.77 bps |     -28.46 bps |          0 / 200 |
| LIGHT/USDT  |     -46.68 bps |     -52.69 bps |          0 / 200 |
| KAT/USDT    |     -35.09 bps |     -46.84 bps |          0 / 200 |
| KAIA/USDT   |     -57.14 bps |     -70.82 bps |          0 / 200 |

This is a negative result, and it is useful: none of the four should have been
traded during that window. The scanner must keep waiting for a fresh
cross-venue book, not act on the historical median.

An additional 30-minute ULTIMA run collected 599 samples per direction. It also
had **0 eligible samples**. The maximum gross edge was only `0.48` bps
(`Gate -> Hotcoin`) and `6.94` bps (`Hotcoin -> Gate`), both far below the
`~23.97` bps entry threshold. ULTIMA is the best historical candidate, not a
standing live opportunity.

## What This Does Not Prove

- OHLCV close is not an executable bid or ask, especially on Hotcoin low-volume
  markets. This was demonstrated by `TBK` and is why live book tracking remains
  mandatory.
- The simulation assumes the full `20 USDT` fills at the next open in both
  markets; it has no queue position, partial-fill, or cancellation model.
- It uses public candles, not captured order-book history. It does not prove
  that a 1-minute window lasts long enough for both orders to land.
- It does not include the initial inventory purchase, its spread, or the
  price-risk while the first sell leg is being prepared.
- It does not include API latency, exchange maintenance, or a temporary
  withdrawal freeze.
- Rebates are modeled as a reduction in taker fees. If a rebate is paid later
  than the trade, the account still needs enough working capital to cover the
  gross fee.

## Reproduce

```powershell
. .\scripts\load-env.ps1

npx tsx scripts/backtest-history.ts --config config/longtail.toml `
  --days 30 --timeframe 15m --min-volume 1 --max-volume 5000000 `
  --max-bases 2000 --max-ticker-age-ms 86400000 `
  --notional 20 --min-profit-usd 0.01 --min-net-profit-bps 5 `
  --safety-buffer-bps 2 --extra-slippage-bps 10 --min-candle-volume-usd 20 `
  --out data/history-wide-15m-30d.json

npx tsx scripts/backtest-history.ts --config config/longtail.toml `
  --days 14 --timeframe 5m --bases ULTIMA,LIGHT,KAT,KAIA,BREV,AEON,LA `
  --notional 20 --min-candle-volume-usd 50 `
  --out data/history-focus-5m-14d.json

npx tsx scripts/backtest-history.ts --config config/longtail.toml `
  --days 6 --timeframe 1m --bases ULTIMA,LIGHT,KAT,KAIA,BREV,AEON,LA `
  --notional 20 --min-candle-volume-usd 50 `
  --out data/history-final-1m-6d.json

npm run watch:s1
```

## Decision

- Monitor `ULTIMA` as the primary S1 pair.
- Keep `LIGHT`, `KAT`, `KAIA`, `BREV`, `AEON`, and `LA` on the active watchlist.
- Do not trade from historical medians. Require a fresh two-sided book, no
  stale-book or outlier flag, and an executable net edge above the configured
  threshold.
- Do not enable live execution or automated transfers as part of this
  backtest. The next live action is still a manually confirmed paper/read-only
  cycle with pre-positioned inventory.
