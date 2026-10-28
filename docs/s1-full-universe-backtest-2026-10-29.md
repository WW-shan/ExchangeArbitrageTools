# Full Low-Volume Universe Backtest (2026-10-29)

## Scope

The run covered every Gate/Hotcoin USDT market intersection in the configured
low-volume band: 188 candidates, 188 analyzed, zero pair errors.

```text
timeframe: 1m
window: 6 days (Gate's 10,000-candle window)
min 24h quote volume: 1 USDT
max 24h quote volume: 5,000,000 USDT
notional: 20 USDT
min net edge: 5 bps
safety buffer: 2 bps
extra slippage: 10 bps
```

The report is `data/history-all-1m-6d-2026-10-29.json`; the resorted output is
`data/rotation-history-ranking.json`.

## Ranking by raw episode count

| Pair   | Total episodes | Per day | Direction flips | Stress samples | Max net bps | Note                              |
| ------ | -------------: | ------: | --------------: | -------------: | ----------: | --------------------------------- |
| TBK    |           1107 |  184.52 |             368 |           2750 |     3179.47 | outlier-heavy, unstable live book |
| LIGHT  |           1011 |  168.52 |             494 |             35 |      662.55 | selected primary                  |
| KAT    |            749 |  124.85 |             262 |             65 |      214.04 | selected reserve                  |
| HUMA   |            734 |  122.35 |             394 |              6 |      493.43 | no current executable edge        |
| DNA    |            708 |  118.01 |             384 |              2 |      318.73 | no current executable edge        |
| ULTIMA |            657 |  109.51 |             227 |            849 |      321.28 | wide live book / stale snapshot   |

Direction detail for the selected pair:

| Pair  | Direction       | Episodes | Per day | Stress | Median net |   P90 net |
| ----- | --------------- | -------: | ------: | -----: | ---------: | --------: |
| LIGHT | Gate -> Hotcoin |      556 |   92.68 |     29 |  16.12 bps | 50.22 bps |
| LIGHT | Hotcoin -> Gate |      455 |   75.84 |      6 |  16.73 bps | 44.86 bps |

## Why TBK is not the primary

TBK has the highest raw count, but its history contains a 31.8% maximum net
print and 2,750 stress-passing samples, far outside the rest of the top group.
That pattern is consistent with low-liquidity repricing rather than a stable
two-sided book. A fresh six-pair live snapshot also showed TBK as the only
positive route, but with pair skew and incomplete capacity. It is watch-only;
the highest raw episode count is not enough evidence of a repeatable edge.

## Current live check

A live snapshot of TBK, LIGHT, KAT, HUMA, DNA, and ULTIMA found:

- only TBK Gate -> Hotcoin was clean at about 67 bps at that instant;
- LIGHT Gate -> Hotcoin was about -62 bps;
- LIGHT Hotcoin -> Gate was about -67 bps;
- KAT both directions were negative;
- HUMA and DNA both directions were negative.

The market therefore does not offer a LIGHT entry at the time of seeding. The
supervisor must wait for a fresh executable edge rather than forcing a trade.

## Seed state

One side was prepared at 10 USDT:

```text
Hotcoin: buy 37.5 LIGHT at 0.26596
Gate:    keep about 10.51 USDT
ready direction: Gate -> Hotcoin
```

The fill leaves Gate quote plus Hotcoin base, so the dominant historical
direction is funded first. After a completed Gate -> Hotcoin round trip the
inventory becomes ready for Hotcoin -> Gate.
