// Simulated test traffic through the official Node SDK, exactly as a real service would call it:
// identify a stable identity, evaluate the experiment flag where the variation is "shown"
// (getExperimentFlag records the exposure), and track the conversion event for some identities.
// The conversion probabilities are inputs to the simulation, not results: results come only
// from Flagsmith's analysis.
import { Flagsmith } from '@flagsmith/nodejs';
import type { Plan } from './plan.ts';

export interface TrafficOptions {
  apiUrl: string;
  environmentKey: string;
  users: number;
  /** Identity prefix; identities are `${prefix}-0001`, `${prefix}-0002`, ... so reruns reuse them. */
  prefix: string;
  /** Simulated conversion probability per arm key ("control" or a variant key). */
  rates: Record<string, number>;
  seed?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface TrafficSummary {
  exposures: Record<string, number>;
  conversions: Record<string, number>;
  unknownValues: number;
}

/** Small deterministic PRNG so a demo run is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseRates(spec: string | undefined, plan: Plan): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const part of (spec ?? '').split(',').filter(Boolean)) {
    const [k, v] = part.split('=');
    const n = Number(v);
    if (!k || !(n >= 0 && n <= 1)) throw new Error(`bad rate "${part}"; use key=0.12`);
    rates[k.trim()] = n;
  }
  const arms = ['control', ...plan.variants.map((v) => v.key)];
  for (const arm of arms) if (rates[arm] === undefined) rates[arm] = 0.1;
  for (const k of Object.keys(rates)) if (!arms.includes(k)) throw new Error(`rate for unknown arm "${k}" (arms: ${arms.join(', ')})`);
  return rates;
}

export function identity(prefix: string, i: number): string {
  return `${prefix}-${String(i).padStart(4, '0')}`;
}

export async function sendTraffic(plan: Plan, opts: TrafficOptions): Promise<TrafficSummary> {
  const sdk = new Flagsmith({
    environmentKey: opts.environmentKey,
    apiUrl: `${opts.apiUrl}/api/v1/`,
    enableEvents: true,
    // Self-hosted with the Flagsmith database warehouse: the API receives events itself.
    eventProcessorConfig: { eventsApiUrl: `${opts.apiUrl}/api/` },
  });
  const valueToArm = new Map<string, string>([[plan.flag.controlValue, 'control'], ...plan.variants.map((v) => [v.value, v.key] as [string, string])]);
  const seed = opts.seed ?? 42;
  const summary: TrafficSummary = { exposures: {}, conversions: {}, unknownValues: 0 };
  const concurrency = 16;
  let done = 0;
  const one = async (i: number) => {
    const id = identity(opts.prefix, i);
    const flag = await sdk.getExperimentFlag(plan.flag.name, id); // evaluates + records exposure
    const arm = valueToArm.get(String(flag.value));
    if (!arm) {
      summary.unknownValues++;
      return;
    }
    summary.exposures[arm] = (summary.exposures[arm] ?? 0) + 1;
    // Per-identity draw: the same identity makes the same simulated choice on every run.
    if (mulberry32(seed * 100_003 + i)() < opts.rates[arm]) {
      sdk.trackEvent(plan.metric.event, { identifier: id }); // conversion, same identity
      summary.conversions[arm] = (summary.conversions[arm] ?? 0) + 1;
    }
  };
  try {
    for (let start = 1; start <= opts.users; start += concurrency) {
      const batch: Promise<void>[] = [];
      for (let i = start; i < start + concurrency && i <= opts.users; i++) batch.push(one(i));
      await Promise.all(batch);
      const before = done;
      done = Math.min(opts.users, start + concurrency - 1);
      if (Math.floor(done / 100) > Math.floor(before / 100) || done === opts.users) opts.onProgress?.(done, opts.users);
    }
    await sdk.flushEvents();
  } finally {
    await sdk.close();
  }
  return summary;
}
