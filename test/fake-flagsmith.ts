// An in-memory stand-in for the Flagsmith Management API endpoints Steward uses.
import type { ApiResponse, ResultsResponse, Transport } from '../src/flagsmith.ts';

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export class FakeFlagsmith implements Transport {
  readonly name = 'fake';
  calls: Call[] = [];
  warehouseStatus = 'connected';
  features: { id: number; name: string; type: string; initial_value: string; multivariate_options: { id: number; key: string | null; string_value: string }[] }[] = [];
  experiments: { id: number; status: string; started_at: string | null; body: any; decision?: unknown }[] = [];
  metrics: { id: number; body: unknown }[] = [];
  results: ResultsResponse = { results: null };
  failOn?: (c: Call) => number | undefined;
  throttleRefresh = false;
  private nextId = 1;

  get writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const c = { method, path, body };
    this.calls.push(c);
    const fail = this.failOn?.(c);
    if (fail) return { status: fail, body: { detail: 'injected failure' } as T };
    const r = (status: number, b: unknown) => ({ status, body: b as T });
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === 'version/') return r(200, { experimentation_enabled: true, image_tag: 'fake' });
    if (method === 'GET' && path.endsWith('/warehouse-connections/')) return r(200, [{ id: 1, status: this.warehouseStatus, name: 'db', total_events_received: 0 }]);
    if (method === 'GET' && (m = /features\/\?search=(.*)$/.exec(path))) return r(200, { results: this.features.filter((f) => f.name === decodeURIComponent(m![1])) });
    if (method === 'POST' && /projects\/\d+\/features\/$/.test(path)) {
      const b = body as { name: string; initial_value: string };
      const f = { id: this.nextId++, name: b.name, type: 'MULTIVARIATE', initial_value: b.initial_value, multivariate_options: [] };
      this.features.push(f);
      return r(201, f);
    }
    if (method === 'POST' && (m = /features\/(\d+)\/mv-options\/$/.exec(path))) {
      const f = this.features.find((x) => x.id === Number(m![1]))!;
      const b = body as { key: string; string_value: string };
      const o = { id: this.nextId++, key: b.key, string_value: b.string_value };
      f.multivariate_options.push(o);
      return r(201, o);
    }
    if (method === 'GET' && (m = /projects\/\d+\/features\/(\d+)\/$/.exec(path))) return r(200, this.features.find((x) => x.id === Number(m![1])));
    if (method === 'POST' && path.endsWith('/experiment-metrics/')) {
      const x = { id: this.nextId++, body };
      this.metrics.push(x);
      return r(201, x);
    }
    if (method === 'POST' && path.endsWith('/experiments/')) {
      const x = { id: this.nextId++, status: 'created', started_at: null, body };
      this.experiments.push(x);
      return r(201, { id: x.id, status: x.status });
    }
    const exp = (id: string) => this.experiments.find((x) => x.id === Number(id))!;
    if (method === 'GET' && (m = /experiments\/(\d+)\/$/.exec(path))) {
      const x = exp(m[1]);
      return r(200, { id: x.id, status: x.status, started_at: x.started_at });
    }
    if (method === 'POST' && (m = /experiments\/(\d+)\/start\/$/.exec(path))) {
      Object.assign(exp(m[1]), { status: 'running', started_at: '2026-11-26T03:00:00Z' });
      return r(200, {});
    }
    if (method === 'POST' && /results\/refresh\/$/.test(path)) {
      if (this.throttleRefresh) return r(429, { detail: 'A refresh was requested recently.' });
      return r(202, null);
    }
    if (method === 'GET' && /results\/$/.test(path)) return r(200, this.results);
    if (method === 'POST' && /exposures\/refresh\/$/.test(path)) return r(this.throttleRefresh ? 429 : 202, null);
    if (method === 'GET' && /exposures\/$/.test(path)) return r(200, { exposures: { as_of: null, payload: { excluded_identities: 0 } } });
    if (method === 'POST' && (m = /experiments\/(\d+)\/complete\/$/.exec(path))) {
      Object.assign(exp(m[1]), { status: 'completed', decision: body });
      return r(200, {});
    }
    if (method === 'GET' && /featurestates\//.test(path)) return r(200, { results: [{ enabled: true, feature_state_value: 'Checkout', multivariate_feature_state_values: [] }] });
    return r(404, { detail: `fake has no route for ${method} ${path}` });
  }
}

export function resultsFor(arms: Record<string, { n: number; sum: number }>, inference: Record<string, { lift: number; ci_low: number; ci_high: number; chance_to_win: number }>, srm: number | null = null, asOf = '2099-01-01T00:00:00Z'): ResultsResponse {
  return {
    results: {
      as_of: asOf,
      last_error_at: null,
      refresh_requested_at: asOf,
      is_final: false,
      payload: { metrics: [{ metric_id: 1, variants: arms, inference }], srm_p_value: srm },
    },
  };
}
