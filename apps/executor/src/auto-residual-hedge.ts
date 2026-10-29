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
  const planned = await planResidualHedge({
    repository,
    config,
    adapters,
    batchId,
    minProfitUsd: settings.maxLossUsd.negated(),
    maxBaselineAgeMs: settings.maxBaselineAgeMs,
  });
  if (planned.status !== 'PLANNED' || !planned.plan) {
    return { ...planned, attempted: false };
  }
  const executed = await executeResidualHedge({
    repository,
    config,
    adapters,
    batchId,
    plan: planned.plan,
    origin: 'automatic',
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { ...executed, attempted: true };
}
