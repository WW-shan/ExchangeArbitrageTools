# S1 冻结盘口事故与修复（2026-11-19）

> 事故：2026-11-19 21:38 UTC（北京时间 05:38），execution 139。
> 结果：买入 5289 WARD 全部成交，卖出 0 成交，留下 5289 WARD 未对冲并触发 kill switch。

## 1. 一句话结论

**S1 从来没有检查过「卖腿的盘口是不是还在动」。** 插针通道有 `BookLivenessTracker`，
S1 通道完全没有。Bitget 的 WARD 买一价在一段时间里是一个不动的挂单，
跨所价差把它读成了 100–200 bps 的利润，而那个价位根本没有买家。

## 2. 事故明细

| 项目 | 数值 |
| --- | --- |
| 方向 | bitget 买 -> gateio 卖 |
| 信号净利 | **7.56 bps**（约 0.0066 USDT） |
| 买入 | 5289 WARD @ 0.001639，**全部成交** |
| 卖出 | 5289 WARD @ 0.001642，**0 成交** |
| 对冲 FOK | 0 成交，`hedge_fok_not_filled` |
| 未对冲库存 | 5289 WARD |

## 3. 盘口证据

146 秒窗口、30 个采样点：

| 交易所 | 唯一 bid 值数量 | 说明 |
| --- | --- | --- |
| gateio | **14** | 正常跳动 |
| bitget | **1**（0.001676 全程不变） | 没人成交的挂单 |

## 4. 64 笔 S1 真实信号统计（决定性数据）

| 信号净利档位 | 笔数 | 成交率 | 已实现盈亏（USDT） |
| --- | --- | --- | --- |
| 0–20 bps | 14 | **79%** | +0.116 |
| 20–50 bps | 13 | 31% | +0.183 |
| 50–100 bps | 10 | 50% | +0.172 |
| **100–200 bps** | **20** | **0%** | **0.000** |
| 200+ bps | 7 | 43% | +1.223 |

那 20 笔 100–200 bps 的信号，**全部**是拿 Bitget 冻结的 0.001676 bid 当卖出价。
这不是「利润越大越难成交」，而是**价格是假的**。

## 5. 修复

在 `apps/scanner/src/scanner-service.ts` 中：

- 新增独立的 `#s1Liveness = new BookLivenessTracker(...)`，与插针检测器分开，
  避免两个通道互相污染状态。
- `evaluateS1Group` 每次扫描都 `observe` 所有盘口（包括之后会被拒的快照），
  否则中途冻结的盘口永远攒不够重复计数。
- **卖出侧冻结检查**：卖腿交易所的 `repeatCount >= s1_max_repeat_count` 时，
  直接 `stale_orderbook` 拒绝，并在 metadata 记录 `sellBookRepeatCount`。

配置（`config/live-rotation.toml`）：

```toml
s1_max_repeat_count = 8
```

8 次 × 5 秒热扫描 = **40 秒盘口完全不动**。真实交易所不会这样。
0 表示关闭检查。代码默认值也是 8。

## 6. 为什么只检查卖腿

买腿用的是 ask，我们要主动去吃它；只要下单，成交与否由我们自己的限价决定。
卖腿用的是 bid，我们**必须有一个真实买家**才能成交。冻结的 bid 正是「看起来有人买、
其实没有」的典型形态，而它是唯一会让系统「买到了却卖不掉」的环节。

## 7. 事故恢复

1. Dry-run 对冲方案 -> 预计亏损 0.0688 USDT
2. 真实执行：Gate 卖出 5289 WARD @ 0.001637，成交，**实现亏损 -0.0278 USDT**
3. 核对：`openExecutions=0`、`unresolvedOrders=0`、`unhedged=[]`
4. 余额：bitget 5.076 USDT / 6890.863 WARD；gateio 9.228 USDT / 58.721 WARD
5. `release-cli.ts --confirm RELEASE-KILL-SWITCH` 解除
6. `scripts/start-rotation.ps1` 重启 -> RUNNING，executor WAIT，scanner SCANNING
7. 生产验证：重启后 6312 次 S1 评估，`staleRejects=0`（当前盘口在动，没有假信号）

## 8. 测试

`apps/scanner/tests/scanner-service.test.ts` 新增两个用例：

- `rejects an S1 sell leg priced against a bid that never moves` —— 复现那 20 笔失败场景。
- `keeps trading when the sell venue keeps moving` —— 确认不会误伤正常盘口。

全量：**614 passed**。

## 9. 教训

风控参数再多，也不能替代「这个价格是不是真的」。
冻结盘口检查是**零成本**的：拒掉一个假信号不损失任何东西，
接受一个假信号损失一整笔仓位。
