# Gate.io + Hotcoin S1 集成记录（2026-10-27）

## 1. 结论

本轮完成了无 API key 阶段能完成的部分：

- Gate.io 使用 CCXT/CCXT Pro，Hotcoin 使用自定义 `CexAdapter`。
- Hotcoin 公开 REST 行情、gzip WebSocket 深度、ping/pong、服务器时间校正已实现并验证。
- Hotcoin 私有 REST（余额、下单、查单、撤单）已实现，但尚未用真实 key 验证。
- Gate.io 与 Hotcoin 统一通过 `createCexAdapter` 创建，避免某个脚本误走 CCXT。
- `config/live-test.toml` 已切到 Gate.io + Hotcoin，单批上限 20 USDT，Hotcoin 最小 sizing 15 USDT。
- readiness 已覆盖 Hotcoin 最小额、IOC/FOK 覆盖、场所执行门、WebSocket 必需性。
- 真实公开探测：Gate.io 2,181 个市场、Hotcoin 374 个市场，两个场所 REST/WS 均成功。
- 五轮零费率 smoke 产生 `gateio->hotcoin` 的 S1 记录，说明公开链路可用；这些记录不是扣费后的真实利润。

当前唯一 readiness 硬阻塞是缺少 `data/secrets.enc.json`。在提供真实 key 前不应开启 `live_enabled`。

## 2. 关键文件

| 文件                                         | 作用                                 |
| -------------------------------------------- | ------------------------------------ |
| `packages/venues/cex/src/hotcoin.ts`         | Hotcoin 自定义适配器                 |
| `packages/venues/cex/src/adapter-factory.ts` | 统一 `createCexAdapter` 路由         |
| `packages/venues/cex/src/fee-overrides.ts`   | 共享费率覆盖与 `data/fees.json` 合并 |
| `packages/venues/cex/src/catalog.ts`         | 将 Hotcoin 纳入 Tier S 目录          |
| `apps/scanner/src/main.ts`                   | Gate/Hotcoin 只读扫描                |
| `apps/executor/src/main.ts`                  | Gate/Hotcoin 执行与恢复              |
| `apps/executor/src/balance-cli.ts`           | Gate/Hotcoin 余额读取                |
| `scripts/live-readiness.ts`                  | 实盘就绪门槛                         |
| `scripts/smoke-s1.ts`                        | 公开行情 S1 链路验证                 |
| `config/live-test.toml`                      | 小额实盘配置                         |

## 3. Hotcoin 公开行情

### REST

- 市场发现：`GET /v1/common/symbols`
- 深度：`GET /v1/depth?symbol=<symbol>`
- 适配器只接受 `state=enable` 的市场。
- 使用 `pricePrecision` / `amountPrecision` 生成价格与数量步长。
- `minOrderAmount` 映射为 `minNotional`；目标交易对当前为 15 USDT。
- `minOrderCount` 映射为 `minAmount`（若大于 0）。

### WebSocket

- 地址：`wss://wss.hotcoinfin.com/trade/multiple`
- 订阅：`{"sub":"market.<symbol>.trade.depth"}`
- 数据为 gzip 压缩，适配器按 gzip magic 自动解压。
- 服务端心跳为 `{"ping": ...}`，客户端必须回复固定 `{"pong":"pong"}`。
- 适配器会读取服务端时间并校正本地与服务器的时间差。
- 首次连接/订阅需要数秒；稳定后 Hotcoin 深度约 1–3 秒推送一次。
- 断线、首包超时、协议错误都会让 `watchOrderBook` reject，由扫描器健康与重连逻辑处理。

## 4. Hotcoin 私有 REST

### 签名

签名格式：

```text
METHOD\nhost\npath\nsorted_query
```

- `METHOD` 为 `GET` 或 `POST`。
- `host` 固定为 `api.hotcoinfin.com`。
- `path` 为接口路径，例如 `/v1/order/place`。
- `sorted_query` 为包含 `AccessKeyId`、`SignatureMethod=HmacSHA256`、
  `SignatureVersion=2`、`Timestamp` 的参数按 key 排序后的 query。
- `Timestamp` 为 UTC ISO 字符串；适配器使用服务器时钟偏移校正。
- HMAC-SHA256 后 Base64。
- `XH-PASSPHRASE` 放在 HTTP header，不放进 query。
- POST 下单使用 query 参数，不依赖 JSON body；这与 Hotcoin 官方 `POST_SIGN_URL` 示例一致。

### 接口

| 操作          | 接口                                          |
| ------------- | --------------------------------------------- |
| 余额          | `GET /v3/balance`，失败回退 `GET /v1/balance` |
| 下单          | `POST /v1/order/place`                        |
| 订单详情      | `GET /v1/order/detailById?id=<id>`            |
| 当前/历史委托 | `GET /v1/order/entrust`                       |
| 撤单          | `POST /v1/order/cancel`                       |

