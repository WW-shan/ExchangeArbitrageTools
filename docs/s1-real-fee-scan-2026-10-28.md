# S1 Real-Fee Opportunity Scan (2026-10-28)

Read-only scan only. No orders or withdrawals were submitted.

## Fee Setup

The scan used the verified live-test fees from
`docs/fee-rate-sources-2026-10-28.md`:

- Gate.io: `9.9 bps` gross, `70%` spot rebate -> `2.97 bps` effective.
- Hotcoin: `20 bps` gross, `80%` spot rebate -> `4 bps` effective.
- S1 round-trip fee floor: `6.97 bps`.
- With `safety_buffer_bps=2` and `min_net_profit_bps=5`, the effective entry
  threshold is `13.97 bps` before the absolute-profit floor.

## Broad Low-Liquidity Scan

Command:

```powershell
npx tsx scripts/scan-longtail.ts --config config/longtail.toml `
  --max-bases 200 --max-book-candidates 80 --top 30 --detail 10 `
  --out data/longtail-real-fees.json
```

Result: 119 candidates, 80 book candidates, 160 directed routes, 0 book errors.
Three routes broke even after fees, and two were clean on market data:

| Pair      | Direction          |     Gross | Max eligible |  Best net | Notes                                |
| --------- | ------------------ | --------: | -----------: | --------: | ------------------------------------ |
| INC/USDT  | Gate.io -> Hotcoin | 57.51 bps |   81.22 USDT | 28.21 bps | Strong one-way spread                |
| GWEI/USDT | Hotcoin -> Gate.io | 17.54 bps |     100 USDT |  7.41 bps | Did not survive the 20 USDT live cap |

`EDGE/USDT` showed a 29,773 bps spread and was rejected as an extreme
price outlier; it is not an executable opportunity.

## Persistence Check at the 20 USDT Live Cap

Both candidates were tracked with REST books every 3 seconds for 3 minutes.

### GWEI/USDT

- `Hotcoin -> Gate.io`: 59 samples, 0 eligible. Maximum gross `14.21 bps`.
- `Gate.io -> Hotcoin`: 59 samples, 0 eligible, negative gross.
- Conclusion: discard at the current 20 USDT order cap.

### INC/USDT

- `Gate.io -> Hotcoin`: 59 samples, 38 eligible (`64.4%`).
- Gross range: `19.48` to `76.95 bps`; median `52.39 bps`.
- Net range when eligible: `7.50` to `42.52 bps` at 20 USDT.
- Longest eligible streak: `27.072 s`; total eligible time across the sample:
  `113.459 s`.
- Time from the first eligible sample to the next non-eligible sample: `2.984 s`.
- `21/59` samples were rejected as `stale_book`, so the spread is intermittent.
- `Hotcoin -> Gate.io` was negative in every sample, with a median of
  `-102.78 bps`. This is not a two-sided mean-reverting pair; it is a persistent
  one-way price gap.

At 20 USDT, the observed net edge is roughly `0.015` to `0.085 USDT` per batch
before any inventory-rebalancing cost. The opportunity is real on market data,
but the absolute profit is small and highly sensitive to fills and stale books.

## Execution Constraint

The account currently holds only USDT on both venues. To execute
`Gate.io -> Hotcoin`, the sell leg needs INC inventory on Hotcoin before the
Gate buy leg is submitted. Without that inventory, the scanner can see the
spread but the executor cannot complete S1.

Possible ways to prepare inventory:

1. Manually transfer INC from Gate.io to Hotcoin and wait for the deposit to
   credit; this takes time and incurs the withdrawal fee.
2. Pre-position a small INC balance on Hotcoin and keep enough USDT on Gate.io
   for the buy leg. This makes the first batch possible but requires a later
   rebalance.
3. Hold inventory on both sides and only trade when the spread is favorable;
   this reduces transfer frequency but doubles the capital tied up.

Do not automate the transfer until the INC network, minimum withdrawal,
withdrawal fee, deposit confirmation, and arrival time are verified. At 20 USDT,
a single withdrawal fee can erase the observed edge.

## Next Gate

1. Verify INC deposit/withdrawal networks, fee, minimum, and arrival time on
   both venues.
2. Record a fresh balance snapshot containing the exact INC inventory that will
   be used for the sell leg.
3. Re-run the INC tracker with the live UTC clock immediately before the manual
   batch; require fresh books on both legs and no stale-book flags.
4. Execute one manually confirmed 15-20 USDT batch only after FOK/IOC and order
   status behavior are verified.
5. Reconcile actual `fee`, fill price, inventory delta, and the rebate ledger.
