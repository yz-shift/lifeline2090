// Unit and life-level tests for the engine's realism fixes (engine.js, death.js, person.js, world.js, economy.js).
// Run: node --test --test-reporter=spec tests/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld, eventMortality } from '../src/core/world.js';
import { randomBirth, customBirth, parentAges } from '../src/core/person.js';
import {
  newLife, stepYear, applyResolution, survivalCurve, countryContext, statusLine, knowGain, zAdd, titleHead, shortHeadline,
} from '../src/core/engine.js';
import { sampleCause } from '../src/core/death.js';
import { medianIncome } from '../src/core/economy.js';
import { simulateLife, HEADLESS_SETTINGS } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });

function lifeOf(iso, seed, year = 2000, extra = {}) {
  const world = createWorld(data, seed * 7 + 3);
  const spec = randomBirth(data, world, new Rng(seed), { year });
  Object.assign(spec, { country: iso }, extra);
  return { world, spec };
}

/** A fresh state for iso at a given age, born in birthYear (no years simulated). */
function stateAt(iso, age, birthYear, seed, patch = {}) {
  const world = createWorld(data, seed);
  const spec = customBirth(data, world, new Rng(seed), { country: iso, year: birthYear, ...patch });
  const st = newLife(data, world, spec, { ...HEADLESS_SETTINGS }, seed);
  st.age = age;
  st.year = birthYear + age;
  return { world, st };
}

// A batch of whole lives shared by the life-level checks (kept small: the laptop running these is low on RAM).
const LIVES = [];
for (const iso of ['CHN', 'USA', 'DEU', 'IND', 'NGA', 'BRA', 'PHL']) {
  for (let i = 0; i < 18; i++) {
    const { world, spec } = lifeOf(iso, 4100 + i);
    const years = [];
    const st = simulateLife(data, world, spec, 4100 + i, {
      onYear(s, r) {
        const p = s.person;
        years.push({ year: s.year, age: s.age, k: s.stats.knowledge, status: p.career.status, pct: p.career.incomePct, income: p.money.income, iso: p.country, retiredYear: p.flags.retiredYear, entries: r.entries.length });
      },
    });
    LIVES.push({ iso, world, st, years });
  }
}

test('knowledge gains slow down near the top of the scale', () => {
  assert.equal(knowGain(40, 4), 4);
  assert.equal(knowGain(80, 4), 2);
  assert.ok(knowGain(95, 4) < 0.6 && knowGain(95, 4) > 0);
  assert.equal(knowGain(95, -3), -3, 'losses are not damped');
  // adults are spread out instead of all pinned at 100
  const at30 = LIVES.map((L) => L.years.find((y) => y.age === 30)).filter(Boolean).map((y) => y.k);
  assert.ok(at30.length > 50);
  const pinned = at30.filter((k) => k >= 99.5).length / at30.length;
  assert.ok(pinned < 0.15, `share of 30-year-olds with knowledge 100: ${pinned.toFixed(2)}`);
});

test('percentile steps on the normal scale shrink near the top', () => {
  assert.ok(Math.abs(zAdd(0.5, 0) - 0.5) < 0.01);
  const mid = zAdd(0.5, 0.2) - 0.5;
  const top = zAdd(0.95, 0.2) - 0.95;
  assert.ok(mid > 0.06 && top < 0.03 && top > 0, `mid ${mid} top ${top}`);
  assert.ok(zAdd(0.999, 5) <= 0.99 && zAdd(0.001, -5) >= 0.01);
});

test('incomes stay plausible for the country: few 50-year-olds sit at the very top', () => {
  const pcts = [];
  const ratios = [];
  for (const L of LIVES) {
    const y = L.years.find((r) => r.age === 50 && ['employed', 'self_employed'].includes(r.status));
    if (!y) continue;
    pcts.push(y.pct);
    ratios.push(y.income / medianIncome(data, L.world, y.iso, y.year));
  }
  assert.ok(pcts.length >= 40, `workers at 50: ${pcts.length}`);
  pcts.sort((a, b) => a - b);
  ratios.sort((a, b) => a - b);
  const med = pcts[Math.floor(pcts.length / 2)];
  const top = pcts.filter((x) => x > 0.97).length / pcts.length;
  assert.ok(med < 0.85, `median income percentile at 50: ${med}`);
  assert.ok(top < 0.12, `share above the 97th percentile at 50: ${top.toFixed(2)}`);
  assert.ok(ratios[Math.floor(ratios.length / 2)] < 3, `median income / national median at 50: ${ratios[Math.floor(ratios.length / 2)]}`);
});

