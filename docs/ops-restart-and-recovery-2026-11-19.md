# 实盘重启与对账 SOP（含 2026-11-19 事故复盘）

## 0. 事故：误杀 node 进程导致实盘中断

**发生了什么**：我在启动只读插针扫描器时执行了 `Stop-Process -Name node`，
把实盘 executor(9224)、scanner(19232)、watchdog(15988) 一起杀掉。

**后果**：
- 有一笔 S1 execution（id=137）正在执行中被中断，卡在 `SAFE_STOP`
- Gate 已买入 4095 WARD，Bitget 卖腿从未提交
- 重启时 startup recovery 正确判定 `open_executions_require_reconciliation` 并 BLOCKED

**恢复过程（已按顺序完成）**：
1. `account:state` 核对真实余额：Gate WARD 从 1244.23 → 5347.72，确认 4095 枚已成交
2. `execution:reconcile --batch <batchId> --carry-inventory --confirm <batchId>` 把多头正式入账
3. 确认 `unhedged: []`
4. `rotation:release -- --confirm RELEASE-KILL-SWITCH`
5. `rotation:start`

**教训（必须遵守）**：

> **永远不要用 `Stop-Process -Name node`。**
> 这个仓库同时跑着 executor、scanner、watchdog、只读脚本，全都是 node.exe。

正确做法：只杀自己启动的那个 PID。

```powershell
# 启动后台脚本时记下 PID
$p = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx","scripts/scan-dislocation.ts" `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput data\dislocation\scan.out.log `
  -RedirectStandardError data\dislocation\scan.err.log
$p.Id | Set-Content data\dislocation\scanner.pid

# 停止时只杀这一个
Stop-Process -Id (Get-Content data\dislocation\scanner.pid)
```

## 1. 实盘状态检查（每次改动前后都做）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rotation-status.ps1
```

要看到：

- `state: RUNNING`
- executor `phase: WAIT`（等待信号）或 `EXECUTING`
- scanner `phase: SCANNING`
- `heartbeatAgeMs` < 5000

## 2. 启动被 BLOCKED 时的排查顺序

```powershell
# 1) 看恢复决策
Get-Content (Get-ChildItem data\logs\executor-*.out.log | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -TotalCount 30
```

`decision.reasons` 里出现下列值，含义分别是：

| reason | 含义 | 处理 |
| --- | --- | --- |
| `open_executions_require_reconciliation` | 有 execution 没走完 | 见第 3 节 |
| `persisted_kill_switch_on` | 数据库里 kill switch 还是 true | 见第 4 节 |
| `unresolved_order` | 有订单状态未知 | `npm run order:reconcile` |
| `unhedged_inventory` | 有未对冲持仓 | 先对冲或 `--carry-inventory` |

## 3. 对账一笔卡住的 execution

```powershell
# 先看这笔到底成交了什么
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/rotation.sqlite',{readOnly:true});console.log(db.prepare('select * from execution_legs where execution_id=?').all(137))"

# 再核对真实余额
npm run account:state

# 情况 A：确实买到了币 → 把多头入账
npx tsx apps/executor/src/reconcile-cli.ts --batch <batchId> --carry-inventory --confirm <batchId>

# 情况 B：两条腿都确认零成交 → 直接关闭
npx tsx apps/executor/src/reconcile-cli.ts --batch <batchId> --close-no-fill --confirm <batchId>
```

对账工具**不会下单、不会清 kill switch**，这是故意的。

## 4. 释放 kill switch

```powershell
npm run rotation:release -- --confirm RELEASE-KILL-SWITCH
```

它会在以下任一条件成立时拒绝：

- `open_execution`
- `unresolved_order`
- `active_transfer`
- 当日已实现亏损 >= `daily_max_loss_usd`
- `unhedged_inventory > 0`

被拒是正确行为，不要去改代码绕过。

## 5. 只读脚本的启动规范

只读脚本（扫描器、探测、回测）必须：

1. 用 `Start-Process ... -PassThru` 拿到 PID 并落盘
2. 日志重定向到 `data/<name>/` 下
3. 停止时按 PID 杀，不按进程名

## 6. 事故留下的真实持仓

当前 WARD 分布（事故后）：

| 交易所 | WARD | USDT |
| --- | --- | --- |
| Gate.io | 5347.72 | 0.58 |
| Bitget | 5631.53 | 7.15 |

两边合计约 10979 WARD。这些是库存，不是损失；S1 的双向逻辑会用它们。
但要注意：Bitget 提 WARD 最低 5824 枚 ≈ 全部持仓，实际无法跨所搬运。
