# S1 自动库存恢复与双边仓位配置（2026-10-30）

## 结论

`execution 30` 的 `Bitget` 买入把该所可用 USDT 从约 `7.7` 消耗到 `0.09`。
之后系统仍把 WARD/KAT 判为 `inventory_sufficient`，原因是旧逻辑只检查两边
base 是否够卖，没有检查每所是否还留有可执行买腿的 USDT。这不是 Bitget
本来没有库存，而是单边买入后没有把仓位重新配置成可轮换状态。

本轮修复后，系统会同时检查：

```text
buyReady(venue)  = free_quote >= min_quote_reserve_usd + min_executable_buy_usd
sellReady(venue) = free_base_value >= min_useful_notional_usd
```

只要有一个可执行方向需要买腿而该所 USDT 不足，就不会再返回
`inventory_sufficient`。如果同一个方向仍有新鲜正价差、该所有多余 base、
且另一所卖腿有足够 base，系统才会自动卖出一小部分 base 恢复买腿。若目标
pair 自己已经没有多余 base，恢复器还会从同一组交易所的其他 pair 中寻找
冗余库存，在买腿交易所卖出换取 USDT。否则明确等待，不做无意义的砸货。

这里的前提是“恢复买腿”而不是“清仓换手”：卖出所得只需要覆盖
`min_quote_reserve_usd + min_executable_buy_usd`，恢复后立刻重新扫描原始
方向；成本除了受 `max_rebalance_loss_usd` 限制，还必须低于目标机会
`conservative_net_profit * max_rebalance_cost_fraction`。默认比例是 50%，
即换手最多花掉机会利润的一半。

## 本轮代码改动

- `apps/scanner/src/scanner-service.ts`
  - 新增 `minBuyQuoteReserveUsd`，买入所的可下单 USDT 先扣除保留额。
- `apps/scanner/src/config.ts` / `apps/scanner/src/main.ts`
  - 新增 `min_buy_quote_reserve_usd` 并传入扫描器。
- `apps/executor/src/coordinator.ts`
  - 预检新增 `buy_quote_reserve_insufficient`：即使余额够这一笔，只要成交后
    会吃掉买腿保留额，也在提交前拒绝，不触发 kill switch。
- `apps/executor/src/auto-inventory.ts`
  - 只要任一执行所有 `quote_reserve_short`，seed 规划不再返回
    `inventory_sufficient`，而是返回 `inventory_quote_rebalance_required`。
  - 新增 `preferredVenueId`：有方向信号时只在“卖腿”那一所补 base，不会因为
    另一所更便宜就把 base 买到错误的买腿。
- `apps/executor/src/inventory-rebalance.ts`
  - 新增单腿 FOK 库存恢复状态机：
    - 只在新鲜正价差信号下触发；
    - 只卖恢复买腿所需的最小 base；
    - 卖后必须保留 `min_useful_notional_usd` 的卖腿 base；
    - 另一所卖腿必须已有足够 base，否则 `inventory_rebalance_sell_leg_unfunded`；
    - 有一次性成本上限 `max_rebalance_loss_usd`；
    - 换手成本不得超过目标机会保守利润的 `max_rebalance_cost_fraction`
      （默认 50%）；不能只因价差大就付出全部利润；
    - 未知/部分成交立即停机，不重试；
    - 成交后必须通过 base 减少、quote 增加的余额增量核对才关闭执行。
  - 新增 `fundingOnly` 模式：当目标 pair 没有多余 base 时，允许从同一组
    交易所的其他 pair 卖出冗余 base 来补买腿 USDT。该模式仍然要求新鲜
    正信号、足够 base、交易所最小名义额、成本上限、FOK 和余额增量核对；
    只是不要求资金来源 pair 在另一所同时持有可卖 base，也不要求卖完后仍
    保留 `min_useful_notional_usd`。
  - 恢复数量会向上满足交易所的最小下单量和最小名义额。Gate 的
    WARD/KAT/LIGHT 当前 `minNotional=3 USDT`、`amountStep=1`，因此不足 3
    USDT 的恢复单不会提交。
