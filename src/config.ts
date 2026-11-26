// Configuration is read from the environment (optionally a local, git-ignored .env file) and
// from flagsmith.json written by `flagsmith init`. Secrets never leave process memory.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  apiUrl: string;
  /** Management (organisation) API key. Never printed. */
  apiKey?: string;
  /** Client-side environment key, used both for SDK traffic and environment-scoped admin paths. */
  environmentKey?: string;
  projectId?: number;
  transport: 'http' | 'cli';
  plansDir: string;
  dashboardUrl: string;
}

/** Parses KEY=VALUE lines (with optional `export `). Does not override variables already set. */
export function loadDotEnv(file: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

/** The Flagsmith CLI's host-scoped variable name, e.g. FLAGSMITH_API_KEY_localhost_8000. */
export function hostScopedKeyName(apiUrl: string): string {
  const u = new URL(apiUrl);
  const host = `${u.hostname}${u.port ? `_${u.port}` : ''}`.replace(/[^A-Za-z0-9]/g, '_');
  return `FLAGSMITH_API_KEY_${host}`;
}

export function loadConfig(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv(join(cwd, '.env'), env);
  let fileCfg: { project?: number | string; environment?: string; apiUrl?: string } = {};
  const fsJson = join(cwd, 'flagsmith.json');
  if (existsSync(fsJson)) fileCfg = JSON.parse(readFileSync(fsJson, 'utf8'));
  const apiUrl = (env.FLAGSMITH_API_URL ?? fileCfg.apiUrl ?? 'http://localhost:8000').replace(/\/+$/, '');
  const apiKey = env.FLAGSMITH_API_KEY ?? env[hostScopedKeyName(apiUrl)];
  const environmentKey = env.FLAGSMITH_ENVIRONMENT_KEY ?? env.FLAGSMITH_ENVIRONMENT ?? fileCfg.environment;
  const project = env.FLAGSMITH_PROJECT ?? fileCfg.project;
  return {
    apiUrl,
    apiKey,
    environmentKey,
    projectId: project === undefined || project === '' ? undefined : Number(project),
    transport: env.STEWARD_TRANSPORT === 'cli' ? 'cli' : 'http',
    plansDir: env.STEWARD_PLANS_DIR ?? join(cwd, 'plans'),
    dashboardUrl: (env.FLAGSMITH_DASHBOARD_URL ?? (apiUrl.includes('api.flagsmith.com') ? 'https://app.flagsmith.com' : apiUrl)).replace(/\/+$/, ''),
  };
}
