// Tests for src/core/data.js and src/core/world.js, using the real data files from disk.
// Run: node --test tests/data_world.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadData, makeDataStore, decodeBase64, decodeUint16LE } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { Rng } from '../src/core/rng.js';
import { HISTORY_END } from '../src/core/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const COUNTRIES = readJson('data/countries.json');
const MORTALITY = readJson('data/mortality.json');
let REAL_CONTENT = null;
try { REAL_CONTENT = readJson('data/content.json'); } catch { REAL_CONTENT = null; }

const data = makeDataStore({ countries: COUNTRIES, mortality: MORTALITY, content: REAL_CONTENT });

const BIG10 = ['CHN', 'IND', 'USA', 'IDN', 'PAK', 'NGA', 'BRA', 'BGD', 'RUS', 'MEX'];

// Synthetic content exercising every world feature regardless of how far the research files are.
const SYN_CONTENT = {
  history: [
    { id: 'gfc_2008', year: 2008, end_year: 2009, scope: 'global', countries: ['USA', 'GBR'], category: 'economy',
      title: '全球金融危机', summary: '美国次贷危机演变为全球金融危机。', effects: { economy: -3, happiness: -1 }, importance: 5 },
    { id: 'quake_2008', year: 2008, scope: 'countries', countries: ['CHN'], category: 'disaster', title: '汶川地震',
      importance: 4, mortality: { mult: 1.01, ages: [0, 120] } },
    { id: 'unrest_2011', year: 2011, end_year: 2012, scope: 'regions', regions: ['NAF', 'WAS'], category: 'politics',
      title: '中东北非局势动荡', importance: 4 },
    { id: 'minor_2008', year: 2008, scope: 'countries', countries: ['ISL'], category: 'economy', title: '冰岛银行危机', importance: 3 },
    { id: 'covid_2020', year: 2020, end_year: 2022, scope: 'global', category: 'epidemic', title: '新冠疫情', importance: 5 },
    { id: 'bad_future', year: 2030, scope: 'global', category: 'society', title: '不应出现的历史条目', importance: 5 },
  ],
  future: {
    baseline_assumptions: [{ domain: 'demography', statement: '基于 UN WPP 2024 中方案。' }],
    dimensions: [
      { id: 'ai', title: '人工智能走向', branches: [
        { id: 'ai_slow', title: '缓慢渗透', prob: 0.3, modifiers: { gdp_growth_add: 0.2 } },
        { id: 'ai_gradual', title: '渐进普及', prob: 0.5,
          modifiers: { gdp_growth_add: 0.5, unemployment_add: 1, inequality_add: 0.03, internet_ceiling: 90 } },
        { id: 'ai_transformative', title: '颠覆式变革', prob: 0.2,
          modifiers: { gdp_growth_add: 1.5, life_exp_add_by_2090: 4, unemployment_add: 3, retirement_age_add: 2 },
          region_overrides: { SSA: { gdp_growth_add: 0.5 } } },
      ] },
      { id: 'climate', title: '气候变化', branches: [
        { id: 'c_low', title: '温和升温', prob: 0.25, modifiers: { heat_risk: 1 } },
        { id: 'c_mid', title: '中等升温', prob: 0.5, modifiers: { heat_risk: 2, sea_level_risk: 1, mortality_mult: 1.02 } },
        { id: 'c_high', title: '严重升温', prob: 0.25,
          modifiers: { heat_risk: 3, sea_level_risk: 2, mortality_mult: 1.06, gdp_growth_add: -0.4 } },
      ] },
      { id: 'geo', title: '地缘格局', branches: [
        { id: 'g_calm', title: '总体缓和', prob: 0.6, modifiers: {} },
        { id: 'g_tense', title: '持续紧张', prob: 0.4, modifiers: { conflict_risk_add: 0.02 },
          region_overrides: { WAS: { conflict_risk_add: 0.06 } } },
      ] },
    ],
    milestones: [
      { id: 'agi', year: 2035, year_range: [2030, 2045], requires: { ai: ['ai_transformative'] }, scope: 'global',
        category: 'technology', title: '通用人工智能出现', prob: 0.9, importance: 5 },
      { id: 'malaria', year: 2040, year_range: [2035, 2050], scope: 'regions', regions: ['SSA'], category: 'health',
        title: '疟疾基本消除', prob: 0.6, mortality: { mult: 0.9, ages: [0, 5] }, importance: 4 },
      { id: 'mars', year: 2060, scope: 'global', category: 'science', title: '载人登陆火星', prob: 0.5, importance: 3 },
    ],
    random_shocks: [
      { id: 'pandemic', title: '新的大流行', annual_prob: 0.03, scope: 'global', category: 'epidemic',
        mortality: { mult: 1.2, ages: [60, 120] }, duration_years: 2, importance: 5 },
      { id: 'quake', title: '强烈地震', annual_prob: 0.1, scope: 'countries', category: 'disaster',
        countries: ['JPN', 'TUR', 'CHL', 'IRN', 'IDN', 'NPL'], duration_years: 1 },
      { id: 'heatwave', title: '极端热浪', annual_prob: 0.2, requires: { climate: ['c_high'] }, scope: 'regions',
        regions: ['SAS', 'WAS'], category: 'disaster', mortality: { mult: 1.05, ages: [65, 120] }, duration_years: 1 },
    ],
  },
  lifePaths: {
    countries: {
      CHN: { currency: { code: 'CNY', name: '人民币', symbol: '¥' }, key_exams: [{ age: 15, name: '中考' }, { age: 18, name: '高考' }],
        median_first_marriage_age: { male: 29 } },
    },
    defaults_by_income_group: { UMC: { compulsory_years: 11, notes: ['默认说明'] } },
  },
};
const syn = makeDataStore({ countries: COUNTRIES, mortality: MORTALITY, content: SYN_CONTENT });

