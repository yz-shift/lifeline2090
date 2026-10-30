// Mortality, causes of death and the death record (CONTRACT §2, §3 DeathRecord, §4 "Mortality", "Cause of death").
//
// Annual hazard = WPP central death rate (data.mx, both sides of the birthday within the calendar year)
//   × personal multiplier (health stat, family/income percentile, city/village, conditions, smoking, a few flags;
//     normalised so the population mean among the living is ≈ 1 at every age)
//   × world.mortalityMult (1 up to 2026) × active hazardMods; the total multiplier is capped to [0.25, 6].
// Pure module: no DOM, no Math.random, no Date.now.

import { HISTORY_END } from './constants.js';
import { Rng, hashString } from './rng.js';
import { dayIndexOf, daysInYear, dateFromDayIndex, formatDate, parseDate } from './person.js';
import { eventMortality } from './world.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (isNum(v) ? v : d);
function safe(fn, fb = null) {
  try {
    const v = fn();
    return v === undefined || v === null ? fb : v;
  } catch {
    return fb;
  }
}

export const MULT_MIN = 0.25;
export const MULT_MAX = 6;
const HARD_AGE = 122;

/* ------------------------------------------------------------------ health baseline */

/** Expected health stat for an age in a country with period life expectancy le (declines after 30). */
export function expectedHealth(age, le) {
  const L = isNum(le) ? clampN(le, 35, 95) : 72;
  const slope = 0.42 + clampN((80 - L) / 45, 0, 0.6);
  let h = age < 1 ? 80 : age < 30 ? 86 : 86 - slope * (age - 30);
  if (age > 75) h -= 0.02 * (age - 75) * (age - 75);
  return clampN(h, 12, 92);
}

/* ------------------------------------------------------------------ smoking */

const FEMALE_SMOKE_RATIO = { EAS: 0.07, SEA: 0.08, SAS: 0.15, CAS: 0.15, WAS: 0.2, NAF: 0.08, SSA: 0.12, EEU: 0.45, WEU: 0.85, NAM: 0.8, LAC: 0.55, OCE: 0.85 };
const FEMALE_SMOKE_COUNTRY = { JPN: 0.3, KOR: 0.15, TWN: 0.15, HKG: 0.25, SGP: 0.2, TUR: 0.45, IRN: 0.1, LBN: 0.7, JOR: 0.25, ISR: 0.6, CYP: 0.5, SRB: 0.95, BIH: 0.8 };

/** Share (0..1) of adults of this sex who smoke, from the WB smoking rate and a regional female/male ratio. */
export function smokingPrevalence(data, iso, year, sex) {
  const s = clampN(num(safe(() => data.series(iso, 'smoking', year)), 20), 0, 80) / 100;
  const region = safe(() => data.country(iso).region) || '';
  const r = FEMALE_SMOKE_COUNTRY[iso] ?? FEMALE_SMOKE_RATIO[region] ?? 0.4;
  const male = clampN((2 * s) / (1 + r), 0, 0.85);
  return sex === 'female' ? clampN(male * r, 0, 0.6) : male;
}
function smokeRR(age) {
  return age < 30 ? 1.15 : age < 45 ? 1.7 : age < 70 ? 1.9 : 1.4;
}

/* ------------------------------------------------------------------ conditions */

// relative risk by severity 1..3
const COND_RR = {
  hypertension: [1.15, 1.3, 1.5], diabetes: [1.25, 1.5, 1.9], cancer: [1.8, 3.0, 5.0], heart: [1.4, 2.0, 3.0],
  stroke: [1.5, 2.0, 2.7], copd: [1.3, 1.8, 2.5], dementia: [1.3, 1.8, 2.6], depression: [1.1, 1.2, 1.4],
  asthma: [1.05, 1.1, 1.25], arthritis: [1.0, 1.04, 1.1], long_covid: [1.05, 1.12, 1.25], hiv: [1.6, 2.6, 4.5],
  tb: [1.5, 2.4, 4.0], kidney: [1.4, 2.0, 3.0], liver: [1.4, 2.2, 3.2], disability: [1.1, 1.3, 1.6], obesity: [1.1, 1.25, 1.45],
};
const COND_DEFAULT = [1.12, 1.3, 1.6];

export function conditionFactor(conditions) {
  let f = 1;
  for (const c of Array.isArray(conditions) ? conditions : []) {
    if (!c || typeof c !== 'object') continue;
    const rr = COND_RR[c.id] || COND_DEFAULT;
    f *= rr[clampN(Math.round(num(c.severity, 1)), 1, 3) - 1];
  }
  return clampN(f, 1, 5);
}

/* ------------------------------------------------------------------ normalisation */

