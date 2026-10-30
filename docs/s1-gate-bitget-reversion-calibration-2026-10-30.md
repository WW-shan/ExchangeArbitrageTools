# Gate/Bitget Reversion Calibration — 2026-10-30

## Purpose

The supervisor can prepare the opposite inventory when a funded direction is
near breakeven, but only if a historical calibration shows that the reverse
opportunity arrives often enough to pay for the preparation. The existing
calibration covered Gate/Hotcoin only. This run checked whether Gate/Bitget
supports the same mechanism.

## Data and parameters

```text
venues          gateio, bitget
pairs           WARD/USDT, KAT/USDT, LIGHT/USDT
timeframe       1m OHLCV
window          2026-10-24 .. 2026-10-30 (6 days)
notional        20 USDT
prep bands      5 bps, 12 bps
horizons        15m, 30m, 60m
reverse target  5 bps
adverse stop    50 bps
minimum samples 20
```

Command:

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npx tsx scripts/backtest-history.ts `
  --config config/longtail.toml `
  --venues gateio,bitget --quote USDT --timeframe 1m --days 6 `
  --bases WARD,KAT,LIGHT --max-bases 10 `
  --min-volume 1 --max-volume 5000000 --min-candle-volume-usd 1 `
  --min-net-profit-bps 5 --min-profit-usd 0.01 `
  --safety-buffer-bps 2 --extra-slippage-bps 10 --notional 20 `
  --concurrency 2 --rps 2 --prep `
  --prep-horizons-ms 900000,1800000,3600000 `
  --prep-band-bps 5,12 --prep-target-bps 5 --prep-stop-bps 50 `
  --prep-min-samples 20 `
  --out data/prep-gate-bitget-2026-10-30.json `
  --prep-out config/s1-prep-calibration-gate-bitget.json
```

## Result

All evaluated preparation directions have negative expected value. The reverse
probability is too low to compensate for preparation cost and adverse carry.

| Pair       | Preparation direction | Band | Samples | P(reverse) | Reverse bps | No-reverse loss bps | EV bps |
| ---------- | --------------------- | ---: | ------: | ---------: | ----------: | ------------------: | -----: |
| WARD/USDT  | bitget->gate          |  5.0 |     100 |     0.2500 |       30.72 |               19.97 | -11.28 |
| WARD/USDT  | gate->bitget          |  5.0 |     101 |     0.2079 |       27.11 |               18.90 | -12.98 |
| WARD/USDT  | bitget->gate          | 12.0 |     139 |     0.2806 |       25.58 |               21.49 | -12.88 |
| WARD/USDT  | gate->bitget          | 12.0 |     155 |     0.2258 |       16.78 |               22.73 | -19.20 |
| LIGHT/USDT | bitget->gate          |  5.0 |     104 |     0.4423 |       12.15 |               38.79 | -18.79 |
| LIGHT/USDT | gate->bitget          |  5.0 |     168 |     0.2083 |       14.10 |               36.05 | -28.34 |
| LIGHT/USDT | bitget->gate          | 12.0 |     275 |     0.3673 |       14.62 |               28.65 | -19.62 |
| LIGHT/USDT | gate->bitget          | 12.0 |     317 |     0.2114 |       13.34 |               34.14 | -31.75 |
| KAT/USDT   | bitget->gate          |  5.0 |      50 |     0.2200 |       17.15 |               36.83 | -27.64 |
| KAT/USDT   | gate->bitget          |  5.0 |      31 |     0.3226 |       14.49 |               43.31 | -27.42 |
| KAT/USDT   | bitget->gate          | 12.0 |      54 |     0.3519 |       24.68 |               41.82 | -24.21 |
| KAT/USDT   | gate->bitget          | 12.0 |      36 |     0.4444 |       28.31 |               47.94 | -20.55 |

## Decision

Do **not** enable `[auto_rotation.preparation]` for the current Gate/Bitget
profile. The live configuration keeps it disabled. A near-breakeven entry is
not justified merely because a large spread appeared later; the historical
conditional probability of that reversal is below the required threshold.

The generated calibration file was deliberately not added to the active
configuration because its entries are negative and the runtime parser uses
the legacy logical direction labels. Raw report:
`data/prep-gate-bitget-2026-10-30.json` (ignored local artifact).

## Implication

The current WARD `bitget->gate` dislocation cannot be captured without Bitget
quote. The correct response is to wait for the funded Gate->Bitget direction,
not to force a one-sided mean-reversion position. If the account is to trade
both directions continuously, Bitget needs a small USDT reserve or a separately
approved transfer.
