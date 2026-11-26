// Turns Flagsmith's results payload into a short, honest verdict. Thresholds follow the
// Flagsmith docs ("Analyse an Experiment" and the statistics glossary):
//   - Collecting data: any arm with < 50 identities, or < 5 conversions for occurrence metrics
//   - winning: chance to beat control >= 95% AND the 95% credible interval is above zero
//   - losing:  chance to beat control <= 5%
//   - otherwise inconclusive (including "95% but the interval still crosses zero")
//   - sample ratio mismatch: do not act on the results at all
// Nothing here invents numbers: every figure printed comes from the payload.
import type { ResultsResponse } from './flagsmith.ts';
import type { Plan } from './plan.ts';
import { controlAllocation } from './plan.ts';

export const MIN_IDENTITIES = 50;
export const MIN_CONVERSIONS = 5;
export const WIN = 0.95;
export const LOSE = 0.05;
/** p-value below which we treat the split as a sample ratio mismatch. */
export const SRM_P = 0.01;

export type VariantVerdict = 'collecting-data' | 'winning' | 'losing' | 'inconclusive' | 'no-data';

export interface ArmRow {
  key: string;
  isControl: boolean;
  plannedShare: number;
  identities: number;
  conversions: number;
  rate: number | null;
  lift?: number;
  ciLow?: number;
  ciHigh?: number;
  chanceToWin?: number;
  verdict?: VariantVerdict;
  note?: string;
}

export type Overall =
  | { kind: 'no-results'; reason: string }
  | { kind: 'srm'; pValue: number }
  | { kind: 'collecting-data' }
  | { kind: 'winner'; key: string }
  | { kind: 'all-losing' }
  | { kind: 'inconclusive' };

export interface Interpretation {
  asOf: string | null;
  isFinal: boolean;
  srmPValue: number | null;
  rows: ArmRow[];
  overall: Overall;
  /** One-line recommendation a human can act on. */
  recommendation: string;
  canShipVariant: string | null;
}

