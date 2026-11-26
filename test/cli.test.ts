import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { hostScopedKeyName, type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';

function harness(answer: string, isTTY: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'steward-cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const cfg: Config = { apiUrl: 'http://127.0.0.1:9', apiKey: 'k', environmentKey: 'E', projectId: 1, transport: 'http', plansDir: dir, dashboardUrl: 'http://x' };
  const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), isTTY, ask: async () => answer };
  return { dir, out, err, run: (args: string[]) => main(args, io, cfg) };
}

const PLAN = ['plan', '--name', 'Checkout button copy', '--flag', 'checkout_cta', '--control-value', 'Checkout', '--variant', 'buy_now=Buy now', '--event', 'checkout_completed', '--hypothesis', 'h'];

test('plan prints an approval card and writes nothing to Flagsmith', async () => {
  const h = harness('', true);
  assert.equal(await h.run(PLAN), 0);
  const text = h.out.join('\n');
  assert.match(text, /APPROVAL 1\/3 · CREATE/);
  assert.match(text, /Nothing has been written to Flagsmith/);
});

test('approve refuses without an interactive terminal (agents cannot self-approve)', async () => {
  const h = harness('whatever', false);
  await h.run(PLAN);
  assert.equal(await h.run(['approve', 'checkout-button-copy']), 3);
  assert.match(h.err.join('\n'), /needs a person at an interactive terminal/);
  assert.equal(new Store(h.dir).load('checkout-button-copy').state, 'draft');
});

test('approve needs the exact code shown on the card', async () => {
  const wrong = harness('nope', true);
  await wrong.run(PLAN);
  assert.equal(await wrong.run(['approve', 'checkout-button-copy']), 1);
  assert.equal(new Store(wrong.dir).load('checkout-button-copy').state, 'draft');

  const store = (d: string) => new Store(d).load('checkout-button-copy');
  const probe = harness('', true);
  await probe.run(PLAN);
  const code = /code ([0-9a-f]{6})/.exec(probe.out.join('\n'))![1];
  const right = harness(code, true);
  await right.run(PLAN);
  assert.equal(await right.run(['approve', 'checkout-button-copy', '--as', 'alice']), 0);
  const r = store(right.dir);
  assert.equal(r.state, 'approved-to-create');
  assert.equal(r.approvals[0].approvedBy, 'alice');
});

test('invalid plans are rejected with reasons', async () => {
  const h = harness('', true);
  assert.equal(await h.run(['plan', '--flag', 'x', '--variant', 'control=A', '--event', 'e']), 1);
  assert.match(h.err.join('\n'), /reserved/);
});

test('host-scoped key names match the Flagsmith CLI convention', () => {
  assert.equal(hostScopedKeyName('http://localhost:8000'), 'FLAGSMITH_API_KEY_localhost_8000');
  assert.equal(hostScopedKeyName('https://flags.example.com'), 'FLAGSMITH_API_KEY_flags_example_com');
});

test('an unsupported ship decision is blocked before the approval prompt', async () => {
  const { Steward } = await import('../src/steward.ts');
  const h = harness('should-not-be-asked', true);
  await h.run(PLAN);
  const store = new Store(h.dir);
  const r = store.load('checkout-button-copy');
  r.state = 'running';
  store.save(r);
  const s = new Steward({ store, flagsmith: () => { throw new Error('no network in this test'); } });
  assert.throws(() => s.checkShip('checkout-button-copy', { kind: 'variant', key: 'buy_now' }), /do not support shipping/);
  assert.doesNotThrow(() => s.checkShip('checkout-button-copy', { kind: 'control' }));
  assert.equal(await h.run(['approve', 'checkout-button-copy', '--decision', 'buy_now']), 3);
  assert.doesNotMatch(h.out.join('\n'), /APPROVAL 3\/3/);
});
