# S1 缺口修复与 DISLOCATION 通道（2026-11-19）

> 依据：`data/zx_hey_tweets.json`（60 条真实推文）、`data/dislocation/`（2,315 轮真实
> Gate/Bitget/WEEX ticker 快照）、`data/rotation.sqlite`（25.3 小时 WARD 盘口）、
> `data/tmp-volumes.json`（Gate 2,006 / Bitget 3,591 个 USDT 市场的 24h 成交额）。

## 0. 一句话结论

之前系统只有一条通道（S1 常态价差），而推文里赚钱的那条通道（插针）**根本没接进
执行器**。扫描器抓到过 IR/USDT 1,213 bps、持续 3.3 分钟、可吃 22.4 USDT 的真实机会，
执行器完全不知道。本轮把这条通道接通了，并修掉两个「让低流动币永远进不来」的过滤器。

## 1. 本轮修掉的真实缺陷

### 1.1 插针信号从未进入执行链路（P0，最严重）

| 项目 | 修复前 | 证据 |
| --- | --- | --- |
| 检测位置 | 只在 `scripts/scan-dislocation.ts`（只读脚本） | 该脚本不写 `opportunities` 表 |
| 执行器查询 | `WHERE strategy = 'S1'` | `repository.recentS1Opportunities` |
| S1 拦截 | `suspicious_spread_bps = 1000` 直接否决 | `packages/core/src/s1.ts:210` |
| 结果 | **插针永远不会被执行** | 2026-11-19 IR/USDT 1,213 bps 零执行 |

**修复**：
- 新增 `packages/core/src/dislocation-opportunity.ts`：把确认过的插针转成可执行机会，
  仅屏蔽两条 S1 专用的「这看起来像坏盘」检查（`suspicious_spread_bps`、
  `max_price_deviation_bps`），其余（最小利润、深度、精度、健康度、时效）全部保留。
- `ScannerService.evaluateDislocationGroup`：在**已经取回的盘口**上做插针检测，
  零额外请求，随行情更新触发。
- `strategy` 增加 `DISLOCATION`；`repository.recentS1Opportunities` 增加 `strategies`
  参数（默认仍为 `['S1']`，不影响既有调用）；supervisor 显式查询 `['S1','DISLOCATION']`。
- `coordinator` 的 `routeIsConsistent` 接受 `DISLOCATION`，preflight 对插针机会不套用
  S1 的两条拦截；执行记录以 `strategy = 'DISLOCATION'` 落库，便于单独核算盈亏。

### 1.2 活跃度过滤把低流动币永久判死（P0）

原规则：60 秒内 24h 成交额必须增长 ≥10 USDT。
等价于 **≥14,400 USDT/天**，而扫描器的成交额下限是 200 USDT。

真实数据（`data/tmp-volumes.json`）：Gate ∩ Bitget 共 443 个 USDT 交易对，
落在扫描器 200–5,000,000 区间的有 412 个，其中 **161 个（39%）永远无法满足**
这条规则——而它们正是插针的主要来源。

**修复**：`MarketActivityTracker` 新增 `minTurnoverFraction`，用「该币自身的 24h 速率」
做基准（0.3 = 达到自身日均速度的 30%），绝对下限降为 0。
死盘仍然过不了（增量为 0），薄但活的盘能过。

实测（159 秒双采样，2,974 个市场）：

| 规则 | 通过数 |
| --- | --- |
| 绝对下限（旧） | 748 |
| 相对速率（新） | 713 |
| 任一通过 | 823 |

新增放行的样例全部是低流动小币：`MANA3`、`YCT`、`4EVER`、`LF`、`ISK`、`ATS`、`POKT`、
`QORPO`、`ALEPH`、`CERE`、`UDAO`…

### 1.3 已量化但**未**采用的改动

`assessTransferability` 要求双向可提币。我们的库存轮转模型其实不需要提币
（WARD 本身不可提币，却一直在交易）。实测多放行 **28 / 351 对（+8%）**，
而且会重新放行 BREV 这类已确认的死盘（1,800 bps 持续一整天，实为提币关闭）。
**收益不足以抵消风险，本轮不改**，留作后续单独评估。

## 2. 为什么只做 WARD 赚不到插针的钱（关键结论）

WARD 25.3 小时真实盘口，严格 5 秒对齐后 676 个跨所样本：

| 正价差档位 | 样本数 |
| --- | --- |
| ≥50 bps | 465 |
| ≥100 bps | 175 |
| ≥200 bps | 3 |
| **≥300 bps** | **0** |
| ≥500 bps | 0 |

