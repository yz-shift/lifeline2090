// Smoke test of the standalone website build (dist-web) served by a plain static server.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const shot = (n) => new URL('./screens/' + n + '.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const port = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn('python', ['-m', 'http.server', String(port), '-d', 'dist-web'], { cwd: root, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/`;
const errors = [], steps = [];
let browser;
try {
  await new Promise((r) => setTimeout(r, 900));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test((m.location() || {}).url || '')) errors.push('console: ' + m.text()); });
  await page.goto(url);
  await page.getByRole('button', { name: '随机出生' }).first().waitFor({ timeout: 30000 });
  if (!(await page.locator('text=每秒约有').count())) errors.push('home text not rendered (charset?)');
  steps.push('home ok');
  await page.getByRole('button', { name: '随机出生' }).first().click();
  await page.getByRole('button', { name: '开始这一生' }).first().click();
  await page.getByRole('button', { name: '跳到下一个抉择' }).first().waitFor({ timeout: 20000 });
  steps.push('game ok');
  await page.goto(url + '#shared');
  await page.locator('.s-card-photo').first().waitFor({ timeout: 15000 });
  const n = await page.locator('.s-card').count();
  await page.waitForFunction(() => { const i = document.querySelector('.s-card-photo'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 }).catch(() => {});
  const loaded = await page.locator('.s-card-photo').first().evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!loaded) errors.push('seed life photo did not load');
  await page.screenshot({ path: shot('web-shared') });
  steps.push(`shared lives ok (${n} cards)`);
  await page.goto(url + '#stories');
  await page.getByRole('tab', { name: '照片墙' }).click();
  await page.locator('.st-tile img').first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: shot('web-wall') });
  steps.push('photo wall ok');
} catch (e) {
  errors.push('test failure: ' + String(e && e.message || e).split('\n')[0]);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
console.log(JSON.stringify({ steps, errors }, null, 1));
process.exit(errors.length ? 1 : 0);
