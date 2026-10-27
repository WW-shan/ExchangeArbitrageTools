# 自动库存调拨 Runbook

本文对应 `docs/automated-inventory-transfer-design.md`。它描述 Gate.io 与 Hotcoin
之间如何自动执行两个方向的提币、如何确认目标站到账，以及第一笔真实资金必须
经过哪些人工闸门。

逐层审计和当前实盘缺口见
`docs/automated-inventory-transfer-audit-2026-10-28.md`。

## 1. 当前边界

- 自动调拨不是原子跨所转账。每条腿分别跟踪源站提币和目标站充值。
- 一个批次最多两条腿；默认串行执行，第一条腿确认 `ARRIVED` 后才提交第二条。
- 源站显示 `Completed` 不代表到账；必须以目标站匹配 `txId` 的充值记录为准。
- 未知提币结果进入 `SAFE_STOP`，不会重发。
- `config/live-test.toml` 当前仍然是 `live_enabled=false`、`kill_switch=true`、
  `[transfers].enabled=false`。
- 没有真实提现 API key 时，只能做规划、预检和 mock 测试。

## 2. 前置条件

每个交易所准备三条独立凭证：

```text
read_only : 余额、充值地址、充值历史
trade     : 下单、查单、撤单，禁止提现
withdrawal: 提币、提币历史，禁止下单；单独 API key
```

提现 key 必须：

- 与 trade key 不同；
- 只给必要权限；
- 开启 IP 白名单；
- 在凭证记录里声明 `withdrawalPermission=true` 和
  `ipWhitelistVerified=true`；
- Hotcoin 记录额外包含 passphrase。

另外需要人工确认：

- 同一币种在 Gate.io 与 Hotcoin 使用同一网络；首批优先 BSC/BEP20，但必须按资产逐一核对。
  2026-10-28 的 Gate 公共数据中，INC 只有 ERC20，TBK/HTX 只有 TRC20，
  CAKE/ETH/USDT 才有 BSC/BEP20；不能把 INC/BSC 当成可用路线；
- 两个方向的目标充值地址；
- 网络是否需要 memo/tag；
- 提币费、最小提币额、最小充值额；
- 目标站充值是否开启；
- 源站提币是否需要邮件/2FA/人工审核。

## 3. 写入凭证

准备一个不入库的 `secrets.json`。示例（不要提交到 Git）：

```json
[
  {
    "venueId": "gateio",
    "role": "read_only",
    "withdrawalPermission": false,
    "apiKey": "gate-read-key",
    "secret": "gate-read-secret",
    "ipWhitelistVerified": true
  },
  {
    "venueId": "gateio",
    "role": "trade",
    "withdrawalPermission": false,
    "apiKey": "gate-trade-key",
    "secret": "gate-trade-secret",
    "ipWhitelistVerified": true
  },
  {
    "venueId": "gateio",
    "role": "withdrawal",
    "withdrawalPermission": true,
    "apiKey": "gate-withdraw-key",
    "secret": "gate-withdraw-secret",
    "ipWhitelistVerified": true
  },
  {
    "venueId": "hotcoin",
    "role": "read_only",
    "withdrawalPermission": false,
    "apiKey": "hotcoin-read-key",
    "secret": "hotcoin-read-secret",
    "password": "hotcoin-passphrase",
    "ipWhitelistVerified": true
  },
  {
    "venueId": "hotcoin",
    "role": "trade",
    "withdrawalPermission": false,
    "apiKey": "hotcoin-trade-key",
    "secret": "hotcoin-trade-secret",
    "password": "hotcoin-passphrase",
    "ipWhitelistVerified": true
  },
  {
    "venueId": "hotcoin",
    "role": "withdrawal",
    "withdrawalPermission": true,
    "apiKey": "hotcoin-withdraw-key",
    "secret": "hotcoin-withdraw-secret",
    "password": "hotcoin-passphrase",
    "ipWhitelistVerified": true
  }
]
```

写入加密凭证库：

```powershell
$env:ARB_SECRET_STORE_KEY = '<至少16位主密钥>'
Get-Content secrets.json -Raw | npm run executor:secrets
Remove-Item secrets.json
```

