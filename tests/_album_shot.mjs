// Screenshots of the album (desktop + phone) and the downloaded card image: node tests/_album_shot.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const shot = (n) => root + '/tests/screens/' + n;
const port = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn('python', ['tools/serve.py', String(port)], { cwd: root, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/`;
const col = { v: 1, lives: 3, sexes: ['male'], countries: ['CHN'], regions: ['EAS'], seen: [], cards: {} };
for (const id of ['first_life', 'long90', 'married', 'gaokao', 'rare_astronaut', 'all_five', 'pet', 'uni', 'millionaire', 'lockdown', 'ai_doctor'])
  col.cards[id] = { at: '2026-10-27T08:00:00Z', n: id === 'married' ? 3 : 1, life: { name: '林晓雨', by: 2000, country: 'CHN', age: 91 } };
const errors = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  await new Promise((r) => setTimeout(r, 900));
  for (const [name, vp, scheme] of [['desktop', { width: 1280, height: 860 }, 'light'], ['phone', { width: 390, height: 844 }, 'dark']]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, acceptDownloads: true });
    await ctx.addInitScript((c) => { localStorage.setItem('ll2090.lifetime', JSON.stringify(c)); }, col);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url + '#album');
    await page.locator('.ac-progress-t').waitFor({ timeout: 30000 });
    await page.screenshot({ path: shot(`${name}-album-grid.png`) });
    await page.getByRole('button', { name: /见到宇航员/ }).click();
    await page.locator('.ac-dialog:not([hidden]) .ac-big').waitFor();
    await page.screenshot({ path: shot(`${name}-album-dialog.png`) }); console.log(name, 'dialog shot');
    if (name === 'desktop') {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.getByRole('button', { name: '下载这张卡片' }).click()]);
      await dl.saveAs(shot('card-astronaut.png')); console.log('card saved');
    }
    if (name !== 'desktop') await ctx.close();
  }
} catch (e) { errors.push(String(e.message).split('\n')[0]); }
await browser.close(); server.kill();
console.log(errors.length ? errors : 'ok');
