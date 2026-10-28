# Hotcoin 最小下单额与卖出路径实测（2026-10-28）

## 结论

- Hotcoin 的最小下单额是 **按交易对** 返回的，不是所有币对统一 15 USDT。
- `tbk_usdt` 的 `/v1/common/symbols` 返回 `minOrderAmount=0`，适配器不再伪造 `minNotional=15`。
- `1 TBK @ 0.23888` 的 FOK 卖单已真实完全成交，证明 1 TBK 可以卖出。
- 成交单可以按 `venueOrderId` 查询；零成交 IOC/FOK 仍可能查不到，执行器继续用余额连续确认零成交。
- 远离盘口的 GTC 限价单可能被 API 接受并返回订单号，但随后既查不到也不冻结余额；这类订单不能用来判断最小额，也不能当作已挂单。

## 官方依据

Hotcoin 官方 Python SDK（仓库 `hotcoinexchange/hotcoin-api-python`，2026-01-20 提交）：

- 下单：`POST_SIGN_URL /v1/order/place`
- 撤单：`POST_SIGN_URL /v1/order/cancel`
- 参数：`symbol`、`type`（buy/sell）、`tradePrice`、`tradeAmount`、`clientOrderId`
- 订单详情：`/v1/order/detailById`、`/v1/order/detailByClOrdId`
- 委托列表：`/v1/order/entrust`，`type=0/1/2`

本仓库适配器与上述参数一致：签名用 POST，参数放在 URL，请求体为空。

## 真实证据

### 1 TBK FOK 卖出

| 项目      | 值                 |
| --------- | ------------------ |
| 交易对    | `tbk_usdt`         |
| 方向      | sell               |
| 数量      | 1 TBK              |
| 价格      | 0.23888 USDT       |
| 订单 ID   | 2610027490567790   |
| 最终状态  | 完全成交           |
| 成交均价  | 0.23888 USDT       |
| 手续费    | 0.0004 USDT        |
| TBK 余额  | 41.916 -> 40.916   |
| USDT 余额 | 9.912 -> 10.150402 |

证据文件：`data/hotcoin-sell-fok-probe-2026-10-28.json`。

### 建库存单

- Hotcoin `TBK/USDT` GTC 买单：限价 0.23900，目标 64 TBK。
- 最终成交 42 TBK，均价 0.23900，手续费 0.084 TBK，剩余 22 TBK 已撤单。
- 净库存 41.916 TBK。
- 证据文件：`data/inventory-build-TBK-2026-10-28.json`。

### 不应重复的错误测试

以下订单虽然返回了订单号，但随后 `detailById` 返回 40010、撤单返回 300，余额没有冻结：

- 1 TBK @ 0.30
- 41 TBK @ 0.37
- 1 TBK @ 0.244

这些价格远离可成交盘口，可能触发 Hotcoin 的价格带/撮合保护，不能用来判断最小名义额。正确验证方式是：

1. 用可立即成交的 FOK 或 IOC；
2. 价格取买一/卖一附近；
3. 数量取最小可卖单位；
4. 成交后用订单详情和余额双重核对；
5. 零成交时用连续余额快照确认没有冻结和成交。

## 代码修正

- `packages/venues/cex/src/hotcoin.ts`：`minOrderAmount=0` 时不生成 `minNotional`；只有大于 0 才映射。
- `scripts/live-readiness.ts`：删除 Hotcoin 统一 >=15 USDT 的硬编码，改为检查 `min_sizing_notional>0` 且不超过 `max_order_notional`；单币最小额由执行器按实时 `market.minNotional` 预检。
- `packages/venues/cex/tests/hotcoin.test.ts`：新增 `minOrderAmount=0` 不产生 `minNotional/minAmount` 的测试。
- `config/live-test.toml`：注释改为“按交易对最小额”。

## 执行安全规则

- 扫描器可以按较小的全局 `min_sizing_notional` 运行，但执行器必须使用实时市场元数据检查两腿最小额。
- 低于 `market.minNotional` 的订单只能在预检阶段拒绝，不能靠交易所静默丢弃。
- 查不到订单且余额未冻结时，只能按“未挂单/零成交”处理；余额有任何变化仍进入 `SAFE_STOP`。
- 卖出腿必须优先使用已验证的 FOK；IOC 在 Hotcoin 上的成交/查单路径仍需单独验证。
- 不要把“API 返回订单号”当成“订单已存在”；必须以订单详情、委托列表或余额冻结为准。
