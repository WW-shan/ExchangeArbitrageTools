import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Decimal, ceilToStep, floorToStep, type MarketMetadata } from '@arb/core';
import { createCexAdapter, createPublicRuntime, type OrderState } from '@arb/venues-cex';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import {
  loadEncryptedSecretStore,
  type StoredCredential,
} from '../apps/executor/src/secret-store.js';

interface ProbeResult {
  venueId: string;
  symbol?: string;
  bestAsk?: string;
  limitPrice?: string;
  amount?: string;
  notional?: string;
  timeInForce?: string;
  clientOrderId?: string;
  venueOrderId?: string;
  createdStatus?: string;
  createdRaw?: string;
  finalStatus?: string;
  filled?: string;
  remaining?: string;
  cancelAttempts?: number;
  lookup?: string;
  lookupError?: string;
  balancesBefore?: Record<string, string>;
  balancesAfter?: Record<string, string>;
  zeroFill?: boolean;
  notResting?: boolean;
  balancesUnchanged?: boolean;
  verdict: 'PASS' | 'PASS_WITH_BALANCE_DRIFT' | 'FAIL' | 'UNVERIFIED';
  error?: string;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function listArg(name: string, fallback: string): string[] {
  return arg(name, fallback)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sanitizeError(error: unknown): string {
  return String(error)
    .replace(/(AccessKeyId|Signature|apiKey|secret|password)=([^&\s]+)/gi, '$1=<redacted>')
    .slice(0, 500);
}

function findMarket(
  markets: readonly MarketMetadata[],
  base: string,
  quote: string,
): MarketMetadata | undefined {
  return markets.find(
    (market) =>
      market.active &&
      market.base.trim().toUpperCase() === base &&
      market.quote.trim().toUpperCase() === quote,
  );
}

function stepFor(value: Decimal | undefined, precision: number): Decimal {
  if (value?.gt(0)) return value;
  return new Decimal(10).pow(-Math.max(0, precision));
}

function balanceValue(
  balances: ReadonlyArray<{ currency: string; free: Decimal; used: Decimal; total: Decimal }>,
  currency: string,
): Record<string, string> | undefined {
  const row = balances.find((balance) => balance.currency.toUpperCase() === currency);
  if (!row) return undefined;
  return { free: row.free.toFixed(), used: row.used.toFixed(), total: row.total.toFixed() };
}

function sameBalance(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function balanceField(
  snapshot: Record<string, string>,
  currency: string,
  field: 'free' | 'used' | 'total',
): string | undefined {
  const raw = snapshot[currency];
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as Record<string, string>)[field];
  } catch {
    return undefined;
  }
}

function isExpectedFokRejection(message: string): boolean {
  return /FOK_NOT_FILL|cannot be filled completely|fok[^\n]*not[^\n]*fill/i.test(message);
}

async function snapshotBalances(
  adapter: NonNullable<ReturnType<typeof createCexAdapter>['fetchBalances']>,
  credential: StoredCredential,
  currencies: readonly string[],
): Promise<Record<string, string>> {
  const balances = await withTimeout(adapter(credential), 30_000, 'fetchBalances');
  const snapshot: Record<string, string> = {};
  for (const currency of currencies) {
    const value = balanceValue(balances, currency);
    if (value) snapshot[currency] = JSON.stringify(value);
  }
  return snapshot;
}

async function pollOrder(
  adapter: NonNullable<ReturnType<typeof createCexAdapter>['fetchOrder']>,
  order: OrderState,
  credential: StoredCredential,
  symbol: string,
  byClientOrderId = false,
  attempts = 10,
): Promise<OrderState> {
  let current = order;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Bitget's createOrder response only contains the order id, so CCXT
    // normalizes the initial status to unknown. Always query that state once
    // before treating the order as terminal.
    if (current.status !== 'open' && current.status !== 'unknown') return current;
    await sleep(500);
    const query = byClientOrderId
      ? { clientOrderId: current.clientOrderId ?? '', symbol }
      : { venueOrderId: current.venueOrderId, symbol };
    if (byClientOrderId && !query.clientOrderId) {
      throw new Error('order has no clientOrderId for fallback lookup');
    }
    current = await withTimeout(adapter(query, credential), 15_000, 'fetchOrder');
  }
  return current;
}

