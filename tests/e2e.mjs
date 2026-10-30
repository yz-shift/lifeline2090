// Headless end-to-end smoke test with the installed Microsoft Edge.
// Usage: node tests/e2e.mjs   (builds nothing; run `node tools/build.mjs` first)
// Besides the screens, it plays the interactivity layer (CONTRACT §10) where the engine provides it: a focus chip,
// an inline small choice, a reflection, naming a child, a star on a log line, both side panels, the music switch,
// the 16x speed and a decision set aside behind the '有一个抉择正在等你' pill. Parts the engine does not offer yet
// are reported as skipped, never as passed.
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

const REFLECT_TEXT = '希望长大以后，还记得今天的阳光。';
const CHILD_NAME = '林晓禾';
const done = { reflected: false, named: false };

/** Wait until one of the locators is attached (or the timeout passes). Never rejects, so no stray rejections. */
const waitAny = (locators, timeout = 25000) => Promise.race(locators.map((l) => l.waitFor({ timeout }).then(() => true, () => false)));

async function overflow(page, label) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  const cw = await page.evaluate(() => document.documentElement.clientWidth);
  if (sw > cw + 1) { errors.push(`horizontal overflow on ${label}: ${sw} > ${cw}`); }
}

/** The autosaved life (localStorage), for checks on what the interactions wrote. */
async function savedLife(page) {
  return page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ll2090.current') || 'null'); } catch { return null; } });
}

/**
 * Handle an open moment dialog: write a reflection the first time (then just continue), name a child the first
 * time (then keep the suggestion). Returns the kind handled or null.
 */
async function handleMoment(page) {
  const naming = page.locator('.g-mom--naming');
  if (await naming.count()) {
    if (!done.named) {
      await naming.locator('input.g-mom-input').fill(CHILD_NAME);
      await naming.getByRole('button', { name: '就叫这个名字' }).click();
      await naming.waitFor({ state: 'detached', timeout: 5000 });
      const life = await savedLife(page);
      const kids = (life && life.person && life.person.children) || [];
      if (!kids.some((c) => c && String(c.name).includes(CHILD_NAME))) errors.push('naming: the chosen name is not on the child');
      done.named = true;
      log('naming a child ok');
    } else {
      await page.keyboard.press('Escape');
      await naming.waitFor({ state: 'detached', timeout: 5000 });
    }
    return 'naming';
  }
  const refl = page.locator('.g-mom--reflect');
  if (await refl.count()) {
    if (!done.reflected) {
      await page.screenshot({ path: shot('desktop-reflection-light') }).catch(() => {});
      await refl.locator('textarea').fill(REFLECT_TEXT);
      await refl.getByRole('button', { name: '记下来' }).click();
      await refl.waitFor({ state: 'detached', timeout: 5000 });
      const life = await savedLife(page);
      const notes = (life && life.notes) || [];
      if (!notes.some((n) => n && n.text === REFLECT_TEXT)) errors.push('reflection: the note was not saved with the life');
      done.reflected = true;
      log('reflection ok');
    } else {
      await refl.getByRole('button', { name: '不写了，继续' }).click();
      await refl.waitFor({ state: 'detached', timeout: 5000 });
    }
    return 'reflect';
  }
  const th = page.locator('.g-mom--thought');
  if (await th.count()) {
    await th.getByRole('button', { name: '算了' }).click();
    return 'thought';
  }
  return null;
}

/**
 * Resolve the next decision; moments on the way (reflection, naming) are handled first. mode: 'option' | 'custom' |
 * 'later' (set the decision aside, come back through the pill, then choose). Returns false when the life ended first.
 */
