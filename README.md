# Experiment Steward

**Human-approved Flagsmith experiments for AI coding agents.**
Toggle Wars (Flagsmith hackathon), Track 2: AI Agents + Feature Flags.

An AI coding agent can set up an A/B test in seconds, but it should not be the one deciding what
changes in your feature flags. Experiment Steward is a small command-line tool that sits between the
agent and Flagsmith:

- the **agent drafts** an experiment plan (flag, keyed variations, metric, split, hypothesis),
- a **human approves** each step that changes Flagsmith, on a card that lists the exact API writes it unlocks,
- **Flagsmith does the work**: native multivariate flag, metric and experiment, SDK exposure and conversion
  events, and Flagsmith's own Bayesian analysis,
- Steward **explains the result honestly** and will not let anyone "ship" a variation the data does not support
  without writing down why.

```
plan ──► APPROVE 1 ──► apply ──► APPROVE 2 ──► start ──► traffic ──► results ──► APPROVE 3 ──► ship
 │        (human)       │        (human)        │                       │         (human)       │
 agent                  creates flag, keyed     locks the flag,         Flagsmith's   ends the experiment,
 drafts                 variation, metric and   turns the rollout on    analysis +    rolls out the
                        an experiment (NOT                              plain verdict decision
                        started)
```

Demo video: see the submission (2–3 minutes, screen recording of a real run against a local Flagsmith).

## Why

Setting up one Flagsmith experiment by hand means: create a multivariate flag, add each variation
*with a key*, create a metric whose event name matches the code exactly, create the experiment with
the right rollout, start it at the right moment, refresh results (at most every 5 minutes) and read
win probability, credible interval, minimum sample and sample-ratio checks correctly. Each step has a
known way to go quietly wrong (unkeyed variations record no exposures; a typo in the event name is
silently ignored; a boolean flag converted later invalidates the data; "93% chance to win" is not a
win).

Steward turns that into one reviewed plan and three explicit approvals, and checks the wiring
mistakes for you. An agent can drive all of it, but it cannot approve on your behalf.

## What it does

| Command | Writes to Flagsmith? | What happens |
| --- | --- | --- |
| `steward doctor` | no | Checks API URL, credentials, project/environment, `experimentation_enabled`, warehouse connection. |
| `steward plan ...` | **no** | Validates the plan and prints approval card 1/3. |
| `steward approve <id>` | no | Shows the card for the pending gate and asks the person at the terminal to type the plan's code. Needs a TTY. |
| `steward reject <id> --reason ...` | no | Records a rejection. A plan rejected at gate 1 can never be applied. |
| `steward apply <id>` | yes (gate 1) | Creates the multivariate flag, keyed variations, metric and an experiment that is **not started**. |
| `steward start <id>` | yes (gate 2) | Starts the experiment (Flagsmith locks the flag and turns on the rollout). |
| `steward traffic <id> --users N` | SDK events only | **Simulated** test traffic through `@flagsmith/nodejs`, with stable identities. |
| `steward results <id>` | refresh only | Refreshes results and exposures (respecting the 5-minute limit) and prints a verdict. |
| `steward ship <id>` | yes (gate 3) | Ends the experiment with the approved decision: roll out a variation, keep control, or disable. |
| `steward show/list/log <id>` | no | Plan, state, and an audit log of every approval and every Flagsmith API call. |

Safety properties (all covered by tests):

- **No approval, no write.** Every write re-checks, immediately before calling Flagsmith, that the
  plan is in the right `approved-to-*` state. Without it the command stops with `■ BLOCKED` and makes
  zero API calls.
- **Approvals are bound to the exact plan.** An approval stores the SHA-256 of the plan. If anything in
  the plan changes afterwards (say, an agent "adjusts" the split), the approval no longer matches and
  Steward refuses.
- **Three separate approvals**, one per consequential step: create, start, ship.
- **Agents can't approve.** `approve` needs an interactive terminal and the 6-character code printed on
  the card. Agent shell tools run without a TTY, so they get a clear refusal and are told to hand over
  to the human. (This is a guard rail, not a sandbox: a person must still not give an agent a TTY and
  ask it to approve.)
- **Honest results.** Steward reads Flagsmith's own numbers and applies Flagsmith's documented
  thresholds. "Collecting data", "inconclusive" and "the interval crosses zero" are reported as
  exactly that. Approving `--decision <variant>` when the results do not support it is blocked
  *before* the approval prompt, unless the human gives an `--override "<reason>"`, which goes in the audit log.
- **No hijacking.** `apply` refuses if a flag with the same name already exists, and stops if the
  environment has no connected warehouse.
- **Resumable.** Each created resource is recorded as soon as it exists, so an interrupted `apply` resumes
  without creating anything twice.