// Mean raw personal multiplier among the living by age, measured by simulating lives in CHN IND USA NGA DEU BRA JPN
// ETH with this engine (frailty selection, condition incidence, event hazards). Dividing by it keeps the
// population mean at ≈ 1 so simulated life expectancy matches the WPP tables. Linear between anchors.
const R_AGES = [0, 5, 15, 30, 45, 60, 70, 80, 90, 100];
// Re-measured (tests/_calib_probe.mjs, 300 lives per country, two passes) after income percentiles stopped
// drifting to the top of the ladder.
const R_VALS = [1.002, 1.004, 1.119, 0.983, 1.082, 1.367, 1.972, 3.15, 3.988, 3.225];

// Residual by income group relative to the pooled age profile (hazard-weighted, 60 lives in each of 31 countries):
// harder places bring more illness, crises and conflict stories, so their lives sit below the expected health
// level; dividing by this keeps each group's own mean near 1 instead of shifting their life expectancy.
const IG_NORM = { LIC: 1.02, LMC: 1.06, UMC: 1.01, HIC: 0.86 };

export function residualNorm(age) {
  if (age <= R_AGES[0]) return R_VALS[0];
  for (let i = 1; i < R_AGES.length; i++) {
    if (age <= R_AGES[i]) {
      const t = (age - R_AGES[i - 1]) / (R_AGES[i] - R_AGES[i - 1]);
      return R_VALS[i - 1] + (R_VALS[i] - R_VALS[i - 1]) * t;
    }
  }
  return R_VALS[R_VALS.length - 1];
}

const SES_BETA = { LIC: 0.9, LMC: 0.8, UMC: 0.7, HIC: 0.6 };
const URBAN_GAMMA = { LIC: 0.12, LMC: 0.1, UMC: 0.07, HIC: 0.03 };

function incomeGroupOf(data, world, iso, year) {
  return safe(() => (world && typeof world.incomeGroup === 'function' ? world.incomeGroup(iso, year) : null))
    || safe(() => data.incomeGroup(iso, year)) || 'UMC';
}

/** Socio-economic percentile used for mortality: family for children, own income for adults. */
export function sesOf(state) {
  const p = state.person || {};
  const age = num(state.age, 0);
  const fam = clampN(num(p.familyPct, 0.5), 0, 1);
  const c = p.career || {};
  if (age < 18) return fam;
  const own = ['employed', 'self_employed', 'military', 'retired'].includes(c.status) ? clampN(num(c.incomePct, fam), 0, 1) : fam * 0.6 + 0.2;
  const w = age >= 28 ? 0.8 : ((age - 18) / 10) * 0.8;
  return fam * (1 - w) + own * w;
}

/**
 * Raw and normalised personal multiplier (without world and hazardMods).
 * Returns {mult, ses, urban, health, conditions, smoking, lifestyle, residual, raw}.
 */
export function personalMultiplier(data, world, state) {
  const p = state.person || {};
  const age = num(state.age, 0);
  const year = num(state.year, 2000);
  const iso = p.country;
  const ig = incomeGroupOf(data, world, iso, year);
  // family / income gradient, exactly mean 1 over a uniform percentile
  let beta = SES_BETA[ig] || 0.7;
  if (age >= 80) beta *= 0.5;
  const ses = Math.exp(beta * (0.5 - sesOf(state))) / (Math.sinh(beta / 2) / (beta / 2));
  // city / village
  const us = clampN(num(safe(() => data.series(iso, 'urban', year)), 55) / 100, 0.02, 1);
  const gam = URBAN_GAMMA[ig] || 0.07;
  const urban = Math.exp(gam * ((p.urban ? 0 : 1) - (1 - us)));
  // health stat relative to the expected level for the age
  const le = num(safe(() => data.series(iso, 'le', Math.min(year, 2100))), 72);
  const dev = num(state.stats && state.stats.health, expectedHealth(age, le)) - expectedHealth(age, le);
  const health = Math.exp(-(age < 5 ? 0.008 : 0.012) * clampN(dev, -40, 25));
  // conditions
  const conditions = conditionFactor(p.conditions);
  // smoking, normalised by the expected prevalence for the sex
  const flags = p.flags || {};
  let smoking = 1;
  if (age >= 15) {
    const prev = smokingPrevalence(data, iso, year, p.sex);
    const rr = smokeRR(age);
    const ex = age >= 40 ? 1.2 : 1.05;
    const norm = 1 + prev * (rr - 1) + (age >= 40 ? prev * 0.35 * (ex - 1) : 0);
    smoking = (flags.smoker === true ? rr : flags.exSmoker ? ex : 1) / norm;
  }
  // lifestyle and circumstances
  let lifestyle = 1;
  if (flags.healthyDiet) lifestyle *= 0.94;
  if (flags.exercise) lifestyle *= 0.92;
  if (flags.longevityTx) lifestyle *= 0.75;
  if (flags.displaced && year - num(flags.displaced, year) <= 5) lifestyle *= 1.15;
  if (flags.homeless) lifestyle *= 1.4;
  const residual = residualNorm(age) * (IG_NORM[ig] || 1);
  const raw = ses * urban * health * conditions * smoking * lifestyle;
  return { mult: raw / residual, ses, urban, health, conditions, smoking, lifestyle, residual, raw };
}

