# Gate + Bitget S1 Backtest (2026-10-29)

## Scope

Read-only research for Gate.io and Bitget spot markets. Hotcoin was excluded.
The full low-volume USDT intersection contained 421 candidates and all 421
were analyzed without a pair-load error.

```text
timeframe: 1m
window: 6 days
quote: USDT
volume band: 1 to 5,000,000 USDT per 24h
notional: 20 USDT
min net edge: 5 bps
safety buffer: 2 bps
extra slippage: 10 bps
max sane spread: 3000 bps
```

The reports are:

- `data/history-gate-bitget-1m-6d-2026-10-29.json`
- `data/rotation-history-gate-bitget-ranking.json`
- `data/gate-bitget-live-shortlist.json`
- `data/gate-bitget-live-finalists.json`
- `data/track-gate-bitget-WARD.json`
- `data/track-gate-bitget-KAT.json`
- `data/track-gate-bitget-XCX.json`

These files are research output under `data/` and are not committed.

## Method

The backtest uses the same convention as the earlier full-universe run:

1. A signal is evaluated on the current 1-minute close.
2. Execution is assumed at the next 1-minute open.
3. Both venues' taker fees are charged, plus 2 bps safety and 10 bps extra
   slippage.
4. A sample must also survive the next candle's high/low stress check.
5. Candles with less than 20 USDT quote volume are rejected.
6. Episodes are separated by a 1.5-candle gap.

Gate uses the account file's 9.9 bps gross fee with the configured 70% rebate,
or about 2.97 bps effective. Bitget is conservatively modeled at 10 bps with no
rebate because no Bitget account tier has been verified yet.

## Full ranking

Top candidates by total eligible episodes across both directions:

| Pair       | Episodes | Per day | Flips | Stress | Min direction | Gate 24h vol | Bitget 24h vol |
| ---------- | -------: | ------: | ----: | -----: | ------------: | -----------: | -------------: |
| WARD/USDT  |      321 |   53.59 |    87 |    287 |           137 |       48,938 |        141,415 |
| KAT/USDT   |      358 |   59.77 |   144 |     74 |           103 |      252,555 |        140,321 |
| XCX/USDT   |      197 |   32.89 |    97 |     55 |            85 |       12,082 |        126,157 |
| DTEC/USDT  |      647 |  108.02 |    43 |    885 |           289 |       34,305 |        115,283 |
| IRYS/USDT  |      664 |  110.86 |   104 |  1,676 |           124 |    1,452,076 |        738,291 |
| BIRB/USDT  |    1,005 |  167.79 |   473 |     54 |           395 |      365,815 |        519,555 |
| BMT/USDT   |      646 |  107.85 |   134 |    743 |            88 |      487,575 |        279,911 |
| ORDER/USDT |      668 |  111.53 |   300 |     47 |           299 |    1,136,530 |        191,712 |
| AIN/USDT   |      822 |  137.24 |   453 |     11 |           369 |    4,852,629 |        541,201 |

Raw episode count alone is not enough. BIRB and AIN have very high counts but
only 3.5% and 1.3% of eligible samples survive the next-candle stress check.
BMT and IRYS have strong stress histories but are strongly one-sided. DTEC has
the best combination of frequency and stress among the non-finalists.

## Finalists

### WARD/USDT: primary candidate

```text
gateio->bitget: 184 episodes, 30.72/day, 183 stress, median 58.06 bps, p90 287.86
bitget->gateio: 137 episodes, 22.87/day, 104 stress, median 45.95 bps, p90 129.69
```

WARD is the only candidate that was continuously executable in the 5-minute
live sample:

```text
gateio->bitget: 100/100 samples eligible
bitget->gateio: 0/100 samples eligible
median gross: 168.31 bps
p95 gross: 194.43 bps
max eligible notional: 20 USDT
```

The fresh finalist scan showed `gross=215.24 bps`, `net=197.05 bps`, with
`maxEligible=20` and `binding=notional_cap`. The research scanner classified it
as `review` because the gross spread exceeded its 200 bps `suspicious_spread`
threshold. The live book was fresh and had real depth: Gate asks included
577 WARD at 0.003446 and 71,522 WARD at 0.00347; Bitget bids included 24,472
WARD at 0.003512.

WARD is listed on BSC at Gate and BASE at Bitget, but CoinGecko identifies both
as the same Warden project. There is no transfer path in the strategy; this is
inventory rotation only. The cross-chain listing can still produce a structural
premium, so start with 5-10 USDT, not the full 20 USDT.

### KAT/USDT: stable secondary candidate

```text
bitget->gateio: 255 episodes, 42.57/day, 72 stress, median 26.83 bps, p90 72.18
gateio->bitget: 103 episodes, 17.20/day, 2 stress, median 19.64 bps, p90 50.95
```

