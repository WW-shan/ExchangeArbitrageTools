# WARD S1 执行质量诊断与优化方案 - 2026-11-18 晚

## 1. 诊断方法

不是凭感觉优化，而是逐笔回放数据库里的真实 preflight 与成交记录：

- `executions.preflight_json`：下单前重新拉取的盘口、限价、数量
- `execution_legs`：每腿请求量、成交量、成交价、终态
- `audit_logs`：自动 hedge 是否触发、失败原因

## 2. 已确认的事实

### 2.1 失败腿不是固定在某一边

| 交易所  | 方向 | 腿数 | 零成交 | 零成交率 |
| ------- | ---- | ---: | -----: | -------: |
| Bitget  | 买   |   17 |      5 |    29.4% |
| Bitget  | 卖   |   13 |      5 |    38.5% |
| Gate.io | 买   |   18 |      7 |    38.9% |
| Gate.io | 卖   |   18 |      2 |    11.1% |

两边买入腿都不稳，Gate 卖出腿明显最稳。所以不能简单地“换一边做”，问题在买入腿本身。

### 2.2 限价贴死在盘口第一档

逐笔比对 `refreshed.expectedBuyPrice` 与 preflight 盘口 `asks[0]`：

- 绝大多数订单 `buyLimitVsAskBps = 0.0`
- 卖腿同理 `sellLimitVsBidBps = 0.0`

也就是限价等于第一档原价，没有任何价格缓冲。

### 2.3 WARD 的 tick 约 6 bps

|    价格 |   1 tick |   占价格 |
| ------: | -------: | -------: |
| 0.00160 | 0.000001 | 6.25 bps |
| 0.00163 | 0.000001 | 6.13 bps |
| 0.00169 | 0.000001 | 5.92 bps |

价格只要向上跳 1 个 tick，贴价买单就必然 FOK 不成交。

### 2.4 失败集中在中等利润单

最近 36 笔 S1 的 preflight 净利分布：中位 37.7 bps，P25 13.9 bps，P75 62.1 bps。

单边失败的 4 笔分别是 39.3 / 51.9 / 61.4 / 44.9 bps，全部落在中位区间。原因很直接：这些单的利润空间只有 6~10 个 tick，跳 1~2 个 tick 就把套利空间吃光，FOK 自然无法成交。

### 2.5 有一个真实 bug：自动 hedge 被错误判过期

`S1-945817`：

- 下单 3.6 秒后自动 hedge 就触发了
- 结果 `residual_book_stale_or_invalid`，`attempted=false`
- 492 秒后才人工补单，亏损 -0.025 USDT

`residual-hedge.ts` 确实每次重新 `fetchOrderBook`，但用的校验上限是 `settings.maxOrderbookAgeMs = scanner.max_orderbook_age_ms = 20000`。这个值本来是给低流动性监控用的，却被拿来卡“必须立刻补单”的路径。要么是 REST 返回慢、要么是 exchangeTimestamp 判定过严，结果把一笔本可自动收口的单拖成人工处理。

### 2.6 单笔失败的代价远大于单笔成功

最近 24 小时：6 笔盈利合计 +0.1374 USDT，4 笔失败合计 -0.1548 USDT。

- 平均盈利 0.0229 USDT
- 平均亏损 0.0387 USDT
- 亏损/盈利 = 1.69 倍

按 60 bps 中位利润、6.6 USDT 仓位算，单笔理论盈利约 0.0396 USDT；一次 40% 失败率下的补单亏损约 0.039 USDT，等于把成功单的利润全部抹掉。

## 3. 优化方案（按收益/风险排序）

### P0-1 给买入腿加 tick 感知缓冲（预计把零成交率从 30-40% 降到 10% 以内）

当前问题：限价 = 第一档原价，0 bps 缓冲。

建议：买入腿限价 = `ceilToStep(bestAsk * (1 + bufferBps/10000))`，卖出腿限价 = `floorToStep(bestBid * (1 - bufferBps/10000))`。

缓冲取值建议：

- 按 tick 自适应：`bufferBps = max(1 tick 对应的 bps, 3 bps)`，WARD 即约 6.3 bps
- 同时把实际成交价上限纳入利润检查：加缓冲后重算净利，必须仍 >= `min_net_profit_bps`
- 也就是说：宁可少做几笔，也不能做“加了缓冲就没利润”的单

代价可量化：6.6 USDT、6.3 bps 缓冲 = 0.0042 USDT/笔，仅占中位利润 0.0396 USDT 的 10.6%。用 10% 的利润换掉 30~40% 的失败率，期望值明显改善。

