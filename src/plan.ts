// The experiment plan: the single artefact a human reviews and approves.
// Anything that changes the plan after approval changes its hash and voids the approval.
import { createHash } from 'node:crypto';

export interface VariantSpec {
  /** Stable key recorded on exposures. Flagsmith ignores exposures for variations without a key. */
  key: string;
  /** The flag value this variation serves. */
  value: string;
  /** Share of enrolled identities (percent). Control receives the remainder. */
  allocation: number;
}

export interface MetricSpec {
  name: string;
  /** Event name sent with trackEvent. Case-sensitive; must match exactly. */
  event: string;
  aggregation: 'occurrence' | 'count' | 'sum' | 'mean';
  direction: 'up' | 'down';
  expectedDirection: 'increase' | 'decrease' | 'not_increase' | 'not_decrease';
}

export interface Plan {
  id: string;
  name: string;
  hypothesis: string;
  flag: { name: string; controlValue: string; description: string };
  variants: VariantSpec[];
  metric: MetricSpec;
  /** Percentage of identities enrolled in the experiment. */
  rolloutPercentage: number;
  /** Who drafted the plan (for the audit trail), e.g. "ai-agent" or a person. */
  draftedBy: string;
}

export class PlanError extends Error {}

const FLAG_NAME = /^[a-z0-9_]{2,64}$/;
const KEY = /^[a-z0-9_]{1,64}$/;

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plan';
}

export function controlAllocation(plan: Plan): number {
  return round2(100 - plan.variants.reduce((sum, v) => sum + v.allocation, 0));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Validate a plan, returning a list of problems (empty when valid). */
export function validatePlan(plan: Plan): string[] {
  const problems: string[] = [];
  if (!plan.name?.trim()) problems.push('name is required');
  if (!plan.hypothesis?.trim()) problems.push('hypothesis is required: say what you expect and why');
  if (!FLAG_NAME.test(plan.flag?.name ?? '')) problems.push('flag.name must be 2-64 chars of a-z, 0-9 or _');
  if (!plan.flag?.controlValue?.trim()) problems.push('flag.controlValue is required (the value control keeps serving)');
  if (!Array.isArray(plan.variants) || plan.variants.length === 0) problems.push('at least one variant is required');
  const keys = new Set<string>();
  for (const v of plan.variants ?? []) {
    if (!KEY.test(v.key ?? '')) problems.push(`variant key "${v.key}" must be 1-64 chars of a-z, 0-9 or _`);
    if (v.key === 'control') problems.push('"control" is reserved by Flagsmith for the flag\'s own value');
    if (keys.has(v.key)) problems.push(`duplicate variant key "${v.key}"`);
    keys.add(v.key);
    if (!v.value?.trim()) problems.push(`variant "${v.key}" needs a value`);
    if (v.value === plan.flag?.controlValue) problems.push(`variant "${v.key}" serves the same value as control`);
    if (!(v.allocation > 0 && v.allocation < 100)) problems.push(`variant "${v.key}" allocation must be between 0 and 100`);
  }
  if (plan.variants?.length && controlAllocation(plan) <= 0) problems.push('variant allocations leave nothing for control');
  if (!plan.metric?.event?.trim()) problems.push('metric.event is required (the conversion event name)');
  if (plan.metric?.event?.startsWith('$')) problems.push('event names starting with $ are reserved by Flagsmith');
  if (!plan.metric?.name?.trim()) problems.push('metric.name is required');
  if (!(plan.rolloutPercentage > 0 && plan.rolloutPercentage <= 100)) problems.push('rolloutPercentage must be in (0, 100]');
  return problems;
}

export interface DraftInput {
  name?: string;
  hypothesis?: string;
  flag: string;
  controlValue?: string;
  variants: string[]; // "key=value" or "key=value@allocation"
  event: string;
  metricName?: string;
  aggregation?: MetricSpec['aggregation'];
  rollout?: number;
  draftedBy?: string;
}

/** Build a plan from command-line style input. Allocations default to an even split with control. */
export function draftPlan(input: DraftInput): Plan {
  const parsed = input.variants.map((raw) => {
    const m = /^([^=]+)=(.*?)(?:@(\d+(?:\.\d+)?))?$/.exec(raw);
    if (!m) throw new PlanError(`cannot read variant "${raw}"; use key=value or key=value@allocation`);
    return { key: m[1].trim(), value: m[2].trim(), allocation: m[3] === undefined ? undefined : Number(m[3]) };
  });
  const even = round2(100 / (parsed.length + 1));
  const variants: VariantSpec[] = parsed.map((v) => ({ key: v.key, value: v.value, allocation: v.allocation ?? even }));
  const plan: Plan = {
    id: slug(input.name ?? input.flag),
    name: input.name ?? `${input.flag} experiment`,
    hypothesis: input.hypothesis ?? '',
    flag: { name: input.flag, controlValue: input.controlValue ?? 'control', description: input.name ?? '' },
    variants,
    metric: {
      name: input.metricName ?? input.event,
      event: input.event,
      aggregation: input.aggregation ?? 'occurrence',
      direction: 'up',
      expectedDirection: 'increase',
    },
    rolloutPercentage: input.rollout ?? 100,
    draftedBy: input.draftedBy ?? 'ai-agent',
  };
  return plan;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over a canonical encoding of the plan. */
export function planHash(plan: Plan): string {
  return createHash('sha256').update(canonical(plan)).digest('hex');
}

/** Short code the approver types to confirm they saw *this* version of the plan. */
export function approvalCode(plan: Plan): string {
  return planHash(plan).slice(0, 6);
}
