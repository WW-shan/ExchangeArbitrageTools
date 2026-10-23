# S1 合约乘数与资产别名设计

日期：2026-10-23

## 1. 目标

S1 要求两条腿交易同一个底层资产。部分交易所用 `1000PEPE`、`kPEPE` 这类
1000 倍计价单位，另一些交易所用 `PEPE`。如果只比较字面 `base`，会漏掉这些
跨所组合；如果只把符号改成 `PEPE` 而不换算数量和价格，会把 1000 倍数量送去
下单，属于不可接受的风险。

本设计把“发现层归一化”和“执行层还原”作为不可拆分的一组能力：

1. 行情在进入 S1 计算前换算成规范资产单位。
2. 机会、深度、利润、库存净额全部以规范单位记录。
3. 下单前把规范数量/价格换回交易所单位，并对齐交易所精度。
4. 别名配对必须通过独立价格校验；不通过则跳过，不产生机会。
5. 旧机会或运行时市场乘数不一致时，执行层 fail closed。

参考实现：`djienne/CROSS_EXCHANGE_MARKET_MAKING_RUST` 的 `SCREENER/src/universe.rs`。
其规则是显式 k 合约列表、`1000` 前缀和 2% 价格比例校验，不对任意前导 `k`
做剥离。该仓库最后推送时间为 2026-10-20。

## 2. 单位定义

对每个市场定义：

- 规范资产 `base`：例如 `PEPE`。
- 交易所资产 `exchangeBase`：例如 `1000PEPE`；没有别名时省略。
- 乘数 `baseMultiplier`：1 个交易所 base 单位所代表的规范 base 数量。
  `1000PEPE` 的乘数为 `1000`，普通 `PEPE` 省略或为 `1`。

换算公式：

```text
canonicalPrice  = exchangePrice  / baseMultiplier
canonicalAmount = exchangeAmount * baseMultiplier

exchangePrice   = canonicalPrice  * baseMultiplier
exchangeAmount  = canonicalAmount / baseMultiplier
```

例：`1000PEPE/USDT` 的卖一价 `0.00995`、数量 `2000`：

```text
规范价格 = 0.00995 / 1000 = 0.00000995 USDT/PEPE
规范数量 = 2000 * 1000   = 2,000,000 PEPE
```

## 3. 别名识别规则

只识别以下两类：

1. 显式 k 合约：`kPEPE`、`kSHIB`、`kBONK`、`kLUNC`、`kFLOKI`、`kNEIRO`。
2. 以 `1000` 开头且后面仍有资产名的符号，例如 `1000PEPE`、`1000BONK`。

不会把 `KAITO`、`KAVA` 等任意前导 k 资产剥离成 `AITO`/`AVA`。`1000` 单独出现
也不视为别名。

规范化在 adapter 边界完成：

- `exchangeSymbol` 保留交易所原始符号，用于行情和下单。
- `unifiedSymbol`、`base` 使用规范资产。
- 只有发生别名时才写 `exchangeBase` 和 `baseMultiplier`。

## 4. 行情与发现

`canonicalMarketForEvaluation()` 生成只用于计算的 market 视图：

- `amountStep` 和 `minAmount` 乘以乘数。
- `priceStep` 除以乘数。
- `baseMultiplier` 设为 `1`，防止重复换算。
- `exchangeSymbol`、`exchangeBase` 保留，便于审计。

`normalizeBookForMarket()` 对盘口做同样变换：价格除以乘数，数量乘以乘数。
原始盘口仍用于持久化，规范盘口只用于 S1、深度和 paper。

扫描路径：

1. 交易所返回原始盘口并通过 `validateOrderBook()`。
2. 别名市场按乘数归一化。
3. 扫描器按规范 `base/quote` 分组。
4. 两条腿乘数不同时，比较归一化 mid；偏差超过 200bps 则计入
   `summary.aliasMismatches` 并跳过。
5. 其余逻辑（预筛、深度、利润、余额、episode）全部使用规范单位。

乘数相同的普通市场不受 2% 限制，正常 S1 价差不会被该规则截断。

