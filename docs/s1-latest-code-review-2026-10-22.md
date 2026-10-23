# S1 最新开源代码对照与优化点（2026-10-22）

方法：用 GitHub Search API 按 `pushed:>2025-06-01`、`sort=updated` 检索，逐个读取仓库元数据、目录树与核心源码（不是只看 README）。下面标注了最后推送时间与具体文件。

## 1. 参考项目

| 仓库                                        | 最后推送   | 语言       | 与 S1 相关的做法                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST` | 2026-10-20 | Rust       | Aster/Lighter/Hyperliquid 跨所 taker 套利。`taker/arb.rs`：热/冷路径分离，f64 预筛 + Decimal 精确门槛，双腿并发 IOC，`depth_supported_qty`/`liquidity_multiple`；`taker/entry_gate.rs`：按历史 `expected_net_margin_bps` 的滚动百分位门槛；`taker/book_sanity.rs`：WS 盘口与 REST 交叉校验、连续失败熔断 + 冷却、连续成功才解封；`inventory.rs`：净额库存、最小对冲量、reduce-only。 |
| `flp1/bot-arb-cripto`                       | 2026-10-19 | Python     | 按配置名义额沿盘口做 VWAP 成交（不只看最优价）；枚举有序交易所对；每个拒绝原因写入 CSV；用中位价偏离过滤异常价；kill-switch 文件；即使低于阈值也记录 best_seen。                                                                                                                                                                                                                     |
| `HurbetAlex/crypto-arbitrage-bot`           | 2026-10-21 | Python     | 利润必须落在 `(min, max)` 区间——上限用于剔除下架/停牌造成的假价差；成交额下限；按 `(symbol, buy, sell)` 去重冷却。                                                                                                                                                                                                                                                                   |
| `charlie-hk/crypto-arbitrage-scanners`      | 2026-10-20 | Python     | `fetch_trading_fees()` 拉取账户真实逐对 taker 费率并识别零费率对；排除 `:` 结算符号；三角 + 跨所，跨所检查充提；Telegram 去重。                                                                                                                                                                                                                                                      |
| `q0821/cross-exchange-arbitrage-bot`        | 2026-10-22 | TypeScript | 资金费率套利：`净收益 = 费率差 -                                                                                                                                                                                                                                                                                                                                                     | 价差 | - 手续费`，前端费率提示、阈值设置、WebSocket 契约与机会历史。 |
| `bsomar16/crypto-arb-scanner`               | 2026-10-22 | Python     | 风控引擎：单笔名义额、总敞口、按交易日志计算的当日已实现亏损、kill switch。                                                                                                                                                                                                                                                                                                          |
| `whyst0ne/crypto-arbitrage-scanner`         | 2026-10-21 | Python     | 极简跨所扫描：最优 bid/ask、扣双边 taker、阈值输出 JSON。                                                                                                                                                                                                                                                                                                                            |
| `hummingbot/hummingbot`                     | 2026-10-20 | Python     | 订单管理/执行参考（订单生命周期、cancel/replace、多交易所连接）。                                                                                                                                                                                                                                                                                                                    |

## 2. 我们的 S1 vs 最新代码

我们已经领先的地方（这些项目多数没有）：全链路 Decimal、执行状态机、未知订单不重试、重启对账、审计可重建、fail-closed、37 所 spot 覆盖、WS 共享币种订阅裁剪、按 base 并发抓取。

下表是实施前的差距清单；第 4 节列出本轮已全部落地的对应实现。

仍然欠缺、且最新代码里有现成做法的：

| 能力       | 我们的现状                        | 最新做法                                             | 差距                                     | 优先级         |
| ---------- | --------------------------------- | ---------------------------------------------------- | ---------------------------------------- | -------------- |
| 入场阈值   | 固定 `min_net_profit_bps`         | `entry_gate.rs` 滚动百分位（按路由/方向）            | 固定阈值无法适应行情波动；已实现为可选项 | P0（本轮已做） |
| 费率精度   | 每所单值覆盖 / CCXT 通用费率      | `fetch_trading_fees()` 逐对真实费率 + 零费率识别     | 我们的净利可能系统性高估/低估            | P0             |
| 盘口真伪   | 本地 stale / 中位价偏离           | `book_sanity.rs` WS vs REST 交叉校验 + 连续失败熔断  | 冻结/错位 WS 盘口仍可能产生假机会        | P0             |
| 可成交深度 | 逐档吃深度 + 最优名义额           | `liquidity_multiple` + 深度目标/可用/最差价/层数指标 | 没有“深度需为目标的 N 倍”缓冲            | P1             |
| 热路径性能 | 全量 Decimal、批量循环            | f64 预筛、无锁读、热路径无 I/O/REST、BBO 变化驱动    | 37 所全量评估有冗余计算                  | P1             |
| 费率来源   | 缺失即 fail-closed                | `FeeEvidence` / `FeeProvenance`（真实/估算/默认）    | 无法区分“真实费率”和“兜底费率”           | P1             |
| 库存对冲   | 记录未对冲量 + rebalance 计划     | 净额库存、最小对冲量、reduce-only 校正               | 缺自动/半自动对冲落地                    | P1             |
| 去重       | `signal_cooldown` 按 venue+symbol | 按 `(symbol, buy, sell)` 路由去重                    | 粒度略粗                                 | P2             |
| 异常上限   | `suspicious_spread_bps`           | 显式 `max_profit_pct` 上限剔除下架/停牌              | 已有近似，可补齐                         | P2             |

## 3. 本轮已实现：滚动百分位入场门槛

新增 `apps/scanner/src/entry-gate.ts`（`PercentileEntryGate`），灵感来自 `djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST` 的 `taker/entry_gate.rs`：

- 每个 `instrument|buy->sell` 路由维护最近窗口内的 `netProfitBps` 样本；
- 样本数达到 `entry_gate_min_samples` 后，只有当前净边际 ≥ 历史 `entry_percentile` 分位才放行；
- 用“历史（不含当前样本）”算阈值，避免自我抬高门槛；
- 内存有界：最多 `maxKeys` 个路由、每路由 `maxSamplesPerKey` 个样本，同时按时间窗口裁剪；
- 被拒时写入 `below_percentile_gate`，并把 `percentileThresholdBps` / `entryGateSamples` 写进 metadata。

配置（默认关闭，不改变现有行为）：

```toml
entry_gate_mode = 'off'        # off | percentile
entry_percentile = 90
entry_gate_window_ms = 3600000
entry_gate_min_samples = 50
```

测试：`apps/scanner/tests/entry-gate.test.ts`（3 个用例：关闭即放行、百分位放行/拒绝、内存上限）。

集成验证（2026-10-22）：中市值 16 币、6 所、8 轮、2bps 情景下，`below_percentile_gate` 拒绝 12 次，同时仍保留 16 条有效 S1（净利 0.82–5.62bps），说明门槛过滤低分位边际时没有把高分位机会一起挡掉。

## 4. 全部优化已落地（2026-10-22）

1. **逐对真实费率（P0，代码完成）**：`CcxtCexAdapter.fetchTradingFees()` 拉取账户级 `{symbol: {taker, maker}}`；`npm run fees:fetch` 用加密只读凭证写入 `data/fees.json`；`mergeAccountFeeFile` 合并成 per-symbol override（`source=account`）；`withFeeOverride` 按 `exchangeSymbol`/`unifiedSymbol` 覆写市场费率；零费率用 `!== undefined` 保留。需要真实 key 才能产生文件。
2. **WS vs REST 盘口校验（P0）**：`apps/scanner/src/book-sanity.ts` 的 `BookSanityMonitor` + `bookDeviationBps`；每 `book_sanity_interval_ms` 抽样 `book_sanity_sample_size` 个订阅币种，比较 WS/REST 最优 bid/ask；偏离超过 `book_sanity_max_deviation_bps` 连续 `book_sanity_required_failures` 次后熔断该 `(venue,symbol)`，冷却 `book_sanity_cooldown_ms`，连续 `book_sanity_required_successes` 次正常才解封；被熔断盘口以 `book_sanity_blocked` 拒绝。
3. **深度流动性倍数（P1）**：`apps/scanner/src/depth.ts` 计算 top-N 档名义深度；`liquidity_multiple`（默认 1.5）把可下名义额限制为较弱一腿深度 / 倍数；机会 metadata 记录 `depthCapNotional`、`liquidityMultiple`、买卖两侧 `*DepthLevels`/`*DepthWorstPrice`。
4. **事件驱动增量评估 + f64 预筛（P1）**：`prefilter_enabled` 先用 f64 估 top-of-book 扣费净边际，低于 `prefilter_floor_bps` 直接跳过 Decimal 深度计算；`incremental_evaluation` 用 `(venue,symbol,sequence/receivedAt)` 指纹跳过盘口未变且上轮无有效机会的 base；`ScanSummary` 新增 `prefiltered`/`skippedUnchanged`。
5. **费率来源标记（P1）**：`MarketMetadata.feeProvenance = config | account | ccxt | default`；`toMarket` 标 `ccxt/default`，配置/账户覆盖标 `config/account`；机会 metadata 写 `buyFeeProvenance`/`sellFeeProvenance`，审计可区分真实费率与兜底。
6. **库存净额与 reduce-only（P1）**：`packages/core/src/inventory-netting.ts` 提供 `applyInventoryFill`（同向加权、反向净额、已实现盈亏、翻转重置均价）、`reduceOnlyHedgeQty`（不超持仓、按步长、子最小单仅允许全平）、`planLongInventoryHedges`（按 venue+asset 汇总 S1 多头未对冲库存）；`npm run rebalance:plan` 现在输出 `hedgeOrders`（只读计划，不签名/不下单）。
7. **路由去重与异常上限（P2）**：`route_cooldown_ms` 按 `instrument|buy->sell` 抑制重复的 paper/热标记，但仍持久化机会并在 metadata 标 `duplicateRoute`；`suspicious_spread_bps` 继续作为毛价差上限剔除下架/停牌类异常。

新增/修改配置：`fee_file`、`liquidity_multiple`、`book_sanity_*`、`prefilter_*`、`incremental_evaluation`、`route_cooldown_ms`、`entry_gate_*`。

## 5. 验证

- `npm run check` 通过：42 个测试文件 / 227 个测试 + 20 批回测。
- 覆盖率：81.00% statements / 72.39% branches / 79.22% functions / 85.01% lines。
- 新增测试：`entry-gate`、`book-sanity`、`depth`、`fee-file`、`inventory-netting`、`scanner-optimizations`（盘口熔断/预筛/增量跳过）。
- 说明：本轮末尾 `127.0.0.1:10808` 代理停止监听（`ECONNREFUSED`），真实网络 smoke 无法复跑；以上为离线套件与此前真实数据验证结果。恢复代理后可直接复跑 `npm run smoke:s1` 与 `npm run fees:fetch`。

## 6. 仍需外部输入（不是代码）

- 真实 trade/read_only key 才能运行 `fees:fetch` 与小额实盘。
- 真实 VIP/maker 费率。
- 代理恢复（10808）。

## 7. 第二轮复核：P0-1 之前只完成了一半（2026-10-22 晚）

第一轮把 `BookStore`、`ccxt.pro` 和 WS 盘口接进来了，但“事件驱动”没有真正落到扫描循环：
`main.ts` 仍然是 `while -> scanOnce -> sleep(ws_scan_interval_ms)`，默认 1 秒；`scanOnce`
每次遍历所有 active base。文档里写的“BBO 变化后 50ms 内完成一次 S1 评估”并未实现。

这次重新下载并阅读了最近仓库的源码（不是只看 README）：

| 仓库                                                      | 最近推送   | 读到的关键实现                                                                                                                                                 |
| --------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tfrmma/cross-venue-arbitrage`                            | 2026-06-08 | `asyncio.Event` 由 BBO 更新触发；`PriceLadder` 只在 BBO 变化时重建；f64 预筛后才做精确计算。                                                                   |
| `djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST`               | 2026-10-20 | `scan_wake: Notify` + `wait_for_scan(poll_interval_ms)` 兜底；`scan_inputs_unchanged` 跳过无变化输入；`FULL_EVAL_FLOOR=250ms`；SCREENER 用真实 tick 排名路线。 |
| `sakshi-rathi-work/GapX`                                  | 2026-10-18 | 300ms 扫描循环；把连续 tick 合并成独立机会窗口（>2s cooldown）；记录检测延迟和数据年龄。                                                                       |
| `Brunop5/binance_triangular_arbitrage`                    | 2026-10-17 | “theoretical / candidate / traded” 三层审计；延迟后到达时重新检查，标注 `DEPTH_ILLUSION`、`EXPIRED_BEFORE_ARRIVAL`。                                           |
| `rahulrajsinghwork15072005-a11y/crypto-arbitrage-monitor` | 2026-10-21 | 机会寿命、误报率、venue reliability、replay 统计。                                                                                                             |
| `HurbetAlex/crypto-arbitrage-bot`                         | 2026-10-21 | 符号归一化、profit 上下限、按路线冷却。                                                                                                                        |
| `flp1/bot-arb-cripto`                                     | 2026-10-19 | 9.6 小时真实 WS paper：25,623 个原始机会只有 20 个正值，且全部来自冻结盘口；说明“先发现、再证伪”必须分开记录。                                                 |
| `charlie-hk/crypto-arbitrage-scanners`                    | 2026-10-20 | 账户逐对费率、零费率对识别、跨所充提检查。                                                                                                                     |