async function probeVenue(
  venueId: string,
  credential: StoredCredential,
  base: string,
  quote: string,
  priceOffsetBps: Decimal,
  targetNotional: Decimal,
  maxNotional: Decimal,
  timeInForce: 'IOC' | 'FOK',
): Promise<ProbeResult> {
  const adapter = createCexAdapter(venueId, createPublicRuntime(2), {
    credentials: credential,
    readOnly: false,
    supportsIoc: timeInForce === 'IOC',
    supportsFok: timeInForce === 'FOK',
  });
  try {
    if (!adapter.createOrder || !adapter.fetchOrder || !adapter.fetchBalances) {
      throw new Error('adapter does not expose the private order/balance capabilities');
    }
    const fetchBalances = adapter.fetchBalances.bind(adapter);
    const markets = await withTimeout(adapter.loadMarkets(), 30_000, 'loadMarkets');
    const market = findMarket(markets, base, quote);
    if (!market) throw new Error(`no active ${base}/${quote} market`);
    const book = await withTimeout(
      adapter.fetchOrderBook(market.exchangeSymbol, 5),
      30_000,
      'fetchOrderBook',
    );
    const bestAsk = book.asks[0]?.price;
    if (!bestAsk?.gt(0)) throw new Error('order book has no ask');

    const priceStep = stepFor(market.priceStep, market.pricePrecision);
    const amountStep = stepFor(market.amountStep, market.amountPrecision);
    const limitPrice = floorToStep(
      bestAsk.mul(new Decimal(1).minus(priceOffsetBps.div(10_000))),
      priceStep,
    );
    if (!limitPrice.gt(0) || !limitPrice.lt(bestAsk)) {
      throw new Error(
        `unsafe probe price ${limitPrice.toFixed()} against ask ${bestAsk.toFixed()}`,
      );
    }

    let amount = ceilToStep(targetNotional.div(limitPrice), amountStep);
    if (market.minAmount?.gt(amount)) amount = ceilToStep(market.minAmount, amountStep);
    if (market.minNotional?.gt(amount.mul(limitPrice))) {
      amount = ceilToStep(market.minNotional.div(limitPrice), amountStep);
    }
    const notional = amount.mul(limitPrice);
    if (notional.gt(maxNotional)) {
      throw new Error(
        `probe notional ${notional.toFixed(4)} exceeds cap ${maxNotional.toFixed(4)}`,
      );
    }

    const before = await snapshotBalances(fetchBalances, credential, [quote, base]);

    const clientOrderId = `fokprobe${venueId === 'gateio' ? 'g' : 'h'}${Date.now().toString(36)}`;
    const result: ProbeResult = {
      venueId,
      symbol: market.exchangeSymbol,
      bestAsk: bestAsk.toFixed(),
      limitPrice: limitPrice.toFixed(),
      amount: amount.toFixed(),
      notional: notional.toFixed(4),
      timeInForce,
      clientOrderId,
      balancesBefore: before,
      verdict: 'UNVERIFIED',
    };

    let created: OrderState | undefined;
    try {
      created = await withTimeout(
        adapter.createOrder(
          {
            symbol: market.exchangeSymbol,
            side: 'buy',
            type: 'limit',
            amount,
            price: limitPrice,
            timeInForce,
            clientOrderId,
          },
          credential,
        ),
        30_000,
        'createOrder',
      );
      result.venueOrderId = created.venueOrderId;
      result.createdStatus = created.status;
      result.createdRaw = sanitizeError(JSON.stringify(created.raw));
    } catch (error) {
      result.error = sanitizeError(error);
      try {
        const found = await withTimeout(
          adapter.fetchOrder({ clientOrderId, symbol: market.exchangeSymbol }, credential),
          15_000,
          'fetchOrderAfterCreateError',
        );
        created = found;
        result.venueOrderId = found.venueOrderId;
        result.createdStatus = found.status;
      } catch {
        if (isExpectedFokRejection(result.error)) {
          await sleep(1000);
          const after = await snapshotBalances(fetchBalances, credential, [quote, base]);
          const balancesUnchanged =
            sameBalance(before[quote], after[quote]) && sameBalance(before[base], after[base]);
          result.balancesAfter = after;
          result.createdStatus = 'rejected';
          result.finalStatus = 'rejected';
          result.filled = '0';
          result.remaining = amount.toFixed();
          result.zeroFill = true;
          result.notResting = true;
          result.balancesUnchanged = balancesUnchanged;
          result.verdict = balancesUnchanged ? 'PASS' : 'PASS_WITH_BALANCE_DRIFT';
          return result;
        }
        result.verdict = 'UNVERIFIED';
        return result;
      }
    }

    let final: OrderState | undefined;
    let lookup = 'venueOrderId';
    try {
      final = await pollOrder(
        adapter.fetchOrder.bind(adapter),
        created,
        credential,
        market.exchangeSymbol,
      );
    } catch (error) {
      result.lookupError = sanitizeError(error);
      lookup = 'clientOrderId';
      try {
        final = await pollOrder(
          adapter.fetchOrder.bind(adapter),
          created,
          credential,
          market.exchangeSymbol,
          true,
        );
      } catch (fallbackError) {
        result.lookupError = `${result.lookupError}; ${sanitizeError(fallbackError)}`;
        await sleep(1000);
        const after = await snapshotBalances(fetchBalances, credential, [quote, base]);
        const quoteUsed = balanceField(after, quote, 'used');
        const baseUnchanged = sameBalance(before[base], after[base]);
        const zeroFill = baseUnchanged;
        const notResting = quoteUsed === '0';
        const balancesUnchanged = sameBalance(before[quote], after[quote]) && baseUnchanged;
        result.lookup = 'not_found';
        result.finalStatus = 'not_found';
        result.filled = zeroFill ? '0' : 'unknown';
        result.remaining = zeroFill ? amount.toFixed() : 'unknown';
        result.balancesAfter = after;
        result.zeroFill = zeroFill;
        result.notResting = notResting;
        result.balancesUnchanged = balancesUnchanged;
        result.verdict = zeroFill && notResting && balancesUnchanged ? 'PASS' : 'UNVERIFIED';
        return result;
      }
    }
    result.lookup = lookup;
    let cancelAttempts = 0;
    while (final.status === 'open' && cancelAttempts < 3) {
      cancelAttempts += 1;
      try {
        final = await withTimeout(
          adapter.cancelOrder!(
            { venueOrderId: final.venueOrderId, symbol: market.exchangeSymbol },
            credential,
          ),
          15_000,
          'cancelOrder',
        );
      } catch (error) {
        result.error = sanitizeError(error);
      }
      if (final.status === 'open') await sleep(500);
    }
    if (cancelAttempts > 0) result.cancelAttempts = cancelAttempts;
    result.finalStatus = final.status;
    result.filled = final.filled.toFixed();
    result.remaining = final.remaining.toFixed();

    await sleep(1000);
    const after = await snapshotBalances(fetchBalances, credential, [quote, base]);
    result.balancesAfter = after;

    const zeroFill = final.filled.eq(0);
    const notResting = final.status !== 'open';
    const balancesUnchanged =
      sameBalance(before[quote], after[quote]) && sameBalance(before[base], after[base]);
    result.zeroFill = zeroFill;
    result.notResting = notResting;
    result.balancesUnchanged = balancesUnchanged;

    const expectedTerminal = final.status === 'canceled' || final.status === 'rejected';
    if (zeroFill && notResting && expectedTerminal) {
      result.verdict = balancesUnchanged ? 'PASS' : 'PASS_WITH_BALANCE_DRIFT';
    } else {
      result.verdict = 'FAIL';
    }
    return result;
  } finally {
    try {
      await withTimeout(Promise.resolve(adapter.close?.()), 3000, 'close');
    } catch {
      // ignore close errors
    }
  }
}

