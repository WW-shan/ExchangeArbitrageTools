# TBK 双向库存套利实盘记录（2026-10-29）

## 结论

TBK 链路已经打通，并完成第一笔自动双向库存套利：

```text
方向: Hotcoin 买入 -> Gate 卖出
数量: 39 TBK
Hotcoin 买入价: 0.22799 USDT
Gate 卖出价:    0.23346 USDT
状态: CLOSED
已实现经济利润: 0.20706918882 USDT
现金利润:       0.1865328894 USDT
返佣应收:       0.02053629942 USDT
净手续费:       0.00626081118 USDT
批次: S1-111631-1793244608063
执行 ID: 1
```

这不是模拟，也不是只读信号；两腿都是真实 FOK 成交，执行器完成了余额对账，没有未对冲库存，没有未知订单，没有开放批次。

## 之前为什么一直不成交

### 1. TBK 最初不在自动白名单

扫描器已经能看到 TBK，但 `auto_rotation.pairs` 只有 LIGHT，所以 TBK 信号不会进入执行器。

修复：把 `TBK/USDT` 加入 `[[auto_rotation.pairs]]`，并把 TBK 加入 `base_assets`。

### 2. 3 秒盘口时间戳阈值误杀低流动性市场

Gate 的 TBK REST 盘口在低流动性时经常 2 到 15 秒没有新更新。旧配置：

```toml
max_orderbook_age_ms = 3000
max_feed_latency_ms = 3000
```

扫描器把“交易所时间戳超过 3 秒”直接判为 `exchange_timestamp_stale`，于是 TBK 在大部分周期根本没有进入 S1 评估。这个时间戳代表“最后一次盘口更新”，不等于“这次 HTTP 请求很慢”，也不等于盘口一定失真；低流动性币长时间没有新成交是正常现象。

修复后的低流动性配置：

```toml
max_orderbook_age_ms = 20000
max_feed_latency_ms = 20000
max_freeze_ms = 10000
ws_max_book_age_ms = 5000
max_pair_skew_ms = 5000
```

执行器仍然会在下单前重新抓取两边盘口、重新读余额、重新计算净利，并用 FOK 限价保护；扫描器放宽时间戳不是取消执行前校验。

### 3. 9.5 USDT 最小批次刚好高于 TBK 可用库存

当时 Gate 有约 39.96 TBK，Hotcoin 有约 9.71 USDT。按 Hotcoin 买价约 0.228 计算，可执行名义额约：

```text
39.96 TBK * 0.228 USDT/TBK = 9.11 USDT
```

旧配置 `min_sizing_notional = 9.5` 把这条真实可做的链路判成 `insufficient_balance`。修复为 3 USDT，执行器仍按市场最小额和余额重新 sizing。

### 4. 200 bps 异常价差阈值把真实低流动性价差拦掉

TBK 当时的可执行价差约 240 bps，旧配置：

```toml
max_price_deviation_bps = 500
suspicious_spread_bps = 200
```

会把这条链路标成 `suspicious_spread` 或 `price_outlier`。修复为 1000 bps，同时保留 10% 的异常上限；超过 10% 的跳价仍然拒绝。低流动性机会本来就会比主流币价差大，不能再用主流币的 2% 阈值。

### 5. Hotcoin 的 TBK 最小额不是 15 USDT

Hotcoin 的最小额按交易对返回。`tbk_usdt` 的 `minOrderAmount=0`，并且已经有 `1 TBK` FOK 卖出真实成交记录。15 USDT 是部分其他 Hotcoin 交易对的最小额，不能套到 TBK 上。

## 本次真实成交

### 执行前

```text
Gate TBK:     39.9604
Hotcoin TBK:   0.914
Gate USDT:    10.5088
Hotcoin USDT:  9.707534
```

当时可执行方向是 `Hotcoin -> Gate`：

- Hotcoin 用 USDT 买入 TBK；
- Gate 用已有 TBK 卖出；
- 两边数量对齐到 Hotcoin 的 1 TBK 步长。

### 成交腿

| 腿  | 交易所  | 方向 |   数量 |       成交价 |           手续费 |
| --- | ------- | ---- | -----: | -----------: | ---------------: |
| 1   | Hotcoin | 买入 | 39 TBK | 0.22799 USDT |        0.078 TBK |
| 2   | Gate.io | 卖出 | 39 TBK | 0.23346 USDT | 按返佣后净额计入 |

### 执行后

```text
Gate TBK:      0.9604
Hotcoin TBK:  39.836
Gate USDT:    19.6047261094
Hotcoin USDT:  0.815924
```

当前 TBK 库存方向已经翻转为：

```text
Gate USDT + Hotcoin TBK -> 等待 Gate 买入、Hotcoin 卖出
```

下一次只有在该方向出现正净利时才会自动执行；如果没有机会，程序只等待，不会强行反向亏损交易。

## 利润口径

执行记录同时保留现金口径和返佣口径：

```text
毛价差:       0.21333 USDT
净手续费:     0.00626081118 USDT
现金利润:     0.1865328894 USDT
返佣应收:     0.02053629942 USDT
经济利润:     0.20706918882 USDT
库存变化:     -0.078 TBK, +0.2043161094 USDT
```

Hotcoin 买入手续费以 TBK 扣除，因此库存少 0.078 TBK；这部分已经计入经济利润，不是遗漏的未对冲库存。

## 运行与核对

当前扫描器和自动执行器仍在后台运行。核对命令：

```powershell
Get-Content data/rotation-run.out.log -Tail 80
Get-Content data/rotation-scanner.stdout.log -Tail 80
```

数据库核对：

```sql
SELECT id, status, realized_profit, batch_id
FROM executions ORDER BY id DESC LIMIT 5;

SELECT venue_id, symbol, side, amount, filled_amount, average_price, status
FROM orders ORDER BY id DESC LIMIT 10;

SELECT venue_id, currency, free, total, fetched_at
FROM balances ORDER BY fetched_at DESC LIMIT 20;

SELECT * FROM unhedged_inventory WHERE status = 'open';
```

## 仍然存在的风险

1. 这是两个交易所的非原子成交；第一条腿成交后，第二条腿仍可能失败。失败会进入 SAFE_STOP 并记录未对冲库存。
2. TBK 是低流动性币，盘口可能长时间不更新；FOK 可以防止追价，但不能保证第二条腿一定成交。
3. 当前利润包含尚未到账的返佣应收；返佣到账时间仍要按交易所账单核对。
4. 当前自动链路只做库存轮换，不做自动提币。库存结构性失衡时仍需要人工处理。
5. 放宽时间戳阈值只适用于这类低流动性轮换；主流币和更大金额仍应使用更严格的阈值。
