import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, renderInterpretation } from '../src/report.ts';
import { resultsFor } from './fake-flagsmith.ts';
import { samplePlan } from './helpers.ts';

const plan = samplePlan();

test('fewer than 50 identities per arm is "collecting data", whatever the win probability says', () => {
  const i = interpret(plan, resultsFor({ control: { n: 40, sum: 4 }, buy_now: { n: 45, sum: 20 } }, { buy_now: { lift: 3, ci_low: 1, ci_high: 5, chance_to_win: 0.999 } }));
  assert.equal(i.overall.kind, 'collecting-data');
  assert.equal(i.canShipVariant, null);
});

test('fewer than 5 conversions on an occurrence metric is "collecting data"', () => {
  const i = interpret(plan, resultsFor({ control: { n: 100, sum: 3 }, buy_now: { n: 100, sum: 12 } }, { buy_now: { lift: 3, ci_low: 0.5, ci_high: 6, chance_to_win: 0.99 } }));
  assert.equal(i.overall.kind, 'collecting-data');
  assert.match(i.rows[1].note ?? '', /control has 100 identities \/ 3 conversions/);
});

test('>= 95% but an interval that crosses zero is still inconclusive', () => {
  const i = interpret(plan, resultsFor({ control: { n: 61, sum: 6 }, buy_now: { n: 59, sum: 23 } }, { buy_now: { lift: 2.96, ci_low: -0.33, ci_high: 6.25, chance_to_win: 0.961 } }));
  assert.equal(i.rows[1].verdict, 'inconclusive');
  assert.match(i.rows[1].note ?? '', /crosses zero/);
  assert.equal(i.canShipVariant, null);
});

test('winning needs >= 95% and an interval above zero', () => {
  const i = interpret(plan, resultsFor({ control: { n: 500, sum: 50 }, buy_now: { n: 500, sum: 90 } }, { buy_now: { lift: 0.8, ci_low: 0.3, ci_high: 1.4, chance_to_win: 0.999 } }, 0.7));
  assert.deepEqual(i.overall, { kind: 'winner', key: 'buy_now' });
  assert.equal(i.canShipVariant, 'buy_now');
  const text = renderInterpretation(i);
  assert.match(text, /\+80\.0%/);
  assert.match(text, /99\.9%/);
  assert.match(text, /p=0\.70 \(ok\)/);
});

test('<= 5% is losing', () => {
  const i = interpret(plan, resultsFor({ control: { n: 500, sum: 90 }, buy_now: { n: 500, sum: 50 } }, { buy_now: { lift: -0.44, ci_low: -0.6, ci_high: -0.2, chance_to_win: 0.001 } }));
  assert.equal(i.overall.kind, 'all-losing');
});

test('a sample ratio mismatch overrides everything', () => {
  const i = interpret(plan, resultsFor({ control: { n: 900, sum: 90 }, buy_now: { n: 300, sum: 90 } }, { buy_now: { lift: 2, ci_low: 1, ci_high: 3, chance_to_win: 0.999 } }, 0.000001));
  assert.equal(i.overall.kind, 'srm');
  assert.equal(i.canShipVariant, null);
  assert.match(i.recommendation, /Do not act/);
});

test('no payload yet is reported plainly', () => {
  assert.equal(interpret(plan, { results: null }).overall.kind, 'no-results');
});
