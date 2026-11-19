import type { ArbitrageRepository } from '@arb/storage';
import type { RecoveryVenue } from './bootstrap.js';
import type { ExecutorConfig } from './config.js';
import {
  executeResidualHedge,
  planResidualHedge,
  type ResidualHedgeResult,
} from './residual-hedge.js';

export interface AutomaticResidualHedgeResult extends ResidualHedgeResult {
  attempted: boolean;
}

// A blocked recovery plan is usually a momentarily unusable book (fetch hiccup,
// crossed snapshot, exchange timestamp lagging). Retrying within the same
// SAFE_STOP window is what keeps a recoverable position from waiting for a human.
const RETRYABLE_PLAN_REASONS = new Set([
  'residual_book_unavailable',
  'residual_book_stale_or_invalid',
  'residual_venue_not_fok_eligible',
  'insufficient_leg2_depth',
]);

export async function attemptAutomaticResidualHedge(input: {
  repository: ArbitrageRepository;
  config: ExecutorConfig;
  adapters: Readonly<Record<string, RecoveryVenue>>;
  batchId: string;
  now?: number;
}): Promise<AutomaticResidualHedgeResult> {
  const { repository, config, adapters, batchId } = input;
  const settings = config.autoRotation.residualHedge;
  if (!settings.enabled) {
    return { status: 'BLOCKED', reasons: ['auto_residual_hedge_disabled'], attempted: false };
  }
  if (repository.getSetting('auto_execution_enabled') !== 'true') {
    return {
      status: 'BLOCKED',
      reasons: ['persisted_automatic_execution_disabled'],
      attempted: false,
    };
  }
  let planned = await planResidualHedge({
    repository,
    config,
    adapters,
    batchId,
    minProfitUsd: settings.maxLossUsd.negated(),
    maxBaselineAgeMs: settings.maxBaselineAgeMs,
  });
  for (let attempt = 1; attempt < settings.maxAttempts; attempt += 1) {
    if (planned.status === 'PLANNED' && planned.plan) break;
    if (!planned.reasons.some((reason) => RETRYABLE_PLAN_REASONS.has(reason))) break;
    await new Promise((resolve) => setTimeout(resolve, settings.retryDelayMs));
    planned = await planResidualHedge({
      repository,
      config,
      adapters,
      batchId,
      minProfitUsd: settings.maxLossUsd.negated(),
      maxBaselineAgeMs: settings.maxBaselineAgeMs,
    });
  }
  if (planned.status !== 'PLANNED' || !planned.plan) {
    return { ...planned, attempted: false };
  }
  // Retry the hedge itself, not just the plan.
  //
  // Measured 2026-11-19 04:56 UTC: execution 150 bought 2880 WARD on Gate and
  // its Bitget sell leg filled zero. The plan succeeded, the FOK was rejected,
  // and the supervisor gave up after ONE attempt - leaving 2880 WARD naked and
  // the process exited. A FOK that misses once is routinely fillable a second
  // later: the book is moving, not gone.
  //
  // Every attempt is a fresh plan (fresh book, fresh price), so this cannot
  // chase a stale quote. A definitive no-fill is retryable; an AMBIGUOUS
  // submission is not, and stays latched for a human.
  let executed = await executeResidualHedge({
    repository,
    config,
    adapters,
    batchId,
    plan: planned.plan,
    origin: 'automatic',
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const retryableOutcomes = new Set(['hedge_fok_not_filled']);
  for (let attempt = 1; attempt < settings.maxAttempts; attempt += 1) {
    if (executed.status === 'HEDGED') break;
    if (!executed.reasons.some((reason) => retryableOutcomes.has(reason))) break;
    await new Promise((resolve) => setTimeout(resolve, settings.retryDelayMs));
    const retryPlan = await planResidualHedge({
      repository,
      config,
      adapters,
      batchId,
      minProfitUsd: settings.maxLossUsd.negated(),
      maxBaselineAgeMs: settings.maxBaselineAgeMs,
    });
    if (retryPlan.status !== 'PLANNED' || !retryPlan.plan) {
      break;
    }
    executed = await executeResidualHedge({
      repository,
      config,
      adapters,
      batchId,
      plan: retryPlan.plan,
      origin: 'automatic',
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }
  return { ...executed, attempted: true };
}
