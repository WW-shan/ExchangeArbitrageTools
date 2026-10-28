# S1 TBK 最小金额实盘全链路测试（2026-10-28）

## 1. 测试目标

用最小金额验证以下链路：

1. Hotcoin 限价建库存；
2. 真实 FOK 卖出 1 TBK；
3. 持久化扫描器生成有效 S1；
4. 只读预演与人工确认；
5. Gate FOK 买入 + Hotcoin FOK 卖出；
6. 成交后余额、订单、库存、利润和返利逐项对账；
7. 失败预检不产生任何订单；
8. 测试结束后恢复安全开关。

## 2. 安全边界

- 单批名义额上限：15.5 USDT；
- 实际 S1 名义额：9.51 USDT；
- `leg_mode='serial'`，两腿均为 FOK；
- `manual_confirmation=true`，批次号精确匹配；
- 单批、无并发批次；
- 不启用自动提币；
- 测试结束后 `kill_switch=true`、`live_enabled=false`。

## 3. 建库存

Hotcoin `TBK/USDT` GTC 买单：

- 限价：0.23900 USDT；
- 目标：64 TBK；
- 成交：42 TBK；
- 手续费：0.084 TBK；
- 剩余 22 TBK 自动撤单；
- 净库存：41.916 TBK。

证据：`data/inventory-build-TBK-2026-10-28.json`。

## 4. 1 TBK FOK 卖出验证

- 方向：sell；
- 数量：1 TBK；
- 价格：0.23888 USDT；
- 结果：完全成交；
- 手续费：0.0004 USDT；
- TBK：41.916 -> 40.916；
- USDT：9.912 -> 10.150402。

订单 ID：`2610027490567790`。

证据：`data/hotcoin-sell-fok-probe-2026-10-28.json`。

## 5. S1 机会与执行

### 机会

- 机会 ID：47；
- 批次：`S1-47-1793200774229`；
- 方向：Gate 买 -> Hotcoin 卖；
- 请求名义额：9.51 USDT；
- 预检刷新后毛边：0.064 USDT；
- 预检净利：0.0473590336 USDT；
- 预检净利 bps：49.7992。

### Gate 买入腿

- 订单 ID：`1157016249366`；
- 数量：40 TBK；
- 成交均价：0.23728 USDT；
- 状态：完全成交；
- 毛手续费：0.0396 TBK（9.9 bps）；
- 毛手续费折 USDT：0.009396288。

### Hotcoin 卖出腿

- 订单 ID：`2610027499537111`；
- 数量：40 TBK；
- 成交均价：0.23888 USDT；
- 状态：完全成交；
- 毛手续费：0.0191 USDT（约 20 bps）。

### 最终余额

| 场所    |     TBK |      USDT |
| ------- | ------: | --------: |
| Gate.io | 39.9604 |   10.5088 |
| Hotcoin |   0.916 | 19.686491 |

## 6. 返利与利润

Gate 的 70% 返利是后续以 USDT 返还，不是下单时免收；Hotcoin 配置为 80% 返利。按实际余额差计算：

| 项目                 |         USDT |
| -------------------- | -----------: |
| 毛价差               |        0.064 |
| Gate 毛手续费        |  0.009396288 |
| Gate 70% 返利应收    | 0.0065774016 |
| Gate 净手续费        | 0.0028188864 |
| Hotcoin 毛手续费     |     0.019111 |
| Hotcoin 80% 返利应收 |    0.0152888 |
| Hotcoin 净手续费     |    0.0038222 |
| 毛手续费合计         |  0.028507288 |
| 返利应收合计         | 0.0218662016 |
| 净手续费合计         | 0.0066410864 |
| 当前现金利润         |  0.035492712 |
| 含返利经济利润       | 0.0573589136 |

库存差：`-0.0396 TBK`；计价币差：`+0.044889 USDT`。

原始执行记录曾把利润记为 `0.0449`，原因是只扣了 Hotcoin 的 USDT 手续费，漏掉 Gate 以 TBK 收取的手续费，也没有单独记录返利应收。该历史记录已通过审计动作 `execution_profit_reconciled` 修正为：

- `realized_profit = 0.0573589136`（经济利润，含返利应收）；
- `fees = 0.0066410864`（净手续费）；
- 元数据保留 `cashProfitQuote=0.035492712`、`rebateReceivableQuote=0.0218662016`、`grossFeesQuote=0.028507288`。

证据：`data/live-s1-tbk-execution-2026-10-28.json`。

## 7. 预检失败与修复

### Gate REST 时间戳

Gate 的 REST 盘口时间戳经常比本地接收时间旧约 4 秒，执行器 3 秒阈值会拒绝：

- `exchange_timestamp_stale`；
- 或顺序抓取后先抓的盘口被后抓的盘口拖老，报 `stale_orderbook`。

修复：

1. 执行器改为并行抓取买卖两家盘口，缩短 pair skew；
2. 本次手工测试临时把执行配置盘口年龄放宽到 10 秒；
3. 扫描器仍保持 3 秒；
4. 测试结束后执行配置恢复为 3 秒；
5. 生产级下一步是执行器直接使用 WS 盘口，而不是 REST 快照。

### 其他安全拒绝

- 持久化 kill switch 为 true 时，预演和实盘均被拒绝；
- 机会超过 handoff 窗口时被拒绝；
- 以上拒绝均为 `ordersSubmitted=0`，没有产生订单。

## 8. 代码修正

- `apps/executor/src/coordinator.ts`：并行抓取两腿盘口；成交后用余额差对账。
- `apps/executor/src/profit-accounting.ts`：新增毛费、返利应收、净费、现金利润、经济利润纯函数。
- `apps/executor/src/main.ts`：把每个场所的 `rebate_pct` 传入执行请求。
- `packages/venues/cex/tests/hotcoin.test.ts`：`minOrderAmount=0` 不伪造 15 USDT 最小额。
- `scripts/live-readiness.ts`：删除 Hotcoin 统一 15 USDT 硬编码，改为按实时市场最小额预检。

## 9. 验证结果

- `npm run check`：56 个测试文件、342 个测试全部通过；
- 合成回测：20/20 批次成功；
- readiness：`liveTestReady=true`；
- 数据库 integrity：ok；
- 未决执行：0；
- 未决订单：0；
- 未对冲库存：0。

## 10. 剩余风险

1. Gate 70% 和 Hotcoin 80% 返利尚未在返利账本中确认到账时间和金额；当前是应收口径。
2. Hotcoin 零成交 IOC/FOK 仍可能查不到订单；执行器用连续余额快照确认，但成交单查询已在本轮验证。
3. 执行器仍使用 REST 盘口预检，Gate 时间戳约 4 秒；下一步应接入 WS 执行盘口。
4. TBK 库存现在主要在 Gate；由于 TBK 提币手续费约 3.5 TBK，不能低成本转回 Hotcoin，本轮是一次性全链路验证。
5. 自动库存再平衡仍未启用；需要先完成提币 allowlist、地址和最小额实测。
6. 本次为完成人工测试临时放宽了 handoff 和盘口年龄；默认安全配置已恢复。
