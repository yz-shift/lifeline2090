// Tests for the app shell and the non-game screens' pure helpers (src/ui/app.js, screens/home.js, screens/birth.js,
// and the v2 interactivity helpers in screens/death.js, screens/money.js, screens/family.js).
// The UI modules import the whole app, including core modules that may not exist yet while the game is being built,
// so the helpers are bundled with esbuild first; a module whose file is missing is replaced by an empty stub.
// Run: node --test tests/shell.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const entry = `
export { sanitizeSettings, archiveNo, DEFAULT_SETTINGS, SCREEN_TITLES, AUTO_TEXTURES, COMPARE_YEAR_MIN, COMPARE_YEAR_MAX, upgradeLife, PANEL_NAMES } from './ui/app.js';
export { summaryOf, starredMoments, lifeNotes, finalNote, setFinalNote, childrenLines, compareBirthplace, FINAL_MAX } from './ui/screens/death.js';
export { normalizeAlloc, allocToPercents, habitLevels, breakdownView, habitCosts, applyHabit, applyAllocation, HABITS, PRESETS } from './ui/screens/money.js';
export { fallbackFamilyView, familyViewOf, groupMembers, roleLabel } from './ui/screens/family.js';
export { worldBirthsPerYear } from './ui/screens/home.js';
export { familyWords, familyShort, normalizeParsed, birthFacts } from './ui/screens/birth.js';
export { archiveNumber } from './ui/cards.js';
export { makeDataStore } from './core/data.js';
export { createWorld } from './core/world.js';
`;

const missing = new Set();
const out = await build({
  stdin: { contents: entry, resolveDir: src, sourcefile: 'shell-entry.js' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: ['es2022'], logLevel: 'silent',
  plugins: [{
    name: 'missing-module-stubs',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const p = resolvePath(args.resolveDir, args.path);
        if (existsSync(p)) return undefined;
        missing.add(basename(p));
        return { path: basename(p), namespace: 'stub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export {};', loader: 'js' }));
    },
  }],
});
const M = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
if (missing.size) console.log(`# stubbed (not written yet): ${[...missing].sort().join(', ')}`);