async function handleDecision(page, mode) {
  const opt = page.locator('.g-opt').first();
  const mom = page.locator('.g-mom').first();
  const dead = page.locator('[aria-label="一生的数字"]');
  for (let i = 0; i < 10; i++) {
    await waitAny([opt, mom, dead]);
    if (await mom.count()) { await handleMoment(page); continue; }
    break;
  }
  if (!(await opt.count()) && (await dead.count())) return false;
  if (!(await opt.count())) throw new Error('no decision appeared');
  if (mode === 'later') {
    await page.getByRole('button', { name: '先看看再选' }).first().click();
    const pill = page.locator('button.g-pill');
    await pill.waitFor({ timeout: 5000 });
    if (!(await pill.isVisible())) errors.push('decision set aside: the pill is not visible');
    const play = page.locator('button.g-cb--play').first();
    if (await play.isEnabled()) errors.push('decision set aside: the clock can run while a decision waits');
    await page.screenshot({ path: shot('desktop-decision-waiting-light') });
    await pill.click();
    await page.locator('.g-opt').first().waitFor({ timeout: 5000 });
    log('decision set aside and resumed ok');
  }
  if (mode === 'custom') {
    // the built-in engine says how it reads the text before the player commits (no AI in this run)
    await page.locator('textarea.g-custom-ta').first().fill('选第二个');
    await page.locator('.g-custom-read').filter({ hasText: '会按选项' }).waitFor({ timeout: 5000 })
      .catch(() => errors.push('custom: no "会按选项" line for 选第二个'));
    await page.locator('textarea.g-custom-ta').first().fill('我想去学编程，将来做软件工程师');
    await page.locator('.g-custom-read').filter({ hasText: '会理解为' }).waitFor({ timeout: 5000 })
      .catch(() => errors.push('custom: no "会理解为" line'));
    await page.screenshot({ path: shot('desktop-decision-custom-read') });
    await page.getByRole('button', { name: '按我的想法' }).first().click();
  } else {
    await page.locator('.g-opt').first().click();
  }
  const cont = page.locator('button.g-res-cont');
  await cont.waitFor({ timeout: 30000 });
  await cont.click();
  return true;
}

/** Pick a focus chip other than auto (needs age >= 6 and the engine's focus API). */
async function chooseFocus(page) {
  const box = page.locator('.g-focus');
  if (!(await box.count()) || !(await box.isVisible())) return 'skipped (no focus API in the engine)';
  const chip = page.locator('.g-focus .g-chip:not(.g-chip--auto):not(.g-chip--off)').first();
  if (!(await chip.count())) return 'skipped (no focus option this year)';
  const label = ((await chip.locator('.g-chip-l').textContent()) || '').trim();
  await chip.click();
  await page.waitForTimeout(150);
  const pressed = await page.locator('.g-focus .g-chip[aria-pressed="true"] .g-chip-l').first().textContent();
  if (!pressed || !pressed.includes(label.replace(/^✓\s*/, ''))) errors.push(`focus: chip "${label}" is not marked as chosen`);
  const st = ((await page.locator('.g-focus-st').textContent()) || '').trim();
  if (!st || st.startsWith('自动')) errors.push(`focus: the status line still says auto: ${st}`);
  const life = await savedLife(page);
  if (!life || !life.focus || life.focus.current == null) errors.push('focus: the choice was not saved with the life');
  // keyboard: arrow keys move between chips, Enter picks the auto chip again
  await page.locator('.g-focus .g-chip[aria-pressed="true"]').first().focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  if (!(await page.locator('.g-focus .g-chip--auto[aria-pressed="true"]').count())) errors.push('focus: keyboard could not go back to auto');
  await chip.click();   // leave a chosen focus for the rest of the life
  return 'ok';
}

/** Wait for an inline small choice and answer it (decisions and moments that come first are handled). */
async function answerSmallChoice(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (await page.locator('[aria-label="一生的数字"]').count()) return 'skipped (the life ended)';
    if (await page.locator('.g-mom').count()) { await handleMoment(page); continue; }
    if (await page.locator('.g-opt').count()) { await handleDecision(page, 'option'); continue; }
    const btn = page.locator('.g-sm:not(.g-sm--done) .g-sm-opt').first();
    if (await btn.count()) {
      const card = page.locator('.g-sm:not(.g-sm--done)').first();
      const cd = ((await card.locator('.g-sm-cdt').textContent().catch(() => '')) || '').trim();
      if (!/自动决定/.test(cd)) errors.push(`small choice: no countdown hint (${cd})`);
      const label = ((await btn.locator('.g-sm-l').textContent()) || '').trim();
      const clock = await page.locator('button.g-cb--play').first().getAttribute('aria-label');
      await btn.click();
      await page.locator('.g-sm--done').first().waitFor({ timeout: 5000 });
      const pick = ((await page.locator('.g-sm--done .g-sm-pick').first().textContent()) || '').trim();
      if (!pick) errors.push('small choice: no result shown in the card');
      const after = await page.locator('button.g-cb--play').first().getAttribute('aria-label');
      if (clock === '暂停' && after !== '暂停') errors.push('small choice: answering stopped the clock');
      await page.screenshot({ path: shot('desktop-small-choice-light') });
      return `ok (${label})`;
    }
    await page.waitForTimeout(400);
  }
  return 'skipped (no small choice appeared within a minute)';
}

