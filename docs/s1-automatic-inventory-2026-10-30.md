# S1 自动库存（SEED）设计与实盘接入

日期：2026-10-30（Asia/Hong_Kong）

## 1. 目标与边界

自动库存解决的是“信号存在，但某一边没有足够 base 可卖”的问题。它不是新的套利策略，也不保证价格回归。每次建仓都是一次方向性持仓，单独记为 `SEED` execution，不能计入套利利润。

它不负责：

- 自动提币或跨所搬币；
- 在没有库存时伪造双腿成交；
- 用另一个交易所的库存关闭本交易所的残留；
- 在未知订单后重试；
- 自动清除 kill switch。

当前实盘只对 `auto_rotation.pairs` 白名单中的 Gate.io / Bitget 标的生效。WEEX 仍然是只读监控。

## 2. 库存语义

对每个 pair 和每个交易所定义：

```text
base_value_usd = free_base x best_bid
```

`base_value_usd >= min_useful_notional_usd` 时，认为该边有“可用库存”。这里的价值按当前盘口买一价计算，而不是按成本价计算。

两边都有可用库存：不建仓。

只有一边缺库存：

- 缺库存边更便宜：买入缺库存边；
- 缺库存边更贵，但相对另一边不超过 `max_pair_deviation_bps`：仍然买入，避免永远等不到完全平价；
- 缺库存边贵出 band：等待。

两边都缺库存：买入 ask 更低的一边。下一轮继续检查，等另一边的价格进入 band 后再补。

这个规则对应实盘中的两种准备方式：

1. 没有库存时，先买便宜的一边；
2. 价格接近平价时，补齐另一边，形成可轮换的双边底仓。

## 3. 为什么不是“看到差价就买”

低流动性币的 ask/bid 可能瞬间跳动。为了避免在异常盘口或单边拉升中建仓，自动库存要求：

- 两个交易所的盘口都通过 `validateOrderBook`；REST 接收时间必须在 5 秒内，
  低流动性标的的交易所时间戳允许放宽到 60 秒，但下单前仍会再次检查接收时间；
- 候选边的最优 ask 在 `min_stable_ms` 内变化不超过 `max_price_drift_bps`；
- 下单前重新读取两边余额；
- 使用 FOK 限价单，限价等于目标数量的最差可成交 ask；
- 不使用无界市价单；
- 只允许 quote 为 USD 稳定币的 pair 自动估值。

自动库存不会因为“价差看起来很大”就追买贵的一边。贵的一边只有在接近平价时才补。

## 4. 下单数量与余额

默认参数：

```text
seed_notional_usd       = 5
min_quote_reserve_usd   = 5
min_useful_notional_usd = 3
```

实际可用 quote 为：

```text
available = free_quote - min_quote_reserve_usd
max_spend = min(seed_notional_usd, pair.max_notional,
                available / (1 + taker_fee_bps / 10000))
```

然后按盘口深度计算 base 数量，向下对齐到 `amount_step`，并再次受余额约束。下单前检查：

- 数量大于 0；
- 满足交易所 `minAmount`；
- 满足交易所 `minNotional`；
- 不超过 pair 的 `max_notional`；
- 建仓后的 `base_value_usd` 至少达到 `min_useful_notional_usd`。

不会为了凑最小下单额而突破 quote reserve，也不会把账户买空。

## 5. 稳定窗口与轮询

supervisor 每 `check_interval_ms` 只检查一个 pair，按白名单轮询。这样 6 个标的不会每秒产生 12 个公共盘口请求。

稳定状态只保存在 executor 内存中：

```text
venueId
referenceCanonicalAsk
firstSeenAt
lastSeenAt
```

如果候选边变化，或价格漂移超过 `max_price_drift_bps`，稳定窗口重置。进程重启后重新等待，不会继承旧价格。

## 6. 执行流程