const readJson = (f) => JSON.parse(readFileSync(join(root, 'data', f), 'utf8'));
const contentPath = join(root, 'data', 'content.json');
const data = M.makeDataStore({
  countries: readJson('countries.json'),
  mortality: readJson('mortality.json'),
  content: existsSync(contentPath) ? readJson('content.json') : {},
});
const world = M.createWorld(data, 20260424);
const badText = (s) => /NaN|undefined|Infinity|\[object/.test(s);

test('sanitizeSettings keeps valid values and repairs invalid ones', () => {
  const ok = M.sanitizeSettings({ lifeMinutes: 60, aiMode: 'quick', decisionFreq: 'frequent', autoChoose: 1, theme: 'dark', lastWorld: { seed: '123', label: 'x' } });
  assert.equal(ok.lifeMinutes, 60);
  assert.equal(ok.aiMode, 'quick');
  assert.equal(ok.decisionFreq, 'frequent');
  assert.equal(ok.autoChoose, true);
  assert.equal(ok.theme, 'dark');
  assert.deepEqual(ok.lastWorld, { seed: 123, label: 'x' });
  const bad = M.sanitizeSettings({ lifeMinutes: 7, aiMode: 'turbo', decisionFreq: 'always', theme: 'blue', lastWorld: { seed: 'abc' } });
  assert.equal(bad.lifeMinutes, M.DEFAULT_SETTINGS.lifeMinutes);
  assert.equal(bad.aiMode, M.DEFAULT_SETTINGS.aiMode);
  assert.equal(bad.decisionFreq, M.DEFAULT_SETTINGS.decisionFreq);
  assert.equal(bad.theme, 'system');
  assert.equal(bad.lastWorld, null);
  for (const raw of [null, undefined, 'junk', 42, []]) assert.deepEqual(M.sanitizeSettings(raw), { ...M.DEFAULT_SETTINGS });
  assert.ok(M.SCREEN_TITLES.memorial && M.SCREEN_TITLES.feedback);
});

test('archiveNo matches the exported cards and accepts a bare BirthSpec', () => {
  const birth = { year: 2000, country: 'CHN', name: '林子安', date: '2000-03-14', time: '08:15:42' };
  const state = { id: 'life-1', seed: 42, birth };
  const no = M.archiveNo(state);
  assert.match(no, /^LL-2000-CHN-[0-9A-F]{6}$/);
  assert.equal(no, M.archiveNumber(state), 'screen and PNG card show the same number');
  assert.equal(M.archiveNo(state), no, 'stable');
  const fromSpec = M.archiveNo(birth);
  assert.match(fromSpec, /^LL-2000-CHN-[0-9A-F]{6}$/);
  assert.equal(fromSpec, M.archiveNumber({ birth, seed: null }), 'spec form equals the share-card fallback');
  assert.match(M.archiveNo(null), /^LL-0000-XXX-[0-9A-F]{6}$/);
});

test('worldBirthsPerYear uses UN WPP births (about 130 million a year, ~4 per second)', () => {
  for (const y of [2000, 2026, 2050]) {
    const n = M.worldBirthsPerYear(data, y);
    assert.ok(n > 1.0e8 && n < 1.6e8, `${y}: ${n}`);
  }
  const perSec = M.worldBirthsPerYear(data, 2026) / (365 * 86400);
  assert.ok(perSec > 3.5 && perSec < 4.6, `per second ${perSec}`);
  // falls back to summing series when birthsWeights is missing
  const lite = { isoList: data.isoList, series: (iso, key, y) => data.series(iso, key, y) };
  const a = M.worldBirthsPerYear(lite, 2010);
  const b = M.worldBirthsPerYear(data, 2010);
  assert.ok(Math.abs(a - b) / b < 0.02, `${a} vs ${b}`);
});

test('family wealth is described in words, never as a raw number', () => {
  const words = [0.05, 0.2, 0.3, 0.5, 0.7, 0.9, 0.97, 0.995].map(M.familyWords);
  assert.equal(new Set(words).size, words.length, 'every band has its own words');
  assert.ok(words.every((w) => typeof w === 'string' && w && !/\d\.\d/.test(w)));
  assert.equal(M.familyWords(NaN), '—');
  assert.equal(M.familyShort(0), '贫困家庭');
  assert.equal(M.familyShort(0.999), '富裕家庭');
  assert.equal(M.familyShort(undefined), '家境不详');
});

test('normalizeParsed keeps only valid custom-birth fields', () => {
  assert.equal(M.normalizeParsed(null, data), null);
  assert.equal(M.normalizeParsed({}, data), null);
  const p = M.normalizeParsed({
    year: 2041.4, country: 'bgd', sex: 'female', urban: false, familyPct: 1.7, parentsEdu: 'primary', siblings: 3,
    motherAge: 9, fatherAge: 33, name: '  Rahima  ', nameLatin: 'Rahima', date: '2041-02-30', time: '25:00:00',
    notes: ['渔村', 42, ''], extra: 'dropped',
  }, data);
  assert.equal(p.year, 2041);
  assert.equal(p.country, 'BGD');
  assert.equal(p.sex, 'female');
  assert.equal(p.urban, false);
  assert.equal(p.familyPct, 0.995);
  assert.equal(p.parentsEdu, 'primary');
  assert.equal(p.siblings, 3);
  assert.equal(p.motherAge, undefined, 'implausible mother age dropped');
  assert.equal(p.fatherAge, 33);
  assert.equal(p.name, 'Rahima');
  assert.equal(p.date, undefined, 'impossible date dropped');
  assert.equal(p.time, undefined);
  assert.deepEqual(p.notes, ['渔村']);
  assert.equal(p.extra, undefined);
  const q = M.normalizeParsed({ year: 2030, date: '2030-07-09', time: '06:30:00', country: 'XXX', sex: 'other' }, data);
  assert.equal(q.date, '2030-07-09');
  assert.equal(q.time, '06:30:00');
  assert.equal(q.country, undefined, 'unknown ISO3 dropped');
  assert.equal(q.sex, undefined);
  const r = M.normalizeParsed({ year: 1990, date: '1990-01-01' }, data);
  assert.equal(r, null, 'out-of-range year is not a field');
  const s = M.normalizeParsed({ fields: { year: 2005 } }, data);
  assert.equal(s.year, 2005, 'nested fields form accepted');
});

test('birthFacts: real-history card for China 2000 uses real data with meters in [0,1]', () => {
  const f = M.birthFacts(data, world, { year: 2000, country: 'CHN', sex: 'male' });
  const keys = f.facts.map((x) => x.key);
  for (const k of ['le', 'imr', 'gdp', 'internet', 'births']) assert.ok(keys.includes(k), `missing ${k}`);
  assert.ok(f.le > 65 && f.le < 75, `CHN 2000 male LE ${f.le}`);
  for (const x of f.facts) {
    assert.ok(!badText(`${x.label} ${x.value} ${x.unit} ${x.note}`), JSON.stringify(x));
    if (x.meter != null) assert.ok(x.meter >= 0 && x.meter <= 1, `${x.key} meter ${x.meter}`);
  }
  assert.ok(f.totalBirths > 1.2e5 && f.totalBirths < 1.5e5, `world births (thousands) ${f.totalBirths}`);
  assert.ok(f.notes.every((n) => !n.includes('推演值')), 'real year is not labelled as projection');
});

// ---------------------------------------------------------------------------------------------------------------
// interactivity layer v2 (CONTRACT §10)

test('sanitizeSettings: v2 settings have defaults and are repaired; old settings files keep working', () => {
  const d = M.DEFAULT_SETTINGS;
  assert.equal(d.autoTexture, 'normal');
  assert.equal(d.gentle, false);
  assert.equal(d.music, true);
  assert.equal(d.reflections, true);
  assert.equal(d.compareIso, null);
  assert.equal(d.compareYear, null);
  // a settings object saved before v2 gets every new default
  const old = M.sanitizeSettings({ lifeMinutes: 60, aiMode: 'off', decisionFreq: 'sparse', autoChoose: true, theme: 'light', lastWorld: null });
  for (const k of ['autoTexture', 'gentle', 'music', 'reflections', 'compareIso', 'compareYear']) assert.equal(old[k], d[k], k);
  const ok = M.sanitizeSettings({ autoTexture: 'giving', gentle: 1, music: false, reflections: 0, compareIso: ' ind ', compareYear: '1998' });
  assert.equal(ok.autoTexture, 'giving');
  assert.equal(ok.gentle, true);
  assert.equal(ok.music, false);
  assert.equal(ok.reflections, false);
  assert.equal(ok.compareIso, 'IND');
  assert.equal(ok.compareYear, 1998);
  const bad = M.sanitizeSettings({ autoTexture: 'reckless', music: null, compareIso: 'INDIA', compareYear: 1800 });
  assert.equal(bad.autoTexture, 'normal');
  assert.equal(bad.music, true, 'null falls back to the default');
  assert.equal(bad.compareIso, null);
  assert.equal(bad.compareYear, null);
  assert.equal(M.sanitizeSettings({ compareYear: '' }).compareYear, null);
  assert.equal(M.sanitizeSettings({ compareYear: M.COMPARE_YEAR_MAX + 1 }).compareYear, null);
  assert.equal(M.sanitizeSettings({ compareYear: M.COMPARE_YEAR_MIN }).compareYear, M.COMPARE_YEAR_MIN);
});

test('AUTO_TEXTURES: the eight contract textures, each with a Chinese label and a one-line description', () => {
  assert.deepEqual(M.AUTO_TEXTURES.map((t) => t.id), ['normal', 'steady', 'adventure', 'family', 'career', 'free', 'comfort', 'giving']);
  for (const t of M.AUTO_TEXTURES) {
    assert.match(t.label, /^[一-鿿]{2,4}$/, t.id);
    assert.ok(t.sub.length >= 12 && t.sub.length <= 40 && /。$/.test(t.sub), `${t.id}: ${t.sub}`);
  }
  assert.equal(new Set(M.AUTO_TEXTURES.map((t) => t.label)).size, 8);
  assert.deepEqual([...M.PANEL_NAMES], ['family', 'money']);
});

test('upgradeLife gives an old save the empty v2 fields without touching existing ones', () => {
  const st = { birth: {}, person: {}, notes: [{ kind: 'thought', text: 'x' }], smallPending: { id: 's' } };
  M.upgradeLife(st);
  assert.deepEqual(st.stars, []);
  assert.deepEqual(st.rare, []);
  assert.equal(st.notes.length, 1);
  assert.deepEqual(st.smallPending, { id: 's' });
  assert.equal(st.namingPending, null);
  assert.equal(st.reflectPending, null);
  assert.equal(M.upgradeLife(null), null);
});

function deadLife() {
  const history = [];
  for (let age = 0; age <= 70; age++) {
    history.push({
      year: 2000 + age, age, tag: age === 0 ? 'birth' : 'calm', mood: age === 31 ? 2 : age === 50 ? 1 : 0, country: age < 30 ? 'CHN' : 'DEU',
      headline: age === 31 ? '在柏林安了家' : age === 50 ? '升职了' : '平常的一年', focus: age >= 6 ? (age < 22 ? 'study' : 'work') : null,
      stats: { health: 90 - age * 0.6, happiness: age === 31 ? 92 : age === 50 ? 21 : 60, knowledge: 50, relationships: 60, wealth: age === 55 ? 88 : 40 },
    });
  }
  return {
    id: 'L-test', birth: { year: 2000, country: 'CHN', sex: 'female', name: '林晓' },
    person: { name: '林晓', sex: 'female', country: 'DEU', children: [{ name: '安娜', sex: 'female', birthYear: 2033, alive: true }, { name: '乐乐', sex: 'male', birthYear: 2036, alive: false }] },
    year: 2070, age: 70, history,
    log: [
      { id: '2005-1', year: 2005, age: 5, kind: 'event', text: '第一次自己骑车。' },
      { id: '2031-2', year: 2031, age: 31, kind: 'event', text: '在柏林安了家。' },
      { id: '2050-1', year: 2050, age: 50, kind: 'event', text: '送走了母亲。' },
    ],
    stars: ['2050-1', 'gone-1', '2005-1'],
    notes: [{ year: 2015, age: 15, kind: 'reflection', prompt: '十五岁的你在想什么？', text: '想快点长大。' }, { year: 2020, age: 20, kind: 'thought', prompt: null, text: '   ' }],
    dead: { year: 2070, age: 70, date: '2070-05-01', cause: { name: '心血管疾病' }, place: 'DEU' },
  };
}

test('death helpers: summary from the history, starred moments, notes and the final sentence', () => {
  const st = deadLife();
  const sum = M.summaryOf({}, data, world, st);
  assert.equal(sum.source, 'history');
  assert.equal(sum.happiestAge, 31);
  assert.equal(sum.richestAge, 55);
  assert.ok(sum.lines.some((l) => l.includes('最快乐的一年是 31 岁（2031 年）') && l.includes('在柏林安了家')), sum.lines.join('|'));
  assert.ok(sum.lines.some((l) => l === '最难熬的一年是 50 岁（2050 年）。'), 'the hardest year is named, without a headline that contradicts it');
  assert.ok(sum.lines.some((l) => l.includes('2 个国家和地区')));
  assert.ok(sum.lines.some((l) => /「工作」上，一共 49 年/.test(l)), sum.lines.join('|'));
  assert.ok(sum.lines.every((l) => !badText(l)));
  const fromEngine = M.summaryOf({ lifeSummary: () => ({ lines: ['最幸福的一年是 31 岁。', '', 42], happiestAge: 31, richestAge: 55, focusYears: {} }) }, data, world, st);
  assert.deepEqual(fromEngine.lines, ['最幸福的一年是 31 岁。']);
  assert.equal(fromEngine.source, 'engine');
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a[0]);
  let broken;
  try { broken = M.summaryOf({ lifeSummary: () => { throw new Error('x'); } }, data, world, st); } finally { console.warn = warn; }
  assert.equal(broken.source, 'history', 'a failing engine call falls back');
  assert.deepEqual(warned, ['[death] lifeSummary']);

  assert.deepEqual(M.starredMoments(st).map((e) => e.id), ['2005-1', '2050-1'], 'oldest first, missing ids skipped');
  assert.deepEqual(M.starredMoments({}), []);
  assert.deepEqual(M.lifeNotes(st).map((n) => n.age), [15], 'blank notes are dropped');

  // the final sentence: one per life, through engine.addNote when it exists
  const calls = [];
  const E = { addNote: (s, text, kind, prompt) => { calls.push([kind, prompt]); s.notes.push({ year: s.year, age: s.age, kind, prompt, text }); return []; } };
  M.setFinalNote(E, st, '  谢谢你\n认真地活过。 ');
  assert.equal(M.finalNote(st).text, '谢谢你 认真地活过。');
  assert.deepEqual(calls, [['final', '最后，你想对这个人说一句话']]);
  M.setFinalNote(E, st, '再见。');
  assert.equal(st.notes.filter((n) => n.kind === 'final').length, 1, 'the last sentence replaces the earlier one');
  M.setFinalNote({}, st, 'x'.repeat(500));
  assert.equal(M.finalNote(st).text.length, M.FINAL_MAX, 'trimmed to 200 characters without an engine');
  M.setFinalNote(E, st, '   ');
  assert.equal(M.finalNote(st), null, 'empty text removes it');
  assert.equal(M.lifeNotes(st).length, 1, 'other notes are kept');
});

