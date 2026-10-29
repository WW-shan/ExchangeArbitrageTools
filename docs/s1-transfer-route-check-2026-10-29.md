# Gate/Bitget 转账补库存与方向检查（2026-10-29）

## 结论

- **WARD 和 KAT 当前都不能做双向跨所转账补库存**。不是配置文件里的 `false` 挡住了，而是交易所当前返回的币种级提现/充值开关和网络本身不满足。
- 把本地 `[transfers] enabled` 改成 `true` 不会改变交易所状态；没有 allowlist 和提现凭证时，配置校验也不会通过。
- WARD 最常出现的是 `Gate→Bitget`，需要 Bitget 的基础币库存；但 Gate 的 WARD 提现关闭，无法从 Gate 补到 Bitget。
- KAT 最常出现的是 `Bitget→Gate`，需要 Gate 的基础币库存；但 Bitget 的 KAT 提现关闭，无法从 Bitget 补到 Gate。
- 当前资金量下，即使换成一个可双向转账的币，提现最低额和固定手续费也会吃掉大部分小额价差。转账只适合提前备货，不适合追秒级机会。
- 本轮同时修复了一个真实问题：扫描器按 100% 可用余额计算下单量，预检时价格轻微变化就会触发 `sell_base_balance_insufficient` 并安全停机。现在默认保留 1% 余额缓冲，配置项为 `balance_safety_buffer_bps = 100`。

## 交易所实时检查

检查时间：2026-10-29 21:45–21:56 HKT。数据来自 Gate/Bitget `fetchCurrencies()` 实时返回。

| 币种 | 交易所 | 网络      | 提现  | 充值  | 最小提币         | 提现手续费      |
| ---- | ------ | --------- | ----- | ----- | ---------------- | --------------- |
| WARD | Gate   | BSC/BEP20 | false | false | -                | -               |
| WARD | Bitget | BASE      | false | false | 2730.748225 WARD | 27.307483 WARD  |
| KAT  | Gate   | KAT       | true  | true  | 2.32504069 KAT   | 11.84 KAT       |
| KAT  | Bitget | KATANA    | false | true  | 2143.6227224 KAT | 21.43622723 KAT |

按当前价格估算：

- WARD Bitget 最小提币约 **9.96 USDT**，手续费约 **0.10 USDT**。
- KAT Bitget 最小提币约 **9.66 USDT**，手续费约 **0.10 USDT**。
- 当前 Gate WARD 约 **4.96 USDT**，Bitget WARD 约 **5.36 USDT**；Gate KAT 约 **4.85 USDT**，Bitget KAT 约 **4.99 USDT**。
- 因此即使 Bitget 的 WARD/KAT 提现开关打开，当前两边的 WARD/KAT 库存也都低于 Bitget 的最小提币量。

### 账户和程序侧状态

- Gate 账户当前 IP 白名单：`count=0`，`currentIpAccepted=false`。
- 凭证库当前只有 `trade` 角色，没有 `withdrawal` 角色。
- `config/live-rotation.toml` 中 `[transfers] enabled=false`，allowlist 为空。
- 运行时 kill switch 当前为 `true`，自动执行开关为 `false`。
- 转账服务在预检时会检查 `source_withdraw_disabled` 和 `destination_deposit_disabled`；这些检查是 fail-closed 的，不能靠改本地布尔值绕过。

## 历史机会方向

数据来自 6 天 1 分钟 Gate+Bitget 回测排名，名义金额 20 USDT，已扣除交易手续费、2 bps 安全和 10 bps 额外滑点。

### WARD

| 方向                              | 可执行 episode |  每天 | 中位净价差 |        P90 | 压力样本 |
| --------------------------------- | -------------: | ----: | ---------: | ---------: | -------: |
| Gate→Bitget（Gate 买，Bitget 卖） |            184 | 30.72 |  58.06 bps | 287.86 bps |      183 |
| Bitget→Gate（Bitget 买，Gate 卖） |            137 | 22.87 |  45.95 bps | 129.69 bps |      104 |

WARD 的主方向是 **Gate→Bitget**。执行这个方向需要：

- Gate 有 USDT 买入；
- Bitget 有 WARD 卖出。

成交后 Bitget 的 WARD 减少、Gate 的 WARD 增加。要重复同方向，需要把 WARD 从 Gate 补到 Bitget；但 Gate 的 WARD 提现当前是 `false`，而且 Gate 是 BSC、Bitget 是 BASE，网络也不一致。

### KAT

| 方向                              | 可执行 episode |  每天 | 中位净价差 |       P90 | 压力样本 |
| --------------------------------- | -------------: | ----: | ---------: | --------: | -------: |
| Bitget→Gate（Bitget 买，Gate 卖） |            255 | 42.57 |  26.83 bps | 72.18 bps |       72 |
| Gate→Bitget（Gate 买，Bitget 卖） |            103 | 17.20 |  19.64 bps | 50.95 bps |        2 |

KAT 的主方向是 **Bitget→Gate**。执行这个方向需要：

- Bitget 有 USDT 买入；
- Gate 有 KAT 卖出。

成交后 Gate 的 KAT 减少、Bitget 的 KAT 增加。要重复同方向，需要把 KAT 从 Bitget 补到 Gate；但 Bitget 的 KAT 提现当前是 `false`。

### 全市场方向

在 421 个候选币对中：

- `Bitget→Gate`：12,581 个可执行 episode，303 个币对有记录。
- `Gate→Bitget`：9,823 个可执行 episode，303 个币对有记录。
- 总体上 `Bitget→Gate` 更多，约占 56.2%。

