// Headless end-to-end smoke test with the installed Microsoft Edge.
// Usage: node tests/e2e.mjs   (builds nothing; run `node tools/build.mjs` first)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const SHOTS = new URL('./screens/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const shot = (name) => new URL(name + '.png', SHOTS).pathname.replace(/^\/([A-Z]:)/, '$1');

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const server = spawn('python', ['tools/serve.py', String(port), '--log'], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), stdio: ['ignore', 'ignore', 'pipe'] });
const reqLog = [];
server.stderr.on('data', (b) => { for (const l of String(b).split(/\r?\n/)) if (/ 404 /.test(l)) reqLog.push(l.trim()); });
const url = `http://127.0.0.1:${port}/`;
const errors = [];
const results = [];
const log = (m) => { results.push(m); console.log(m); };
let browser;

async function overflow(page, label) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  const cw = await page.evaluate(() => document.documentElement.clientWidth);
  if (sw > cw + 1) { errors.push(`horizontal overflow on ${label}: ${sw} > ${cw}`); }
}

/** Resolve the next decision; returns false when the life ended first (e.g. an infant death). */
async function handleDecision(page, mode) {
  const dlg = page.locator('.g-opt').first();
  const dead = page.locator('[aria-label="一生的数字"]');
  await Promise.race([dlg.waitFor({ timeout: 25000 }), dead.waitFor({ timeout: 25000 })]);
  if (!(await dlg.count()) && (await dead.count())) return false;
  if (mode === 'custom') {
    await page.locator('textarea.g-custom-ta').first().fill('我想去学编程，将来做软件工程师');
    await page.getByRole('button', { name: '按我的想法' }).first().click();
  } else {
    await dlg.click();
  }
  const cont = page.locator('button.g-res-cont');
  await cont.waitFor({ timeout: 30000 });
  await cont.click();
  return true;
}

try {
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test((m.location() || {}).url || '')) errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(url);
  await page.getByRole('button', { name: '随机出生' }).first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: shot('desktop-home-light') });
  log('home ok');

  await page.getByRole('button', { name: '随机出生' }).first().click();
  const start = page.getByRole('button', { name: '开始这一生' }).first();
  await start.waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: shot('desktop-birth-light') });
  log('birth card ok');
  await start.click();

  const skip = page.getByRole('button', { name: '跳到下一个抉择' }).first();
  await skip.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('desktop-game-light') });
  log('game ok');

  const isDead = async () => (await page.locator('[aria-label="一生的数字"]').count()) > 0;
  for (const mode of ['option', 'custom', 'option']) {
    if (await isDead()) break;
    await skip.click();
    if (await handleDecision(page, mode)) log('decision ' + mode + ' ok');
  }
  await page.screenshot({ path: shot('desktop-game-mid-light') });

  // proactive custom action (skipped when the life already ended)
  if (!(await isDead())) {
  await page.getByRole('button', { name: '主动选择' }).first().click();
  const ta = page.locator('textarea.g-custom-ta').first();
  await ta.waitFor({ timeout: 10000 });
  await ta.fill('周末开始跑步锻炼身体');
  await page.getByRole('button', { name: /就这么做|按我的想法/ }).first().click();
  await page.locator('button.g-res-cont').waitFor({ timeout: 30000 });
  await page.locator('button.g-res-cont').click();
  log('custom action ok');
  }

  // fast-forward to death
  const deathMark = page.locator('[aria-label="一生的数字"]');
  for (let i = 0; i < 80; i++) {
    if (await deathMark.count()) break;
    if (await page.locator('.g-opt').count()) { await handleDecision(page, 'option'); continue; }
    if (await skip.count() && await skip.isVisible() && await skip.isEnabled()) await skip.click();
    await page.waitForTimeout(400);
  }
  await deathMark.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('desktop-death-light'), fullPage: true });
  log('death screen ok');

  for (const route of []) {
    await page.goto(url + '#' + route);
    await page.waitForTimeout(900);
    await page.screenshot({ path: shot('desktop-' + route + '-light') });
    log('route ' + route + ' ok');
  }

  const dump = await page.evaluate(() => {
    const past = JSON.parse(localStorage.getItem('ll2090.past') || '[]');
    const rec = past[0] || {};
    const st = rec.state || {};
    const m = (st.person || {}).money;
    const big = (st.log || []).filter((e) => e.effects && Math.abs(e.effects.wealthDelta || 0) > 0).map((e) => [e.year, e.kind, Math.round(e.effects.wealthDelta), String(e.text).slice(0, 40)]);
    big.sort((a, b) => Math.abs(b[2]) - Math.abs(a[2]));
    return { money: m, income: m && m.income, top: big.slice(0, 12), decisions: (st.decisions || []).map((d) => d.year + ' ' + d.title + ' -> ' + d.choice).slice(0, 40) };
  });
  console.log(JSON.stringify(dump, null, 1));
} catch (e) {
  errors.push('test failure: ' + (e && e.message ? e.message.split('\n')[0] : String(e)));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
console.log(JSON.stringify({ steps: results, errors, notFound: reqLog }, null, 1));
process.exit(errors.length ? 1 : 0);
