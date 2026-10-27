# S1 真实数据发现（2026-10-22）

本文件记录通过本地 SOCKS5 代理（`127.0.0.1:10808`）接入真实交易所后的只读扫描结果。
所有数据来自公开行情，没有下单、签名、广播或提现。

## 1. 连通性

- `ARB_SOCKS_PROXY=socks5://127.0.0.1:10808` 同时代理 REST 与 WebSocket。
- HTTP 代理 `http://127.0.0.1:10808` 也可用，但 WS 首帧约 9s、Gate feed latency p95 约 3s；SOCKS 后续帧 30–56ms、交易所时间戳年龄约 64–77ms。
- MEXC、WEEX 的 REST 与 WS 均可用；Gate WS 可用，但安静币种的 `timestamp` 容易显得陈旧。
- 需要额外依赖：`http-proxy-agent`、`https-proxy-agent`、`socks-proxy-agent`、`protobufjs`（MEXC WS 解码）。

## 2. 四分钟只读 soak（MEXC + WEEX，10 个币，10bps）

- S1 评估：**1,254 次，有效 0 次**。
- 拒绝原因：`gross_profit_below_threshold` 1,002 次；`invalid_orderbook` + `stale_orderbook` 252 次。
- 健康度：MEXC p95 REST 约 1,997ms，WEEX 约 268ms；均为 health A。
- 真实最大毛利差（fee=0，1s 采样）：

| 币种 | 最大毛利差 bps | 原始价差帧 |
| ---- | -------------: | ---------: |
| BNB  |           3.52 |        168 |
| DOGE |           2.51 |         21 |
| LINK |           2.46 |          8 |
| ETH  |           2.26 |        186 |
| XRP  |           2.24 |         22 |
| AVAX |           2.14 |          1 |
| BTC  |           1.91 |        222 |
| SOL  |           0.96 |          3 |
| ADA  |           0.00 |          0 |
| CAKE |           0.00 |          0 |

结论：主流币在 10bps 双边 taker（20bps 往返）下**结构性无机会**；即使 2bps 双边（4bps 往返），上述品种也基本为 0。

## 3. 低费率下的真实候选

### APT（60 秒，2bps）

- 原始价差 2 帧，净机会 2 帧，FPR 0。
- 最大毛利差 5.11bps，最大净利 1.11bps，路径 `mexc->weex`。
- 2bps + maker rebate（maker -1bps、50% 成交概率）：最大净利 2.05bps。
- 10bps 下：0 净机会。

### INJ（3 分钟，2bps）

- 1,001 条录制，187 个采样，180 个双所齐全。
- 原始价差帧 123；按 $30 固定名义金额，净机会 4 帧，FPR 96.7%。
- 最大毛利差 8.47bps，最大净利 3.41bps，路径 `weex->mexc`。
- 盘口年龄 p50 166ms / p95 672ms。
- 端到端扫描器（开启最优仓位）在 90 轮/3 分钟内产生 23+ 条有效 S1，净利 1.1–3.4bps，但 `requestedNotional` 常被深度限制到约 **$3.65**。

结论：INJ/APT 上确实存在真实、可重复的跨所价差，但**只在小费率（≤2bps）下成立，且常被盘口深度限制到几美元**；按 10bps 计全部消失。

## 4. 对 S1 的直接含义

- 10bps taker-taker 在主流币上不可行，继续扩大主流币覆盖没有意义。
- 真正可行的是：**低费率账户 + 中小市值品种 + 深度感知仓位 + maker-first/taker-hedge**。
- 当前系统的过滤器（stale、crossed、pair skew、reliability）在真实数据中确实拦住了 MEXC 的 crossed/stale 帧（3–10% crossed rate）。
- 单笔利润很小，必须靠频率和更低费率；在确认账户真实费率前，不应投入真实资金。

## 5. 复现

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run probe:venues -- --timeout-ms 20000 --pair BTC/USDT

$env:ARB_CONFIG = 'config/s1-soak.toml'
npm run smoke:s1 -- --venues mexc,weex --bases INJ,APT,SUI,BNB --cycles 30 --interval-ms 2000 --warmup-ms 15000 --notional 30 --record --record-dir data/feed-candidates

