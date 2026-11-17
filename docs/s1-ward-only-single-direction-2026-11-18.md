# WARD-only 单方向库存轮换设计（2026-11-18）

## 1. 当前决策

- 只交易 `WARD/USDT`，不再同时维护 KAT、LIGHT、LA、BREV、AEON。
- 只启用 `gateio` 与 `bitget` 两个执行场所。
- 每批最大名义金额 `5 USDT`，最小可执行买入 `3 USDT`。
- 单次只允许一个 open batch；成交并核对后才进入下一轮。
- 目标不是“两边都提前囤满 WARD”，而是让库存随每次成交自然换边。

## 2. 单方向库存模型

当前账户的起点是：

| 场所    |       WARD |           USDT | 角色               |
| ------- | ---------: | -------------: | ------------------ |
| Gate.io | 4286.75191 |  5.42952923471 | 卖方：有 WARD 可卖 |
| Bitget  |          0 | 15.99715483644 | 买方：有 USDT 可买 |

因此第一笔只做 `Bitget 买入 -> Gate 卖出`：

1. Bitget 用 USDT 买入 WARD。
2. Gate 卖出等量 WARD 换取 USDT。
3. 成交后 Bitget 的 WARD 增加、USDT 减少；Gate 的 WARD 减少、USDT 增加。
4. 下一笔自然变成 `Gate 买入 -> Bitget 卖出`。

这就是“库存翻转”。程序不要求两个场所同时持有 WARD，也不要求两个方向同时可执行。
每次只检查当前真正有库存的那一个方向；没有库存的一边不会下卖单。

## 3. 为什么不默认两边买满

- 两边同时囤 WARD 会占用双倍资金，并把一半资金暴露在暂时没有价差的标的上。
- 提前买入不是套利利润，而是一笔方向性库存；如果价差继续扩大，库存会先浮亏。
- WARD 的价差机会是间歇性的，单边库存已经足够捕捉当前方向；成交后库存会换到另一边。
- 自动 seed 只在“出现新的方向性 S1 信号 + 缺失侧确实需要库存 + 价格在允许偏差内”时触发，
  不是常驻的“两边都买”指令。

## 4. 信号与执行规则

- 行情：WebSocket 盘口，`ws_scan_interval_ms=1000`，只订阅 WARD/USDT。
- 信号窗口：`max_signal_age_ms=5000`；执行前重新拉取两边盘口。
- 执行：`parallel_fok`，两边同时提交 FOK；FOK 不成交不会留下挂单。
- 利润门槛：`min_net_profit_bps=5`、`safety_buffer_bps=2`、`min_profit_usd=0.005`。
- 滑点上限：`max_slippage_bps=30`；单批最大 `5 USDT`。
- 余额：每次执行前刷新；只使用新鲜余额。过期余额按缺失处理，不拿旧缓存当库存。
- 安全：未知订单不重试；部分成交进入 `SAFE_STOP`；residual hedge 最多允许 `1 USDT` 损失；
  任何异常都会打开 kill switch，而不是继续重试。

费用口径：

| 场所    | 毛 taker |   返佣 |   当前有效成本 |
| ------- | -------: | -----: | -------------: |
| Gate.io |  9.9 bps |    70% |       2.97 bps |
| Bitget  |   10 bps | 未配置 | 10 bps（保守） |

Bitget 的 80% 返佣尚未在配置中确认，因此当前按 10 bps 保守计算；确认后再加 `rebate_pct = 80`，
不要先用假设费率放大信号。

## 5. 当前关键配置

```toml
[scanner]
enabled_venues = ['gateio', 'bitget']
monitor_only_venues = []
base_assets = [WARD]
max_base_assets = 1
max_order_notional = 5
feed_mode = 'websocket'
ws_scan_interval_ms = 1000
min_net_profit_bps = 5
min_profit_usd = 0.005
max_slippage_bps = 30
balance_safety_buffer_bps = 100
min_buy_quote_reserve_usd = '0.5'

[execution]
live_enabled = true
leg_mode = 'parallel_fok'
max_open_batches = 1
daily_max_loss_usd = 5

[auto_rotation]
enabled = true
max_signal_age_ms = 5000
max_preflight_ms = 4000
cooldown_ms = 0

[[auto_rotation.pairs]]
base = 'WARD'
quote = 'USDT'
venues = ['gateio', 'bitget']
max_notional = '5'
```

## 6. 启动与监控

