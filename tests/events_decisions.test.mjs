// Tests for src/core/events.js and src/core/decisions.js on the real data files.
// Run: node --test tests/events_decisions.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Rng } from '../src/core/rng.js';
import { YEAR_TAGS, DECISION_AGES, DECISION_FREQUENCY, CAREER_STATUS, EDU_LEVELS } from '../src/core/constants.js';
import { EVENT_LIBRARY, pickPersonalEvents, fillText, lifeFacts, CITIES, keyExams, eventTemplate, newPartnerName } from '../src/core/events.js';
import {
  nextDecisionAge, buildDecisionOffline, resolveOffline, classifyIntent, autoChoose, triggeredDecision, ACTION_KEYS,
} from '../src/core/decisions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

let data;
let createWorld = null;
try {
  const D = await import('../src/core/data.js');
  let content = null;
  try { content = readJson('data/content.json'); } catch { content = null; }
  data = D.makeDataStore({ countries: readJson('data/countries.json'), mortality: readJson('data/mortality.json'), content });
} catch {
  // minimal stub when data.js is unavailable
  const countries = readJson('data/countries.json');
  const years = countries.meta.years;
  const at = (arr, y) => {
    if (!Array.isArray(arr)) return null;
    let i = years.findIndex((x) => x >= y);
    if (i < 0) i = years.length - 1;
    return arr[i] ?? null;
  };
  data = {
    years, countries: countries.countries, isoList: Object.keys(countries.countries), content: { names: { countries: {} }, lifePaths: { countries: {} } },
    country: (iso) => countries.countries[iso],
    series: (iso, k, y) => { const c = countries.countries[iso]; return c ? at((c.wb && c.wb[k]) || (c.wpp && c.wpp[k]), y) : null; },
    incomeGroup: (iso, y) => { const g = data.series(iso, 'gdp_pc_ppp', y) || 5000; return g < 2600 ? 'LIC' : g < 9000 ? 'LMC' : g < 26000 ? 'UMC' : 'HIC'; },
    lifePath: () => ({}),
  };
}
try { ({ createWorld } = await import('../src/core/world.js')); } catch { createWorld = null; }
function makeWorld(seed) {
  if (createWorld) return createWorld(data, seed);
  return { seed, branches: {}, dims: [], modifiers: () => ({}), indicator: (iso, k, y) => data.series(iso, k, y), events: () => [], incomeGroup: (iso, y) => data.incomeGroup(iso, y), isProjection: (y) => y > 2026 };
}
const WORLDS = [1, 2, 3, 4, 5, 6].map((s) => makeWorld(1000 + s));

/* ------------------------------------------------------------------ fake lives */

const TITLES = [['工人', '制造业'], ['店员', '零售'], ['教师', '教育'], ['护士', '医疗'], ['司机', '运输'], ['软件工程师', '信息技术'], ['农民', '农业'], ['职员', '金融商业']];
const NAMES = ['李明', '王芳', '阿米特', '玛丽亚', '约瑟夫', '安娜', '佐藤', '阿伊莎'];
const isoList = data.isoList || Object.keys(data.countries);

function ctxFor(world, iso, year) {
  const ind = (k) => { const v = world.indicator(iso, k, year); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  const events = (world.events(iso, year) || []).filter(Boolean);
  const war = events.filter((e) => e.category === 'war' || e.category === 'conflict');
  const conflict = war.some((e) => (e.countries || []).includes(iso)) ? 2 : war.length ? 1 : 0;
  const c = data.country(iso) || {};
  return {
    iso3: iso, year, country: c.name, region: c.region, incomeGroup: (world.incomeGroup || data.incomeGroup)(iso, year),
    gdp: ind('gdp_pc_ppp'), gdpGrowth: ind('gdp_growth'), unemployment: ind('unemployment'), youthUnemp: ind('youth_unemp'), gini: ind('gini'),
    poverty: ind('poverty'), internet: ind('internet'), urban: ind('urban'), secEnroll: ind('sec_enroll'), terEnroll: ind('ter_enroll'),
    lifeExp: ind('le'), tfr: ind('tfr'), medAge: ind('med_age'), conflict, events, projection: year > 2026,
  };
}

function pickIso(r, year) {
  if (r.chance(0.3) || !data.birthsWeights) return r.pick(isoList);
  try {
    const bw = data.birthsWeights(Math.min(2100, year));
    return r.weighted(bw.isos, bw.weights) || r.pick(isoList);
  } catch { return r.pick(isoList); }
}

function makeLife(r, ageWanted, opts = {}) {
  const age = ageWanted;
  const birthYear = opts.birthYear ?? r.int(2000, Math.min(2070, 2105 - age));
  const year = birthYear + age;
  const iso = opts.iso || pickIso(r, birthYear);
  const sex = opts.sex || (r.chance(0.5) ? 'male' : 'female');
  const urban = opts.urban ?? r.chance(0.55);
  const familyPct = opts.familyPct ?? r.float(0.02, 0.98);
  let level = 'none';
  let inSchool = false;
  let field = null;
  if (age >= 3 && age < 6) { level = 'preschool'; inSchool = r.chance(0.6); } else if (age < 12) { level = 'primary'; inSchool = age >= 6 && r.chance(0.9); } else if (age < 18) { level = 'secondary'; inSchool = r.chance(0.75); } else if (age < 23) { level = r.pick(['secondary', 'secondary', 'vocational']); inSchool = r.chance(0.4); field = inSchool && r.chance(0.6) ? '工程' : null; } else { level = r.pick(['none', 'primary', 'secondary', 'secondary', 'vocational', 'tertiary', 'tertiary', 'postgrad']); }
  let status = 'child';
  if (age >= 15) {
    if (inSchool) status = 'student';
    else if (age >= 65) status = r.chance(0.7) ? 'retired' : 'employed';
    else status = r.weighted(['employed', 'self_employed', 'unemployed', 'homemaker', 'military'], [70, 12, 10, 6, 2]);
  }
  const [title, sector] = status === 'employed' || status === 'self_employed' ? r.pick(TITLES) : [null, null];
  let rel = 'single';
  if (age >= 18) {
    rel = age < 26 ? r.weighted(['single', 'dating', 'married'], [60, 30, 10])
      : age <= 40 ? r.weighted(['married', 'single', 'dating', 'divorced', 'partnered'], [55, 20, 15, 5, 5])
        : age <= 70 ? r.weighted(['married', 'divorced', 'widowed', 'single', 'dating'], [65, 10, 10, 10, 5])
          : r.weighted(['married', 'widowed', 'single'], [45, 45, 10]);
  }
  const partner = ['dating', 'married', 'partnered'].includes(rel) ? { name: r.pick(NAMES), sinceYear: year - r.int(0, Math.max(0, age - 18)) } : null;
  const children = [];
  if (age >= 20 && ['married', 'divorced', 'widowed', 'partnered'].includes(rel)) {
    const n = r.int(0, 3);
    for (let i = 0; i < n; i++) {
      const by = year - r.int(0, Math.max(0, age - 18));
      children.push({ name: r.pick(['小明', '小红', '阿里', '索菲亚', '卢卡斯']) + i, sex: r.chance(0.5) ? 'male' : 'female', birthYear: by, alive: r.chance(0.97) });
    }
  }
  const conditions = [];
  if (age >= 40 && r.chance(0.3)) conditions.push({ id: r.pick(['hypertension', 'diabetes', 'cancer', 'copd']), name: '慢性病', sinceYear: year - r.int(0, 8), severity: r.int(1, 3) });
  const flags = {};
  if (age >= 16 && r.chance(0.2)) flags.smoker = true;
  if (age >= 18 && r.chance(0.08)) { flags.migrant = iso; flags.origin = pickIso(r, birthYear); flags.migrantSince = year - r.int(0, 10); }
  if (r.chance(0.05)) flags.leftBehind = true;
  if (age >= 25 && r.chance(0.2)) flags.homeowner = true;
  if (age >= 50 && r.chance(0.3)) flags.grandparent = true;
  const gdp = data.series(iso, 'gdp_pc_ppp', Math.min(year, 2100)) || 8000;
  const income = status === 'employed' || status === 'self_employed' ? gdp * 0.6 * r.float(0.3, 2.5) : 0;
  const momAge = age + r.int(18, 40);
  const dadAge = age + r.int(20, 45);
  const id = `life-${r.int(0, 1e9)}`;
  return {
    v: 1, id, seed: r.int(1, 1e9), rng: [1, 2, 3, 4], createdAt: '2026-10-24T00:00:00Z', mode: 'random',
    worldSeed: 1, worldLabel: 'test',
    settings: { lifeMinutes: 30, aiMode: 'off', decisionFreq: opts.freq || 'standard', autoChoose: false },
    birth: { mode: 'random', year: birthYear, date: `${birthYear}-05-01`, time: '08:00:00', country: flags.origin || iso, sex, urban: opts.birthUrban ?? r.chance(0.5), familyPct, parentsEdu: 'secondary', siblings: r.int(0, 4), motherAge: 28, fatherAge: 31, name: r.pick(NAMES), notes: [] },
    year, age,
    person: {
      name: r.pick(NAMES), sex, country: iso, urban, familyPct,
      education: { level, inSchool, field, years: Math.min(age, 16), exams: [] },
      career: { status, title, sector, incomePct: r.float(0.05, 0.95), years: Math.max(0, age - 20), employer: null },
      relationship: { status: rel, partner },
      children,
      parents: { mother: { age: momAge, alive: momAge < 85 && r.chance(0.9) }, father: { age: dadAge, alive: dadAge < 82 && r.chance(0.85) } },
      siblings: r.int(0, 4),
      money: { cash: r.float(0, 5) * gdp, debt: r.chance(0.3) ? r.float(0, 2) * gdp : 0, income, portfolio: { stocks: r.chance(0.3) ? gdp : 0, bonds: 0, gold: 0, property: 0, crypto: 0 } },
      conditions, flags,
    },
    stats: { health: r.int(20, 95), happiness: r.int(15, 95), knowledge: r.int(10, 95), relationships: r.int(15, 95), wealth: r.int(5, 95) },
    history: [], log: [], decisions: [], threads: [], hazardMods: [], pending: null, dead: null, cohort: [], aiNotes: { birthStory: null, lastSummary: null },
  };
}

/* ------------------------------------------------------------------ validators */

const BAD = /\{\w+\}|undefined|NaN|null|\[object/;
function checkText(s, where) {
  assert.equal(typeof s, 'string', `${where}: not a string`);
  assert.ok(s.trim().length > 0, `${where}: empty`);
  assert.ok(!BAD.test(s), `${where}: bad text «${s}»`);
}
function checkEffects(e, where, withWealth = true) {
  assert.ok(e && typeof e === 'object', `${where}: effects missing`);
  for (const k of ['health', 'happiness', 'knowledge', 'relationships']) {
    assert.ok(Number.isInteger(e[k]), `${where}: ${k}=${e[k]} not int`);
    assert.ok(e[k] >= -15 && e[k] <= 15, `${where}: ${k}=${e[k]} out of range`);
  }
  if (withWealth || e.wealthDelta !== undefined) assert.ok(Number.isFinite(e.wealthDelta), `${where}: wealthDelta ${e.wealthDelta}`);
}
const RISKS = new Set(['low', 'mid', 'high']);
function checkDecision(d, where, kind) {
  assert.ok(d && typeof d === 'object', `${where}: no decision`);
  assert.equal(typeof d.id, 'string');
  if (kind) assert.equal(d.kind, kind, `${where}: kind`);
  checkText(d.title, `${where} title`);
  checkText(d.situation, `${where} situation`);
  assert.ok(Array.isArray(d.options) && d.options.length >= 2 && d.options.length <= 4, `${where}: ${d.options && d.options.length} options`);
  const ids = new Set();
  d.options.forEach((o, i) => {
    assert.equal(o.id, 'abcd'[i], `${where}: option id`);
    ids.add(o.id);
    checkText(o.label, `${where} label`);
    assert.ok(o.label.length <= 16, `${where}: label too long «${o.label}»`);
    checkText(o.detail, `${where} detail`);
    assert.ok(RISKS.has(o.risk), `${where}: risk ${o.risk}`);
  });
  assert.equal(d.allowCustom, true);
  assert.equal(d.source, 'local');
}
const REL = new Set(['single', 'dating', 'married', 'partnered', 'divorced', 'widowed']);
function checkSet(s, where) {
  assert.ok(s && typeof s === 'object' && !Array.isArray(s), `${where}: set`);
  if (s.country !== undefined) assert.ok(data.country(s.country), `${where}: unknown country ${s.country}`);
  if (s.relationship) assert.ok(REL.has(s.relationship.status), `${where}: relationship ${s.relationship.status}`);
  if (s.career && s.career.status !== undefined) assert.ok(CAREER_STATUS.includes(s.career.status), `${where}: career ${s.career.status}`);
  if (s.career && s.career.incomePct !== undefined) assert.ok(s.career.incomePct >= 0 && s.career.incomePct <= 1, `${where}: incomePct`);
  if (s.education && s.education.level !== undefined) assert.ok(EDU_LEVELS.includes(s.education.level), `${where}: edu ${s.education.level}`);
  if (s.urban !== undefined) assert.equal(typeof s.urban, 'boolean', `${where}: urban`);
  if (s.flags !== undefined) assert.equal(typeof s.flags, 'object', `${where}: flags`);
}
function checkResolution(r, state, where) {
  assert.ok(r && typeof r === 'object', `${where}: no resolution`);
  checkText(r.narrative, `${where} narrative`);
  checkEffects(r.effects, where);
  checkSet(r.set, where);
  assert.equal(typeof r.feasible, 'boolean', `${where}: feasible`);
  assert.ok(Array.isArray(r.threads), `${where}: threads`);
  if (r.hazard) {
    assert.ok(r.hazard.mult >= 0.5 && r.hazard.mult <= 2, `${where}: hazard mult`);
    assert.ok(r.hazard.years >= 1 && r.hazard.years <= 30, `${where}: hazard years`);
    assert.equal(typeof r.hazard.reason, 'string');
  }
  for (const t of r.threads) {
    assert.equal(typeof t.id, 'string');
    checkText(t.title, `${where} thread title`);
    checkText(t.text, `${where} thread text`);
    assert.ok(t.trigger && Number.isInteger(t.trigger.year) && t.trigger.year > state.year, `${where}: thread trigger`);
    assert.equal(t.conditions && t.conditions.alive, true);
    checkEffects(t.effects, `${where} thread`);
    if (t.set) checkSet(t.set, `${where} thread`);
    if (t.decision) checkDecision(t.decision, `${where} thread decision`);
    assert.equal(t.source, 'local');
  }
}

/* ------------------------------------------------------------------ events */

describe('EVENT_LIBRARY', () => {
  test('has 450+ well-formed templates with unique ids', () => {
    assert.ok(EVENT_LIBRARY.length >= 450, `only ${EVENT_LIBRARY.length}`);
    const ids = new Set();
    for (const t of EVENT_LIBRARY) {
      assert.ok(!ids.has(t.id), `duplicate ${t.id}`);
      ids.add(t.id);
      assert.equal(typeof t.when, 'function');
      assert.ok(YEAR_TAGS.includes(t.tag), `${t.id}: tag ${t.tag}`);
      assert.ok(t.text || t.textFn, `${t.id}: no text`);
      checkEffects(t.effects, t.id, false);
      assert.ok(t.once || t.cooldown >= 1, `${t.id}: neither once nor cooldown`);
      if (t.hazard) assert.ok(t.hazard.mult >= 0.5 && t.hazard.mult <= 2);
    }
  });
  test('covers every life stage and the world', () => {
    const pre = (p) => EVENT_LIBRARY.filter((t) => t.id.startsWith(p)).length;
    for (const [p, n] of [['inf_', 25], ['ch_', 60], ['tn_', 40], ['y_', 50], ['a_', 50], ['m_', 35], ['s_', 30], ['e_', 15], ['w_', 15], ['t_', 10], ['r_', 10]]) assert.ok(pre(p) >= n, `${p}: ${pre(p)} < ${n}`);
    assert.ok(EVENT_LIBRARY.filter((t) => t.world).length >= 60);
  });
  test('every condition evaluates without throwing on 300 random lives', () => {
    const r = new Rng(7);
    for (let i = 0; i < 300; i++) {
      const s = makeLife(r, r.int(0, 105));
      const w = r.pick(WORLDS);
      const ctx = ctxFor(w, s.person.country, s.year);
      for (const t of EVENT_LIBRARY) {
        const v = t.when(s, ctx, data, w);
        assert.ok(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)), `${t.id} returned ${v}`);
      }
    }
  });
});

