import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GateError } from '../src/gates.ts';
import { resultsFor } from './fake-flagsmith.ts';
import { setup } from './helpers.ts';

test('apply without approval is refused and makes zero Flagsmith calls', async () => {
  const { steward, fake } = setup();
  await assert.rejects(steward.apply('checkout-button-copy'), (e) => e instanceof GateError && /needs a human/.test(e.message));
  assert.equal(fake.calls.length, 0);
});

test('editing the plan after approval voids the approval', async () => {
  const { steward, store, fake } = setup();
  steward.approve('checkout-button-copy', 'alice');
  const r = store.load('checkout-button-copy');
  r.plan.variants[0].allocation = 90; // e.g. an agent "tweaks" the split after approval
  store.save(r);
  await assert.rejects(steward.apply('checkout-button-copy'), /changed after it was approved/);
  assert.equal(fake.calls.length, 0);
});

test('apply creates flag, keyed variation, metric and an experiment that is NOT started', async () => {
  const { steward, fake, store } = setup();
  steward.approve('checkout-button-copy', 'alice');
  const r = await steward.apply('checkout-button-copy');
  assert.equal(r.state, 'created');
  assert.deepEqual(fake.writes.map((c) => c.path.replace(/\d+/g, 'N')), [
    'api/vN/projects/N/features/',
    'api/vN/projects/N/features/N/mv-options/',
    'api/vN/environments/ENVKEY/experiment-metrics/',
    'api/vN/environments/ENVKEY/experiments/',
  ]);
  assert.equal(fake.features[0].multivariate_options[0].key, 'buy_now');
  assert.equal(fake.experiments[0].status, 'created');
  const body = fake.experiments[0].body;
  assert.equal(body.experiment_rollout.feature_state_value.value, 'Checkout');
  assert.equal(body.experiment_rollout.multivariate_feature_state_values[0].percentage_allocation, 50);
  assert.equal(store.load('checkout-button-copy').journal.length, fake.calls.length);
});

test('start needs its own (second) approval', async () => {
  const { steward, fake } = setup();
  steward.approve('checkout-button-copy', 'alice');
  await steward.apply('checkout-button-copy');
  const before = fake.calls.length;
  await assert.rejects(steward.start('checkout-button-copy'), /needs a human/);
  assert.equal(fake.calls.length, before);
  steward.approve('checkout-button-copy', 'alice');
  const r = await steward.start('checkout-button-copy');
  assert.equal(r.state, 'running');
  assert.equal(fake.experiments[0].status, 'running');
});

test('no warehouse: apply stops before creating anything', async () => {
  const { steward, fake } = setup();
  fake.warehouseStatus = 'error';
  steward.approve('checkout-button-copy', 'alice');
  await assert.rejects(steward.apply('checkout-button-copy'), /no connected warehouse/);
  assert.equal(fake.writes.length, 0);
});

test('an existing flag with the same name is never taken over', async () => {
  const { steward, fake } = setup();
  fake.features.push({ id: 99, name: 'checkout_cta', type: 'STANDARD', initial_value: 'x', multivariate_options: [] });
  steward.approve('checkout-button-copy', 'alice');
  await assert.rejects(steward.apply('checkout-button-copy'), /already exists/);
  assert.equal(fake.writes.length, 0);
});

test('an interrupted apply resumes without duplicating resources', async () => {
  const { steward, fake } = setup();
  steward.approve('checkout-button-copy', 'alice');
  fake.failOn = (c) => (c.method === 'POST' && c.path.endsWith('/experiment-metrics/') ? 500 : undefined);
  await assert.rejects(steward.apply('checkout-button-copy'), /500/);
  fake.failOn = undefined;
  const r = await steward.apply('checkout-button-copy');
  assert.equal(r.state, 'created');
  assert.equal(fake.features.length, 1);
  assert.equal(fake.features[0].multivariate_options.length, 1);
  assert.equal(fake.experiments.length, 1);
});

async function running() {
  const ctx = setup();
  ctx.steward.approve('checkout-button-copy', 'alice');
  await ctx.steward.apply('checkout-button-copy');
  ctx.steward.approve('checkout-button-copy', 'alice');
  await ctx.steward.start('checkout-button-copy');
  return ctx;
}

test('shipping a variant the results do not support needs an explicit override', async () => {
  const { steward, fake } = await running();
  fake.results = resultsFor({ control: { n: 200, sum: 20 }, buy_now: { n: 200, sum: 30 } }, { buy_now: { lift: 0.5, ci_low: -0.1, ci_high: 1.2, chance_to_win: 0.9 } });
  await steward.results('checkout-button-copy');
  assert.throws(() => steward.approve('checkout-button-copy', 'alice', { decision: { kind: 'variant', key: 'buy_now' } }), /do not support shipping/);
  const a = steward.approve('checkout-button-copy', 'alice', { decision: { kind: 'variant', key: 'buy_now' }, override: 'brand team decision' });
  assert.equal(a.verdict, 'inconclusive');
  assert.equal(a.override, 'brand team decision');
});

test('keeping control never needs an override, and ship ends the experiment', async () => {
  const { steward, fake } = await running();
  await assert.rejects(steward.ship('checkout-button-copy'), /needs a human/);
  steward.approve('checkout-button-copy', 'alice', { decision: { kind: 'control' } });
  const { record } = await steward.ship('checkout-button-copy');
  assert.equal(record.state, 'ended');
  assert.deepEqual(fake.experiments[0].decision, { rollout_decision: 'control' });
});

test('a winning variant can be shipped and sends its option id', async () => {
  const { steward, fake, store } = await running();
  fake.results = resultsFor({ control: { n: 500, sum: 50 }, buy_now: { n: 500, sum: 90 } }, { buy_now: { lift: 0.8, ci_low: 0.3, ci_high: 1.4, chance_to_win: 0.999 } }, 0.6);
  const { interp } = await steward.results('checkout-button-copy');
  assert.equal(interp.canShipVariant, 'buy_now');
  steward.approve('checkout-button-copy', 'alice', { decision: { kind: 'variant', key: 'buy_now' } });
  await steward.ship('checkout-button-copy');
  const optionId = store.load('checkout-button-copy').resources.variantIds!.buy_now;
  assert.deepEqual(fake.experiments[0].decision, { rollout_decision: 'variant', rollout_variant: optionId });
});

test('results respect the 5-minute refresh limit locally and on a 429', async () => {
  const { steward, fake, advance } = await running();
  fake.results = resultsFor({ control: { n: 10, sum: 1 }, buy_now: { n: 10, sum: 2 } }, {});
  const first = await steward.results('checkout-button-copy');
  assert.equal(first.refreshed, true);
  const second = await steward.results('checkout-button-copy');
  assert.equal(second.refreshed, false);
  assert.ok(second.nextRefreshAt);
  advance(6 * 60 * 1000);
  fake.throttleRefresh = true;
  const third = await steward.results('checkout-button-copy');
  assert.equal(third.refreshed, false);
  assert.match(third.throttled ?? '', /recently/);
  assert.equal(fake.calls.filter((c) => c.path.endsWith('/results/refresh/')).length, 2);
});

test('a rejected plan can never be applied', async () => {
  const { steward, fake } = setup();
  steward.reject('checkout-button-copy', 'alice', 'wrong metric');
  assert.throws(() => steward.approve('checkout-button-copy', 'alice'), /nothing is waiting/);
  await assert.rejects(steward.apply('checkout-button-copy'), /rejected/);
  assert.equal(fake.calls.length, 0);
});
