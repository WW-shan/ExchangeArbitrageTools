# 小额实盘测试 Runbook（S1 手动批次）

目标：用最小资金验证“扫描 → 就绪检查 → 只读预演 → 手动确认下单 → 双腿对账”的完整链路。默认只做 S1，只开 gateio/mexc/weex，单批不超过 10 USDT。

## 0. 前提

- 已有 `config/live-test.toml`（本仓库提供，`live_enabled=false`、`kill_switch=true`、`max_order_notional=10`、`min_profit_usd=0.005`）。
- 已安装并启动代理，`ARB_SOCKS_PROXY=socks5://127.0.0.1:10808`。
- 已准备 trade key（禁用提现、开 IP 白名单）与 read_only key。

## 1. 写入真实费率

编辑 `config/live-test.toml`，取消注释并填入你账户的真实费率：

```toml
[fees.gateio]
taker_bps = 10
maker_bps = 2
[fees.mexc]
taker_bps = 10
maker_bps = 2
[fees.weex]
taker_bps = 10
maker_bps = 2
```

未填费率时，就绪检查会告警，部分场所会以 `fee_not_configured` 失败关闭。

## 2. 写入加密凭证

先准备 `secrets.json`，内容是一个 JSON 数组，每个元素形如：

```json
{
  "venueId": "gateio",
  "role": "trade",
  "withdrawalPermission": false,
  "apiKey": "...",
  "secret": "..."
}
```

为 gateio/mexc/weex 各准备一条 trade 和一条 read_only 记录，然后：

```powershell
$env:ARB_SECRET_STORE_KEY = '<至少16位主密钥>'
Get-Content secrets.json -Raw | npm run executor:secrets
```

命令只输出指纹，不输出密钥。确认 `withdrawalPermission=false`。

## 3. 刷新余额

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor:balances
```

## 4. 就绪检查（必须通过）

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run live:readiness
```

- 必须 `liveTestReady: true` 且退出码 0。
- 任何 `block`（缺少凭证、DB 未对账、连通失败）都必须先解决。
- 结果同时写入 `data/live-readiness.json`。

## 5. 启动扫描器

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
npm run scanner
```

扫描器把 S1 机会写入 `data/live-test.sqlite`，不产生任何订单。

## 6. 只读执行预演

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor -- --opportunity <机会ID>
```

默认只读：加载最新有效 S1、检查凭证与恢复状态、打印精确的批次确认字符串，不提交订单。

## 7. 手动实盘（确认后才执行）

1. 在 `config/live-test.toml` 把 `live_enabled` 改为 `true`、`kill_switch` 改为 `false`。
2. 通过 Dashboard `POST /api/kill-switch`（body 为 `{"active":false}`）释放持久化 kill switch（或确认启动后仍为 false）。
3. 用上一步打印的批次号执行：

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor -- --opportunity <机会ID> --confirm-batch <批次ID> --execute
```

`--execute` 还要求：`live_enabled=true`、kill switch 已释放、启动恢复无未对账执行、`--confirm-batch` 与批次号完全一致。

## 8. 限额与停止条件

- 单批 notional ≤ 10 USDT，并发批次 = 1，每日最多 5 批，日亏上限 5 USDT，必须手动确认。
- 出现以下任一情况立即停手：未知订单无法对账、余额不一致、交易所回报本地不存在的订单、API 权限变化、检测到提现权限、行情持续过期、时钟漂移、同一场所重复下单失败、BSC 模拟与报价明显不符。

## 9. 测试期记录

- 每批记录：机会 ID、批次 ID、方向、实际成交价、手续费、滑点、净利、库存漂移。
- 达到 10 批手动实盘且 ≥80% 双腿完全对账后，再考虑进入自动化阶段（见 `docs/live-rollout-plan.md`）。
