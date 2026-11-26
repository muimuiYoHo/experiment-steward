// The gated operations. Each one re-checks its approval immediately before calling Flagsmith,
// records every API call in the plan's journal, and saves progress after each resource so an
// interrupted run can resume without duplicating anything.
import { controlAllocation, planHash, type Plan } from './plan.ts';
import { GateError, markDone, requireApproval, recordApproval, type Approval, type ShipDecision } from './gates.ts';
import { FlagsmithApiError, type Flagsmith, type ResultsResponse } from './flagsmith.ts';
import { interpret, type Interpretation } from './report.ts';
import type { PlanRecord, Store } from './store.ts';

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface Deps {
  store: Store;
  flagsmith: () => Flagsmith;
  now?: () => Date;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export class Steward {
  private readonly d: Required<Deps>;
  constructor(deps: Deps) {
    this.d = {
      now: () => new Date(),
      log: () => {},
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...deps,
    } as Required<Deps>;
  }

  private client(record: PlanRecord, step: string): Flagsmith {
    const fs = this.d.flagsmith();
    fs.onCall = (method, path, status) => {
      record.journal.push({ at: this.d.now().toISOString(), step, method, path, status });
    };
    return fs;
  }

  approve(id: string, approvedBy: string, opts: { decision?: ShipDecision; override?: string } = {}): Approval {
    const record = this.d.store.load(id);
    const gate = record.state === 'draft' ? 'create' : record.state === 'created' ? 'start' : record.state === 'running' ? 'ship' : null;
    if (!gate) throw new GateError(`nothing is waiting for approval while the plan is "${record.state}"`);
    const approval: Approval = { gate, planHash: planHash(record.plan), approvedBy, approvedAt: this.d.now().toISOString() };
    if (gate === 'ship') {
      if (!opts.decision) throw new GateError('shipping needs a decision: --decision <variant-key> | control | disable');
      const results = record.lastResults as ResultsResponse | undefined;
      const interp = results ? interpret(record.plan, results) : undefined;
      approval.decision = opts.decision;
      approval.resultsAsOf = interp?.asOf ?? null;
      approval.verdict = interp?.overall.kind ?? 'no-results';
      if (opts.decision.kind === 'variant') {
        const key = opts.decision.key;
        if (!record.plan.variants.some((v) => v.key === key)) throw new GateError(`unknown variant "${key}"`);
        if (interp?.canShipVariant !== key) {
          if (!opts.override?.trim()) {
            throw new GateError(
              `results do not support shipping "${key}" (verdict: ${approval.verdict}). Run \`steward results ${id}\`, or pass --override "<reason>" to ship anyway`,
            );
          }
          approval.override = opts.override.trim();
        }
      }
    }
    recordApproval(record, approval);
    this.d.store.save(record);
    return approval;
  }

  reject(id: string, rejectedBy: string, reason: string): void {
    const record = this.d.store.load(id);
    const gate = record.state === 'draft' ? 'create' : record.state === 'created' ? 'start' : record.state === 'running' ? 'ship' : null;
    if (!gate) throw new GateError(`nothing to reject while the plan is "${record.state}"`);
    record.rejections.push({ gate, rejectedBy, rejectedAt: this.d.now().toISOString(), reason });
    if (gate === 'create') record.state = 'rejected';
    this.d.store.save(record);
  }

  /** Gate 1: create flag, keyed variations, metric and a NOT-started experiment. */
  async apply(id: string): Promise<PlanRecord> {
    const record = this.d.store.load(id);
    requireApproval(record, 'create');
    const plan = record.plan;
    const fs = this.client(record, 'apply');
    const save = () => this.d.store.save(record);
    try {
      const warehouses = await fs.warehouses();
      if (!warehouses.some((w) => w.status === 'connected')) {
        throw new GateError('this environment has no connected warehouse; connect one (Environment settings → Warehouse) before creating experiments');
      }
      const res = record.resources;
      if (res.featureId === undefined) {
        const existing = await fs.findFeature(plan.flag.name);
        if (existing) throw new GateError(`a flag named "${plan.flag.name}" already exists (id ${existing.id}); Steward will not take over an existing flag`);
        const feature = await fs.createFeature(plan.flag.name, plan.flag.controlValue, plan.flag.description);
        res.featureId = feature.id;
        this.d.log(`  ✓ created multivariate flag ${plan.flag.name} (id ${feature.id}), control value "${plan.flag.controlValue}"`);
        save();
      }
      res.variantIds ??= {};
      for (const v of plan.variants) {
        if (res.variantIds[v.key] !== undefined) continue;
        const opt = await fs.addVariant(res.featureId, v.key, v.value);
        res.variantIds[v.key] = opt.id;
        this.d.log(`  ✓ added variation key=${v.key} value="${v.value}" (id ${opt.id})`);
        save();
      }
      const feature = await fs.getFeature(res.featureId);
      const unkeyed = feature.multivariate_options.filter((o) => !o.key);
      if (unkeyed.length) throw new GateError(`flag has ${unkeyed.length} variation(s) without a key; they would record no exposures`);
      if (res.metricId === undefined) {
        const metric = await fs.createMetric(plan.metric);
        res.metricId = metric.id;
        this.d.log(`  ✓ created metric "${plan.metric.name}" on event "${plan.metric.event}" (id ${metric.id})`);
        save();
      }
      if (res.experimentId === undefined) {
        const exp = await fs.createExperiment(experimentBody(plan, res.featureId, res.metricId, res.variantIds));
        res.experimentId = exp.id;
        this.d.log(`  ✓ created experiment "${plan.name}" (id ${exp.id}), status ${exp.status}, NOT started`);
        save();
      }
      const exp = await fs.getExperiment(res.experimentId);
      if (exp.status !== 'created') throw new GateError(`expected the experiment to be "created", Flagsmith says "${exp.status}"`);
      markDone(record, 'create');
      return record;
    } finally {
      save();
    }
  }

  /** Gate 2: start the experiment (locks the flag, turns the rollout on). */
  async start(id: string): Promise<PlanRecord> {
    const record = this.d.store.load(id);
    requireApproval(record, 'start');
    const expId = record.resources.experimentId;
    if (expId === undefined) throw new GateError('no experiment recorded for this plan');
    const fs = this.client(record, 'start');
    try {
      const before = await fs.getExperiment(expId);
      if (before.status !== 'created') throw new GateError(`experiment is "${before.status}", expected "created"`);
      await fs.startExperiment(expId);
      const after = await fs.getExperiment(expId);
      if (after.status !== 'running') throw new GateError(`start did not take effect: status is "${after.status}"`);
      this.d.log(`  ✓ experiment ${expId} is running (started ${after.started_at})`);
      markDone(record, 'start');
      return record;
    } finally {
      this.d.store.save(record);
    }
  }

  /** Read-only for flag configuration: refreshes (at most every 5 minutes) and reads results. */
  async results(id: string, opts: { refresh?: boolean; waitMs?: number } = {}): Promise<{ record: PlanRecord; interp: Interpretation; refreshed: boolean; nextRefreshAt?: Date; throttled?: string }> {
    const record = this.d.store.load(id);
    const expId = record.resources.experimentId;
    if (expId === undefined) throw new GateError('no experiment yet: approve and apply the plan first');
    const fs = this.client(record, 'results');
    const now = this.d.now();
    const last = record.lastRefreshAt ? new Date(record.lastRefreshAt) : undefined;
    const allowed = !last || now.getTime() - last.getTime() >= REFRESH_INTERVAL_MS;
    let refreshed = false;
    let res: ResultsResponse;
    try {
      let throttled: string | undefined;
      if (opts.refresh !== false && allowed && record.state !== 'ended') {
        try {
          await fs.refreshResults(expId);
          record.lastRefreshAt = now.toISOString();
          refreshed = true;
        } catch (e) {
          // Flagsmith allows one refresh per 5 minutes and answers 429 otherwise: show cached results.
          if (!(e instanceof FlagsmithApiError) || e.status !== 429) throw e;
          throttled = (e.body as { detail?: string } | null)?.detail ?? 'refresh throttled by Flagsmith';
        }
      }
      if (refreshed) {
        res = await fs.getResults(expId);
        const deadline = Date.now() + (opts.waitMs ?? 60_000);
        while (!isFresh(res, record.lastRefreshAt!) && Date.now() < deadline) {
          await this.d.sleep(2000);
          res = await fs.getResults(expId);
        }
      } else {
        res = await fs.getResults(expId);
      }
      record.lastResults = res;
      return {
        record,
        interp: interpret(record.plan, res),
        refreshed,
        nextRefreshAt: last && !allowed ? new Date(last.getTime() + REFRESH_INTERVAL_MS) : undefined,
        throttled,
      };
    } finally {
      this.d.store.save(record);
    }
  }

  /** Gate 3: end the experiment with the approved rollout decision. */
  async ship(id: string): Promise<{ record: PlanRecord; decision: ShipDecision; served?: unknown }> {
    const record = this.d.store.load(id);
    const approval = requireApproval(record, 'ship');
    const decision = approval.decision;
    if (!decision) throw new GateError('ship approval carries no decision');
    const { experimentId, variantIds, featureId } = record.resources;
    if (experimentId === undefined || featureId === undefined) throw new GateError('no experiment recorded for this plan');
    const fs = this.client(record, 'ship');
    try {
      const variantId = decision.kind === 'variant' ? variantIds?.[decision.key] : undefined;
      if (decision.kind === 'variant' && variantId === undefined) throw new GateError(`no Flagsmith id recorded for variant "${decision.key}"`);
      await fs.completeExperiment(experimentId, decision.kind, variantId);
      const after = await fs.getExperiment(experimentId);
      if (after.status !== 'completed') throw new GateError(`experiment did not end: status is "${after.status}"`);
      const state = await fs.environmentFeatureState(featureId).catch(() => undefined);
      markDone(record, 'ship');
      return { record, decision, served: state };
    } finally {
      this.d.store.save(record);
    }
  }
}

function isFresh(res: ResultsResponse, requestedAt: string): boolean {
  const r = res.results;
  if (!r?.as_of || !r.payload) return false;
  return new Date(r.as_of).getTime() >= new Date(requestedAt).getTime() - 1000;
}

export function experimentBody(plan: Plan, featureId: number, metricId: number, variantIds: Record<string, number>) {
  return {
    feature: featureId,
    name: plan.name,
    hypothesis: plan.hypothesis,
    metrics: [{ metric: metricId, expected_direction: plan.metric.expectedDirection }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: plan.rolloutPercentage,
      feature_state_value: { type: 'string', value: plan.flag.controlValue },
      multivariate_feature_state_values: plan.variants.map((v) => ({
        multivariate_feature_option: variantIds[v.key],
        percentage_allocation: v.allocation,
      })),
    },
  };
}

export { controlAllocation };
