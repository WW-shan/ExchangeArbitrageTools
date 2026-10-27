# S1 事件驱动热路径设计（2026-10-22）

范围：只讨论 S1（跨交易所、同 base/quote、两腿、双向现货）。S2/S3/S4 不在本文。

## 1. 目标与非目标

目标：

- WebSocket 盘口变化后，尽快评估受影响的 S1 路线，而不是等固定定时器。
- 只评估发生变化的 `base/quote` 组，避免全量 `O(venues² × bases)` 扫描。
- BBO 或前 `hot_depth_levels` 档（默认 3）变化才唤醒；更深档位更新不触发热扫。
- 把“接近门槛但还没通过”的路线提升为 hot，优先占用 WS 订阅和热扫资源。
- 用真实记录统计每条路线是否值得继续扫，而不是凭感觉加币种/交易所。
- 重启后从最近有效路线恢复 hot 集合，不让历史发现归零。

非目标：

- 不在本文改执行器、签名、下单、转账。
- 不把 S1 扩成多跳/跨报价；那属于 S2 图算法。
- 不引入合约乘数别名（`kPEPE`/`1000PEPE`）的执行单位翻译；见第 8 节。

## 2. 数据流

```text
ccxt.pro watchOrderBook
        |
        v
BookStore (latest book per venue|symbol)
        |
        | onBook(book)
        v
ScannerService.onBookUpdate(book)
        |
        |-- BBO fingerprint unchanged? -> return
        |-- dirtyBooks.add(venue|symbol)
        |-- wake hot waiters
        v
ScannerService.scanUpdates()
        |
        |-- drain dirtyBooks
        |-- map dirty symbol -> {base, quote}
        |-- pairIndex[quote|base] -> all venues with a fresh WS book
        |-- evaluateS1Group() -> record/paper/gate/route stats
        v
SQLite opportunities / episodes
```

全量 `scanOnce()` 仍然存在，但职责收窄：

- universe 刷新（按成交量/tier）。
- S2 三角与跨所图。
- S3/S4/BSC（由 `main.ts` 在全量周期里调用）。
- REST-only 币种兜底、健康快照、episode 清理。

## 3. 唤醒条件

`onBookUpdate` 对每个 `(venue, symbol)` 维护一个 top-N 指纹（`hot_depth_levels`，默认 3）：

```text
bid[0].price|bid[0].amount;bid[1].price|bid[1].amount;... # ask[0]...
```

只有指纹变化才写入 `dirtyBooks`。这样：

- 深度第 4 档变化但前三档不变：不触发热扫。
- 前 3 档里某一档数量变化：触发热扫（可吃容量变了）。
- 只有 sequence/nonce 变化：不触发热扫。
- BBO 价格或数量变化：立即唤醒。

风险：如果只改第 4 档以后，而某个已有效机会的容量发生变化，热扫不会立刻重算；下一次
全量 `scanOnce()`（默认 5s）会兜底。对 $10–30 名义额的 S1 来说，前三档已经覆盖绝大多数
可执行容量；`hot_depth_levels` 可调到 5 或更高，代价是更多热扫。

## 4. 合并与节流

- `hot_scan_debounce_ms`（默认 25ms）：同一批 tick 合并，避免每笔更新都做 Decimal 深度计算。
- `hot_scan_budget_ms`（默认 250ms）：一次热扫的软时间预算。超预算的组会放回
  `dirtyBooks`，下一次事件继续处理；`summary.deferredGroups` 记录被延后的组数。这样突发
  更新不会把主循环卡住，也不会丢更新。
- `ws_scan_interval_ms`（默认 1000ms）：没有 WS 事件时的兜底唤醒上限；不是检测周期。
- 热扫只使用新鲜 WS 盘口；`allowRestFallback=false`，避免一次事件触发大量 REST。
- 全量 `scanOnce()` 仍允许 REST fallback。
- `closeStaleEpisodes` 在热扫里最多每秒一次，避免高频 SQLite 写。

## 5. 全量/热扫职责表

| 能力          | `scanOnce()`     | `scanUpdates()`           |
| ------------- | ---------------- | ------------------------- |
| universe 刷新 | 是               | 否                        |
| S1 评估       | 全量 active base | 仅 dirty base/quote       |
| WS 优先       | 是               | 是（只接受新鲜 WS）       |
| REST fallback | 是               | 否                        |
| S2/S3/S4      | 是               | 否                        |
| 健康快照      | 是               | 否                        |
| episode 清理  | 是               | 最多 1 次/秒              |
| 热订阅刷新    | 是               | 是（有 dirty 标记时限频） |

## 6. 热订阅与 near-miss

`promoteHot(venue, market)` 满足以下任一条件时触发：

- S1 结果 `valid=true`。
- 净边际 `netProfitBps >= minNetProfitBps - hot_near_miss_bps` 且 `> 0`。

