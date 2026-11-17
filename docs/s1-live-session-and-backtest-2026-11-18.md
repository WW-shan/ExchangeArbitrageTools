# S1 实盘运行与最近 6 天回测 - 2026-11-18

> 2026-11-18 01:40 HKT 更新：实盘策略已收敛为 `WARD-only` 单方向库存轮换。
> 当前设计、库存翻转规则和运行检查见
> `docs/s1-ward-only-single-direction-2026-11-18.md`。本文第 3-4 节保留的是
> 多币时期的历史回测记录，不再作为当前候选池的依据。

## 1. 本轮实盘状态

- 启动时间：2026-11-18 00:26（HKT）
- 运行状态：`RUNNING`
- executor：运行中，`WAIT`/余额刷新/机会检查
- scanner：运行中，`SCANNING`
- `kill_switch=false`，`auto_execution_enabled=true`，`live_enabled=true`
- 当前挂单：Gate、Bitget 均为 0
- 未完成 execution：0
- 未解决 order：0

代理问题已修复：`.env.live-test` 的 `ARB_SOCKS_PROXY` 从失效的 `10808` 改为实际监听的 `10809`。

## 2. 已确认的真实成交

2026-11-18 00:09:41（HKT）

| 项目                          | 数值                                 |
| ----------------------------- | ------------------------------------ |
| batch                         | `S1-876203-1794931780327`            |
| direction                     | Bitget -> Gate                       |
| pair                          | WARD/USDT                            |
| planned notional              | 3.06 USDT                            |
| Bitget buy                    | 1865 WARD @ 0.00164                  |
| Gate sell                     | 1865 WARD @ 0.001655                 |
| realized profit               | +0.023999687225 USDT                 |
| signal age at execution start | 675 ms                               |
| end-to-end latency            | 5443 ms                              |
| execution duration            | 4768 ms                              |
| result                        | `CLOSED`，无 safe-stop，无未平仓残留 |

买入手续费为 1.865 WARD，卖出手续费为 0.00305570925 USDT。成交后 Gate WARD 由 2615.4063 降至 750.4063，Bitget WARD 由 536.68001 升至 2399.81501；这是正常的库存方向切换。

随后执行了一笔库存调仓：

- `REBAL-KAT-1794931856636-bitget-ecfa40a7`
- Bitget 卖出 997.52 KAT @ 0.00297
- 状态 `CLOSED`
- 调仓本身 `realized_profit=0`

## 3. 最近 6 天回测口径

- 时间窗口：2026-11-12 00:30 至 2026-11-18 00:30（HKT）
- 交易所：Gate.io、Bitget
- K 线：1 分钟 OHLCV
- 标的：WARD、KAT、LIGHT、LA、BREV、AEON
- 参考名义金额：3.06 USDT
- 最小净利：5 bps
- 最小利润：0.005 USDT
- 安全缓冲：2 bps
- 额外滑点：10 bps
- 最大合理价差：1000 bps
- 最小 1 分钟成交额：20 USDT
- 输出文件：`data/history-gate-bitget-1m-6d-live-filter-2026-11-18.json`

### 结果

| 标的       | 最佳方向       | 机会段 | 次/天 | 中位净 bps | 按中位数估算/次 | 6 天估算上限 |
| ---------- | -------------- | -----: | ----: | ---------: | --------------: | -----------: |
| WARD/USDT  | Bitget -> Gate |    204 | 34.06 |      75.41 |     0.0231 USDT |   4.708 USDT |
| BREV/USDT  | Bitget -> Gate |     21 |  3.51 |     643.31 |     0.1969 USDT |   4.134 USDT |
| AEON/USDT  | Gate -> Bitget |     27 |  4.51 |      33.85 |     0.0104 USDT |   0.280 USDT |
| LA/USDT    | Gate -> Bitget |      5 |  0.83 |      34.05 |     0.0104 USDT |   0.052 USDT |
| LIGHT/USDT | Bitget -> Gate |      5 |  0.83 |      26.60 |     0.0081 USDT |   0.041 USDT |
| KAT/USDT   | Bitget -> Gate |      6 |  1.00 |      20.39 |     0.0062 USDT |   0.037 USDT |

`最佳方向合计估算上限 = 9.252 USDT / 6 天`。剔除 BREV 的高价差后为 `5.118 USDT / 6 天`。

## 4. 哪些是真正可执行的

### WARD

WARD 是唯一已经用真实成交验证过的主力机会：

- 6 天 204 个机会段，约 34 个/天；
- 中位净价差 75.41 bps；
- 实盘 00:09 的成交净效果为 +0.024 USDT / 3.06 USDT，和中位回测结果吻合；
- 按 3.06 USDT 全部捕获的理论上限约 0.78 USDT/天，但实际会受库存、延迟、部分成交和行情消失影响。

### BREV

BREV 回测看起来最高，但不能直接计入可实现收益：

- Gate 报价约 0.110 USDT，Bitget 约 0.096 USDT，价差约 15%；
- 实盘 scanner 已把它判定为 `suspicious_spread`；
- Gate 侧可用 BREV 仅约 1.43-1.64 USDT，低于 3 USDT 最小 S1 名义金额；
- 同时出现 `insufficient_depth` 和 `insufficient_balance`，因此不会下单；
- 如果价差长期不回归，必须依赖提币/链上搬运才能持续套利，而当前未启用该路径。

### 其他标的

AEON、LA、LIGHT、KAT 的机会频率和深度都明显弱于 WARD；当前库存也不足以支持完整的最小卖单。它们适合继续监控，不应作为主要收益来源。

## 5. 结论

1. 当前 S1 链路已真实跑通：扫描、信号、双边 FOK、成交、P&L、库存调仓、挂单核对均正常。
2. WARD 是现阶段最稳定的可执行标的，理论量级约 0.02-0.03 USDT/笔，3.06 USDT 仓位。
3. BREV 的诱人价差不是“免费机会”：它被 live 风控正确拦下，缺的是 Gate 侧库存或跨所搬运能力。
4. 回测是 1 分钟 OHLCV 的上限估算，不建模盘口深度、排队、延迟、成交概率和库存枯竭，不能把 9.25 USDT 当作保证收益。

## 6. 当天 issue 处理

- #1：账户部分费率合并，PR #3 已合入。
- #2：带乘数市场的 seed 记账，PR #4 已合入。
- #3：S3 取整为零，PR #6 已合入。
- #7：S2/跨场所按实际订单金额检查 minNotional，参考分支已合入并格式化，commit `2573a2d`。
- #8：价差持续时间不再跨越采样缺口，commit `26b3f81`。
- 当前 open issue：0。
- 本地全量测试：516 passed；`npm run lint` 通过。

## 7. 复跑命令

```powershell
. .\scripts\load-env.ps1
$env:ARB_CONFIG='config/live-rotation.toml'
npm run backtest:history -- --config config/live-rotation.toml --venues gateio,bitget --quote USDT --timeframe 1m --days 6 --bases WARD,KAT,LIGHT,LA,BREV,AEON --min-volume 1 --max-volume 5000000 --min-candle-volume-usd 20 --min-net-profit-bps 5 --min-profit-usd 0.005 --safety-buffer-bps 2 --extra-slippage-bps 10 --max-sane-spread-bps 1000 --notional 3.06 --concurrency 3 --rps 3 --out data/history-gate-bitget-1m-6d-live-filter-2026-11-18.json
```