但 WARD 是例外：它的主方向是 `Gate→Bitget`。KAT 则跟随总体，主方向是 `Bitget→Gate`。

## 当前实时盘口

2026-10-29 21:56 HKT 左右：

- WARD Gate bid `0.003763`，Bitget ask `0.003647`，`Bitget→Gate` 毛价差约 **318 bps**。
- Gate 的 WARD 约 1317.69 枚，按当前价约 4.96 USDT；Bitget 的 USDT 约 7.15 USDT。这个方向最多只能做约 4.7 USDT 的一小批。
- 13:36 UTC 的一次 WARD `Bitget→Gate` 机会净价差约 **466.70 bps**，请求 4.73 USDT，最后因为预检时 `sell_base_balance_insufficient` + `preflight_balance_mismatch` 安全停机。根因是扫描器按 100% 可用余额计算，没有给预检价格变化留余量。
- KAT 在该时刻没有正价差。

## 可双向转账的替代币

实时检查发现：

- Gate/Bitget 共有 1,234 条同网络币种/网络记录；
- 其中 406 条是两边 `withdraw=true` 且 `deposit=true` 的双向路径；
- 421 个历史候选币对中，有 246 个至少存在一条双向路径；
- 历史前 50 个币对中，有 39 个存在双向路径。

按历史机会和转账成本筛选出的候选：

| 币对       | 总 episode | 主方向      |     主方向中位/P90 | 双向网络 | 最小提币约 | Bitget 提现费约 | 备注                             |
| ---------- | ---------: | ----------- | -----------------: | -------- | ---------: | --------------: | -------------------------------- |
| LIGHT/USDT |        604 | Gate→Bitget |  15.34 / 37.62 bps | BSC      | 10.67 USDT |       0.16 USDT | BSC 低费，适合小额优先验证       |
| BTW/USDT   |        577 | Gate→Bitget |  13.64 / 34.47 bps | BSC      |  9.53 USDT |       0.14 USDT | BSC 低费，Gate 手续费需再核对    |
| BIRB/USDT  |      1,005 | Bitget→Gate |  22.80 / 71.38 bps | SOL      |  9.91 USDT |       0.99 USDT | 频率最高，但压力存活率弱         |
| ORDER/USDT |        668 | Bitget→Gate | 39.65 / 157.43 bps | ERC20    |  9.90 USDT |       1.98 USDT | 频率高，但 ERC20 费用和压力较弱  |
| DTEC/USDT  |        647 | Gate→Bitget |  32.83 / 78.06 bps | MATIC    | 10.05 USDT |       1.00 USDT | 方向均衡、压力样本多，作为储备   |
| BMT/USDT   |        646 | Bitget→Gate | 72.86 / 246.19 bps | SOL      |  9.98 USDT |       1.00 USDT | 单边严重，极端价差，不适合第一批 |

LIGHT 和 BTW 是最适合当前小额资金的 BSC 候选；但它们的中位净价差只有约 15 bps，20 USDT 名义下每笔约 0.03 USDT。提现费按 0.14–0.47 USDT 计算，转账一次需要很多笔交易才能摊平。因此：

- 转账补库存只适合较大本金（建议每边至少 50–100 USDT）或较大单笔；
- 5–20 USDT 资金更适合“两边预置库存 + 本地买卖轮换”，不适合频繁跨所搬运。

## 程序修改

本轮新增：

- `apps/scanner/src/scanner-service.ts`
  - `balanceSafetyBufferBps` 选项，默认 100 bps；
  - 计算可下单量时同时扣除买入手续费和余额缓冲；
  - 避免“刚好用满余额”导致预检时价格变化触发安全停机。
- `apps/scanner/src/config.ts`
  - 新增 `balance_safety_buffer_bps`，默认 `100`。
- `apps/scanner/src/main.ts`
  - 把配置传入扫描器。
- `apps/scanner/tests/scanner-balance-sizing.test.ts`
  - 增加余额缓冲回归测试。
- `config/live-rotation.toml`
  - 增加 `balance_safety_buffer_bps = 100`。

没有把 `[transfers] enabled` 改成 `true`，原因：

1. WARD/KAT 的交易所提现开关仍然关闭；
2. 没有 allowlist；
3. 没有 withdrawal 角色凭证；
4. Gate 没有 IP 白名单；
5. 运行时 kill switch 仍为 `true`。

在这些条件满足前强行打开，只会在预检阶段失败，或者把不安全的转账路径暴露给自动执行。

## 下一步建议

1. **WARD/KAT**：继续双边库存轮换，不配置转账；库存不足时在价差中性时本地买入，而不是跨所搬运。
2. **如果要做自动转账补库存**：优先选 LIGHT 或 BTW，先在 Gate/Bitget 后台确认币种级提现、充值、网络和最小额，再添加 `withdrawal` 凭证、IP 白名单和 allowlist，最后用单腿小额预检。
3. **如果要保留 WARD/KAT 并减少安全停机**：本轮余额缓冲已经修复；下一步需要重启执行器并释放 kill switch，才能重新捕捉实时机会。
4. **如果要支持“转 USDT 过去再买基础币”**：这是另一条流程，需要新增“转计价币 + 目标所补买 + 对账”的状态机；当前自动 rebalance 只会搬同名资产。

## 复现

```powershell
. .\scripts\load-env.ps1
$env:ARB_CONFIG = 'config/live-rotation.toml'
node node_modules/tsx/dist/cli.mjs data/check-ward-networks.ts
npm run account:state
```

历史方向统计来自：

- `data/rotation-history-gate-bitget-ranking.json`
- `data/history-gate-bitget-1m-6d-2026-10-29.json`