### 本轮已补齐

1. **真正的 S1 事件驱动热路径**：`BookStore.onBook` 把 `(venue, symbol)` 写入 dirty set 并唤醒
   `scanUpdates()`；主循环在两次全量 `scanOnce()` 之间只做热扫。热扫只评估受影响的
   `base/quote` 组，不再全量遍历；25ms debounce 合并同一批 tick；没有更新时等待下一次
   WS 事件或 `ws_scan_interval_ms` 兜底。`scanOnce()` 仍每 `scan_interval_ms` 跑一次，
   负责 universe 刷新、S2/S3、REST-only 兜底和健康记录。
   热扫有 `hot_scan_budget_ms`（默认 250ms）软预算；超预算的组放回 dirty set，由下一次
   事件继续，避免突发更新卡住主循环。
2. **BBO + top-N depth 唤醒**：`onBookUpdate()` 对每侧前 `hot_depth_levels` 档（默认 3）
   的价格与数量做指纹；BBO 或前几档容量变化才进入热扫，避免深度里无关档位更新打满 CPU。
   这是 `tfrmma` / `djienne` 的共同做法，同时避免只看 BBO 漏掉“BBO 没变但可吃深度变大”的机会。
3. **热订阅与 near-miss 聚焦**：有效机会或“距离门槛 `hot_near_miss_bps` 以内”的机会都会
   把两个 `(venue, symbol)` 提升为 hot；`syncSubscriptions()` 优先订阅 hot，并允许 hot 的
   top500 币种进入订阅集。以前只有 valid 才 promote，而且 promote 不会触发重新订阅。
