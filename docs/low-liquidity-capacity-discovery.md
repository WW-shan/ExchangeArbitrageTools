# 低流动性币种发现与容量分析（Gate.io + Hotcoin）

最后验证：2026-10-27 20:24 HKT。本文只覆盖只读发现，不启用实盘，
也不把毛边直接当成利润。

## 1. 结论先行

只扫描成交量前 30 的币，确实基本找不到机会。之前 top30 结果只有 12 个
双边盘口组，最佳毛边约 2 bps，扣 20 bps 往返手续费后为负。

改成“双边交集 + 低成交量区间”后，同一时间窗口内：

- Gate.io USDT 市场 2,181 个，Hotcoin USDT 市场 366 个。
- 两边都存在的统一 base 有 229 个。
- 成交量在 1,000 到 500,000 USD 之间的双边候选有 122 个。
- 实际抓到 244 本双边订单簿，0 个抓取错误。
- 244 条方向中，5 条达到费用前盈亏平衡，2 条达到配置的最低净边。
- 其中 1 条 clean 机会（INC），1 条高优先级待复核机会（TBK）。

这不是统计噪声：TBK 在约 2 分钟内的 3 次独立抓取里持续出现
360 到 368 bps 毛边，容量约 103 到 104 USDT。INC 在 50 到 86 bps
之间波动，容量约 47 到 63 USDT。HTX 在 34 到 45 bps 之间波动，
部分快照能过，部分快照是 near miss。

但这些不是长期稳定的价差。20:31 HKT 再复核时，TBK 的 gateio -> hotcoin
方向已经反转成约 -367 bps，Hotcoin 的厚 bid 被吃掉或撤掉了；INC 那一轮
Gate 快照变 stale；HTX 只剩约 8 到 17 bps。换句话说，低流动性机会确实
存在，但窗口很短，不能用几分钟前的曲线直接下单。

## 2. Gate 公共数据逐项复核

### 2.1 已验证可以读取

| 项目                              | 结果                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| 现货市场列表 /spot/currency_pairs | HTTP 200，2,181 个市场                                              |
| 全部 ticker /spot/tickers         | HTTP 200，2,183 条                                                  |
| 订单簿 /spot/order_book           | HTTP 200，CAKE、TBK、INC 等均可读                                   |
| 最低下单额与精度                  | min_base_amount、min_quote_amount、amount_precision、precision 可读 |
| WebSocket 首本订单簿              | 代理约 13.4 秒；直连约 1.97 秒                                      |
| CCXT loadMarkets                  | 已限制为只加载 spot，不再被交割合约端点拖累                         |

Gate 的 CCXT 默认 fetchMarkets 会同时请求 spot、swap、future、option。
其中 delivery 合约端点和 S1 无关，却可能在代理抖动时单独失败。现在
Gate spot 适配器设置 fetchMarkets.types = ['spot']，因此市场加载只依赖
现货端点。

### 2.2 Gate 低流动性数据的注意点

Gate 低流动性币的 REST 订单簿时间戳偶尔会落后 10 到 30 秒。INC 的
一次快照就出现过先被标记 stale_book，下一轮又恢复正常的情况。因此：

- 发现脚本保留 stale_book 标志，stale 快照不计入 clean/review 机会。
- 实盘前应使用 WebSocket 订单簿，或在执行前重新抓取并做跨源校验。
- Gate WebSocket 经代理偶尔 TLS 断开，但重试可以成功；直连更稳定。

## 3. 为什么不能再“每个交易所各取前 N”

原来的 top_volume 逻辑是先在每个交易所内部按成交量排序，再各取前 N。
这样会得到两个不同的币种集合，真正“两边都挂牌但都很冷门”的币会被
两边的前 N 同时排除。

新逻辑是：

1. 先按 base/quote 求所有启用交易所的交集。
2. 对每个交易所要求存在新鲜 ticker 和可解析的 24h quote volume。
3. 成交量下限取“较弱腿”，上限取“较强腿”：
   - min(volume) >= 1,000 USD，排除死盘。
   - max(volume) <= 500,000 USD，排除已经太有效的热门盘。
4. 用 ticker 的跨场所 bid/ask 毛边排序，再按较强腿成交量升序。
5. 对候选逐个抓取双边订单簿，计算两个方向和完整容量曲线。

这套逻辑在 apps/scanner/src/universe.ts 的 buildLongTailUniverse 中，
不会把 A 交易所的 INC 和 B 交易所的 ETH 拼成一个假的双边组。

## 4. 容量定义

容量不是“盘口看起来有多少”，而是按真实可见档位逐档吃单后的结果。
所有金额使用 Decimal，不使用二进制浮点。