test('death helpers: children\'s lives and the comparison with the player\'s real birthplace', () => {
  const st = deadLife();
  const kids = M.childrenLines({}, data, world, st);
  assert.equal(kids.length, 2);
  assert.match(kids[0].line, /她 37 岁/);
  assert.match(kids[1].line, /先走了一步/);
  const fates = M.childrenLines({ childrenFates: () => [{ name: '安娜', sex: 'female', birthYear: 2033, line: '成了一名兽医，活到 88 岁。' }, { name: '?', line: '' }] }, data, world, st);
  assert.deepEqual(fates.map((k) => k.line), ['成了一名兽医，活到 88 岁。']);

  const c = M.compareBirthplace(data, world, st, { compareIso: 'IND', compareYear: 1995 });
  assert.ok(c, 'comparison built');
  assert.equal(c.lines.length, 2);
  assert.match(c.lines[0], /^你实际出生的印度，1995 年出生的人，预期寿命约 \d+\.\d 岁（数据从 2000 年开始，这里按 2000 年计）。$/);
  assert.match(c.lines[1], /^林晓出生在中国（2000 年），那里那时约 \d+\.\d 岁；林晓活到了 70 岁。$/);
  assert.ok(c.realLE > 55 && c.realLE < 70, `IND 2000 LE ${c.realLE}`);
  assert.ok(c.lifeLE > 68 && c.lifeLE < 76, `CHN 2000 LE ${c.lifeLE}`);
  assert.ok(c.note && !badText(c.note));
  const same = M.compareBirthplace(data, world, st, { compareIso: 'CHN', compareYear: null });
  assert.match(same.lines[0], /2000 年出生的人/);
  assert.match(same.lines[1], /也出生在中国/);
  const recent = M.compareBirthplace(data, world, st, { compareIso: 'JPN', compareYear: 2010 });
  assert.ok(!recent.approx && !recent.lines[0].includes('按 2000 年计'));
  assert.equal(M.compareBirthplace(data, world, st, { compareIso: null }), null);
  assert.equal(M.compareBirthplace(data, world, st, { compareIso: 'XXX' }), null);
  assert.equal(M.compareBirthplace(data, world, st, null), null);
});