/** Product of the active hazardMods (each 0.5..2), capped to [0.5, 3]. */
export function modsMultiplier(state, year) {
  let m = 1;
  for (const h of Array.isArray(state.hazardMods) ? state.hazardMods : []) {
    if (!h || !isNum(h.mult)) continue;
    if (isNum(h.untilYear) && h.untilYear < year) continue;
    m *= clampN(h.mult, 0.5, 2);
  }
  return clampN(m, 0.5, 3);
}

/** Fraction of the calendar year that falls before the birthday (0..1). */
export function birthdayFraction(birth) {
  const d = parseDate(birth && birth.date);
  if (!d) return 0.5;
  return dayIndexOf(d.year, d.month, d.day) / daysInYear(d.year);
}

/**
 * Base (unmodified) central death rate for the calendar year state.year in which the person turns state.age:
 * a fraction b of the year at age-1 and 1-b at age; the first step also carries the rest of the birth year.
 */
export function baseHazard(data, state) {
  const p = state.person || {};
  const iso = p.country || (state.birth && state.birth.country);
  const year = num(state.year, 2000);
  const age = Math.max(0, Math.floor(num(state.age, 0)));
  const sex = p.sex === 'female' ? 'female' : 'male';
  const b = birthdayFraction(state.birth);
  const mx = (y, a) => num(safe(() => data.mx(iso, y, sex, a)), 0.01);
  const after = (1 - b) * mx(year, age);
  let before = age >= 1 ? b * mx(year, age - 1) : 0;
  if (age === 1) before += (1 - b) * mx(year - 1, 0);
  return { m: before + after, before, after, b };
}

/**
 * Hazard for the current life-year (CONTRACT §2). q = 1 - exp(-m × mult) with mult = clamp(personal × world ×
 * hazardMods, 0.25, 6). parts: {base (q without multipliers), m, personal, world, mods, b, ...personal factors}.
 */
export function hazardFor(data, world, state) {
  const p = (state && state.person) || {};
  const year = num(state && state.year, 2000);
  const age = Math.max(0, Math.floor(num(state && state.age, 0)));
  const iso = p.country || (state && state.birth && state.birth.country);
  const base = baseHazard(data, state);
  const pm = personalMultiplier(data, world, state);
  const w = clampN(num(safe(() => (world && typeof world.mortalityMult === 'function' ? world.mortalityMult(iso, year, age) : 1)), 1), 0.2, 5);
  const mods = modsMultiplier(state, year);
  const mult = clampN(pm.mult * w * mods, MULT_MIN, MULT_MAX);
  let q = 1 - Math.exp(-base.m * mult);
  if (age >= HARD_AGE) q = 1;
  return {
    q: clampN(q, 0, 1),
    mult,
    parts: {
      base: 1 - Math.exp(-base.m), m: base.m, before: base.before, after: base.after, b: base.b,
      personal: pm.mult, world: w, mods, ses: pm.ses, urban: pm.urban, health: pm.health, conditions: pm.conditions,
      smoking: pm.smoking, lifestyle: pm.lifestyle, residual: pm.residual,
    },
  };
}

/* ------------------------------------------------------------------ causes of death */