const NEUTRAL_KEYS = {
  gdp_growth_add: 0, unemployment_add: 0, mortality_mult: 1, inequality_add: 0, internet_ceiling: 100, heat_risk: 0,
  sea_level_risk: 0, conflict_risk_add: 0, migration_push_add: 0, retirement_age_add: 0, education_years_add: 0, happiness_add: 0,
};

/* ================================================================ data.js */

describe('decoding', () => {
  test('base64 decoder matches Buffer for all padding cases', () => {
    const rng = new Rng(7);
    for (let len = 0; len < 40; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = rng.int(0, 255);
      const b64 = Buffer.from(bytes).toString('base64');
      assert.deepEqual(Array.from(decodeBase64(b64)), Array.from(bytes), `len ${len}`);
    }
    assert.deepEqual(Array.from(decodeBase64('AQID\nBA==')), [1, 2, 3, 4]);
  });

  test('Uint16 little-endian decode', () => {
    assert.deepEqual(Array.from(decodeUint16LE(new Uint8Array([1, 0, 0, 1, 255, 255]))), [1, 256, 65535]);
  });
});

describe('DataStore basics', () => {
  test('countries, years, lookups', () => {
    assert.equal(data.isoList.length, Object.keys(COUNTRIES.countries).length);
    assert.equal(data.years[0], 2000);
    assert.equal(data.years.at(-1), 2100);
    assert.equal(data.country('CHN').en, 'China');
    assert.equal(data.country('XXX'), undefined);
    assert.equal(data.country('toString'), undefined);
  });

  test('series: grid values, interpolation, clamping, fallbacks', () => {
    const pop = COUNTRIES.countries.CHN.wpp.pop;
    const gi = COUNTRIES.meta.years.indexOf(2030);
    assert.equal(data.series('CHN', 'pop', 2000), pop[0]);
    assert.equal(data.series('CHN', 'pop', 1990), pop[0]);
    assert.equal(data.series('CHN', 'pop', 2150), pop.at(-1));
    const interp = data.series('CHN', 'pop', 2032);
    assert.ok(Math.abs(interp - (pop[gi] + (pop[gi + 1] - pop[gi]) * 0.4)) < 1e-9);
    assert.ok(Math.abs(data.series('CHN', 'pop', 2000.5) - (pop[0] + pop[1]) / 2) < 1e-9);
    assert.equal(data.series('CHN', 'gdp_pc_ppp', 2000), COUNTRIES.countries.CHN.wb.gdp_pc_ppp[0]);
    assert.equal(data.series('CHN', 'no_such_key', 2000), null);
    assert.equal(data.series('XXX', 'pop', 2000), null);
  });

  test('qx sanity: infant mortality matches IMR, ages, sexes', () => {
    const imr = data.series('CHN', 'imr', 2000) / 1000;
    const q0m = data.qx('CHN', 2000, 'male', 0);
    const q0f = data.qx('CHN', 2000, 'female', 0);
    assert.ok(q0m > imr * 0.75 && q0m < imr * 1.35, `CHN q0 male ${q0m} vs IMR ${imr}`);
    assert.ok(q0f > imr * 0.6 && q0f < imr * 1.35, `CHN q0 female ${q0f} vs IMR ${imr}`);
    for (const iso of BIG10) {
      const both = data.series(iso, 'imr', 2020) / 1000;
      const avg = (data.qx(iso, 2020, 'male', 0) + data.qx(iso, 2020, 'female', 0)) / 2;
      assert.ok(avg > both * 0.75 && avg < both * 1.3, `${iso} q0 ${avg} vs IMR ${both}`);
      for (const sex of ['male', 'female']) {
        const q30 = data.qx(iso, 2020, sex, 30);
        const q80 = data.qx(iso, 2020, sex, 80);
        assert.ok(q30 > 0 && q30 < 0.05 && q80 > q30 && q80 < 1, `${iso} ${sex}`);
      }
      assert.ok(data.qx(iso, 2020, 'female', 60) < data.qx(iso, 2020, 'male', 60), `${iso} female advantage`);
    }
    // same age group -> same rate; fractional ages floor
    assert.equal(data.qx('USA', 2010, 'male', 41), data.qx('USA', 2010, 'male', 44.9));
    assert.equal(data.qx('USA', 2010, 'male', 200), data.qx('USA', 2010, 'male', 100));
    assert.equal(data.qx('USA', 2010, 'male', -3), data.qx('USA', 2010, 'male', 0));
  });

  test('mx interpolates log-linearly between grid years and clamps years', () => {
    const a = data.mx('IND', 2030, 'female', 50);
    const b = data.mx('IND', 2035, 'female', 50);
    const m = data.mx('IND', 2032, 'female', 50);
    assert.ok(Math.abs(m - Math.exp(Math.log(a) + 0.4 * (Math.log(b) - Math.log(a)))) < 1e-12);
    assert.equal(data.mx('IND', 1990, 'female', 50), data.mx('IND', 2000, 'female', 50));
    assert.equal(data.mx('IND', 2200, 'female', 50), data.mx('IND', 2100, 'female', 50));
    const unknown = data.qx('ZZZ', 2030, 'male', 50);
    assert.ok(unknown > 0 && unknown < 0.05, 'unknown ISO falls back to a world reference schedule');
  });

  test('periodLifeExpectancy within 0.7 years of WPP for 10 large countries', () => {
    for (const iso of BIG10) {
      for (const y of [2000, 2020, 2050]) {
        for (const [sex, key] of [['male', 'le_m'], ['female', 'le_f']]) {
          const e = data.periodLifeExpectancy(iso, y, sex);
          const w = data.series(iso, key, y);
          assert.ok(Math.abs(e - w) < 0.7, `${iso} ${y} ${sex}: ${e.toFixed(2)} vs WPP ${w}`);
        }
      }
    }
  });

  test('multiplier functions and cohort helpers', () => {
    const base = data.periodLifeExpectancy('USA', 2020, 'female');
    const worse = data.periodLifeExpectancy('USA', 2020, 'female', () => 2);
    const better = data.periodLifeExpectancy('USA', 2020, 'female', () => Math.exp(-0.09 * 5));
    assert.ok(worse < base - 3);
    assert.ok(better > base + 3 && better < base + 7, `exp(-0.45) ≈ +5 years, got +${(better - base).toFixed(2)}`);
    const rem60 = data.periodLifeExpectancy('USA', 2020, 'female', null, 60);
    assert.ok(rem60 > 18 && rem60 < 30);

    const cohort = data.cohortLifeExpectancy('CHN', 2000, 'male');
    assert.ok(cohort > data.periodLifeExpectancy('CHN', 2000, 'male') + 3, 'cohort LE exceeds period LE with improving mortality');
    const s = data.cohortSurvival('CHN', 2000, 'male', 0);
    assert.equal(s.length, 116);
    assert.equal(s[0], 1);
    for (let a = 1; a < s.length; a++) assert.ok(s[a] <= s[a - 1] && s[a] >= 0);
    // trapezoid integral of survival ≈ life expectancy
    let area = 0;
    for (let a = 0; a < 115; a++) area += (s[a] + s[a + 1]) / 2;
    assert.ok(Math.abs(area - cohort) < 0.6, `area ${area} vs cohort LE ${cohort}`);
    const s30 = data.cohortSurvival('CHN', 2000, 'male', 30);
    for (let a = 0; a <= 30; a++) assert.equal(s30[a], 1);
    assert.ok(s30[31] < 1 && Math.abs(s30[80] - s[80] / s[30]) < 1e-12);
    const withMult = data.cohortSurvival('CHN', 2000, 'male', 0, (y, age) => (age >= 60 ? 2 : 1));
    assert.equal(withMult[60], s[60]);
    assert.ok(withMult[70] < s[70]);
  });

  test('birthsWeights', () => {
    const b = data.birthsWeights(2000);
    assert.ok(Math.abs(b.total - 135000) < 135000 * 0.03, `total ${b.total}`);
    assert.equal(b.isos.length, b.weights.length);
    assert.ok(b.isos.includes('IND') && b.weights.every((w) => w > 0));
    assert.equal(data.birthsWeights(2000), b, 'cached');
    const f = data.birthsWeights(2060);
    assert.ok(f.total > 90000 && f.total < 160000);
  });

  test('income groups', () => {
    assert.equal(data.incomeGroup('USA', 2020), 'HIC');
    assert.equal(data.incomeGroup('BDI', 2020), 'LIC');
    assert.ok(['LMC', 'UMC'].includes(data.incomeGroup('CHN', 2005)));
    assert.equal(data.incomeGroup('CHN', 2025), 'UMC');
    assert.ok(['LIC', 'LMC', 'UMC', 'HIC'].includes(data.incomeGroup('ZZZ', 2020)));
  });

  test('lifePath and currency fallbacks', () => {
    const lp = data.lifePath('ZZZ');
    assert.equal(typeof lp.school_start_age, 'number');
    assert.ok(Array.isArray(lp.key_exams) && Array.isArray(lp.retirement_age) && lp.retirement_age.length);
    assert.deepEqual(data.currency('ZZZ'), { code: '', name: '本地货币', symbol: '' });
    assert.equal(data.currency('FRA').code, 'EUR');
    const usa = data.lifePath('USA');
    assert.ok(!usa.common_destinations.includes('USA'));
    assert.ok(usa.median_first_marriage_age.male >= 18);

    const chn = syn.lifePath('CHN');
    assert.equal(chn.median_first_marriage_age.male, 29, 'country entry wins');
    assert.equal(typeof chn.median_first_marriage_age.female, 'number', 'nested defaults kept');
    assert.equal(chn.compulsory_years, 11, 'income-group default applied');
    assert.equal(chn.key_exams.length, 2);
    assert.equal(chn.currency.code, 'CNY');
    assert.equal(syn.lifePath('BRA').compulsory_years, 11);
    assert.equal(syn.lifePath('CHN'), chn, 'cached');
  });

  test('loadData: parallel fetch, content failure tolerated, required failure rejects', async () => {
    const seen = [];
    const ok = await loadData(async (url) => {
      seen.push(url);
      if (url === 'data/countries.json') return COUNTRIES;
      if (url === 'data/mortality.json') return MORTALITY;
      throw new Error('404');
    });
    assert.deepEqual(seen.sort(), ['data/content.json', 'data/countries.json', 'data/mortality.json']);
    assert.deepEqual(ok.content.history, []);
    assert.deepEqual(ok.content.future.dimensions, []);
    assert.deepEqual(ok.content.lifePaths.countries, {});
    assert.ok(ok.qx('CHN', 2000, 'male', 0) > 0);
    await assert.rejects(loadData(async (url) => {
      if (url === 'data/mortality.json') throw new Error('offline');
      return url === 'data/countries.json' ? COUNTRIES : {};
    }));
  });

  test('performance: 1e6 qx calls < 1.5 s', () => {
    const isos = ['CHN', 'IND', 'USA', 'NGA'];
    const t0 = performance.now();
    let s = 0;
    for (let i = 0; i < 1e6; i++) s += data.qx(isos[i & 3], 2000 + (i % 91), i & 1 ? 'female' : 'male', i % 110);
    const ms = performance.now() - t0;
    assert.ok(s > 0);
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  });
});

