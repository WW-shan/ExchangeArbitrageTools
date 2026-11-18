# S1 亏损根因与修复（实测）

> 2026-11-19。这份文档记录的是一个真实的代码缺陷，不是市场问题。

## 0. 结论

**S1 亏损不是价差不够，是买到了不卖。**

| 指标 | 修复前（11-18） |
| --- | --- |
| S1 买入成交 | 27 笔 |
| S1 卖出成交 | **1 笔** |
| 累计盈亏 | **-2.54 USDT** |

## 1. 回归定位

`fed6fe7 feat: size WARD rotation from live balance ratio` 改了两件事：

```diff
-max_order_notional = "5"
+# 0 = no fixed cap: size from the limiting live balance and visible depth.
+max_order_notional = "0"
```

```diff
-max_notional = '5'
+max_notional = '0'
```

结果：

| 指标 | fed6fe7 之前 | 之后 |
| --- | --- | --- |
| S1 笔数 | 34 | 25 |
| 平均下单 | **5.52 U** | **7.92 U** |
| 累计盈亏 | **+1.88 U** | **-2.54 U** |

仓位放大 43%，盈亏从 +1.88 变成 -2.54。**这是唯一同时发生的变量变化。**

## 2. 代码层的真正缺陷

`apps/executor/src/coordinator.ts` 在买腿成交后的对冲逻辑：

```ts
// 修复前
if (preparation ? preparationCostTooHigh : projectedProfit.lte(0)) {
  this.recordUnhedgedInventory(...);
  return safeStop('post_fill_profit_not_positive');
}
```

**买腿已经成交了，币已经在账上。**
此时如果重算利润 <= 0，代码直接 SAFE_STOP，**卖腿从未提交**。

这等于：亏了就不卖，让它继续亏，直到人工发现。

### 2.1 为什么会「重算后利润为负」

买腿成交后，程序会重新拉一次卖方的盘口（`fetchFreshBook`）。
实测 Bitget 的 ask 在 1 秒后只有 **51%** 还停在原位：

```
bitget  + 1s: ask still reachable 51%  bid still reachable 93%  (n=396)
gateio  + 1s: ask still reachable 86%  bid still reachable 84%  (n=662)
weex    + 1s: ask still reachable 98%  bid still reachable 100% (n=273)
```

而我们买完到重拉盘口要 1.5 秒以上。所以「重算后利润变负」是**高频正常事件**，不是异常。

## 3. 修复

```ts
// 修复后
// 买腿已成交，币在账上。不卖不是"避免亏损"，是持有一个策略从未
// 设计过的裸头寸。唯一还允许停的条件是：平掉会锁定超过配置上限的亏损。
const exitLossUsd = projectedProfit.lt(0) ? projectedProfit.neg() : ZERO;
const exitLossCeiling = preparation?.maxCostUsd ?? this.#maxPostFillExitLossUsd;
if (exitLossUsd.gt(exitLossCeiling)) {
  this.recordUnhedgedInventory(...);
  return safeStop('post_fill_exit_loss_above_ceiling');
}
// 否则：继续执行卖腿
```

配置：

```toml
[execution]
max_post_fill_exit_loss_usd = "0.5"
```

0.5 USDT ≈ 7 USDT 一单的 7%。足够容忍盘口正常波动，又不至于在崩盘时无脑砸出去。

## 4. 为什么 0.5 U 是合理的

在一个 7 USDT 的批次上：

- 正常波动导致的重算亏损：0.01~0.15 USDT（实测 `-0.026 ~ -0.14`）
- 0.5 USDT 上限 = 7% 单笔回撤，远超正常波动
- 真正崩盘（币价腰斩）时会触发，此时停下来报警是对的

## 5. 验证

新增测试 `still sells after a filled buy when the spread has collapsed`：

- 构造「买腿成交 + 重拉卖盘价格下跌」的场景
- 断言 `sell.state.createCalls === 1`（卖腿必须提交）
- 断言 `reasons` 不含 `post_fill_profit_not_positive`

全部 595 个测试通过。

## 6. 仍然存在的风险

1. **卖腿仍可能部分成交**：`leg2_partial_fill` 这条路径没改，因为它代表真实的流动性不足。
   但至少现在会尝试，而不是直接放弃。
2. **`max_notional = 0` 仍然有效**：仓位仍按余额比例放大。
   修好卖腿后，放大仓位的风险会小很多，但仍需实测验证。
3. **WARD 是唯一标的**：单标的意味着没有分散，一旦 WARD 出问题就全停。

## 7. 下一步该看什么

重启后要盯的第一个指标：

> **S1 卖出成交笔数 / 买入成交笔数** 应该接近 1:1。
> 如果仍然是 1:27，说明还有另一条路径在吞掉卖腿。