### 余额规范化

- 优先读取 `free/available/normal` 作为可用。
- 优先读取 `total/balance` 作为总额。
- 优先读取 `frozen/locked/used` 作为冻结。
- 只给 `total + frozen` 时，可用 = total - frozen，总额 = total。
- 只给 `free + frozen` 时，总额 = free + frozen。
- 该逻辑避免把 `total` 误当成可用余额，防止超额下单。

### 订单

- `matchType=0`：限价 GTC。
- `matchType=1`：市价。
- `matchType=8`：FOK。
- `matchType=9`：IOC。
- 文档状态码：
  - `1` 未成交 → `open`
  - `2` 部分成交 → `open`
  - `3` 完全成交 → `closed`
  - `4` 撤单中 → `open`
  - `5` 已撤单 → `canceled`
  - `8` 部分成交后撤单 → `canceled`
- `fetchOrder` 支持 `venueOrderId`；也支持 `clientOrderId`，最多扫描 20 页、每页 100 条，找不到就 fail closed。
- `createOrder` 对 FOK/IOC 仍使用限价参数，价格来自扫描器的可执行价；不会用市价单绕过滑点保护。

## 5. 执行链路

- 扫描器只读加载市场、WS 盘口和费率覆盖，不创建订单。
- 执行器在 preflight 中重新加载两个场所市场，并应用 `[fees.*]` 与 `data/fees.json`。
- 买入腿与卖出腿都检查最小数量、最小名义额、价格/数量精度。
- 买入腿要求 `plannedQuote >= minNotional`；卖出腿要求实际可执行 quote >= minNotional。
- 任一腿低于最小额、精度不合法、盘口过期、余额不足、费率未配置，都会 fail closed。
- 第二腿使用第一腿实际成交量；部分成交、未知订单、撤单失败进入 `SAFE_STOP` 并记录未对冲库存。
- Hotcoin 的 `ioc` / `fok` 能力默认关闭，必须在真实 key 实测后再写入 `ioc_venues` / `fok_venues`。

## 6. 公开验证结果

### 探测

命令：

```powershell
$env:ARB_SOCKS_PROXY='socks5://127.0.0.1:10808'
npx tsx scripts/probe-venues.ts --venues gateio,hotcoin --pair BTC/USDT --timeout-ms 30000
```

结果：

- Gate.io：REST 成功，2,181 个市场，BTC/USDT 盘口成功，WS 成功。
- Hotcoin：REST 成功，374 个市场，BTC/USDT 盘口成功，WS 成功。
- Gate.io 的 WS 首包包含 CCXT Pro 初始化时间，约 20 秒；Hotcoin 首包约 2.6 秒。
- 探测输出：`data/venue-probe-hotcoin.json`。

### 五轮 smoke

命令：

```powershell
$env:ARB_CONFIG='config/live-test.toml'
$env:ARB_SOCKS_PROXY='socks5://127.0.0.1:10808'
npm run smoke:s1 -- --venues gateio,hotcoin --bases CAKE,ETH,BTC --notional 20 --cycles 5 --warmup-ms 10000 --max-feed-latency-ms 3000 --taker-bps 0 --min-net-profit-bps 0 --min-profit-usd 0 --safety-buffer-bps 0 --min-sizing-notional 15
```

结果：

- 两个场所健康状态均为 A。
- 初始全量扫描与后续 hot scan 均运行。
- 产生 `gateio->hotcoin` 的 S1 记录，零费率下净收益约 0.3–1.2 bps。
- 这证明公开数据、归一化、深度 sizing 和 S1 持久化链路可用。
- 真实费率约为 10 bps/腿时，这些记录会全部被拒绝；不能用零费率 smoke 判断盈利。

### 保守费率 smoke

用 10 bps/腿的占位费率、5 bps 最低净收益、2 bps 安全缓冲跑 3 轮：

```powershell
$env:ARB_CONFIG='config/live-test.toml'
$env:ARB_SOCKS_PROXY='socks5://127.0.0.1:10808'
npx tsx scripts/smoke-s1.ts --venues gateio,hotcoin --bases CAKE,ETH,BTC --notional 20 --cycles 3 --warmup-ms 10000 --interval-ms 3000 --taker-bps 10 --maker-bps 2 --min-net-profit-bps 5 --min-profit-usd 0.01 --safety-buffer-bps 2 --min-sizing-notional 15
```

结果：

- `validS1Rows: []`
- `rejectionCounts`: `gross_profit_below_threshold=10`、`invalid_orderbook=2`、`stale_orderbook=2`
- 两个场所健康状态仍为 A。