npm run analyze:feed -- --dir data/feed-candidates --pair INJ/USDT --step-ms 500 --min-net-bps 1 --fee-bps 2
npm run replay:feed -- --dir data/feed-candidates --pair INJ/USDT --fee-bps 2
```

## 6. 限制

- 结果是 60 秒到 3 分钟的窗口，不是 24 小时 soak。
- 2bps 是情景假设，必须用账户真实 VIP/maker 费率确认。
- 代理延迟和 MEXC 的 crossed 帧会影响信号质量；当前过滤器会拒绝，但也可能漏掉真实机会。
- 深度限制导致单笔名义金额很小，尚未验证真实成交率、排队和滑点。

## 7. 2026-10-23 Gate/WEEX 事件驱动复测

代理恢复（`127.0.0.1:10808`）后，用新的 `scanUpdates()` 热路径复测：

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_HTTPS_PROXY = 'http://127.0.0.1:10808'
npm run smoke:s1 -- --venues gateio,weex --bases CAKE,ETH,BTC,INJ,APT,BNB,SOL,DOGE,ARB,OP `
  --cycles 10 --interval-ms 500 --warmup-ms 5000 --notional 10 `
  --taker-bps 0 --min-net-profit-bps 0 --min-profit-usd 0 --safety-buffer-bps 0
```

结果（0 费率情景，用于验证发现能力）：

- Gate 2,180 市场，WEEX 2,339 市场；WS 健康状态 A。
- 初始全量 + 10 个热扫周期共 11 条有效 S1；净边际 **0.08–2.59bps**。
- 方向以 `gateio->weex` 为主，也有 `weex->gateio`；`requestedNotional` 3.67–10 USDT。
- 6 条拒绝原因是 `gross_profit_below_threshold`，说明不是所有帧都有效。
- 热扫 `dirtyBooks` 5–10、`dirtyGroups` 5–10，`deferredGroups=0`，没有出现热扫积压。

同一组币种、2bps taker 情景跑 20 个周期：

- **0 条有效 S1**；每周期 `prefiltered` 14–16，说明原始边际在扣 4bps 双边费后为负。
- Gate WS feed latency p95 约 1.58s，WEEX 约 0.26s；两者 health 均为 A。
- 结论：新的热路径能发现真实盘口机会，但 0 费率下的 0.08–2.59bps 在 2bps 双边费下不够；
  需要更低真实费率、maker 腿或更高边际的品种。

补充 1bps taker 情景（同样 10 个币、10 个周期）：第 10 个热扫周期出现 1 条有效 S1，
`gateio->weex`，净边际 **1.08bps**，名义额 10 USDT；其余周期 prefiltered 16–20。
这说明当前 Gate/WEEX 样本的盈亏平衡点在 **1–2bps taker** 之间，不是 10bps 能覆盖的区间。

另外修正了 `ScanSummary.booksFetched`：热扫不再把“尝试读取但 WS 无新鲜盘口”的 ref 计入。

## 8. 2026-10-23 合约乘数能力复测

新增别名归一化后，Gate/WEEX 只读 smoke（`CAKE,ETH,BTC,PEPE`，0 费率，3 个热扫周期）：

- 发现 Gate 2,180 / WEEX 2,339 个市场；初始全量 3 条有效 S1，后续两个热扫周期各 3 条。
- 有效净边际 **0.25–5.67bps**，方向均为 `gateio->weex`，名义额 9.81–9.99 USDT。
- `aliasMismatches=0`；热扫 `dirtyGroups=4`、`deferredGroups=0`。
- 单独扫描 Gate/WEEX/MEXC 的 active spot 市场，当前没有 `k*` 或 `1000*` 别名市场。

结论：乘数能力已经端到端可执行，但**当前这三个现货所没有产生额外别名机会**；它的价值是避免未来
交易所改成 1000 倍单位时漏掉机会或下错数量，而不是今天立即增加有效条数。

## 9. 2026-10-27 S1 端到端测试与只读复测

新增 `apps/executor/tests/s1-pipeline.test.ts`，覆盖真实链路：

- scanner 发现并持久化 S1；
- handoff 选择最新有效机会并核对人工确认号；
- executor 重新拉盘口、检查余额、提交双腿并写回 CLOSED；
- 第二腿部分成交时进入 `SAFE_STOP`，记录剩余未对冲库存并打开 kill switch。

S1 相关测试集合：16 个测试文件 / 100 个测试通过。全量：46 个文件 / 243 个测试 +
20 批回测通过。

真实只读 smoke（Gate/WEEX，0 费率，CAKE/ETH/BTC/PEPE）：

- 代理链路本次抖动明显：Gate feed latency p95 约 5.6–6.0s，WEEX 约 3.7s；
  默认 `max_feed_latency_ms=2000` 下所有盘口被判过期，有效 S1 为 0。
- 将只读 smoke 阈值临时放宽到 8000ms 后，初始全量扫描出现 1 条有效 S1：
  `gateio->weex`，净边际 **0.5023bps**，名义额 10 USDT。
- 后续热扫周期没有新的有效行，`dirtyGroups=3–4`、`deferredGroups=0`。
- 结论：本地 S1 链路逻辑正常；本次 0 条主要来自代理延迟和过热盘口，不是策略计算错误。
  该结果不能替代真实低延迟网络和 24 小时 soak。