| 字段                    | 定义                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| topGrossBps             | 买一价到卖一价的毛边，不扣费                                                                   |
| feeBreakEvenBps         | 买腿 taker + 卖腿 taker，覆盖手续费所需的最低毛边                                              |
| eligibleThresholdBps    | 手续费 + safety_buffer + min_net_profit，达到配置门槛的近似毛边                                |
| maxFeeBreakEvenNotional | 可见深度内，扣手续费后仍大于 0 的最大下单名义额                                                |
| maxProfitableNotional   | 扣手续费和 safety buffer 后仍大于 0 的最大名义额                                               |
| maxEligibleNotional     | 再满足 min_net_profit_bps 的最大名义额，最接近“可执行”                                         |
| depthExhaustionNotional | 买腿 ask 和卖腿 bid 可见深度都还够的最大名义额                                                 |
| bindingReason           | 最后卡住容量的是 fee_floor、profit_threshold、spread_decay、depth、notional_cap、stale_book 等 |
| classification          | clean、review、near_miss、rejected、no_edge                                                    |

容量搜索以 0.5 USDT 为粗步长，再在边界上做 12 次二分细化，因此
maxFeeBreakEvenNotional 和 maxEligibleNotional 的精度约为 0.001 USDT。
所有点都会重新走 S1 的深度、精度、最小额、手续费和 safety buffer 规则。

## 5. 使用方法

```powershell
$env:ARB_CONFIG = 'config/longtail.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'

# 快速扫描：按 ticker 毛边取前 60 个候选，约 37 秒
npm run scan:longtail -- --max-bases 200 --top 20 --detail 5 --out data/longtail-full.json

# 全量扫描：122 个候选全部抓取，约 60 秒
npm run scan:longtail -- --max-bases 200 --max-book-candidates 0 --top 20 --detail 5 --out data/longtail-all.json

# 只验证几个已知候选，方便重复确认
npm run scan:longtail:test

# 换费率场景；0/2/5/10/20 表示每腿 taker bps
npm run scan:longtail -- --bases TBK,INC,HTX --fee-scenarios 0,2,5,10,20 --out data/longtail-review.json
```

config/longtail.toml 中的费率是 10 bps/腿的筛选占位值，不是账户真实费率。
输出同时包含 0、2、5、10、20 bps/腿场景，方便看到费率变化后容量怎么缩。

## 6. 本次真实结果

### 6.1 汇总

以下结果使用 10 bps/腿、safety_buffer=2 bps、min_net_profit=5 bps、
min_profit_usd=0.01 的筛选参数。

| 币对      | 方向              | Gate/Hotcoin 24h USD |  毛边 bps | maxFeeBE USDT | maxEligible USDT | 分类                    |
| --------- | ----------------- | -------------------: | --------: | ------------: | ---------------: | ----------------------- |
| INC/USDT  | gateio -> hotcoin |       19,049 / 9,137 |     85.78 |         69.88 |            63.07 | clean                   |
| TBK/USDT  | gateio -> hotcoin |      64,356 / 55,791 |    367.83 |        105.51 |           103.98 | review，extreme_spread  |
| HTX/USDT  | gateio -> hotcoin |      2,567 / 151,888 |     34.17 |         19.73 |               无 | near_miss               |
| EDGE/USDT | gateio -> hotcoin |     24,489 / 455,607 |    31,082 |         5,225 |            5,225 | rejected，price_outlier |
| FAI/USDT  | gateio -> hotcoin |     40,827 / 263,667 | 6,245,274 |         11.57 |            11.57 | rejected，price_outlier |

EDGE 和 FAI 的毛边大到不可能是正常套利。它们被 price_outlier 拦截，
只用于说明“不能看到大数字就当机会”。

### 6.2 TBK 容量曲线

TBK 的 Gate 买一约 0.24183，Hotcoin 卖一约 0.25058。按 10 bps/腿：

| 名义额 USDT | 毛边 bps | 净边 bps | 是否达到最低净边 |
| ----------: | -------: | -------: | ---------------- |
|           5 |   355.60 |   315.91 | 是               |
|          10 |   364.49 |   334.31 | 是               |
|          20 |   364.48 |   339.29 | 是               |
|          50 |   361.76 |   339.47 | 是               |
|         100 |    43.51 |    21.48 | 是               |
|      103.98 |    27.50 |     5.51 | 是               |
|      105.20 |    22.75 |     0.77 | 否               |
|      105.51 |    20.92 |    -1.09 | 否               |

100 USDT 附近毛边突然从约 362 bps 掉到 44 bps，说明卖腿的厚 bid
已经吃完了。继续加到约 105 USDT，扣费后就没有利润。这就是“套多少
之后差价就没了”的直观答案。

### 6.3 INC 容量曲线

