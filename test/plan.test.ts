import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalCode, controlAllocation, draftPlan, planHash, validatePlan } from '../src/plan.ts';
import { samplePlan } from './helpers.ts';

test('draftPlan splits evenly with control and keys every variation', () => {
  const p = draftPlan({ flag: 'cta', variants: ['a=A', 'b=B'], event: 'clicked', hypothesis: 'h' });
  assert.deepEqual(p.variants.map((v) => [v.key, v.value, v.allocation]), [['a', 'A', 33.33], ['b', 'B', 33.33]]);
  assert.equal(controlAllocation(p), 33.34);
  assert.deepEqual(validatePlan(p), []);
});

test('explicit allocations are honoured', () => {
  const p = draftPlan({ flag: 'cta', variants: ['a=A@20'], event: 'clicked', hypothesis: 'h' });
  assert.equal(p.variants[0].allocation, 20);
  assert.equal(controlAllocation(p), 80);
});

test('validation catches the wiring mistakes Flagsmith warns about', () => {
  const bad = samplePlan({
    hypothesis: '',
    variants: [
      { key: 'control', value: 'X', allocation: 50 },
      { key: 'Bad Key', value: 'Checkout', allocation: 60 },
    ],
  });
  const problems = validatePlan(bad).join('\n');
  assert.match(problems, /hypothesis is required/);
  assert.match(problems, /"control" is reserved/);
  assert.match(problems, /variant key "Bad Key"/);
  assert.match(problems, /same value as control/);
  assert.match(problems, /nothing for control/);
});

test('reserved $ event names are rejected', () => {
  assert.match(validatePlan(samplePlan({ metric: { ...samplePlan().metric, event: '$exposure' } })).join(), /reserved/);
});

test('plan hash ignores key order but changes with any edit', () => {
  const p = samplePlan();
  const reordered = Object.fromEntries(Object.entries(p).reverse()) as typeof p;
  assert.equal(planHash(p), planHash(reordered));
  const edited = samplePlan();
  edited.variants[0].allocation = 51;
  assert.notEqual(planHash(p), planHash(edited));
  assert.equal(approvalCode(p).length, 6);
});