4. **路线密度/寿命统计**：新增 `ArbitrageRepository.s1RouteStats()` 和
   `npm run routes:stats`，按 `instrument + buy->sell` 输出样本数、有效数、有效率、平均/最大
   net bps、episode 数、p50/p90 寿命。对应 `djienne` SCREENER 的“哪些路线值得继续扫”和
   GapX 的“独立机会窗口”思路。启动时 `seedHotFromRoutes()` 会把最近 7 天内至少有过 1 次
   有效 S1 的路线重新标记为 hot，重启后不会丢失订阅优先级。

配置新增：`hot_scan_debounce_ms`、`hot_near_miss_bps`、`hot_subscription_refresh_ms`、
`hot_seed_*`。

5. **延迟后到达的离线 shadow audit**：`npm run analyze:feed -- --arrival-latency-ms 100`
   会把每个有效机会在 `t + latency` 的最新盘口上重新评估，输出 `arrival.checked`、
   `arrival.survived`、`arrival.survivalRate`、`arrival.bestNetBps`。这对应 Brunop5 的
   `EXPIRED_BEFORE_ARRIVAL`，但只用于录制数据回放，不增加 live 热路径状态。

6. **机会窗口离线统计**：`analyze:feed` 增加 `--window-gap-ms`（默认 2000），按路线把连续
   有效帧合并成窗口，输出 `opportunityWindows.count/medianMs/p90Ms/maxMs`。这对应 GapX 的
   “3,322 distinct windows”，目前只在分析层，不改变 live 机会记录。

