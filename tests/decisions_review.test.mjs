// Review fixes in src/core/decisions.js: option labels match their outcomes, no repeated or impossible choices,
// university entry follows the country's tertiary enrolment, and a new occupation gets a plausible income percentile.
// Run: node --test --test-reporter=spec tests/decisions_review.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear } from '../src/core/engine.js';
import { simulateLife, autoResolve, HEADLESS_SETTINGS } from '../src/core/cohort.js';
import { buildDecisionOffline, resolveOffline, triggeredDecision, autoChoose } from '../src/core/decisions.js';
import { CITIES } from '../src/core/events.js';
import { Rng } from '../src/core/rng.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const EDU = ['none', 'preschool', 'primary', 'secondary', 'vocational', 'tertiary', 'postgrad'];

/* ------------------------------------------------------------------ helpers */

/** a real LifeState from the engine, moved to the wanted age and patched */
function lifeAt(iso, age, o = {}) {
  const world = createWorld(data, o.worldSeed ?? 11);
  const spec = randomBirth(data, world, new Rng(o.seed ?? 1), { year: o.birthYear ?? 2000 });
  spec.country = iso;
  if (o.sex) spec.sex = o.sex;
  if (o.urban !== undefined) spec.urban = o.urban;
  if (o.birthUrban !== undefined) spec.urban = o.birthUrban;
  if (o.fam !== undefined) spec.familyPct = o.fam;
  const st = newLife(data, world, spec, { ...HEADLESS_SETTINGS, decisionFreq: 'standard' }, o.seed ?? 1);
  st.year = spec.year + age;
  st.age = age;
  const p = st.person;
  if (o.urban !== undefined) p.urban = o.urban;
  Object.assign(p.education, { level: 'secondary', inSchool: false, field: null }, o.education || {});
  Object.assign(p.career, { status: 'employed', title: '职员', sector: '金融商业', incomePct: 0.5, years: 5 }, o.career || {});
  if (o.relationship) p.relationship = o.relationship;
  if (o.children) p.children = o.children;
  p.parents = o.parents || { mother: { age: age + 27, alive: true }, father: { age: age + 30, alive: true } };
  p.flags = { ...(o.flags || {}) };
  Object.assign(st.stats, { health: 75, happiness: 60, knowledge: 75, relationships: 60, wealth: 50 }, o.stats || {});
  st.decisions = o.decisions || [];
  st.pending = null;
  return { world, st };
}
/** build offline decisions with different seeds until one with this template key appears */
function findDecision(world, st, key, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const d = buildDecisionOffline(data, world, st, {}, new Rng(1000 + i));
    if (d && d.context && d.context.key === key) return d;
  }
  return null;
}
const optByLabel = (d, re) => d.options.find((o) => re.test(o.label));
const resolveMany = (world, st, d, o, n = 25) => Array.from({ length: n }, (_, i) => resolveOffline(data, world, st, d, { optionId: o.id }, new Rng(77 + i)));
/** a hand-built decision whose single option runs one action (for action-level checks) */
const actDecision = (st, act, p = {}) => ({
  id: `d-test-${st.year}-${st.age}-x`, year: st.year, age: st.age, kind: 'milestone', title: '测试', situation: '测试。', allowCustom: true, source: 'local',
  options: [{ id: 'a', label: '测试', detail: '测试。', risk: 'mid' }, { id: 'b', label: '不变', detail: '测试。', risk: 'low' }],
  context: { key: 'test', acts: { a: { act, p }, b: { act: 'stay_course', p: {} } }, auto: { a: 1, b: 1 } },
});
/** every career patch in a resolution and its threads */
function careerPatches(r) {
  const list = [];
  if (r.set && r.set.career) list.push(r.set.career);
  for (const t of r.threads || []) if (t.set && t.set.career) list.push(t.set.career);
  return list;
}
function eduLevels(r) {
  const list = [];
  if (r.set && r.set.education && r.set.education.level) list.push(r.set.education.level);
  for (const t of r.threads || []) if (t.set && t.set.education && t.set.education.level) list.push(t.set.education.level);
  return list;
}

