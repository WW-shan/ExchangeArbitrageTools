# S1 优化逐项核对（2026-10-22）

本文只核对 S1（跨交易所、同 base/quote、两腿、双向现货）。结论分两层：

- **代码层**：本文列出的优化项均已落地并有测试/命令证据。
- **实盘层**：真实 key、24 小时只读 soak、真实小额 live batch 仍未完成，属于外部条件，不是代码项。

## 1. 原始 7 项

| #   | 优化项                 | 状态           | 证据                                                                                                                                                                                                                                                                      |
| --- | ---------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 逐对真实费率           | 完成（代码）   | `CcxtCexAdapter.fetchTradingFees()`；`npm run fees:fetch`；`mergeAccountFeeFile()`；`withFeeOverride()` 按 `exchangeSymbol`/`unifiedSymbol` 覆盖；`packages/venues/cex/tests/ccxt-adapter.test.ts` 验证 10bps/2bps/0bps。真实账户费率仍需 key 才能生成 `data/fees.json`。 |
| 2   | WS vs REST 盘口校验    | 完成           | `apps/scanner/src/book-sanity.ts`；连续失败熔断、冷却、连续成功解封；`apps/scanner/tests/book-sanity.test.ts`；`scanner-optimizations.test.ts` 验证熔断后 S1=0。                                                                                                          |
| 3   | 深度流动性倍数         | 完成           | `apps/scanner/src/depth.ts` 的 `bookDepthNotional`/`depthBoundNotional`；`liquidity_multiple` 默认 1.5；`apps/scanner/tests/depth.test.ts`。                                                                                                                              |
| 4   | f64 预筛 + 增量评估    | 完成并加强     | `passesPrefilter()` 在 `estimateS1Return` 之前执行，低边际直接跳过；`incremental_evaluation` 按 base 指纹跳过未变且上轮无有效的组；`scanner-optimizations.test.ts`。                                                                                                      |
| 5   | 费率来源标记           | 完成           | `MarketMetadata.feeProvenance`；机会 metadata 写 `buyFeeProvenance`/`sellFeeProvenance`；`scanner-optimizations.test.ts` 验证 account/config。                                                                                                                            |
| 6   | 库存净额 + reduce-only | 完成（计划层） | `packages/core/src/inventory-netting.ts`；`npm run rebalance:plan` 输出 `hedgeOrders`；`packages/core/tests/inventory-netting.test.ts`。不签名、不转账、不下单。                                                                                                          |
| 7   | 路由去重 + 异常上限    | 完成           | `route_cooldown_ms` 抑制同路线重复 paper；metadata `duplicateRoute`；`suspicious_spread_bps` 保留为毛价差上限；`scanner-optimizations.test.ts` 验证两轮只产生 1 个 paper trade。                                                                                          |

## 2. 第二轮新增（发现能力）

| #   | 优化项                        | 状态           | 证据                                                                                                                                                                                                                                                                             |
| --- | ----------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | 真正的事件驱动 S1 热路径      | 完成           | `BookStore.onBook` -> `ScannerService.scanUpdates()`；只评估 dirty `base/quote`；`scanOnce()` 只做全量兜底/S2/S3/REST；`scanner-hot-scan.test.ts` 验证无更新不空转、更新后产生 S1。                                                                                              |
| 9   | top-N 深度唤醒                | 完成           | `hot_depth_levels` 默认 3；前三档价格/数量变化触发，第 4 档变化不触发；`scanner-hot-scan.test.ts`。                                                                                                                                                                              |
| 10  | near-miss 热订阅 + 重启 seed  | 完成           | `hot_near_miss_bps`；`promoteHot()` 对 valid 或接近门槛的路线提升两条腿；`seedHotFromRoutes()` 从最近有效路线恢复 hot；`scanner-hot-scan.test.ts`。                                                                                                                              |
| 11  | 热订阅预算与优先级            | 完成           | `syncSubscriptions()` 优先 hot，允许 hot top500；`hot_subscription_refresh_ms` 限频；`hot_scan_budget_ms` 超预算组放回 dirty set，`summary.deferredGroups`。                                                                                                                     |
| 12  | 路线密度/寿命统计             | 完成           | `s1RouteStats()` 输出 samples/evaluated/eval%/valid/validRate/avg/max net bps/episodes/p50/p90；`npm run routes:stats`；`packages/storage/tests/route-stats.test.ts`。                                                                                                           |
| 13  | 延迟后到达的离线 shadow audit | 完成（离线）   | `npm run analyze:feed -- --arrival-latency-ms 100`；输出 `arrival.checked/survived/survivalRate/bestNetBps`；合成 feed 验证 1 个有效机会在 100ms 后存活 0 个。                                                                                                                   |
| 14  | 机会窗口离线统计              | 完成（分析层） | `analyze:feed` 新增 `--window-gap-ms`（默认 2000）和 `opportunityWindows.count/medianMs/p90Ms/maxMs`；按路线把连续有效帧合并成窗口。                                                                                                                                             |
| 15  | 合约乘数/别名端到端           | 完成           | `resolveBaseUnits()` + `canonicalMarketForEvaluation()` + `normalizeBookForMarket()`；scanner/paper 用规范单位，executor 下单前换回交易所单位；2% 别名价格校验；`market-units`、`scanner-alias`、`coordinator-alias`、`handoff` 测试。详见 `docs/s1-base-multiplier-design.md`。 |