describe('pickPersonalEvents', () => {
  test('200 random contexts x every stage: 0-3 clean events, no contradictions, era-gated', () => {
    const r = new Rng(11);
    const ages = [0, 1, 2, 4, 6, 9, 12, 14, 16, 17, 19, 21, 24, 28, 33, 38, 44, 50, 57, 63, 69, 75, 82, 90, 98];
    const childTpl = new Set(EVENT_LIBRARY.filter((t) => (typeof t.text === 'string' && t.text.includes('{child}')) || (Array.isArray(t.text) && t.text.some((x) => x.includes('{child}')))).map((t) => t.id));
    const partnerTpl = new Set(EVENT_LIBRARY.filter((t) => (typeof t.text === 'string' && t.text.includes('{partner}')) || (Array.isArray(t.text) && t.text.some((x) => x.includes('{partner}')))).map((t) => t.id));
    let total = 0;
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      for (const age of ages) {
        const s = makeLife(r, age);
        const w = WORLDS[i % WORLDS.length];
        const ctx = ctxFor(w, s.person.country, s.year);
        const evs = pickPersonalEvents(data, w, s, ctx, new Rng(i * 1000 + age));
        assert.ok(Array.isArray(evs) && evs.length <= 3, 'count');
        const f = lifeFacts(data, w, s, ctx);
        for (const e of evs) {
          total++;
          seen.add(e.id);
          const where = `${e.id} (${s.person.country} ${s.year} age ${age})`;
          checkText(e.text, where);
          assert.ok(Number.isInteger(e.tone) && e.tone >= -2 && e.tone <= 2, `${where}: tone`);
          assert.ok(Array.isArray(e.tags) && YEAR_TAGS.includes(e.tag), `${where}: tag`);
          checkEffects(e.effects, where, false);
          if (e.set) checkSet(e.set, where);
          assert.equal(s.person.flags[`ev:${e.id}`], s.year, `${where}: not marked`);
          if (childTpl.has(e.id)) assert.ok(f.hasKids, `${where}: child event without children`);
          if (partnerTpl.has(e.id)) assert.ok(f.hasPartner, `${where}: partner event without partner`);
          // these quote the title of a real/projected world event verbatim (e.g. a 2022 ChatGPT headline)
          if (['w_hook_history', 'w_hook_future', 'w_tech_news', 'w_space', 'w_sport', 'w_epidemic_local', 'w_fin_crisis', 'w_war_far', 'w_war_mild', 'w_blackout'].includes(e.id)) continue;
          if (s.year < 2008) assert.ok(!/智能手机|短视频|扫码|直播|AI|人工智能|机器人|生成式/.test(e.text), `${where}: anachronism «${e.text}»`);
          if (s.year <= 2022) assert.ok(!/生成式|AI 助手|AI 工具|AI 写/.test(e.text), `${where}: early AI «${e.text}»`);
          if (s.year <= 2026) assert.ok(!/护理机器人|机器狗|脑机接口|火星上的|抗衰老疗法|基本收入/.test(e.text), `${where}: future tech «${e.text}»`);
        }
      }
    }
    assert.ok(total > 3000, `only ${total} events`);
    assert.ok(seen.size >= 250, `only ${seen.size} distinct templates fired`);
  });
  test('once and cooldown are respected across years', () => {
    const r = new Rng(5);
    const s = makeLife(r, 30, { iso: 'CHN', birthYear: 2000 });
    const w = WORLDS[0];
    const fired = new Map();
    for (let y = 0; y < 40; y++) {
      s.year = 2030 + y;
      s.age = 30 + y;
      s.birth.year = 2000;
      const ctx = ctxFor(w, 'CHN', s.year);
      for (const e of pickPersonalEvents(data, w, s, ctx, new Rng(y))) {
        const t = EVENT_LIBRARY.find((x) => x.id === e.id);
        if (fired.has(e.id)) {
          assert.ok(!t.once, `${e.id} fired twice though once`);
          assert.ok(s.year - fired.get(e.id) >= t.cooldown, `${e.id} cooldown broken`);
        }
        fired.set(e.id, s.year);
      }
    }
  });
  test('reacts to world events (war, pandemic) and gates projections', () => {
    const r = new Rng(3);
    const war = { id: 'test_war', source: 'history', year: 2015, title: '测试冲突', summary: '', category: 'war', importance: 5, scope: 'countries', countries: ['SYR'], effects: { safety: -3, economy: -2 }, migration_push: 3, personal_hooks: ['居民躲进地下室'], projection: false };
    let warHits = 0;
    for (let i = 0; i < 60; i++) {
      const s = makeLife(r, 30, { iso: 'SYR', birthYear: 1985 + (i % 3) });
      s.year = 2015; s.age = 2015 - s.birth.year;
      const ctx = { ...ctxFor(WORLDS[0], 'SYR', 2015), events: [war], conflict: 3 };
      for (const e of pickPersonalEvents(data, WORLDS[0], s, ctx, new Rng(i))) if (e.tags.includes('world')) warHits++;
    }
    assert.ok(warHits >= 40, `war reactions ${warHits}`);
    const covid = { id: 'covid', source: 'history', year: 2020, endYear: 2022, title: '新冠疫情', summary: 'COVID-19', category: 'epidemic', importance: 5, scope: 'global', countries: [], effects: { health: -2 }, personal_hooks: [], projection: false };
    let lock = 0;
    for (let i = 0; i < 40; i++) {
      const s = makeLife(r, 35, { iso: 'ITA', birthYear: 1985 });
      const ctx = { ...ctxFor(WORLDS[0], 'ITA', 2020), events: [covid] };
      for (const e of pickPersonalEvents(data, WORLDS[0], s, ctx, new Rng(100 + i))) if (e.tags.includes('world')) lock++;
    }
    assert.ok(lock >= 20, `pandemic reactions ${lock}`);
  });
  test('fillText resolves every variable and never leaks braces', () => {
    const r = new Rng(9);
    for (let i = 0; i < 100; i++) {
      const s = makeLife(r, r.int(0, 90));
      const ctx = ctxFor(WORLDS[0], s.person.country, s.year);
      const t = fillText('{name}{partner}{child}{sibling}{country}{city}{year}{age}{bigcity}{festival}{homefood}{crop}{sport}{lang}{storm}{exam}{origin}{granny}{grandpa}{unknownvar}', s, ctx, r);
      assert.ok(!/[{}]|undefined|NaN/.test(t), t);
    }
    assert.ok(Object.keys(CITIES).length >= 40);
    assert.equal(fillText('{city}', { person: { country: 'JPN', urban: false, flags: {} } }, {}, null), '镇上');
  });
  test('deterministic for the same seed', () => {
    const r1 = new Rng(77);
    const r2 = new Rng(77);
    const a = makeLife(r1, 33);
    const b = makeLife(r2, 33);
    const ctxA = ctxFor(WORLDS[1], a.person.country, a.year);
    const ctxB = ctxFor(WORLDS[1], b.person.country, b.year);
    assert.deepEqual(pickPersonalEvents(data, WORLDS[1], a, ctxA, new Rng(5)), pickPersonalEvents(data, WORLDS[1], b, ctxB, new Rng(5)));
  });
});