/* ================================================================ world.js */

describe('World', () => {
  test('determinism: same seed and toJSON branches rebuild the same world', () => {
    for (const seed of [1, 42, 123456789, 'abc']) {
      const a = createWorld(syn, seed);
      const b = createWorld(syn, seed);
      const c = createWorld(syn, a.toJSON().seed, a.toJSON().branches);
      for (const w of [b, c]) {
        assert.deepEqual(w.branches, a.branches);
        assert.equal(w.label, a.label);
        assert.equal(w.description, a.description);
        assert.deepEqual(w.timeline(), a.timeline());
        assert.deepEqual(w.modifiers('NGA', 2050), a.modifiers('NGA', 2050));
        assert.equal(w.lifeExpectancy('NGA', 2060, 'female'), a.lifeExpectancy('NGA', 2060, 'female'));
      }
      assert.deepEqual(JSON.parse(JSON.stringify(a)), { seed, branches: a.branches });
    }
    const real1 = createWorld(data, 99);
    const real2 = createWorld(data, 99);
    assert.deepEqual(real1.timeline(), real2.timeline());
    assert.equal(real1.label, real2.label);
  });

  test('forced branches are respected and unknown ids ignored', () => {
    const w = createWorld(syn, 5, { ai: 'ai_transformative', climate: 'nope', unknown_dim: 'x' });
    assert.equal(w.branches.ai, 'ai_transformative');
    assert.ok(['c_low', 'c_mid', 'c_high'].includes(w.branches.climate));
    assert.equal(w.dims.length, 3);
    assert.equal(w.dims[0].branch.title, '颠覆式变革');
    assert.equal(w.dims[0].branch.prob, 0.2);
    // forcing one dimension does not change the others
    const free = createWorld(syn, 5);
    assert.equal(w.branches.climate, free.branches.climate);
    assert.equal(w.branches.geo, free.branches.geo);
  });

  test('neutral modifiers and pure data for years <= 2026', () => {
    for (const seed of [3, 4, 5]) {
      const w = createWorld(syn, seed, { ai: 'ai_transformative', climate: 'c_high', geo: 'g_tense' });
      for (const iso of ['CHN', 'NGA', 'USA', 'IRN']) {
        for (const y of [2000, 2013, 2026]) {
          const m = w.modifiers(iso, y);
          for (const [k, v] of Object.entries(NEUTRAL_KEYS)) assert.equal(m[k], v, `${iso} ${y} ${k}`);
          for (const age of [0, 30, 70]) assert.equal(w.mortalityMult(iso, y, age), 1);
          for (const key of ['gdp_pc_ppp', 'gini', 'internet', 'unemployment', 'poverty', 'le']) {
            assert.equal(w.indicator(iso, key, y), syn.series(iso, key, y));
          }
          assert.equal(w.lifeExpectancy(iso, y, 'male'), syn.periodLifeExpectancy(iso, y, 'male'));
          assert.ok(w.events(iso, y).every((e) => e.source === 'history' && !e.projection));
        }
      }
      assert.equal(w.isProjection(2026), false);
      assert.equal(w.isProjection(2027), true);
    }
  });

  test('modifiers ramp in, region overrides, indicators', () => {
    const w = createWorld(syn, 11, { ai: 'ai_transformative', climate: 'c_low', geo: 'g_calm' });
    const m27 = w.modifiers('USA', 2027);
    const m31 = w.modifiers('USA', 2031);
    assert.ok(Math.abs(m27.gdp_growth_add - 0.3) < 1e-9);
    assert.ok(Math.abs(m31.gdp_growth_add - 1.5) < 1e-9);
    assert.ok(Math.abs(w.modifiers('NGA', 2040).gdp_growth_add - 0.5) < 1e-9, 'SSA override');
    // longevity knobs are centred on the probability-weighted mean across branches (WPP medium = average world)
    const cLE = syn.content.future.dimensions.reduce((s, d) => {
      const tot = d.branches.reduce((a, b) => a + Math.max(0, b.prob || 0), 0) || 1;
      return s + d.branches.reduce((a, b) => a + (Math.max(0, b.prob || 0) / tot) * ((b.modifiers && b.modifiers.life_exp_add_by_2090) || 0), 0);
    }, 0);
    const cLogM = syn.content.future.dimensions.reduce((s, d) => {
      const tot = d.branches.reduce((a, b) => a + Math.max(0, b.prob || 0), 0) || 1;
      return s + d.branches.reduce((a, b) => { const m = b.modifiers && b.modifiers.mortality_mult; return a + (m > 0 ? (Math.max(0, b.prob || 0) / tot) * Math.log(m) : 0); }, 0);
    }, 0);
    assert.ok(Math.abs(w.modifiers('USA', 2058).life_exp_add - (2 - cLE / 2)) < 1e-9);
    assert.ok(Math.abs(w.modifiers('USA', 2090).life_exp_add - (4 - cLE)) < 1e-9);
    assert.ok(Math.abs(w.modifiers('USA', 2100).life_exp_add - (4 - cLE)) < 1e-9, 'held after 2090');
    assert.ok(Math.abs(w.modifiers('USA', 2060).retirement_age_add - 2) < 1e-9);
    assert.ok(w.modifiers('USA', 2090).heat_risk > w.modifiers('USA', 2040).heat_risk);

    // gdp compounds the added growth from 2027
    let f = 1;
    for (let y = 2027; y <= 2040; y++) f *= 1 + w.modifiers('USA', y).gdp_growth_add / 100;
    const ratio = w.indicator('USA', 'gdp_pc_ppp', 2040) / syn.series('USA', 'gdp_pc_ppp', 2040);
    assert.ok(Math.abs(ratio - f) < 1e-9 && f > 1.15);
    assert.ok(w.indicator('USA', 'poverty', 2040) <= syn.series('USA', 'poverty', 2040) + 1e-9);
    assert.ok(Math.abs(w.indicator('USA', 'unemployment', 2040) - (syn.series('USA', 'unemployment', 2040) + 3)) < 1e-9);

    // mortality multiplier: exp(-0.09 * lifeExpAdd) at an age untouched by shocks (no shocks reach age 30 here)
    const mm = w.mortalityMult('USA', 2090, 30);
    const wm = w.modifiers('USA', 2090);
    assert.ok(Math.abs(mm - Math.exp(-0.09 * (4 - cLE)) * wm.mortality_mult) < 1e-9, `${mm}`);
    const le = w.lifeExpectancy('USA', 2090, 'male');
    assert.ok(le > syn.periodLifeExpectancy('USA', 2090, 'male') + 1, 'a longevity branch raises life expectancy above the average world');

    const g = createWorld(syn, 11, { ai: 'ai_gradual', climate: 'c_mid', geo: 'g_calm' });
    assert.ok(Math.abs(g.indicator('CHN', 'gini', 2040) - (syn.series('CHN', 'gini', 2040) + 3)) < 1e-9, 'gini 0-100 scale');
    assert.ok(g.indicator('KOR', 'internet', 2040) <= 90 + 1e-9, 'internet ceiling');
    assert.ok(g.modifiers('JPN', 2090).sea_level_risk > 0);
    assert.equal(g.modifiers('CHE', 2090).sea_level_risk, 0, 'landlocked');
    assert.ok(Math.abs(g.modifiers('USA', 2040).mortality_mult - 1.02 / Math.exp(cLogM)) < 1e-9);
    const mo = g.modifiers('USA', 2040);
    mo.gdp_growth_add = 99; // returned objects are copies
    assert.notEqual(g.modifiers('USA', 2040).gdp_growth_add, 99);
  });

  test('history events: scope matching, years, headlines', () => {
    const w = createWorld(syn, 1);
    const ids = (iso, y) => w.events(iso, y).map((e) => e.id);
    assert.ok(ids('CHN', 2008).includes('gfc_2008') && ids('CHN', 2008).includes('quake_2008'));
    assert.ok(ids('USA', 2008).includes('gfc_2008') && !ids('USA', 2008).includes('quake_2008'));
    assert.ok(ids('USA', 2009).includes('gfc_2008'), 'active through end_year');
    assert.ok(!ids('USA', 2010).includes('gfc_2008'));
    assert.ok(ids('EGY', 2011).includes('unrest_2011') && ids('IRQ', 2012).includes('unrest_2011'));
    assert.ok(!ids('CHN', 2011).includes('unrest_2011'));
    assert.ok(ids('ISL', 2008).includes('minor_2008'));
    assert.ok(!w.timeline().some((e) => e.id === 'bad_future') && !ids('USA', 2030).includes('bad_future'));
    const ev = w.events('CHN', 2008)[0];
    for (const k of ['id', 'source', 'year', 'endYear', 'title', 'summary', 'category', 'importance', 'scope', 'countries',
      'regions', 'effects', 'migration_push', 'personal_hooks', 'sources', 'projection']) assert.ok(k in ev, k);
    assert.deepEqual(Object.keys(ev.effects).sort(), ['economy', 'education', 'happiness', 'health', 'safety', 'tech']);

    const hl = w.headlines(2008, 'CHN', 6);
    assert.ok(hl.length >= 2 && hl.length <= 6);
    assert.ok(hl.some((e) => e.id === 'gfc_2008') && hl.some((e) => e.id === 'quake_2008'));
    assert.ok(!hl.some((e) => e.id === 'minor_2008'), 'minor foreign events stay out of the ticker');
    assert.ok(w.headlines(2008, 'ISL').some((e) => e.id === 'minor_2008'));
    assert.equal(w.headlines(2008, 'CHN', 1).length, 1);
    assert.deepEqual(w.events('CHN', 1990), []);
  });

  test('future items: requires, probabilities, year ranges, scopes, shocks', () => {
    let agiT = 0, nT = 0, malaria = 0, heatOk = true, quakeOk = true, overlapOk = true, conflictsTense = 0, conflictsCalm = 0;
    let pandemicChecked = false;
    const N = 600;
    for (let seed = 1; seed <= N; seed++) {
      const w = createWorld(syn, seed);
      const tl = w.timeline();
      for (let i = 1; i < tl.length; i++) assert.ok(tl[i].year >= tl[i - 1].year, 'timeline sorted');
      for (const e of tl) {
        assert.ok(e.projection && e.year >= 2027 && e.year <= 2090 && e.endYear >= e.year);
        assert.ok(e.source === 'future' || e.source === 'shock');
      }
      const agi = tl.find((e) => e.refId === 'agi');
      if (w.branches.ai === 'ai_transformative') {
        nT++;
        if (agi) { agiT++; assert.ok(agi.year >= 2030 && agi.year <= 2045); }
      } else {
        assert.equal(agi, undefined, 'agi requires ai_transformative');
      }
      const mal = tl.find((e) => e.refId === 'malaria');
      if (mal) {
        malaria++;
        assert.ok(mal.year >= 2035 && mal.year <= 2050);
        assert.ok(w.events('NGA', mal.year).includes(mal) && !w.events('CHN', mal.year).includes(mal));
        assert.ok(Math.abs(w.mortalityMult('NGA', mal.year, 2) / w.mortalityMult('NGA', mal.year, 30) - 0.9) < 1e-9);
      }
      const heat = tl.filter((e) => e.refId === 'heatwave');
      if (heat.length && w.branches.climate !== 'c_high') heatOk = false;
      for (const q of tl.filter((e) => e.refId === 'quake')) {
        if (!(q.countries.length >= 1 && q.countries.length <= 2 && q.scope === 'countries')) quakeOk = false;
        if (!q.title.startsWith('强烈地震（')) quakeOk = false;
      }
      const pans = tl.filter((e) => e.refId === 'pandemic');
      for (let i = 1; i < pans.length; i++) if (pans[i].year <= pans[i - 1].endYear) overlapOk = false;
      if (pans.length && !pandemicChecked) {
        const p = pans[0];
        const r = w.mortalityMult('FRA', p.year, 70) / w.mortalityMult('FRA', p.year, 30);
        assert.ok(Math.abs(r - 1.2) < 1e-9, `pandemic multiplier on 60+ ${r}`);
        assert.ok(w.events('FRA', p.year).includes(p) && w.headlines(p.year, 'BRA').includes(p));
        pandemicChecked = true;
      }
      const conflicts = tl.filter((e) => e.refId === 'regional_conflict');
      if (w.branches.geo === 'g_tense') conflictsTense += conflicts.length; else conflictsCalm += conflicts.length;
      for (const c of conflicts) {
        assert.ok(c.mortality && c.countries.length === 1 && c.category === 'war' && c.title.startsWith('局部武装冲突（'));
        assert.ok(syn.country(c.countries[0]).region === c.regions[0]);
      }
    }
    assert.ok(heatOk, 'heatwave requires c_high');
    assert.ok(quakeOk, 'localized disaster picks 1-2 countries');
    assert.ok(overlapOk, 'a shock does not overlap itself');
    assert.ok(pandemicChecked);
    assert.ok(Math.abs(agiT / nT - 0.9) < 0.08, `agi ${agiT}/${nT}`);
    assert.ok(Math.abs(malaria / N - 0.6) < 0.07, `malaria ${malaria / N}`);
    assert.equal(conflictsCalm, 0);
    assert.ok(conflictsTense > 0);
  });

  test('labels and description are Chinese and summarise the branches', () => {
    const w = createWorld(syn, 2024, { ai: 'ai_gradual', climate: 'c_high', geo: 'g_tense' });
    assert.match(w.label, /^世界线 [0-9A-Z]{3}-[0-9A-Z]{3} · /);
    for (const t of ['渐进普及', '严重升温', '持续紧张']) assert.ok(w.description.includes(t), t);
    assert.ok(w.description.includes('推演'));
    assert.equal(w.assumptions.length, 1);
    const real = createWorld(data, 7);
    assert.ok(real.label.startsWith('世界线 ') && real.description.length > 20);
  });

  test('branch frequencies over 3000 seeds within ±0.05 of probs (synthetic content)', () => {
    checkFrequencies(syn);
  });

  test('branch frequencies over 3000 seeds within ±0.05 of probs (real content)', (t) => {
    if (!data.content.future.dimensions.length) {
      t.skip('content has no future dimensions yet');
      return;
    }
    checkFrequencies(data);
  });

  test('performance: world.mortalityMult and lifeExpectancy are cheap', () => {
    const w = createWorld(syn, 77);
    const t0 = performance.now();
    let s = 0;
    for (let i = 0; i < 2e5; i++) s += w.mortalityMult('IND', 2000 + (i % 91), i % 100);
    for (let y = 2027; y <= 2090; y++) s += w.lifeExpectancy('IND', y, 'female');
    const ms = performance.now() - t0;
    assert.ok(s > 0 && ms < 1500, `${ms.toFixed(0)} ms`);
  });
});

function checkFrequencies(store) {
  const N = 3000;
  const dims = store.content.future.dimensions.filter((d) => d && d.id && Array.isArray(d.branches) && d.branches.length);
  const counts = {};
  for (let seed = 1; seed <= N; seed++) {
    const w = createWorld(store, seed);
    for (const [d, b] of Object.entries(w.branches)) {
      counts[d] = counts[d] || {};
      counts[d][b] = (counts[d][b] || 0) + 1;
    }
  }
  for (const d of dims) {
    const tot = d.branches.reduce((s, b) => s + Math.max(0, +b.prob || 0), 0) || d.branches.length;
    for (const b of d.branches) {
      const p = tot ? Math.max(0, +b.prob || 0) / tot : 1 / d.branches.length;
      const got = ((counts[d.id] || {})[b.id] || 0) / N;
      assert.ok(Math.abs(got - p) <= 0.05, `${d.id}/${b.id}: ${got.toFixed(3)} vs ${p}`);
    }
  }
}

test('constants sanity', () => {
  assert.equal(HISTORY_END, 2026);
});