## 3. 配置清单

```toml
[scanner]
feed_mode = 'websocket'
ws_scan_interval_ms = 1000
scan_interval_ms = 5000
hot_scan_debounce_ms = 25
hot_depth_levels = 3
hot_scan_budget_ms = 250
hot_near_miss_bps = 5
hot_subscription_refresh_ms = 5000
hot_seed_enabled = true
hot_seed_lookback_ms = 604800000
hot_seed_limit = 30
hot_seed_ttl_ms = 3600000
prefilter_enabled = true
prefilter_floor_bps = 0
incremental_evaluation = true
route_cooldown_ms = 60000
liquidity_multiple = 1.5
book_sanity_enabled = true
fee_file = 'data/fees.json'
```

## 4. 验证命令

```powershell
npm run check
npm run coverage
npm run routes:stats -- --since-hours 24 --limit 30
npm run analyze:feed -- --dir data/feed --pair CAKE/USDT --arrival-latency-ms 100
```

当前结果：

- `npm run check`：45 个测试文件 / 241 个测试 + 20 批回测。
- `npm run coverage`：81.71% statements / 73.47% branches / 80.44% functions / 85.60% lines。
- `routes:stats` 在现有 SQLite 上可运行；当前历史样本没有有效 S1，输出为 0 valid，属于真实数据结果。
- `analyze:feed` 合成样例：`arrival.checked=1`、`arrival.survived=0`、`survivalRate=0`。
- 真实 Gate/WEEX 事件驱动 smoke（2026-10-23）：0 费率 11 条有效 S1（0.08–2.59bps），
  2bps 下 0 条有效；热扫 dirty 5–10 组、`deferredGroups=0`。证据：
  `docs/s1-real-data-findings-2026-10-22.md` 第 7 节。

## 5. 仍然欠缺（不是“再加测试/风控”能解决）

| 缺口                                 | 为什么还没做                                                                     | 下一步的正确做法                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 机会窗口落库（live）                 | 离线 `analyze:feed` 已做窗口统计；live 机会还没有 `windowId/windowMaxBps` 字段。 | 先在 24 小时录制数据上跑 `--window-gap-ms`，再决定是否把窗口字段写进 metadata/DB。                                  |
| live 延迟 shadow audit               | 离线版已做；live 热路径加延迟定时器会增加状态和内存复杂度。                      | 先用 `record_feed` 录 24 小时，跑 `--arrival-latency-ms` 看存活率，再决定是否把 `arrivalNetBps` 写进机会 metadata。 |
| USDT/USDC 跨报价 S1                  | 这是 3 腿/跨报价路径，不属于 S1 同 base/quote；S2 图算法更合适。                 | 在 S2 增加稳定币边和转换成本，不要塞进 S1。                                                                         |
| 多账户/资金分配、cancel/replace、KMS | 属于执行与运维层，不是发现层；设计文档已列为 P2。                                | 实盘前按 `docs/execution-risk-design.md` 分阶段做。                                                                 |

## 6. 实盘前外部条件

- 真实只读/交易 key（无提现权限、IP 白名单）。
- 24 小时只读 soak（当前只有短时/数分钟验证）。
- 至少 1 个真实可执行 S1、20 个真实市场 paper batch、10 个手动确认 live batch。
- 真实 VIP/maker 费率，生成 `data/fees.json`。
- 代理恢复（`127.0.0.1:10808`）后复跑 `npm run smoke:s1` 与 `npm run fees:fetch`。

## 7. 结论

原始 7 项优化全部有代码和测试证据；第二轮又补了事件驱动、top-N 深度、near-miss/seed、热扫预算、路线统计、离线延迟审计、机会窗口统计和合约乘数端到端。**代码层 S1 优化清单完成；剩余 live 窗口/延迟审计属于分析层，S2/S3 的乘数传播暂不启用；实盘验证未完成，需要用户提供 key、资金和确认。**