/* ------------------------------------------------------------------ decisions */

describe('nextDecisionAge', () => {
  test('standard, sparse and frequent schedules', () => {
    assert.equal(nextDecisionAge({ age: 0 }, 'standard'), 5);
    assert.equal(nextDecisionAge({ age: 5 }, 'standard'), 12);
    assert.equal(nextDecisionAge({ age: 17 }, 'standard'), 18);
    assert.equal(nextDecisionAge({ age: 100 }, 'standard'), 999);
    assert.equal(nextDecisionAge({ age: 18 }, 'sparse'), 22);
    assert.equal(nextDecisionAge({ age: 18, settings: { decisionFreq: 'sparse' } }), 22);
    const st = { age: 0, seed: 42 };
    let prev = 0;
    const seq = [];
    for (let i = 0; i < 20; i++) { const n = nextDecisionAge(st, 'frequent'); seq.push(n); st.age = n; }
    assert.equal(seq[0], 5);
    for (const n of seq.slice(1)) { assert.ok(n - prev >= 2 && n - prev <= 3 || prev === 0, `gap ${n - prev}`); prev = n; }
    assert.deepEqual(DECISION_FREQUENCY.standard, DECISION_AGES);
  });
});

describe('buildDecisionOffline + resolveOffline', () => {
  test('200 random contexts x every standard age: valid decisions and resolutions', () => {
    const r = new Rng(21);
    const customs = ['我想去城里打工', '我要好好学习', '去美国留学', '开一家小店', '和伴侣结婚', '每天跑步锻炼', '我想当一名画家', '随便过过日子吧', '去火星', '照顾生病的妈妈', 'xyz123'];
    const keys = new Map();
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const w = WORLDS[i % WORLDS.length];
      for (const age of DECISION_AGES) {
        const s = makeLife(r, age);
        const ctx = ctxFor(w, s.person.country, s.year);
        const d = buildDecisionOffline(data, w, s, ctx, new Rng(i * 997 + age));
        const where = `${d.context && d.context.key} ${s.person.country} ${s.year} age ${age}`;
        checkDecision(d, where, 'milestone');
        keys.set(d.context.key, (keys.get(d.context.key) || 0) + 1);
        for (const o of d.options) {
          const res = resolveOffline(data, w, s, d, { optionId: o.id }, new Rng(n++));
          checkResolution(res, s, `${where} → ${o.label}`);
        }
        const c = autoChoose(s, d, new Rng(i));
        assert.ok(d.options.some((o) => o.id === c.optionId), 'autoChoose id');
        const txt = customs[(i + age) % customs.length];
        const cr = resolveOffline(data, w, s, { ...d, kind: 'custom', options: [] }, { customText: txt }, new Rng(n++));
        checkResolution(cr, s, `${where} custom «${txt}»`);
      }
    }
    assert.ok(keys.size >= 45, `only ${keys.size} templates used: ${[...keys.keys()].join(',')}`);
  });
  test('every action key resolves for several life shapes', () => {
    const r = new Rng(31);
    const w = WORLDS[2];
    for (const act of ACTION_KEYS) {
      for (const age of [8, 16, 24, 40, 70]) {
        const s = makeLife(r, age);
        const ctx = ctxFor(w, s.person.country, s.year);
        const d = { id: `d-test-${act}`, year: s.year, age, kind: 'milestone', title: '测试', situation: '测试', allowCustom: true, source: 'local',
          options: [{ id: 'a', label: '测试选项', detail: '测试。', risk: 'mid' }, { id: 'b', label: '另一个', detail: '测试。', risk: 'low' }],
          context: { key: 'test', acts: { a: { act, p: {} }, b: { act: 'stay_course', p: {} } }, auto: { a: 1, b: 1 } } };
        checkResolution(resolveOffline(data, w, s, d, { optionId: 'a' }, new Rng(age)), s, `${act} @${age}`);
        void ctx;
      }
    }
  });
  test('country-specific decisions: gaokao, conscription, retirement', () => {
    const r = new Rng(41);
    const w = WORLDS[0];
    let gaokao = 0;
    for (let i = 0; i < 30; i++) {
      const s = makeLife(r, 18, { iso: 'CHN', birthYear: 2002 + (i % 6) });
      s.person.education.inSchool = true;
      s.person.education.level = 'secondary';
      const d = buildDecisionOffline(data, w, s, ctxFor(w, 'CHN', s.year), new Rng(i));
      if (d.context.key === 'k18_gaokao') gaokao++;
    }
    assert.ok(gaokao >= 15, `gaokao ${gaokao}/30`);
    let consc = 0;
    for (let i = 0; i < 30; i++) {
      const s = makeLife(r, 18, { iso: 'KOR', sex: 'male', birthYear: 2003 });
      const d = buildDecisionOffline(data, w, s, ctxFor(w, 'KOR', s.year), new Rng(i));
      if (d.context.key === 'k18_conscript') consc++;
    }
    assert.ok(consc >= 12, `conscription ${consc}/30`);
    const s = makeLife(r, 60, { iso: 'DEU', birthYear: 2001 });
    s.person.career.status = 'employed';
    const d = buildDecisionOffline(data, w, s, ctxFor(w, 'DEU', s.year), new Rng(1));
    checkDecision(d, 'retire', 'milestone');
  });
  test('feasibility: a poor rural child cannot simply move abroad', () => {
    const r = new Rng(51);
    const w = WORLDS[0];
    for (let i = 0; i < 20; i++) {
      const s = makeLife(r, 12, { iso: 'NER', urban: false, familyPct: 0.05, birthYear: 2005 });
      const d = buildDecisionOffline(data, w, s, ctxFor(w, 'NER', s.year), new Rng(i));
      const res = resolveOffline(data, w, s, d, { customText: '我要移民去美国' }, new Rng(i));
      assert.equal(res.feasible, false, res.narrative);
      assert.equal(res.set.country, undefined);
    }
    let moved = 0;
    for (let i = 0; i < 40; i++) {
      const s = makeLife(r, 30, { iso: 'IND', urban: true, familyPct: 0.95, birthYear: 2000 });
      s.person.education.level = 'postgrad';
      s.stats.knowledge = 85;
      s.person.money.cash = 200000;
      const d = buildDecisionOffline(data, w, s, ctxFor(w, 'IND', s.year), new Rng(i));
      const res = resolveOffline(data, w, s, d, { customText: '移民加拿大' }, new Rng(i));
      if (res.set.country === 'CAN') {
        moved++;
        assert.ok(res.threads.length >= 2, 'migration threads');
        assert.ok(res.set.flags && res.set.flags.migrant === 'CAN');
      }
    }
    assert.ok(moved >= 10, `educated wealthy emigrants succeeded only ${moved}/40`);
  });
  test('medicine leads to a doctor thread years later', () => {
    const r = new Rng(61);
    const w = WORLDS[0];
    let doctor = 0;
    for (let i = 0; i < 40; i++) {
      const s = makeLife(r, 18, { iso: 'BRA', familyPct: 0.85, birthYear: 2004 });
      s.person.education.inSchool = true;
      s.stats.knowledge = 88;
      const d = { id: 'd-med', year: s.year, age: 18, kind: 'milestone', title: '志愿', situation: '选择专业。', options: [{ id: 'a', label: '学医', detail: '学医。', risk: 'mid' }, { id: 'b', label: '工作', detail: '工作。', risk: 'low' }], allowCustom: true, source: 'local', context: { key: 'x', acts: { a: { act: 'uni', p: { field: 'medicine' } }, b: { act: 'work_now', p: {} } }, auto: {} } };
      const res = resolveOffline(data, w, s, d, { optionId: 'a' }, new Rng(i));
      const t = res.threads.find((x) => x.set && x.set.career && x.set.career.title === '医生');
      if (t) { doctor++; assert.ok(t.trigger.year - s.year >= 6, 'doctor thread timing'); }
    }
    assert.ok(doctor >= 10, `doctor threads ${doctor}/40`);
  });
  test('decisions without context (AI-shaped) are resolved by their text', () => {
    const r = new Rng(71);
    const s = makeLife(r, 25, { iso: 'MEX', birthYear: 2001 });
    const d = { id: 'ai-1', year: s.year, age: 25, kind: 'milestone', title: 'AI 抉择', situation: '……', allowCustom: true, source: 'ai',
      options: [{ id: 'a', label: '去美国打工', detail: '跨过边境。', risk: 'high' }, { id: 'b', label: '在家乡开店', detail: '做点小生意。', risk: 'mid' }, { id: 'c', label: '坐看云起', detail: '……', risk: 'low' }] };
    for (const id of ['a', 'b', 'c']) checkResolution(resolveOffline(data, WORLDS[0], s, d, { optionId: id }, new Rng(3)), s, `ai ${id}`);
    checkResolution(resolveOffline(data, WORLDS[0], s, null, null, null), s, 'null decision');
  });
});