- `apps/executor/src/auto-supervisor.ts`
  - 每轮库存检查不再只轮询一个 pair，而是扫描全部 pair，优先选择最新的
    “仅因余额不足而失败”的 S1 方向；同一时刻再比较净价差；
  - 扫描器在余额不足时通常还会附带 `below_min_notional` 或
    `insufficient_depth`。恢复触发允许这组由余额派生出的原因，但
    `stale_orderbook`、`crossed_orderbook`、`suspicious_spread` 等硬失败仍
    不会触发资金换手；
  - `require_signal_for_seed=true` 时，没有新鲜方向信号就不建仓；避免把共享的
    小额 USDT 分散到所有 pair；
  - 有信号时先恢复买腿 USDT，再在信号指定的卖腿补 base；
  - 目标 pair 没有可用冗余 base 时，按相同买卖交易所筛选其他 pair；只保留
    最近 120 秒余额快照中在买腿交易所有正 base 的来源，按可用 base 数量降序
    依次尝试（最多 8 个候选）；每次恢复批次之间有 5 秒节流，防止连续 API
    请求；
  - 自动恢复成交后立即刷新余额，再重新寻找 S1。

## 当前小额账户参数

当前账户总权益很小，而 Gate 的小币最小名义额是 `3 USDT`。如果继续使用
`1.4 USDT` 的可执行下限，扫描器可能生成一个交易所根本不会接受的买单；如果
使用旧的 `min_quote_reserve=5`，当前约 10 USDT 的账户又达不到“可买腿且保留
买腿资金”的条件，形成结构性等待。因此 live 配置调整为：

```toml
min_sizing_notional = "3"
min_buy_quote_reserve_usd = "0.5"
min_quote_reserve_usd = "0.5"
min_executable_buy_usd = "3"
min_useful_notional_usd = "3"
```

这不改变套利判定本身，只让最小可执行批次适合当前约 10 USDT 的测试资金。
资金增加后应同步调大，避免 3 USDT 批次的手续费占比过高。

`require_signal_for_seed = true` 也很重要：它把 seed 从“按 pair 轮询、看到缺
base 就买”改成“只有出现正价差方向才准备对应卖腿”。当前 WARD/KAT/LIGHT 都有
两所 base 和一笔可用 quote，但实时盘口没有正价差，所以系统保持等待，不会为了
填库存而继续买入。

## 自动恢复 SOP

1. 扫描器发现正价差方向 A 买、B 卖。
2. 执行器检查 A 的 USDT 和 B 的 base 是否都够。
3. 如果 A 的 USDT 不足，但 A 有超过 `min_useful_notional_usd` 的多余 base，
   且 B 的 base 足够：
   - 在 A 上 FOK 卖出恢复买腿所需的最小 base；
   - 核对余额增量；
   - 刷新两边余额；
   - 重新评估 A 买、B 卖。
4. 如果目标 pair 在 A 上没有多余 base，则检查同一组 A/B 的其他 pair：
   - 只考虑在 A 上有 base 余额的 pair；
   - 在该 pair 的盘口重新读取后，卖出满足最小名义额的最少 base；
   - 成交后用 A 的 base 减少、USDT 增加确认，再重新扫描原目标方向；
   - 按最近余额筛选并排序，最多尝试 8 个来源 pair；全部不满足就等待，不继续
     扩大下单。
5. 如果 B 的 base 也不足，不卖 A 的目标 pair base；等待 seed 或反向机会。
6. 如果 A 没有任何可换手库存，等待转账/入金，不做亏损换手。

## 当前可复现例子

2026-10-30 的实际余额中，Gate 只有约 `2.052 USDT`，但持有
`19.96 LIGHT`；Gate 最小下单名义额是 `3 USDT`，目标买腿门槛是
`0.5 + 3 = 3.5 USDT`。因此 Gate 无法直接买任何 WARD/KAT/LIGHT。恢复器在
出现真实正 S1 信号时，会优先尝试目标 pair，再尝试 KAT/LIGHT 等来源 pair；
以 LIGHT 为例，卖出约 `12 LIGHT`、按盘口最优卖价可得到约 `3 USDT`，随后
重新扫描。没有正信号时不会为了补库存而主动卖出。

## 2026-10-30 实盘验证

17:02（HKT）出现 WARD `gateio->bitget` 的余额受限正信号，系统先执行了跨 pair
补资金：

```text
REBALANCE execution 53
funding pair        LA/USDT
venue               gateio
sell                57 LA
limit price         0.05319
average fill        0.05321
FOK result          filled
fee                 0.0030026403 USDT
quote proceeds      3.0299673597 USDT
Gate USDT before    2.052031568
Gate USDT after     5.0819989277
Gate LA before      94.81289
Gate LA after       37.81289
```

余额增量与订单增量一致，执行状态为 `CLOSED`，kill switch 保持关闭，没有未对账
订单。这证明“目标 pair 没库存 -> 从同交易所其他 pair 卖冗余 base -> 恢复买腿
USDT -> 重新扫描”的链路在真实账户上成立。