/* ------------------------------------------------------------------ 1. labels and outcomes */

describe('option labels match their outcomes', () => {
  test('火星招募 → 去地面中心工作 is a ground-station job, not a random career switch', () => {
    const { world, st } = lifeAt('CHN', 30, { birthYear: 2052, education: { level: 'tertiary' }, stats: { health: 85 } });
    const d = findDecision(world, st, 'kx_mars');
    assert.ok(d, 'kx_mars offered in 2082');
    const o = optByLabel(d, /地面中心/);
    assert.ok(o);
    for (const r of resolveMany(world, st, d, o, 10)) {
      assert.match(r.narrative, /地面支持中心/);
      assert.doesNotMatch(r.narrative, /转行做/);
      assert.equal(r.set.career.title, '地面支持工程师');
      assert.ok(typeof r.set.career.incomePct === 'number');
    }
  });

  test('最后的心愿 → 拍一张全家福 takes a family photo (not homework help), also without children', () => {
    for (const kids of [[{ name: '林晓', sex: 'female', birthYear: 1960, alive: true }], []]) {
      const { world, st } = lifeAt('CHN', 85, { birthYear: 2000, career: { status: 'retired' }, children: kids, relationship: { status: 'widowed', partner: null }, parents: { mother: { age: 110, alive: false }, father: { age: 112, alive: false } } });
      st.person.children = kids.map((k) => ({ ...k, birthYear: st.year - 58 }));
      const d = findDecision(world, st, 'k85_wishes');
      assert.ok(d);
      const o = optByLabel(d, /全家福|合影/);
      assert.ok(o, d.options.map((x) => x.label).join('/'));
      for (const r of resolveMany(world, st, d, o, 6)) {
        assert.match(r.narrative, /全家福|合影/);
        assert.doesNotMatch(r.narrative, /作业/);
      }
      const tell = optByLabel(d, /讲给后辈/);
      for (const r of resolveMany(world, st, d, tell, 3)) assert.match(r.narrative, /讲/);
    }
  });

  test('十五岁的出路 → 进城打工 moves to the named city (never "you tried to change jobs")', () => {
    const { world, st } = lifeAt('CHN', 15, { sex: 'male', urban: false, birthUrban: false, education: { level: 'primary', inSchool: false }, career: { status: 'unemployed', title: null, sector: null } });
    const d = findDecision(world, st, 'k15_out');
    assert.ok(d);
    const o = optByLabel(d, /进城打工/);
    assert.ok(o);
    const city = /去(.+?)闯一闯/.exec(d.options.find((x) => x.id === o.id).detail);
    for (const r of resolveMany(world, st, d, o, 10)) {
      assert.equal(r.set.urban, true);
      assert.doesNotMatch(r.narrative, /换工作|跳槽/);
      if (city) assert.ok(r.narrative.includes(city[1]), `${r.narrative} / ${city[1]}`);
    }
    // going back to school is told as going back
    const back = optByLabel(d, /回学校读书/);
    for (const r of resolveMany(world, st, d, back, 4)) assert.match(r.narrative, /回到了学校/);
  });

  test('an AI-rewritten option under an offline id is resolved by its own text', () => {
    const { world, st } = lifeAt('CHN', 30, {});
    const d = actDecision(st, 'invest_crypto');
    d.context.labels = { a: '测试', b: '不变' };
    d.source = 'ai';
    d.options[0] = { id: 'a', label: '去学钢琴', detail: '学一门乐器。', risk: 'low' };
    const r = resolveOffline(data, world, st, d, { optionId: 'a' }, new Rng(3));
    assert.doesNotMatch(r.narrative, /加密货币/);
    assert.match(r.narrative, /钢琴/);
  });
});