const FALLBACK_IDS = ['cvd', 'cancer', 'chronic_resp', 'diabetes_kidney', 'digestive', 'neuro', 'lri', 'diarrhoea', 'tb_hiv_malaria', 'neonatal', 'maternal', 'road', 'suicide', 'violence', 'other_injury', 'other'];
const FALLBACK_NAMES = {
  cvd: '心血管疾病', cancer: '癌症', chronic_resp: '慢性呼吸系统疾病', diabetes_kidney: '糖尿病与肾病', digestive: '消化系统疾病',
  neuro: '神经系统疾病', lri: '下呼吸道感染', diarrhoea: '腹泻病', tb_hiv_malaria: '结核/艾滋/疟疾', neonatal: '新生儿疾病',
  maternal: '孕产相关疾病', road: '道路交通伤害', suicide: '自杀', violence: '暴力与冲突', other_injury: '意外伤害', other: '其他疾病',
  covid: '新冠肺炎（COVID-19）',
};
const FALLBACK_BANDS = [[0, 4], [5, 14], [15, 29], [30, 49], [50, 69], [70, 120]];
// WHO GHE 2019 shares (‰) by income group and age band, cause order as FALLBACK_IDS (used when content is missing)
const FALLBACK_SHARES = {
  LIC: '4,6,4,3,5,3,156,97,156,340,0,6,0,3,22,194|23,34,8,18,22,16,128,84,122,32,0,77,6,52,164,215|42,43,7,23,28,15,30,24,157,8,105,101,27,244,72,73|136,114,16,34,59,9,38,24,257,3,67,64,22,36,54,66|312,138,43,74,65,12,54,29,138,2,0,27,12,10,31,54|428,70,72,76,43,48,76,32,71,0,0,10,5,1,25,43',
  LMC: '7,6,3,2,5,3,151,84,101,460,0,6,0,2,29,144|33,55,9,16,27,21,99,79,107,44,0,63,13,16,172,246|86,53,15,29,53,18,25,30,117,13,70,130,105,49,117,89|223,139,33,49,80,9,21,19,147,3,27,67,42,20,64,57|377,156,95,87,57,11,28,25,64,1,0,19,10,4,31,37|400,60,156,80,34,44,55,58,34,0,0,6,4,1,32,37',
  UMC: '9,21,6,3,13,6,89,31,48,616,0,19,0,6,67,65|38,139,15,19,31,43,66,21,33,72,0,128,20,33,210,134|92,71,15,29,36,25,25,6,74,18,14,182,78,139,132,65|242,195,22,48,72,13,24,4,83,4,6,82,36,41,68,58|366,298,52,69,52,22,23,4,19,1,0,25,12,4,25,32|467,160,104,54,31,73,41,6,6,0,0,5,4,0,17,30',
  HIC: '12,27,5,2,7,21,43,11,8,733,0,15,0,12,60,46|44,204,21,10,17,96,41,4,4,94,0,115,62,41,153,96|64,86,10,13,20,37,15,1,22,17,3,180,205,85,84,157|204,203,14,26,88,23,21,1,38,6,2,50,99,26,57,143|287,371,45,41,67,30,19,1,6,3,0,11,23,3,27,66|379,222,64,47,37,114,43,3,1,0,0,2,4,0,25,57',
};

function parseFallback() {
  const shares = {};
  for (const [g, s] of Object.entries(FALLBACK_SHARES)) shares[g] = s.split('|').map((row) => row.split(',').map((x) => +x / 1000));
  return shares;
}

const tableCache = new WeakMap();
/** Normalised cause-of-death table from content.econ.causes_of_death, or the built-in fallback. */
export function causeTable(data) {
  const key = data && typeof data === 'object' ? data : null;
  if (key && tableCache.has(key)) return tableCache.get(key);
  const cd = safe(() => data.content.econ.causes_of_death);
  let t = null;
  if (isObj(cd) && Array.isArray(cd.causes) && cd.causes.length && isObj(cd.shares)) {
    const ids = cd.causes.map((c) => String((c && c.id) || ''));
    const n = ids.length;
    const bands = Array.isArray(cd.age_bands) && cd.age_bands.length ? cd.age_bands.map((b) => [num(b[0], 0), num(b[1], 120)]) : FALLBACK_BANDS;
    const okRow = (r) => Array.isArray(r) && r.length === n && r.every(isNum);
    const okTable = (tb) => isObj(tb) && ['LIC', 'LMC', 'UMC', 'HIC'].every((g) => Array.isArray(tb[g]) && tb[g].length === bands.length && tb[g].every(okRow));
    if (ids.every(Boolean) && okTable(cd.shares)) {
      const byYear = {};
      if (isObj(cd.shares_by_year)) for (const [y, tb] of Object.entries(cd.shares_by_year)) if (okTable(tb)) byYear[y] = tb;
      const bySex = {};
      if (isObj(cd.shares_by_sex_2019)) for (const sx of ['male', 'female']) if (okTable(cd.shares_by_sex_2019[sx])) bySex[sx] = cd.shares_by_sex_2019[sx];
      const names = {};
      cd.causes.forEach((c) => { names[c.id] = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : FALLBACK_NAMES[c.id] || c.id; });
      const details = isObj(cd.cause_details) ? cd.cause_details : {};
      t = { ids, names, bands, shares: cd.shares, byYear, bySex, details };
    }
  }
  if (!t) t = { ids: FALLBACK_IDS, names: { ...FALLBACK_NAMES }, bands: FALLBACK_BANDS, shares: parseFallback(), byYear: {}, bySex: {}, details: {} };
  if (!t.names.covid) t.names.covid = FALLBACK_NAMES.covid;
  if (key) tableCache.set(key, t);
  return t;
}

function bandIndex(bands, age) {
  for (let i = 0; i < bands.length; i++) if (age >= bands[i][0] && age <= bands[i][1]) return i;
  return age < bands[0][0] ? 0 : bands.length - 1;
}