describe('triggeredDecision', () => {
  test('valid when present, rare in calm lives, likely in war', () => {
    const r = new Rng(81);
    let calm = 0;
    let years = 0;
    for (let i = 0; i < 30; i++) {
      const s = makeLife(r, 25, { iso: 'NOR', birthYear: 2001 });
      for (let y = 0; y < 30; y++) {
        s.year++;
        s.age++;
        years++;
        const ctx = { ...ctxFor(WORLDS[0], 'NOR', s.year), events: [] };
        const d = triggeredDecision(data, WORLDS[0], s, ctx, new Rng(i * 100 + y));
        if (d) {
          calm++;
          checkDecision(d, `trigger ${d.context.key}`, 'triggered');
          s.decisions.push({ id: d.id, year: s.year, age: s.age, title: d.title, choice: 'a', custom: false, source: 'local' });
        }
      }
    }
    assert.ok(calm / years < 0.12, `too many triggered decisions: ${calm}/${years}`);
    const war = { id: 'w', source: 'history', year: 2030, title: '冲突', summary: '', category: 'war', importance: 5, scope: 'countries', countries: ['UKR'], effects: { safety: -3 }, migration_push: 3, personal_hooks: [], projection: true };
    let hits = 0;
    for (let i = 0; i < 40; i++) {
      const s = makeLife(r, 31, { iso: 'UKR', birthYear: 1999 });
      s.year = 2030;
      s.age = 31;
      const d = triggeredDecision(data, WORLDS[0], s, { ...ctxFor(WORLDS[0], 'UKR', 2030), events: [war], conflict: 3 }, new Rng(i));
      if (d) { hits++; checkDecision(d, 'war trigger', 'triggered'); for (const o of d.options) checkResolution(resolveOffline(data, WORLDS[0], s, d, { optionId: o.id }, new Rng(i)), s, 'war option'); }
    }
    assert.ok(hits >= 15, `war triggers ${hits}/40`);
  });
});

describe('degrades gracefully', () => {
  test('empty content (no names, life paths, history or future) still yields clean events and decisions', async () => {
    let D = null;
    try { D = await import('../src/core/data.js'); } catch { D = null; }
    if (!D || !createWorld) return;
    const bare = D.makeDataStore({ countries: readJson('data/countries.json'), mortality: readJson('data/mortality.json'), content: null });
    const w = createWorld(bare, 99);
    const r = new Rng(101);
    for (let i = 0; i < 60; i++) {
      const s = makeLife(r, DECISION_AGES[i % DECISION_AGES.length]);
      const ctx = { iso3: s.person.country, year: s.year, events: [] };
      for (const e of pickPersonalEvents(bare, w, s, ctx, new Rng(i))) checkText(e.text, `bare ${e.id}`);
      const d = buildDecisionOffline(bare, w, s, ctx, new Rng(i));
      checkDecision(d, 'bare decision', 'milestone');
      for (const o of d.options) checkResolution(resolveOffline(bare, w, s, d, { optionId: o.id }, new Rng(i)), s, 'bare resolution');
      checkResolution(resolveOffline(bare, w, s, d, { customText: '我想出国读书' }, new Rng(i)), s, 'bare custom');
    }
  });
  test('malformed input never throws', () => {
    assert.deepEqual(pickPersonalEvents(data, WORLDS[0], null, {}, new Rng(1)), []);
    assert.deepEqual(pickPersonalEvents(data, WORLDS[0], { person: null }, {}, new Rng(1)), []);
    const partial = { id: 'p', year: 2030, age: 40, person: { country: 'BRA' }, stats: {} };
    const d = buildDecisionOffline(data, WORLDS[0], partial, {}, new Rng(1));
    checkDecision(d, 'partial', 'milestone');
    checkResolution(resolveOffline(data, WORLDS[0], partial, d, { optionId: 'a' }, new Rng(1)), partial, 'partial');
    assert.ok(Array.isArray(pickPersonalEvents(data, WORLDS[0], partial, {}, new Rng(2))));
    assert.equal(triggeredDecision(data, WORLDS[0], { dead: { year: 2000 } }, {}, new Rng(1)), null);
    assert.ok(autoChoose({}, { options: [] }, new Rng(1)).customText);
  });
});

describe('classifyIntent', () => {
  const cases = [
    ['我想继续读书，考研究生', 'study'], ['我要转专业去学计算机', 'change_major'], ['辞职！再也不想上班了', 'quit_job'],
    ['和朋友一起创业开公司', 'start_business'], ['去北京打工', 'move_city'], ['我想移民去加拿大', 'emigrate'],
    ['出国留学读硕士', 'study_abroad'], ['向女朋友求婚，我们结婚吧', 'marry'], ['我们离婚吧', 'divorce'],
    ['想要个孩子', 'have_child'], ['去孤儿院领养一个孩子', 'adopt'], ['每天跑步健身', 'exercise'],
    ['戒烟', 'quit_smoking'], ['背包去环游世界旅行', 'travel'], ['周末去做志愿者', 'volunteer'],
    ['拿积蓄去炒股', 'invest_stocks'], ['买比特币', 'invest_crypto'], ['攒钱存起来', 'save'],
    ['贷款买房', 'buy_home'], ['我要当一名作家，写小说', 'writer'], ['组乐队唱歌', 'musician'],
    ['参军入伍保家卫国', 'military'], ['回老家照顾父母', 'care_parents'], ['去看心理医生', 'therapy'],
    ['去寺庙修行', 'faith'], ['参加环保倡导活动', 'activism'], ['去赌场赌一把', 'gamble'],
    ['提前退休享受生活', 'retire_early'], ['学人工智能和编程', 'learn_ai'], ['回乡种地养猪', 'farming'],
    ['我不想结婚了', 'stay_single'], ['不再赌博了', 'save'],
  ];
  for (const [text, want] of cases) {
    test(`«${text}» -> ${want}`, () => {
      const c = classifyIntent(text, data);
      assert.ok(c.intents.length > 0, 'no intent');
      assert.equal(c.intents[0], want, `got ${c.intents.join(',')}`);
    });
  }
  test('destination detection', () => {
    assert.equal(classifyIntent('我想移民去加拿大', data).targetCountry, 'CAN');
    assert.equal(classifyIntent('去日本工作', data).targetCountry, 'JPN');
    assert.equal(classifyIntent('搬去中国台湾', data).targetCountry, 'TWN');
    assert.equal(classifyIntent('去迪拜打工', data).targetCountry, 'ARE');
    const c = classifyIntent('去上海闯一闯', data);
    assert.equal(c.targetCountry, 'CHN');
    assert.equal(c.targetCity, '上海');
    assert.deepEqual(classifyIntent('', data).intents, []);
    assert.equal(classifyIntent('去南苏丹', data).targetCountry, 'SSD');
  });
});

/* ------------------------------------------------------------------ free-text actions, end to end */

/** a fully specified life (no randomness) for semantic checks */
function fixedLife(o = {}) {
  const age = o.age ?? 30;
  const year = o.year ?? 2024;
  const iso = o.iso || 'CHN';
  const sex = o.sex || 'male';
  const alive = o.parents !== false;
  return {
    v: 1, id: `fixed-${iso}-${age}-${o.tag || ''}`, seed: 7, rng: [1, 2, 3, 4], createdAt: '2026-10-24T00:00:00Z', mode: 'random', worldSeed: 1, worldLabel: 'test',
    settings: { lifeMinutes: 30, aiMode: 'off', decisionFreq: 'standard', autoChoose: false },
    birth: { mode: 'random', year: year - age, date: `${year - age}-05-01`, time: '08:00:00', country: o.birthIso || iso, sex, urban: o.birthUrban ?? true, familyPct: 0.5, parentsEdu: 'secondary', siblings: 1, motherAge: 28, fatherAge: 30, name: '测试', notes: [] },
    year, age,
    person: {
      name: '测试', sex, country: iso, urban: o.urban ?? true, familyPct: o.familyPct ?? 0.5,
      education: { level: o.edu || (age >= 22 ? 'tertiary' : 'secondary'), inSchool: !!o.inSchool, field: null, years: Math.min(age, 16), exams: [] },
      career: { status: o.status || (age >= 65 ? 'retired' : age >= 22 ? 'employed' : 'student'), title: age >= 22 ? '职员' : null, sector: age >= 22 ? '金融商业' : null, incomePct: 0.5, years: Math.max(0, age - 22), employer: null },
      relationship: o.rel || (age >= 26 ? { status: 'married', partner: { name: '王芳', sinceYear: year - 3 } } : { status: 'single', partner: null }),
      children: o.kids || [],
      parents: { mother: { age: age + 28, alive }, father: { age: age + 30, alive } }, siblings: 1,
      money: { cash: o.cash ?? 20000, debt: 0, income: age >= 22 && age < 65 ? 15000 : 0, portfolio: { stocks: 0, bonds: 0, gold: 0, property: 0, crypto: 0 } },
      conditions: o.conditions || [], flags: { ...(o.flags || {}) },
    },
    stats: { health: 70, happiness: 55, knowledge: 60, relationships: 60, wealth: 50 },
    history: [], log: [], decisions: [], threads: [], hazardMods: [], pending: null, dead: null, cohort: [], aiNotes: { birthStory: null, lastSummary: null },
  };
}
const CUSTOM = { id: 'custom', kind: 'custom', title: '主动选择', situation: '', options: [], allowCustom: true, source: 'local' };
const doFree = (s, text, seed = 5, w = WORLDS[0]) => resolveOffline(data, w, s, CUSTOM, { customText: text }, new Rng(seed));