## 5. 执行与 paper

### 5.1 Paper

Paper 模拟使用规范 market 和规范 book。成交数量、成本和利润均是规范单位，
因此 1000 倍别名不会造成虚拟库存或利润放大。

### 5.2 Live executor

预检：

1. 重新拉取原始盘口并验证。
2. 检查两条腿的规范 mid 在允许范围内。
3. 用规范市场重新评估 S1。
4. 检查规范价格和交易所价格都满足 tick size。
5. 规范数量分别换算回买腿、卖腿的交易所数量，并对齐 `amountStep`。
6. 检查交易所 `minAmount`、`minNotional`。
7. 卖腿余额按 `exchangeBase` 查找，乘回乘数后与规范需求比较。

下单：

- Leg 1 数量 = 规范数量 / 买腿乘数，再按买腿 step 向下对齐。
- Leg 1 价格 = 规范限价 * 买腿乘数。
- Leg 2 用 Leg 1 实际成交数量（乘回买腿乘数）计算卖腿深度。
- Leg 2 数量 = 规范数量 / 卖腿乘数，再按卖腿 step 向下对齐。
- Leg 2 价格 = 规范限价 * 卖腿乘数。

对账和部分成交仍以交易所返回数量为准；利润始终用 quote 金额计算。未对冲库存
以交易所资产和交易所数量落库，同时在 risk event 中记录规范资产、规范数量和乘数。

机会 metadata 写入：

```text
buySymbol / sellSymbol
buyExchangeBase / sellExchangeBase
buyBaseMultiplier / sellBaseMultiplier
```

执行层会对照存储的 symbol 和 multiplier；任何一项与当前市场不一致都会
`BLOCKED`。旧机会没有这些字段时仍可按唯一市场匹配，但一旦字段存在就严格比较。

## 6. Fail-closed 边界

- `evaluateS1Direction()` 拒绝 `baseMultiplier != 1` 的未归一化市场。
- 别名 mid 偏差超过 200bps 时，扫描不产生机会，执行预检返回
  `alias_price_mismatch`。
- 同一交易所有多个市场映射到同一规范资产且无法用存储的 `exchangeSymbol`
  唯一确定时，执行层拒绝选择。
- S2/S3、BSC 映射暂不使用带乘数的市场，避免把 1000 倍数量混入其他策略。
- `baseMultiplier` 非有限或非正数时拒绝。

## 7. 测试与证据

- `packages/core/tests/market-units.test.ts`
  - k 别名、1000 前缀、任意 k 不剥离。
  - 盘口、step、minAmount、数量和价格双向换算。
  - 2% 价格校验。
  - 规范 S1 有效；未归一化别名市场被拒绝。
- `packages/venues/cex/tests/ccxt-adapter.test.ts`
  - `1000PEPE/USDT` 映射为规范 `PEPE/USDT`，保留 `exchangeBase=1000PEPE`。
- `apps/scanner/tests/scanner-alias.test.ts`
  - `1000PEPE -> PEPE` 产生有效 S1 和 CLOSED paper。
  - 归一化价格偏差超过 2% 时不配对。
- `apps/executor/tests/coordinator-alias.test.ts`
  - 规范数量 `1,005,000 PEPE` 下单为 `1005` 张 `1000PEPE`。
  - 规范价格 `0.00000995` 下单为 `0.00995`。
  - 存储乘数漂移时在下任何单前 BLOCKED。
- `apps/executor/tests/handoff.test.ts`
  - handoff 阶段拒绝乘数漂移。

## 8. 已知限制

- 只支持现货乘数别名；永续市场仍由 `marketType` 过滤。
- 乘数固定为 1000；`10000` 等新单位需要显式加入规则并补测试。
- quote 资产别名（如 `USDT` 与 `USD`）不在本设计内。
- 别名市场的 S2/S3 路径暂时跳过；需要时为图算法单独设计单位传播。
- 2% 校验是别名安全阈值，不是利润门槛；极端宽价差会因无法确认同一资产而跳过。
