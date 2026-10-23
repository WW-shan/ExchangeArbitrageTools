# BSC Token Mapping and Quote Design

## Objective

Safely connect CEX currencies with BNB Smart Chain tokens and compute executable CEX-DEX opportunities.

The core rule is:

> A CEX ticker and a BSC token are only considered the same asset when the BSC contract address is verified.

## Mapping pipeline

```text
CEX currency metadata
-> candidate network label
-> normalized BSC network
-> candidate contract address
-> token metadata check
-> risk check
-> manual approval
-> active mapping
```

## Data sources

Priority order:

1. CEX official currency/network API.
2. BscScan token metadata.
3. CoinGecko platform contract mapping.
4. Known project documentation.
5. Manual whitelist entry.

Sources 1-4 create candidate mappings. Only source 5 or repeated agreement across multiple independent sources can activate a mapping automatically.

## Mapping record

```ts
interface TokenMapping {
  id: string;
  cexVenueId: string;
  cexCurrency: string;
  chain: 'BSC';
  contractAddress: string;
  tokenDecimals: number;
  quoteToken: 'USDT' | 'USDC' | 'WBNB' | 'BUSD' | string;
  status: 'candidate' | 'active' | 'rejected';
  verification: string[];
  withdrawEnabled: boolean;
  depositEnabled: boolean;
  withdrawFee?: Decimal;
  minWithdrawAmount?: Decimal;
  transferTaxBps: Decimal;
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
  notes?: string;
}
```

## Standard BSC tokens

Maintain a curated whitelist:

| Token | Contract                                     |
| ----- | -------------------------------------------- |
| WBNB  | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| USDT  | `0x55d398326f99059fF775485246999027B3197955` |
| USDC  | `0x8AC76a51cc950d9822D68b83fE1ad97B32Cd580d` |
| BUSD  | `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56` |
| CAKE  | `0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82` |

Always verify these addresses through BscScan before implementation.

## Quote providers

Use aggregator APIs first:

- 0x
- 1inch
- ParaSwap
- PancakeSwap Smart Router

The initial implementation should use one primary and one backup provider.

### Quote record

```ts
interface DexQuote {
  providerId: string;
  chain: 'BSC';
  sellToken: string;
  buyToken: string;
  sellAmount: Decimal;
  buyAmount: Decimal;
  expectedSlippageBps: Decimal;
  priceImpactBps: Decimal;
  feeBps: Decimal;
  gasEstimate: Decimal;
  gasPrice: Decimal;
  quotedAt: number;
  validUntil?: number;
}
```

## Required quote directions

For every candidate:

1. `USDT -> TOKEN`
2. `TOKEN -> USDT`
3. Optional `WBNB -> TOKEN`
4. Optional `TOKEN -> WBNB`

AMM routes are asymmetric, so one direction cannot be inferred from the other.

## Cost model

### CEX buy, DEX sell

```text
CEX buy cost
= CEX ask-side executable cost
+ CEX taker fee
+ CEX withdraw fee
+ transfer risk buffer

DEX sell proceeds
= aggregator buy output
- DEX swap fee
- price impact
- slippage buffer
- gas
- token transfer tax

Net profit
= DEX sell proceeds - CEX buy cost - safety buffer
```

### DEX buy, CEX sell

```text
DEX buy cost
= aggregator sell input
+ DEX swap fee
+ price impact
- slippage buffer
+ gas

CEX sell proceeds
= CEX bid-side executable proceeds
- CEX taker fee
- deposit risk buffer

Net profit
= CEX sell proceeds - DEX buy cost - safety buffer
```

Transfer costs are not required when both sides already hold inventory. However, inventory assumptions must be explicit in each opportunity.

## Gas handling

- Estimate gas before every opportunity.
- Convert gas to USDT using current BNB price.
- Reject opportunities where gas exceeds the configured maximum.
- Use a minimum gas multiplier of 1.25 for safety.
- Recalculate before execution.

Default MVP limit:

```text
max_gas_cost_usd = 0.50
```

## Token risk rules

### Blocked tokens

A token is blocked if any of these are true:

- Cannot sell in a simulation.
- Contract is not verified.
- Transfer tax exceeds configured maximum.
- Liquidity is below the minimum.
- CEX withdrawal or deposit is disabled when the path requires transfer.
- Ticker matches but contract cannot be verified.
- Known honeypot or blacklist behavior.
- Liquidity lock is insufficient.

### MVP token policy

For early live tests:

```text
max_transfer_tax_bps = 0
min_pool_liquidity_usd = 50_000
min_pool_24h_volume_usd = 50_000
verified_contract_only = true
whitelist_only = true
```

The first live BSC tests should use tokens from this whitelist:

- CAKE
- BNB/WBNB
- USDT
- USDC

Only after execution is reliable should lower-liquidity tokens be considered.

## Risk score

Each token mapping receives a score:

```text
risk_score =
  transfer_tax_risk
+ liquidity_risk
+ contract_risk
+ listing_risk
+ transfer_availability_risk
+ market_depth_risk
```

Risk levels:

- `low`: whitelisted, verified, liquid, zero tax
- `medium`: verified, liquid, small tax or moderate depth
- `high`: thin depth or uncertain metadata
- `blocked`: fails a mandatory rule

Only `low` and `medium` tokens may appear in opportunities, and only `low` tokens may be used for execution in MVP.

## Deposit and withdrawal considerations

CEX-DEX opportunities fall into two classes:

### Inventory mode

Both CEX balance and BSC wallet already hold the asset.

- No transfer required.
- Transfer fee excluded.
- Inventory drift must be monitored.

### Transfer mode

One side must transfer the asset.

- Requires enabled deposit/withdrawal.
- Withdrawal fee included.
- Arrival time included.
- Opportunity must expire if transfer cannot complete before price risk becomes unacceptable.

MVP live execution supports inventory mode only.