describe('free-text actions (classifyIntent + resolveOffline)', () => {
  // [player text, expected top intent (null: nothing recognised), expected destination]
  const FREE = [
    // work and study
    ['我想继续读书，考研究生', 'study'], ['大学毕业了，我想考研', 'grad'], ['我不想上班了', 'quit_job'], ['我想换个工作', 'job_hunt'], ['我要跳槽到大公司', 'job_hunt'],
    ['我想转行', 'career_change'], ['找老板要加薪', 'promotion'], ['我要考公务员', 'civil_service'], ['开一家咖啡馆', 'start_business'],
    ['回老家开个小饭馆', 'start_business'], ['我想和朋友合伙开个奶茶店', 'start_business'], ['在网上卖东西', 'side_hustle'],
    ['做自媒体博主', 'side_hustle'], ['我想送外卖', 'gig'], ['我想当一名医生', 'medicine'], ['我想做一名老师', 'teach'],
    ['学英语准备雅思', 'learn_language'], ['我想学吉他', 'learn_hobby'], ['学做蛋糕', 'learn_hobby'], ['写一本小说', 'writer'],
    ['组个乐队', 'musician'], ['去打职业电竞', 'athlete'], ['努力学习考上好大学', 'study'],
    // love, family, friends
    ['我想谈恋爱', 'date'], ['给喜欢的人表白', 'date'], ['向她求婚', 'marry'], ['我们分手吧', 'breakup'], ['我想要二胎', 'have_child'],
    ['领养一只狗', 'pet'], ['我想养一只猫', 'pet'], ['辅导孩子写作业', 'family_time'], ['陪孩子多玩玩', 'family_time'],
    ['回国照顾父母', 'care_parents'], ['跟老同学聚一聚', 'reunion'], ['存钱给孩子上大学', 'save'],
    // health and mind
    ['去健身房锻炼', 'exercise'], ['每天早睡早起', 'sleep'], ['少熬夜', 'sleep'], ['我要减肥', 'diet'], ['戒掉手机', 'screen'], ['考驾照', 'learn_hobby'],
    ['我想跳楼', 'crisis'], ['跳楼价甩卖库存', null], ['生意撑不下去了，想关店', null], ['想给妈妈过生日', 'care_parents'],
    ['最近压力很大，睡不着', 'therapy'], ['我觉得活着没意思', 'crisis'], ['我好累，想休息一年', 'rest'],
    // money
    ['把钱存起来', 'save'], ['还清信用卡', 'save'], ['买辆车', 'spend'], ['买彩票', 'gamble'],
    // meaning and the rest
    ['信基督教', 'faith'], ['去寺庙出家', 'faith'], ['竞选村长', 'activism'], ['去养老院做义工', 'volunteer'], ['去非洲做志愿者', 'volunteer'],
    ['我想偷东西', 'illegal'], ['随便吧', 'stay'], ['做好本职工作', 'stay'], ['飞去火星', 'space'], ['我想长生不老', 'longevity'],
    // negations
    ['我不想出国', 'stay'], ['我不想生孩子', 'childfree'], ['我不打算要孩子', 'childfree'], ['我不想离婚，想好好过日子', 'reconcile'],
    ['我不再炒股了', 'save'], ['别抽烟了', 'quit_smoking'], ['我不去当兵', 'avoid_military'], ['不要去打仗', 'avoid_military'],
    ['我不想买房，继续租房', 'rent'], ['我不想读研了，直接工作', 'drop_out'], ['我放弃考研了', 'drop_out'], ['我不太想结婚', 'stay_single'],
    ['我不想开店了', 'stay'], ['我不想养狗', 'stay'], ['别再赌博了', 'save'],
    // not negations
    ['没钱也要出国', 'emigrate'], ['不管多难我都要创业', 'start_business'], ['我不得不去打工', 'move_city'],
    // destinations
    ['我想去美国读博士', 'grad', ['USA']], ['去德国当护士', 'nursing', ['DEU']], ['移民澳大利亚', 'emigrate', ['AUS']],
    ['我想去新加坡工作', 'emigrate', ['SGP']], ['去深圳找工作', 'job_hunt', ['CHN', '深圳']], ['我想搬到成都去生活', 'move_city', ['CHN', '成都']],
    ['去海南定居', 'move_city', ['CHN', '海南']], ['我想去西藏支教', 'teach', ['CHN', '西藏']], ['去日本旅游', 'travel', ['JPN']],
    ['带孩子去上海迪士尼玩', 'travel', ['CHN', '上海']], ['去澳门赌一把', 'gamble', ['MAC']], ['去中东打工', 'labor_abroad', ['ARE']],
    ['我想去北京看升旗', 'travel', ['CHN', '北京']], ['去日本', 'travel', ['JPN']], ['我想去日本生活', 'emigrate', ['JPN']],
    // nothing to act on
    ['asdfghjkl', null], ['啊啊啊啊', null], ['……', null], ['今天天气不错', null], ['我想变成一只鸟', null],
  ];
  const NOISE = new Set(['asdfghjkl', '啊啊啊啊', '……']);

  test(`${FREE.length} realistic inputs are understood (top intent and destination)`, () => {
    assert.ok(FREE.length >= 60);
    const bad = [];
    for (const [text, want, dest] of FREE) {
      const c = classifyIntent(text, data);
      if ((c.intents[0] || null) !== want) bad.push(`«${text}» -> ${c.intents.join(',') || '(none)'} (want ${want})`);
      if (dest && c.targetCountry !== dest[0]) bad.push(`«${text}» country ${c.targetCountry} (want ${dest[0]})`);
      if (dest && dest[1] && c.targetCity !== dest[1]) bad.push(`«${text}» city ${c.targetCity} (want ${dest[1]})`);
    }
    assert.deepEqual(bad, []);
  });

  test('every input resolves cleanly for very different lives', () => {
    const lives = [
      fixedLife({ iso: 'CHN', age: 30, flags: { city: '北京' } }),
      fixedLife({ iso: 'IND', age: 16, inSchool: true, urban: false, birthUrban: false, edu: 'secondary' }),
      fixedLife({ iso: 'DEU', age: 72, year: 2060, rel: { status: 'widowed', partner: null }, kids: [{ name: '安娜', sex: 'female', birthYear: 2016, alive: true }] }),
      fixedLife({ iso: 'NGA', age: 40, status: 'unemployed', rel: { status: 'single', partner: null } }),
      fixedLife({ iso: 'BRA', age: 9, inSchool: true, edu: 'primary', status: 'child' }),
    ];
    let i = 0;
    for (const s of lives) {
      for (const [text] of FREE) {
        const r = doFree(s, text, i++);
        const where = `${s.person.country}@${s.age} «${text}»`;
        checkResolution(r, s, where);
        if (NOISE.has(text)) {
          assert.equal(r.feasible, false, where);
          assert.ok(r.note, where);
          for (const k of ['health', 'happiness', 'knowledge', 'relationships', 'wealthDelta']) assert.equal(r.effects[k], 0, `${where} ${k}`);
        } else {
          assert.ok(r.narrative.includes(text.slice(0, 6)), `${where}: the player's words are not echoed «${r.narrative}»`);
        }
        if (s.age < 16) assert.equal(r.effects.wealthDelta, 0, `${where}: children's choices never move money`);
      }
    }
  });

  test('resolutions match what the player asked for', () => {
    const adult = () => fixedLife({ iso: 'CHN', age: 30, flags: { city: '北京' } });
    const has = (r, re, msg) => assert.ok(re.test(r.narrative), `${msg}: «${r.narrative}»`);
    const not = (r, re, msg) => assert.ok(!re.test(r.narrative), `${msg}: «${r.narrative}»`);
    // safety first: thoughts of suicide always lead to help and a pointer to real-world support
    for (const t of ['我觉得活着没意思', '我不想活了', '撑不下去了']) {
      const r = doFree(adult(), t);
      has(r, /热线/, t);
      assert.ok(r.set.flags && r.set.flags.soughtHelp, t);
    }
    // a move for work inside the country goes to the named city
    let r = doFree(adult(), '去深圳找工作');
    assert.equal(r.set.flags && r.set.flags.city, '深圳', r.narrative);
    // an employed adult who drops a plan to study does not "leave school"
    r = doFree(adult(), '我不想读研了，直接工作');
    not(r, /离开了学校/, 'drop study plan');
    assert.equal(r.set.career, undefined);
    // pets are not children
    r = doFree(adult(), '领养一只狗');
    assert.ok(r.set.flags && r.set.flags.pet, r.narrative);
    assert.ok(!r.threads.some((t) => t.set && t.set.addChild), 'no child adoption');
    has(r, /狗/, 'dog');
    // wording and the details the player gave
    not(doFree(adult(), '组个乐队'), /认真音乐/, 'grammar');
    has(doFree(adult(), '我想学吉他'), /学吉他/, 'hobby named');
    has(doFree(adult(), '信基督教'), /教堂/, 'church, not temple');
    has(doFree(adult(), '去寺庙出家'), /寺/, 'temple');
    not(doFree(adult(), '买彩票'), /越陷越深/, 'a lottery ticket is not a gambling addiction');
    not(doFree(adult(), '去成都旅游'), /陌生的语言/, 'a domestic trip');
    has(doFree(adult(), '去成都旅游'), /成都/, 'trip destination');
    has(doFree(adult(), '在老家养羊'), /羊/, 'herding, not farming');
    has(doFree(adult(), '我想送外卖'), /外卖/, 'delivery');
    has(doFree(adult(), '我想长生不老'), /抗衰老/, 'longevity');
    r = doFree(fixedLife({ iso: 'CHN', age: 50 }), '去养老院做义工');
    assert.equal(r.set.flags && r.set.flags.careHome, undefined, 'volunteering, not moving into a care home');
    // no conscription in China: refusing to serve is simply a personal choice
    r = doFree(adult(), '我不去当兵');
    assert.equal(r.set.career, undefined);
    // an old person with grown children is not helping with homework
    not(doFree(fixedLife({ iso: 'DEU', age: 85, year: 2070, kids: [{ name: '安娜', sex: 'female', birthYear: 2015, alive: true }] }), '多陪陪家人'), /写作业/, 'old age family time');
    // the impossible and the unintelligible change nothing
    r = doFree(adult(), '我想变成一只鸟');
    assert.equal(r.feasible, false);
    r = doFree(adult(), 'asdfghjkl');
    assert.equal(r.feasible, false);
    assert.ok(r.note.length <= 40, 'note fits the engine line');
  });

  test('nobody is sent to work in a country at war', () => {
    const w = WORLDS[0];
    const atWar = (iso, y) => (w.events(iso, y) || []).some((e) => (e.category === 'war' || e.category === 'conflict') && ((e.effects && e.effects.safety) ?? -2) <= -2 && Array.isArray(e.countries) && e.countries[0] === iso);
    const year = [2022, 2023, 2024, 2025].find((y) => atWar('UKR', y));
    if (!year) return; // this data set has no such war: nothing to check
    for (let i = 0; i < 5; i++) {
      const r = doFree(fixedLife({ iso: 'DEU', age: 30, year, tag: i }), '我想去乌克兰工作', i);
      assert.equal(r.feasible, false, r.narrative);
      assert.equal(r.set.country, undefined);
    }
  });
});

