# S1 优化研究与逐点设计

状态：调研 + 设计，未改代码。
日期：2026-10-22（Asia/Hong_Kong）。
范围：只讨论 S1，即跨交易所现货、同一 base/quote、两腿、双向。S2/S3/S4 不在本文范围。

## 1. 结论先行

S1 现在最缺的不是风控，也不是测试，而是**发现能力**。具体是三点：

1. **发现太慢**：外层循环 5 秒，但真正决定扫描频率的是 `dueTiers`：
   `hot=30s`、`top100=120s`、`top500=600s`。也就是说热门币最快 30 秒才刷一次盘口，
   长尾币 2–10 分钟一次。跨所价差在主流币上通常存活不到 1 秒，这个节奏在结构上抓不到。
2. **只有 REST 快照**：`capabilities.websocket=false`，`fetchOrderBook` 是 REST 快照。
   两个交易所的盘口永远不是同一时刻，天然产生“假价差”；断线冻结的盘口还会制造“看起来很好”的假机会。
3. **费用不真实**：S1 只用单一 `feeTakerBps`，没有 VIP 层级、maker rebate、支付币折扣，
   `rebalanceCostBps` 默认 0。跨所套利在 0.1% 双边 taker 下几乎必亏。

所以优化顺序应该是：**先让数据又快又真，再让成本算得准，最后才谈仓位和执行**。

## 2. 近期开源项目证据（2024–2026）