test('money helpers: allocation weights, habit levels and costs, the income breakdown view', () => {
  const a = M.normalizeAlloc({ bank: 30, balanced: 30, stocks: 30, crypto: 0 });
  assert.equal(Math.round((a.bank + a.balanced + a.stocks + a.crypto) * 100), 100);
  assert.deepEqual(M.normalizeAlloc({}), { bank: 1, balanced: 0, stocks: 0, crypto: 0 });
  assert.deepEqual(M.normalizeAlloc({ bank: -5, stocks: 20 }), { bank: 0, balanced: 0, stocks: 1, crypto: 0 });
  assert.deepEqual(M.allocToPercents({ bank: 0.25, balanced: 0.25, stocks: 0.5, crypto: 0 }), { bank: 25, balanced: 25, stocks: 50, crypto: 0 });
  assert.equal(M.allocToPercents(null), null);
  assert.equal(M.allocToPercents({ bank: 0 }), null, 'an all-zero mix counts as auto');
  for (const p of M.PRESETS) assert.equal(Object.values(p.pct).reduce((x, y) => x + y, 0), 100, p.id);

  assert.deepEqual(M.HABITS.map((x) => x.key), ['dining', 'parents', 'travel', 'learning', 'health', 'charity']);
  assert.deepEqual(M.habitLevels({ habits: { dining: 2, travel: 7, health: -1 } }), { dining: 2, parents: 0, travel: 2, learning: 0, health: 0, charity: 0 });

  const st = { year: 2030, age: 35, person: { country: 'CHN', money: { income: 20000 } }, habits: { dining: 1 } };
  const est = M.habitCosts({}, data, world, st, 'travel');
  assert.equal(est.exact, false);
  assert.deepEqual(est.costs.map(Math.round), [0, 600, 1600], 'estimate = share of income');
  const seen = [];
  const E = {
    incomeBreakdown: (d, w, s) => {
      seen.push(s.habits.travel);
      return { income: 20000, items: [{ key: 'living', label: '吃穿住行', amount: 9000 }, { key: 'travel', label: '旅行', amount: (s.habits.travel || 0) * 700 }] };
    },
  };
  const exact = M.habitCosts(E, data, world, st, 'travel');
  assert.equal(exact.exact, true);
  assert.deepEqual(exact.costs, [0, 700, 1400]);
  assert.deepEqual(seen, [1, 2], 'priced on a copy of the life with only that habit changed');
  assert.equal(st.habits.travel, undefined, 'the real life is untouched');

  // writes go through the engine, else straight into the CONTRACT §10 shape
  const calls = [];
  M.applyHabit({ setHabit: (s, k, v) => calls.push(['h', k, v]) }, st, 'health', 5);
  M.applyAllocation({ setAllocation: (s, x) => calls.push(['a', x]) }, st, null);
  assert.deepEqual(calls, [['h', 'health', 2], ['a', null]]);
  M.applyHabit({}, st, 'charity', 1);
  M.applyAllocation({}, st, { bank: 1, balanced: 0, stocks: 0, crypto: 0 });
  assert.equal(st.habits.charity, 1);
  assert.deepEqual(st.person.money.allocation, { bank: 1, balanced: 0, stocks: 0, crypto: 0 });

  const items = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `项${i}`, amount: 1000 - i * 50 }));
  const v = M.breakdownView({ income: 5000, items: [...items, { key: 'refund', label: '退税', amount: -200 }] });
  assert.equal(v.segments.length, 7, 'six slots plus one folded 其他');
  assert.deepEqual(v.segments.map((s) => s.slot), [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(v.segments[6].label, '其他');
  assert.deepEqual(v.segments[6].parts, ['项6', '项7', '项8']);
  assert.equal(v.negative.length, 1);
  assert.ok(v.over > 0, 'spending above income is reported');
  assert.ok(Math.abs(v.segments.reduce((x, s) => x + s.share, 0) - 1) < 1e-9);
  assert.equal(M.breakdownView(null), null);
  assert.deepEqual(M.breakdownView({ income: 0, items: [] }).segments, []);
});

