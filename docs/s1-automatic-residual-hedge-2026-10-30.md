# S1 单腿残留自动对冲设计（2026-10-30）

## 1. 目标

自动对冲只解决一个问题：双腿执行已经进入 `SAFE_STOP`，但账户里存在
已经确认的多头或空头残留。它不负责追价、不负责等待回归、不允许扩大
仓位，也不替代人工异常处理。多头残留用 FOK 卖出，空头残留用 FOK 买回。

触发后仍然保持全局 kill switch。自动对冲只是风险收口，不是新的套利
开仓，也不会自动恢复 supervisor。

## 2. 触发条件

只有同时满足以下条件才会尝试提交一笔 reduce-only FOK 单：

- 原执行状态为 `SAFE_STOP`，且尚未关闭；
- 当前只有这一笔未关闭执行；
- 没有 `pending/open/unknown` 订单；
- `unhedged_inventory` 中存在该批次的 open 多头或空头记录；
- open 记录属于同一个资产；
- 多头残留所在交易所有足够 free base；空头残留有足够 free quote；
- 能读取执行前余额基线和当前余额；
- 残留所在交易所有 FOK 权限；
- 当前盘口新鲜、通过校验；
- 预计平仓损失不超过 `max_loss_usd`；
- 本次数量覆盖全部可平残留，不会只卖/买一部分就关闭库存记录。
- 空头买回按 base 手续费向上取整，避免 gross filled 覆盖、净 base 仍不足。

## 3. 绝不自动对冲的场景

以下场景保持原样，kill switch 继续打开，等待人工对账：

- 订单状态未知，或仍有未解决订单；
- 同一批次同时出现多头和空头，或出现多个资产；
- 空头买回所需 quote 现金不足；
- 执行前余额基线缺失或过期；
- 当前余额无法证明残留仍然存在；
- 残留所在交易所没有 FOK 或盘口不可用；
- 预计损失超过配置上限；
- 可用余额不足以覆盖完整残留；
- 自动执行开关已被人工关闭；
- 对冲提交结果未知：只记录 `HEDGE_UNKNOWN`，绝不重试。

## 4. 安全不变量

1. 只在残留所在交易所操作。禁止用另一个交易所原本就有的库存冒充对冲，
   否则会错误关闭原库存记录，造成账实不一致。
2. 只允许全量平仓。若可用余额不足以覆盖目标数量，直接阻断，不生成部分平仓。
3. 空头买回必须按预期 base 手续费 gross-up；成交后如果净 base 增量仍低于
   记录的空头量，保持原执行未关闭，并记录 `hedge_net_residual_remains`。
4. 亏损有硬上限。当前实盘 `max_loss_usd = 1`，并且不得超过账户
   `daily_max_loss_usd`。
5. 未知结果不重试。提交异常但无法证明未成交时，订单记为 unknown，
   打开 kill switch，保留原库存和 HEDGE 记录。
6. kill switch 不会被自动清除。对冲完成后仍需人工运行
   `rotation:release`。
7. 自动对冲单独记录为 `HEDGE` execution，原执行只在确认成交且余额
   对账通过后更新为 `RECONCILED`。
8. 审计 actor 区分来源：自动对冲写 `executor`，手工 CLI 写 `operator`。

## 5. 配置

```toml
[auto_rotation.residual_hedge]
enabled = true
max_loss_usd = '1'
max_baseline_age_ms = 60000
```

`max_loss_usd = 0` 表示只允许保本或盈利平仓。负值不允许。
自动路径只使用这个上限；手工 CLI 可以用负的 `--min-profit-usd` 显式接受
更大但仍有界的损失，当前解析下限为 `-5`。
`max_baseline_age_ms` 必须在 1000 到 300000 之间。

## 6. 执行流程

1. 原执行返回 `SAFE_STOP`，coordinator 写入 kill switch、风险事件和
   `unhedged_inventory`。
