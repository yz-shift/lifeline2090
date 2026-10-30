// Headless Edge test of 生活片段 (local mode): post with a photo, react, reply, photo wall, mine, delete, phone layout.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const SHOTS = new URL('./screens/', import.meta.url);
mkdirSync(SHOTS, { recursive: true });
const shot = (n) => new URL(n + '.png', SHOTS).pathname.replace(/^\/([A-Z]:)/, '$1');

// a small gradient PNG built by hand (no image libraries needed)
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 240 - y; raw[o + 1] = 160 + x / 4; raw[o + 2] = 90 + y; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const port = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn('python', ['tools/serve.py', String(port)], { cwd: root, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/`;
const errors = [], steps = [];
let browser;
try {
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test((m.location() || {}).url || '')) errors.push('console: ' + m.text()); });
  await page.goto(url + '#stories');
  await page.locator('.st-page').waitFor({ timeout: 30000 });
  await page.screenshot({ path: shot('stories-empty-light') });
  steps.push('stories empty ok');

  await page.getByRole('tab', { name: '写一段' }).click();
  await page.locator('#st-file').setInputFiles({ name: 'summer.png', mimeType: 'image/png', buffer: png(160, 110) });
  await page.locator('.st-preview-img').waitFor({ timeout: 5000 });
  await page.locator('#st-title').fill('外婆家的夏天');
  await page.locator('#st-text').fill('那年暑假，外婆每天傍晚切一个西瓜，我们坐在院子里等星星出来。\n后来我才知道，那就是幸福。');
  await page.locator('.st-tag', { hasText: '家人' }).click();
  await page.getByRole('button', { name: '发布' }).click();
  await page.locator('.st-detail-img').waitFor({ timeout: 15000 });
  steps.push('post with photo ok');

  await page.locator('.st-rbtn', { hasText: '温暖' }).click();
  await page.locator('.st-rbtn[aria-pressed="true"]').waitFor({ timeout: 5000 });
  await page.locator('#st-reply').fill('谢谢你，想起了我外婆。');
  await page.getByRole('button', { name: '发送' }).click();
  await page.locator('.st-reply', { hasText: '想起了我外婆' }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: shot('stories-detail-light'), fullPage: true });
  steps.push('react and reply ok');

  await page.getByRole('tab', { name: '照片墙' }).click();
  await page.locator('.st-tile').first().waitFor({ timeout: 5000 });
  await page.screenshot({ path: shot('stories-wall-light') });
  steps.push('photo wall ok');

  await page.getByRole('tab', { name: '我的' }).click();
  await page.locator('.st-card').first().click();
  await page.getByRole('button', { name: '删除这段故事' }).click();
  const okBtn = page.locator('[role=dialog], [role=alertdialog]').getByRole('button', { name: '删除', exact: true });
  if (await okBtn.count()) await okBtn.first().click();
  await page.locator('.st-empty').waitFor({ timeout: 8000 });
  steps.push('delete ok');

  for (const scheme of ['light', 'dark']) {
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme })).newPage();
    p.on('pageerror', (e) => errors.push('pageerror(phone): ' + e.message));
    await p.goto(url + '#stories');
    await p.locator('.st-page').waitFor({ timeout: 30000 });
    await p.getByRole('tab', { name: '写一段' }).click();
    await p.locator('.st-form').waitFor();
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    if (sw > 391) errors.push(`phone overflow ${scheme}: ${sw}`);
    await p.screenshot({ path: shot(`stories-compose-phone-${scheme}`), fullPage: true });
    steps.push('phone ' + scheme + ' ok');
  }
} catch (e) {
  try { const pg = browser && browser.contexts()[0] && browser.contexts()[0].pages()[0]; if (pg) await pg.screenshot({ path: shot('stories-failure') }); } catch { /* ignore */ }
  errors.push('test failure: ' + String(e && e.message || e).split('\n')[0]);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
console.log(JSON.stringify({ steps, errors }, null, 1));
process.exit(errors.length ? 1 : 0);
