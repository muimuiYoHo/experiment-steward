// Persistent CDP helper: reads one JSON command per line on stdin, replies "ok" per line.
import { chromium } from 'playwright-core';
import { createInterface } from 'node:readline';
const b = await chromium.connectOverCDP('http://localhost:9333');
const page = b.contexts()[0].pages()[0];
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const c = JSON.parse(line);
  try {
    if (c.op === 'goto') { await page.goto(c.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(c.settle ?? 1200); }
    if (c.op === 'click') await page.getByText(c.text, { exact: c.exact ?? false }).first().click();
    if (c.op === 'scroll') await page.mouse.wheel(0, c.dy);
    if (c.op === 'scrollTo') await page.getByText(c.text).first().scrollIntoViewIfNeeded();
    if (c.op === 'wait') await page.waitForTimeout(c.ms);
    if (c.op === 'waitText') await page.getByText(c.text).first().waitFor({ timeout: c.ms ?? 15000 });
    if (c.op === 'shot') await page.screenshot({ path: c.path });
    process.stdout.write('ok\n');
  } catch (e) { process.stdout.write('err ' + String(e).split('\n')[0] + '\n'); }
}
await b.close();