7. **合约乘数/别名端到端**：adapter 把 `kPEPE`、`1000PEPE` 归一为规范的 `PEPE`，
   保留 `exchangeBase`/`baseMultiplier`；scanner 和 paper 使用规范盘口；executor 在
   下单前把数量/价格换回交易所单位，并校验存储乘数。别名 mid 偏差超过 200bps 时跳过。
   设计见 `docs/s1-base-multiplier-design.md`。

### 仍然没有做的（按优先级，不是遗漏）

| 缺口                                     | 最新代码证据                        | 为什么暂不做                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 机会窗口合并（>2s 连续 tick 算一个窗口） | GapX 的 3,322 个 distinct windows   | 当前已有 `opportunity_episodes`（只对 valid）和 `route_cooldown_ms`；要做全量窗口需要新增 `window_id` 或 metadata 汇总，属于分析层增强，不影响热路径发现速度。                   |
| 延迟后到达的 shadow audit                | Brunop5 的 `EXPIRED_BEFORE_ARRIVAL` | 需要保存“机会出现后 50ms 的盘口”再回看；当前 feed recorder 已能录，但 live 热路径里加延迟定时器会增加状态复杂度。建议用 `record_feed` + `replay:feed` 先量化，而不是先加过滤器。 |
| USDT/USDC 跨报价路径                     | 多跳图算法（S2）                    | 这是 3 腿路径，不属于 S1 同 base/quote 范围；S2 已有跨所图，后续在 S2 做更合适。                                                                                                 |
| VPIN / 订单流毒性                        | tfrmma 的 `VPINEstimator`           | 更偏“少做”的风控/选择性过滤，不是当前“更快发现”的主要瓶颈；且需要逐笔成交数据。                                                                                                  |