/* ------------------------------------------------------------------ 2. repeated or impossible choices */

describe('no repeated or impossible choices', () => {
  test('继续深造 for a university graduate means graduate school, never a second bachelor\'s', () => {
    const { world, st } = lifeAt('CHN', 23, { education: { level: 'tertiary', inSchool: false, field: '计算机科学' }, career: { status: 'unemployed', title: null, sector: null }, stats: { knowledge: 85 } });
    const d = findDecision(world, st, 'k22_unemp');
    assert.ok(d);
    const o = optByLabel(d, /深造/);
    assert.ok(o);
    let postgrad = 0;
    for (const r of resolveMany(world, st, d, o, 30)) {
      assert.ok(!eduLevels(r).includes('tertiary'), r.narrative);
      assert.ok(!(r.set.flags && r.set.flags.track === 'uni'), 'no undergraduate track');
      assert.match(r.narrative, /研究生|读研/);
      if (eduLevels(r).includes('postgrad')) postgrad++;
    }
    assert.ok(postgrad > 0, 'some graduates get in');
    // studying abroad after a degree is a master's too
    const rich = lifeAt('CHN', 23, { fam: 0.95, education: { level: 'tertiary', inSchool: false, field: '工程' }, stats: { knowledge: 90 } });
    rich.st.person.money.cash = 500000;
    const abroad = actDecision(rich.st, 'emigrate', { mode: 'study' });
    for (let i = 0; i < 30; i++) {
      const r = resolveOffline(data, rich.world, rich.st, abroad, { optionId: 'a' }, new Rng(i));
      assert.ok(!eduLevels(r).includes('tertiary'), r.narrative);
      if (r.set.country) assert.match(r.narrative, /研究生/);
    }
  });

  test('a vocational graduate at 18 is never offered vocational school again', () => {
    for (const iso of ['CHN', 'DEU', 'IND']) {
      const { world, st } = lifeAt(iso, 18, { education: { level: 'vocational', inSchool: false, field: '电工' }, career: { status: 'employed', title: '电工', sector: '建筑与维修', incomePct: 0.35 }, flags: { trade: '电工' } });
      for (let i = 0; i < 60; i++) {
        const d = buildDecisionOffline(data, world, st, {}, new Rng(i));
        for (const o of d.options) {
          assert.doesNotMatch(o.label, /职业学校|职业高中|职业教育|读高职/, `${d.context.key}: ${o.label}`);
          assert.notEqual(d.context.acts[o.id].act, 'vocational', `${d.context.key}: ${o.label}`);
          assert.ok(!/^(直接工作)$/.test(o.label), 'already working');
        }
        if (d.context.key === 'k18_uni') assert.equal(d.title, '职校毕业以后');
      }
    }
  });

  test('一份邀请 never offers a move to the city the person already lives in; a city-state gets a same-city offer', () => {
    const cases = [['CHN', '上海'], ['CHN', '北京'], ['USA', '纽约'], ['HKG', '香港'], ['SGP', '新加坡']];
    for (const [iso, city] of cases) {
      let offers = 0;
      for (let i = 0; i < 3000 && offers < 12; i++) {
        const { world, st } = lifeAt(iso, 31, { urban: true, flags: { city }, education: { level: 'secondary' }, stats: { knowledge: 75 } });
        const d = triggeredDecision(data, world, st, {}, new Rng(i));
        if (!d || d.context.key !== 't_offer') continue;
        offers++;
        for (const o of d.options) assert.ok(!o.label.includes(city), `${iso} ${city}: ${o.label}`);
        assert.ok(!d.situation.includes(`去${city}`), d.situation);
        const accept = d.options[0];
        const r = resolveOffline(data, world, st, d, { optionId: accept.id }, new Rng(i));
        if ((CITIES[iso] || []).length <= 1) {
          assert.equal(accept.label, '接受邀请');
          assert.ok(!r.set.flags || r.set.flags.city === undefined || r.set.flags.city === city, JSON.stringify(r.set));
        } else if (r.set.flags && r.set.flags.city) assert.notEqual(r.set.flags.city, city);
      }
      assert.ok(offers >= 3, `${iso}: only ${offers} offers`);
    }
  });

  test('父母老了 comes at most once in 12 years and only while a parent is alive', () => {
    const hist = (yearsAgo, st) => [{ id: `d-k_parents-${st.year - yearsAgo}-${st.age - yearsAgo}-abcde`, year: st.year - yearsAgo, age: st.age - yearsAgo, title: '父母老了', choice: '常回家看看', custom: false, source: 'local' }];
    const old = (age) => ({ mother: { age: age + 30, alive: true }, father: { age: age + 33, alive: true } });
    // milestone
    let { world, st } = lifeAt('CHN', 50, { parents: old(50) });
    st.decisions = hist(9, st);
    for (let i = 0; i < 300; i++) assert.notEqual(buildDecisionOffline(data, world, st, {}, new Rng(i)).context.key, 'k_parents');
    st.decisions = hist(13, st);
    assert.ok(findDecision(world, st, 'k_parents'), 'allowed again after 12 years');
    st.person.parents = { mother: { age: 80, alive: false }, father: { age: 83, alive: false } };
    for (let i = 0; i < 300; i++) assert.notEqual(buildDecisionOffline(data, world, st, {}, new Rng(i)).context.key, 'k_parents');
    // triggered
    ({ world, st } = lifeAt('CHN', 47, { parents: old(47), career: { status: 'retired' } }));
    let seen = 0;
    for (let i = 0; i < 2000; i++) {
      const s = JSON.parse(JSON.stringify(st));
      s.decisions = hist(9, s);
      const d = triggeredDecision(data, world, s, {}, new Rng(i));
      assert.ok(!d || d.context.key !== 'k_parents', 'triggered within 12 years');
      const s2 = JSON.parse(JSON.stringify(st));
      s2.decisions = hist(13, s2);
      const d2 = triggeredDecision(data, world, s2, {}, new Rng(i));
      if (d2 && d2.context.key === 'k_parents') seen++;
    }
    assert.ok(seen > 0, 'the trigger still exists');
    // whole lives: never twice within 12 years, never after both parents died
    for (let i = 0; i < 40; i++) {
      const w = createWorld(data, 300 + i);
      const spec = randomBirth(data, w, new Rng(300 + i), { year: 2000 + (i % 10) });
      const life = simulateLife(data, w, spec, 300 + i, { settings: { decisionFreq: i % 2 ? 'frequent' : 'standard' } });
      const years = life.decisions.filter((x) => /^d-k_parents-/.test(x.id)).map((x) => x.year).sort((a, b) => a - b);
      for (let k = 1; k < years.length; k++) assert.ok(years[k] - years[k - 1] >= 12, `k_parents in ${years.join(',')}`);
    }
  });

  test('a married person who moves away either takes the family along or says who stays behind', () => {
    const fam = { relationship: { status: 'married', partner: { name: '林小雨', sinceYear: 2020 } }, children: [{ name: '小树', sex: 'male', birthYear: 2026, alive: true }] };
    const { world, st } = lifeAt('IND', 30, { urban: false, birthUrban: false, career: { status: 'self_employed', title: '农民', sector: '农业', incomePct: 0.2 }, ...fam });
    st.person.money.cash = 20000;
    for (const [act, p] of [['migrate_city', {}], ['accept_offer', { city: '孟买' }], ['emigrate', { mode: 'labor' }], ['emigrate', { mode: 'skilled' }]]) {
      const d = actDecision(st, act, p);
      let moved = 0;
      for (let i = 0; i < 25; i++) {
        const r = resolveOffline(data, world, st, d, { optionId: 'a' }, new Rng(i));
        if (!(r.set.urban || r.set.country || (r.set.flags && r.set.flags.city))) continue;
        moved++;
        assert.ok(r.narrative.includes('林小雨') || r.narrative.includes('孩子'), `${act}: ${r.narrative}`);
        assert.doesNotMatch(r.narrative, /一个人站在天桥上/);
      }
      assert.ok(moved > 0, `${act} never moved`);
    }
  });
});

