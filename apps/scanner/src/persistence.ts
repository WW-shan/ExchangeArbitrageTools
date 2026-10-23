import { Decimal, ZERO, type OpportunityResult } from '@arb/core';
import type { ArbitrageRepository, StoredOpportunity } from '@arb/storage';

function fillValue(
  fillQuality: Record<string, unknown> | undefined,
  section: string,
  key: string,
): string | undefined {
  const value = fillQuality?.[section];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' || typeof field === 'number' ? String(field) : undefined;
}

export function persistSimulatedOpportunity(
  repository: ArbitrageRepository,
  stored: StoredOpportunity,
  opportunity: OpportunityResult,
  quoteCurrency: string,
): number | undefined {
  const durationMs = stored.episodeId ? repository.episodeDuration(stored.episodeId) : 0;

  if (opportunity.strategy === 'S2') {
    const outputAmount = opportunity.requestedNotional.plus(opportunity.depthNetProfit);
    const effectiveRatio = opportunity.requestedNotional.gt(0)
      ? outputAmount.div(opportunity.requestedNotional)
      : new Decimal(1);
    return repository.recordPaperTrade({
      opportunityId: stored.id,
      requestedNotional: opportunity.requestedNotional,
      simulatedBaseAmount: opportunity.requestedNotional,
      buyPriceAverage: new Decimal(1),
      sellPriceAverage: effectiveRatio,
      fees: Decimal.max(0, opportunity.grossSpread.minus(opportunity.depthNetProfit)),
      gasCost: ZERO,
      netProfit: opportunity.depthNetProfit,
      result: 'SIMULATED',
      executedAt: opportunity.sampledAt,
      durationMs,
      expectedFailureReasons: opportunity.rejectionReasons,
      fillQuality: {
        strategy: 'S2',
        inputAsset: quoteCurrency,
        inputAmount: opportunity.requestedNotional.toFixed(),
        outputAsset: quoteCurrency,
        outputAmount: outputAmount.toFixed(),
        effectiveOutputRatio: effectiveRatio.toFixed(),
        ...(opportunity.fillQuality ?? {}),
      },
    });
  }

  if (opportunity.strategy !== 'S3' && opportunity.strategy !== 'S4') return undefined;
  const strategyFill =
    opportunity.fillQuality && typeof opportunity.fillQuality === 'object'
      ? opportunity.fillQuality
      : undefined;
  const simulatedBaseAmount = new Decimal(
    opportunity.strategy === 'S3'
      ? (fillValue(strategyFill, 'cex', 'executableBaseAmount') ?? '0')
      : (fillValue(strategyFill, 'buyLeg', 'outputAfterTaxAndFees') ?? '0'),
  );
  return repository.recordPaperTrade({
    opportunityId: stored.id,
    requestedNotional: opportunity.requestedNotional,
    simulatedBaseAmount,
    buyPriceAverage: opportunity.expectedBuyPrice ?? ZERO,
    sellPriceAverage: opportunity.expectedSellPrice ?? ZERO,
    fees: Decimal.max(0, opportunity.grossSpread.minus(opportunity.depthNetProfit)),
    gasCost: new Decimal(opportunity.metadata?.gasCostUsd ?? '0'),
    netProfit: opportunity.depthNetProfit,
    result: 'SIMULATED',
    executedAt: opportunity.sampledAt,
    durationMs,
    expectedFailureReasons: opportunity.rejectionReasons,
    fillQuality: opportunity.fillQuality ?? {},
  });
}