/** Base shares for one person-year (sex-specific 2019 table scaled by the era's shares). */
function baseShares(t, ig, band, sex, year) {
  const g = ['LIC', 'LMC', 'UMC', 'HIC'].includes(ig) ? ig : 'UMC';
  const both19 = t.shares[g][band];
  const sexRow = t.bySex[sex] ? t.bySex[sex][g][band] : null;
  const base = (sexRow || both19).slice();
  const yk = year < 2005 ? '2000' : year < 2015 ? '2010' : year >= 2023 ? '2023' : null;
  const yt = yk && t.byYear[yk] ? t.byYear[yk][g][band] : null;
  if (yt) {
    for (let i = 0; i < base.length; i++) {
      const r = both19[i] > 0 ? clampN(yt[i] / both19[i], 0.25, 4) : 1;
      base[i] *= r;
    }
  }
  return base;
}

const COND_CAUSE = {
  hypertension: [['cvd', 2.2]], heart: [['cvd', 4]], stroke: [['cvd', 4]], diabetes: [['diabetes_kidney', 4], ['cvd', 1.4]],
  kidney: [['diabetes_kidney', 4]], cancer: [['cancer', 8]], copd: [['chronic_resp', 5]], asthma: [['chronic_resp', 2]],
  dementia: [['neuro', 6]], depression: [['suicide', 3]], hiv: [['tb_hiv_malaria', 8]], tb: [['tb_hiv_malaria', 8]],
  long_covid: [['lri', 1.5]], liver: [['digestive', 4]],
};

function covidWeight(iso, year, age) {
  let base = { 2020: 0.06, 2021: 0.1, 2022: 0.05, 2023: 0.015 }[year] || 0;
  if (iso === 'CHN') base = { 2020: 0.003, 2021: 0.002, 2022: 0.08, 2023: 0.03 }[year] || 0;
  return base * (age >= 60 ? 1.6 : age >= 40 ? 0.8 : age >= 15 ? 0.2 : 0.05);
}

const pickFrom = (R, arr) => arr[Math.floor(R.next() * arr.length) % arr.length];

function causeDetail(id, state, ctx, R, t) {
  const p = state.person || {};
  const age = num(state.age, 0);
  const fe = p.sex === 'female';
  const ig = (ctx && ctx.incomeGroup) || 'UMC';
  const poor = ig === 'LIC' || ig === 'LMC';
  const region = (ctx && ctx.region) || '';
  const flags = p.flags || {};
  switch (id) {
    case 'cvd': return age < 50 ? pickFrom(R, ['突发心脏病', '突发心肌梗死']) : pickFrom(R, ['突发心肌梗死', '脑卒中（中风）', '心力衰竭', '冠心病']);
    case 'cancer': {
      if (age < 25) return pickFrom(R, ['白血病', '淋巴瘤', '脑部肿瘤']);
      const list = ['胃癌', '结直肠癌', '肝癌', '胰腺癌'];
      if (flags.smoker || flags.exSmoker) list.push('肺癌', '肺癌', '肺癌');
      else list.push('肺癌');
      if (fe) list.push('乳腺癌', '乳腺癌', poor ? '宫颈癌' : '卵巢癌');
      else if (age >= 60) list.push('前列腺癌');
      return pickFrom(R, list);
    }
    case 'chronic_resp': return pickFrom(R, ['慢性阻塞性肺疾病（慢阻肺）', '慢阻肺急性加重', '严重哮喘发作']);
    case 'diabetes_kidney': return pickFrom(R, ['糖尿病并发症', '慢性肾衰竭']);
    case 'digestive': return pickFrom(R, ['肝硬化', '消化道出血', '急性胰腺炎']);
    case 'neuro': return age < 50 ? '癫痫发作' : age >= 70 ? pickFrom(R, ['阿尔茨海默病', '阿尔茨海默病', '帕金森病晚期并发症']) : pickFrom(R, ['帕金森病晚期并发症', '运动神经元病']);
    case 'lri': return age < 5 ? '重症肺炎' : pickFrom(R, ['重症肺炎', '流感引发的肺炎']);
    case 'diarrhoea': return poor && age < 5 ? pickFrom(R, ['严重腹泻导致脱水', '不洁饮水引起的肠道感染']) : '严重腹泻导致脱水';
    case 'tb_hiv_malaria': {
      const ssa = region === 'SSA' || safe(() => ctx.region === 'SSA');
      if (ssa && age < 15) return '疟疾';
      if (ssa && age >= 15 && age < 60 && num(state.year, 2000) < 2015) return pickFrom(R, ['艾滋病相关疾病', '结核病', '疟疾']);
      return ssa ? pickFrom(R, ['结核病', '疟疾', '艾滋病相关疾病']) : '结核病';
    }
    case 'neonatal': return age < 1 ? pickFrom(R, ['早产并发症', '出生窒息', '新生儿败血症', '先天性心脏病']) : pickFrom(R, ['先天性心脏病', '先天性疾病']);
    case 'maternal': return pickFrom(R, ['分娩时大出血', '妊娠期高血压并发症', '产后感染']);
    case 'road': return poor ? pickFrom(R, ['摩托车事故', '交通事故', '步行时被车辆撞倒']) : pickFrom(R, ['交通事故', '交通事故', '步行时被车辆撞倒']);
    case 'suicide': return '长期承受心理痛苦';
    case 'violence': return ctx && ctx.conflict >= 2 ? '在战乱中遇难' : '遭遇暴力事件';
    case 'other_injury': {
      if (ctx && Array.isArray(ctx.events) && ctx.events.some((e) => e && e.category === 'disaster')) return pickFrom(R, ['在自然灾害中遇难', '意外事故']);
      if (age >= 70) return '意外跌倒';
      if (age < 15) return pickFrom(R, ['溺水', '意外事故']);
      return pickFrom(R, ['意外事故', '溺水', '火灾', '工作中的意外']);
    }
    case 'covid': return '感染新冠病毒后引发重症肺炎';
    case 'other':
    default:
      if (age >= 85) return pickFrom(R, ['年老体衰，在睡梦中安详离世', '多器官衰竭', '年老体衰']);
      if (age < 5 && poor) return pickFrom(R, ['营养不良相关疾病', '麻疹', '感染性疾病']);
      return pickFrom(R, ['多器官衰竭', '感染性疾病', '血液系统疾病']);
  }
}

