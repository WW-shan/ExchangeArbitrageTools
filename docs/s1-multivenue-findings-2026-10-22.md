# 多所 S1 实测与发现优化（2026-10-22）

环境：Windows、`ARB_SOCKS_PROXY=socks5://127.0.0.1:10808`、`ccxt 4.5.88`、`ccxt.pro`。
范围：仅 S1（跨所现货、同 base/quote、两腿、双向）。

## 1. 本轮代码改动

- 目录扩展到 32 个场所（24 CEX spot + 3 DEX spot + 5 perp 参考），默认启用 27 个 spot 场所。
- `syncSubscriptions` 改为只订阅“至少两个场所有同 base/quote”的币种，按 tier 排序并受 `ws_max_subscriptions` 全局限额。
- `activeUniverse` 在 WS 模式下：已订阅币种全部参与；未订阅币种每所每轮只取 `ws_rest_fallback_per_venue`（默认 8）个轮换 REST 回退。
- WS 模式跳过 `prefetchBooks`；S1 按 base 分组后并发抓取该 base 的盘口并立即评估，消除“先串行抓完全部盘口再统一评估”造成的假 stale。
- `smoke-s1` 支持 `--quotes`、`--taker-bps`、`--maker-bps`、`--min-net-profit-bps`、`--safety-buffer-bps`、`--min-profit-usd`，便于研究模式。

## 2. 主流 8 所 + 主流 4 币（默认 10bps）

命令：`--venues binance,okx,bybit,bitget,gateio,mexc,weex,kucoin --bases BTC,ETH,SOL,DOGE --cycles 12`。

- 每轮 32 本盘口，全部来自 WS；`errors` 2-4，`rejectionCounts` 仅 `gross_profit_below_threshold`。
- `validOpportunities = 0`：10bps 双边 taker（20bps）+ 15bps safety + 20bps minNet 结构性无机会。
- 健康度：8 所均 A；feed latency p95 多在 60-4600ms，`staleFeedRate=0`。

## 3. 16 个中市值币（2bps 研究模式）

命令：`--venues weex,mexc,gateio,bitget,okx,binance --bases INJ,APT,ARB,OP,SUI,SEI,TIA,WLD,PEPE,SHIB,FET,RNDR,NEAR,LDO,CRV,AAVE --cycles 20 --notional 500 --taker-bps 2 --maker-bps 0 --min-net-profit-bps 0 --safety-buffer-bps 0 --min-profit-usd 0.01`。

- 每轮 91 本盘口，`errors` 0-1，`staleFeedRate=0`，无 `stale_orderbook`/`invalid_orderbook` 拒绝。
- 20 轮内出现 **15 条有效 S1**（`validOpportunities` 每轮 0-9 条）。
- 代表样本：
  - `bitget->mexc` 1.68bps，可下 $500
  - `okx->mexc` 1.52bps，可下 $414
  - `weex->mexc` 1.45bps，可下 $500
  - `weex->binance` 1.34bps，可下 $500
  - `weex->gateio` 1.32bps，可下 $463
- 方向集中：mexc 常作为卖出腿，weex/gateio/bitget 常作为买入腿。

## 4. 结论

- 发现引擎在合理费率下能抓到真实跨所价差，不是只有测试和风控。
- 净利对费率极敏感：同样的盘口，10bps 双边 taker 归零，2bps 才出现 1-2bps 净利。
- 可成交深度是第二约束：$30 notional 下 `min_profit_usd=0.25` 相当于 8.3bps 门槛，会掩盖所有小价差；研究时必须同时放宽 notional 与 `min_profit_usd`。
- 下一步若要实盘：必须先确认真实 VIP/maker 费率与目标币种的真实盘口深度，否则 1-2bps 的纸面机会会被手续费吃掉。

## 5. 全量 spot 场所

命令：`--venues` 取 `config/default.toml` 的 27 个 spot 场所，`--cycles 3`。

- 27/27 场所市场发现成功，无崩溃：gateio 2180、mexc 1796、weex 2340、binance 1387、okx 1184、bybit 527、bitget 3590、kucoin 968、htx 601、bitrue 1629、lbank 1368、xt 483、coinbase 917、kraken 1366、cryptocom 566、woo 87、backpack 1244、poloniex 830、bingx 613、phemex 176、whitebit 799、upbit 876、bitstamp 255、gemini 332、hyperliquid 304、lighter 11、aster 75。
- 每轮 91 本盘口；`rejectionCounts`：`gross_profit_below_threshold` 924、`price_outlier` 38、`pair_skew_too_high` 30、`invalid_orderbook` 8、`stale_orderbook` 8（约 0.5%）。相比优化前的 914 条 stale，按 base 并发抓取把假 stale 基本消除。
- `woo` 的 REST 盘口时间戳实测落后 9 分钟（BTC）到 5.3 小时（SOL），属于交易所侧延迟缓存；系统按 fail-closed 正确拒绝，不应当作可用实时源。
- 追加 bitfinex/blockchaincom/bigone 后 30/30 场所发现成功；BTC/ETH 2 币每轮 54 本盘口，`stale_orderbook` 18/1250（约 1.4%），`fee_not_configured` 66 表示部分场所无 CCXT 费率信息，按 fail-closed 拒绝（与 live-readiness 的费率告警一致）。
- 再追加 hitbtc/btse/cex/digifinex/p2b/deepcoin/hashkey 后 **37/37 场所发现成功**（并发发现，约 28 秒含 10 秒预热）；BTC 单币每轮 33 本盘口，`stale_orderbook` 60/930（约 6.5%，主要来自 REST-only 小所），`fee_not_configured` 174。全部无崩溃，修复了 `cex` 关闭时的 `ExchangeClosedByUser` 未捕获异常。

## 6. DEX spot（USDC 计价）

- `hyperliquid`：304 个 spot 市场，`BTC/USDC` REST+WS 正常；8 所 USDC 冒烟中每轮 24 本盘口、0 stale，`hyperliquid` 健康度 A、feed latency p95 约 528ms。
- `lighter`：仅 11 个 spot 市场（无 BTC/USDC，首市场 UNI/USDC），可用但覆盖很窄。
- `aster`：75 个市场但多为测试/小众币，`BTC/USDC` 不存在且 WS 超时，当前不具备 S1 价值。
- USDC 路线 12 轮内 0 有效 S1，`pair_skew_too_high` 140，说明 DEX 与 CEX 的时间戳/更新节奏差异较大，跨 DEX-CEX 的 S1 需要更严格的对齐或更长寿命机会。