这说明当前短窗口内没有扣费后的可执行 S1；零费率结果不能当作机会。真实费率确认后需要重新做更长窗口的只读 soak。

### readiness

命令：

```powershell
$env:ARB_CONFIG='config/live-test.toml'
$env:ARB_SOCKS_PROXY='socks5://127.0.0.1:10808'
npm run live:readiness
```

结果：

- `liveTestReady: false`
- 唯一 block：`secrets.store`
- `network.venues`: `2/2 REST ok, 2/2 WS ok`
- `sizing.hotcoin_min_notional`: pass（15 / 20）
- `sizing.min_profit_vs_notional`: pass（5.00bps）
- 输出：`data/live-readiness-hotcoin.json`

## 7. API key 阶段测试矩阵

以下项目必须在真实 key 下逐项完成，不能只靠 mock 测试。

### 7.1 凭证与余额

1. Gate.io read_only key：`npm run executor:balances` 能读出 USDT 与目标币。
2. Hotcoin read_only key：优先 `/v3/balance` 成功；若失败，确认 `/v1/balance` 可用。
3. 核对 Hotcoin 的 `free/used/total` 与网页余额一致，尤其是冻结余额。
4. 确认两条 trade key 都没有提现权限，且 IP 白名单已生效。

### 7.2 费率

1. 在 Gate.io 后台确认实际 taker/maker。
2. 在 Hotcoin 后台确认实际 taker/maker。
3. 写入 `[fees.gateio]` 与 `[fees.hotcoin]`。
4. 重新跑 readiness，确认 `fees.taker_overrides` 通过。
5. 不要依赖 `fees:fetch` 获取 Hotcoin 费率；当前官方 SDK 未提供已验证接口。

### 7.3 FOK / IOC

1. 用最小 15 USDT 名义额、远离盘口的限价单验证 FOK：应完全成交或完全拒绝，不能部分成交后留在市场。
2. 用 IOC 验证：允许部分成交，剩余立即撤销。
3. 验证 `matchType=8` 与 `matchType=9` 的请求参数。
4. 验证 `fetchOrder` 的状态码 1/2/3/4/5/8 与本地状态映射。
5. 验证取消订单后最终状态和剩余数量。
6. 验证 `clientOrderId` 在超过 100 条委托时仍能分页找到。
7. 通过后再把场所写入 `ioc_venues` / `fok_venues`。

### 7.4 最小额与精度

1. Hotcoin 15 USDT 最小名义额：确认 14.99 被拒绝、15.00 可下单。
2. 确认价格精度与数量精度向下取整不会导致第二腿低于 15 USDT。
3. 确认 Gate.io 与 Hotcoin 的 `amountStep`、`priceStep`、`minAmount`、`minNotional` 与交易所页面一致。
4. 确认 20 USDT 上限下仍能生成至少 15 USDT 的第二腿。

### 7.5 执行安全

1. 只读预演：`npm run executor -- --opportunity <ID>` 不提交订单。
2. 模拟/纸面验证第一腿部分成交、第二腿失败、未知订单、重启恢复。
3. 第一条真实批次前，确认 kill switch、手动确认、单批限制、日亏限制全部生效。
4. 第一条真实批次使用 15–20 USDT，只开一个批次，人工盯盘。
5. 记录实际成交价、手续费、滑点、净利、库存漂移。
6. 出现未知订单、余额不一致、权限变化、行情过期、时钟漂移，立即停止。

## 8. 已知限制

- Hotcoin 没有已验证的账户费率查询接口，费率必须手工维护。
- Hotcoin 没有 sandbox；不要尝试用 `sandbox` 模式。
- Hotcoin 深度推送约 1–3 秒一次，明显慢于 Gate.io；live-test 使用
  `max_feed_latency_ms=3000`、`ws_max_book_age_ms=3000`、`max_pair_skew_ms=2500` 作为当前折中。
- Gate.io 的 CCXT Pro 首次 WS 初始化可能很慢，readiness 使用 30 秒超时。
- Hotcoin 私有接口、FOK/IOC、订单状态、余额字段仍需真实 key 验证。
- 当前只验证 S1；S2/S3/BSC 不在本轮实盘范围。
- 没有真实费率时，零费率 smoke 的正收益不代表可执行机会。

## 9. 下一步

1. 用户提供 Gate.io 与 Hotcoin 的 read_only/trade key，禁止提现并开启 IP 白名单。
2. 写入加密凭证库，只输出指纹。
3. 完成第 7 节测试矩阵。
4. 写入真实费率与已验证的 IOC/FOK 场所。
5. 重新跑 readiness，直到 `liveTestReady: true`。
6. 先做只读预演和 20 个 paper batch，再做第一条 15–20 USDT 手动实盘批次。
