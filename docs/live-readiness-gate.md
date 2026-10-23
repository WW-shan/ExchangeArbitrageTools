# 实盘前就绪门槛（Live Readiness Gate）

本文定义“可以开始实盘测试”的可验证条件，并提供只读检查工具 `npm run live:readiness`。工具不会签名、不会下单、不会广播。

## 1. 一键检查

```powershell
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<至少16位主密钥>'
npm run live:readiness
```

- 输出 `liveTestReady: true` 且退出码 0 才表示门槛通过。
- 只读网络探测可用 `--venues binance,okx,gateio --timeout-ms 12000` 限制范围，或 `--skip-network` 跳过。
- 探测结果写入 `data/live-readiness.json`。
- 小额实盘可用 `ARB_CONFIG=config/live-test.toml`，完整步骤见 `docs/live-test-runbook.md`。

## 2. 检查项

| 检查                                            | 级别       | 含义                                                                                     |
| ----------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| execution.safety_bounds                         | block      | max_open_batches=1、manual_confirmation=true、max_order_notional<=30、daily_max_loss<=20 |
| execution.live_enabled                          | warn       | 实盘开关应保持 false，直到人工开启                                                       |
| execution.kill_switch                           | pass/warn  | 应保持 true                                                                              |
| fees.taker_overrides                            | warn       | 每个启用场所是否配置真实 taker_bps（否则用 CCXT 通用费率）                               |
| sizing.min_profit_vs_notional                   | warn       | min_profit_usd / 执行器实际 max_order_notional 的隐含 bps 门槛，过高会掩盖小价差         |
| network.proxy                                   | warn       | 是否配置代理                                                                             |
| database.integrity                              | block      | SQLite integrity_check 必须 ok                                                           |
| database.open_executions                        | block      | 不能有未对账的 open execution / unresolved order                                         |
| database.persisted_kill_switch / persisted_live | pass/warn  | 持久化开关状态                                                                           |
| secrets.store                                   | block      | 加密凭证库存在且可解密                                                                   |
| secrets.trade_coverage                          | block      | 每个启用场所都有 trade 凭证                                                              |
| secrets.ip_whitelist                            | warn       | trade key 是否标记 ipWhitelistVerified                                                   |
| network.venues                                  | block/warn | 每个场所 REST/WS 连通性                                                                  |
| bsc.quote_keys                                  | block      | 启用 BSC 时 0x/1inch key 是否存在                                                        |

## 3. 当前状态（2026-10-22）

- `liveTestReady: false`。
- block：`secrets.store`（`data/secrets.enc.json` 不存在）。
- warn：`fees.taker_overrides`（37 个场所均用 CCXT 通用费率）、`sizing.min_profit_vs_notional`（0.25/30 = 83.33bps）、`network.proxy`（未设置时代理告警）。
- pass：安全边界、kill switch、DB 完整性、无未对账执行、BSC 未启用。

## 4. 操作员待办

1. 为计划交易的场所创建 trade key（禁用提现、开 IP 白名单）和 read_only key。
2. 用 `npm run executor:secrets` 写入加密凭证库，确认只输出指纹。
3. 在 `config/default.toml` 的 `[fees.<venue>]` 写入真实 taker/maker 费率。
4. 调整 `max_order_notional` 与 `min_profit_usd`，使隐含门槛符合真实费率（例如 30 USDT 名义额时 0.25 USD 等于 83bps，明显过高）。
5. 反复运行 `npm run live:readiness`，直到 `liveTestReady: true`。
6. 人工确认后再把 `execution.live_enabled` 置为 true，并按 `docs/live-rollout-plan.md` 的小额手动批次推进。

## 5. 实盘测试前仍缺的外部条件

- 真实 VIP/maker 费率与返佣。
- 可交易、无提现权限的 API key（含 IP 白名单）。
- 目标币种的真实盘口深度与成交概率。
- 若启用 BSC：0x/1inch key、钱包余额、swap 模拟与手动确认。
