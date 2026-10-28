# 小额实盘测试 Runbook（S1 手动批次）

目标：用最小资金验证“扫描 → 就绪检查 → 只读预演 → 手动确认下单 → 双腿对账”的完整链路。当前只做 S1，只开 Gate.io 与 Hotcoin，单批名义额上限 20 USDT。

## 0. 当前状态（2026-10-28）

- `config/live-test.toml`：`enabled_venues=['gateio','hotcoin']`、`max_order_notional=20`、`min_sizing_notional=15`、`min_profit_usd=0.01`、`feed_mode='websocket'`。
- 行情门槛：`max_feed_latency_ms=3000`、`ws_max_book_age_ms=3000`、`max_pair_skew_ms=2500`。Gate.io 经代理的 WS feed latency 可能接近 2.5 秒，不能沿用 500ms 门槛。
- 默认安全状态：`live_enabled=false`、`kill_switch=true`、`leg_mode='serial'`、`ioc_venues=[]`、`fok_venues=['gateio','hotcoin']`、`manual_confirmation=true`。
- 公开链路已验证：Gate.io 与 Hotcoin 的 REST、WS 均可通过 `socks5://127.0.0.1:10808` 连接；Hotcoin 深度 WS 为 gzip 推送，约 1–3 秒更新一次。
- 私有链路已部分验证：真实余额、Gate FOK 未成交、Hotcoin FOK/IOC 零成交已实测；成交腿与卖出腿仍未验证。详见 `docs/fok-private-probe-2026-10-28.md`。
- Hotcoin 最小名义额按交易对返回；TBK/USDT 当前为 0，其他币对可能为 15。扫描器 sizing 与执行器 preflight 都必须按实际 market.minNotional 校验。
- 当前没有真实 API key 时，`npm run live:readiness` 会因为 `secrets.store` 缺失而 block；这是预期行为，不是代码故障。
- 只读机会发现使用独立配置 `config/discovery.toml`：成交量前 30、最低 100,000 USD 24h
  quote volume、10 bps/腿占位费率。它不会打开实盘，也不代表真实费率。

## 1. 前提

1. Windows 时钟已同步。Hotcoin 签名使用 UTC 时间，偏差过大会直接认证失败。
2. 代理可用：`ARB_SOCKS_PROXY=socks5://127.0.0.1:10808`。
3. 为 Gate.io 和 Hotcoin 各准备两条 key：
   - `read_only`：只读余额，供 `executor:balances` 与扫描器余额门槛使用；
   - `trade`：读取 + 下单 + 查单 + 撤单；
   - 禁止提现/转账；
   - 开启 IP 白名单，填入代理出口 IP。
4. Hotcoin key 的 passphrase 必须与创建 key 时一致，写入凭证的 `password` 字段。
   Hotcoin 的 read_only 适配器不执行查单/撤单；恢复与对账使用 trade 凭证。

## 2. 写入真实费率

费率有两种数值，不能混用：

- `taker_bps` / `maker_bps`：交易所返回的**毛费率**；
- `rebate_pct`：现货返佣百分比，程序在覆盖逐币种费率后统一折算。

当前 `config/live-test.toml`：

```toml
[fees.gateio]
taker_bps = 9.9
maker_bps = 9.9
rebate_pct = 70

[fees.hotcoin]
taker_bps = 20
maker_bps = 20
rebate_pct = 80
```

说明：

- 有效费率 = `毛费率 × (1 - rebate_pct / 100)`。以上配置的有效成本为
  Gate.io `2.97 bps/腿`、Hotcoin `4 bps/腿`。
- 负数 `maker_bps` 表示交易所向 maker 付费；返佣仍按同一公式折算。
- Gate.io 的毛费率来自认证后的个人费率接口；Hotcoin 的 VIP0 毛费率来自官方
  费率页和 `/hk-web/vip/level-fee-rate`，私有 API 仍没有账户费率查询接口。
- `data/fees.json` 可由 `npm run fees:fetch` 生成，保存的是毛费率；Hotcoin 会被跳过。
  返佣在读取后统一应用，因此重新拉取不会丢失返佣。
- 当 `live_enabled=true` 且任一启用场所缺少 taker 费率时，readiness 会 block；`live_enabled=false` 时只是 warn。
- 来源、公式与首笔成交后的复核步骤见 `docs/fee-rate-sources-2026-10-28.md`。

## 3. 写入加密凭证

准备 `secrets.json`，内容是 JSON 数组。Gate.io 示例：

```json
{
  "venueId": "gateio",
  "role": "trade",
  "withdrawalPermission": false,
  "apiKey": "...",
  "secret": "...",
  "ipWhitelistVerified": true
}
```

Hotcoin 示例（passphrase 必填）：

```json
{
  "venueId": "hotcoin",
  "role": "trade",
  "withdrawalPermission": false,
  "apiKey": "...",
  "secret": "...",
  "password": "...",
  "ipWhitelistVerified": true
}
```

每个场所再准备一条 `role: "read_only"` 记录，然后执行：

```powershell
$env:ARB_SECRET_STORE_KEY = '<至少16位主密钥>'
Get-Content secrets.json -Raw | npm run executor:secrets
```

命令只输出指纹，不输出密钥。确认 `withdrawalPermission=false`，并在交易所后台再次确认没有提现权限。