| 项目                                        |   最近更新 |      规模 | 做法                                                                                                                                    | 可借鉴点                                                                                                                                                       |
| ------------------------------------------- | ---------: | --------: | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rexonelo/barbotine-arbitrage-bot`          |    2026-02 |      647★ | CCXT 跨所现货，盘口级撮合，机会级余额模拟，无限交易所，session 后 rebalance，fake-money 模式                                            | 每个机会先做余额模拟；rebalance 会话化                                                                                                                         |
| `flp1/bot-arb-cripto`                       | 2026-10-19 |         — | Binance/OKX/Bybit WebSocket + paper，9.6 小时 25,623 个跨所机会                                                                         | 真实数据：税后中位 **-0.205%**，仅 **20/25,623 = 0.078%** 为正，且全部是 WS 断线导致盘口冻结（最长 13 分钟）的假信号；风控拦住 14/17，仍有 3 个在 age 边界漏过 |
| `FatihHekim0glu/crypto-arb-scanner`         |    2026-06 |         — | gross→net 瀑布：双边 taker、深度滑点、提现/结算成本；staleness/embargo 防未来函数；半陈旧快照整组作废；DSR 防过拟合                     | 成本瀑布逐层展示；配对级新鲜度；不要用未来数据                                                                                                                 |
| `HurbetAlex/crypto-arbitrage-bot`           | 2026-10-21 |         — | 轮询 spot+futures，统一 symbol，跨所最低 ask/最高 bid，逐腿扣费，只告警不下单                                                           | symbol 归一化；跨所最优腿；明确“只读”                                                                                                                          |
| `sakshi-rathi-work/GapX`                    | 2026-10-18 |         — | Binance depth20@100ms、Coinbase、Kraken WS；300ms 检测循环；$500 深度 walk；2000ms staleness；actionable 标记；SQLite + WS API          | 事件节奏；深度 walk；陈旧阈值                                                                                                                                  |
| `tfrmma/cross-venue-arbitrage`              |    2026-06 |         — | asyncio，L2 WS，**BBO 变化触发而非定时器**；PriceLadder 字典 + 惰性 numpy；cumsum/searchsorted 扫深度；熔断 + 库存再平衡 + 2000ms stale | 事件驱动检测；盘口数据结构；min_net_pnl_bps                                                                                                                    |
| `Patrick-Ehimen/meridian-rs`                | 2026-10-14 |         — | Rust 多所订单簿聚合，统一 depth/VWAP/OFI，gRPC/REST/WS/TUI                                                                              | 统一内部表示；适配器隔离                                                                                                                                       |
| `mkbeh/arb-bot-rs`                          | 2026-08-21 |         — | Rust HFT，CEX & DEX                                                                                                                     | 低延迟工程结构                                                                                                                                                 |
| `tardis-dev/tardis-node` / `tardis-machine` | 2026-10-21 | 367★/313★ | tick 级历史 + 实时标准化行情                                                                                                            | P1 回测数据源                                                                                                                                                  |
| `djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST` | 2026-10-20 |         — | 双引擎、taker-taker、跨引擎亏损停止、dry-run                                                                                            | 引擎级亏损停止；dry-run 先行                                                                                                                                   |

### 跨项目共同结论

- 所有认真做的项目都是 **WebSocket / 事件驱动**；REST 轮询只作为冷门兜底。
- **毛利差很容易找，净利差很稀有**；成本瀑布必须精确到每一腿。
- **冻结/陈旧盘口是假信号的最大来源**；新鲜度、序号、跨所价格 sanity 必须同时有。
- 仓位必须同时受**深度**和**余额**约束。
- 费率层级 / maker rebate 是生死线。
- 机会有生命周期，必须测量衰减，不能拿过期信号去执行。

## 3. 我们 S1 的现状（已核对代码）

| 维度     | 现状                                                                                         | 位置                                                                    |
| -------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 扫描频率 | 外层 5s；`hot=30s`、`top100=120s`、`top500=600s`                                             | `apps/scanner/src/scanner-service.ts` `dueTiers`、`config/default.toml` |
| 行情     | 仅 REST `fetchOrderBook(depth=50)`；`websocket=false`                                        | `packages/venues/cex/src/ccxt-adapter.ts`                               |
| 盘口校验 | 已有 stale、freeze、feed latency、sequence gap、crossed                                      | `packages/core/src/orderbook.ts`                                        |
| 成本     | taker fee + safetyBuffer + minProfit + minNetProfitBps；`rebalanceCostBps` 默认 0            | `packages/core/src/s1.ts`                                               |
| 仓位     | `max_order_notional=30` 上限；可选按深度最优搜索；**无余额约束**                             | `s1.ts` `evaluateS1DirectionOptimal`                                    |
| 健康度   | 计算 `reliabilityScore`，但 S1 只用 A/B/C/D `healthState`                                    | `packages/core/src/health.ts`、`s1.ts`                                  |
| 排序     | 记录所有机会；没有“当前最优”排序；执行器取最新持久化 S1                                      | `scanner-service.ts`、`apps/executor`                                   |
| 回放     | 新增 `feedLatency`、`rawEdgeFrames`、`netOpportunityFrames`、`falsePositiveRate`，但尚无断言 | `apps/scanner/src/replay.ts`                                            |
| 覆盖     | 37 家 spot 场所（34 CEX + 3 DEX），另有 5 家 perp DEX 参考；100 个 base；USDT/USDC           | `packages/venues/cex/src/catalog.ts`、`config/default.toml`             |

### 已实测的环境事实

- `ccxt 4.5.88`，`ccxt.pro` 可用。
- `gate`（即 gateio）`watchOrderBook` 实测成功：BTC/USDT bid 82883 / ask 82883.1，带 `timestamp` 与 `nonce`。
- `mexc`、`weex` 的 REST/WS 在当前网络下连接超时；需要代理或换网络。代码已有 `ARB_HTTPS_PROXY` 支持。
- `ccxt.pro` 里 `gateio` 的 id 是 `gate`，需要显式映射。

## 4. 差距清单（按“能否发现真机会”排序）

| #   | 差距                             | 现状                                 | 证据                                 | 对发现真机会的影响           | 优先级 |
| --- | -------------------------------- | ------------------------------------ | ------------------------------------ | ---------------------------- | ------ |
| G1  | 发现频率过低                     | hot 30s / top100 2min / top500 10min | flp1、GapX、tfrmma 都是 100–300ms 级 | 主流币价差 <1s，基本抓不到   | P0     |
| G2  | 只有 REST，无 WS/重连/序号       | `websocket=false`                    | flp1 假信号全来自冻结盘口            | 既抓不到真机会，又制造假机会 | P0     |
| G3  | S1 无余额约束                    | 只按深度和固定 notional              | barbotine 每个机会做余额模拟         | 报出的机会可能根本下不了单   | P0     |
| G4  | 费率单一、无 VIP/rebate          | 单一 takerBps                        | flp1 中位 -0.205%；费率决定生死      | 真实净利被高估或低估         | P0     |
| G5  | 无跨所价格 sanity / 异常价差上限 | 只有 crossed                         | flp1、HurbetAlex、GapX               | 追着坏数据或停牌币跑         | P0     |
| G6  | 无“当前最优”排序与生命周期门槛   | 记录全部，执行器取最新               | tfrmma 事件驱动 + 衰减               | 执行到过期或次要机会         | P0     |
| G7  | `reliabilityScore` 未接入 S1     | 只用 healthState                     | 我们自己的 health.ts                 | 降级交易所仍在参与           | P1     |
| G8  | 交易所覆盖                       | 37 家 spot + 5 家 perp 参考          | 能力对照表                           | 路线数大幅增加               | 已完成 |
| G9  | 无按路线/币种的机会密度统计      | 无                                   | barbotine、GapX                      | 无法动态聚焦高机会区域       | P1     |
| G10 | 无 tick 级历史                   | 合成 + fixture 回放                  | tardis、GapX                         | 无法验证真实滑点/延迟/成交率 | P1     |

## 5. 逐点设计

### P0-1 事件驱动 WebSocket 行情（最大杠杆）

状态：**数据层已实现（2026-10-22）；调度层 2026-10-22 晚补齐**。新增 `BookStore`、`ccxt.pro watchOrderBook`、`gateio -> gate` 映射、断线指数退避、扫描器 WS 优先 / REST 兜底、`feed_mode` 与 `ws_scan_interval_ms` 配置。真实 Gate WS 冒烟：3/3 订阅有盘口、0 stale，BTC/ETH/CAKE 盘口年龄 13/15/280ms，均带 `sequence` 与 `source=websocket`（MEXC/WEEX/其他交易所在当前网络超时）。

补记（2026-10-22 晚）：第一版仍是 `scanOnce` + 1s sleep 的全量循环，没有达到本节的 50ms 目标。现在 `BookStore.onBook` 写入 dirty set 并唤醒 `scanUpdates()`；热扫只评估受影响的 `base/quote` 组，前 `hot_depth_levels` 档指纹不变不唤醒，`hot_scan_debounce_ms` 默认 25ms；`scanOnce()` 每 `scan_interval_ms` 只做全量兜底、universe/S2/S3/REST fallback。证据：`apps/scanner/tests/scanner-hot-scan.test.ts`。

**目标**：热门与 Top100 币种的盘口延迟 p95 < 300ms，BBO 变化后 50ms 内完成一次 S1 评估。

**设计**

- 在 `CexAdapter` 增加可选能力：
  - `watchOrderBook?(symbol, depth, onBook): Promise<void>` 或返回异步迭代器；
  - `close?(): Promise<void>`。
- 新增 `BookStore`（`packages/venues/cex/src/book-store.ts`）：
  - 以 `venueId|symbol` 为键，保存最新 `OrderBookSnapshot`；
  - 维护 `sequence`/`nonce`，检测缺口即标记 `resync_required`；
  - 记录 `receivedAt`、`exchangeTimestamp`、`source='websocket'`；
  - BBO 变化时触发订阅回调（事件驱动，不轮询）。
- `CcxtCexAdapter` 用 `ccxt.pro` 实现 `watchOrderBook`：
  - id 映射：`gateio -> gate`；
  - 断线指数退避（1s→30s），重连后重新拉快照并校验序号；
  - 保留 REST `fetchOrderBook` 作为冷门/兜底。
- `ScannerService`：
  - `feed_mode = websocket` 时，对 `hot`/`top100` 订阅 BookStore；
  - `top500` 仍可 REST 定时；
  - 收到 BBO 事件后只对受影响 base 的 S1 路线重算，不再全量扫。
- 配置：

```toml
[scanner]
feed_mode = websocket        # websocket | rest
ws_max_book_age_ms = 1000
ws_max_subscriptions = 200
ws_reconnect_min_ms = 1000
ws_reconnect_max_ms = 30000
ws_resync_on_gap = true
```

**验收**

- Gate 单所 WS 连续 10 分钟无断流；序号缺口能自动 resync。
- 盘口 age p95 < 300ms（本地网络允许时）。
- 冻结盘口 fixture 在回放中被 `frozen_orderbook` 拒绝。
- 现有 REST 模式与全部测试保持通过。

**风险**：MEXC/WEEX 当前网络超时，需要代理；`ccxt.pro` 对某些小所字段不完整，需以 `nonce/timestamp` 缺失即降级 REST。

### P0-2 真实费率层级与 maker/taker 模式

状态：**已实现（2026-10-22）**。`CostSettings.executionMode` 支持 `taker_taker` / `maker_buy_taker_sell` / `taker_buy_maker_sell`，maker 腿使用 `makerFeeBps`（允许负 rebate），按 `makerFillProbability` 缩放期望净利；缺 maker 费率时 fail closed 为 `fee_not_configured`。另支持 `[fees.<venue>]` 配置覆盖 `taker_bps` / `maker_bps`，在加载市场时覆盖 CCXT 的通用费率。证据：`packages/core/tests/s1.test.ts`、`apps/scanner/tests/fee-overrides.test.ts`。

**目标**：净利计算使用账户真实费率，支持 maker rebate，能回答“这条路线在什么费率下才成立”。

**设计**

- 新增 `FeeProfile`（`packages/core/src/fees.ts`）：

```ts
interface FeeProfile {
  venueId: string;
  takerBps: Decimal;
  makerBps: Decimal; // 可为负，表示 rebate
  vipTier?: string;
  paymentDiscountBps?: Decimal;
  withdrawalFeeUsd?: Decimal;
}
```

- `MarketMetadata` 的 `feeTakerBps` 保留兼容，但 S1 优先读 `FeeProfile`。
- S1 增加 `executionMode`：
  - `taker_taker`（当前行为）；
  - `maker_buy_taker_sell`：买入腿挂 maker，卖出腿 taker 对冲；
  - `taker_buy_maker_sell`：反向。
- 净利公式按腿的 maker/taker 分别计费；maker 腿需附带成交概率假设（默认保守 0.5，可配）。
- 输出 `metadata.feeProfile`、`metadata.makerLeg`、`metadata.breakEvenTakerBps`。

**验收**

- 同一路线在 `taker_taker` 下为负、在 maker rebate 下为正，测试可复现。
- 配置缺 `FeeProfile` 时 fail closed 为 `fee_not_configured`。

### P0-3 余额感知的 S1 仓位

状态：**已实现（2026-10-22）**。扫描器读取 `latestBalances`，按买入所 quote free 与卖出所 base free 计算 `maxExecutableNotional`，超出即截断或 `insufficient_balance`；`require_balances_for_s1` 可强制要求余额。证据：`apps/scanner/tests/scanner-balance-sizing.test.ts`。

**目标**：每条有效 S1 都是“当前余额真的做得出来”的，而不是纸面机会。

**设计**

- 读取 `repository.latestBalances({ maxAgeMs: balance_max_age_ms })`。
- 买入腿可用 = 买入所 quote 币 free；卖出腿可用 = 卖出所 base 币 free。
- `maxExecutableNotional = min(深度最优 notional, quoteFree, baseFree × buyPrice, 单所风险上限)`。
- 低于最小名义金额 → `insufficient_balance`。
- `metadata.maxExecutableNotional`、`metadata.balanceLimited` 输出。
- 扫描器 paper 模拟使用同一 size，避免“扫描大、模拟小”。

**验收**

- 无余额 → 无有效机会；余额小于深度 → size 被余额截断；余额充足 → 与深度最优一致。

### P0-4 真机会过滤器（不是泛化风控）

状态：**已实现（2026-10-22）**。S1 支持 `price_outlier`（跨所中位价偏离）、`suspicious_spread`（异常价差上限）、`pair_skew_too_high`（两腿时差）、`venue_reliability_low`（可靠度门槛）；扫描器按同一 base 计算中位中间价，并在有 ≥5 个 feed 样本时传入可靠度。证据：`packages/core/tests/s1.test.ts` 过滤器用例。

**目标**：把“坏数据/停牌/异常价差”从候选里剔掉，让注意力集中在真机会。

**设计**

- 跨所价格中位数偏离：`|px - median| / median > max_price_deviation_bps` → `price_outlier`。
- 异常价差上限：`grossSpread / notional > suspicious_spread_bps` → `suspicious_spread`（默认 200bps）。
- 市场状态：`active` 且非 maintenance/suspended；24h quote volume 低于阈值 → `illiquid_market`。
- 配对级新鲜度：两腿 `receivedAt` 差值 > `max_pair_skew_ms` → `pair_skew_too_high`。
- 复用现有 `reliabilityScore`：低于阈值 → `venue_reliability_low`。

**验收**

- 回放的 `falsePositiveRate` 可计算且低于基线。
- 冻结/停牌/异常价差 fixture 全部被拒。

### P0-5 当前最优排序与生命周期门槛

状态：**已实现（2026-10-22）**。新增 `repository.bestValidS1Opportunity`：按 `netProfitBps × fillProbability × 新鲜度` 选最优，并用 `medianEpisodeDurationMs` 跳过超过历史寿命的机会；执行器 handoff 改为取最优而非最新，同时保留 `stale_s1_opportunity` 语义。证据：`packages/storage/tests/opportunity-ranking.test.ts`、`apps/executor/tests/handoff.test.ts`。

**目标**：执行器永远拿“当前最优且还活着”的机会。

**设计**

- 对有效 S1 打分：
  `score = conservativeNetProfit × fillProbability / expectedLockMs`。
- 生命周期：用最近 N 个样本估计半衰期；`expectedExecutionMs > lifetimeP50` → `opportunity_expired`。
- 同路线去重 + 冷却（已有 `signal_cooldown_ms`）。
- 持久化 `rank`、`lifetimeMs`、`score`；执行器只取 `rank=1` 且未过期。

**验收**

- 多机会时执行器选分数最高且最新；过期机会被拒。

### P1-1 交易所与路线覆盖

状态：**已扩展（2026-10-22）**。目录含 42 个场所（34 CEX + 8 DEX），37 个 spot 场所默认启用；新增 bingx/phemex/whitebit/upbit/bitstamp/gemini/bitfinex/blockchaincom/bigone/hitbtc/btse/cex/digifinex/p2b/deepcoin/hashkey，DEX Hyperliquid/Lighter/Aster 已接入，apex/derive 作为 perp 参考。多所 WS 只订阅“至少两个场所有同 base/quote”的币种，配合按 tier 排序与每所 REST 回退上限，把 8 所 8 币的扫描稳定在 64 本 WS 盘口、0 stale。2026-10-22 晚补了路线密度/寿命反馈：`s1RouteStats()` + `npm run routes:stats` 按 instrument + buy->sell 输出样本、有效率、平均/最大净边际、episode 数、p50/p90 寿命，并让 hot/near-miss 路线优先进入 WS 订阅。证据：`docs/venue-expansion-2026-10-22.md`、`docs/s1-multivenue-findings-2026-10-22.md`、`packages/storage/tests/route-stats.test.ts`。

- 先加只读参考所：binance、okx、bybit、kucoin、bitget、htx（WS 均可用）。
- 小所继续作为执行主场：gate、mexc、weex、hotcoin。
- 统计每个 `(venue, pair)` 的有效机会密度、平均寿命、误报率；按密度自动提升 tier。
- 注意：覆盖扩大同时放大噪音，必须与 P0-4 一起上。

### P1-2 tick 级录制与真实回放

状态：**录制、分析与全链路回放已实现（2026-10-22）**。`record_feed` 把 WS L2 快照写成 JSONL；`npm run analyze:feed` 计算 raw/net 机会帧、误报率、盘口年龄、最佳路线和拒绝原因；`npm run replay:feed` 把录制数据送入完整扫描器（episode、寿命、持久化）。合成两所 3 帧验证：rawEdge=3、net=2、falsePositiveRate=1/3、best=179.8bps，回放 episode 500ms。外部 tick 数据仍可接 `tardis-machine`。

- 把 WS L2 增量落盘（JSONL，按 venue/symbol/日期分片）。
- 回放引擎复用扫描器与 S1 评估，支持 `staleness/embargo`，禁止未来数据。
- 可选接 `tardis-machine` 做交叉校验。

### P1-3 库存再平衡流程

状态：**规划器已实现（2026-10-22）**。`planRebalance` 按每所每币目标余额计算同币种贪心转账、最小转账阈值与成本；`npm run rebalance:plan` 读取最新余额并输出只读计划与缺口。没有转账/提现/签名路径。证据：`packages/core/tests/rebalance.test.ts`。

- 目标分配（每所每币目标余额）、偏离阈值、再平衡建议与成本。
- S1 的 `rebalanceCostBps` 从“常数”升级为“按实际路线估算”。

## 6. 明确暂缓

- BSC 链上签名/广播/MEV：设计已暂缓。
- 更多泛化风控测试：不是当前瓶颈。
- Dashboard 新功能、多账户、KMS：P2。

## 7. 建议的落地顺序

1. **P0-1 WebSocket + BookStore + 事件驱动扫描**（先做 gate 单所，mexc/weex 走代理）。
2. **P0-2 费率层级 + maker/taker 模式**。
3. **P0-3 余额感知仓位**。
4. **P0-4 真机会过滤器**。
5. **P0-5 最优排序 + 生命周期**。

每一项完成后都要：`npm run typecheck`、聚焦测试、`npm run check`、`npm run coverage`，并更新本文档与 `docs/implementation-checklist.md` 的状态与数字。

## 8. 验证命令

```powershell
npm run typecheck
npx vitest run packages/core/tests/market-data.test.ts packages/core/tests/risk.test.ts packages/core/tests/s1.test.ts apps/scanner/tests/replay.test.ts apps/scanner/tests/scanner-service.test.ts
npm run check
npm run coverage
```

## 9. 实盘前置条件（外部）

代码侧 P0 已全部完成，但真正开跑实盘前仍需以下外部条件：

1. **第二家可达交易所**。当前网络实测只有 Gate 可达；OKX、Binance、Bybit、KuCoin、Bitget、HTX、MEXC、WEEX 均连接超时。S1 至少需要两家健康交易所，需要配置 `ARB_HTTPS_PROXY` 或换到可访问这些域名的网络。
2. **只读 / 交易 API key**。禁止提现权限，开启 IP 白名单；先用只读 key 做 24 小时 soak。
3. **余额快照**。`npm run executor:balances -- --loop` 持续刷新余额，S1 才能按真实余额裁剪仓位。
4. **实盘门槛**。至少 1 个真实可执行 S1 机会、20 个真实市场 paper batch、10 个手动确认 live batch；这些必须由用户提供凭证、资金和操作确认后完成。

## 10. 新增验证工具

```powershell
# 1) 探测配置中每个交易所的 REST/WS 连通性
npm run probe:venues -- --timeout-ms 8000 --pair BTC/USDT