1. 正常 S1 机会优先。只有没有可执行 S1 / preparation 时，才检查自动库存。
2. 确认 live、自动执行、kill switch、open execution、unresolved order 都允许。
3. 拉取两个交易所的盘口，校验新鲜度、symbol、venue、crossed book。
4. 用最近一次余额快照做初筛；快照缺失或过期则等待。
5. 计算缺库存边、价格 band、稳定窗口、深度、最小下单额和 quote reserve。
6. 初筛通过后，重新读取两边私有余额，重新计算一次；任何一项变化就放弃。
7. 检查目标交易所的 open orders，要求为空。
8. 创建 `SEED` execution 和一条 `buy` leg。
9. 提交 FOK 限价买单。Gate 的 `clientOrderId` 上限是 28 字符，因此订单 ID 使用
   `SD-<base36-time>-<8hex>`，不再把长 batch id 直接当订单 ID。
10. 处理终态：
    - 全成交：`CLOSED`，写入 inventory delta、余额快照、审计和 `inventory_seeded` 事件；
    - 明确未成交：`SEED_REJECTED`，不打开 kill switch，等待重试冷却；
    - 部分成交：`SEED_PARTIAL`，打开 kill switch，保留 execution 供人工核对；
    - 结果未知：`SEED_UNKNOWN`，只做有限次数 `fetchOrder` 查询，绝不重新 `createOrder`，打开 kill switch。

`SEED` 的 `realized_profit` 为 0。它不是套利收益，真实成本体现在 inventory delta 和后续卖出 execution 中。

如果结果是 `SEED_UNKNOWN`，先确认交易所没有挂单、余额与建仓前快照一致，再运行：

```powershell
npm run seed:reconcile -- --batch <batchId> --confirm <batchId>
```

该命令只关闭确认零成交的 seed，不会重新下单，也不会自动清除 kill switch。

### 6.1 手续费与净库存

成交量和库存增量不是同一个数。交易所可能用 base 收费，也可能用 quote 收费：

```text
base 收费：net_base = filled - fee_base
quote 收费：net_base = filled，quote_out = filled x price + fee_quote
```

当前处理顺序：

1. 在 CCXT adapter 边界统一解析 `order.fee`、`order.fees` 和原始回包
   `info.fee/fee_currency`、Bitget `feeDetail`；
2. 把 `feeCurrency` 持久化到 `orders.fee_currency`；
3. 用手续费资产计算净 base / quote delta；
4. 同时读取建仓前后 free 余额作为交叉校验；
5. 手续费资产缺失或不属于 base/quote 时，优先使用可验证的余额差；
6. 两者都无法解释时进入 `SEED_ACCOUNTING_UNKNOWN`，打开 kill switch，不关闭
   execution，绝不猜测入账。

`inventory_delta_json` 记录的是净库存，不是 `order.filled`。例如 Gate WARD 的
真实成交为 1127 WARD、手续费 1.11573 WARD，则净 base delta 是 1125.88427 WARD。

历史已关闭 SEED 如果出现同类错账，使用受控修正命令：

```powershell
npm run seed:repair-accounting -- --batch <batchId> --confirm <batchId>
```

该命令只允许修复已关闭、订单终态且全成交的 SEED；不会下单、撤单、重试或修改
kill switch。修复会写入 `inventory_seed_accounting_repaired` 审计和 warning 风险事件，
并在 metadata 中保留 `accountingRepair.previousInventoryDelta`。

## 7. 审计字段

`executions.metadata_json` 包含：

- `seed=true`、`origin=automatic`；
- pair、venue、other venue、exchange symbol；
- `reason`：`both_sides_missing_cheaper_side` / `missing_side_cheaper` / `missing_side_near_parity`；
- 两边 canonical ask/bid、pair deviation；
- 建仓前两边 base value；
- 计划 spend、数量、限价、预期 base value；
- 稳定窗口 first seen、盘口 fetchedAt；
- 成交后的 filled、average price、quote spent。
- 手续费金额、资产、计价价值、收费方式和入账来源；
- `netBaseCanonical`、`balanceBaseDeltaCanonical`、`balanceQuoteDelta`。

审计事件：

- `inventory_seed_attempt`
- `inventory_seed_filled`
- `inventory_seed_rejected`
- supervisor 的 `inventory_seed_supervisor_result`

风险事件：

- `inventory_seeded`（info）
- `inventory_seed_partial_fill`（critical）
- `inventory_seed_unknown`（critical）
- `inventory_seed_post_balance_failed`（warning）
- `inventory_seed_accounting_unknown`（critical）
- `inventory_seed_accounting_repaired`（warning）