第二笔补资金（`REBAL-BREV`）卖出了 `37 BREV`，估算成本 `0.0146 USDT`，而
对应信号的保守利润只有 `0.0161 USDT`，只留下约 `0.0015 USDT` 的理论空间，
不足以覆盖真实滑点。新的 50% 利润上限会把这类换手拒绝，等待成本更低的来源
pair；这用于避免“为了交易而交易”。

补资金完成后，系统立即看到 WARD `gateio->bitget` 的正 S1：

```text
09:03:05 UTC  55.83 bps  4.53 USDT  -> PREFLIGHT_FAILED: gross_profit_below_threshold
09:03:32 UTC   7.08 bps  4.53 USDT  -> PREFLIGHT_FAILED: gross_profit_below_threshold
09:03:37 UTC  45.33 bps  4.53 USDT  -> PREFLIGHT_FAILED: signal_expired_at_preflight
09:04:50 UTC  41.86 bps  4.53 USDT  -> PREFLIGHT_FAILED: preflight_too_slow
```

这些失败的共同点是：信号选择到执行开始只有 `8-15 ms`，但预检耗时约
`2.3-4.5 s`，重新抓到的盘口已经不支持原来的净利。它们没有提交任何订单，也
没有改变余额。因此当前主要瓶颈不是扫描或选路，而是预检阶段的外部 API 往返。

其中一部分失败原因只是 `preflight_too_slow` 或 `signal_expired_at_preflight`：
这表示重新抓盘后的净利仍然通过，但因为旧的 `2.5 s / 3 s` 预算被拒绝。因此把
live 预算调整为 `max_preflight_ms=4000`、`max_signal_age_ms=5000`；真正是否
下单仍由预检时的新盘口、余额和 FOK 决定，不会使用过期价格直接成交。

不过同一时间段也成功闭合了一笔真实 S1：

```text
S1-859273-1793351323686
Gate buy    1566 WARD @ 0.002892
Bitget sell 1566 WARD @ average 0.0029010391762452
both legs filled, fill mismatch 0
economic profit       0.008267247666 USDT
cash profit           0.00512873937 USDT
rebate receivable     0.003138508296 USDT
Gate WARD fee         1.55034 WARD (charged in base)
```

Gate 买入手续费从 WARD 余额扣除，所以两个交易所合计的 WARD 库存减少
`1.55034`，这不是裸空或漏卖；两腿的成交数量都是 `1566`，订单事件和余额增量
一致。成功这笔的预检耗时为 `1.482 s`（盘口 `1.424 s`，余额 `1.481 s`），
说明超过 2 秒的预检确实是机会流失的主要风险。

只读延迟拆解显示，正常情况下单次 Gate/Bitget 余额、挂单、盘口 REST 调用约为
`290-320 ms`，启动时 `loadMarkets` 为 `5-6 s` 但不在热路径。由于预检存在
偶发 3 秒级等待，代码已增加 `executionTiming`，记录：

- `bookFetchStartedAt/bookFetchCompletedAt`
- `balanceFetchStartedAt/balanceFetchCompletedAt`
- `openOrderCheckCompletedAt`
- `evaluationCompletedAt`
- `preflightAt`

下一次 S1 失败时可以直接区分是盘口请求、余额请求、挂单请求还是网络抖动。

## 验证

```text
npm run typecheck        PASS
npm run test:types       PASS
npm test                 PASS (70 files / 483 tests)
npm run format:check     PASS
npm run backtest         PASS
```

新增测试覆盖：

- 买腿 USDT 不足时 seed 不得返回 `inventory_sufficient`；
- 扫描器必须保留买腿 USDT；
- 预检拒绝会吃掉保留额的买单；
- 自动恢复只卖恢复保留额所需的最小 base；
- 卖后 base 低于卖腿下限时拒绝；
- 另一所卖腿没有 base 时拒绝恢复；
- 恢复成本超过上限时拒绝；
- 换手成本超过目标机会保守利润的 50% 时拒绝；
- FOK 成交后必须通过余额增量核对才关闭执行。
- 跨 pair 恢复只选择同组交易所、买腿交易所有正 base 余额的来源；
- 多 pair 同时出现余额不足信号时，优先使用采样的最新方向，而不是轮询顺序；
- 余额受限且附带最小名义额/深度拒绝时仍可触发恢复，但硬行情失败必须拒绝。