**WARD 从未出现过 ≥300 bps 的插针。** 推文的收益来自 $0.2 → $9 这类极端错价，
那是低流动小币的特征，不是 WARD 的特征。因此：

- 通道现在**已建立并默认开启检测**，但只有出现在
  `[[auto_rotation.pairs]]` 白名单里的币才会被执行；
- 只做 WARD 时该通道只产生观测数据，不产生交易——这是诚实的现状，不是缺陷；
- 要真正吃到插针，需要增加低流动标的（下一步，需你确认）。

## 3. 与推文经验的对照

| 维度 | zx_hey | 本轮之后 |
| --- | --- | --- |
| 目标函数 | 尾部插针（100%+） | **已支持**（DISLOCATION 通道） |
| 标的范围 | 一篮子低流动币 | 仍限白名单（WARD） |
| 实时性 | 每秒级 | WS + 事件驱动，已具备 |
| 频率 | 145 笔/天 | 受「无机会」限制，非参数过严 |
| 过早出场 | 他自己也承认 0.5U 就卖光 | 我们卖腿必执行，无此问题 |

推文里那句「工具在 0.5U 就卖光了，后面巨大利润没吃到」印证了一点：
**出场纪律比入场速度更容易被忽视**。我们上一轮修的「买到不卖」正是同类问题。

## 4. 验证

| 测试 | 内容 |
| --- | --- |
| `packages/core/tests/dislocation-opportunity.test.ts` | 真实 IR/USDT 插针可通过；repricing/小价差被拒 |
| `apps/scanner/tests/scanner-service.test.ts` | scanner 端到端写出 DISLOCATION；关闭时不写 |
| `packages/storage/tests/repository.test.ts` | 默认只查 S1；显式查询含 DISLOCATION |
| `apps/executor/tests/coordinator.test.ts` | 插针不被 `suspicious_spread` 误杀；路由不符仍 BLOCKED |

**611 个测试全部通过**（基线 597）。`tsc -b` 无错误。

## 5. 下一步（需要你决定）

1. **是否增加低流动标的**：这是吃到插针的唯一前提。建议先加 2–3 个
   Gate ∩ Bitget 都可交易、24h 成交额 1k–50k USDT 的币，只读观察 24h 后再放实盘。
2. `min_turnover_fraction` 是否需要按交易所分别校准（Gate 与 Bitget 的成交量上报
   频率不同，0.3 是一个保守起点，可再收窄）。
3. 如果要做跨所提币补库存，再单独评估 1.3 的结论。

## 6. 上线状态（05:22 UTC+8）

- 已用仓库自带的 `scripts/stop-rotation.ps1` / `start-rotation.ps1` 重启，未按进程名杀进程。
- executor `pid 21376`、scanner `pid 19644`，`state=RUNNING`，`phase=WAIT/SCANNING`。
- 重启前三项检查全部干净：`open_executions=0`、`unresolved_orders=0`、`unhedged=[]`。
- 新通道已加载：配置读到 `dislocation_enabled=true`、`min=500 bps`、`min_notional=3`。
- 重启后 WARD 的 S1 样本持续写入（约 874 条/3 分钟），`DISLOCATION` 行数为 0，
  与 25 小时历史一致——WARD 不产生插针，这是预期结果，不是故障。

### 顺带清理

原先还有一个遗留的只读 `scripts/scan-dislocation.ts` 进程在跑，11 小时写了 **2.7 GB**
快照（`data/dislocation/`）。已按 PID 停止（3484/8128/8720），并按时间清理到最近 30 分钟，
目录从 2.7 GB 降到 337 MB。**注意：该脚本每 5 秒写一个完整快照且没有保留策略，
不要在实盘机上长期挂。**


## 7. 运维提示：`start-rotation.ps1` 可能拉起两个 watchdog

值班时观察到一次：执行 `start-rotation.ps1` 后同时存在两个
`watch-rotation.ps1`（PID 20004 与 11216）。原因是上一次启动尝试在
30 秒内没有写出状态文件，人（或脚本重试）又执行了一次。

- 两个 watchdog 会**互相看到对方**并都报告 `already running`；
  executor 与 scanner 仍然各只有 1 个，短时间不会重复下单；
- 但仍应清理，否则 stop 时其中一个可能继续重启。

清理方式：先 `stop-rotation.ps1`，确认所有相关进程退出，再
`start-rotation.ps1` 一次并且**只执行一次**。
不要把 `start-rotation.ps1` 放在自动重试循环里。
