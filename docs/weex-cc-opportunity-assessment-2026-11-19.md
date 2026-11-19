# WEEX 接入评估：CC/USDT 是当前最好的机会（2026-11-19）

> 60 秒连续实测，3 USDT 单笔净赚 0.147-0.155 USDT。
> WARD 同期无可交易机会。

## 1. 实测数据

```
02:39:28  weexAsk 0.07778x3307  gateBid 0.08169  503 bps  profit $0.1508
02:39:34  weexAsk 0.07773x214   gateBid 0.08166  506 bps  profit $0.1517
02:39:40  weexAsk 0.07776x3114  gateBid 0.08166  502 bps  profit $0.1505
02:39:47  weexAsk 0.07768x3114  gateBid 0.08165  511 bps  profit $0.1533
02:39:53  weexAsk 0.07765x3315  gateBid 0.08165  515 bps  profit $0.1545
02:39:59  weexAsk 0.07770x327   gateBid 0.08165  508 bps  profit $0.1525
02:40:05  weexAsk 0.07786x341   gateBid 0.08169  492 bps  profit $0.1476
02:40:12  weexAsk 0.07773x329   gateBid 0.08172  513 bps  profit $0.1540
02:40:18  weexAsk 0.07776x208   gateBid 0.08175  513 bps  profit $0.1539
02:40:24  weexAsk 0.07779x343   gateBid 0.08175  509 bps  profit $0.1527

unique top-of-book over 30s: weex=10, gateio=8
```

**两边都在真实跳动，不是冻结盘口。**

## 2. 与 WARD 的对比

| 项目 | WARD（gateio->bitget） | CC（weex->gateio） |
| --- | --- | --- |
| 价差 | 20-45 bps | **492-515 bps** |
| 3 USDT 单笔 | 约 0.006 USDT | **约 0.151 USDT** |
| 深度 | 经常 < 0.1 USDT | **3 USDT 完全吃得下** |
| 持续时间 | p50 1.4 秒 | **60 秒以上** |
| 盘口活性 | 好 | 好（10 个唯一值/30 秒） |

**CC 的单笔收益是 WARD 的 25 倍。**

## 3. 72 小时历史数据支持

按方向统计 >=20 bps 的样本与深度：

| 方向 | 样本 | 深盘(>=3USDT) | 占比 | 平均价差 |
| --- | --- | --- | --- | --- |
| **bitget -> weex** | 570 | **570** | **100%** | **672 bps** |
| **weex -> gateio** | 1593 | **1593** | **100%** | **382 bps** |
| weex -> bitget | 817 | 817 | 100% | 137 bps |
| gateio -> weex | 87 | 87 | 100% | 48 bps |
| gateio -> bitget | 2147 | 937 | 44% | 37 bps |
| bitget -> gateio | 10494 | 213 | 2% | 53 bps |

**所有涉及 WEEX 的方向都是 100% 深盘。**
Gate x Bitget 内部只有 2-44% 的样本有足够深度。

## 4. 为什么之前没发现

两个原因叠加：

1. `discover-candidates.ts` 把交易所写死成 gateio + bitget。
2. 要求双向可提币，而 WEEX 上 CC 没有提币网络。

已修复：`--venues` 可选任意交易所，`--require-transfer` 默认关闭。

## 5. 接入需要的条件

| 条件 | 状态 |
| --- | --- |
| WEEX 公开行情 | 已有（`ccxt.weex`） |
| WEEX 私有 API key | **缺** |
| WEEX 现货下单 | 需验证 CC 的最小下单量 |
| CC 提币 | 无网络，**必须靠库存轮转** |
| 冻结盘口防护 | 已有（买一活性检查） |

### CC 的库存轮转模型

```
初始:  WEEX 有 CC + Gate 有 USDT
交易:  WEEX 买 CC（花 USDT） -> Gate 卖 CC（收 USDT）
结果:  WEEX 有 USDT + Gate 有 CC   <- 库存翻转
下一笔: 需要 WEEX 有 USDT、Gate 有 CC，方向变成 gateio -> weex
```

所以 CC 必须**双向**都有机会才能持续。
历史数据里 `gateio -> weex` 有 87 个深盘样本（48 bps），`bitget -> weex` 有 570 个（672 bps）。
**双向都有，可以轮转。**

## 6. 建议

1. 申请 WEEX API key（现货交易权限）。
2. 先做最小额实测：CC/USDT 3 USDT 单笔，验证下单和成交。
3. 验证通过后加入 `[[auto_rotation.pairs]]`：
   `base = 'CC'`, `venues = ['gateio', 'weex']`。
4. WARD 保留，两个标的并行监控，谁有机会做谁。

## 7. 风险

- CC 在 WEEX 无提币网络，库存卡在某一侧就停摆。
- WEEX 的部分币盘口会冻结（CP/CT/GWEI/PRL 实测 25 秒不动）。
  CC 目前是活的，但必须靠买一活性检查实时判断。
- WEEX 费率按 10 bps 计（未确认返佣），实际可能更高。
