/**
 * Measure the real FOK fill rate against the visible best bid.
 *
 * 26 of 33 sell legs in our logs ended at filled=0 even though the recorded
 * book showed a large bid at exactly our limit price. Either the book is not
 * what the matching engine sees, or something about our order (size, client id,
 * price) is rejected.
 *
 * This repeats the exact submission five times at 1 USDT and reports each
 * outcome, alternating long and short client order ids so an id-length or
 * id-format rejection shows up as a pattern rather than noise.
 *
 *   npx tsx scripts/probe-fok-loop.ts --venue bitget --base WARD --usd 1.1 --rounds 5
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
const rounds = Math.max(1, Number(arg('--rounds', '5')));
const longId = arg('--long-id', '1') === '1';
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
  const keys = {
    apiKey: credential.apiKey,
    secret: credential.secret,
    ...(credential.password ? { password: credential.password } : {}),
  };

  const proxyUrl = process.env.ARB_PROXY_URL ?? 'socks5://127.0.0.1:10808';
  const adapter = createCexAdapter(venueId, createPublicRuntime(8), { proxyUrl });

  const results: Array<{ round: number; status: string; filled: string; idLen: number; bookAgeMs: number }> = [];
  try {
    const markets = await adapter.loadMarkets();
    const market = markets.find(
      (row) => row.base.trim().toUpperCase() === base && row.quote.trim().toUpperCase() === 'USDT',
    );
    if (!market) throw new Error(`${base}/USDT not listed on ${venueId}`);
    const step = market.amountStep ?? new Decimal('0.01');

    for (let round = 1; round <= rounds; round += 1) {
      const balances = await adapter.fetchBalances!(keys);
      const free = balances.find((row) => row.currency.toUpperCase() === base)?.free ?? new Decimal(0);
      if (!free.gt(0)) throw new Error('no base balance');

      const book = await adapter.fetchOrderBook(market.exchangeSymbol, 10);
      const bookAt = Date.now();
      const bestBid = book.bids[0]!;
      const amount = Decimal.min(free, targetUsd.div(bestBid.price));
      const aligned = amount.div(step).floor().mul(step);
      if (!aligned.gt(0)) throw new Error('amount rounds to zero');

      // Mirror the live executor's id shape (batch-id + leg suffix), which is
      // 27 characters, to catch any id-length rejection.
      const clientOrderId = longId
        ? `S1-${String(Date.now()).slice(-7)}-${Date.now()}-L2`
        : `probe-${Date.now().toString(36)}`;

      const started = Date.now();
      let status = 'error';
      let filled = '0';
      try {
        const order = await adapter.createOrder!(
          {
            symbol: market.exchangeSymbol,
            side: 'sell',
            type: 'limit',
            amount: aligned,
            price: bestBid.price,
            timeInForce: 'FOK',
            clientOrderId,
          },
          keys,
        );
        status = order.status;
        filled = order.filled.toString();
      } catch (error) {
        status = `throw:${String(error).slice(0, 60)}`;
      }
      const elapsed = Date.now() - started;
      results.push({
        round,
        status,
        filled,
        idLen: clientOrderId.length,
        bookAgeMs: Date.now() - bookAt,
      });
      console.log(
        `round ${round}: ${status} filled=${filled}/${aligned.toString()} ` +
          `price=${bestBid.price.toString()} idLen=${clientOrderId.length} ${elapsed}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    await adapter.close?.().catch(() => undefined);
  }

  const full = results.filter((row) => Number(row.filled) > 0).length;
  console.log(`\nfill rate: ${full}/${results.length}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