### P0-2 提高最低净利门槛，过滤“薄利单”

失败集中在 30~62 bps。建议把 WARD 的 `min_net_profit_bps` 从 5 提到 25~30：

- 6.6 USDT 仓位下，25 bps = 0.0165 USDT 毛利
- 加 6.3 bps 缓冲后仍留有约 19 bps 安全垫
- 回测中位 40~72 bps，说明合格信号仍然充足，不会把机会掐死

### P0-3 修 hedge 的 freshness 判定

现在用 20 秒的通用盘口年龄卡补单路径，不合理：

- 补单是危机处置，必须“重拉即用”
- 建议给 residual hedge 单独配置 `residual_hedge_book_max_age_ms = 3000`
- 并且放宽 `exchangeTimestamp` 的严格校验：以本地 `receivedAt` 为权威，`exchangeTimestamp` 只做辅助
- 这样 S1-945817 那种 3.6 秒就触发的补单能真正执行，而不是拖 8 分钟

### P1-1 买入腿优先，串行执行做对照实验

代码里已经有串行“先买后卖”路径（`leg_mode='serial'`），只是当前配置用了 `parallel_fok`。

建议：

- 先完成 P0-1/P0-2，用数据验证并行 FOK 的失败率是否降到可接受
- 若仍高于 15%，切到串行 buy-first 做 A/B
- 串行必须保留“买腿失败则直接放弃、不卖”的保护；买腿成功而卖腿失败则进 residual hedge
- 不盲目切换：串行的风险是买到了却卖不掉，必须先用小仓位验证

### P1-2 按信号利润动态决定仓位，而不是固定 6.6 USDT

当前所有信号都按可用余额的同一比例下单。但薄利单加缓冲后利润更薄，应该：

- 高 bps 信号（>100 bps）用满可用余额
- 中低 bps 信号（25~100 bps）按比例缩小，保证“单笔预期利润 >= 2 倍失败成本”

### P2 记录每次 FOK 的真实原因分布

现在只知道“零成交”，不知道是价格跳、深度消失还是限价被拒。建议在 `execution_legs.metadata` 记录：

- 提交时盘口 BBO
- 限价与 BBO 的 bps 差
- venues 返回的原始错误码
- 成交腿的实际滑点

积累 100 笔后，就能用数据回答“缓冲应该设 6 bps 还是 12 bps”。

## 4. 预期效果（保守估算）

以 6.6 USDT、每天 46 个合格机会、中位 60 bps 为基准：

| 方案                 | 单笔利润 | 成交率 |     期望每天 | 备注                   |
| -------------------- | -------: | -----: | -----------: | ---------------------- |
| 现状                 |   0.0396 |   ~60% | 约 1.09 USDT | 实际被补单亏损吃掉     |
| 加 6.3 bps 缓冲      |   0.0354 |   ~85% | 约 1.38 USDT | 利润略降，成交率显著升 |
| 加缓冲 + 门槛 25 bps |   0.0354 |   ~85% | 约 1.38 USDT | 机会数减少但更稳       |
| 再加串行 buy-first   |   0.0354 |   ~90% | 约 1.46 USDT | 需小仓位验证           |

这些是理论上限，不含库存切换成本和行情消失，实际会低一些。但方向很明确：**先提高成交率，再考虑放大仓位**。

## 5. 不建议做的事

- 不要继续放大单笔金额：失败成本会同比例放大
- 不要靠增加过滤器来“避免亏损”：失败发生在成交瞬间，过滤不掉
- 不要在没有 A/B 数据前直接切串行：买到卖不掉的风险更贵

## 6. 下一步执行顺序

1. 给买入/卖出限价加 tick 感知缓冲，并在加缓冲后重算利润
2. 把 WARD 的 `min_net_profit_bps` 提到 25
3. 单独放宽 residual hedge 的盘口 freshness 判定
4. 跑 24 小时，统计零成交率与单笔盈亏
5. 若零成交率仍 > 15%，切串行 buy-first 小仓位 A/B

## 7. 2026-11-18 live evidence

Replaying S1-1053201/1053213/1053215 showed the signal book age was 43-56 ms and the
spread was genuine (0.001689 buy vs 0.001704 sell), but preflight spent 2441 ms on
`balanceSource: rest`. The edge disappeared while waiting on a private balance call.

Root cause: `PreflightCache.balancesForVenue` required every currency on the venue to be
fresh, so a dormant long-tail balance invalidated the whole snapshot and forced the hot
path back onto blocking REST.

Fixed: per-currency freshness, a dedicated residual-hedge book window, bounded hedge
retries, and automatic kill-switch release after a confirmed hedge.