/* ------------------------------------------------------------------ cultural and family consistency of events */

describe('event texts fit the life', () => {
  test('exam names follow the year (renamed and replaced exams)', () => {
    const lp = { key_exams: [{ age: 15, name: '高中入学考试' }, { age: 18, name: '大学入试中心考试', until: 2020 }, { age: 18, name: '大学入学共通测试', from: 2021 }] };
    assert.deepEqual(keyExams(lp, 'JPN', 2010).map((e) => e[1]), ['高中入学考试', '大学入试中心考试']);
    assert.deepEqual(keyExams(lp, 'JPN', 2040).map((e) => e[1]), ['高中入学考试', '大学入学共通测试']);
    assert.equal(keyExams(lp, 'JPN').length, 3, 'without a year the whole list (old callers)');
    const s = fixedLife({ iso: 'JPN', age: 17, year: 2040, inSchool: true, edu: 'secondary', status: 'student' });
    const f = lifeFacts(data, WORLDS[0], s, {});
    const txt = fillText(eventTemplate('tn_exam_stress').text, s, {}, new Rng(1), null, f);
    assert.ok(!/中心考试/.test(txt), txt);
  });

  test('lives without living parents are not told about their parents', () => {
    const r = new Rng(91);
    // remembered parents and other people's mothers are fine
    const allow = new Set(['e_dream_parents', 'w_refugee_neighbors', 'm_grandchild', 'y_sibling_wedding', 'w_hook_history', 'w_hook_future']);
    let n = 0;
    for (let i = 0; i < 220; i++) {
      const s = makeLife(r, r.int(15, 88));
      s.person.parents = { mother: { age: s.age + 30, alive: false }, father: { age: s.age + 32, alive: false } };
      const w = WORLDS[i % WORLDS.length];
      for (let k = 0; k < 4; k++) {
        const evs = pickPersonalEvents(data, w, s, ctxFor(w, s.person.country, s.year), new Rng(i * 31 + k));
        for (const e of evs) {
          n++;
          if (!allow.has(e.id)) assert.ok(!/父亲|母亲|父母|爸妈/.test(e.text), `${e.id} @${s.age}: «${e.text}»`);
        }
        s.year += 1;
        s.age += 1;
      }
    }
    assert.ok(n > 300, `only ${n} events`);
  });

  test('China-only customs and words stay with Chinese lives', () => {
    const r = new Rng(93);
    const CN_ONLY = /普通话|封控|户口|春运|高考|中考|份子钱|奥数|县城|核酸|抢菜|双减|躺平|大小周|春联|老破小|广场上跳舞|考研|月饼|抓周/;
    const non = isoList.filter((iso) => !['CHN', 'TWN', 'HKG', 'MAC', 'SGP'].includes(iso));
    let n = 0;
    for (let i = 0; i < 300; i++) {
      const s = makeLife(r, r.int(0, 85), { iso: r.pick(non) });
      const w = WORLDS[i % WORLDS.length];
      const evs = pickPersonalEvents(data, w, s, ctxFor(w, s.person.country, s.year), new Rng(i));
      for (const e of evs) {
        n++;
        if (e.id.startsWith('w_hook')) continue; // research hooks quote real events as written
        assert.ok(!CN_ONLY.test(e.text), `${e.id} in ${s.person.country}: «${e.text}»`);
      }
    }
    assert.ok(n > 200, `only ${n} events`);
  });

  test('decisions and their outcomes for non-Chinese lives use no China-only words', () => {
    const r = new Rng(95);
    const CN_ONLY = /普通话|封控|户口|春运|高考|中考|份子钱|奥数|县城|过年|二舅|妇女主任|城中村|打工子弟|咸菜/;
    const ENGLISH = new Set(['USA', 'GBR', 'CAN', 'AUS', 'NZL', 'IRL']);
    const non = isoList.filter((iso) => !['CHN', 'TWN', 'HKG', 'MAC', 'SGP'].includes(iso));
    let n = 0;
    for (let i = 0; i < 90; i++) {
      for (const age of DECISION_AGES) {
        const iso = i % 9 === 0 ? r.pick([...ENGLISH]) : r.pick(non);
        const s = makeLife(r, age, { iso });
        const w = WORLDS[i % WORLDS.length];
        const d = buildDecisionOffline(data, w, s, ctxFor(w, iso, s.year), new Rng(i * 100 + age));
        const txt = [d.title, d.situation, ...d.options.flatMap((o) => [o.label, o.detail])].join(' ');
        assert.ok(!CN_ONLY.test(txt), `${d.context.key} in ${iso}: «${txt}»`);
        if (ENGLISH.has(iso)) assert.ok(!/学英语/.test(txt), `${d.context.key} in ${iso}: «${txt}»`);
        for (const o of d.options) {
          const res = resolveOffline(data, w, s, d, { optionId: o.id }, new Rng(n++));
          const all = [res.narrative, ...res.threads.map((t) => t.text)].join(' ');
          assert.ok(!CN_ONLY.test(all), `${d.context.key}/${o.label} in ${iso}: «${all}»`);
        }
      }
    }
    assert.ok(n > 1000);
  });

  test('homemakers, displaced people, the chronically ill and the retired have stories of their own', () => {
    const facts = (s) => lifeFacts(data, WORLDS[0], s, {});
    const kid = { name: '小雨', sex: 'female', birthYear: 2016, alive: true };
    assert.ok(eventTemplate('a_homemaker_day').cond(facts(fixedLife({ age: 34, status: 'homemaker', kids: [kid] }))));
    assert.ok(eventTemplate('a_displaced_camp').cond(facts(fixedLife({ age: 30, flags: { displaced: 2022 } }))));
    assert.ok(eventTemplate('m_diabetes_life').cond(facts(fixedLife({ age: 55, conditions: [{ id: 'diabetes', name: '糖尿病', sinceYear: 2020, severity: 1 }] }))));
    assert.ok(eventTemplate('s_retired_hobby').cond(facts(fixedLife({ age: 66, status: 'retired' }))));
    assert.ok(eventTemplate('a_single_parent').cond(facts(fixedLife({ age: 35, rel: { status: 'divorced', partner: null }, kids: [kid] }))));
    // over a few years they actually come up
    let seen = 0;
    for (let i = 0; i < 30; i++) {
      const s = fixedLife({ age: 34, status: 'homemaker', kids: [kid], tag: i });
      for (let y = 0; y < 6; y++) {
        if (pickPersonalEvents(data, WORLDS[i % WORLDS.length], s, {}, new Rng(i * 7 + y)).some((e) => e.id.startsWith('a_homemaker'))) seen++;
        s.year += 1;
        s.age += 1;
      }
    }
    assert.ok(seen >= 10, `homemaker stories ${seen}`);
  });
});

/* ------------------------------------------------------------------ war at home, timing, occupation, retirement, names */

let countryContext = null;
try { ({ countryContext } = await import('../src/core/engine.js')); } catch { countryContext = null; }

const WAR_HOME = ['inf_war', 'ch_war_school', 'ch_war_flee', 'tn_war_shelter', 'a_war_job', 'a_war_flee', 'w_war_home', 'w_war_endure', 's_war'];
const FARM = ['ch_field_help', 'tn_harvest', 'a_harvest_good', 'a_harvest_bad', 'a_livestock', 'a_seed_loan', 'a_monsoon_crop', 'a_locust', 'a_drought_farm', 'a_farm_phone', 'a_rice_transplant', 'a_coffee_harvest', 'r_spring_planting', 'r_pastoral'];
const cond = (id, s, ctx = {}, w = WORLDS[0]) => !!eventTemplate(id).cond(lifeFacts(data, w, s, ctx));
const insurgency = (over = {}) => ({ id: 'test_insurgency', source: 'history', year: 2010, endYear: 2030, title: '北部武装叛乱', summary: '', category: 'conflict', importance: 4, scope: 'countries', countries: ['NGA'], effects: { safety: -3, economy: -1 }, migration_push: 1, personal_hooks: [], projection: false, ...over });