/* ------------------------------------------------------------------ 3. university entry follows enrolment */

describe('university entry follows the country\'s tertiary enrolment', () => {
  // the same typical school leaver (median family, typical knowledge, city) in countries with low to high enrolment
  const ISOS = ['PAK', 'IND', 'BRA', 'USA'];
  function leaver(iso) {
    return lifeAt(iso, 18, { fam: 0.5, urban: true, education: { level: 'secondary', inSchool: true }, career: { status: 'student', title: null, sector: null }, flags: { secDone: 2018 }, stats: { knowledge: 78 } });
  }
  test('admission chance rises with ter_enroll', () => {
    const rates = ISOS.map((iso) => {
      const { world, st } = leaver(iso);
      const d = actDecision(st, 'uni', { field: 'business' });
      let ok = 0;
      const N = 300;
      for (let i = 0; i < N; i++) if (resolveOffline(data, world, st, d, { optionId: 'a' }, new Rng(i)).set.flags?.track === 'uni') ok++;
      return ok / N;
    });
    for (let i = 1; i < rates.length; i++) assert.ok(rates[i] > rates[i - 1], `admission ${ISOS.join(',')}: ${rates.map((x) => x.toFixed(2)).join(',')}`);
    assert.ok(rates[0] < 0.75 && rates[3] > 0.9 && rates[3] - rates[0] > 0.2, rates.join(','));
  });
  test('the automatic choice applies to university about as often as the country\'s school leavers do', () => {
    const shares = ISOS.map((iso) => {
      const { world, st } = leaver(iso);
      let uni = 0, n = 0;
      for (let i = 0; i < 400; i++) {
        const d = buildDecisionOffline(data, world, st, {}, new Rng(i));
        if (d.context.key !== 'k18_uni') continue;
        const c = autoChoose(st, d, new Rng(i + 9));
        n++;
        if (d.context.acts[c.optionId].act === 'uni') uni++;
      }
      assert.ok(n >= 50, `${iso}: k18_uni ${n}`);
      return uni / n;
    });
    for (let i = 1; i < shares.length; i++) assert.ok(shares[i] > shares[i - 1], `apply ${ISOS.join(',')}: ${shares.map((x) => x.toFixed(2)).join(',')}`);
    assert.ok(shares[0] < 0.65 && shares[3] > 0.85, shares.join(','));
  });
  test('cohorts born in 2000 reach tertiary education within ±10 points of ter_enroll at 18', () => {
    const N = 200;
    const out = [];
    for (const iso of ['CHN', 'IND', 'USA', 'DEU', 'NGA', 'BRA', 'JPN']) {
      let n = 0, t = 0;
      for (let i = 0; i < N; i++) {
        const seed = 5000 + i;
        const world = createWorld(data, seed * 7 + 3);
        const spec = randomBirth(data, world, new Rng(seed), { year: 2000 });
        spec.country = iso;
        const st = newLife(data, world, spec, { ...HEADLESS_SETTINGS }, seed);
        let g = 0;
        while (!st.dead && st.age < 30 && g++ < 200) {
          if (st.pending) autoResolve(data, world, st);
          else stepYear(data, world, st);
        }
        if (st.dead) continue;
        n++;
        if (EDU.indexOf(st.person.education.level) >= 5) t++;
      }
      const ter = data.series(iso, 'ter_enroll', 2018);
      out.push(`${iso} ${(100 * t / n).toFixed(1)} vs ${ter.toFixed(1)}`);
      assert.ok(Math.abs(100 * t / n - ter) <= 10, out.join(' | '));
    }
  });
});

