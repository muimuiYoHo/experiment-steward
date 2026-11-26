import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flagsmith } from '../src/flagsmith.ts';
import { draftPlan, type Plan } from '../src/plan.ts';
import { Steward } from '../src/steward.ts';
import { newRecord, Store } from '../src/store.ts';
import { FakeFlagsmith } from './fake-flagsmith.ts';

export function samplePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    ...draftPlan({
      name: 'Checkout button copy',
      flag: 'checkout_cta',
      controlValue: 'Checkout',
      variants: ['buy_now=Buy now'],
      event: 'checkout_completed',
      hypothesis: 'Buy now increases completed checkouts',
    }),
    ...overrides,
  };
}

export function setup(plan = samplePlan()) {
  const dir = mkdtempSync(join(tmpdir(), 'steward-'));
  const store = new Store(dir);
  store.save(newRecord(plan));
  const fake = new FakeFlagsmith();
  let clock = new Date('2026-11-26T03:00:00Z');
  const steward = new Steward({
    store,
    flagsmith: () => new Flagsmith(fake, 'ENVKEY', 1),
    now: () => clock,
    sleep: async () => {},
  });
  return {
    dir,
    store,
    fake,
    steward,
    plan,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
