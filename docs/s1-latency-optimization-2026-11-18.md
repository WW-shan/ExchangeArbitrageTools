# S1 延迟拆解与热路径优化（2026-11-18）

## 1. 结论先说

这次不应先重写 Rust。实测慢的不是 Rust/TypeScript 的计算，而是：

1. 预检阶段串行等待私有 REST（余额、挂单）；
2. 盘口没有稳定的 WS 热快照，执行端回退到 REST 抓盘；
3. 低流动性盘口在预检到提交的几百毫秒内被抽走。

74 号实盘执行的原始数据：

| 阶段                         |     耗时 |
| ---------------------------- | -------: |
| 信号产生到 executor 开始执行 | 约 627ms |
| 余额 REST                    |    375ms |
| 盘口抓取                     |    444ms |
| 预检总计                     |    819ms |
| 预检完成到两腿提交           |      8ms |
| Bitget 买单响应              |    333ms |
| Gate 卖单响应                |    155ms |

也就是说，**内部逻辑只占 8ms**，剩下全是网络、私有 REST 和盘口变化。把 TypeScript 换成 Rust，最多省掉这 8ms 里的很小一部分，无法抵消 150–330ms 的交易所 RTT。

## 2. 74 号失败的真正原因

74 号信号方向为 `bitget -> gateio`：

- Bitget 买入 3071 WARD @ 0.001602，成交；
- Gate 卖出 3071 WARD @ 0.001612，FOK 0 成交；
- 预检时 Gate 卖一为 `4015 WARD @ 0.001612`，理论上足够；
- 但预检完成到提交只有 8ms，Gate 卖一在这 8ms 内被抽走；
- 系统只能立即在 Bitget 反向卖出 3067.92 WARD，实现亏损约 -0.058866 USDT。

这不是定价公式错误，而是**低流动性盘口的瞬时撤单风险 + 预检等待过长**。因此优化方向是：

- 把预检从 819ms 压到几十毫秒；
- 让执行端直接读取 scanner 的 WS 最新盘口；
- 私有余额/挂单改成后台缓存，热路径不再等 REST。

## 3. 本次已落地的改动

### 3.1 预检并发化

`apps/executor/src/coordinator.ts` 中，余额、挂单、买盘、卖盘四件事现在同时发起：

- 不再“先等余额 375ms，再抓盘 444ms”；
- 最慢的一项决定预检时间，而不是所有项相加；
- 任何一项失败仍然 fail closed，不会因为并发而降低安全性。

### 3.2 WS 热盘口表

新增 `hot_orderbooks` 表（migration 12）：

- 每个 `(venue_id, exchange_symbol)` 只保留一行；
- scanner 在 WS book 通过校验后 upsert；
- executor 预检优先读取该行，`preflight_hot_book_max_age_ms`（默认 3000ms）内有效；
- 读取失败才回退到历史 `orderbooks` 快照，再回退到 REST。

这样不会把每个 WS tick 都写成历史行，避免数据库膨胀；同时 executor 能在 1–2ms 内拿到最新盘口。

### 3.3 余额/挂单预检缓存

新增 `apps/executor/src/preflight-cache.ts`：

- `auto_rotation.balance_refresh_ms` 改为 1000ms；
- 后台并发刷新余额和挂单；
- executor 热路径优先读缓存（默认 3000ms 新鲜窗口）；
- 缓存过期、缺币种、查询失败时自动回退 REST；
- 每次成交后立即触发一次强制刷新。

### 3.4 诊断字段

预检 timing 现在记录：

- `balanceSource: cache | rest`
- `openOrderSource: cache | rest`
- `bookSources: { buy: hot | snapshot | rest, sell: ... }`

下一次实盘可以直接从审计日志判断是否命中热路径。

### 3.5 scanner 扫描间隔

`ws_scan_interval_ms` 从 250ms 降到 100ms，减少 WS 更新到信号生成的等待。

## 4. 预期效果

缓存全部命中时：

- 余额：接近 0ms；
- 挂单：接近 0ms；
- 盘口：1–2ms（SQLite 热行）；
- 预检总计：预计 5–20ms；
- 预检到提交仍然约 8ms；
- 总信号到下单约 20–40ms + 交易所 RTT。

缓存未命中时：

- 余额/挂单/盘口仍并发执行；
- 预检上限约为最慢 REST 的耗时，而不是三者之和。

## 5. 还需要做什么（按收益排序）

### P0：部署到交易所附近 VPS

当前 Gate 155ms、Bitget 333ms 的响应主要是代理和物理距离。把 executor 放到东京/新加坡等交易所附近，通常可以把 RTT 压到 10–50ms。这个收益远大于 Rust。

### P1：私有用户数据 WS

余额和挂单目前是 1 秒轮询。若要做到真正零等待，可以接 CCXT Pro 的 `watchBalance` / `watchOrders`，用私有 WS 维护余额和挂单状态；REST 只做校准。当前缓存已经把热路径从 375ms 降到接近 0，先观察命中率再决定是否值得增加维护复杂度。

### P2：脆弱腿优先/串行化

低流动性下，即使预检只有 10ms，盘口仍可能被抽走。可选策略：

- 先提交库存所在腿（卖出腿），确认成交后再提交买入腿；
- 或识别“盘口深度/撤单率”更脆弱的一腿，优先提交；
- 代价是多一次 RTT，但可以避免“买入已成交、卖出 0 成交”的强制对冲亏损。

这需要单独做 A/B 回测和实盘小批量验证，不应直接替换当前并行 FOK。

### P3：Rust

只有在以下条件都满足后才考虑：

1. 已部署 VPS，网络 RTT 已压到 10–50ms；
2. 预检已稳定在 20ms 内；
3. 发现 WS 解析、订单簿维护或签名计算成为 CPU 瓶颈。

否则 Rust 重写只会增加维护成本，不会改变实盘成交速度。

## 6. 当前实盘状态

- kill switch：`true`
- `auto_execution_enabled`：`false`
- 未对冲库存：空
- 挂单：空
- Gate WARD：约 3093.93
- Bitget WARD：约 6136.87
- Gate USDT：约 7.21
- Bitget USDT：约 6.10

在重新启动前，必须先确认：

1. 没有残留 executor/scanner 进程；
2. `rotation:status` 为 `STOPPED`；
3. `account:state` 无未对冲、无未知订单；
4. 释放 kill switch 后先跑最小金额单批，观察 `balanceSource/openOrderSource/bookSources` 是否命中 `cache/hot`。

## 7. 本机时钟问题

实测本机时间比 Gate/Bitget 服务器时间快约 13.2–13.4 秒，Windows Time 服务未同步（Local CMOS Clock）。这不影响本次真实网络耗时，但会让成交绝对时间、信号年龄和交易所时间戳对账产生偏差。`w32tm /resync /force` 因权限不足失败；需要在管理员 PowerShell 中执行：

```powershell
w32tm /config /manualpeerlist:time.windows.com,0x9 /syncfromflags:manual /reliable:no /update
Restart-Service w32time
w32tm /resync /force
```

在时钟修正前，代码已避免用交易所旧时间戳判断盘口新鲜度，改用本地 `receivedAt`。
