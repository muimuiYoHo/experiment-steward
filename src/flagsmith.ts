// Flagsmith adapter. Two interchangeable transports reach the same Management API endpoints:
//   http: direct fetch with `Authorization: Api-Key ...`
//   cli:  `flagsmith api <path> -X <method> --input -` (Flagsmith CLI v2 supplies the credentials)
import { spawn } from 'node:child_process';
import type { Config } from './config.ts';

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface Transport {
  readonly name: string;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>>;
}

export class FlagsmithApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(method: string, path: string, status: number, body: unknown) {
    super(`${method} ${path} failed with ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 600));
    this.status = status;
    this.body = body;
  }
}

export class HttpTransport implements Transport {
  readonly name = 'Management API (HTTP)';
  private readonly apiUrl: string;
  private readonly apiKey: string;
  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }
  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.apiUrl}/${path.replace(/^\/+/, '')}`, {
      method,
      headers: { Authorization: `Api-Key ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    return { status: res.status, body: parsed as T };
  }
}

export class CliTransport implements Transport {
  readonly name = 'Flagsmith CLI (flagsmith api)';
  private readonly bin: string;
  constructor(bin = process.env.FLAGSMITH_CLI ?? 'flagsmith') {
    this.bin = bin;
  }
  request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const args = ['api', path.replace(/^\/+/, ''), '-X', method, '--include', '--no-input'];
    if (body !== undefined) args.push('--input', '-');
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', () => {
        const m = /^HTTP\/[\d.]+ (\d{3})/m.exec(out);
        if (!m) return reject(new Error(`flagsmith CLI gave no HTTP status: ${err.trim() || out.slice(0, 200)}`));
        const split = out.search(/\r?\n\r?\n/);
        const raw = split >= 0 ? out.slice(split).trim() : '';
        let parsed: unknown = raw;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          /* keep text */
        }
        resolve({ status: Number(m[1]), body: parsed as T });
      });
      child.stdin.end(body === undefined ? '' : JSON.stringify(body));
    });
  }
}

export function makeTransport(cfg: Config): Transport {
  if (cfg.transport === 'cli') return new CliTransport();
  if (!cfg.apiKey) {
    throw new Error(
      'no Flagsmith Management API key found: set FLAGSMITH_API_KEY (or the CLI-style host-scoped variable) in your shell or a local .env',
    );
  }
  return new HttpTransport(cfg.apiUrl, cfg.apiKey);
}

// ---- Typed API surface --------------------------------------------------------------------

export interface Feature {
  id: number;
  name: string;
  type: string;
  initial_value: string | null;
  multivariate_options: { id: number; key: string | null; string_value: string | null }[];
}
export interface Warehouse {
  id: number;
  status: string;
  name: string;
  total_events_received: number | null;
}
export interface Experiment {
  id: number;
  name: string;
  status: 'created' | 'running' | 'paused' | 'completed';
  started_at: string | null;
  ended_at: string | null;
  rollout_decision?: string | null;
}
export interface ResultsPayload {
  metrics: {
    metric_id: number;
    variants: Record<string, { n: number; sum: number; sum_squares?: number }>;
    inference: Record<string, { lift: number; ci_low: number; ci_high: number; chance_to_win: number }>;
  }[];
  srm_p_value: number | null;
}
export interface ResultsResponse {
  results: {
    as_of: string | null;
    last_error_at: string | null;
    refresh_requested_at: string | null;
    payload: ResultsPayload | null;
    is_final: boolean;
  } | null;
}

export interface ExposuresResponse {
  exposures: {
    as_of: string | null;
    payload: { excluded_identities: number; timeseries?: unknown } | null;
  } | null;
}

export type CallLog = (method: string, path: string, status: number) => void;

export class Flagsmith {
  readonly transport: Transport;
  private readonly env: string;
  private readonly project: number;
  onCall: CallLog = () => {};

  constructor(transport: Transport, environmentKey: string, projectId: number) {
    this.transport = transport;
    this.env = environmentKey;
    this.project = projectId;
  }

  private async call<T>(method: string, path: string, body?: unknown, ok: number[] = [200, 201, 202, 204]): Promise<T> {
    const res = await this.transport.request<T>(method, path, body);
    this.onCall(method, path, res.status);
    if (!ok.includes(res.status)) throw new FlagsmithApiError(method, path, res.status, res.body);
    return res.body;
  }

  private envPath(rest: string): string {
    return `api/v1/environments/${this.env}/${rest}`;
  }

  version(): Promise<{ experimentation_enabled?: boolean; image_tag?: string }> {
    return this.call('GET', 'version/');
  }
  warehouses(): Promise<Warehouse[]> {
    return this.call('GET', this.envPath('warehouse-connections/'));
  }
  async findFeature(name: string): Promise<Feature | undefined> {
    const page = await this.call<{ results: Feature[] }>('GET', `api/v1/projects/${this.project}/features/?search=${encodeURIComponent(name)}`);
    return page.results.find((f) => f.name === name);
  }
  getFeature(id: number): Promise<Feature> {
    return this.call('GET', `api/v1/projects/${this.project}/features/${id}/`);
  }
  createFeature(name: string, controlValue: string, description: string): Promise<Feature> {
    return this.call('POST', `api/v1/projects/${this.project}/features/`, {
      name,
      type: 'MULTIVARIATE',
      initial_value: controlValue,
      default_enabled: true,
      description,
    });
  }
  addVariant(featureId: number, key: string, value: string): Promise<{ id: number; key: string }> {
    return this.call('POST', `api/v1/projects/${this.project}/features/${featureId}/mv-options/`, {
      feature: featureId,
      type: 'unicode',
      string_value: value,
      key,
      default_percentage_allocation: 0,
    });
  }
  createMetric(m: { name: string; event: string; aggregation: string; direction: string }): Promise<{ id: number }> {
    return this.call('POST', this.envPath('experiment-metrics/'), {
      name: m.name,
      aggregation: m.aggregation,
      direction: m.direction,
      definition: { version: 1, event: m.event },
    });
  }
  createExperiment(body: unknown): Promise<Experiment> {
    return this.call('POST', this.envPath('experiments/'), body);
  }
  getExperiment(id: number): Promise<Experiment> {
    return this.call('GET', this.envPath(`experiments/${id}/`));
  }
  startExperiment(id: number): Promise<Experiment> {
    return this.call('POST', this.envPath(`experiments/${id}/start/`));
  }
  refreshResults(id: number): Promise<ResultsResponse> {
    return this.call('POST', this.envPath(`experiments/${id}/results/refresh/`));
  }
  getResults(id: number): Promise<ResultsResponse> {
    return this.call('GET', this.envPath(`experiments/${id}/results/`));
  }
  refreshExposures(id: number): Promise<unknown> {
    return this.call('POST', this.envPath(`experiments/${id}/exposures/refresh/`));
  }
  getExposures(id: number): Promise<ExposuresResponse> {
    return this.call('GET', this.envPath(`experiments/${id}/exposures/`));
  }
  completeExperiment(id: number, decision: 'control' | 'variant' | 'disable', variantId?: number): Promise<Experiment> {
    const body: Record<string, unknown> = { rollout_decision: decision };
    if (variantId !== undefined) body.rollout_variant = variantId;
    return this.call('POST', this.envPath(`experiments/${id}/complete/`), body);
  }
  /** What the environment serves by default now (used to verify a ship). */
  async environmentFeatureState(featureId: number): Promise<{ enabled: boolean; feature_state_value: unknown; multivariate_feature_state_values?: unknown[] } | undefined> {
    const page = await this.call<{ results: { enabled: boolean; feature_state_value: unknown; multivariate_feature_state_values?: unknown[] }[] }>(
      'GET',
      `api/v1/environments/${this.env}/featurestates/?feature=${featureId}`,
    );
    return page.results[0];
  }
}
