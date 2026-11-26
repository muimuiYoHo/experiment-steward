// `steward` command-line entry point.
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, type Config } from './config.ts';
import { Flagsmith, makeTransport } from './flagsmith.ts';
import { approvalCode, draftPlan, PlanError, validatePlan, type Plan } from './plan.ts';
import { GateError, pendingGate, type ShipDecision } from './gates.ts';
import { Store, newRecord, type PlanRecord } from './store.ts';
import { Steward } from './steward.ts';
import { approvalCard, box, planLines } from './card.ts';
import { renderInterpretation } from './report.ts';
import { parseRates, sendTraffic } from './traffic.ts';

const HELP = `Experiment Steward — human-approved Flagsmith experiments for AI coding agents

  steward doctor                       check Flagsmith, experimentation, warehouse, credentials
  steward plan  --flag <name> --variant key=value[@pct]... --event <name> --hypothesis "..."
                [--name "..."] [--control-value "..."] [--rollout 100] [--drafted-by "..."]
  steward plan  --file plan.json       (a plan written by an AI agent)
  steward show <id> | list | log <id>
  steward approve <id> [--decision <variant-key>|control|disable] [--override "reason"]
                                       interactive: shows the approval card, asks for the code
  steward reject <id> --reason "..."
  steward apply <id>                   gate 1: create flag, keyed variations, metric, experiment
  steward start <id>                   gate 2: start the experiment
  steward traffic <id> --users 400 [--rates control=0.10,key=0.16] [--prefix demo-user]
                                       SIMULATED test traffic via @flagsmith/nodejs
  steward results <id> [--no-refresh]  refresh (max every 5 min) and interpret results
  steward ship <id>                    gate 3: end the experiment with the approved decision

Approvals need an interactive terminal (TTY). Steward never approves its own plans.`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  ask: (q: string) => Promise<string>;
}

function defaultIo(): Io {
  return {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    isTTY: Boolean(process.stdin.isTTY),
    ask: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
  };
}

function clientFactory(cfg: Config): () => Flagsmith {
  return () => {
    if (!cfg.environmentKey) throw new Error('no environment: set FLAGSMITH_ENVIRONMENT_KEY or run `flagsmith init`');
    if (cfg.projectId === undefined) throw new Error('no project: set FLAGSMITH_PROJECT or run `flagsmith init`');
    return new Flagsmith(makeTransport(cfg), cfg.environmentKey, cfg.projectId);
  };
}

