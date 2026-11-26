// Local persistence: one JSON file per plan in ./plans. No secrets are ever written here.
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from './plan.ts';
import type { Approval, Rejection, State } from './gates.ts';

export interface JournalEntry {
  at: string;
  step: string;
  method: string;
  path: string;
  status: number | string;
}

export interface Resources {
  featureId?: number;
  variantIds?: Record<string, number>;
  metricId?: number;
  experimentId?: number;
}

export interface PlanRecord {
  plan: Plan;
  state: State;
  createdAt: string;
  approvals: Approval[];
  rejections: Rejection[];
  resources: Resources;
  lastRefreshAt?: string;
  lastResults?: unknown;
  journal: JournalEntry[];
}

export class Store {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(id: string): string {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad plan id "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  exists(id: string): boolean {
    return existsSync(this.path(id));
  }

  load(id: string): PlanRecord {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`no plan "${id}" in ${this.dir} (run \`steward list\`)`);
    return JSON.parse(readFileSync(p, 'utf8')) as PlanRecord;
  }

  save(record: PlanRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const p = this.path(record.plan.id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
    renameSync(tmp, p);
  }

  list(): PlanRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('example-'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as PlanRecord)
      .filter((r) => r && r.plan && r.state);
  }
}

export function newRecord(plan: Plan, now = new Date()): PlanRecord {
  return { plan, state: 'draft', createdAt: now.toISOString(), approvals: [], rejections: [], resources: {}, journal: [] };
}
