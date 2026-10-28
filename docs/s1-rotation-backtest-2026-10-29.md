# S1 Two-Sided Rotation Backtest (2026-10-29)

> Superseded for pair selection by
> [s1-full-universe-backtest-2026-10-29.md](s1-full-universe-backtest-2026-10-29.md).
> This document remains as the earlier focused-sample record.

Scope: Gate.io and Hotcoin spot, USDT-quoted low-volume pairs. This is
read-only research. No order, withdrawal, or transfer was submitted.

## Decision

Use **KAT/USDT as the primary rotation pair** and **LIGHT/USDT as the
secondary pair**.

- KAT has the best small-account economics: low step cost, low fee dust, and
  frequent two-sided signals.
- LIGHT has the highest direction-flip count, but its stress-pass rate is
  lower and Gate step dust is larger. It needs a higher live entry threshold.
- ULTIMA has the strongest stress history, but its high price and 0.0001 step
  create roughly 0.10 USDT of dust per 20 USDT buy. It is watch-only at the
  current account size.

The five-minute live book sample taken after the backtest produced **zero**
eligible samples for KAT, LIGHT, and ULTIMA. Historical frequency is a
candidate filter, not a standing order.

## Historical data

Source files:

- `data/history-final-1m-6d.json` (1-minute candles, six days)
- `data/history-focus-5m-14d.json`
- `data/history-wide-15m-30d.json`

Signal convention: current candle close, execution at the next candle open,
effective fees 2.97 bps on Gate and 4.00 bps on Hotcoin, plus 10 bps extra
slippage and 2 bps safety buffer. Stress samples require the next candle
low/high to remain profitable.

| Pair   | Direction       | Episodes/day | Stress samples | Median net bps | P90 net bps | Flips |
| ------ | --------------- | -----------: | -------------: | -------------: | ----------: | ----: |
| KAT    | Gate -> Hotcoin |        78.34 |             37 |          11.14 |       43.77 |   230 |
| KAT    | Hotcoin -> Gate |        25.34 |             11 |          17.59 |       59.92 |   230 |
| LIGHT  | Gate -> Hotcoin |        85.68 |             20 |          16.86 |       53.10 |   463 |
| LIGHT  | Hotcoin -> Gate |        69.17 |              3 |          17.12 |       48.16 |   463 |
| ULTIMA | Gate -> Hotcoin |        48.51 |            410 |          23.93 |      129.27 |   148 |
| ULTIMA | Hotcoin -> Gate |        24.01 |            138 |          18.11 |       60.58 |   148 |
| BREV   | Gate -> Hotcoin |        11.50 |              6 |          31.54 |       88.56 |    71 |
| BREV   | Hotcoin -> Gate |        11.67 |              8 |          22.48 |       74.16 |    71 |

The 6-day 1-minute sample is short. It is enough to rank candidates, not to
prove a live edge.

## Fee dust at 20 USDT

Spot buys are charged in the received base asset on the fills observed so far:
Gate charged TBK on a TBK buy, and Hotcoin charged TBK on the inventory build.
The next sell usually receives USDT, so the sell fee does not reduce base.

The buy-side dust is:

```text
gross base = floor(notional / ask / step) * step
fee base   = gross base * gross fee rate
net base   = gross base - fee base
dust       = net base - floor(net base / step) * step
```

Using the 2026-10-29 snapshot and gross fees:

| Pair   | Venue   |   Step | Fee dust at 20 USDT | Decision                               |
| ------ | ------- | -----: | ------------------: | -------------------------------------- |
| KAT    | Gate.io |    0.1 |   about 0.0002 USDT | acceptable                             |
| KAT    | Hotcoin |      1 |   about 0.0035 USDT | acceptable                             |
| LIGHT  | Gate.io |    0.1 |   about 0.0067 USDT | acceptable                             |
| LIGHT  | Hotcoin |   0.01 |   about 0.0026 USDT | acceptable                             |
| ULTIMA | Gate.io | 0.0001 |   about 0.1036 USDT | too high                               |
| ULTIMA | Hotcoin | 0.0001 |   about 0.0842 USDT | too high                               |
| BREV   | Gate.io |    0.1 |   about 0.0051 USDT | acceptable                             |
| BREV   | Hotcoin |    0.1 |   about 0.0016 USDT | acceptable, but Hotcoin min is 15 USDT |

KAT and LIGHT can absorb the dust at a 10-20 USDT batch. ULTIMA cannot: one
fractional lot can consume more than the expected edge.

## Live sample

On 2026-10-29, `scripts/track-spread.ts` sampled both directions every three
seconds for five minutes:

| Pair   | Samples per direction | Positive gross samples | Fee-break-even samples | Eligible |
| ------ | --------------------: | ---------------------: | ---------------------: | -------: |
| KAT    |                   100 |                      0 |                      0 |        0 |
| LIGHT  |                   100 |                      0 |                      0 |        0 |
| ULTIMA |                   100 |   26 (Gate -> Hotcoin) |                      0 |        0 |

The market was quiet during the sample. This is a negative result, not a
reason to lower the threshold. The auto runner must wait for a fresh,
profitable book.

A 15-minute follow-up used 299 KAT samples and 300 LIGHT samples per
direction. KAT and LIGHT still had zero fee-break-even samples, and their
maximum gross spreads were negative. The wide snapshot also checked 80 pair
books: only TBK and HTX had a clean Gate-to-Hotcoin route. TBK was rejected by
the dust/size analysis, and HTX had only about one episode per day and was not
two-sided in the 5-minute history. Those two are not rotation replacements.

## Selection

1. **KAT/USDT** is the first live rotation pair. It has the cleanest dust
   economics and enough two-sided history.
2. **LIGHT/USDT** is second. Use it only after KAT completes a clean soak and
   if the live stress pass rate is acceptable.
3. **ULTIMA/USDT** stays watch-only until the batch size is large enough to
   amortize its step dust.
4. **BREV/USDT** is a reserve candidate; its frequency is lower and Hotcoin
   requires a 15 USDT minimum.

## What This Does Not Prove

- OHLCV closes are not executable bids or asks. The five-minute live sample
  proved that historical edges can disappear.
- The backtest does not model queue position, partial fills, API latency, or
  a venue freezing the book.
- Rebates are accrued later. The account must still fund the gross fees.
- A two-sided rotation can wait a long time for the reverse direction. It does
  not guarantee that the spread returns.

Next: seed one side only, run a fresh 15-minute and then 24-hour read-only
book capture, and keep automatic order submission disabled until the seed,
dust, and reconciliation gates pass.