/**
 * Sample a cause of death for the person this year (CONTRACT §4): WHO shares by age band × income group (× sex,
 * × era), reweighted by context: armed conflict -> violence, epidemics -> infections, smoking -> cvd/cancer/
 * respiratory, conditions -> their own cause, a birth this year -> maternal, disasters -> injuries, COVID years.
 * Returns {id, name, detail}. ctx is optional (countryContext of the year).
 */
export function sampleCause(data, world, state, rng, ctx) {
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`${state && state.id}|cause|${state && state.year}`));
  const t = causeTable(data);
  const p = (state && state.person) || {};
  const age = Math.max(0, Math.floor(num(state && state.age, 0)));
  const year = num(state && state.year, 2000);
  const iso = p.country;
  const sex = p.sex === 'female' ? 'female' : 'male';
  const ig = (ctx && ctx.incomeGroup) || incomeGroupOf(data, world, iso, year);
  const band = bandIndex(t.bands, age);
  const w = baseShares(t, ig, band, sex, year);
  const idx = {};
  t.ids.forEach((id, i) => { idx[id] = i; });
  const mul = (id, f) => { if (idx[id] != null) w[idx[id]] *= f; };
  const flags = p.flags || {};
  if (flags.smoker === true && age >= 30) { mul('cvd', 1.5); mul('cancer', 1.9); mul('chronic_resp', 2.6); }
  else if (flags.exSmoker && age >= 40) { mul('cvd', 1.2); mul('cancer', 1.4); mul('chronic_resp', 1.6); }
  for (const c of Array.isArray(p.conditions) ? p.conditions : []) {
    const list = c && COND_CAUSE[c.id];
    if (!list) continue;
    const sev = clampN(num(c.severity, 1), 1, 3);
    for (const [cid, f] of list) mul(cid, 1 + (f - 1) * (0.6 + 0.2 * sev));
  }
  const conflict = num(ctx && ctx.conflict, 0);
  // Unrest without a casualty estimate only nudges violence up: a country-wide conflict level says little about how
  // many of this year's deaths it caused (Ukraine 2014–21 or northern Nigeria are a small part of the country).
  if (conflict >= 2) mul('violence', conflict >= 3 ? 1.5 * (sex === 'male' && age >= 15 && age < 60 ? 1.3 : 1) : 1.2);
  for (const h of Array.isArray(state.hazardMods) ? state.hazardMods : []) {
    if (!h || !(num(h.mult, 1) > 1) || (isNum(h.untilYear) && h.untilYear < year)) continue;
    const r = String(h.reason || '');
    if (/战|冲突|轰炸|服役/.test(r)) mul('violence', 4);
    if (/车|交通|骑手|驾驶/.test(r)) mul('road', 3);
    if (/疫|感染|流感|肺炎/.test(r)) mul('lri', 2);
    if (/工地|矿|事故|危险/.test(r)) mul('other_injury', 2.5);
    if (/抑郁|心理|绝望/.test(r)) mul('suicide', 2);
  }
  const evs = ctx && Array.isArray(ctx.events) ? ctx.events : [];
  if (evs.some((e) => e && e.category === 'epidemic')) { mul('lri', 1.6); mul('other', 1.2); mul('tb_hiv_malaria', 1.2); }
  if (evs.some((e) => e && e.category === 'disaster' && Array.isArray(e.countries) && e.countries.includes(iso))) mul('other_injury', 3);
  // maternal deaths need a pregnancy: a birth this year (or late last year), or a partner (a pregnancy not carried to term)
  if (sex === 'female' && age >= 15 && age <= 49) {
    const lb = num(flags.lastBirth, -9);
    const partnered = ['married', 'partnered', 'dating'].includes(p.relationship && p.relationship.status);
    mul('maternal', lb === year ? 12 : lb === year - 1 ? 1 : partnered && !flags.childfree ? 0.3 : 0);
  } else mul('maternal', 0);
  if (year > HISTORY_END) {
    const heat = num(safe(() => world.modifiers(iso, year).heat_risk), 0);
    if (heat > 0) mul('cvd', 1 + 0.1 * heat);
  }
  if (age >= 95) mul('other', 1.3);
  // Wars with a mortality estimate: the excess share of deaths (1 - 1/mult, mostly men of fighting age) is violent.
  // Several research entries often describe the same war, so the largest estimate is used, not their product.
  let warMult = 1;
  for (const e of evs) {
    if (!e || (e.category !== 'war' && e.category !== 'conflict') || !isObj(e.mortality)) continue;
    const ages = Array.isArray(e.mortality.ages) ? e.mortality.ages : [0, 120];
    if (age < num(ages[0], 0) || age > num(ages[1], 120)) continue;
    warMult = Math.max(warMult, eventMortality(e, iso));
  }
  if (warMult > 1 && idx.violence != null) {
    const sexF = age < 15 ? 0.7 : sex === 'male' ? (age < 65 ? 1.4 : 0.9) : 0.6;
    const target = clampN((1 - 1 / warMult) * sexF * 0.85, 0, 0.85);
    const tot = w.reduce((s, x) => s + (isNum(x) && x > 0 ? x : 0), 0);
    const v = Math.max(0, num(w[idx.violence], 0));
    if (tot > 0 && v / tot < target) w[idx.violence] = ((tot - v) * target) / (1 - target);
  }
  const ids = t.ids.slice();
  const weights = w.map((x) => (isNum(x) && x > 0 ? x : 0));
  const cw = covidWeight(iso, year, age);
  if (cw > 0) {
    const tot = weights.reduce((s, x) => s + x, 0);
    ids.push('covid');
    weights.push((tot * cw) / Math.max(0.01, 1 - cw));
  }
  let id = R.weighted(ids, weights);
  if (!id) id = age >= 70 ? 'cvd' : age < 5 ? (idx.neonatal != null ? 'neonatal' : 'other') : 'other';
  const name = t.names[id] || FALLBACK_NAMES[id] || '疾病';
  const c = ctx || { incomeGroup: ig, region: safe(() => data.country(iso).region) || '', conflict, events: evs };
  const detail = causeDetail(id, state, { ...c, region: c.region || safe(() => data.country(iso).region) || '' }, R, t);
  return { id, name, detail };
}

