# 主流 CEX/DEX 扩展（2026-10-22）

## 1. 已加入的交易所

`VENUE_CATALOG` 现在包含 42 个场所，其中 37 个 spot 场所进入默认扫描列表：

- CEX spot：gateio、mexc、weex、binance、okx、bybit、bitget、kucoin、htx、bitrue、lbank、xt、coinbase、kraken、cryptocom、woo、backpack、poloniex、bingx、phemex、whitebit、upbit、bitstamp、gemini、bitfinex、blockchaincom、bigone、hitbtc、btse、cex、digifinex、p2b、deepcoin、hashkey。
- DEX spot：hyperliquid、lighter、aster。
- DEX perp 参考（不进入 S1）：dydx、paradex、extended、apex、derive。

每个场所有 `kind`、`marketType`、`tier`、`ccxtId`、`s1Eligible` 元数据。`createCcxtAdapter` 按目录自动选择 CCXT id、tier 与 `defaultType`。

## 2. 连通性探测（SOCKS5 127.0.0.1:10808）

`npm run probe:venues -- --timeout-ms 12000 --pair BTC/USDT` 的真实结果：

- REST：21/21 可用。
- WebSocket：17/21 可用；bitrue、xt、cryptocom、woo 的 WS 在当前代理下不可用，自动回退 REST。
- DEX：hyperliquid 304 个 spot 市场、lighter 11 个、aster 75 个，REST 与 WS 均可用。
- 主要市场数：bitget 3590、gateio 2180、weex 2340、mexc 1796、bitrue 1629、binance 1387、kraken 1366、lbank 1366、backpack 1244、okx 1183、kucoin 968、coinbase 917、poloniex 829、htx 601、cryptocom 566、bybit 527、xt 483、woo 87。
- 第二批新增场所（单独探测）：bingx spot 2292（USDT 2241）、phemex spot 1019（USDT 976）、whitebit spot 799（USDT 328、USDC 143）、bitstamp spot 256、gemini spot 332（USDC 78）、upbit spot 876（USDT 246），REST 盘口均可用；bithumb 仅有 KRW，未加入。
- 第三批新增场所（适配器实测）：bitfinex 194（USDT 67，REST+WS 可用，深度只接受 25/100）、blockchaincom 60（USDT 45，REST+WS 可用）、bigone 918（USDT 905，REST 可用，无 ccxt.pro WS）。bitmart/coinex/ascendex 在 ccxt 4.5.88 中不存在，未加入。
- 第四批新增场所（REST 盘口实测）：hitbtc 1161（USDT 756，REST+WS）、btse 1084（USDT 290，REST）、cex 797（USDT 255，REST+WS）、digifinex 189（USDT 171，REST）、p2b 172（USDT 113，REST+WS）、deepcoin 170（USDT 170，REST+WS）、hashkey 31（USDT 31，REST+WS）。latoken/bullish 连接超时，bitvavo 无 USDT，未加入。

## 3. 兼容性修复

- 盘口深度归一化：KuCoin 只接受 20/100；Kraken 接受 10/25/100/500/1000；Bybit WS 接受 1/50/200/1000。适配器会按交易所自动取合法值。
- 时间戳归一化：自动识别秒、毫秒、微秒、纳秒，避免 Woo/Poloniex/Coinbase 出现数小时甚至数天的虚假 feed latency。
- WS 重连上限：`ws_max_reconnect_attempts` 默认 5，失败交易所停止重试并回退 REST，避免无限重连。
- 默认并发提升到 16，盘口深度降到 20，适配多交易所扫描。
- 多所订阅裁剪：`syncSubscriptions` 只订阅“同一 base/quote 至少出现在两个场所”的币种，并按 venue tier 排序、`ws_max_subscriptions` 全局限额；`activeUniverse` 在 WS 模式下对未订阅币种每所每轮只做 `ws_rest_fallback_per_venue` 个轮换 REST 回退，避免为不可能形成 S1 的币种建立海量订阅或全量 REST 轮询。
- 评估时点：S1 逐 base 取 `now`，并在 WS 模式下跳过前置 REST 预取，消除“先取完全部盘口再统一评估”导致的假 stale。

## 4. 测试

- `packages/venues/cex/tests/catalog.test.ts`：目录完整性、spot/perp 标记、32 个适配器无网络构造。
- `packages/venues/cex/tests/ccxt-adapter.test.ts`：时间戳多量级归一化。
- `apps/scanner/tests/scanner-ws.test.ts`：新增“只订阅至少两个场所共享的 base”用例。
- 8 所主流所 + 4 个主流币冒烟：每轮 32 本 WS 盘口、0 stale；中市值 16 币研究模式出现 15 条有效 S1。
- `npm run check` 通过：42 个测试文件 / 227 个测试 + 20 批回测。
- 覆盖率：81.00% statements / 72.39% branches / 79.22% functions / 85.01% lines。

## 5. 复现

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run probe:venues -- --timeout-ms 12000 --pair BTC/USDT
npm run smoke:s1 -- --venues binance,okx,bybit,bitget,gateio,mexc,weex,kucoin --bases BTC,ETH,SOL,DOGE --quotes USDT --cycles 12 --interval-ms 2000 --warmup-ms 20000
```

## 6. 限制

- 37 家同时做全量 REST 扫描仍然很重；默认已按共享币种裁剪 WS 订阅、按 tier 排序、限制每所 REST 回退数量，并把场所发现改为并发（启动从数分钟降到约半分钟）。
- DEX spot 多为 USDC 计价；S1 的 USDC 路线可用，但跨 USDT/USDC 的转换属于多跳策略，不在 S1 范围。
- bitrue、xt、cryptocom、woo 的 WS 在当前代理下不可用，只有 REST 行情。

## 7. 多所 S1 实测（2026-10-22）

详见 `docs/s1-multivenue-findings-2026-10-22.md`。核心结论：

- 8 所主流所（binance、okx、bybit、bitget、gateio、mexc、weex、kucoin）扫描 4 个主流币，每轮 32 本 WS 盘口，**0 stale、0 invalid**，验证了订阅裁剪与评估时点修复。
- 10bps 双边 taker 下主流币结构性无机会（0 valid），与费率结论一致。
- 把 taker 设为 2bps、`min_profit_usd` 降到 0.01、notional 提到 500 后，16 个中市值币在 20 轮内出现 **15 条有效 S1**，例如 `bitget->mexc` 1.68bps @ $500、`okx->mexc` 1.52bps @ $414、`weex->mexc` 1.45bps @ $500。说明发现引擎能抓到真实价差，但净利对费率和可成交深度高度敏感。
