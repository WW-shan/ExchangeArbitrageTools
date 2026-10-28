# Gate.io / Hotcoin Spot Fee Verification (2026-10-28)

Scope: S1 spot taker/taker costs for the `gateio` and `hotcoin` accounts used by
`config/live-test.toml`. All rates below are gross account fees before the
operator's commission rebate.

## Gate.io

- Official API reference: `https://www.gate.com/docs/developers/apiv4/en/#query-personal-trading-fees`
- The authenticated personal-fee endpoint returned `taker_fee=0.00099` and
  `maker_fee=0.00099`, i.e. `9.9 bps` on each side.
- `npm run fees:fetch` writes the per-symbol gross fees to `data/fees.json`.
- Operator-confirmed spot rebate: `70%`.
- Effective cost: `9.9 x (1 - 0.70) = 2.97 bps`.

The personal-fee endpoint reflects the account's fee tier and any GT discount,
but not the separately settled referral/commission rebate.

## Hotcoin

- Official fee page: `https://www.hotcoin.com/en_US/rateStandard/index`
- Official public schedule API:
  `https://www.hotcoin.com/hk-web/vip/level-fee-rate?lang=en_US&platform=1&client=1&versionCode=3.2.0`
- The API response for `spotVip` level 0 returned:

```json
{ "level": 0, "name": "VIP0", "makerFee": "0.2", "takerFee": "0.2" }
```

`makerFee` and `takerFee` are percentages: `0.2% = 20 bps` on each side.
The account has less than 10,000 USDT in assets and less than 50,000 USDT of
30-day volume, so it is VIP0 under the published thresholds.

- Hotcoin's documented private API still has no account-fee query endpoint.
  The public VIP schedule is therefore the authoritative gross rate; the
  account-specific rebate comes from the operator's confirmed plan.
- Operator-confirmed spot rebate: `80%`.
- Effective cost: `20 x (1 - 0.80) = 4 bps`.

## Effective-Rate Implementation

`taker_bps` and `maker_bps` are gross rates. `rebate_pct` is applied after the
venue-level or per-symbol account fee is selected:

```text
effective_bps = gross_bps x (1 - rebate_pct / 100)
```

This ordering is intentional. `data/fees.json` is generated from exchange fee
endpoints and contains gross rates. Applying the rebate after the merge means a
later `npm run fees:fetch` cannot silently replace the effective rate with the
gross rate.

Current live-test configuration:

```toml
[fees.gateio]
taker_bps = 9.9
maker_bps = 9.9
rebate_pct = 70

[fees.hotcoin]
taker_bps = 20
maker_bps = 20
rebate_pct = 80
```

## First Live Fill Reconciliation (2026-10-28)

The first real S1 batch (`S1-47-1793200774229`) confirmed that both venues
charge the gross fee at fill time and settle rebates separately:

- Gate charged `0.0396 TBK` on a `40 TBK` buy at `0.23728`, i.e. `9.9 bps`.
  The 70% rebate is an accrued USDT receivable of `0.0065774016`, not an
  immediate discount.
- Hotcoin charged `0.0191 USDT` on a `40 TBK` sell at `0.23888`, i.e. about
  `20 bps`. The 80% rebate is an accrued USDT receivable of `0.0152888`.
- Gross spread was `0.064 USDT`; gross fees were `0.028507288 USDT`; accrued
  rebates were `0.0218662016 USDT`; net fees were `0.0066410864 USDT`.
- Cash profit was `0.035492712 USDT`; economic profit including accrued rebates
  was `0.0573589136 USDT`.

The executor now reconciles closed trades from actual balance deltas, so fees
charged in the base asset are not lost. It records cash profit and rebate
receivable separately in execution metadata. See
`docs/s1-live-test-tbk-2026-10-28.md`.

## What Still Requires Live Verification

1. After the first real fills, compare `/v1/order/matchresults` (Hotcoin) and
   Gate's trade history `fee` fields with the configured gross rates.
2. Confirm the rebate amount and settlement time in each venue's rebate ledger.
   The trading UI may show the gross fee even when the rebate is paid later.
3. If either venue changes the VIP tier, fee schedule, or rebate percentage,
   update both the gross rate and `rebate_pct`, then rerun
   `npm run live:readiness`.