2. supervisor 读取配置，确认 `auto_execution_enabled` 仍为 true。
3. 只加载残留所在交易所的 market、balances 和盘口。
4. 用执行前余额基线计算真实残留和成本。
5. 多头以最差 bid、gross fee 计算净回款；空头以最差 ask、gross fee
   和 base 手续费 gross-up 计算总成本。
6. 通过亏损上限和全量平仓检查后，多头提交 FOK 卖单，空头提交 FOK 买单。
7. 成交后重新读取余额，按余额差计算真实回款和已实现盈亏。
8. 关闭 HEDGE execution、原执行和 unhedged 记录，保留 kill switch。
9. 对冲失败或超出限制时只记录审计和日志，不进入重试循环。

## 7. 账务与审计

自动对冲结果写入：

- `executions.strategy = HEDGE`；
- `execution_legs.side = sell`（多头）或 `buy`（空头），以及 venue order id、
  成交量和均价；
- `orders` 与 `order_events` 的提交/响应记录；
- `risk_events.rule = residual_hedged`；
- `audit_logs.actor = executor`，`action = residual_hedged`；
- supervisor 的 `auto_residual_hedge_result` 审计和 JSON 日志。

若真实回款低于成本，亏损会计入 `daily_risk_state.realized_loss`。

## 8. 测试

新增回归覆盖：

- 正常全量 FOK 平仓，原执行变为 `RECONCILED`；
- 亏损超过上限时不提交；
- 自动执行被关闭时不提交；
- 未知提交只发一次，不重试；
- 残留交易所无可用余额时，不允许在另一个交易所卖出；
- 可用余额不足完整残留时不生成部分平仓。
- 空头残留买回、base 手续费 gross-up、亏损上限和余额对账。

相关命令：

```powershell
npx vitest run apps/executor/tests/auto-residual-hedge.test.ts
npx vitest run apps/executor/tests/residual-hedge.test.ts
npm run typecheck
npm run test:types
```

## 9. 人工兜底

自动对冲未完成时，先查看：

```powershell
npm run account:state
npm run rotation:status
```

人工命令仍然保留：

```powershell
npm run hedge:residual -- --batch <batchId> --confirm <batchId> --config config/live-rotation.toml --dry-run
npm run hedge:residual -- --batch <batchId> --confirm <batchId> --config config/live-rotation.toml
npm run hedge:residual -- --reconcile-hedge <hedgeBatchId>
```

任何未知订单都不要重复提交。人工核对交易所后台和本地
`order_events` 后，再决定是否 reconciliation。

## 10. 尚未覆盖

- 自动提币补库存；
- 跨交易所库存净额对冲；
- 超过亏损上限后的自动等待回归；
- Telegram/Discord 告警。

## 11. 实盘事件：并行 FOK 卖腿成交、买腿失败（2026-10-30）

`S1-430906-1793300070996` 在 Gate/Bitget 并行执行：

```text
Gate buy FOK   1174 WARD @ 0.004172   -> FOK_NOT_FILL, filled 0
Bitget sell FOK 1174 WARD @ 0.004197  -> filled 1174, quote 4.927278 USDT
```

预检盘口里 Gate 卖一 `0.004172` 有 1539 WARD，但订单到达前该档消失，FOK
拒绝部分成交。Bitget 卖腿先成交，于是记录 `1174 WARD` 的 short residual。

旧版本 residual hedge 只支持 long，自动路径返回
`only_long_residual_hedge_is_supported`，kill switch 保持打开。修复后：

```text
hedge execution       18
side                  buy
filled                1174 WARD
averagePrice          0.0047899705025554
quote cost            5.62342537 USDT
fee                   1.174 WARD (base)
net base delta        1172.826 WARD
realized profit       -0.705996998722 USDT
```

这次手工回补没有 gross-up，base 手续费让净 base 少 1.174 WARD，约
0.0056 USDT，属于不可交易 dust。新代码已经改为：

```text
gross buy amount = residual / (1 - taker_fee_rate)
```

并把 `max_loss_usd` 从 `0.05` 提高到 `1`，使同类约 0.7 USDT 的自动风险收口
可以在 supervisor 内完成，而不是留下空头等待人工。