/** Star the newest log line and check the counter. */
async function starLine(page) {
  const star = page.locator('.g-log .g-star').first();
  if (!(await star.count())) return 'skipped (no log ids / toggleStar in the engine)';
  await star.click();
  await page.waitForTimeout(150);
  if ((await star.getAttribute('aria-pressed')) !== 'true') errors.push('star: the log line is not marked');
  const cnt = ((await page.locator('.g-log-stars').textContent()) || '').trim();
  if (!/1\/12/.test(cnt)) errors.push(`star: counter says "${cnt}"`);
  const life = await savedLife(page);
  if (!life || !Array.isArray(life.stars) || life.stars.length !== 1) errors.push('star: not saved with the life');
  return 'ok';
}

/** Open both side panels when the shell provides them; each must pause the clock and close with Escape. */
async function openPanels(page) {
  const out = [];
  for (const name of ['家人与生活', '花钱·投资']) {
    const btn = page.locator(`.g-ctrl button[aria-label="${name}"]`).first();
    if (!(await btn.count())) { out.push(`${name} skipped (no app.openPanel)`); continue; }
    await btn.click();
    const sheet = page.locator('.ll-sheet').first();
    await sheet.waitFor({ timeout: 8000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot(`desktop-panel-${name === '家人与生活' ? 'family' : 'money'}-light`) });
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 5000 });
    out.push(`${name} ok`);
  }
  return out.join(', ');
}

/** Turn the music on and off again (WebAudio only; no console errors). */
async function toggleMusic(page) {
  const btn = page.locator('.g-ctrl button[aria-label="背景音乐"]').first();
  if (!(await btn.count()) || !(await btn.isVisible())) return 'skipped (no WebAudio)';
  const before = await btn.getAttribute('aria-pressed');
  await btn.click();
  await page.waitForTimeout(700);
  const mid = await btn.getAttribute('aria-pressed');
  if (mid === before) errors.push('music: the switch did not change');
  await btn.click();
  await page.waitForTimeout(300);
  if ((await btn.getAttribute('aria-pressed')) !== before) errors.push('music: the switch did not come back');
  return 'ok';
}

/**
 * Set the speed with the button group when it is shown, else with the cycle button (laptops and phones).
 * Returns true when the control bar shows that speed afterwards.
 */
async function setSpeed(page, x) {
  const label = `${x}×`;
  const btn = page.locator(`.g-spd[data-x="${x}"]`).first();
  if (await btn.isVisible()) {
    await btn.click();
    return (await btn.getAttribute('aria-pressed')) === 'true';
  }
  const cyc = page.locator('button.g-cb--cycle').first();
  for (let i = 0; i < 8; i++) {
    if (((await cyc.textContent()) || '').trim() === label) return true;
    await cyc.click();
  }
  return ((await cyc.textContent()) || '').trim() === label;
}

