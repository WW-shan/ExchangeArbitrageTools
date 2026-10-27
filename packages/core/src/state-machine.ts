export type BatchState =
  | 'IDLE'
  | 'OPPORTUNITY_FOUND'
  | 'PREFLIGHT_CHECK'
  | 'PREFLIGHT_FAILED'
  | 'LEG1_SUBMITTING'
  | 'LEG1_RECONCILING'
  | 'LEG1_REJECTED'
  | 'LEG1_PARTIAL'
  | 'LEG1_UNKNOWN'
  | 'HEDGE_DECISION'
  | 'LEG2_SUBMITTING'
  | 'LEG2_RECONCILING'
  | 'LEG2_REJECTED'
  | 'LEG2_PARTIAL'
  | 'LEG2_UNKNOWN'
  | 'PARALLEL_SUBMITTING'
  | 'PARALLEL_RECONCILING'
  | 'PARALLEL_REJECTED'
  | 'BALANCE_MISMATCH'
  | 'SAFE_STOP'
  | 'CLOSED';

const transitions: Readonly<Record<BatchState, readonly BatchState[]>> = {
  IDLE: ['OPPORTUNITY_FOUND'],
  OPPORTUNITY_FOUND: ['PREFLIGHT_CHECK'],
  PREFLIGHT_CHECK: [
    'PREFLIGHT_FAILED',
    'BALANCE_MISMATCH',
    'LEG1_SUBMITTING',
    'PARALLEL_SUBMITTING',
    'SAFE_STOP',
  ],
  PREFLIGHT_FAILED: [],
  LEG1_SUBMITTING: ['LEG1_RECONCILING', 'LEG1_REJECTED', 'LEG1_UNKNOWN', 'SAFE_STOP'],
  LEG1_RECONCILING: ['HEDGE_DECISION', 'LEG1_PARTIAL', 'LEG1_UNKNOWN', 'CLOSED', 'SAFE_STOP'],
  LEG1_REJECTED: [],
  LEG1_PARTIAL: ['HEDGE_DECISION', 'SAFE_STOP', 'CLOSED'],
  LEG1_UNKNOWN: ['LEG1_RECONCILING', 'SAFE_STOP'],
  HEDGE_DECISION: ['LEG2_SUBMITTING', 'LEG1_PARTIAL', 'SAFE_STOP'],
  LEG2_SUBMITTING: ['LEG2_RECONCILING', 'LEG2_REJECTED', 'LEG2_UNKNOWN', 'SAFE_STOP'],
  LEG2_RECONCILING: ['CLOSED', 'LEG2_PARTIAL', 'LEG2_UNKNOWN', 'SAFE_STOP'],
  LEG2_REJECTED: ['SAFE_STOP'],
  LEG2_PARTIAL: ['SAFE_STOP'],
  LEG2_UNKNOWN: ['LEG2_RECONCILING', 'SAFE_STOP'],
  PARALLEL_SUBMITTING: ['PARALLEL_RECONCILING', 'SAFE_STOP'],
  PARALLEL_RECONCILING: ['CLOSED', 'PARALLEL_REJECTED', 'SAFE_STOP'],
  PARALLEL_REJECTED: [],
  BALANCE_MISMATCH: ['SAFE_STOP'],
  SAFE_STOP: ['LEG1_RECONCILING', 'LEG2_RECONCILING', 'PARALLEL_RECONCILING', 'CLOSED'],
  CLOSED: [],
};

export class InvalidStateTransitionError extends Error {
  constructor(
    readonly from: BatchState,
    readonly to: BatchState,
  ) {
    super(`invalid execution transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export function canTransition(from: BatchState, to: BatchState): boolean {
  return transitions[from].includes(to);
}

export class BatchStateMachine {
  #state: BatchState;
  readonly #history: BatchState[];

  constructor(initial: BatchState = 'IDLE') {
    this.#state = initial;
    this.#history = [initial];
  }

  get state(): BatchState {
    return this.#state;
  }

  get history(): readonly BatchState[] {
    return this.#history;
  }

  transition(to: BatchState): void {
    if (!canTransition(this.#state, to)) throw new InvalidStateTransitionError(this.#state, to);
    this.#state = to;
    this.#history.push(to);
  }

  isTerminal(): boolean {
    return ['CLOSED', 'PREFLIGHT_FAILED', 'LEG1_REJECTED', 'PARALLEL_REJECTED'].includes(
      this.#state,
    );
  }
}