## 4. 刷新余额

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor:balances
```

必须看到 Gate.io 与 Hotcoin 的 USDT 余额。Hotcoin 优先调用 `/v3/balance`，失败时回退 `/v1/balance`；余额字段会按 `free/used/total` 规范化。

## 5. 就绪检查（有 key 后必须通过）

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run live:readiness
```

必须满足：

- `liveTestReady: true` 且退出码为 0；
- `network.venues` 同时满足 REST 与 WS 成功（`feed_mode=websocket` 时 WS 失败会 block）；
- 若使用 `config/discovery.toml`（`asset_universe_mode=top_volume`），`network.venues`
  还必须显示 `2/2 tickers ok`；
- `sizing.hotcoin_min_notional` 通过：`min_sizing_notional>0` 且不大于 `max_order_notional`；单币最小额由执行器按实时 market.minNotional 预检。
- `fees.taker_overrides` 通过；
- `secrets.trade_coverage` 覆盖 Gate.io 与 Hotcoin；
- `secrets.read_only_coverage` 覆盖 Gate.io 与 Hotcoin（扫描器需要只读余额）；
- `secrets.hotcoin_passphrase` 覆盖 Hotcoin 的 read_only 与 trade 凭证；
- `database.open_executions` 没有未对账执行；
- `execution.ioc_fok_venues` 在 API key 实测完成前允许 warn；`live_enabled=true` 时会 block。
- 若显式切换到 `leg_mode='parallel_fok'`，`execution.parallel_fok_venues` 要求两个场所都已写入 `fok_venues`；真实 API 验证前不得切换。

## 6. 公开行情 smoke（不需要 key）

这个命令只验证 Gate + Hotcoin 的公开扫描链路，不证明真实盈利。为了看到链路结果，可临时把费用和利润阈值设为 0：

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run smoke:s1 -- --venues gateio,hotcoin --bases CAKE,ETH,BTC --notional 20 --cycles 5 --warmup-ms 10000 --max-feed-latency-ms 3000 --taker-bps 0 --min-net-profit-bps 0 --min-profit-usd 0 --safety-buffer-bps 0 --min-sizing-notional 15
```

观察：

- `health` 中两个场所都应为 A 或至少 B；
- `validS1Rows` 若出现，方向应为 `gateio->hotcoin` 或 `hotcoin->gateio`；
- 结果只用于验证数据链路。真实费率下的净机会必须重新扫描，不能把零费率结果当成可执行利润。

### 成交量排序发现（只读）

```powershell
$env:ARB_CONFIG = 'config/discovery.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run smoke:discovery
```

关注 `topGrossRows` 和 `topNetRows`，不要只看 `validS1Rows`。2026-10-27 的短窗口
结果是：扩到 30 个 base 后最佳毛边约 2.00 bps，扣 10 bps/腿后最佳净边约 -22.46 bps，
因此没有可执行 S1。详细说明见 `docs/s1-opportunity-discovery.md`。

## 7. 启动扫描器（只读）

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run scanner
```

扫描器把 S1 机会写入 `data/live-test.sqlite`，不产生任何订单。确认 `live_enabled=false` 与 `kill_switch=true`。
若只想扩大搜索面，改用 `ARB_CONFIG=config/discovery.toml`，数据库为
`data/discovery.sqlite`。

## 8. 只读执行预演

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor -- --opportunity <机会ID>
```

默认只读：加载最新有效 S1、检查凭证与恢复状态、打印精确的批次确认字符串，不提交订单。

## 9. 手动实盘（确认后才执行）

只有以下条件全部满足后才允许：

1. readiness 全部通过；
2. `executor:balances` 能看到两个场所余额；
3. Gate.io 与 Hotcoin 的 FOK 零成交路径已经实测并写入 `fok_venues`；成交腿、卖出腿和对账仍需单独验证；
4. 已完成只读预演与至少一条公开行情 smoke；
5. 操作者明确知道该机会的真实费率与库存风险。

将 `config/live-test.toml` 改为：

```toml
[execution]
live_enabled = true
kill_switch = false
manual_confirmation = true
max_open_batches = 1
```

然后：

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor -- --opportunity <机会ID> --confirm-batch <批次ID> --execute
```

`--execute` 还要求：`live_enabled=true`、kill switch 已释放、启动恢复无未对账执行、`--confirm-batch` 与批次号完全一致。

## 10. 限额与停止条件

- 单批 notional ≤ 20 USDT，并发批次 = 1，日亏上限 5 USDT，必须手动确认。
- 每日最多 5 批目前是操作纪律，由人工计数；执行器还没有自动按日批次数硬限制。
- Hotcoin 单笔最小名义额按交易对不同；执行器按实时 market.minNotional 拦截，不得用统一 15 USDT 假设。
- 出现以下任一情况立即停止：未知订单无法对账、余额不一致、交易所回报本地不存在的订单、API 权限变化、检测到提现权限、行情持续过期、时钟漂移、同一场所重复下单失败、BSC 模拟与报价明显不符。

## 11. 测试期记录

每批记录：机会 ID、批次 ID、方向、实际成交价、手续费、滑点、净利、库存漂移、是否触发安全停止。

达到 10 批手动实盘且 ≥80% 双腿完全对账后，再考虑进入自动化阶段（见 `docs/live-rollout-plan.md`）。
