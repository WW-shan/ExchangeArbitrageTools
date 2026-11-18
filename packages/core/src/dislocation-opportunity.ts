import { Decimal, ZERO } from './money.js';
import { evaluateS1Direction } from './s1.js';
import type {
  CostSettings,
  MarketMetadata,
  OpportunityResult,
  OrderBookSnapshot,
} from './types.js';
import type { DislocationSignal } from './dislocation.js';

/**
 * Turn a confirmed dislocation into an executable opportunity.
 *
 * The S1 evaluator already does the work we need: walk both books, apply fees
 * and the safety buffer, and return the conservative net profit. The only
 * parts of S1 that must not apply here are the two "this spread looks wrong"
 * guards:
 *
 *   suspicious_spread_bps  rejects anything above ~1000 bps, which is exactly
 *                          the range a dislocation lives in
 *   max_price_deviation    rejects a venue whose price moved far from the
 *                          reference mid, which is the defining property of a
 *                          spike
 *
 * Both guards exist to stop us from trading a *broken* book during normal S1.
 * For DISLOCATION the break has already been classified: the detector proved
 * one venue moved while the other stayed on its own baseline, that both books
 * are live, and that neither top of book is frozen. Re-applying the S1 guard
 * would reject every real spike, which is what happened to IR/USDT on
 * 2026-11-19 (1,213 bps for 3.3 minutes, never executed).
 *
 * Everything else stays: minimum profit, depth limits, precision, health, and
 * the freshness window. A dislocation is not a licence to skip risk checks.
 */
export interface DislocationOpportunityInput {
  base: string;
  quote: string;
  buyMarket: MarketMetadata;
  sellMarket: MarketMetadata;
  buyBook: OrderBookSnapshot;
  sellBook: OrderBookSnapshot;
  signal: DislocationSignal;
  requestedNotional: Decimal;
  settings: CostSettings;
  now: number;
  venueHealth?: Readonly<Record<string, import('./types.js').HealthState>>;
  venueReliability?: Readonly<Record<string, Decimal>>;
}

export function evaluateDislocationOpportunity(
  input: DislocationOpportunityInput,
): OpportunityResult {
  const { signal } = input;
  const settings: CostSettings = {
    ...input.settings,
    // See the comment above: these two guards are S1-specific.
    suspiciousSpreadBps: ZERO,
    maxPriceDeviationBps: ZERO,
  };
  const evaluated = evaluateS1Direction({
    base: input.base,
    quote: input.quote,
    buyMarket: input.buyMarket,
    sellMarket: input.sellMarket,
    buyBook: input.buyBook,
    sellBook: input.sellBook,
    requestedNotional: input.requestedNotional,
    settings,
    now: input.now,
    ...(input.venueHealth ? { venueHealth: input.venueHealth } : {}),
    ...(input.venueReliability ? { venueReliability: input.venueReliability } : {}),
  });

  const reasons = [...evaluated.rejectionReasons];
  if (!signal.isDislocation) {
    // Callers should not build an opportunity from a rejected signal, but if
    // they do, never let it through.
    reasons.push('suspicious_spread');
  }

  return {
    ...evaluated,
    strategy: 'DISLOCATION',
    opportunityKey: `DISLOCATION|${input.base}/${input.quote}|${input.buyMarket.venueId}|${input.sellMarket.venueId}`,
    rejectionReasons: [...new Set(reasons)],
    valid: evaluated.valid && signal.isDislocation && reasons.length === 0,
    metadata: {
      ...(evaluated.metadata ?? {}),
      dislocationKind: signal.kind ?? 'unknown',
      dislocationBps: signal.magnitudeBps.toFixed(),
      spikeDeviationBps: signal.spikeDeviationBps.toFixed(),
      counterDeviationBps: signal.counterDeviationBps.toFixed(),
      spikeSide: signal.spikeSide ?? 'unknown',
      spikeDetectedAt: String(signal.sampledAt),
    },
  };
}