## 8. 延迟与门槛

最近一次成功 WARD 双腿执行的实测：

```text
signalAgeMs          1963
preflightMs          1774
bookFetchMs          1059
balanceFetchMs       1773
endToEndLatencyMs    3311
```

主要瓶颈是私有余额查询，不是 scanner。scanner 已经使用 WebSocket，执行器仍会在下单前重新拉取盘口和余额。

当前调整：

```text
max_signal_age_ms = 3000
max_preflight_ms  = 2500
```

含义：

- 信号总年龄仍被 3 秒硬限制；
- 预检自身超过 2.5 秒会以 `preflight_too_slow` 失败；
- 不通过缓存旧余额来“变快”，因为预检余额同时是后续对账基线，缓存会让成交/残留判断失真；
- 真正的下一步优化应是带失效标记的共享余额快照，而不是简单放宽风控。

## 9. 实盘配置

`config/live-rotation.toml`：

```toml
[auto_rotation.inventory]
enabled = true
seed_notional_usd = '5'
min_quote_reserve_usd = '5'
min_useful_notional_usd = '3'
min_stable_ms = 3000
max_pair_deviation_bps = '30'
max_price_drift_bps = '100'
check_interval_ms = 1000
retry_cooldown_ms = 60000
```

当前白名单：WARD、KAT、LIGHT、LA、BREV、AEON。

## 10. 验收步骤

1. 确认 `openExecutions=0`、`unresolvedOrders=0`、kill switch 关闭。
2. 重启 supervisor，观察日志出现 `inventory_waiting`，确认它在等待稳定窗口或价格 band，而不是报 adapter/capability 错误。
3. 第一笔 `SEED` 必须满足：单笔不超过 5 USDT、quote reserve 仍 >= 5 USDT、只买一边。
4. 成交后核对 `executions.strategy=SEED`、`execution_legs.side=buy`、`orders`、`order_events`、`inventory_delta_json` 和余额快照。
5. 观察另一边是否在价格进入 band 后自动补仓。若长期不进入 band，程序应继续等待，不能追价。
6. 只有在两边都有可用库存后，才允许正常 S1 双腿执行。
7. 任意 `SEED_UNKNOWN` / `SEED_PARTIAL` 都必须人工核对交易所后台后，再决定是否 release kill switch。

### 10.1 实盘验收记录（2026-10-30）

第一笔 Gate SEED：

```text
executionId        15
batchId            SEED-WARD-1793298805018-gateio-1d77e431
orderId            1157692006205
filled             1127 WARD
averagePrice       0.004423
fee                1.11573 WARD
netBaseDelta       1125.88427 WARD
quoteDelta         -4.984721 USDT
```

这笔最初把 `filled` 直接当作 base delta。已通过
`seed:repair-accounting` 修正，并保留修复前 delta、审计和 warning 风险事件。

第二笔 Bitget SEED（新代码首次实盘）：

```text
executionId        16
batchId            SEED-WARD-1793300022571-bitget-aa366aca
orderId            1499774490238173186
filled             1164.26 WARD
averagePrice       0.00420749104152
fee                1.16426 WARD
netBaseDelta       1163.09574 WARD
quoteDelta         -4.89861352 USDT
accountingSource   order_fee
```

Bitget 余额变化：

```text
before             WARD 24.5369      USDT 16.65597384
after              WARD 1187.63264   USDT 11.75736032
base increase      1163.09574 WARD
quote decrease     4.89861352 USDT
```

订单回包里的 `feeDetail`、`orders.fee/fee_currency`、`execution_legs.fee_paid`、
`inventory_delta_json` 和余额变化一致。两边 WARD 库存都已达到可用阈值，
S1-E7 验收完成。

## 11. 当前限制

- 没有自动提币，因此跨所缺 base 只能通过“在目标所买入”解决；
- 不假设价差会回归；
- 自动库存是方向性风险，极端行情可能立即浮亏；
- 只支持 USD 稳定币 quote；
- 公共盘口仍通过 REST 获取，自动库存不是毫秒级抢单策略；
- 未实现共享余额缓存、Prometheus/Telegram 告警和自动仓位再平衡。