The 5-minute live sample was eligible in 96/100 samples for
`bitget->gateio`, with a median gross spread of 52.03 bps. The fresh finalist
scan still showed a clean `bitget->gateio` route at `gross=36.94 bps` and
`net=17.16 bps`, with 20 USDT capacity.

Gate has 1 KAT minimum amount / 3 USDT minimum notional; Bitget has 0 minimum
amount / 1 USDT minimum notional. Amount steps are 0.1 on Gate and 0.01 on
Bitget, so fee dust at 20 USDT is negligible.

Bitget's KAT network is shown as KATANA and Gate's as KAT; CoinGecko lists both
as the Katana project. Bitget withdrawal is disabled for KAT, so this pair must
use two-sided inventory rotation, not withdrawals.

### XCX/USDT: speculative, not primary

```text
gateio->bitget: 112 episodes, 18.70/day, 34 stress, median 40.84 bps, p90 213.61
bitget->gateio: 85 episodes, 14.19/day, 21 stress, median 57.27 bps, p90 464.74
```

XCX was eligible in only 23/100 samples during the 5-minute live sample. The
fresh finalist scan had no edge at all (`gross=2.93 bps`). The historical
distribution is attractive, but the live window is too intermittent for a
primary allocation.

Both venues use BSC for XCX, which is the cleanest identity match of the three
finalists. Gate's 24h volume is much thinner than Bitget's.

## Reserve watchlist

- **DTEC**: 647 episodes, 108/day, 79.7% stress-pass rate, balanced directions,
  but no live edge in the current snapshot. Best reserve candidate.
- **IRYS**: 664 episodes and 1,676 stress samples, but 540 of 664 episodes are
  one direction. Watch for a two-sided regime before using it.
- **BABYSHARK / QUBIC**: good historical medians and stress counts, but both
  had 0/100 eligible samples in the 5-minute live sample.
- **BIRB / AIN / ORDER**: high frequency but weak stress survival. Do not use
  as primary pairs without a live-book edge and a smaller size.
- **BMT**: high stress and median, but the 2,874 bps maximum print and
  one-sided history make it unsuitable for the first Gate+Bitget batch.

## Asset identity check

CoinGecko platforms:

```text
WARD: BSC 0xf5cb7cc90040aa717a16887c8b7d7c10a7c60984
      Base 0x174a0de0fa1c4771ca980a42553c0041016e5a67
KAT:  Katana 0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d
      Base 0xd5390300c5db71f80d46f0fa9983fc72d4d1e3da
XCX:  BSC 0xe32f9e8f7f7222fcd83ee0fc68baf12118448eaf
```

The exchange currency metadata matches these networks. This is not a guarantee
that every bridge or chain version has identical liquidity, so the first live
batch must be small and manually reviewed.

## Recommendation

1. Use **WARD** as the primary research pair, initially 5-10 USDT per batch.
2. Use **KAT** as the clean secondary pair, up to 20 USDT when its funded
   direction is present.
3. Keep **XCX** and **DTEC** on a watchlist; do not allocate primary inventory
   yet.
4. Do not start automatic Bitget execution until a Bitget private key, account
   fee tier, balance reconciliation and FOK/private order path are verified.
   Bitget remains monitor-only in the current live configuration.
5. The current rotation was stopped while this research ran. It was not
   restarted against Hotcoin.

## Reproduce

```powershell
. .\scripts\load-env.ps1

npx tsx scripts/backtest-history.ts --config config/longtail.toml `
  --venues gateio,bitget --quote USDT --timeframe 1m --days 6 `
  --min-volume 1 --max-volume 5000000 --max-bases 2000 `
  --max-ticker-age-ms 86400000 --notional 20 --min-profit-usd 0.01 `
  --min-net-profit-bps 5 --safety-buffer-bps 2 --extra-slippage-bps 10 `
  --min-candle-volume-usd 20 --max-sane-spread-bps 3000 `
  --concurrency 4 --rps 4 `
  --out data/history-gate-bitget-1m-6d-2026-10-29.json

npx tsx scripts/rank-rotation-history.ts `
  --input data/history-gate-bitget-1m-6d-2026-10-29.json `
  --out data/rotation-history-gate-bitget-ranking.json `
  --min-episodes-per-direction 1 --limit 60
```

Live checks used `scripts/scan-longtail.ts` and `scripts/track-spread.ts` with
`--venues gateio,bitget`, 5-20 USDT probes, and the same fee model.

## Limitations

- The backtest uses public OHLCV, not captured order-book history.
- It does not model queue position, partial fills, or the time needed to submit
  both FOK legs.
- The 6-day window is a ranking sample, not proof of a permanent edge.
- WARD's extreme spread may be a cross-chain structural premium rather than a
  quickly mean-reverting arbitrage.
- Bitget fees are assumed at 10 bps because no verified account rebate is
  available yet.
- No order, withdrawal, or transfer was submitted during this research.
