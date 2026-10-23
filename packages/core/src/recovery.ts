export interface StartupRecoveryInput {
  openExecutions: number;
  unresolvedLegs: number;
  persistedKillSwitch: boolean;
  balancesConfirmed: boolean;
}

export interface StartupRecoveryDecision {
  blockExecution: boolean;
  killSwitch: boolean;
  reasons: string[];
}

export function assessStartupRecovery(input: StartupRecoveryInput): StartupRecoveryDecision {
  const reasons: string[] = [];
  if (input.openExecutions > 0) reasons.push('open_executions_require_reconciliation');
  if (input.unresolvedLegs > 0) reasons.push('unresolved_orders_require_reconciliation');
  if (input.persistedKillSwitch) reasons.push('persisted_kill_switch_on');
  if (!input.balancesConfirmed) reasons.push('balances_not_confirmed');
  return {
    blockExecution: reasons.length > 0,
    killSwitch: input.persistedKillSwitch || input.unresolvedLegs > 0 || input.openExecutions > 0,
    reasons,
  };
}