### 验证

- `npm run check` 通过：45 个测试文件 / 241 个测试 + 20 批回测。
- 新增 `apps/scanner/tests/scanner-hot-scan.test.ts`：验证 WS 更新只评估 dirty 组、无更新时
  不空转、BBO 不变时不触发、BBO 变化后立即产生新的 S1。
- 新增 `packages/storage/tests/route-stats.test.ts`：验证路线有效率、平均/最大净边际和
  episode 寿命统计。
- 新增 `packages/core/tests/market-units.test.ts`、`apps/scanner/tests/scanner-alias.test.ts`、
  `apps/executor/tests/coordinator-alias.test.ts`：验证 1000 倍别名从行情到下单的双向换算。
- 真实事件驱动 smoke（2026-10-23，Gate/WEEX，代理 10808）：0 费率下 11 条有效 S1，
  净边际 0.08–2.59bps；2bps 下 0 条有效。详见 `docs/s1-real-data-findings-2026-10-22.md`
  第 7 节。

结论：第一轮的 6 项优化确实都在，但 P0-1 的“事件驱动”只完成了数据层，没有完成调度层；
这一轮才把它补齐。S1 现在仍有可优化点，但剩余项要么依赖执行单位翻译，要么属于 S2/分析层，
不是“再写几个测试/风控”能替代的发现能力。

详细设计见 `docs/s1-event-driven-hot-path.md`。
逐项核对与剩余项见 `docs/s1-completion-audit-2026-10-22.md`。