test('a raise from a resolution is compressed above the median, applied as given below it', () => {
  const { world, st } = stateAt('USA', 40, 2000, 11);
  Object.assign(st.person.career, { status: 'employed', title: '职员', sector: '金融商业', incomePct: 0.9, years: 15 });
  applyResolution(data, world, st, { id: 'd1', title: '加薪', options: [{ id: 'a', label: '好' }] }, { optionId: 'a' },
    { narrative: '你升职了。', effects: {}, set: { career: { incomePct: 0.96 } }, threads: [], feasible: true });
  const hi = st.person.career.incomePct;
  assert.ok(hi > 0.9 && hi < 0.945, `0.9 + 0.06 became ${hi}`);
  st.person.career.incomePct = 0.3;
  applyResolution(data, world, st, { id: 'd2', title: '加薪', options: [{ id: 'a', label: '好' }] }, { optionId: 'a' },
    { narrative: '你换了工作。', effects: {}, set: { career: { incomePct: 0.4 } }, threads: [], feasible: true });
  assert.equal(st.person.career.incomePct, 0.4);
});

test('moving to a richer country starts lower on its ladder', () => {
  const { world, st } = stateAt('IND', 30, 2000, 12);
  Object.assign(st.person.career, { status: 'employed', title: '工程师', sector: '工程制造', incomePct: 0.8, years: 8 });
  applyResolution(data, world, st, { id: 'mig', title: '出国', options: [{ id: 'a', label: '去' }] }, { optionId: 'a' },
    { narrative: '你出国了。', effects: {}, set: { country: 'USA' }, threads: [], feasible: true });
  assert.equal(st.person.country, 'USA');
  assert.equal(st.person.flags.migrant, 'USA');
  assert.ok(st.person.career.incomePct < 0.75, `percentile after the move: ${st.person.career.incomePct}`);
  const ctx = countryContext(data, world, st.person.country, st.year);
  assert.equal(ctx.iso3, 'USA');
});

test('children: plausible mothers, distinct names, one family name per couple', () => {
  let kids = 0;
  for (const L of LIVES) {
    const p = L.st.person;
    const names = new Set();
    for (const k of p.children) {
      if (k.adopted) continue;
      kids++;
      if (p.sex === 'female') {
        const ma = k.birthYear - L.st.birth.year;
        assert.ok(ma >= 15 && ma <= 49, `${L.iso} mother aged ${ma}`);
      }
      assert.notEqual(k.name, p.name, `${L.iso} child named like the parent: ${k.name}`);
      assert.ok(!names.has(k.name), `${L.iso} two children named ${k.name}`);
      names.add(k.name);
    }
    // one union, no adoptions: every child carries the same family name
    const own = p.children.filter((k) => !k.adopted && k.name.includes('·'));
    if (!(p.pastPartners && p.pastPartners.length) && own.length >= 2 && p.sex === 'female') {
      const sur = new Set(own.map((k) => k.name.slice(k.name.lastIndexOf('·') + 1)));
      assert.equal(sur.size, 1, `${L.iso} siblings with different family names: ${own.map((k) => k.name).join(', ')}`);
    }
  }
  assert.ok(kids > 50, `children born: ${kids}`);
});

test('a couple that got together this year rarely has a baby the same year', () => {
  let fresh = 0;
  let settled = 0;
  const N = 160;
  for (let i = 0; i < N; i++) {
    for (const since of [0, 3]) {
      const { world, st } = stateAt('BRA', 27, 2000, 300 + i, { sex: 'female' });
      const p = st.person;
      p.relationship = { status: 'married', partner: { name: '卢卡斯·席尔瓦', sinceYear: st.year + 1 - since, birthYear: 1971, sex: 'male' } };
      p.flags.firstUnion = st.year + 1 - since;
      p.flags.kidTarget = 2;
      st.rng = new Rng(9000 + i).state();
      stepYear(data, world, st);
      if (p.children.length) since === 0 ? fresh++ : settled++;
    }
  }
  assert.ok(settled > 25, `births to settled couples: ${settled}/${N}`);
  assert.ok(fresh * 3 < settled, `births in the year a couple met: ${fresh}/${N} vs settled ${settled}/${N}`);
});