test('family helpers: a view built from the state, grouped and labelled in Chinese', () => {
  const st = {
    year: 2040, age: 40,
    person: {
      parents: { mother: { age: 68, alive: true }, father: { age: 70, alive: false } },
      relationship: { status: 'married', partner: { name: '周远', sinceYear: 2031 } },
      children: [{ name: '小禾', sex: 'female', birthYear: 2033, alive: true }],
      siblings: 2,
      conditions: [{ id: 'hypertension', name: '高血压', sinceYear: 2038, severity: 1 }],
    },
    habits: { parents: 2, travel: 0 },
  };
  const v = M.fallbackFamilyView(st);
  const groups = M.groupMembers(v);
  assert.deepEqual(groups.map((g) => g.id), ['parents', 'partner', 'children', 'siblings']);
  assert.equal(groups[0].members[1].alive, false);
  assert.equal(groups[2].members[0].age, 7);
  assert.deepEqual(v.habits.map((x) => x.label), ['孝亲费']);
  assert.equal(M.roleLabel(groups[1].members[0], st), '配偶');
  assert.equal(M.roleLabel({ role: 'partner', sex: 'female' }, st), '妻子');
  assert.equal(M.roleLabel({ role: 'child', sex: 'male' }, st), '儿子');
  assert.equal(M.roleLabel({ role: 'sibling', sex: 'female', older: true }, st), '姐姐');
  assert.equal(M.roleLabel({ role: '表哥' }, st), '表哥');
  assert.equal(M.roleLabel({ role: 'mother', label: '妈妈' }, st), '妈妈');
  const eng = M.familyViewOf({ familyView: () => ({ members: [{ role: 'grandchild', name: '豆豆', age: 3, alive: true }], friends: 4, pets: [], habits: [], conditions: [] }) }, data, world, st);
  assert.equal(eng.source, 'engine');
  assert.deepEqual(M.groupMembers(eng).map((g) => g.id), ['grandchildren']);
  assert.equal(M.familyViewOf({ familyView: () => null }, data, world, st).source, 'state');
});

test('birthFacts: projected years are labelled and every country has usable facts', () => {
  const p = M.birthFacts(data, world, { year: 2055, country: 'NGA', sex: 'female' });
  assert.ok(p.notes.some((n) => n.includes('推演值')), 'projection note present');
  assert.ok(p.le > 50 && p.le < 95, `NGA 2055 female LE ${p.le}`);
  let checked = 0;
  for (const iso of data.isoList) {
    const f = M.birthFacts(data, world, { year: 2026, country: iso, sex: 'female' });
    for (const x of f.facts) assert.ok(!badText(`${x.value} ${x.note}`), `${iso} ${x.key}: ${x.value} ${x.note}`);
    if (data.series(iso, 'births', 2026) > 0) assert.ok(f.facts.some((x) => x.key === 'le'), `${iso} has life expectancy`);
    checked++;
  }
  assert.equal(checked, data.isoList.length);
});
