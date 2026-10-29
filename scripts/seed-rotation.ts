import { Decimal } from '@arb/core';
import {
  alignAmountDown,
  calculateBuyDepthByQuote,
  ceilToStep,
  commonAmountStep,
  marketExchangeBase,
  planRotationSeed,
} from '@arb/core';
import { ArbitrageRepository, openDatabase } from '@arb/storage';
import { applyFeeOverride, mergeAccountFeeFile } from '@arb/venues-cex';
import { loadExecutorConfig } from '../apps/executor/src/config.js';
import { refreshBalances } from '../apps/executor/src/balance-service.js';
import { adapterMap } from '../apps/executor/src/runtime.js';
import { loadEncryptedSecretStore } from '../apps/executor/src/secret-store.js';
import { rotationPairConfig } from '../apps/executor/src/auto-rotation.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const config = loadExecutorConfig(process.env.ARB_CONFIG ?? 'config/live-rotation.toml');
  const base = arg('--base', '').trim().toUpperCase();
  const quote = arg('--quote', 'USDT').trim().toUpperCase();
  const buyVenueId = arg('--buy-venue', '').trim().toLowerCase();
  const notional = new Decimal(arg('--notional', '10'));
  const execute = has('--execute');
  if (!base) throw new Error('--base is required');
  if (!notional.isFinite() || notional.lte(0)) throw new Error('--notional must be positive');
  const pair = rotationPairConfig(config.autoRotation.pairs, `${base}/${quote}`);
  if (!pair) throw new Error(`pair ${base}/${quote} is not in auto_rotation.pairs`);
  const [venueA, venueB] = pair.venues;
  if (buyVenueId && buyVenueId !== venueA && buyVenueId !== venueB) {
    throw new Error(`--buy-venue must be ${venueA} or ${venueB}`);
  }
  const masterKey = process.env.ARB_SECRET_STORE_KEY;
  if (!masterKey) throw new Error('ARB_SECRET_STORE_KEY is required');
  const credentials = await loadEncryptedSecretStore(config.secretStorePath, masterKey);
  const adapters = adapterMap(
    new ArbitrageRepository(openDatabase(':memory:')),
    config,
    credentials,
  );
  const repository = new ArbitrageRepository(openDatabase(config.databasePath));
  try {
    if (repository.countOpenExecutions() > 0 || repository.countUnresolvedOrders() > 0) {
      throw new Error('seed refused: an execution or order is unresolved');
    }
    if (repository.getSetting('auto_execution_enabled') === 'true') {
      throw new Error('seed refused: stop the automatic rotation supervisor first');
    }
    const feeOverrides = mergeAccountFeeFile(config.feeOverrides, config.feeFile);
    const markets: Record<
      string,
      Awaited<ReturnType<(typeof adapters)[string]['adapter']['loadMarkets']>>
    > = {};
    for (const venueId of [venueA, venueB]) {
      const bundle = adapters[venueId];
      if (!bundle) throw new Error(`missing trade credential for ${venueId}`);
      markets[venueId] = (await bundle.adapter.loadMarkets()).map((market) =>
        applyFeeOverride(market, feeOverrides),
      );
    }
    const venueAMarket = markets[venueA]!.find(
      (market) =>
        market.active && market.base.toUpperCase() === base && market.quote.toUpperCase() === quote,
    );
    const venueBMarket = markets[venueB]!.find(
      (market) =>
        market.active && market.base.toUpperCase() === base && market.quote.toUpperCase() === quote,
    );
    if (!venueAMarket || !venueBMarket) {
      throw new Error(`missing ${base}/${quote} market on one venue`);
    }

    const balanceResult = await refreshBalances(
      repository,
      [venueA, venueB].flatMap((venueId) => {
        const bundle = adapters[venueId];
        return bundle ? [{ adapter: bundle.adapter, credentials: bundle.credentials }] : [];
      }),
    );
    if (balanceResult.errors.length > 0) throw new Error(balanceResult.errors.join('; '));
    const balances = repository.latestBalances({ maxAgeMs: 60_000 });
    const free = (venueId: string, currency: string): Decimal =>
      balances.find(
        (balance) =>
          balance.venueId === venueId &&
          balance.currency.trim().toUpperCase() === currency.trim().toUpperCase(),
      )?.free ?? new Decimal(0);
    const venueAQuote = free(venueA, quote);
    const venueBQuote = free(venueB, quote);
    const venueABase = free(venueA, marketExchangeBase(venueAMarket));
    const venueBBase = free(venueB, marketExchangeBase(venueBMarket));

    let chosenBuyVenue = buyVenueId;
    if (!chosenBuyVenue) {
      if (venueAQuote.gte(notional) && venueBQuote.lt(notional)) chosenBuyVenue = venueA;
      else if (venueBQuote.gte(notional) && venueAQuote.lt(notional)) chosenBuyVenue = venueB;
      else if (venueAQuote.gte(notional) && venueBQuote.gte(notional)) {
        chosenBuyVenue = (venueAMarket.feeTakerBps ?? new Decimal(10)).lte(
          venueBMarket.feeTakerBps ?? new Decimal(10),
        )
          ? venueA
          : venueB;
      }
    }
    if (chosenBuyVenue !== venueA && chosenBuyVenue !== venueB) {
      throw new Error('both venues lack enough quote balance to seed');
    }
    const sellVenue = chosenBuyVenue === venueA ? venueB : venueA;
    const buyMarket = chosenBuyVenue === venueA ? venueAMarket : venueBMarket;
    const sellMarket = chosenBuyVenue === venueA ? venueBMarket : venueAMarket;
    const buyBundle = adapters[chosenBuyVenue]!;
    const buyQuote = free(chosenBuyVenue, quote);
    if (buyQuote.lt(notional))
      throw new Error(`${chosenBuyVenue} quote balance is below ${notional.toFixed()}`);
    if (!buyMarket.amountStep || !sellMarket.amountStep || !buyMarket.priceStep) {
      throw new Error('amount/price step is missing');
    }

    const [buyBook, sellBook] = await Promise.all([
      buyBundle.adapter.fetchOrderBook(buyMarket.exchangeSymbol, 20),
      adapters[sellVenue]!.adapter.fetchOrderBook(sellMarket.exchangeSymbol, 20),
    ]);
    const depth = calculateBuyDepthByQuote(buyBook, notional);
    if (depth.insufficientDepth) throw new Error('insufficient buy depth for seed notional');
    const commonStep = commonAmountStep(buyMarket.amountStep, sellMarket.amountStep);
    const price = ceilToStep(depth.worstPrice, buyMarket.priceStep);
    const bid = sellBook.bids[0]?.price;
    if (!bid || bid.lte(0)) throw new Error('sell book has no bid');
    const plan = planRotationSeed({
      venue: chosenBuyVenue,
      notionalQuote: notional,
      ask: depth.worstPrice,
      bid,
      amountStep: commonStep,
      feeBps: buyMarket.feeTakerBps ?? new Decimal(0),
      feeChargeAsset: 'base',
      ...(buyMarket.minNotional ? { minNotional: buyMarket.minNotional } : {}),
    });
    const amount = alignAmountDown(plan.grossBase, commonStep);
    const quoteRequired = amount.mul(price);
    if (!amount.gt(0)) throw new Error('seed amount rounded to zero');
    if (buyMarket.minNotional && quoteRequired.lt(buyMarket.minNotional)) {
      throw new Error('seed order is below buy min notional');
    }
    if (quoteRequired.gt(buyQuote.mul('0.999'))) {
      throw new Error(
        `seed requires ${quoteRequired.toFixed()} ${quote}, available ${buyQuote.toFixed()}`,
      );
    }
    const readyDirectionAfterFill =
      chosenBuyVenue === venueA ? `${venueB}->${venueA}` : `${venueA}->${venueB}`;
    const summary = {
      mode: execute ? 'seed_execute' : 'seed_dry_run',
      pair: `${base}/${quote}`,
      buyVenue: chosenBuyVenue,
      sellVenue,
      amount: amount.toFixed(),
      limitPrice: price.toFixed(),
      quoteRequired: quoteRequired.toFixed(),
      expectedNetBase: plan.netBase.toFixed(),
      expectedResidualBase: plan.residualBase.toFixed(),
      balances: {
        [venueA]: { base: venueABase.toFixed(), quote: venueAQuote.toFixed() },
        [venueB]: { base: venueBBase.toFixed(), quote: venueBQuote.toFixed() },
      },
      readyDirectionAfterFill,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!execute) {
      console.log('dry run only; pass --execute to submit the FOK limit seed order');
      return;
    }
    if (!config.liveEnabled)
      throw new Error('execution.live_enabled must be true for seed execution');
    if (repository.getSetting('kill_switch') !== 'false') {
      throw new Error('persisted kill_switch must be false for seed execution');
    }

    const clientOrderId = `SEED-${base}-${Date.now()}`;
    let order;
    try {
      order = await buyBundle.adapter.createOrder!(
        {
          symbol: buyMarket.exchangeSymbol,
          side: 'buy',
          type: 'limit',
          amount,
          price,
          timeInForce: 'FOK',
          clientOrderId,
        },
        buyBundle.credentials,
      );
    } catch (error) {
      repository.recordRiskEvent('critical', 'rotation_seed_submit_failed', String(error), {
        base,
        buyVenue: chosenBuyVenue,
        clientOrderId,
      });
      throw error;
    }
    repository.recordOrder({
      venueId: chosenBuyVenue,
      venueOrderId: order.venueOrderId,
      clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price ?? price,
      amount: order.amount,
      filledAmount: order.filled,
      ...(order.averagePrice ? { averagePrice: order.averagePrice } : {}),
      ...(order.fee ? { fee: order.fee } : {}),
      status: order.status,
      now: Date.now(),
    });
    let finalOrder = order;
    const unresolvedStatuses = new Set(['open', 'unknown', 'submitted', 'pending']);
    for (let attempt = 0; attempt < 10 && unresolvedStatuses.has(finalOrder.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        finalOrder = await buyBundle.adapter.fetchOrder!(
          {
            clientOrderId,
            symbol: buyMarket.exchangeSymbol,
            venueOrderId: finalOrder.venueOrderId,
          },
          buyBundle.credentials,
        );
      } catch {
        break;
      }
    }
    if (finalOrder.status === 'open') {
      finalOrder = await buyBundle.adapter.cancelOrder!(
        { clientOrderId, symbol: buyMarket.exchangeSymbol, venueOrderId: finalOrder.venueOrderId },
        buyBundle.credentials,
      );
    }
    repository.recordOrder({
      venueId: chosenBuyVenue,
      venueOrderId: finalOrder.venueOrderId,
      clientOrderId,
      symbol: finalOrder.symbol,
      side: finalOrder.side,
      type: finalOrder.type,
      price: finalOrder.price ?? price,
      amount: finalOrder.amount,
      filledAmount: finalOrder.filled,
      ...(finalOrder.averagePrice ? { averagePrice: finalOrder.averagePrice } : {}),
      ...(finalOrder.fee ? { fee: finalOrder.fee } : {}),
      status: finalOrder.status,
      now: Date.now(),
    });
    repository.recordOrderEvent(clientOrderId, 'seed_final_status', {
      venueOrderId: finalOrder.venueOrderId,
      status: finalOrder.status,
      amount: finalOrder.amount.toFixed(),
      filled: finalOrder.filled.toFixed(),
      remaining: finalOrder.remaining.toFixed(),
      averagePrice: finalOrder.averagePrice?.toFixed() ?? null,
    });
    await refreshBalances(
      repository,
      [venueA, venueB].flatMap((venueId) => {
        const bundle = adapters[venueId];
        return bundle ? [{ adapter: bundle.adapter, credentials: bundle.credentials }] : [];
      }),
    );
    repository.recordAudit('operator', 'rotation_seed', {
      clientOrderId,
      pair: `${base}/${quote}`,
      buyVenue: chosenBuyVenue,
      requestedAmount: amount.toFixed(),
      filledAmount: finalOrder.filled.toFixed(),
      status: finalOrder.status,
      price: finalOrder.averagePrice?.toFixed() ?? finalOrder.price?.toFixed() ?? price.toFixed(),
    });
    const result = {
      status: finalOrder.status,
      requestedAmount: amount.toFixed(),
      acceptedAmount: finalOrder.amount.toFixed(),
      filled: finalOrder.filled.toFixed(),
      remaining: finalOrder.remaining.toFixed(),
      shortfall: finalOrder.amount.minus(finalOrder.filled).toFixed(),
      averagePrice: finalOrder.averagePrice?.toFixed() ?? null,
      clientOrderId,
      readyDirectionAfterFill,
    };
    console.log(JSON.stringify(result, null, 2));
    const fillRatio = finalOrder.amount.gt(0)
      ? finalOrder.filled.div(finalOrder.amount)
      : new Decimal(0);
    const closedWithTinyShortfall =
      finalOrder.status === 'closed' &&
      finalOrder.filled.gt(0) &&
      finalOrder.remaining.eq(0) &&
      fillRatio.gte('0.999');
    if (!closedWithTinyShortfall) {
      repository.setSetting('kill_switch', 'true');
      repository.recordRiskEvent(
        'critical',
        'rotation_seed_incomplete',
        'seed order did not fill completely',
        result,
      );
      process.exitCode = 2;
    }
  } finally {
    repository.close();
    for (const bundle of Object.values(adapters)) await bundle.adapter.close?.();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
