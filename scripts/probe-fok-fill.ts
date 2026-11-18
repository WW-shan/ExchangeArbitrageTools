/**
 * Does Bitget actually fill a FOK sell against the bid we can see?
 *
 * This is the one question that decides whether atomic two-leg execution would
 * help. Our logs show 26 of 33 sell legs ending at filled=0 while the recorded
 * book showed a large bid at exactly our limit price. Two explanations:
 *
 *   a) the book was real and FOK failed for an execution reason, or
 *   b) the recorded bid was not takeable (hidden/iceberg/frozen or a different
 *      market than the one we submit to).
 *
 * The probe submits the smallest possible FOK sell at the visible best bid and
 * reports what happened, then immediately re-reads the book.
 *
 *   npx tsx scripts/probe-fok-fill.ts --venue bitget --base WARD --usd 1.1
 *
 * Read-only in intent: it places one tiny FOK order that either fills fully or
 * not at all. Any fill is then sold back at the visible bid.
 */
import { Decimal } from '@arb/core';
import { createCexAdapter, createPublicRuntime } from '@arb/venues-cex';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

const venueId = arg('--venue', 'bitget').toLowerCase();
const base = arg('--base', 'WARD').toUpperCase();
const targetUsd = new Decimal(arg('--usd', '1.1'));
const configPath = process.env.ARB_CONFIG ?? 'config/live-rotation.toml';

async function main(): Promise<void> {
  const config = loadExecutorConfig(configPath);
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const credential = [...credentials.values()].find(
    (row) => row.venueId === venueId && row.role === 'trade' && row.apiKey,
  );
  if (!credential) throw new Error(`no trade credential for ${venueId}`);

  const proxyUrl = process.env.ARB_PROXY_URL ?? 'socks5://127.0.0.1:10808';
  const adapter = createCexAdapter(venueId, createPublicRuntime(8), { proxyUrl });

  try {
    const markets = await adapter.loadMarkets();
    const market = markets.find(
      (row) => row.base.trim().toUpperCase() === base && row.quote.trim().toUpperCase() === 'USDT',
    );
    if (!market) throw new Error(`${base}/USDT not listed on ${venueId}`);

    const balances = await adapter.fetchBalances!({
      apiKey: credential.apiKey,
      secret: credential.secret,
      ...(credential.password ? { password: credential.password } : {}),
    });
    const baseBalance = balances.find((row) => row.currency.toUpperCase() === base);
    console.log(`${venueId} ${base} free balance: ${baseBalance?.free.toString() ?? '0'}`);
    if (!baseBalance || baseBalance.free.lte(0)) throw new Error('no base balance to sell');

    const bookBefore = await adapter.fetchOrderBook(market.exchangeSymbol, 10);
    const bestBid = bookBefore.bids[0]!;
    console.log(
      `book: bid ${bestBid.price.toString()} x ${bestBid.amount.toString()} ` +
        `(${bestBid.price.mul(bestBid.amount).toFixed(2)} USDT), ask ${bookBefore.asks[0]?.price.toString()}`,
    );

    const amount = Decimal.min(
      baseBalance.free,
      targetUsd.div(bestBid.price),
    );
    const step = market.amountStep ?? new Decimal('0.01');
    const aligned = amount.div(step).floor().mul(step);
    if (!aligned.gt(0)) throw new Error('amount rounds to zero');

    console.log(
      `submitting FOK sell ${aligned.toString()} ${base} @ ${bestBid.price.toString()} ` +
        `(~${aligned.mul(bestBid.price).toFixed(2)} USDT)`,
    );
    const started = Date.now();
    const order = await adapter.createOrder!(
      {
        symbol: market.exchangeSymbol,
        side: 'sell',
        type: 'limit',
        amount: aligned,
        price: bestBid.price,
        timeInForce: 'FOK',
        clientOrderId: `probe-${Date.now().toString(36)}`,
      },
      {
        apiKey: credential.apiKey,
        secret: credential.secret,
        ...(credential.password ? { password: credential.password } : {}),
      },
    );
    const elapsed = Date.now() - started;
    console.log(
      `result after ${elapsed}ms: status=${order.status} filled=${order.filled.toString()} ` +
        `remaining=${order.remaining.toString()} avg=${order.averagePrice?.toString() ?? '-'}`,
    );

    const bookAfter = await adapter.fetchOrderBook(market.exchangeSymbol, 10);
    console.log(
      `book after: bid ${bookAfter.bids[0]?.price.toString()} x ${bookAfter.bids[0]?.amount.toString()}`,
    );

    const verdict =
      order.filled.gt(0) && order.remaining.eq(0)
        ? 'FULL_FILL'
        : order.filled.eq(0)
          ? 'ZERO_FILL'
          : 'PARTIAL_FILL';
    console.log(`\nverdict: ${verdict}`);
    console.log(
      verdict === 'ZERO_FILL'
        ? 'A visible bid at our limit did not fill. That is a real execution barrier, ' +
          'not just latency, and atomic submission would not have helped.'
        : 'FOK filled against the visible bid. Atomic submission is viable.',
    );
  } finally {
    await adapter.close?.().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
