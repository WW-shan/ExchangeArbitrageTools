# Gate/Hotcoin 私有 IOC/FOK 探测（2026-10-28）

## 目的

用真实 API key 验证三件事：

1. Gate.io 的 FOK 未成交是否会明确拒绝；
2. Hotcoin 的 `matchType=8`（FOK）和 `matchType=9`（IOC）未成交是否还能查单；
3. 未成交后是否残留挂单、冻结余额或基础币库存。

## 安全边界

- 只做买入探测，不做卖出、不提币、不开启 `live_enabled`。
- 限价低于当时卖一约 200 bps，使用 FOK/IOC，单笔名义金额不超过 20 USDT。
- 只使用加密存储中的 `trade` 凭证；输出不包含 API key、secret 或 passphrase。
- 每笔探测后立即查单；如果仍为 open，脚本会最多撤单 3 次。

## 实测结果

| 场所    | TIF |    卖一 |    限价 |   数量 |         名义 | 结果                        |
| ------- | --- | ------: | ------: | -----: | -----------: | --------------------------- |
| Gate.io | FOK |  1242.2 |  1217.3 | 0.0029 |  3.5302 USDT | `FOK_NOT_FILL`，零成交      |
| Hotcoin | FOK | 1236.11 | 1211.38 | 0.0133 | 16.1114 USDT | 下单返回 ID，随后查不到订单 |
| Hotcoin | IOC | 1236.06 | 1211.33 | 0.0133 | 16.1107 USDT | 下单返回 ID，随后查不到订单 |

### Gate.io

- 交易所明确返回 `FOK_NOT_FILL` / `Order cannot be filled completely`。
- `filled=0`，USDT 余额保持 `20`，`used=0`。
- 结论：Gate 的 FOK 未成交是确定性拒绝，不是未知订单。

### Hotcoin

- FOK 订单 ID：`2610027453266831`，clientOrderId：`fokprobehmvs5decj`。
- IOC 订单 ID：`2610027452897887`，clientOrderId：`fokprobehmvs5c26k`。
- `/v1/order/detailById` 和 `/v1/order/detailByClOrdId` 都返回 `40010 委单不存在`。
- `/v1/order/entrust` 的 type 0/1/2 均为空，零成交 IOC/FOK 不进入当前或历史委托。
- USDT 余额保持 `19.95`，`used=0`，没有基础币增加。
- 结论：Hotcoin 不保留零成交 IOC/FOK 的可查订单，不能把“查不到”直接当成“没成交”。

证据文件：

- `data/fok-probe-gate.json`
- `data/fok-probe-hotcoin.json`
- `data/ioc-probe-hotcoin.json`

## 代码修复

### Gate 确定性拒绝

`apps/executor/src/coordinator.ts` 识别 `FOK_NOT_FILL` / `cannot be filled completely`，直接生成零成交的 `canceled` 订单状态，走正常零成交关闭路径，不进入 `LEG1_UNKNOWN`，也不触发 kill switch。

### Hotcoin 查不到订单

当订单提交成功、但 `fetchOrder` 连续返回“委单不存在/order not found”时，执行器会比较提交前和提交后的基础币、计价币余额：

- 连续两次（间隔 750ms）余额完全不变，且没有冻结，才确认零成交；
- 生成 `balance_confirmed_no_fill_after_not_found` 的合成 `canceled` 订单；
- 任何余额变化都仍然进入 `SAFE_STOP`，不猜测成交结果。

### 适配器回退

Hotcoin `fetchOrder` 在 `detailById` 返回 `40010` 时，会继续用 `clientOrderId` 调 `detailByClOrdId`，再做有界委托列表分页，不再因为订单号不存在就直接失败。

### 配置

```toml
ioc_venues = []
fok_venues = ['gateio', 'hotcoin']
```

只启用已验证的 FOK 路径；IOC 仍保持关闭。`live_enabled=false`、`kill_switch=true`、`manual_confirmation=true` 均未改变。

## 仍未验证

- 没有验证 FOK 真正成交时的查单、手续费和库存变化；
- 没有验证卖出腿 FOK（当前没有基础币库存）；
- Hotcoin 零成交单不落历史，审计只能依赖本地 `order_events`、余额检查和执行状态；
- 余额确认假设 IOC/FOK 在约 1.5 秒内完成；如果交易所在确认后才延迟成交，仍可能留下未对冲库存；
- Gate/Hotcoin 仍共用带提现权限的 key，`secrets.shared_withdrawal_key` 警告未消除。

## 下一步

1. 先用 15-20 USDT 做一笔真实成交的 FOK 买入，形成基础币库存，验证成交查单和余额变化；
2. 再验证卖出腿 FOK 和双交易所对账；
3. 把 `ULTIMA` 加入扫描器显式资产池，持续观察实时净边；
4. 只有成交腿、卖出腿、对账都通过后，才考虑打开 `live_enabled`。
