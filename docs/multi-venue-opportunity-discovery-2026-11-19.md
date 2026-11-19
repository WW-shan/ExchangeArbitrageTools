# 多交易所机会发现：Gate x Bitget 之外的真实价差（2026-11-19）

> 起因：WARD 单标的长时间无价差，系统空转。此前结论「全市场没有机会」只扫了 Gate 和 Bitget。
> 本轮把发现工具扩展到三所，结论完全不同。

## 1. 之前的结论是错的

`scripts/discover-candidates.ts` 原来把交易所写死成 `['gateio','bitget']`，
并且要求**双向可提币**才进入候选。两条限制叠加，把真正的机会全部排除了：

| 限制 | 后果 |
| --- | --- |
| 只扫两所 | 看不到第三所的系统性价差 |
| 要求双向提币 | 库存轮转模型不需要提币，却因此排除了低流动性币 |

2026-11-19 用原工具扫 413 个共同币：`none. Nothing on Gate x Bitget clears fees`。
这是**真的**——但只对这两个所有效。

## 2. 扩展后的工具

`scripts/discover-candidates.ts` 新增：

- `--venues gateio,bitget,weex`：任意交易所列表，自动枚举所有有序方向对。
- `--fees gateio=2.97,bitget=2,weex=10`：按所覆盖有效费率（含返佣后）。
- `--require-transfer`：**默认关闭**。库存轮转不需要提币；需要时显式打开。
- 候选按「被几个所同时上线」再按成交量排序。

## 3. 实测结果（3 所 x 120 币 x 5 轮）

```
venues: gateio,bitget,weex | shared USDT bases: 701, candidates: 120
  round 5/5: 64 candidates seen
```

64 个币出现 >= 20 bps 净价差，其中 20 个 **5/5 轮全部命中**：

| 币 | 方向 | 最好净价差 |
| --- | --- | --- |
| CP/USDT | weex -> gateio | 985 bps |
| CP/USDT | weex -> bitget | 952 bps |
| CT/USDT | weex -> bitget | 754 bps |
| CC/USDT | weex -> bitget | 488 bps |
| GWEI/USDT | weex -> gateio | 430 bps |
| PRL/USDT | weex -> bitget | 261 bps |
| CYS/USDT | weex -> bitget | 252 bps |

## 4. 关键判据：这些机会是真的吗

WEEX 的盘口经常**冻结**，所以「有价差」不等于「能成交」。
用 25 秒、10 次采样测 top-of-book 唯一值数量：

| 币 | weex 唯一值 | gateio 唯一值 | 结论 |
| --- | --- | --- | --- |
| CP/USDT | **1** | 4 | WEEX 冻结，假信号 |
| CT/USDT | **1** | 7 | WEEX 冻结，假信号 |
| GWEI/USDT | **1** | 2 | WEEX 冻结，假信号 |
| PRL/USDT | **1** | 3 | WEEX 冻结，假信号 |
| **CC/USDT** | **6** | 3 | **两边都在动，真机会** |

这和 2026-11-18 Bitget WARD 那张挂了 13 小时的 12391.31 WARD 买单是同一类陷阱：
**价格不动 + 数量不动 = 没人真的在交易**。

## 5. CC/USDT 的真实形态

90 秒连续采样，4 秒一次：

```
01:50:37  weexAsk 0.07807x712   gateBid 0.08202x54    506 bps
01:50:45  weexAsk 0.07812x3227  gateBid 0.08202x1054  499 bps
01:50:53  weexAsk 0.07806x3229  gateBid 0.08201x3595  506 bps
01:51:01  weexAsk 0.07812x6115  gateBid 0.08202x1121  499 bps
01:51:31  weexAsk 0.07806x3236  gateBid 0.08199x3420  503 bps
01:52:03  weexAsk 0.07808x3235  gateBid 0.08202x1267  505 bps
```

- 价差稳定在 **495-510 bps**，持续 90 秒以上
- WEEX 卖一挂单量在 **712 -> 3227 -> 6115 -> 783** 之间真实跳动（有人在挂、在撤、在成交）
- Gate 买一有 **1000-3600 个 CC**，约 **$82-295**
- 24h 成交量：Gate $1.40M / Bitget $552K / WEEX $223K，是真实市场

### 单笔收益测算

| 项目 | 数值 |
| --- | --- |
| 买入（WEEX ask） | 0.0781 |
| 卖出（Gate bid） | 0.0820 |
| 毛价差 | 约 500 bps |
| 手续费（10 + 2.97） | 约 13 bps |
| 净价差 | **约 487 bps** |
| 3 USDT 单笔毛利 | **约 0.146 USDT** |

3 USDT 是 Gate 的最小可执行金额。按当前余额（Gate 9.23 + Bitget 5.08 USDT）
可以连续做十几笔，不需要提币——**库存轮转**即可。

## 6. 结构性发现：WEEX 系统性偏低

六个币的同一时刻盘口：

| 币 | gateio spread | weex spread | 差 |
| --- | --- | --- | --- |
| CP/USDT | -21 bps | **-129 bps** | 108 |
| CT/USDT | -11 bps | **-81 bps** | 70 |
| GWEI/USDT | -26 bps | **-73 bps** | 47 |
| CC/USDT | -4 bps | **-58 bps** | 54 |
| PRL/USDT | -18 bps | **-122 bps** | 104 |
| IRYS/USDT | -28 bps | **-91 bps** | 63 |

WEEX 的买卖价差比其他所宽 **47-108 bps**。这是低流动性所的正常特征，
也意味着 **weex 买 / 大所卖** 这个方向天然占优。

但同样的宽度也意味着 WEEX 的盘口更容易冻结。
所以每一笔都必须先过「买一是否在动」这一关。

## 7. 下一步

1. WEEX 私有 API（余额 / 下单）尚未接入实盘链路，需要 API key。
2. 现有 `BookLivenessTracker` 已经能识别冻结盘口，
   把 WEEX 加入 `enabled_venues` 后同一套判据会自动生效。
3. 建议先把 CC/USDT 加进 `[[auto_rotation.pairs]]`，
   与 WARD 并行监控，只做 weex->gateio / weex->bitget 方向。
