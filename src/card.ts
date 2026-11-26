// Plain-text cards: what the human is approving, and exactly which Flagsmith calls it unlocks.
import { approvalCode, controlAllocation, type Plan } from './plan.ts';
import type { Gate } from './gates.ts';
import type { PlanRecord } from './store.ts';
import { interpret, renderInterpretation } from './report.ts';
import type { ResultsResponse } from './flagsmith.ts';

const WIDTH = 80;

export function box(title: string, lines: string[]): string {
  // Wide enough for the longest line (e.g. the results table), within reason.
  const longest = Math.max(...lines.map((l) => [...l].length), [...title].length + 4);
  const width = Math.min(Math.max(WIDTH, longest + 2), 120);
  const top = `┌─ ${title} ${'─'.repeat(Math.max(0, width - [...title].length - 4))}┐`;
  const body = lines.flatMap((l) => wrap(l, width - 2)).map((l) => `│ ${l.padEnd(width - 2)} │`);
  return [top, ...body, `└${'─'.repeat(width)}┘`].join('\n');
}

function wrap(line: string, width: number): string[] {
  if ([...line].length <= width) return [line];
  const lead = /^\s*/.exec(line)![0];
  const out: string[] = [];
  let cur = lead;
  for (const word of line.slice(lead.length).split(' ')) {
    const fresh = cur.length === lead.length || cur === lead + '    ';
    const candidate = fresh ? cur + word : `${cur} ${word}`;
    if ([...candidate].length > width && !fresh) {
      out.push(cur);
      cur = lead + '    ' + word;
    } else cur = candidate;
  }
  out.push(cur);
  return out;
}

export function planLines(plan: Plan): string[] {
  return [
    `Experiment   ${plan.name}`,
    `Hypothesis   ${plan.hypothesis}`,
    `Flag         ${plan.flag.name}  (multivariate, every variation keyed)`,
    `  control    "${plan.flag.controlValue}"  ${controlAllocation(plan)}%`,
    ...plan.variants.map((v) => `  ${v.key.padEnd(9)}  "${v.value}"  ${v.allocation}%`),
    `Rollout      ${plan.rolloutPercentage}% of identified users enter the experiment`,
    `Metric       ${plan.metric.name}: ${plan.metric.aggregation} of event "${plan.metric.event}", expect ${plan.metric.expectedDirection}`,
    `Drafted by   ${plan.draftedBy}`,
  ];
}

export function gateLines(record: PlanRecord, gate: Gate): string[] {
  const p = record.plan;
  if (gate === 'create') {
    return [
      'Approving unlocks ONLY these Flagsmith writes (`steward apply`):',
      `  POST features/          multivariate flag "${p.flag.name}", value "${p.flag.controlValue}"`,
      ...p.variants.map((v) => `  POST mv-options/        variation key=${v.key}`),
      `  POST experiment-metrics/ "${p.metric.name}"`,
      '  POST experiments/       created but NOT started',
      'Starting the experiment and shipping a winner each need their own approval.',
    ];
  }
  if (gate === 'start') {
    return [
      `Approving unlocks (\`steward start\`): POST experiments/${record.resources.experimentId}/start/`,
      `Effect: flag "${p.flag.name}" is locked and ${p.rolloutPercentage}% of identified users are split`,
      `between control and ${p.variants.map((v) => v.key).join(', ')}. Make sure exposure + "${p.metric.event}"`,
      'tracking are deployed first, or the data will be meaningless.',
    ];
  }
  const res = record.lastResults as ResultsResponse | undefined;
  const lines = [
    `Approving unlocks (\`steward ship\`): POST experiments/${record.resources.experimentId}/complete/`,
    'Effect: results are frozen as final, the flag is unlocked and every user gets the',
    'decision you choose below. This cannot be undone (an ended experiment cannot restart).',
    '',
  ];
  if (!res) lines.push('⚠ No results have been read yet. Run `steward results` before deciding.');
  else lines.push(...renderInterpretation(interpret(p, res)).split('\n'));
  return lines;
}

export function approvalCard(record: PlanRecord, gate: Gate): string {
  const n = { create: 1, start: 2, ship: 3 }[gate];
  return box(`APPROVAL ${n}/3 · ${gate.toUpperCase()} · plan ${record.plan.id} · code ${approvalCode(record.plan)}`, [
    ...planLines(record.plan),
    '',
    ...gateLines(record, gate),
  ]);
}