命令只输出指纹，不输出 key。写入后删除明文文件。

## 4. 配置白名单

在 `config/live-test.toml` 增加两个方向。地址必须是目标交易所实时返回的地址。

```toml
[transfers]
enabled = false
require_manual_confirmation = true
max_in_flight_batches = 1
max_legs_per_batch = 2
max_balance_age_ms = 300000
poll_interval_ms = 15000
withdrawal_timeout_ms = 900000
deposit_timeout_ms = 1800000

[[transfers.allowlist]]
from_venue = 'gateio'
to_venue = 'hotcoin'
asset = 'CAKE'
network = 'BSC'
address = '0x目标地址'
address_tag = ''
venue_currency = 'CAKE(BSC)' # optional; use when the venue withdrawal endpoint requires a chain-qualified code
min_amount = '15'
max_amount = '200'
daily_max_amount = '400'
withdraw_fee = '1'

[[transfers.allowlist]]
from_venue = 'hotcoin'
to_venue = 'gateio'
asset = 'USDT'
network = 'BSC'
address = '0x目标地址'
address_tag = ''
min_amount = '10'
max_amount = '200'
daily_max_amount = '400'
withdraw_fee = '1'
```

注意：

- `CAKE` 只是结构示例；Hotcoin 是否开放同一网络的充提必须在真实 key 下确认。
- 首批只保留一条腿，确认后再加入第二条。
- `withdraw_fee` 是保守预留，必须与交易所实际费用一致。
- `max_amount` 和 `daily_max_amount` 是币种数量，不是 USDT 市值。
- 地址、tag、网络任何一项变化都会在预检时阻断。

## 5. 操作流程

### 5.1 刷新余额

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
$env:ARB_SOCKS_PROXY = 'socks5://127.0.0.1:10808'
$env:ARB_SECRET_STORE_KEY = '<主密钥>'
npm run executor:balances
```

余额必须包含目标场所和币种。超过 `max_balance_age_ms` 会被规划拒绝。

### 5.2 生成计划（不联网、不提币）

```powershell
npm run rebalance:execute -- --targets gateio:CAKE=30,hotcoin:CAKE=30
```

输出包含 `batchId`、每条腿的金额、方向和 `status`。如果状态是 `BLOCKED`，
先看 `safeModeReason`，不要执行。

### 5.3 预检（只读）

```powershell
npm run rebalance:execute -- --batch <batchId> --preflight
```

预检会：

- 重新读取目标站充值地址并与白名单比较；
- 检查网络、tag、最小/最大额、每日额度；
- 检查源站余额是否覆盖提币额和手续费；
- 检查源站提币是否开启；
- 检查目标站充值是否开启。

只有状态为 `READY` 才能继续。

### 5.4 Dry-run

```powershell
npm run rebalance:execute -- --batch <batchId> --dry-run
```

状态应变为 `DRY_RUN`，且交易所不会收到提币请求。

### 5.5 第一笔真实单腿

先把白名单缩减到一条腿，并保持：

```toml
[execution]
live_enabled = true
kill_switch = false
manual_confirmation = true

