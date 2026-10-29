# Gate/Bitget 小币双向回测（2026-10-30）

## 1. 目的

重新确认 Gate.io 与 Bitget 上哪些小币在最近 6 天里反复出现可执行价差，
避免只凭当前盘口或旧标的列表决定库存。回测只用于筛选监控标的，不代替
实盘盘口、余额、精度和 FOK 检查。

## 2. 数据与参数

- 时间窗口：2026-10-24 至 2026-10-30，最近 6 天；
- K 线：1 分钟 OHLCV；
- 交易所：Gate.io、Bitget；
- 报价币：USDT；
- 参考名义金额：10 USDT；
- 最小净利：5 bps；
- 安全缓冲：2 bps；
- 额外滑点：10 bps；
- 最小单根 K 线成交额：1 USDT；
- 成交量带：1 至 5,000,000 USDT。

命令：

```powershell
npm run backtest:history -- `
  --config config/longtail.toml `
  --venues gateio,bitget `
  --quote USDT `
  --timeframe 1m `
  --days 6 `
  --bases ULTIMA,LIGHT,KAT,KAIA,BREV,AEON,LA,WARD `
  --max-bases 20 `
  --min-volume 1 `
  --max-volume 5000000 `
  --min-candle-volume-usd 1 `
  --min-net-profit-bps 5 `
  --min-profit-usd 0.01 `
  --safety-buffer-bps 2 `
  --extra-slippage-bps 10 `
  --notional 10 `
  --concurrency 3 `
  --rps 3 `
  --out data/history-gate-bitget-1m-6d-2026-10-30.json
```

## 3. 结果

| 标的       | 双向次数/天 | 方向次数/天                            | 压力样本 |    中位净 bps | 最长窗口 |
| ---------- | ----------: | -------------------------------------- | -------: | ------------: | -------: |
| WARD/USDT  |      169.13 | Gate->Bitget 89.99；Bitget->Gate 79.14 |     2725 | 53.72 / 59.15 |  49 分钟 |
| LIGHT/USDT |       89.66 | Gate->Bitget 53.43；Bitget->Gate 36.23 |        5 | 20.86 / 19.91 |   6 分钟 |
| KAT/USDT   |       61.94 | Bitget->Gate 47.08；Gate->Bitget 14.86 |      111 | 32.71 / 23.83 |  12 分钟 |
| LA/USDT    |       24.38 | Bitget->Gate 16.36；Gate->Bitget 8.01  |       38 | 26.84 / 43.25 |   3 分钟 |
| BREV/USDT  |       19.70 | Bitget->Gate 10.35；Gate->Bitget 9.35  |        8 | 35.67 / 29.67 |   3 分钟 |
| AEON/USDT  |       14.53 | Gate->Bitget 7.35；Bitget->Gate 7.18   |        6 | 21.04 / 22.34 |   3 分钟 |
| KAIA/USDT  |        2.50 | 双向均低于 1.4 次/天                   |        0 | 14.80 / 12.09 |   2 分钟 |

完整明细：

- `data/history-gate-bitget-1m-6d-2026-10-30.json`
- `data/rotation-history-gate-bitget-1m-6d-2026-10-30.json`

## 4. 结论

1. WARD 仍然是最高优先级：频率最高、压力样本最多、窗口最长。
2. KAT 是第二优先级：频率和压力样本都足够，当前两所也已有库存。
3. LIGHT 频率高，但压力样本只有 5 个，不能把它当作稳定收益来源。
4. LA、BREV、AEON 频率较低，但双向性完整，适合作为补充监控。
5. KAIA 频率太低，暂不加入。

因此 live 配置加入 LIGHT、LA、BREV、AEON 作为监控标的。它们没有余额时
只会产生候选和拒绝原因，不会下单；必须先有实际库存或经过人工确认的
库存准备，才会参与自动执行。

## 5. 当前 WARD 的特殊情况

2026-10-30 的实盘数据显示，Gate->Bitget 的 WARD 仍有约 145 bps 的账面
价差，但 Bitget 只剩约 24.5 WARD，最大可执行名义金额只有约 0.126 USDT，
低于最小下单额。原因是上一笔 Gate 买入、Bitget 卖出的完整轮换卖掉了
Bitget 的大部分 WARD，随后 Gate 侧又发生了没有本地订单记录的外部卖出。

这不是检测漏报，而是库存不足。恢复 WARD 需要：

- 在 Bitget 补回 WARD 多头库存；或
- 用 Gate 已有的 WARD 完成反向轮换；或
- 等外部库存重新平衡后，由 KAT/LIGHT 等已有库存标的继续产生交易。

## 6. 风险

- 6 天 1 分钟 OHLCV 不能模拟盘口深度、队列位置和真实成交概率。
- LIGHT/LA/BREV/AEON 的压力样本少于 WARD/KAT，不能用回测频率承诺收益。
- 小币可能有提现关闭、价格异常、最小下单额和精度变化；执行前仍要经过
  盘口、余额、FOK 和风险检查。
- 该回测不改变最小净利、安全缓冲、kill switch 或单批限制。