export function interpret(plan: Plan, res: ResultsResponse): Interpretation {
  const r = res.results;
  const empty = (reason: string): Interpretation => ({
    asOf: r?.as_of ?? null,
    isFinal: r?.is_final ?? false,
    srmPValue: null,
    rows: [],
    overall: { kind: 'no-results', reason },
    recommendation: `No results yet (${reason}). Send traffic, wait about a minute, then refresh.`,
    canShipVariant: null,
  });
  if (!r) return empty('the experiment has never been refreshed');
  if (!r.payload) return empty(r.last_error_at ? `last refresh failed at ${r.last_error_at}` : 'refresh still computing');
  const metric = r.payload.metrics[0];
  if (!metric) return empty('no metric attached to this experiment');

  const occurrence = plan.metric.aggregation === 'occurrence';
  const arm = (key: string, isControl: boolean, share: number): ArmRow => {
    const v = metric.variants[key];
    const identities = v?.n ?? 0;
    const conversions = v?.sum ?? 0;
    return { key, isControl, plannedShare: share, identities, conversions, rate: identities ? conversions / identities : null };
  };
  const control = arm('control', true, controlAllocation(plan));
  const rows: ArmRow[] = [control];
  const controlShort = control.identities < MIN_IDENTITIES || (occurrence && control.conversions < MIN_CONVERSIONS);

  for (const v of plan.variants) {
    const row = arm(v.key, false, v.allocation);
    const inf = metric.inference[v.key];
    const short = row.identities < MIN_IDENTITIES || (occurrence && row.conversions < MIN_CONVERSIONS);
    if (inf) {
      row.lift = inf.lift;
      row.ciLow = inf.ci_low;
      row.ciHigh = inf.ci_high;
      row.chanceToWin = inf.chance_to_win;
    }
    if (short || controlShort) {
      row.verdict = 'collecting-data';
      const who = short ? row : control;
      row.note = `${who.key} has ${who.identities} identities / ${who.conversions} conversions; needs ${MIN_IDENTITIES}${occurrence ? ` / ${MIN_CONVERSIONS}` : ''}`;
    } else if (!inf) {
      row.verdict = 'no-data';
      row.note = 'Flagsmith returned no inference for this variant';
    } else if (inf.chance_to_win >= WIN && inf.ci_low > 0) {
      row.verdict = 'winning';
    } else if (inf.chance_to_win <= LOSE) {
      row.verdict = 'losing';
    } else {
      row.verdict = 'inconclusive';
      row.note = inf.chance_to_win >= WIN ? 'chance to win is >= 95% but the credible interval still crosses zero' : 'credible interval crosses zero';
    }
    rows.push(row);
  }

  const srm = r.payload.srm_p_value;
  const variants = rows.filter((x) => !x.isControl);
  let overall: Overall;
  if (srm !== null && srm < SRM_P) overall = { kind: 'srm', pValue: srm };
  else if (variants.some((x) => x.verdict === 'collecting-data')) overall = { kind: 'collecting-data' };
  else {
    const winners = variants.filter((x) => x.verdict === 'winning').sort((a, b) => (b.chanceToWin ?? 0) - (a.chanceToWin ?? 0));
    if (winners.length) overall = { kind: 'winner', key: winners[0].key };
    else if (variants.every((x) => x.verdict === 'losing')) overall = { kind: 'all-losing' };
    else overall = { kind: 'inconclusive' };
  }

  const recommendation = {
    'no-results': '',
    srm: `Sample ratio mismatch (p=${srm?.toPrecision(2)}): traffic did not split as configured. Do not act on these results; fix the exposure wiring first.`,
    'collecting-data': 'Still collecting data. Keep the experiment running; do not ship a variation yet.',
    winner: `"${overall.kind === 'winner' ? overall.key : ''}" meets Flagsmith's bar (>= 95% chance to beat control, interval above zero). You may approve shipping it.`,
    'all-losing': 'Every variation is losing to control. Consider ending the experiment and keeping control.',
    inconclusive: 'Inconclusive: no variation has cleared the 95% bar with an interval above zero. Keep collecting data, or end it and keep control.',
  }[overall.kind];

  return {
    asOf: r.as_of,
    isFinal: r.is_final,
    srmPValue: srm,
    rows,
    overall,
    recommendation,
    canShipVariant: overall.kind === 'winner' ? overall.key : null,
  };
}

const pct = (x: number | null | undefined, digits = 1): string =>
  x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`;
const signed = (x: number | undefined): string => (x === undefined ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);

export function renderInterpretation(i: Interpretation): string {
  if (i.overall.kind === 'no-results') return i.recommendation;
  const head = ['arm', 'planned', 'identities', 'conversions', 'rate', 'lift', '95% interval', 'win prob', 'verdict'];
  const body = i.rows.map((r) => [
    r.isControl ? 'control' : r.key,
    `${r.plannedShare}%`,
    String(r.identities),
    String(r.conversions),
    pct(r.rate),
    r.isControl ? '' : signed(r.lift),
    r.isControl || r.ciLow === undefined ? '' : `${signed(r.ciLow)} … ${signed(r.ciHigh)}`,
    r.isControl ? '' : pct(r.chanceToWin),
    r.isControl ? 'baseline' : (r.verdict ?? ''),
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((row) => row[c].length)));
  const line = (cells: string[]) => cells.map((c, k) => c.padEnd(widths[k])).join('  ').trimEnd();
  const out = [line(head), widths.map((w) => '─'.repeat(w)).join('  '), ...body.map(line)];
  for (const r of i.rows) if (r.note) out.push(`  · ${r.key}: ${r.note}`);
  out.push(`  · sample ratio check: ${i.srmPValue === null ? 'not reported by Flagsmith yet' : `p=${i.srmPValue.toPrecision(2)}${i.srmPValue < SRM_P ? '  ⚠ MISMATCH' : ' (ok)'}`}`);
  out.push('', `Verdict: ${i.recommendation}`);
  return out.join('\n');
}
