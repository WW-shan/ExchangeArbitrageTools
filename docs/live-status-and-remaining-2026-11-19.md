# 实盘状态与剩余工作盘点（2026-11-19 10:30 UTC+8）

## 1. 实盘当前状态

| 项目 | 状态 |
| --- | --- |
| watchdog | RUNNING |
| scanner | SCANNING |
| executor | WAIT（no_valid_opportunity） |
| openExecutions | 0 |
| unresolvedOrders | 0 |
| 未对冲库存 | 0 |
| kill switch | false |
| leg_mode | **parallel_fok** |
| 标的 | WARD/USDT（Gate x Bitget） |

当前 WARD 价差 **-46 bps**，无机会，系统正确等待。

## 2. 本轮修复的四个真问题

### 2.1 买一挂单冻结（13 小时不成交）

Bitget 的 12391.31 WARD 买单在 0.001676 挂了 13 小时，26 笔 S1 全部零成交。
判据改成「买一价格 + 数量都不变超过 20 秒」，按毫秒计时而不是扫描次数。

### 2.2 下单时盘口已过期

preflight 读完盘口后还要 1.5-2 秒做私有 REST，下单时盘口已老。
48 笔真实数据：盘口 <500ms 成交率 89%，1-2 秒降到 37%，>2 秒 0%。
新增 `SUBMIT_BOOK_MAX_AGE_MS = 1500`，超限则买卖两腿都不发。

### 2.3 PREFLIGHT_FAILED 永不关闭

`countOpenExecutions()` 数 `closed_at IS NULL`，但终态没写 closed_at。
一笔被拒的预检把执行器卡了 20 分钟，期间 **160 个有效信号全部浪费**。

### 2.4 serial 模式吃掉全部利润

24 笔实测：parallel_fok 平均 +126 bps / 中位 +67 bps；serial 平均 +41 bps / 中位 +1 bps。
已切回 parallel_fok。

## 3. 实盘首次完整闭环

execution 144：gateio 买 5265 WARD @0.001639 + bitget 卖 5265 @0.001640，
两腿全成、数量相等、无残值，实现 +0.0010 USDT。
库存成功从「Gate 有币」翻转到「Bitget 有币」，不需要提币。

## 4. 机会密度实测（26 小时真实数据）

| 方向 | 机会窗口数 | 平均价差 | 持续 >=1 秒 |
| --- | --- | --- | --- |
| gateio -> bitget | **95** | 44 bps | 66 |
| bitget -> gateio | 0 | - | - |

持续时间：p50 1.4 秒、p90 47.6 秒、最长 **808 秒**。

**机会是存在的，密度也不低。** 之前的瓶颈是 2.3 那个 bug。

## 5. 仍欠缺的（按优先级）

### P0：影响赚钱

| 缺口 | 现状 | 影响 |
| --- | --- | --- |
| **只有 WARD 一个标的** | 单标的 | 26h 只有 95 个窗口，多数时间空转 |
| **WEEX 未接入实盘** | 仅监控 | 发现 64 个币有 >=20bps 价差，但无法下单 |
| **资金只有 ~14 USDT** | 单笔 3-8 USDT | 即使抓到大机会也只能吃很小一块 |

### P1：工程能力

| 缺口 | 现状 |
| --- | --- |
| WEEX 私有 API | 无 key，无法读余额/下单 |
| 多标的同时监控 | 配置里只有 WARD 一个 pair |
| 历史 tick 回测 | 只有合成数据 + 快照回放 |
| 告警（Telegram/Discord） | 无 |

### P2：能力增强

- 图算法多跳路径（当前只有两所两腿）
- 最优仓位（当前按盘口逐档吃）
- 多账户资金分配
- 密钥轮换 / KMS

## 6. 下一步建议（按收益排序）

1. **给 WEEX 申请 API key**，把 CC/USDT 加进 pairs。
   实测 CC 在 WEEX 卖一 0.0781 / Gate 买一 0.0820，**500 bps 持续 90 秒**，
   3 USDT 单笔毛利约 0.146 USDT。这是 WARD 的 5 倍。
2. **多标的同时监控**：WARD + CC + CP + CT，按机会自动切换。
3. **增加本金**：当前 14 USDT，单笔 3-8 USDT，机会来了也吃不满。

## 7. 已知风险

- WEEX 盘口容易冻结（CP/CT/GWEI/PRL 25 秒不动），**必须先过买一活性检查**。
- CC 在 WEEX 没有提币网络，只能靠库存轮转，需要两边都有初始库存。
- WARD 只有 gateio->bitget 一个方向有机会，库存会单向耗尽，需要再平衡。