/** Visible buttons in the header and the game control bar must be at least 40 x 40 px (phone tap targets). */
async function tapTargets(page, label) {
  const small = await page.$$eval('.ll-header button, .g-ctrl button', (els) => els
    .filter((e) => e.offsetParent !== null)
    .map((e) => { const r = e.getBoundingClientRect(); return { b: e.getAttribute('aria-label') || e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.w < 40 || x.h < 40));
  if (small.length) errors.push(`small tap targets on ${label}: ${JSON.stringify(small)}`);
}

/**
 * Pause, open the page again and continue the autosaved life from the home screen's resume card: the same year
 * comes back, the clock runs again and no year appears twice in the life log. Returns 'ok' or why it was skipped.
 */
async function resumeAfterReload(page) {
  const play = page.locator('button.g-cb--play').first();
  if (!(await play.isEnabled())) return 'skipped (a decision is open)';
  if ((await play.getAttribute('aria-label')) === '暂停') await play.click();
  const yearBefore = ((await page.locator('.g-strip-year').first().textContent()) || '').trim();
  await page.goto(url);   // a full load of the page without the #game anchor
  const resume = page.getByRole('button', { name: '继续这一生' }).first();
  await resume.waitFor({ timeout: 30000 });
  await resume.click();
  await page.locator('button.g-cb--skip').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(300);
  if (await page.locator('.g-mom').count()) await handleMoment(page);
  const yearAfter = ((await page.locator('.g-strip-year').first().textContent()) || '').trim();
  if (yearAfter !== yearBefore) errors.push(`resume after reload: year ${yearBefore} -> ${yearAfter}`);
  const years = await page.$$eval('.g-yr', (els) => els.map((e) => e.dataset.year));
  if (!years.length || new Set(years).size !== years.length) errors.push(`resume after reload: year groups ${years.join(',')}`);
  const label = await page.locator('button.g-cb--play').first().getAttribute('aria-label');
  if (label !== '暂停') errors.push(`resume after reload: the clock is not running (play button says ${label})`);
  return 'ok';
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
  log('music ' + await toggleMusic(page));

  const isDead = async () => (await page.locator('[aria-label="一生的数字"]').count()) > 0;
  for (const mode of ['option', 'custom', 'later']) {
    if (await isDead()) break;
    await skip.click();
    if (await handleDecision(page, mode)) log('decision ' + mode + ' ok');
    if (await isDead()) break;
    if (mode === 'option') log('star ' + await starLine(page));
    if (mode === 'custom') log('focus ' + await chooseFocus(page));
  }
  if (!done.reflected) log('reflection skipped (no reflectPending from the engine at 5 or 15)');
  await page.screenshot({ path: shot('desktop-game-mid-light') });

  if (!(await isDead())) {
    // small choices are inline and never stop the clock: let the year run at 4x and answer one
    await setSpeed(page, 4);
    log('small choice ' + await answerSmallChoice(page));
  }

  if (!(await isDead())) log('panels ' + await openPanels(page));

  // proactive custom action (skipped when the life already ended)
  if (!(await isDead())) {
    if (await page.locator('.g-opt').count()) await handleDecision(page, 'option');
    if (await page.locator('.g-mom').count()) await handleMoment(page);
    await page.getByRole('button', { name: '主动选择' }).first().click();
    const ta = page.locator('textarea.g-custom-ta').first();
    await ta.waitFor({ timeout: 10000 });
    await ta.fill('周末开始跑步锻炼身体');
    await page.getByRole('button', { name: /就这么做|按我的想法/ }).first().click();
    await page.locator('button.g-res-cont').waitFor({ timeout: 30000 });
    await page.locator('button.g-res-cont').click();
    log('custom action ok');
  }

  // 16x, then fast-forward to death (children born on the way are named once)
  if (await isDead()) log('speed skipped (the life ended early)');
  else if (!(await setSpeed(page, 16))) errors.push('speed: 16x is not selected');
  else log('speed 16x ok');
  const deathMark = page.locator('[aria-label="一生的数字"]');
  for (let i = 0; i < 120; i++) {
    if (await deathMark.count()) break;
    if (await page.locator('.g-mom').count()) { await handleMoment(page); continue; }
    if (await page.locator('.g-opt').count()) { await handleDecision(page, 'option'); continue; }
    if (await skip.count() && await skip.isVisible() && await skip.isEnabled()) await skip.click();
    await page.waitForTimeout(400);
  }
  await deathMark.waitFor({ timeout: 30000 });
  if (!done.named) log('naming skipped (no child was born in this life, or no namingPending from the engine)');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot('desktop-death-light'), fullPage: true });
  log('death screen ok');

  // achievement cards: the life's cards flip in on the death screen; the album shows them and opens a detail dialog
  // 人生长卷: the poster opens in a preview with a real image (long-press to save on phones), Escape closes it
  await page.getByRole('button', { name: '生成人生长卷 · 分享图' }).click();
  await page.locator('.g-poster-ov:not([hidden]) .g-poster-img').waitFor({ timeout: 20000 });
  const pw = await page.locator('.g-poster-img').evaluate((im) => new Promise((r) => (im.complete ? r(im.naturalWidth) : im.addEventListener('load', () => r(im.naturalWidth)))));
  if (pw !== 1080) errors.push('poster: image width ' + pw);
  await page.screenshot({ path: shot('desktop-poster') });
  await page.keyboard.press('Escape');
  if (!(await page.locator('.g-poster-ov[hidden]').count())) errors.push('poster preview did not close on Escape');
  log('poster ok');

  const lifeCards = await page.locator('.g-cards .ac-card').count();
  if (!lifeCards) errors.push('cards: no achievement cards on the death screen');
  if (!(await page.locator('.g-cards .ac-fresh').count())) errors.push('cards: no NEW card after the first life');
  await page.locator('.g-cards').getByRole('button', { name: '打开成就图鉴' }).click();
  await page.locator('.ac-progress-t').waitFor({ timeout: 10000 });
  const prog = await page.locator('.ac-progress-t').textContent();
  if (!/已收集 [1-9]\d* \/ \d+/.test(prog || '')) errors.push('album progress: ' + prog);
  await page.locator('.ac-card.ac-got').first().click();
  await page.locator('.ac-dialog:not([hidden]) .ac-big').waitFor({ timeout: 5000 });
  await page.screenshot({ path: shot('desktop-album') });
  await page.keyboard.press('Escape');
  if (!(await page.locator('.ac-dialog[hidden]').count())) errors.push('album dialog did not close on Escape');
  log(`cards ok (${lifeCards} on the death screen, ${prog})`);

  for (const route of ['album', 'memorial', 'shared', 'past', 'about', 'settings', 'feedback']) {
    await page.goto(url + '#' + route);
    await page.waitForTimeout(900);
    await page.screenshot({ path: shot('desktop-' + route + '-light') });
    log('route ' + route + ' ok');
  }

  // phone width, light + dark
  for (const scheme of ['light', 'dark']) {
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: scheme });
    const p = await pctx.newPage();
    p.on('pageerror', (e) => errors.push('pageerror(phone): ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test((m.location() || {}).url || '')) errors.push('console(phone): ' + m.text()); });
    await p.goto(url);
    await p.getByRole('button', { name: '随机出生' }).first().waitFor({ timeout: 30000 });
    await p.screenshot({ path: shot(`phone-home-${scheme}`), fullPage: true });
    await overflow(p, `phone home ${scheme}`);
    await p.getByRole('button', { name: '随机出生' }).first().click();
    const st = p.getByRole('button', { name: '开始这一生' }).first();
    await st.waitFor({ timeout: 20000 });
    await p.waitForTimeout(500);
    await p.screenshot({ path: shot(`phone-birth-${scheme}`), fullPage: true });
    await overflow(p, `phone birth ${scheme}`);
    await st.click();
    const sk = p.getByRole('button', { name: '跳到下一个抉择' }).first();
    await sk.waitFor({ timeout: 20000 });
    await sk.click();
    await handleDecision(p, 'option');
    if (!(await p.locator('[aria-label="一生的数字"]').count())) {
      // a second decision brings the life past 6, where the focus chips appear
      await sk.click();
      await handleDecision(p, 'option');
    }
    await p.waitForTimeout(800);
    await p.screenshot({ path: shot(`phone-game-${scheme}`) });
    await overflow(p, `phone game ${scheme}`);
    await tapTargets(p, `phone game ${scheme}`);
    const fr = p.locator('.g-focus-scroll');
    if (await fr.count() && await fr.isVisible()) {
      const box = await fr.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
      if (box.sw > box.cw && box.ox !== 'auto' && box.ox !== 'scroll') errors.push(`phone ${scheme}: the focus row overflows without scrolling`);
    }
    if (scheme === 'light' && !(await p.locator('[aria-label="一生的数字"]').count())) {
      const r = await resumeAfterReload(p);
      log('phone resume after reload ' + r);
    }
    if (scheme === 'dark' && !(await p.locator('[aria-label="一生的数字"]').count())) {
      if (await p.locator('.g-mom').count()) await handleMoment(p);
      if (await sk.isEnabled()) {
        await sk.click();
        await waitAny([p.locator('.g-opt').first(), p.locator('.g-mom').first()], 20000);
        if (await p.locator('.g-mom').count()) {
          await p.screenshot({ path: shot('phone-moment-dark') });
          await handleMoment(p);
        }
        await waitAny([p.locator('.g-opt').first()], 20000);
        if (await p.locator('.g-opt').count()) {
          await p.screenshot({ path: shot('phone-decision-dark') });
          await handleDecision(p, 'option');
        }
      }
      for (const route of ['about', 'memorial', 'past', 'shared', 'settings', 'feedback']) {
        await p.goto(url + '#' + route);
        await p.waitForTimeout(800);
        await overflow(p, `phone ${route} dark`);
        await p.screenshot({ path: shot(`phone-${route}-dark`) });
      }
    }
    await pctx.close();
    log('phone ' + scheme + ' ok');
  }
} catch (e) {
  errors.push('test failure: ' + (e && e.message ? e.message.split('\n')[0] : String(e)));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
console.log(JSON.stringify({ steps: results, errors, notFound: reqLog }, null, 1));
process.exit(errors.length ? 1 : 0);