启动：

```powershell
. .\scripts\load-env.ps1
$env:ARB_CONFIG='config/live-rotation.toml'
npm run rotation:start
npm run rotation:status
```

必须同时看到：

- watchdog `RUNNING`
- executor 心跳 `running`，phase 在 `WAIT` / `BALANCING` / `EXECUTING` 之间变化
- scanner 心跳 `running`，phase `SCANNING`
- 日志里只有 `WARD/USDT`，没有其他 base asset
- 没有 `SAFE_STOP`、没有 unknown order、没有挂单残留
- `openExecutions=0`、`unresolvedOrders=0` 在每轮开始前成立

查看账户与余额：

```powershell
npm run executor:balances
npm run account:state
```

停止：

```powershell
npm run rotation:stop
```

## 7. 当前实盘状态（2026-11-18 01:40 HKT）

- watchdog：`RUNNING`
- executor：`WAIT`，仅监控 `WARD/USDT`
- scanner：`SCANNING`，WebSocket 盘口每秒更新
- 未完成 execution：0
- 未解决 order：0
- Gate 挂单：0；Bitget 挂单：0
- 当前价差为负（Bitget->Gate 约 -90 bps，Gate->Bitget 约 -207 bps），所以不交易是正确状态
- 当前方向：Bitget 用 USDT 买、Gate 卖 WARD；等正价差出现后自动执行

## 8. 回测依据与边界

6 天 1 分钟 Gate/Bitget 历史数据（2026-11-12 至 2026-11-18）显示：

- WARD 有 204 个机会段，约 34 次/天；
- 中位净价差 75.41 bps，p90 234.38 bps，最大 601.48 bps；
- 压力样本 152 个；
- 实盘已验证一笔 3.06 USDT 的 Bitget->Gate 成交，净实现 `+0.023999687225 USDT`，
  端到端约 5.44 秒，无 SAFE_STOP。

但 1 分钟 OHLCV 回测不建模盘口深度、排队、延迟、成交概率和库存枯竭，不能把回测上限当成保证收益。
实盘只按当前盘口和 FOK 结果记账。

## 9. 下一步优先级

1. 先观察 24 小时：确认两个方向都能自然翻转，且每次成交后余额与 execution 记录一致。
2. 如果 Bitget 返佣确认是 80%，把 `[fees.bitget].rebate_pct` 设为 80，再观察机会数量变化。
3. 统计实际成交率、平均信号年龄、preflight 耗时和每笔净利，决定是否调整 `max_signal_age_ms`。
4. 只有在 WARD-only 稳定后，才考虑历史 tick 回测、告警、Prometheus 或多跳图算法。

## 10. 速度优化（2026-11-18 02:20 HKT）

目标不是“多付价格换成交”，而是缩短从信号出现到订单到达交易所的时间。当前热路径：

| 阶段                    | 之前                   | 现在                                 |
| ----------------------- | ---------------------- | ------------------------------------ |
| scanner WS 扫描等待上限 | 1000 ms                | 250 ms                               |
| executor 信号轮询       | 250 ms                 | 50 ms                                |
| 预检盘口                | 每次 REST 200-400 ms   | 优先读取 750 ms 内的 scanner WS 快照 |
| 私有 API 限额           | 5 RPS                  | 10 RPS                               |
| 盘口抓取与挂单检查顺序  | 先抓盘口，再等挂单检查 | 先并行等余额/挂单检查，再抓最新盘口  |

关键点：

- 不在下单前加人为 sleep；没有价格缓冲、没有冷却。
- 预检仍然保留余额和挂单检查；只是把盘口抓取放到检查之后，避免“抓到的盘口比下单时间早 600-900 ms”。
- WS 盘口以本地 `receivedAt` + `maxFreezeMs` 判断新鲜度。Gate 的 `book.timestamp` 经常是首次快照/最后变价时间，不能拿它当消息到达时间。
- 缓存盘口超过 750 ms 或校验失败时自动回退 REST，不会用过期盘口硬下单。

真正的延迟上限：

- Node 计算本身只有几毫秒到几十毫秒，Rust 重写不会解决主要延迟。
- 主要延迟来自代理到交易所的 RTT、私有 API 的 open-orders/余额查询，以及交易所 FOK 撮合。
- 下一步要再快，应该把执行端放到离交易所更近的 VPS，并使用私有 WebSocket 用户数据流替代每笔 REST 查询；这比换语言更有效。