- **No secrets in files it writes.** Credentials come from the environment or a git-ignored `.env`; plan
  files and logs never contain keys (the environment key in API paths is masked in `steward log`).

## How it uses Flagsmith

Flagsmith is the mechanism, not a wrapper. Without it, there is nothing to create, start, measure or ship.

- **Native Experimentation (Beta) on a self-hosted Flagsmith 2.295** with `EXPERIMENTATION_ENABLED=true`
  and the *Flagsmith database* warehouse (`warehouse_type: postgres`, `source: flagsmith_database`).
- **Management API**, called either directly over HTTP (`Authorization: Api-Key ...`) or through the
  **Flagsmith CLI v2** (`STEWARD_TRANSPORT=cli` sends every call through `flagsmith api <path> -X <method> --input -`,
  using the CLI's own host-scoped credentials). Endpoints used:

  | Step | Endpoint |
  | --- | --- |
  | doctor | `GET /version/`, `GET /api/v1/environments/{env}/warehouse-connections/` |
  | apply | `GET /api/v1/projects/{p}/features/?search=`, `POST /api/v1/projects/{p}/features/` (type `MULTIVARIATE`, initial value = control), `POST /api/v1/projects/{p}/features/{f}/mv-options/` (one per variation, **with `key`**), `GET .../features/{f}/` (verifies every variation has a key), `POST /api/v1/environments/{env}/experiment-metrics/` (`definition: {version: 1, event}`), `POST /api/v1/environments/{env}/experiments/` (rollout %, control value, per-variation `percentage_allocation`) |
  | start | `POST /api/v1/environments/{env}/experiments/{id}/start/` then `GET` to confirm `running` |
  | results | `POST .../experiments/{id}/results/refresh/`, `POST .../exposures/refresh/`, `GET .../results/`, `GET .../exposures/` |
  | ship | `POST .../experiments/{id}/complete/` with `rollout_decision` = `variant` (+ `rollout_variant`), `control` or `disable`; then `GET .../featurestates/?feature={f}` to show what is now served |

- **Node SDK `@flagsmith/nodejs` 9.5** for traffic, exactly as an app would use it:
  `getExperimentFlag(flag, identifier)` where the variation is shown (this records the exposure),
  `trackEvent(event, { identifier })` on success, `flushEvents()` and `close()` before exit. For a self-hosted
  instance the SDK is pointed at `apiUrl = <api>/api/v1/` and `eventsApiUrl = <api>/api/`.
- **Why not the MCP server for this?** Flagsmith's own guidance for experiments says not to use the MCP
  server because it cannot start experiments (it has no start, refresh or end tools). Steward uses the
  CLI and Management API, which cover the full lifecycle.

### Results interpretation (from Flagsmith's docs)

| Condition | Steward says |
| --- | --- |
| an arm has < 50 identities, or < 5 conversions for an occurrence metric | **Collecting data**, keep running |
| chance to beat control ≥ 95% **and** the 95% credible interval is above zero | **winning**, can approve shipping it |
| chance to beat control ≤ 5% | **losing** |
| anything else, including ≥ 95% with an interval that still crosses zero | **inconclusive** |
| sample-ratio-mismatch p-value < 0.01 | **SRM: do not act on these results** |
| identities served more than one variation | reported as a count (quarantined by Flagsmith); non-zero is a warning |

Lift and intervals are relative to control, as Flagsmith returns them.

## Run it locally

Requirements: Docker with Compose v2, Node.js ≥ 22.18 (runs the TypeScript sources directly; no build
step), ports 8000 and 8001 free, about 2 GB of free RAM. Optional: Flagsmith CLI v2
(`curl -fsSL https://get.flagsmith.com | sh`).

### 1. Start Flagsmith with experimentation enabled

```bash
mkdir flagsmith-local && cd flagsmith-local
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Flagsmith/flagsmith/main/docker-compose.yml
grep EXPERIMENTATION_ENABLED docker-compose.yml   # the official file sets it to 'true'
docker compose up -d
curl -s http://localhost:8000/version/            # expect "experimentation_enabled": true
```

If containers can't reach each other (some sandboxes and CI runners block Docker bridge networking),
use the host-network override in this repo:
`docker compose -f docker-compose.yml -f <this-repo>/local-flagsmith/docker-compose.hostnet.yml up -d`.

### 2. Install Steward and bootstrap credentials

```bash
git clone https://github.com/muimuiYoHo/experiment-steward && cd experiment-steward
npm install
npm link                                   # puts `steward` on your PATH (or use: npm run steward -- <cmd>)
node scripts/bootstrap-local.ts            # local admin, org, project, Development env, warehouse, API key
steward doctor
```

`bootstrap-local.ts` writes `.env` (mode 600, git-ignored) and the dashboard login to
`local-admin.secrets` (git-ignored). It never prints a secret. To use an existing instance instead,
copy `.env.example` to `.env` and fill it in. Variables:

| Variable | Meaning |
| --- | --- |
| `FLAGSMITH_API_URL` | e.g. `http://localhost:8000` |
| `FLAGSMITH_API_KEY_localhost_8000` (or `FLAGSMITH_API_KEY`) | organisation API key (Management API). Secret. |
| `FLAGSMITH_PROJECT` | project id |
| `FLAGSMITH_ENVIRONMENT_KEY` | client-side environment key (SDK + environment-scoped API paths) |
| `STEWARD_TRANSPORT` | `http` (default) or `cli` to route calls through `flagsmith api` |

### 3. Run an experiment

```bash
steward plan --name "Checkout button copy" --flag checkout_cta --control-value Checkout \
  --variant buy_now="Buy now" --event checkout_completed \
  --hypothesis "A direct label (Buy now) increases completed checkouts"
# or: steward plan --file plans/example-cta-copy.json

steward apply checkout-button-copy        # ■ BLOCKED: not approved
steward approve checkout-button-copy      # card 1/3, type the code shown on it
STEWARD_TRANSPORT=cli steward apply checkout-button-copy

steward approve checkout-button-copy      # card 2/3
steward start checkout-button-copy

steward traffic checkout-button-copy --users 800 --prefix shopper --rates control=0.10,buy_now=0.20
steward results checkout-button-copy      # Flagsmith's analysis + verdict

steward approve checkout-button-copy --decision buy_now   # card 3/3, shows the evidence
steward ship checkout-button-copy
steward log checkout-button-copy          # approvals + every API call
```

What you should see: the card and "Nothing has been written to Flagsmith" after `plan`; `■ BLOCKED`
before approval; four `✓ created ...` receipts and a dashboard link after `apply`; status `running` after
`start`; per-arm exposure counts after `traffic`; a results table after `results` (the same numbers as
the experiment page in the Flagsmith dashboard); after `ship`, the experiment is *Completed* in Flagsmith
and "buy_now rolled out to everyone".

`traffic` is a simulator for demos and for checking your wiring. The conversion rates you pass are
inputs to the simulation; the results are computed by Flagsmith from the events it received. In a real
app, put `getExperimentFlag` where the variation is rendered and `trackEvent` where success happens
(see `src/traffic.ts`, which uses the SDK exactly that way).

### Use it from an AI coding agent

See [AGENTS.md](AGENTS.md): a short instruction block for Claude Code, Cursor, Codex and others. The agent
drafts the plan, runs `apply`/`start`/`results`/`ship`, wires the SDK calls into your code, and hands
every approval to you.

## Development

```bash
npm test          # node:test, 30 tests against an in-memory fake of the Flagsmith endpoints
npm run typecheck # tsc --noEmit (strict)
```

Layout:

```
src/plan.ts       plan model, validation, canonical hash, approval code
src/gates.ts      approval state machine (draft → approved-to-create → created → approved-to-start →
                  running → approved-to-ship → ended, or rejected)
src/steward.ts    gated operations: apply, start, results, ship (journalled, resumable)
src/flagsmith.ts  Management API client; HTTP and Flagsmith-CLI transports
src/traffic.ts    simulated traffic through @flagsmith/nodejs
src/report.ts     results interpretation and table
src/card.ts       approval cards
src/cli.ts        `steward` commands
scripts/bootstrap-local.ts   local instance setup
local-flagsmith/  docker-compose host-network override
```

## Limitations

- Flagsmith Experimentation is in **Beta**; endpoint shapes were verified against Flagsmith 2.295.2.
- Steward handles one metric per plan and string-valued variations.
- The Flagsmith-database warehouse is meant for trying experimentation locally; use a dedicated
  warehouse in production.
- The TTY-plus-code approval stops agents from approving by accident. It is not a security boundary
  against a person who deliberately hands an agent a terminal.
- Tested on the self-hosted path. Flagsmith Cloud uses the same API, but whether its free plan includes
  experimentation and a hosted warehouse wasn't verified.

## How this was built (AI assistance)

This project was built during the hackathon window with an AI coding assistant, which wrote most of
the code, the tests, this README and the demo recording script for the entrant. The hackathon rules
allow AI coding assistants. Every statement about Flagsmith behaviour here was checked against a
running local Flagsmith instance during development, and every number in the demo comes from
Flagsmith.

The demo video is a screen recording of a real run against a local Flagsmith instance. To make the
recording reproducible, the keystrokes, including typing the approval codes, were scripted. In normal
use a person types the approvals.

## Licence

MIT. Flagsmith is a trademark of its owners; this is an independent hackathon project.