/* ------------------------------------------------------------------ 4. pay of a new occupation, and a sweep */

describe('a new occupation gets its own income percentile', () => {
  test('switching from a well-paid office job to care work does not keep the old percentile', () => {
    const { world, st } = lifeAt('CHN', 40, { education: { level: 'tertiary' }, career: { status: 'employed', title: '职员', sector: '金融商业', incomePct: 0.89 } });
    for (let i = 0; i < 10; i++) {
      const r = resolveOffline(data, world, st, actDecision(st, 'career_switch', { to: 'care' }), { optionId: 'a' }, new Rng(i));
      assert.equal(r.set.career.title, '护理员');
      assert.ok(r.set.career.incomePct < 0.55, `护理员 at ${r.set.career.incomePct}`);
    }
    const farm = resolveOffline(data, world, st, actDecision(st, 'farming'), { optionId: 'a' }, new Rng(1));
    assert.ok(farm.set.career.incomePct < 0.45, `农民 at ${farm.set.career.incomePct}`);
    const worker = lifeAt('CHN', 30, { career: { status: 'employed', title: '工厂工人', sector: '制造业', incomePct: 0.1 }, stats: { knowledge: 90 } });
    for (let i = 0; i < 20; i++) {
      const r = resolveOffline(data, worker.world, worker.st, actDecision(worker.st, 'retrain_ai'), { optionId: 'a' }, new Rng(i));
      for (const c of careerPatches(r)) if (c.title) assert.ok(c.incomePct > 0.35, `${c.title} at ${c.incomePct}`);
    }
    const soldier = lifeAt('KOR', 19, { sex: 'male', career: { status: 'student', title: null, sector: null, incomePct: 0.9 } });
    const m = resolveOffline(data, soldier.world, soldier.st, actDecision(soldier.st, 'military'), { optionId: 'a' }, new Rng(1));
    assert.equal(typeof m.set.career.incomePct, 'number');
    assert.ok(m.set.career.incomePct < 0.4);
  });

  test('sweep over simulated lives: every job title comes with a percentile; no vocational school for vocational graduates; no offer to one\'s own city', () => {
    let checked = 0;
    for (const iso of ['CHN', 'IND', 'USA', 'NGA', 'BRA', 'HKG']) {
      for (let i = 0; i < 6; i++) {
        const seed = 41000 + i * 17 + iso.charCodeAt(1);
        const world = createWorld(data, seed);
        const spec = randomBirth(data, world, new Rng(seed), { year: [2000, 2020, 2045][i % 3] });
        spec.country = iso;
        simulateLife(data, world, spec, seed, {
          settings: { decisionFreq: 'frequent' },
          onYear(state) {
            const d = state.pending;
            if (!d || !d.context) return;
            const lvl = EDU.indexOf(state.person.education.level);
            const here = state.person.urban ? state.person.flags.city : null;
            const own = /^(k15_|k18_|k22_|retry)/.test(d.context.key || '');
            for (const o of d.options) {
              if (own && lvl >= 4) assert.doesNotMatch(o.label, /职业学校|职业高中|读高职/, `${d.context.key} for ${state.person.education.level}`);
              if (here && d.context.key === 't_offer') assert.ok(!o.label.includes(here), `${o.label} / ${here}`);
              const r = resolveOffline(data, world, state, d, { optionId: o.id }, new Rng(state.year));
              checked++;
              for (const c of careerPatches(r)) {
                if (typeof c.title === 'string' && c.title) assert.equal(typeof c.incomePct, 'number', `${d.context.key} «${o.label}» sets ${c.title} without a percentile`);
              }
              if (/全家福|合影/.test(o.label)) assert.match(r.narrative, /全家福|合影/);
              if (/进城打工/.test(o.label)) assert.doesNotMatch(r.narrative, /换工作|跳槽/);
            }
          },
        });
      }
    }
    assert.ok(checked > 300, `checked ${checked}`);
  });
});