/* ------------------------------------------------------------------ death record */

const EDU_PHRASE = { none: '没有上过学', preschool: '没有上过学', primary: '读到小学', secondary: '读完了中学', vocational: '读过职业学校', tertiary: '读过大学', postgrad: '读到了研究生' };

function exactAge(birthDate, deathDate) {
  const b = parseDate(birthDate);
  const d = parseDate(deathDate);
  if (!b || !d) return null;
  const tb = Date.UTC(b.year, b.month - 1, b.day);
  const td = Date.UTC(d.year, d.month - 1, d.day);
  return (td - tb) / (365.2425 * 86400000);
}
export { exactAge };

/**
 * Date and completed age of a death during the life-year: before the birthday with probability `before/m`
 * (age state.age - 1), else after it (age state.age). Returns {date, age, exact}.
 */
export function deathTiming(state, parts, rng) {
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`${state.id}|timing|${state.year}`));
  const year = num(state.year, 2000);
  const age = Math.max(0, Math.floor(num(state.age, 0)));
  const b = parseDate(state.birth && state.birth.date) || { year: year - age, month: 7, day: 1 };
  const n = daysInYear(year);
  const bd = dayIndexOf(year, b.month, b.day);
  const pBefore = parts && parts.m > 0 ? clampN(parts.before / parts.m, 0, 1) : 0.5;
  let before = age >= 1 && R.chance(pBefore);
  if (bd <= 0) before = false;
  let di;
  if (before) {
    // infant deaths cluster early in life
    const u = age === 1 ? Math.pow(R.next(), 0.6) : R.next();
    di = Math.min(bd - 1, Math.floor(u * bd));
  } else {
    di = bd + Math.floor(R.next() * Math.max(1, n - bd));
  }
  const { month, day } = dateFromDayIndex(year, clampN(di, 0, n - 1));
  const date = formatDate(year, month, day);
  const completed = before ? age - 1 : age;
  const ex = exactAge(state.birth && state.birth.date, date);
  return { date, age: Math.max(0, completed), exact: isNum(ex) ? Math.max(0, ex) : completed + 0.5 };
}