| 名义额 USDT | 毛边 bps | 净边 bps | 是否达到最低净边 |
| ----------: | -------: | -------: | ---------------- |
|           5 |    85.19 |    45.13 | 是               |
|          10 |    84.28 |    54.20 | 是               |
|          20 |    79.90 |    54.82 | 是               |
|          50 |    45.86 |    23.82 | 是               |
|       63.07 |    27.03 |     5.01 | 是               |
|       67.79 |    22.03 |     0.01 | 否               |
|       69.88 |    20.02 |    -2.00 | 否               |

INC 的容量比 TBK 小，但对 5 到 20 USDT 的小额批次已经很够用。
它也会出现 Gate 快照 stale 的轮次；stale 轮次不应下单。

## 7. 这些机会真实存在的前提

### 7.1 不是无库存原子套利

S1 是跨交易所两腿 taker。要抓 TBK 的 gateio -> hotcoin 方向，需要：

- Gate 有 USDT 可以买入 TBK。
- Hotcoin 预先有 TBK 可以卖出。

如果 Hotcoin 没有 TBK，就要先从 Gate 提币，转账时间和提币费会吃掉
这类小额机会，而且 bid 可能在你到账前消失。当前扫描只验证价格和深度，
没有验证两边的实际余额、提币状态和到账时间。

### 7.2 低流动性意味着容量小、消失快

- 可见深度之外没有流动性，隐藏单和冰山单不能假定存在。
- TBK 的厚 bid 只有约 100 USDT 的有效容量。
- Hotcoin 深度更新约 1 到 3 秒一次；Gate 低流动性 REST 偶尔滞后。
- 一次扫描只能证明“当时盘口存在”；实盘必须在下单前重新抓取并重新计算。

### 7.3 还需要人工检查

- 两边是否真的是同一个代币合约，而不是同名不同币。
- Hotcoin 和 Gate 的充提是否开启，网络是否一致。
- 市场是否处于异常状态、是否即将下架。
- 真实账户 taker/maker 费率、VIP 等级和返佣。
- 是否有足够的卖腿库存和买腿 USDT。

## 8. 当前分类规则

- clean：有 maxEligibleNotional，且没有 price_outlier、stale_book、
  one_sided_book、no_depth、min_notional_above_cap。
- review：有 maxEligibleNotional，但有 extreme_spread；需要人工复核，
  不能直接当成 clean。
- near_miss：扣费后曾大于 0，但没有达到 min_net_profit_bps。
- rejected：有价格异常、过期、单边盘口、深度或最小额硬阻断。
- no_edge：扣费前就已经不赚钱，或没有可执行深度。

TBK 属于 review，不是因为它不真实，而是 368 bps 的毛边本身需要人工
确认币种、充提和库存。HTX 属于 near_miss，因为最后一张快照的
maxEligible 为空，虽然毛边仍有约 34 bps。

## 9. 尚未完成

1. 真实账户费率：当前 10 bps/腿是占位值，必须用 Gate 账户页面和
   Hotcoin 账户页面确认。
2. 余额感知容量：现在只算市场深度，没有把 Hotcoin 的 TBK 库存和
   Gate 的 USDT 余额纳入 maxEligibleNotional。
3. WebSocket 持续确认：本次是 REST 快照加三次独立复核；TBK 在约 10 分钟后
   已经反转，说明必须对候选建立 WS 订阅和持续性统计。
4. 充提状态和代币合约核验：尚未接入逐币种充提、网络和合约地址检查。
5. 24 小时 soak 和真实 API key 私有接口验证：仍需要外部凭证。

## 10. 建议的下一步

优先级从高到低：

1. 用真实费率重跑本扫描，确认 TBK/INC/HTX 在真实费率下还剩多少。
2. 增加 balance-aware capacity：把卖腿库存和买腿 USDT 作为硬上限。
3. 对 clean/review 候选做 10 到 30 分钟 WS 持续采样，记录出现次数、
   持续时间、最大容量和消失速度。
4. 增加充提状态、网络、合约地址和 token 风险检查。
5. 只有在以上都通过后，才进入 20 个 paper batch 和小额手动实盘。

最终判断标准不是“毛边大”，而是：

- 扣真实费用后仍有正净边；
- 当前真实库存足够；
- 两腿盘口在确认窗口内仍然存在；
- 实际下单数量不超过容量曲线；
- 失败时能安全停止并记录未对冲库存。

两腿执行顺序、库存要求和“价差是否会回归”的完整说明见
`docs/s1-two-leg-execution-and-convergence.md`。短期存活时间可用
`npm run track:spread -- --base TBK --duration-ms 300000 --interval-ms 3000`
观察；它只描述历史持续性，不保证未来回归。