# 2) 开启录制（config/default.toml: record_feed = true），运行扫描器后分析
npm run analyze:feed -- --dir data/feed --pair CAKE/USDT --step-ms 500

# 3) 把录制数据送入完整扫描器回放（可加 --paper）
npm run replay:feed -- --dir data/feed --pair CAKE/USDT --paper

# 3b) 延迟后到达 shadow audit：统计 100ms 后还存活的机会
npm run analyze:feed -- --dir data/feed --pair CAKE/USDT --arrival-latency-ms 100

# 3c) 机会窗口：把连续有效帧合并成窗口（默认 gap 2000ms）
npm run analyze:feed -- --dir data/feed --pair CAKE/USDT --window-gap-ms 2000

# 4) 只读库存再平衡计划（不执行转账）
npm run rebalance:plan -- --target gateio:USDT=1000,mexc:USDT=1000 --cost-bps 10
```

## 11. 真实数据结果

2026-10-22 已通过本地 SOCKS5 `127.0.0.1:10808` 接入 MEXC/WEEX 并完成只读扫描：4 分钟 1,254 次 S1 评估在 10bps 下 0 有效；2bps 情景下 APT 出现 2/2 净机会（最佳 1.11bps，maker 后 2.05bps），INJ 在 3 分钟内出现 23+ 条有效 S1（净利 1.1–3.4bps，但仓位常被限制到约 $3.65）。详细数据与复现命令见 `docs/s1-real-data-findings-2026-10-22.md`。