function survivalAt(curve, x) {
  if (!Array.isArray(curve) || !curve.length) return null;
  if (x <= 0) return 1;
  const i = Math.floor(x);
  if (i >= curve.length - 1) return curve[curve.length - 1];
  const a = curve[i];
  const b = curve[i + 1];
  if (!(a > 0)) return 0;
  if (!(b > 0)) return a * (1 - (x - i));
  return a * Math.pow(b / a, x - i);
}

function cname(data, iso) {
  return safe(() => data.country(iso).name) || iso || '';
}

/**
 * DeathRecord (CONTRACT §3): {year, age, date, cause, place, summary, stats, lifeExpAtBirth, percentile}.
 * lifeExpAtBirth is the cohort life expectancy of the birth country/year/sex on this world line (data.cohortLifeExpectancy
 * with world.mortalityMult); percentile is the share of that birth cohort expected to die younger (0..1).
 * opts: {date, age, exact} from deathTiming (computed here when missing).
 */
export function deathRecord(data, world, state, cause, opts = {}) {
  const p = state.person || {};
  const b = state.birth || {};
  const year = num(state.year, 2000);
  const timing = opts && opts.date ? opts : deathTiming(state, null, opts && opts.rng);
  const age = Math.max(0, Math.floor(num(timing.age, num(state.age, 0))));
  const exact = num(timing.exact, age + 0.5);
  const bIso = b.country || p.country;
  const bYear = num(b.year, year - age);
  const sex = p.sex === 'female' ? 'female' : 'male';
  const mult = (yy, a) => num(safe(() => (world && typeof world.mortalityMult === 'function' ? world.mortalityMult(bIso, yy, a) : 1)), 1);
  let le = safe(() => (world && typeof world.cohortLifeExpectancy === 'function' ? world.cohortLifeExpectancy(bIso, bYear, sex) : null));
  if (!isNum(le)) le = safe(() => data.cohortLifeExpectancy(bIso, bYear, sex, mult));
  if (!isNum(le)) le = num(safe(() => data.series(bIso, sex === 'female' ? 'le_f' : 'le_m', bYear)), 70);
  let curve = safe(() => (world && typeof world.cohortSurvival === 'function' ? world.cohortSurvival(bIso, bYear, sex) : null));
  if (!Array.isArray(curve)) curve = safe(() => data.cohortSurvival(bIso, bYear, sex, 0, mult));
  const s = survivalAt(curve, exact);
  const percentile = isNum(s) ? Math.round(clampN(1 - s, 0, 1) * 1000) / 1000 : 0.5;
  const c = cause && typeof cause === 'object' ? cause : { id: 'other', name: '疾病', detail: '' };
  const causeOut = { id: String(c.id || 'other'), name: String(c.name || '疾病'), detail: String(c.detail || '') };
  const place = p.country || bIso;
  const stats = {};
  for (const k of ['health', 'happiness', 'knowledge', 'relationships', 'wealth']) stats[k] = Math.round(clampN(num(state.stats && state.stats[k], 50), 0, 100));
  return {
    year,
    age,
    date: timing.date || `${year}-07-01`,
    cause: causeOut,
    place,
    summary: deathSummary(data, state, causeOut, age, place),
    stats,
    lifeExpAtBirth: Math.round(le * 10) / 10,
    percentile,
  };
}

function deathSummary(data, state, cause, age, place) {
  const p = state.person || {};
  const b = state.birth || {};
  const name = p.name || b.name || '这个人';
  const bc = cname(data, b.country);
  const pc = cname(data, place);
  const year = num(state.year, 2000);
  if (age < 5) {
    return `${name}，${b.year} 年生于${bc}，${age < 1 ? '不满一岁' : `${age} 岁`}时因${cause.name}夭折。这个短暂的生命，曾被家人深深爱过。`;
  }
  const parts = [`${name}，${b.year} 年生于${bc}${place !== b.country ? `，后来在${pc}生活` : ''}。`];
  const edu = EDU_PHRASE[(p.education && p.education.level) || 'none'] || '';
  const c = p.career || {};
  let work = '';
  if (age >= 18) {
    if (c.title) work = `做过${c.title}`;
    else if (c.status === 'homemaker') work = '操持着一个家';
    else if (c.status === 'retired') work = '工作到了退休';
  }
  const kids = (Array.isArray(p.children) ? p.children : []).filter((k) => k && k.alive !== false).length;
  const rel = p.relationship || {};
  const fam = rel.status === 'married' ? '与伴侣相守' : rel.status === 'widowed' ? '晚年丧偶' : '';
  const life = [edu, work, fam].filter(Boolean).join('，');
  if (life) parts.push(`一生${life}。`);
  parts.push(`${year} 年因${cause.name}离世，享年 ${age} 岁${kids > 0 ? `，身后留下 ${kids} 个孩子` : ''}。`);
  return parts.join('');
}