describe('war at home is nationwide only at conflict level 3', () => {
  test('a regional conflict reaches about a sixth of the lives, deterministically; the rest hear of it', () => {
    const ctx = { iso3: 'NGA', year: 2015, region: 'SSA', events: [insurgency()], conflict: 2 };
    const later = { ...ctx, year: 2016, events: [insurgency(), insurgency({ id: 'test_banditry', year: 2016, title: '西北部匪患', importance: 3, effects: { safety: -2 } })] };
    let zone = 0;
    let zoneLater = 0;
    const N = 1500;
    for (let i = 0; i < N; i++) {
      const s = fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: `z${i}` });
      const f = lifeFacts(data, WORLDS[0], s, ctx);
      assert.equal(lifeFacts(data, WORLDS[0], fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: `z${i}` }), ctx).war, f.war, 'the same life draws the same');
      if (f.war) {
        zone++;
        assert.ok(f.warZone && !f.warNation && !f.warNear);
      } else {
        assert.ok(f.warNear && f.warElsewhere, 'outside the war zone the conflict is news, mobilisation and refugees');
        assert.ok(!cond('w_war_home', s, ctx) && !cond('w_war_endure', s, ctx) && !cond('a_war_job', s, ctx));
      }
      // a newer conflict elsewhere never takes a life out of the war zone it already lives in
      s.year = 2016;
      s.age = 31;
      const g = lifeFacts(data, WORLDS[0], s, later);
      if (f.war) assert.ok(g.war, 'still in the war zone a year later');
      if (g.war) zoneLater++;
    }
    assert.ok(zone >= 0.1 * N && zone <= 0.25 * N, `in the war zone ${zone}/${N}`);
    assert.ok(zoneLater <= 0.26 * N && zoneLater >= zone, `two conflicts ${zoneLater}/${N}`);
    // the stories follow: a life outside the zone is told of the war elsewhere in the country
    let k = 0;
    let out = fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: 'out0' });
    while (lifeFacts(data, WORLDS[0], out, ctx).war && k < 50) out = fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: `out${++k}` });
    const txt = eventTemplate('w_war_near').textFn(lifeFacts(data, WORLDS[0], out, ctx));
    assert.match(txt, /国内/);
  });

  test('conflict level 3 puts every life at war; a context without a level falls back to the event itself', () => {
    const big = insurgency({ id: 'test_war', importance: 5, title: '全面战争' });
    for (let i = 0; i < 200; i++) {
      const s = fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: `n${i}` });
      const f = lifeFacts(data, WORLDS[0], s, { iso3: 'NGA', year: 2015, events: [big], conflict: 3 });
      assert.ok(f.war && f.warNation);
      assert.ok(lifeFacts(data, WORLDS[0], s, { iso3: 'NGA', year: 2015, events: [big] }).warNation, 'importance 5 without a level');
      assert.ok(!lifeFacts(data, WORLDS[0], s, { iso3: 'NGA', year: 2015, events: [insurgency()] }).warNation, 'importance 4 without a level');
    }
  });

  test('picked events: war-at-home stories for few lives in a regional conflict, for most in a nationwide war', () => {
    let regional = 0;
    let national = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      const s = fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: `p${i}` });
      const evs = pickPersonalEvents(data, WORLDS[0], s, { iso3: 'NGA', year: 2015, region: 'SSA', events: [insurgency()], conflict: 2 }, new Rng(i));
      if (evs.some((e) => WAR_HOME.includes(e.id))) regional++;
      const t = fixedLife({ iso: 'NGA', age: 30, year: 2015, tag: `q${i}` });
      const evt = pickPersonalEvents(data, WORLDS[0], t, { iso3: 'NGA', year: 2015, region: 'SSA', events: [insurgency({ importance: 5 })], conflict: 3 }, new Rng(i));
      if (evt.some((e) => WAR_HOME.includes(e.id))) national++;
    }
    assert.ok(regional <= 0.25 * N, `regional conflict: war-at-home stories in ${regional}/${N} lives`);
    assert.ok(national >= 0.5 * N, `nationwide war: war-at-home stories in ${national}/${N} lives`);
  });

  test('real history: Nigeria 2009-26 and Ukraine 2014-21 are regional, Ukraine from 2022 nationwide', () => {
    if (!countryContext) return;
    const w = WORLDS[0];
    const share = (iso, year) => {
      const ctx = countryContext(data, w, iso, year);
      let n = 0;
      for (let i = 0; i < 600; i++) if (lifeFacts(data, w, fixedLife({ iso, age: 35, year, tag: `r${i}` }), ctx).war) n++;
      return { conflict: ctx.conflict, share: n / 600 };
    };
    for (const [iso, year] of [['NGA', 2012], ['NGA', 2015], ['NGA', 2021], ['UKR', 2015], ['UKR', 2019]]) {
      const r = share(iso, year);
      if (r.conflict >= 3) continue; // a different data set may rate it nationwide
      assert.ok(r.share <= 0.27, `${iso} ${year}: ${Math.round(r.share * 100)}% at war at home`);
    }
    const u = share('UKR', 2023);
    if (u.conflict >= 3) assert.equal(u.share, 1);
  });
});

describe('stories come at the right time', () => {
  test('wedding photos and "years of trying" wait for the years to pass (tracked from the wedding)', () => {
    const s = fixedLife({ age: 29, year: 2030, rel: { status: 'single', partner: null }, tag: 'wed' });
    pickPersonalEvents(data, WORLDS[0], s, {}, new Rng(1));
    s.year = 2031;
    s.age = 30;
    s.person.relationship = { status: 'married', partner: { name: '李娜', sinceYear: 2027 } };
    s.person.flags.firstUnion = 2031;
    for (let y = 2031; y <= 2037; y++) {
      s.year = y;
      s.age = y - 2001;
      pickPersonalEvents(data, WORLDS[0], s, {}, new Rng(y));
      assert.equal(s.person.flags['rel:wed'], 2031, 'wedding year noted');
      assert.equal(cond('a_wedding_photo', s), y - 2031 >= 5, `wedding photo in ${y}`);
      assert.equal(cond('a_infertility', s), y - 2031 >= 3, `infertility in ${y}`);
    }
    // a child who died still counts as a child: "no child ever came" would be wrong
    s.person.children = [{ name: '小禾', sex: 'female', birthYear: 2032, alive: false }];
    assert.ok(!cond('a_infertility', s));
    // a remarriage starts the count again
    s.person.relationship = { status: 'married', partner: { name: '周敏', sinceYear: 2036 } };
    pickPersonalEvents(data, WORLDS[0], s, {}, new Rng(9));
    assert.equal(s.person.flags['rel:wed'], 2037);
    assert.ok(!cond('a_wedding_photo', s));
  });

  test('no layoff in the first year of a job; no rider story for a rider', () => {
    const covid = { id: 'covid19_pandemic', source: 'history', year: 2020, endYear: 2022, title: '新冠肺炎大流行', summary: 'COVID-19', category: 'epidemic', importance: 5, scope: 'global', countries: [], effects: { health: -3 }, personal_hooks: [], projection: false };
    const s = fixedLife({ iso: 'USA', age: 35, year: 2020, tag: 'job' });
    s.person.career.since = 2020;
    assert.ok(!cond('a_layoff', s, { year: 2020, events: [covid] }), 'job started this year');
    s.person.career.since = 2017;
    assert.ok(cond('a_layoff', s, { year: 2020, events: [covid] }));
    const r = fixedLife({ iso: 'CHN', age: 25, year: 2024, tag: 'rider' });
    r.person.career = { status: 'employed', title: '外卖骑手', sector: '平台服务', incomePct: 0.2, years: 3, since: 2021, employer: null };
    assert.ok(!cond('y_delivery', r));
    r.person.career = { status: 'employed', title: '工厂工人', sector: '制造业', incomePct: 0.2, years: 3, since: 2021, employer: null };
    assert.ok(cond('y_delivery', r));
    assert.doesNotMatch(eventTemplate('y_delivery').textFn(lifeFacts(data, WORLDS[0], r, {})), /^你注册成为/);
  });

  test('online classes and lockdowns only with a pandemic or a school-closing epidemic', () => {
    const kid = (year, iso = 'ZAF') => fixedLife({ iso, age: 10, year, inSchool: true, edu: 'primary', tag: `k${year}` });
    const avian = { id: 'h5n1_avian_flu_2004', year: 2004, endYear: 2006, title: 'H5N1禽流感扩散', summary: '世卫组织担心演变为大流行', category: 'epidemic', importance: 2, scope: 'regions', countries: ['IDN'], effects: { health: 0 } };
    const art = { id: 'zaf_art_rollout_2004', year: 2004, endYear: 2019, title: '南非公立医疗系统推行抗逆转录病毒治疗', summary: '', category: 'epidemic', importance: 5, scope: 'countries', countries: ['ZAF'], effects: { health: 3 } };
    const shock = { id: 'shock-pandemic_covid_scale-2031', refId: 'pandemic_covid_scale', year: 2031, endYear: 2032, title: '新的全球大流行（新冠级别）', summary: '', category: 'epidemic', importance: 3, scope: 'global', countries: [], effects: { health: -2 }, projection: true };
    for (const id of ['ch_online_class', 'ch_no_internet_lockdown']) {
      assert.ok(!cond(id, kid(2006), { year: 2006, events: [avian, art] }) && !cond(id, kid(2006, 'IDN'), { year: 2006, events: [avian] }), `${id} in 2006`);
      assert.ok(!cond(id, kid(2031), { year: 2031, events: [art] }), `${id} without an outbreak`);
    }
    assert.ok(cond('ch_online_class', kid(2031, 'USA'), { year: 2031, events: [shock] }) || cond('ch_no_internet_lockdown', kid(2031, 'USA'), { year: 2031, events: [shock] }));
    assert.ok(!cond('s_pandemic', fixedLife({ iso: 'ZAF', age: 70, year: 2006 }), { year: 2006, events: [art] }), 'a treatment roll-out is no pandemic');
    // with the real world lines: no lockdown story outside COVID unless a pandemic or Ebola-type event is active
    for (const w of WORLDS) {
      for (const iso of ['ZAF', 'IDN', 'CHN', 'NGA', 'KEN', 'USA', 'IND', 'BRA']) {
        for (let year = 2000; year <= 2090; year += 1) {
          if (year >= 2020 && year <= 2022) continue;
          const f = lifeFacts(data, w, kid(year, iso), {});
          if (f.lockdown) assert.ok(f.events.some((e) => /pandemic_covid|pandemic_severe|大流行（|埃博拉|ebola/i.test(`${e.id} ${e.refId || ''} ${e.title}`)), `${iso} ${year} lockdown without a pandemic`);
        }
      }
    }
  });

  test('widowhood: grief first, a new love only later, never both in one year', () => {
    assert.ok(eventTemplate('s_widow_grief').groups.includes('courtship'));
    assert.ok(eventTemplate('m_late_love').groups.includes('courtship') && eventTemplate('s_late_companion').groups.includes('courtship'));
    const s = fixedLife({ iso: 'DEU', sex: 'female', age: 62, year: 2040, rel: { status: 'married', partner: { name: '托马斯', sinceYear: 2005 } }, tag: 'widow' });
    pickPersonalEvents(data, WORLDS[0], s, {}, new Rng(1));
    s.year = 2041;
    s.age = 63;
    s.person.relationship = { status: 'widowed', partner: null };
    s.person.pastPartners = ['托马斯'];
    pickPersonalEvents(data, WORLDS[0], s, {}, new Rng(2));
    assert.equal(s.person.flags['rel:widow'], 2041);
    assert.ok(cond('s_widow_grief', s) && !cond('m_late_love', s) && !cond('s_late_companion', s), 'the year the spouse died');
    s.year = 2043;
    s.age = 65;
    assert.ok(cond('m_late_love', s) && cond('s_widow_grief', s));
    for (const k of Object.keys(s.person.flags)) if (k.startsWith('ev:')) delete s.person.flags[k];
    let grief = 0;
    let love = 0;
    for (let i = 0; i < 400; i++) {
      const t = JSON.parse(JSON.stringify(s));
      const ids = pickPersonalEvents(data, WORLDS[i % WORLDS.length], t, {}, new Rng(500 + i)).map((e) => e.id);
      if (ids.includes('s_widow_grief')) grief++;
      if (ids.includes('m_late_love')) love++;
      assert.ok(!(ids.includes('s_widow_grief') && ids.some((x) => ['m_late_love', 's_late_companion'].includes(x))), ids.join(','));
    }
    assert.ok(grief > 0 && love > 0, `grief ${grief}, new love ${love}`);
    s.year = 2045;
    s.age = 67;
    assert.ok(!cond('s_widow_grief', s), 'grief stories belong to the first years');
    // once a new courtship has begun there is no grief story
    s.person.relationship = { status: 'dating', partner: { name: '马库斯', sinceYear: 2045 } };
    s.year = 2042;
    assert.ok(!cond('s_widow_grief', s));
  });
});

