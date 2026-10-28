# 实盘前就绪门槛（Live Readiness Gate）

## 1. 运行

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run live:readiness
```

- 输出 `liveTestReady: true` 且退出码为 0 才表示门槛通过。
- 只读网络探测可用 `--venues gateio,hotcoin --timeout-ms 30000` 限制范围，或 `--skip-network` 跳过。
- 探测结果写入 `data/live-readiness.json`，可用 `--out` 指定其他路径。
- 小额实盘完整步骤见 `docs/live-test-runbook.md`。

## 2. 检查项

| 检查项                           | 级别       | 含义                                                                                                                                                   |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execution.safety_bounds`        | block      | `max_open_batches=1`、`manual_confirmation=true`、`max_order_notional<=30`、`daily_max_loss<=20`                                                       |
| `execution.live_enabled`         | warn       | 实盘开关应保持 false，直到人工开启                                                                                                                     |
| `execution.kill_switch`          | pass/warn  | 应保持 true                                                                                                                                            |
| `fees.taker_overrides`           | warn/block | 每个启用场所是否有显式 taker 费率；`live_enabled=true` 时缺失会 block                                                                                  |
| `sizing.min_profit_vs_notional`  | warn       | `min_profit_usd / max_order_notional` 的隐含 bps 门槛，过高会遮蔽小价差                                                                                |
| `sizing.hotcoin_min_notional`    | block      | Hotcoin 启用时，`min_sizing_notional` 必须大于 0 且不大于 `max_order_notional`；单币最小额由执行器按实时 `market.minNotional` 预检，不统一假定 15 USDT |
| `execution.ioc_fok_venues`       | warn/block | 每个启用场所是否有已验证的 IOC/FOK；`live_enabled=true` 时缺失会 block                                                                                 |
| `execution.parallel_fok_venues`  | warn/block | 仅 `leg_mode='parallel_fok'` 时检查；每个启用场所都必须已验证 FOK，实盘开启时缺失会 block                                                              |
| `network.proxy`                  | warn       | 是否配置代理                                                                                                                                           |
| `database.integrity`             | block      | SQLite `integrity_check` 必须为 ok                                                                                                                     |
| `database.open_executions`       | block      | 不能有未对账的 open execution / unresolved order                                                                                                       |
| `database.persisted_kill_switch` | pass/warn  | 持久化 kill switch 状态                                                                                                                                |
| `database.persisted_live`        | pass/warn  | 持久化 live 开关状态                                                                                                                                   |
| `execution.venue_gates`          | warn/block | 每个启用场所是否已在数据库中打开 `execution_enabled`                                                                                                   |
| `secrets.store`                  | block      | 加密凭证库存在且可解密                                                                                                                                 |
| `secrets.master_key`             | block      | 主密钥存在                                                                                                                                             |
| `secrets.trade_coverage`         | block      | 每个启用场所都有 trade 凭证                                                                                                                            |
| `secrets.read_only_coverage`     | warn/block | `require_balances_for_s1=true` 时，每个启用场所都需要 read_only 凭证供余额刷新                                                                         |
| `secrets.hotcoin_passphrase`     | warn/block | Hotcoin 凭证是否包含 passphrase；`live_enabled=true` 时缺失会 block                                                                                    |
| `secrets.ip_whitelist`           | warn       | trade key 是否标记 `ipWhitelistVerified`                                                                                                               |
| `network.venues`                 | block      | 每个启用场所 REST 必须成功；`feed_mode=websocket` 时 WS 必须成功；`asset_universe_mode=top_volume` 时 ticker 必须成功                                  |
| `bsc.quote_keys`                 | block      | 启用 BSC 时 0x/1inch key 是否存在                                                                                                                      |

## 3. 当前状态（2026-10-27，无 API key）

实际运行结果：

- `liveTestReady: false`
- block：`secrets.store`（`data/secrets.enc.json` 不存在）
- warn：`fees.taker_overrides`、`execution.ioc_fok_venues`、`database.persisted_kill_switch`、`execution.venue_gates`
- pass：安全边界、live 开关、kill switch、`sizing.hotcoin_min_notional`、代理、数据库完整性、无未对账执行、`network.venues`（Gate.io 与 Hotcoin 均 2/2 REST/WS 成功；`config/discovery.toml` 下另为 2/2 tickers 成功）、BSC 未启用
- `sizing.min_profit_vs_notional`：`0.01 / 20 = 5.00bps`
- 输出文件：`data/live-readiness-hotcoin.json`

这说明无 key 阶段的公开链路和配置门槛已通过；唯一硬阻塞是缺少加密凭证库。

## 4. 操作员待办

1. 为 Gate.io 和 Hotcoin 创建 trade key（禁用提现、开启 IP 白名单）与 read_only key。
2. 用 `npm run executor:secrets` 写入加密凭证库，确认只输出指纹。
3. 在 `config/live-test.toml` 的 `[fees.gateio]` 与 `[fees.hotcoin]` 写入真实 taker/maker 费率。
4. 运行 `npm run executor:balances`，确认两个场所余额可读。
5. Gate.io 与 Hotcoin 的 FOK 零成交路径已实测，`fok_venues` 已写入；成交腿和卖出腿验证后再考虑启用 IOC。
6. 在数据库中显式打开场所执行门：

```powershell
npm run executor:venue -- --enable gateio
npm run executor:venue -- --enable hotcoin
```

7. 反复运行 `npm run live:readiness`，直到 `liveTestReady: true`。
8. 人工确认后再把 `execution.live_enabled` 置为 true，并按 `docs/live-rollout-plan.md` 推进小额手动批次。

## 5. 实盘测试前仍缺的外部条件

- 真实 VIP/maker 费率与返佣。
- 可交易、无提现权限的 API key（含 IP 白名单）。
- Gate.io 与 Hotcoin 的 FOK 成交订单状态映射、卖出腿对账和 clientOrderId 成交回查。
- 目标币种的真实盘口深度、成交概率和库存再平衡成本。
- 若启用 BSC：0x/1inch key、钱包余额、swap 模拟与手动确认。