test('a former partner is remembered and never reused for a new partner', () => {
  const { world, st } = stateAt('PHL', 35, 2000, 21, { sex: 'female' });
  const p = st.person;
  p.relationship = { status: 'married', partner: { name: '詹姆斯', sinceYear: 2025, birthYear: 1998, sex: 'male' } };
  applyResolution(data, world, st, { id: 'dv', title: '离婚', options: [{ id: 'a', label: '分开' }] }, { optionId: 'a' },
    { narrative: '你们分开了。', effects: {}, set: { relationship: { status: 'divorced' } }, threads: [], feasible: true });
  assert.equal(p.relationship.partner, null);
  assert.ok(p.pastPartners.includes('詹姆斯'));
  // collect the names the engine would draw, then forbid the most common ones
  const draw = (seed, past) => {
    const s = stateAt('PHL', 35, 2000, 21, { sex: 'female' }).st;
    s.person.pastPartners = past;
    s.rng = new Rng(seed).state();
    applyResolution(data, world, s, { id: `dt${seed}`, title: '恋爱', options: [{ id: 'a', label: '好' }] }, { optionId: 'a' },
      { narrative: '你恋爱了。', effects: {}, set: { relationship: { status: 'dating' } }, threads: [], feasible: true });
    return s.person.relationship.partner.name;
  };
  const freq = {};
  for (let i = 0; i < 60; i++) { const n = draw(500 + i, []); freq[n] = (freq[n] || 0) + 1; }
  const banned = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
  for (let i = 0; i < 60; i++) assert.ok(!banned.includes(draw(500 + i, banned.slice())), 'a new partner got a former partner\'s name');
});

test('retirement is final: no promotions afterwards, business closed, pension story only right after', () => {
  let retirees = 0;
  for (const L of LIVES) {
    const f = L.st.person.flags;
    if (!f.retiredYear) continue;
    retirees++;
    assert.notEqual(f.business, true);
    for (const e of L.st.log) {
      if (e.year > f.retiredYear && e.kind === 'milestone') assert.ok(!/升了职|得到了晋升|带新人/.test(e.text), `${L.iso} promoted after retiring: ${e.text}`);
      if (/第一笔养老金到账了/.test(e.text)) assert.ok(e.year - f.retiredYear <= 2 && e.year >= f.retiredYear, `${L.iso} first pension ${e.year - f.retiredYear} years after retiring`);
      if (/退休那天，同事们/.test(e.text)) assert.fail(`${L.iso} a second retirement-day story`);
    }
  }
  assert.ok(retirees > 20, `retirees: ${retirees}`);
});

test('every lived year has a personal line, news text ends cleanly, one history row per year', () => {
  for (const L of LIVES) {
    const st = L.st;
    for (let i = 1; i < st.history.length; i++) assert.equal(st.history[i].year, st.history[i - 1].year + 1);
    const byYear = new Map();
    for (const e of st.log) {
      if (e.kind !== 'news') byYear.set(e.year, (byYear.get(e.year) || 0) + 1);
      else assert.ok(!/[；，、：]$/.test(e.text), `news ends mid-sentence: ${e.text.slice(-20)}`);
    }
    for (const h of st.history) assert.ok(byYear.get(h.year) > 0, `${L.iso} ${h.year} has no personal entry`);
  }
});

test('statusLine fits the age and is fast to compute', () => {
  const { st } = stateAt('IND', 4, 2015, 5);
  assert.equal(statusLine(data, st), '还没上学');
  st.age = 1;
  assert.equal(statusLine(data, st), '襁褓之中');
  const L = LIVES[0];
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) statusLine(data, L.st);
  assert.ok(performance.now() - t0 < 500);
  assert.equal(statusLine(data, L.st), '已离世');
});

test('survivalCurve is a proper, fast survival function', () => {
  const { world, spec } = lifeOf('CHN', 77);
  const st = newLife(data, world, spec, { ...HEADLESS_SETTINGS }, 77);
  for (let i = 0; i < 40 && !st.dead; i++) { if (st.pending) st.pending = null; stepYear(data, world, st); }
  if (st.dead) return;
  const t0 = performance.now();
  let c;
  for (let i = 0; i < 100; i++) c = survivalCurve(data, world, st);
  assert.ok(performance.now() - t0 < 3000, 'survivalCurve too slow');
  assert.equal(c.ages[0], st.age);
  assert.equal(c.personal[0], 1);
  assert.equal(c.ages.length, c.personal.length);
  assert.equal(c.ages.length, c.baseline.length);
  for (let i = 1; i < c.ages.length; i++) {
    assert.equal(c.ages[i], c.ages[i - 1] + 1);
    assert.ok(c.personal[i] <= c.personal[i - 1] && c.baseline[i] <= c.baseline[i - 1]);
  }
  assert.ok(c.baseline[c.baseline.length - 1] < 0.01);
  assert.ok(c.remaining.baseline > 20 && c.remaining.baseline < 70, `remaining years ${c.remaining.baseline}`);
});

