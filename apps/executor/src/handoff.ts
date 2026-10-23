import { Decimal, marketBaseMultiplier, type MarketMetadata } from '@arb/core';
import type {
  ArbitrageRepository,
  LoadedOpportunity,
  OpportunityExecutionReference,
} from '@arb/storage';
import type {
  CexLiveExecutor,
  ExecutionVenue,
  LiveExecutionRequest,
  LiveExecutionResult,
} from './coordinator.js';

export interface HandoffSelectionOptions {
  maxAgeMs: number;
  now?: number;
  opportunityId?: number;
}

export interface S1HandoffSelection {
  loaded: LoadedOpportunity;
  batchId: string;
  ageMs: number;
}

export type HandoffSelectionResult =
  | { ok: true; selection: S1HandoffSelection }
  | {
      ok: false;
      reason: 'no_s1_opportunity' | 'stale_s1_opportunity' | 'opportunity_already_executed';
      ageMs?: number;
      batchId?: string;
      priorExecution?: OpportunityExecutionReference;
    };

export type BuildHandoffResult =
  { ok: true; request: LiveExecutionRequest } | { ok: false; reasons: string[] };

export type HandoffRunStatus =
  | 'AWAITING_CONFIRMATION'
  | 'LIVE_DISABLED'
  | 'CONFIRMATION_MISMATCH'
  | 'DUPLICATE_OPPORTUNITY'
  | 'EXECUTED';

export interface HandoffRunResult {
  status: HandoffRunStatus;
  batchId: string;
  reasons: string[];
  execution?: LiveExecutionResult;
}

export interface HandoffExecutionOptions {
  repository: ArbitrageRepository;
  request: LiveExecutionRequest;
  batchId: string;
  liveEnabled: boolean;
  executeRequested: boolean;
  confirmedBatchId?: string;
  engine: Pick<CexLiveExecutor, 'execute'>;
  now?: () => number;
}

function instrument(market: MarketMetadata): string {
  return `${market.base}/${market.quote}`.trim().toUpperCase();
}

function multiplierMatches(market: MarketMetadata, stored: string | undefined): boolean {
  if (stored === undefined || stored.trim() === '') return true;
  try {
    return new Decimal(stored).eq(marketBaseMultiplier(market));
  } catch {
    return false;
  }
}

export function s1BatchId(loaded: LoadedOpportunity): string {
  return `S1-${loaded.id}-${loaded.opportunity.sampledAt}`;
}

export function selectS1Handoff(
  repository: ArbitrageRepository,
  options: HandoffSelectionOptions,
): HandoffSelectionResult {
  const now = options.now ?? Date.now();
  const loaded =
    options.opportunityId !== undefined
      ? repository.validS1OpportunityById(options.opportunityId)
      : ((Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
          ? repository.bestValidS1Opportunity({ now, maxAgeMs: options.maxAgeMs })
          : undefined) ?? repository.latestValidS1Opportunity());
  if (!loaded) return { ok: false, reason: 'no_s1_opportunity' };
  const batchId = s1BatchId(loaded);
  const priorExecution = repository.executionForOpportunity(loaded.id);
  if (priorExecution) {
    return {
      ok: false,
      reason: 'opportunity_already_executed',
      batchId,
      priorExecution,
    };
  }
  const ageMs = Math.max(0, now - loaded.opportunity.sampledAt);
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0 || ageMs > options.maxAgeMs) {
    return { ok: false, reason: 'stale_s1_opportunity', batchId, ageMs };
  }
  return { ok: true, selection: { loaded, batchId, ageMs } };
}