export async function main(argv: string[], io: Io = defaultIo(), cfg: Config = loadConfig()): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values: o, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      flag: { type: 'string' },
      variant: { type: 'string', multiple: true },
      event: { type: 'string' },
      hypothesis: { type: 'string' },
      name: { type: 'string' },
      'control-value': { type: 'string' },
      rollout: { type: 'string' },
      'drafted-by': { type: 'string' },
      file: { type: 'string' },
      decision: { type: 'string' },
      override: { type: 'string' },
      reason: { type: 'string' },
      as: { type: 'string' },
      users: { type: 'string' },
      rates: { type: 'string' },
      prefix: { type: 'string' },
      seed: { type: 'string' },
      'no-refresh': { type: 'boolean' },
      force: { type: 'boolean' },
    },
  });
  const store = new Store(cfg.plansDir);
  const steward = new Steward({ store, flagsmith: clientFactory(cfg), log: io.out });
  const id = positionals[0];
  const need = () => {
    if (!id) throw new PlanError(`usage: steward ${cmd} <plan-id>`);
    return id;
  };
  const next = (r: PlanRecord) => {
    const gate = pendingGate(r.state);
    const hint: Record<string, string> = {
      draft: `Nothing has been written to Flagsmith. Next (human): steward approve ${r.plan.id}`,
      'approved-to-create': `Next: steward apply ${r.plan.id}`,
      created: `Next (human): steward approve ${r.plan.id}   → unlocks start`,
      'approved-to-start': `Next: steward start ${r.plan.id}`,
      running: `Next: traffic + results; then a human approves the ship decision (--decision <key>|control|disable)`,
      'approved-to-ship': `Next: steward ship ${r.plan.id}`,
      ended: 'Experiment ended.',
      rejected: 'Plan rejected. Draft a new one.',
    };
    return `» ${hint[r.state]}`;
  };

  try {
    switch (cmd) {
      case undefined:
      case 'help':
      case '--help':
        io.out(HELP);
        return 0;

      case 'doctor': {
        io.out(`Flagsmith API      ${cfg.apiUrl}`);
        io.out(`Transport          ${cfg.transport === 'cli' ? 'Flagsmith CLI (flagsmith api)' : 'Management API (HTTP)'}`);
        io.out(`Admin credentials  ${cfg.transport === 'cli' ? 'from the Flagsmith CLI' : cfg.apiKey ? 'found (not shown)' : 'MISSING'}`);
        io.out(`Project            ${cfg.projectId ?? 'MISSING'}`);
        io.out(`Environment key    ${cfg.environmentKey ? `${cfg.environmentKey.slice(0, 4)}…` : 'MISSING'}`);
        const fs = clientFactory(cfg)();
        const v = await fs.version();
        io.out(`Flagsmith version  ${v.image_tag ?? 'unknown'}`);
        io.out(`Experimentation    ${v.experimentation_enabled === false ? 'DISABLED (set EXPERIMENTATION_ENABLED=true)' : 'enabled'}`);
        const wh = await fs.warehouses();
        const ok = wh.find((w) => w.status === 'connected');
        io.out(`Warehouse          ${ok ? `${ok.name}: connected (${ok.total_events_received ?? 0} events received)` : 'NOT CONNECTED'}`);
        return v.experimentation_enabled === false || !ok ? 1 : 0;
      }

      case 'plan': {
        const plan: Plan = o.file
          ? (JSON.parse(readFileSync(o.file, 'utf8')) as Plan)
          : draftPlan({
              flag: o.flag ?? '',
              variants: o.variant ?? [],
              event: o.event ?? '',
              hypothesis: o.hypothesis,
              name: o.name,
              controlValue: o['control-value'],
              rollout: o.rollout === undefined ? undefined : Number(o.rollout),
              draftedBy: o['drafted-by'],
            });
        const problems = validatePlan(plan);
        if (problems.length) throw new PlanError(`plan is not valid:\n  - ${problems.join('\n  - ')}`);
        if (store.exists(plan.id) && !o.force) throw new PlanError(`plan "${plan.id}" already exists (use --name to pick another id)`);
        const record = newRecord(plan);
        store.save(record);
        io.out(approvalCard(record, 'create'));
        io.out(next(record));
        return 0;
      }

      case 'show': {
        const r = store.load(need());
        const gate = pendingGate(r.state);
        io.out(gate ? approvalCard(r, gate) : box(`plan ${r.plan.id}`, planLines(r.plan)));
        io.out(`State: ${r.state}`);
        io.out(next(r));
        return 0;
      }

      case 'list': {
        const all = store.list();
        if (!all.length) io.out('No plans yet. Start with `steward plan`.');
        for (const r of all) io.out(`${r.plan.id.padEnd(28)} ${r.state.padEnd(20)} ${r.plan.name}`);
        return 0;
      }

      case 'log': {
        const r = store.load(need());
        for (const a of r.approvals) io.out(`${a.approvedAt}  APPROVED ${a.gate.padEnd(6)} by ${a.approvedBy}  plan ${a.planHash.slice(0, 6)}${a.decision ? `  decision=${decisionText(a.decision)}` : ''}${a.override ? `  override="${a.override}"` : ''}`);
        for (const x of r.rejections) io.out(`${x.rejectedAt}  REJECTED ${x.gate} by ${x.rejectedBy}: ${x.reason}`);
        for (const j of r.journal) io.out(`${j.at}  ${j.step.padEnd(7)} ${j.method.padEnd(6)} ${String(j.status).padEnd(4)} ${j.path.replace(cfg.environmentKey ?? '\u0000', '<env>')}`);
        return 0;
      }

      case 'approve': {
        const r = store.load(need());
        const gate = pendingGate(r.state);
        if (!gate) throw new GateError(`nothing is waiting for approval while the plan is "${r.state}"`);
        const decision = gate === 'ship' ? parseDecision(o.decision) : undefined;
        if (decision) steward.checkShip(r.plan.id, decision, o.override);
        io.out(approvalCard(r, gate));
        if (decision) io.out(`Decision to approve: ${decisionText(decision)}${o.override ? `  (override: ${o.override})` : ''}`);
        if (!io.isTTY) {
          throw new GateError('approval needs a person at an interactive terminal; this process has no TTY. (AI agents: show the card to your human and stop.)');
        }
        const code = approvalCode(r.plan);
        const answer = (await io.ask(`Type the approval code (${code}) to approve, or press Enter to cancel: `)).trim();
        if (answer !== code) {
          io.out('Not approved. Nothing was written to Flagsmith.');
          return 1;
        }
        const by = o.as ?? userInfo().username;
        const a = steward.approve(r.plan.id, by, { decision, override: o.override });
        io.out(`✓ Approved ${a.gate} by ${by} at ${a.approvedAt} for plan version ${a.planHash.slice(0, 6)}`);
        io.out(next(store.load(r.plan.id)));
        return 0;
      }

      case 'reject': {
        if (!o.reason) throw new PlanError('give a reason: --reason "..."');
        steward.reject(need(), o.as ?? userInfo().username, o.reason);
        io.out('Rejected. Nothing was written to Flagsmith.');
        return 0;
      }

      case 'apply': {
        io.out(`Applying plan ${need()} via ${transportName(cfg)} …`);
        const r = await steward.apply(id);
        io.out(`Flagsmith now has the flag, variations, metric and experiment ${r.resources.experimentId} (status: created).`);
        io.out(`Dashboard: ${cfg.dashboardUrl}/project/${cfg.projectId}/environment/${cfg.environmentKey}/experiments/`);
        io.out(next(r));
        return 0;
      }

      case 'start': {
        const r = await steward.start(need());
        io.out(next(r));
        return 0;
      }

      case 'traffic': {
        const r = store.load(need());
        if (r.state !== 'running') throw new GateError(`traffic only makes sense while the experiment is running (plan is "${r.state}")`);
        if (!cfg.environmentKey) throw new Error('FLAGSMITH_ENVIRONMENT_KEY is required for SDK traffic');
        const users = Number(o.users ?? 200);
        const rates = parseRates(o.rates, r.plan);
        const prefix = o.prefix ?? 'demo-user';
        io.out(`SIMULATED test traffic: ${users} stable identities (${prefix}-0001…), simulated conversion rates ${Object.entries(rates).map(([k, v]) => `${k}=${v}`).join(', ')}`);
        const s = await sendTraffic(r.plan, {
          apiUrl: cfg.apiUrl,
          environmentKey: cfg.environmentKey,
          users,
          rates,
          prefix,
          seed: o.seed === undefined ? undefined : Number(o.seed),
          onProgress: (d, t) => io.out(`  … ${d}/${t} identities evaluated`),
        });
        for (const arm of ['control', ...r.plan.variants.map((v) => v.key)]) {
          io.out(`  ${arm.padEnd(10)} exposures ${String(s.exposures[arm] ?? 0).padStart(4)}   conversions sent ${String(s.conversions[arm] ?? 0).padStart(4)}`);
        }
        if (s.unknownValues) io.out(`  ⚠ ${s.unknownValues} evaluations returned a value that matches no arm`);
        io.out('Events flushed to Flagsmith. These counts are what was SENT; read the analysis with `steward results`.');
        return 0;
      }

      case 'results': {
        const { interp, refreshed, nextRefreshAt, record, throttled, excludedIdentities } = await steward.results(need(), { refresh: !o['no-refresh'] });
        io.out(
          `Flagsmith results as of ${interp.asOf ?? 'never'}${interp.isFinal ? ' (final)' : ''}` +
            (refreshed ? ' — freshly refreshed' : throttled ? ` — cached (${throttled})` : nextRefreshAt ? ` — cached; next refresh allowed at ${nextRefreshAt.toISOString()}` : ''),
        );
        const extra =
          excludedIdentities === undefined
            ? []
            : [`  · identities served more than one variation (quarantined): ${excludedIdentities}${excludedIdentities > 0 ? '  ⚠ check that the identifier is stable' : ' (ok)'}`];
        io.out(renderInterpretation(interp, extra));
        io.out(next(record));
        return 0;
      }

      case 'ship': {
        const { record, decision, served } = await steward.ship(need());
        io.out(`✓ Experiment ${record.resources.experimentId} ended with decision ${decisionText(decision)}.`);
        if (served && typeof served === 'object') {
          const s = served as { enabled: boolean; feature_state_value: unknown; multivariate_feature_state_values?: { multivariate_feature_option: number; percentage_allocation: number }[] };
          const byId = new Map(Object.entries(record.resources.variantIds ?? {}).map(([k, v]) => [v, k]));
          const alloc = (s.multivariate_feature_state_values ?? []).filter((m) => m.percentage_allocation > 0);
          io.out(`  Flagsmith now serves flag "${record.plan.flag.name}" (enabled=${s.enabled}):`);
          for (const m of alloc) {
            const key = byId.get(m.multivariate_feature_option) ?? `option ${m.multivariate_feature_option}`;
            const value = record.plan.variants.find((v) => v.key === key)?.value;
            io.out(`    ${m.percentage_allocation}% of identified users → ${key}${value ? ` ("${value}")` : ''}`);
          }
          const rest = 100 - alloc.reduce((t, m) => t + m.percentage_allocation, 0);
          if (rest > 0) io.out(`    ${rest}% of identified users → control (${JSON.stringify(s.feature_state_value)})`);
          io.out(`    unidentified requests → ${JSON.stringify(s.feature_state_value)}`);
        }
        io.out(next(record));
        return 0;
      }

      default:
        io.err(`unknown command "${cmd}"\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    const err = e as Error;
    const label = err instanceof GateError ? '■ BLOCKED' : err instanceof PlanError ? '✗ PLAN' : '✗ ERROR';
    io.err(`${label}: ${err.message}`);
    return err instanceof GateError ? 3 : 1;
  }
}

function transportName(cfg: Config): string {
  return cfg.transport === 'cli' ? 'the Flagsmith CLI (flagsmith api)' : 'the Flagsmith Management API';
}

export function parseDecision(raw: string | undefined): ShipDecision {
  if (!raw) throw new GateError('shipping needs a decision: --decision <variant-key> | control | disable');
  if (raw === 'control') return { kind: 'control' };
  if (raw === 'disable') return { kind: 'disable' };
  return { kind: 'variant', key: raw };
}

function decisionText(d: ShipDecision): string {
  return d.kind === 'variant' ? `roll out "${d.key}"` : d.kind === 'control' ? 'keep control' : 'disable the flag';
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
