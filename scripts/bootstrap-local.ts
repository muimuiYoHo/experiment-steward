// One-off setup for a fresh LOCAL Flagsmith (docker compose): admin user, organisation, project,
// Development environment, Flagsmith-database warehouse and an organisation API key.
// Writes credentials only to ./.env and ./local-admin.secrets (both git-ignored, mode 600).
// Never prints a secret.
//
//   node scripts/bootstrap-local.ts [--api http://localhost:8000] [--project "Checkout Demo"]
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: process.env.FLAGSMITH_API_URL ?? 'http://localhost:8000' },
    email: { type: 'string', default: process.env.FLAGSMITH_ADMIN_EMAIL ?? 'admin@example.local' },
    password: { type: 'string', default: process.env.FLAGSMITH_ADMIN_PASSWORD },
    organisation: { type: 'string', default: 'Steward Demo Org' },
    project: { type: 'string', default: 'Checkout Demo' },
    force: { type: 'boolean', default: false },
  },
});
const api = values.api!.replace(/\/+$/, '');

async function call<T>(method: string, path: string, auth: string | null, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${api}/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
function must<T>(r: { status: number; body: T }, what: string): T {
  if (r.status >= 300) throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

if (existsSync('.env') && !values.force) {
  console.error('.env already exists; pass --force to overwrite it');
  process.exit(1);
}

const version = must(await call<{ experimentation_enabled: boolean; image_tag: string }>('GET', 'version/', null), 'GET /version/');
console.log(`Flagsmith ${version.image_tag} at ${api}; experimentation_enabled=${version.experimentation_enabled}`);
if (!version.experimentation_enabled) {
  console.error('Set EXPERIMENTATION_ENABLED=true on the Flagsmith containers and restart (see README).');
  process.exit(1);
}

const password = values.password ?? `Fs-${randomBytes(12).toString('base64url')}`;
let token: string;
const signup = await call<{ key?: string }>('POST', 'api/v1/auth/users/', null, {
  email: values.email, password, re_password: password, first_name: 'Local', last_name: 'Admin',
});
if (signup.status === 201 && signup.body.key) {
  token = signup.body.key;
  writeFileSync('local-admin.secrets', `FLAGSMITH_ADMIN_EMAIL=${values.email}\nFLAGSMITH_ADMIN_PASSWORD=${password}\n`, { mode: 0o600 });
  console.log(`Created dashboard admin ${values.email} (password saved to local-admin.secrets)`);
} else {
  if (!values.password) throw new Error(`could not sign up ${values.email} (${signup.status}); if it exists, pass --password`);
  token = must(await call<{ key: string }>('POST', 'api/v1/auth/login/', null, { email: values.email, password }), 'login').key;
  console.log(`Logged in as existing admin ${values.email}`);
}
const auth = `Token ${token}`;

const org = must(await call<{ id: number }>('POST', 'api/v1/organisations/', auth, { name: values.organisation }), 'create organisation');
const project = must(await call<{ id: number }>('POST', 'api/v1/projects/', auth, { name: values.project, organisation: org.id }), 'create project');
const env = must(await call<{ id: number; api_key: string }>('POST', 'api/v1/environments/', auth, { name: 'Development', project: project.id }), 'create environment');
const wh = must(
  await call<{ status: string }>('POST', `api/v1/environments/${env.api_key}/warehouse-connections/`, auth, {
    warehouse_type: 'postgres',
    config: { source: 'flagsmith_database' },
  }),
  'connect warehouse',
);
const key = must(
  await call<{ key: string }>('POST', `api/v1/organisations/${org.id}/master-api-keys/`, auth, { name: 'experiment-steward', is_admin: true }),
  'create organisation API key',
);
const host = new URL(api);
const scoped = `FLAGSMITH_API_KEY_${`${host.hostname}${host.port ? `_${host.port}` : ''}`.replace(/[^A-Za-z0-9]/g, '_')}`;
writeFileSync(
  '.env',
  [
    '# Written by scripts/bootstrap-local.ts. Local-only credentials. Never commit this file.',
    `export FLAGSMITH_API_URL=${api}`,
    `export ${scoped}=${key.key}`,
    `export FLAGSMITH_PROJECT=${project.id}`,
    `export FLAGSMITH_ENVIRONMENT_KEY=${env.api_key}`,
    `export FLAGSMITH_ENVIRONMENT=${env.api_key}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`Organisation ${org.id}, project ${project.id}, environment "Development" (${env.api_key.slice(0, 4)}…), warehouse ${wh.status}`);
console.log('Wrote .env (mode 600). Next: npm run steward -- doctor');