export function buildS1ExecutionRequest(input: {
  selection: S1HandoffSelection;
  buy: ExecutionVenue;
  sell: ExecutionVenue;
  confirmedBatchId?: string;
}): BuildHandoffResult {
  const { opportunity } = input.selection.loaded;
  const reasons: string[] = [];
  const buyInstrument = instrument(input.buy.market);
  const sellInstrument = instrument(input.sell.market);
  const expectedInstrument = opportunity.instrumentKey.trim().toUpperCase();
  if (input.buy.adapter.venueId !== opportunity.venueBuy) reasons.push('buy_venue_mismatch');
  if (input.sell.adapter.venueId !== opportunity.venueSell) reasons.push('sell_venue_mismatch');
  if (input.buy.market.venueId !== input.buy.adapter.venueId) reasons.push('buy_market_mismatch');
  if (input.sell.market.venueId !== input.sell.adapter.venueId)
    reasons.push('sell_market_mismatch');
  if (!input.buy.market.active || !input.sell.market.active) reasons.push('market_inactive');
  if (buyInstrument !== sellInstrument || buyInstrument !== expectedInstrument) {
    reasons.push('instrument_mismatch');
  }
  const storedBuySymbol = opportunity.metadata?.buySymbol?.trim();
  const storedSellSymbol = opportunity.metadata?.sellSymbol?.trim();
  if (storedBuySymbol && storedBuySymbol !== input.buy.market.exchangeSymbol) {
    reasons.push('stored_buy_symbol_mismatch');
  }
  if (storedSellSymbol && storedSellSymbol !== input.sell.market.exchangeSymbol) {
    reasons.push('stored_sell_symbol_mismatch');
  }
  if (!multiplierMatches(input.buy.market, opportunity.metadata?.buyBaseMultiplier)) {
    reasons.push('stored_buy_multiplier_mismatch');
  }
  if (!multiplierMatches(input.sell.market, opportunity.metadata?.sellBaseMultiplier)) {
    reasons.push('stored_sell_multiplier_mismatch');
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    request: {
      batchId: input.selection.batchId,
      opportunity,
      opportunityId: input.selection.loaded.id,
      buy: input.buy,
      sell: input.sell,
      confirmedBatchId: input.confirmedBatchId ?? '',
    },
  };
}

export async function runS1Handoff(options: HandoffExecutionOptions): Promise<HandoffRunResult> {
  const { repository, request, batchId } = options;
  const now = options.now ?? Date.now;
  const persistedLiveEnabled = repository.getSetting('live_enabled') === 'true';
  if (!options.liveEnabled || !persistedLiveEnabled) {
    repository.recordAudit(
      'executor',
      'execution_handoff_live_disabled',
      { batchId, liveEnabled: options.liveEnabled, persistedLiveEnabled },
      now(),
    );
    return {
      status: 'LIVE_DISABLED',
      batchId,
      reasons: [
        ...(!options.liveEnabled ? ['config_live_disabled'] : []),
        ...(!persistedLiveEnabled ? ['persisted_live_disabled'] : []),
      ],
    };
  }
  if (!options.executeRequested) {
    repository.recordAudit(
      'executor',
      'execution_handoff_awaiting_confirmation',
      { batchId, opportunityId: request.opportunityId ?? null },
      now(),
    );
    return {
      status: 'AWAITING_CONFIRMATION',
      batchId,
      reasons: ['manual_confirmation_required'],
    };
  }
  if (options.confirmedBatchId !== batchId) {
    repository.recordRiskEvent(
      'warning',
      'execution_confirmation_mismatch',
      'manual batch confirmation did not match the prepared batch',
      { batchId, confirmedBatchId: options.confirmedBatchId ?? null },
      now(),
    );
    return {
      status: 'CONFIRMATION_MISMATCH',
      batchId,
      reasons: ['manual_confirmation_mismatch'],
    };
  }
  if (request.opportunityId !== undefined) {
    const priorExecution = repository.executionForOpportunity(request.opportunityId);
    if (priorExecution) {
      return {
        status: 'DUPLICATE_OPPORTUNITY',
        batchId,
        reasons: [`opportunity_already_executed:${priorExecution.status}`],
      };
    }
  }
  const execution = await options.engine.execute({
    ...request,
    confirmedBatchId: options.confirmedBatchId,
  });
  return { status: 'EXECUTED', batchId, reasons: execution.reasons, execution };
}
