// Render 人生长卷 posters of a few simulated lives in headless Edge: node tests/_poster_shot.mjs [seed ...]
// Writes tests/screens/poster-<seed>.png
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
const port = await new Promise((r) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const errors = [];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  await new Promise((r) => setTimeout(r, 900));
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/tests/`);
  const out = await page.evaluate(async (seeds) => {
    const [{ makeDataStore }, { createWorld }, { customBirth }, { simulateLife }, { Rng }, cards, ach] = await Promise.all([
      import('/src/core/data.js'), import('/src/core/world.js'), import('/src/core/person.js'), import('/src/core/cohort.js'),
      import('/src/core/rng.js'), import('/src/ui/cards.js'), import('/src/core/achievements.js')]);
    const rd = async (f) => (await fetch('/data/' + f)).json();
    const data = makeDataStore({ countries: await rd('countries.json'), mortality: await rd('mortality.json'), content: await rd('content.json') });
    const res = [];
    for (const seed of seeds.length ? seeds : [5003, 5011, 5020]) {
      const world = createWorld(data, seed * 7 + 3);
      const spec = customBirth(data, world, new Rng(seed), { country: 'CHN', year: 2003 });
      const r = simulateLife(data, world, spec, seed); const st = r.state || r;
      // a written choice, as a player would leave one
      if (Array.isArray(st.decisions) && st.decisions.length > 2) Object.assign(st.decisions[2], { custom: true, choice: '每月定投美股，再用AI接文案单' });
      const got = ach.evaluateLife(st).map((id) => ach.achievementDef(id)).filter(Boolean);
      const blob = await cards.lifePoster(st, data, { title: '', cards: got, url: cards.shareUrl() });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      res.push({ seed, b64: btoa(bin), age: st.dead.age, n: got.length, exams: st.person.education.exams });
    }
    return res;
  }, seeds);
  for (const o of out) {
    writeFileSync(`${root}/tests/screens/poster-${o.seed}.png`, Buffer.from(o.b64, 'base64'));
    console.log(o.seed, 'age', o.age, 'cards', o.n, JSON.stringify(o.exams));
  }
} catch (e) { errors.push(String(e.message).split('\n')[0]); }
await browser.close(); server.kill();
console.log(errors.length ? errors : 'ok');