describe('stories fit the stage of life and the work', () => {
  test('farm stories only for farmers and children of farming households', () => {
    const facts = (o) => lifeFacts(data, WORLDS[0], fixedLife(o), {});
    const rural = { urban: false, birthUrban: false, familyPct: 0.12 };
    const student = fixedLife({ iso: 'IND', age: 20, year: 2024, ...rural, inSchool: true, edu: 'secondary', status: 'student', tag: 's' });
    assert.ok(!lifeFacts(data, WORLDS[0], student, {}).farmer);
    const barber = fixedLife({ iso: 'NGA', age: 33, year: 2024, ...rural, tag: 'b' });
    barber.person.career = { status: 'employed', title: '美容美发技师', sector: '服务业', incomePct: 0.3, years: 8, since: 2018, employer: null };
    assert.ok(!lifeFacts(data, WORLDS[0], barber, {}).farmer);
    const farmerLife = fixedLife({ iso: 'VNM', age: 40, year: 2024, ...rural, tag: 'f' });
    farmerLife.person.career = { status: 'self_employed', title: '农民', sector: '农业', incomePct: 0.2, years: 20, since: 2004, employer: null };
    assert.ok(lifeFacts(data, WORLDS[0], farmerLife, {}).farmer && cond('r_spring_planting', farmerLife));
    assert.ok(facts({ iso: 'ETH', age: 45, year: 2024, ...rural, status: 'unemployed', flags: { farmer: true } }).farmer, 'a rural adult who chose farming');
    assert.ok(!facts({ iso: 'ETH', age: 45, year: 2024, ...rural, status: 'unemployed' }).farmer, 'rural, poor, but no farming in this life');
    assert.ok(!facts({ iso: 'ETH', age: 45, year: 2024, urban: true, status: 'unemployed', flags: { farmer: true } }).farmer, 'moved to the city');
    assert.ok(facts({ iso: 'ETH', age: 9, year: 2024, ...rural, inSchool: true, edu: 'primary' }).farmKid);
    // over several years, rural students and hairdressers never get a farm story
    let n = 0;
    for (let i = 0; i < 120; i++) {
      const iso = ['IND', 'NGA', 'VNM', 'ETH', 'IDN', 'BGD'][i % 6];
      const s = i % 2 ? fixedLife({ iso, age: 19, year: 2015, ...rural, inSchool: true, edu: 'secondary', status: 'student', tag: `st${i}` })
        : fixedLife({ iso, age: 30, year: 2015, ...rural, tag: `hd${i}` });
      if (!(i % 2)) s.person.career = { status: 'employed', title: '美容美发技师', sector: '服务业', incomePct: 0.3, years: 8, since: 2010, employer: null };
      for (let y = 0; y < 5; y++) {
        for (const e of pickPersonalEvents(data, WORLDS[i % WORLDS.length], s, {}, new Rng(i * 13 + y))) {
          n++;
          assert.ok(!FARM.includes(e.id), `${e.id} for a ${s.person.career.title || '学生'} in ${iso}: «${e.text}»`);
        }
        s.year += 1;
        s.age += 1;
      }
    }
    assert.ok(n > 300, `only ${n} events`);
  });

  test('kindergarten only before school starts and before any schooling', () => {
    assert.ok(cond('ch_kindergarten', fixedLife({ iso: 'USA', age: 4, year: 2030, edu: 'none', tag: 'kg1' })));
    assert.ok(!cond('ch_kindergarten', fixedLife({ iso: 'USA', age: 4, year: 2030, edu: 'primary', inSchool: true, tag: 'kg2' })));
    assert.ok(!cond('ch_kindergarten', fixedLife({ iso: 'USA', age: 4, year: 2030, edu: 'preschool', inSchool: true, tag: 'kg3' })));
    const gbr = fixedLife({ iso: 'GBR', age: 5, year: 2030, edu: 'none', tag: 'kg4' });
    if (lifeFacts(data, WORLDS[0], gbr, {}).schoolStart <= 5) assert.ok(!cond('ch_kindergarten', gbr), 'school starts at 5 in Britain');
  });

  test('a quiet year reads like the life it belongs to', () => {
    const first = (s) => eventTemplate('g_quiet_year').textFn(lifeFacts(data, WORLDS[0], s, {}))[0];
    const mk = (status, title, extra = {}) => {
      const s = fixedLife({ iso: 'DEU', age: 40, year: 2030, status, tag: `q${status}`, ...extra });
      s.person.career.title = title;
      return s;
    };
    assert.match(first(mk('employed', '职员')), /上班/);
    for (const [status, re] of [['unemployed', /打听活计/], ['homemaker', /照顾一家老小/], ['self_employed', /开张/], ['retired', /散步/], ['unable', /吃药/]]) {
      const t = first(mk(status, status === 'self_employed' ? '店主' : null, status === 'retired' ? { age: 70 } : {}));
      assert.match(t, re, `${status}: ${t}`);
      assert.doesNotMatch(t, /上班/, `${status}: ${t}`);
    }
  });
});

describe('retirement and partners', () => {
  test('retirement stories key on the year and the job the person retired from', () => {
    const r = (flags, iso = 'DEU', age = 66) => fixedLife({ iso, age, year: 2040, status: 'retired', flags, tag: JSON.stringify(flags) });
    assert.ok(!cond('s_retire_day', r({}, 'DEU', 85)), 'no retirement day without the engine bookkeeping');
    assert.ok(cond('s_retire_day', r({ retiredYear: 2040, retiredFrom: 'employed' })));
    assert.ok(!cond('s_retire_day', r({ retiredYear: 2040, retiredFrom: 'self_employed' })), 'no colleagues to throw a party');
    assert.ok(!cond('s_retire_day', r({ retiredYear: 2034, retiredFrom: 'employed' })), 'years later');
    assert.ok(cond('s_pension', r({ retiredYear: 2039, retiredFrom: 'employed' })));
    assert.ok(!cond('s_pension', r({ retiredYear: 2033, retiredFrom: 'employed' })), 'the first pension comes right after retiring');
    assert.ok(!cond('s_pension', r({ retiredYear: 2040, retiredFrom: 'homemaker' })));
    assert.ok(!cond('s_pension', r({})));
  });

  test('a new partner never has the name of a former one', () => {
    const s = fixedLife({ iso: 'USA', sex: 'female', age: 55, year: 2040, rel: { status: 'widowed', partner: null }, flags: { 'rel:widow': 2034 }, tag: 'names' });
    s.person.pastPartners = ['詹姆斯'];
    const f = lifeFacts(data, WORLDS[0], s, {});
    for (let i = 0; i < 400; i++) {
      const nm = newPartnerName(f, new Rng(i));
      assert.ok(nm && nm !== '詹姆斯', nm);
    }
    // every name taken: the courtship stories are skipped instead of repeating one
    const names = data.content && data.content.names && data.content.names.countries && data.content.names.countries.USA;
    if (names && Array.isArray(names.male)) {
      s.person.pastPartners = names.male.slice();
      assert.equal(newPartnerName(lifeFacts(data, WORLDS[0], s, {}), new Rng(1)), null);
      for (let i = 0; i < 200; i++) {
        const t = JSON.parse(JSON.stringify(s));
        for (const e of pickPersonalEvents(data, WORLDS[i % WORLDS.length], t, {}, new Rng(i))) assert.ok(!['m_late_love', 'y_dating_app', 's_late_companion'].includes(e.id), e.text);
      }
    }
    // the picked story and its relationship patch use the fresh name
    const y = fixedLife({ iso: 'USA', sex: 'female', age: 24, year: 2030, rel: { status: 'single', partner: null }, tag: 'meet' });
    y.person.pastPartners = ['詹姆斯', '迈克尔'];
    let met = 0;
    for (let i = 0; i < 300 && met < 20; i++) {
      const t = JSON.parse(JSON.stringify(y));
      for (const e of pickPersonalEvents(data, WORLDS[i % WORLDS.length], t, {}, new Rng(i))) {
        if (e.id !== 'y_meet' && e.id !== 'y_dating_app') continue;
        met++;
        assert.ok(!/詹姆斯|迈克尔/.test(e.text), e.text);
        assert.ok(!['詹姆斯', '迈克尔'].includes(e.set.relationship.partner.name));
      }
    }
    assert.ok(met > 0, 'no courtship story came up');
  });
});
