// The approval state machine. Every Flagsmith write is preceded by a gate check:
// the record must be in the matching "approved-to-*" state, and the approval must cover the
// exact plan (same hash) that is about to be written.
import { planHash, type Plan } from './plan.ts';

export type State =
  | 'draft'
  | 'approved-to-create'
  | 'created'
  | 'approved-to-start'
  | 'running'
  | 'approved-to-ship'
  | 'ended'
  | 'rejected';

export type Gate = 'create' | 'start' | 'ship';

export type ShipDecision = { kind: 'variant'; key: string } | { kind: 'control' } | { kind: 'disable' };

export interface Approval {
  gate: Gate;
  planHash: string;
  approvedBy: string;
  approvedAt: string;
  decision?: ShipDecision;
  /** For ship: the results snapshot the approver looked at, and any override reason. */
  resultsAsOf?: string | null;
  verdict?: string;
  override?: string;
}

export interface Rejection {
  gate: Gate;
  rejectedBy: string;
  rejectedAt: string;
  reason: string;
}

/** State in which a gate may be approved, and the state the approval moves to. */
export const GATES: Record<Gate, { from: State; approved: State; done: State; action: string }> = {
  create: { from: 'draft', approved: 'approved-to-create', done: 'created', action: 'apply' },
  start: { from: 'created', approved: 'approved-to-start', done: 'running', action: 'start' },
  ship: { from: 'running', approved: 'approved-to-ship', done: 'ended', action: 'ship' },
};

export class GateError extends Error {}

/** Which gate a record is waiting on, if any. */
export function pendingGate(state: State): Gate | null {
  for (const [gate, g] of Object.entries(GATES) as [Gate, (typeof GATES)[Gate]][]) {
    if (g.from === state) return gate;
  }
  return null;
}

export interface GateSubject {
  plan: Plan;
  state: State;
  approvals: Approval[];
}

/** Throws unless the subject holds a valid, current approval for `gate`. Returns that approval. */
export function requireApproval(subject: GateSubject, gate: Gate): Approval {
  const g = GATES[gate];
  if (subject.state === 'rejected') throw new GateError('this plan was rejected; draft a new plan instead');
  if (subject.state !== g.approved) {
    if (subject.state === g.from) {
      throw new GateError(`not approved: "${g.action}" needs a human to run \`steward approve ${subject.plan.id}\` first`);
    }
    throw new GateError(`cannot ${g.action} while the plan is "${subject.state}" (needs "${g.approved}")`);
  }
  const approval = [...subject.approvals].reverse().find((a) => a.gate === gate);
  if (!approval) throw new GateError(`state says approved but no ${gate} approval is recorded; refusing`);
  const current = planHash(subject.plan);
  if (approval.planHash !== current) {
    throw new GateError(
      `the plan changed after it was approved (approved ${approval.planHash.slice(0, 6)}, now ${current.slice(0, 6)}); approve it again`,
    );
  }
  return approval;
}

/** Moves the subject into the approved state for `gate`. Throws if the gate is not pending. */
export function recordApproval(subject: GateSubject, approval: Approval): void {
  const g = GATES[approval.gate];
  if (subject.state !== g.from) {
    throw new GateError(`nothing to approve for "${approval.gate}" while the plan is "${subject.state}"`);
  }
  if (approval.planHash !== planHash(subject.plan)) throw new GateError('approval does not match the current plan');
  subject.approvals.push(approval);
  subject.state = g.approved;
}

export function markDone(subject: GateSubject, gate: Gate): void {
  requireApproval(subject, gate);
  subject.state = GATES[gate].done;
}