async function main(): Promise<void> {
  const config = loadExecutorConfig(process.env.ARB_CONFIG ?? 'config/live-test.toml');
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const records = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const venues = listArg('--venues', 'gateio,hotcoin');
  const base = arg('--base', 'ULTIMA').trim().toUpperCase();
  const quote = arg('--quote', 'USDT').trim().toUpperCase();
  const priceOffsetBps = new Decimal(arg('--price-offset-bps', '200'));
  const maxNotional = new Decimal(arg('--max-notional', '20'));
  const timeInForce = arg('--tif', 'FOK').trim().toUpperCase();
  if (timeInForce !== 'IOC' && timeInForce !== 'FOK') {
    throw new Error('--tif must be IOC or FOK');
  }
  if (!priceOffsetBps.gt(0) || priceOffsetBps.gte(5000)) {
    throw new Error('--price-offset-bps must be between 0 and 5000');
  }

  const results: ProbeResult[] = [];
  for (const venueId of venues) {
    const credential = [...records.values()].find(
      (record) => record.venueId === venueId && record.role === 'trade',
    );
    if (!credential) {
      results.push({ venueId, verdict: 'UNVERIFIED', error: 'trade credential missing' });
      continue;
    }
    const targetNotional = new Decimal(
      arg(`--${venueId}-notional`, venueId === 'hotcoin' ? '16' : '3.5'),
    );
    try {
      results.push(
        await probeVenue(
          venueId,
          credential,
          base,
          quote,
          priceOffsetBps,
          targetNotional,
          maxNotional,
          timeInForce,
        ),
      );
    } catch (error) {
      results.push({ venueId, verdict: 'UNVERIFIED', error: sanitizeError(error) });
    }
  }

  const output = resolve(arg('--out', `data/fok-probe-${Date.now()}.json`));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(results, null, 2));
  console.log(`wrote ${output}`);
  if (results.some((result) => result.verdict === 'FAIL' || result.verdict === 'UNVERIFIED')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(sanitizeError(error));
  process.exitCode = 1;
});