效果：

- 两个 leg 的 `(venue, symbol)` 进入 `hotUntil`。
- `syncSubscriptions()` 优先排序 hot 币种，允许 hot 的 top500 币种进入订阅集。
- 最多每 `hot_subscription_refresh_ms`（默认 5s）重订阅一次，避免抖动。

这样即使某条路线暂时差几个 bps，也会继续获得 WS 数据，而不是掉回 10 分钟一次的 REST。

启动时还会调用 `seedHotFromRoutes()`：读取最近 `hot_seed_lookback_ms` 内至少产生过 1 次
有效 S1 的路线，把两条 leg 加入 hot，TTL 为 `hot_seed_ttl_ms`。这样重启后仍会优先订阅
历史上真正出过机会的路线；没有有效样本的路线不会被 seed。

## 7. 路线统计反馈

`ArbitrageRepository.s1RouteStats()` 按 `instrument + venue_buy + venue_sell` 聚合：

- `samples`：所有记录样本。
- `evaluatedSamples`：真正完成深度计算的样本（排除 early-return 的 0 值）。
- `validSamples` / `evaluationRate` / `validRate`：有效机会数、深度评估率、有效/评估比例。
- `avgNetBps` / `maxNetBps`：只统计已评估样本。
- `episodes`、`medianDurationMs`、`p90DurationMs`、`maxDurationMs`。

CLI：

```powershell
npm run routes:stats -- --since-hours 24 --limit 30
npm run routes:stats -- --since-hours 168 --min-valid 3 --json
```

用途：

- 找出“样本多但从未有效”的噪音路线，降低订阅优先级。
- 找出“有效率高、寿命长”的路线，优先分配 hot 资源。
- 对比不同交易所组合，而不是只看总机会数。

## 8. 已知未覆盖

### 8.1 合约乘数/别名（已完成）

`kPEPE`、`1000PEPE` 与 `PEPE` 已按同一规范资产处理。adapter 保留
`exchangeSymbol`，S1 使用归一化 book 和规范数量；executor 在下单前把数量和价格
换回交易所单位。别名 mid 偏差超过 200bps 时不配对，存储的乘数与当前市场不一致时
执行层 BLOCKED。

实现与边界见 `docs/s1-base-multiplier-design.md`。S2/S3 和 BSC 映射暂不消费带乘数
的市场，避免在未做图算法单位传播前混入 1000 倍数量。

### 8.2 机会窗口

GapX 把连续 tick 合并成独立窗口（>2s cooldown）。我们目前有 valid episode（15s gap）
和 route cooldown；`analyze:feed --window-gap-ms 2000` 已在离线分析里做窗口汇总，输出
`opportunityWindows.count/medianMs/p90Ms/maxMs`。live 机会还没有
`windowId/windowMaxBps/windowSamples` 字段；先用录制数据量化，再决定是否落库。

### 8.3 延迟后到达的 shadow audit

Brunop5 的 `EXPIRED_BEFORE_ARRIVAL` 会在“机会出现后经过执行延迟”再检查一次。我们当前
没有在 live 热路径里加延迟定时器；建议先用 `record_feed` + `replay:feed` 量化，再决定是否
把 `arrivalNetBps` 写入 metadata。

## 9. 配置

```toml
[scanner]
feed_mode = 'websocket'
ws_scan_interval_ms = 1000      # fallback wake-up, not detection cadence
hot_scan_debounce_ms = 25
hot_depth_levels = 3
hot_scan_budget_ms = 250
hot_near_miss_bps = 5
hot_subscription_refresh_ms = 5000
hot_seed_enabled = true
hot_seed_lookback_ms = 604800000
hot_seed_limit = 30
hot_seed_ttl_ms = 3600000
scan_interval_ms = 5000         # full pass: universe/S2/S3/REST fallback
```

## 10. 验证

- `apps/scanner/tests/scanner-hot-scan.test.ts`：
  - 首次 WS 更新后 `scanUpdates()` 产生 S1。
  - 无更新时返回 `undefined`，不空转。
  - 只改第 4 档、前三档不变时不触发；改第 2 档数量时触发。
  - BBO 变化后只评估 dirty group，并产生新的 S1。
- `packages/storage/tests/route-stats.test.ts`：
  - 有效样本数、平均/最大净边际、episode 数、p50 寿命。
- `npm run check`：46 个测试文件 / 243 个测试 + 20 批回测。

## 11. 实盘前仍需外部条件

- 至少两家可达交易所的 WS（当前网络只有 Gate 稳定可达；MEXC/WEEX 需要代理）。
- 真实只读/交易 key（无提现权限、IP 白名单）。
- 24 小时只读 soak，确认 event-driven 下没有漏扫/重扫风暴。
