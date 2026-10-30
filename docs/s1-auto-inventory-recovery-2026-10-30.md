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
方向；成本超过 `max_rebalance_loss_usd` 就不做。

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

## 验证

```text
npm run typecheck        PASS
npm run test:types       PASS
npm test                 PASS (70 files / 480 tests)
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
- FOK 成交后必须通过余额增量核对才关闭执行。
- 跨 pair 恢复只选择同组交易所、买腿交易所有正 base 余额的来源；
- 多 pair 同时出现余额不足信号时，优先使用采样的最新方向，而不是轮询顺序。