test('countryContext is cached, bounded and never throws', () => {
  const world = createWorld(data, 5);
  const a = countryContext(data, world, 'UKR', 2023);
  assert.equal(countryContext(data, world, 'UKR', 2023), a);
  assert.equal(a.conflict, 3);
  assert.ok(countryContext(data, world, 'DEU', 2010).conflict <= 1);
  // a regional insurgency is serious unrest (2), not a war in every home (3); a neighbour taking in refugees is 1
  assert.equal(countryContext(data, world, 'NGA', 2015).conflict, 2);
  assert.equal(countryContext(data, world, 'UKR', 2016).conflict, 2);
  assert.equal(countryContext(data, world, 'SYR', 2014).conflict, 3);
  assert.equal(countryContext(data, world, 'POL', 2023).conflict, 1);
  for (const iso of ['USA', 'NGA', 'XXX']) for (const y of [2000, 2026, 2060, 2100, 2131]) {
    const c = countryContext(data, world, iso, y);
    assert.ok(c.conflict >= 0 && c.conflict <= 3 && Array.isArray(c.events));
  }
});

test('causes of death fit the life: no maternal death without a pregnancy, war deaths scaled by the war', () => {
  const world = createWorld(data, 1);
  const share = (iso, year, sex, age, rel, id) => {
    const ctx = countryContext(data, world, iso, year);
    const state = { id: 'c', year, age, person: { sex, country: iso, flags: {}, conditions: [], relationship: { status: rel } }, hazardMods: [] };
    const R = new Rng(3);
    let n = 0;
    for (let i = 0; i < 2000; i++) if (sampleCause(data, world, state, R, ctx).id === id) n++;
    return n / 2000;
  };
  assert.equal(share('NER', 2005, 'female', 24, 'single', 'maternal'), 0);
  assert.ok(share('NER', 2005, 'female', 24, 'married', 'maternal') > 0);
  // a regional insurgency without a casualty estimate is not "most deaths were violent"
  assert.ok(share('UKR', 2016, 'male', 35, 'married', 'violence') < 0.25);
  // a full-scale civil war with a large mortality estimate is
  assert.ok(share('SYR', 2014, 'male', 30, 'married', 'violence') > 0.3);
});

test('event mortality honours applies_to and by_country', () => {
  const ev = { mortality: { mult: 1.15, ages: [18, 60], appliesTo: ['UKR', 'RUS'], byCountry: { UKR: 1.25 } } };
  assert.equal(eventMortality(ev, 'POL'), 1);
  assert.equal(eventMortality(ev, 'UKR'), 1.25);
  assert.equal(eventMortality(ev, 'RUS'), 1.15);
  assert.equal(eventMortality({}, 'UKR'), 1);
  const world = createWorld(data, 9);
  const war = world.events('UKR', 2023).find((e) => e.mortality && e.mortality.appliesTo);
  assert.ok(war, 'history mortality keeps applies_to');
});

test('headlines are cut at a clause, not in the middle of a bracket', () => {
  assert.equal(titleHead('尼日利亚开放GSM移动通信，手机迅速普及'), '尼日利亚开放GSM移动通信');
  assert.equal(titleHead('南亚致命热浪（印度、巴基斯坦、孟加拉国）'), '南亚致命热浪');
  assert.equal(titleHead('全球金融危机'), '全球金融危机');
  assert.equal(shortHeadline('在这条世界线上，「玉米等主粮减产」成了这一年的大事。'), '玉米等主粮减产');
  assert.equal(shortHeadline('在这条世界线上，粮价涨了不少。'), '粮价涨了不少');
});

test('a mother of many children is not implausibly young', () => {
  const R = new Rng(42);
  for (let i = 0; i < 300; i++) {
    const { motherAge } = parentAges(data, 'NGA', 2000, 8, R);
    assert.ok(motherAge >= 22, `mother aged ${motherAge} with 8 other children`);
  }
});

test('exams belong to the academic track', () => {
  const run = (track) => {
    const { world, st } = stateAt('USA', 16, 2000, 31);
    const p = st.person;
    Object.assign(p.education, { level: 'secondary', inSchool: true, years: 10, exams: [] });
    p.career.status = 'student';
    if (track) p.flags.track = track;
    stepYear(data, world, st);
    return st.log.some((e) => e.year === st.year && /SAT/.test(e.text));
  };
  assert.equal(run('vocational'), false);
  assert.equal(run(null), true);
});