[transfers]
enabled = true
```

然后执行：

```powershell
npm run rebalance:execute -- --batch <batchId> --execute --confirm-batch <batchId>
```

命令会：

1. 重新预检；
2. 提交一次提币；
3. 轮询源站提币记录；
4. 用源站 `txId` 查询目标站充值记录；
5. 只有匹配到账才标记 `ARRIVED`；
6. 最后标记批次 `COMPLETED`。

第一笔必须用最小额，并在两个交易所后台同时观察。

### 5.6 对账

如果命令超时或进程中断：

```powershell
npm run rebalance:execute -- --batch <batchId> --reconcile
```

对账只查询历史，不会新提币。若无法确认，保持 `SAFE_STOP`。

### 5.7 人工解除锁定

只有在交易所后台人工确认后，才允许：

```powershell
npm run rebalance:execute -- --batch <batchId> --resolve --status BLOCKED --reason 'checked on venue UI; no transfer found'
```

不要为了继续跑而把未到账批次标成 `COMPLETED`。代码只允许所有腿均为 `ARRIVED`
时才标记 `COMPLETED`。

### 5.8 双方向循环

第一笔单腿成功并核对到账金额、手续费、耗时后，才加入第二条腿。随后：

1. `plan` 生成两条腿；
2. `preflight` 必须同时 `READY`；
3. `execute` 一次确认后自动串行完成两腿；
4. 第一条腿未 `ARRIVED`，第二条腿不会提交。

## 6. 失败处理

| 现象                 | 状态                            | 处理                             |
| -------------------- | ------------------------------- | -------------------------------- |
| 地址/网络/tag 不一致 | `BLOCKED`                       | 修正白名单，重新规划             |
| 余额不足             | `BLOCKED`                       | 补足余额或降低目标               |
| 提币请求异常         | `UNKNOWN` / `SAFE_STOP`         | 只在交易所后台/API 查询，不重发  |
| 源站失败/撤销        | `WITHDRAW_FAILED` / `SAFE_STOP` | 人工核查                         |
| 源站完成但无 txId    | `WAITING_DEPOSIT`               | 人工核查，最终 `DEPOSIT_TIMEOUT` |
| 目标站未到账         | `DEPOSIT_TIMEOUT` / `SAFE_STOP` | 对账，不重发                     |
| 目标站充值失败       | `DEPOSIT_FAILED` / `SAFE_STOP`  | 人工核查                         |

所有状态、源站记录 ID、目标站记录 ID、txId 和错误原因都会写入 SQLite。

## 7. 第一批验收记录

每次真实测试至少记录：

| 字段                     | 示例                    |
| ------------------------ | ----------------------- |
| 批次号                   | `xfer-...`              |
| 方向                     | Gate.io -> Hotcoin      |
| 币种/网络                | CAKE / BSC              |
| 提币金额/手续费          | 15 / 1                  |
| 源站提币 ID              | `...`                   |
| txId                     | `0x...`                 |
| 目标站充值 ID            | `...`                   |
| 到账金额                 | 14                      |
| 提交到源站完成耗时       | `...`                   |
| 源站完成到目标站到账耗时 | `...`                   |
| 最终状态                 | `ARRIVED` / `COMPLETED` |

## 8. 仍未完成的外部条件

- Gate.io 与 Hotcoin 的真实提现 key（独立、IP 白名单、无多余权限）。
- 两个方向的真实充值地址、网络、tag、手续费和最小额；Gate 当前 INC/TBK/HTX
  不在 BSC，不能直接套用示例资产。
- Hotcoin 适配器没有公开的币种网络/最小额元数据接口，必须用真实 key 返回的
  充值地址和提币记录人工确认；预检只能检查地址、链、余额和 allowlist。
- 第一笔单腿真实提币。
- 第一轮双方向真实调拨。
- 多轮到账延迟、失败率、手续费和人工审核观察。

在这些条件完成前，自动提币仍应保持关闭。当前代码完成的是可审计、可预检、
可 dry-run、未知结果不重发的工程链路，不代表已经通过实盘验收。

## 9. Live readiness 新增检查

运行：

```powershell
$env:ARB_CONFIG = 'config/live-test.toml'
npm run live:readiness
```

与调拨相关的新检查：

| 检查项                         | 含义                                                        | 失败级别 |
| ------------------------------ | ----------------------------------------------------------- | -------- |
| `secrets.withdrawal_isolation` | read_only/trade key 的 `withdrawalPermission` 必须为 false  | block    |
| `transfers.allowlist`          | 开启调拨时必须至少有一条 allowlist                          | block    |
| `transfers.credentials`        | 每条路线的场所需要 read_only/trade；源场所还需要 withdrawal | block    |
| `transfers.ip_whitelist`       | withdrawal key 必须标记 `ipWhitelistVerified=true`          | block    |
| `transfers.execution`          | 调拨关闭时显示 pass                                         | pass     |

`liveTestReady=true` 只表示工程闸门通过，不表示交易所已经允许提币，也不表示
第一笔真实调拨已经成功。真实 key、地址、手续费和到账时间仍必须按第 7 节记录。
