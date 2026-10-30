// Money: incomes, pensions, savings, portfolios, housing, the wealth stat and local-currency formatting
// (CONTRACT §1 money rule, §4 "Work and money").
//
// All amounts are 2021 international dollars (PPP, real). Display converts to local currency with the country's
// 2021 ppp_factor and labels the result "按2021年物价".
// Pure module: no DOM, no Math.random, no Date.

import { HISTORY_END, INCOME_THRESHOLDS } from './constants.js';
import { Rng, hashString } from './rng.js';
import { normInv } from './person.js';

export const ASSET_KEYS = ['stocks', 'bonds', 'gold', 'property', 'crypto'];
export const ASSET_LABELS = { stocks: '股票', bonds: '储蓄与债券', gold: '黄金', property: '房产', crypto: '加密资产' };

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
const EDU_RANK = { none: 0, preschool: 1, primary: 2, secondary: 3, vocational: 4, tertiary: 5, postgrad: 6 };

/* ------------------------------------------------------------------ indicators */

/** World-line indicator (projection aware) with the raw data series as fallback. */
export function indicator(data, world, iso, key, year) {
  const w = safe(() => (world && typeof world.indicator === 'function' ? world.indicator(iso, key, year) : null));
  if (isNum(w)) return w;
  const d = safe(() => data.series(iso, key, year));
  return isNum(d) ? d : null;
}

export function incomeGroupOf(data, world, iso, year) {
  const g = safe(() => (world && typeof world.incomeGroup === 'function' ? world.incomeGroup(iso, year) : null))
    || safe(() => data.incomeGroup(iso, year));
  return INCOME_THRESHOLDS.some((t) => t.id === g) ? g : 'UMC';
}

const GDP_FALLBACK = { LIC: 1800, LMC: 6500, UMC: 17000, HIC: 52000 };

/** Lognormal sigma for a Gini coefficient (0–100 or 0–1). */
export function giniSigma(gini) {
  const g = isNum(gini) ? (gini > 1 ? gini / 100 : gini) : 0.38;
  return Math.SQRT2 * normInv((clampN(g, 0.15, 0.75) + 1) / 2);
}

/** Mean annual income of earners: country mean consumption (consumption_share × GDP per head) × 1.5. */
export function meanEarnerIncome(data, world, iso, year) {
  let gdp = indicator(data, world, iso, 'gdp_pc_ppp', year);
  if (!isNum(gdp) || gdp <= 0) gdp = GDP_FALLBACK[incomeGroupOf(data, world, iso, year)] || 15000;
  const cs = num(safe(() => data.country(iso).consumption_share), 0.6);
  return Math.max(250, gdp * clampN(cs, 0.25, 1) * 1.5);
}

/** Annual income at a percentile of the country's earner distribution (mean-preserving lognormal from the Gini). */
export function incomeAtPct(data, world, iso, year, pct) {
  const mean = meanEarnerIncome(data, world, iso, year);
  const s = giniSigma(indicator(data, world, iso, 'gini', year));
  return mean * Math.exp(s * normInv(clampN(num(pct, 0.5), 0.01, 0.99)) - (s * s) / 2);
}

export function medianIncome(data, world, iso, year) {
  return incomeAtPct(data, world, iso, year, 0.5);
}

/* ------------------------------------------------------------------ income model */

/** Age–earnings profile by years of work experience (≈ 0.77 at entry, peak ≈ 1.2 after 30 years). */
export function experienceFactor(years) {
  const y = clampN(num(years, 0), 0, 50);
  return Math.exp(0.03 * y - 0.0005 * y * y) / 1.3;
}

const EDU_MULT = { none: 0.9, preschool: 0.9, primary: 0.94, secondary: 1, vocational: 1.04, tertiary: 1.1, postgrad: 1.16 };
/** Education premium on top of the person's percentile; larger where higher education is scarce. */
export function educationFactor(level, terEnroll) {
  const m = EDU_MULT[level] ?? 1;
  if (m <= 1) return m;
  const ter = isNum(terEnroll) ? terEnroll : 35;
  return 1 + (m - 1) * clampN(1.6 - ter / 100, 0.8, 1.6);
}

/** Women's pay relative to men's: wider where female labour-force participation is low; narrows over the decades. */
export function sexFactor(data, world, iso, year, sex) {
  if (sex !== 'female') return 1;
  const flfp = indicator(data, world, iso, 'female_lfp', year);
  const gap = clampN(0.05 + (58 - (isNum(flfp) ? flfp : 50)) / 110, 0.03, 0.32) * clampN(1 - 0.009 * (year - 2000), 0.4, 1.05);
  return 1 - gap;
}

function isFarmer(career) {
  return /农|牧|渔/.test(`${(career && career.sector) || ''}${(career && career.title) || ''}`);
}

/** Retirement pension (annual) when someone stops working now. */
export function pensionFor(data, world, state) {
  const p = state.person;
  const iso = p.country;
  const year = state.year;
  const ig = incomeGroupOf(data, world, iso, year);
  const c = p.career || {};
  const med = medianIncome(data, world, iso, year);
  const informal = c.status === 'self_employed' && (isFarmer(c) || ig === 'LIC' || ig === 'LMC');
  const formal = ['employed', 'military'].includes(c.status) || (c.status === 'self_employed' && !informal) || num(c.years) >= 15;
  const repl = ({ HIC: 0.5, UMC: 0.42, LMC: 0.22, LIC: 0.08 }[ig] || 0.3) * (formal ? 1 : 0.35) * (p.urban || ig === 'HIC' ? 1 : 0.7);
  let last = num(p.money && p.money.income, 0);
  if (!(last > 0) || ['unemployed', 'homemaker', 'unable'].includes(c.status)) {
    last = incomeAtPct(data, world, iso, year, num(c.incomePct, 0.35)) * experienceFactor(num(c.years, 10)) * 0.8;
    if (c.status === 'homemaker') last *= 0.3;
  }
  const floor = ({ HIC: 0.22, UMC: 0.08, LMC: 0.03, LIC: 0 }[ig] || 0) * med;
  return Math.round(Math.max(floor, repl * last));
}

/**
 * Annual income (2021 intl $) for the person's current situation (CONTRACT §4):
 * lognormal(Gini) at incomePct × experience × education × sex gap; benefits for the unemployed / unable
 * where a welfare state exists; pension when retired; 0 for children, students and homemakers.
 */
export function incomeFor(data, world, state) {
  const base = baseIncomeFor(data, world, state);
  const p = state && state.person;
  if (!p || !p.flags || !p.flags.sideIncome || num(state.age, 0) < 14) return base;
  return Math.round(base + sideIncomeOf(p.flags, state.year, medianIncome(data, world, p.country, state.year)));
}
function baseIncomeFor(data, world, state) {
  const p = state && state.person;
  if (!p) return 0;
  const c = p.career || {};
  const iso = p.country;
  const year = state.year;
  const age = num(state.age, 0);
  const ig = incomeGroupOf(data, world, iso, year);
  const med = () => medianIncome(data, world, iso, year);
  const flags = p.flags || {};
  switch (c.status) {
    case 'employed':
    case 'self_employed': {
      const ter = indicator(data, world, iso, 'ter_enroll', year);
      let inc = incomeAtPct(data, world, iso, year, num(c.incomePct, 0.4)) * experienceFactor(c.years)
        * educationFactor(p.education && p.education.level, ter) * sexFactor(data, world, iso, year, p.sex);
      if (flags.partTime) inc *= 0.55;
      if (p.education && p.education.inSchool) inc *= 0.35;
      return Math.round(inc);
    }
    case 'military': {
      const consc = flags.enlisted != null && year - num(flags.enlisted, year) < 3 && !flags.careerSoldier;
      return Math.round(consc ? 0.12 * med() : incomeAtPct(data, world, iso, year, Math.max(num(c.incomePct, 0.4), 0.4)));
    }
    case 'retired':
      return Math.round(num(p.money && p.money.pension, 0) || pensionFor(data, world, state));
    case 'unemployed':
      return Math.round(({ HIC: 0.3, UMC: 0.08, LMC: 0, LIC: 0 }[ig] || 0) * (num(c.years) >= 1 ? 1 : 0.5) * med());
    case 'unable':
      return Math.round(({ HIC: 0.28, UMC: 0.08, LMC: 0.02, LIC: 0 }[ig] || 0) * med());
    default:
      if (flags.workingStudent && age >= 15) return Math.round(0.12 * med());
      return 0;
  }
}

/** Share of income saved, by income percentile, region, age and family (negative = dissaving). */
export function savingsRate(data, world, state) {
  const p = state.person;
  const pct = num(p.career && p.career.incomePct, 0.4);
  const region = safe(() => data.country(p.country).region) || '';
  const ig = incomeGroupOf(data, world, p.country, state.year);
  let s = -0.05 + 0.3 * pct;
  if (region === 'EAS' || region === 'SEA') s += 0.07;
  if (ig === 'HIC') s += 0.02;
  if (ig === 'LIC') s -= 0.03;
  const kids = (p.children || []).filter((k) => k && k.alive !== false && state.year - num(k.birthYear, state.year) < 18).length;
  s -= Math.min(0.08, 0.025 * kids);
  if (p.flags && p.flags.saver) s += 0.06;
  if (p.flags && p.flags.gambler) s -= 0.06;
  if (p.career && p.career.status === 'retired') s = -0.02;
  return clampN(s, -0.2, 0.45);
}

/* ------------------------------------------------------------------ assets */

// US CPI inflation (%), used to turn USD-denominated nominal returns into real returns
const US_CPI = [3.4, 2.8, 1.6, 2.3, 2.7, 3.4, 3.2, 2.8, 3.8, -0.4, 1.6, 3.2, 2.1, 1.5, 1.6, 0.1, 1.3, 2.1, 2.4, 1.8, 1.2, 4.7, 8.0, 4.1, 2.9, 2.7];
const LOCAL_SERIES = { cn_stocks: 'CHN', jp_stocks: 'JPN', in_stocks: 'IND', eu_stocks: 'DEU' };
/** Stock markets a player can name (decisions.investPlanOf); keys of content.econ.asset_returns.series. */
export const INVEST_MARKETS = { us_stocks: '美股（标普500）', cn_stocks: 'A股', jp_stocks: '日股', in_stocks: '印度股市', eu_stocks: '欧洲股市', world_stocks: '全球股市', em_stocks: '新兴市场' };
/**
 * How new savings are split for an investing style the player described in their own words (flags.investStyle):
 * dca 定投指数 / all_in 梭哈 / trader 炒短线 / gold 买黄金 / bonds 买债券. Share = part of spare cash invested each year.
 */
export const INVEST_STYLES = {
  dca: { share: 0.85, w: { stocks: 0.8, bonds: 0.15, gold: 0.05, crypto: 0 } },
  all_in: { share: 0.95, w: { stocks: 0.95, bonds: 0, gold: 0.05, crypto: 0 } },
  trader: { share: 0.8, w: { stocks: 0.9, bonds: 0.1, gold: 0, crypto: 0 } },
  gold: { share: 0.7, w: { stocks: 0, bonds: 0.2, gold: 0.8, crypto: 0 } },
  bonds: { share: 0.75, w: { stocks: 0.1, bonds: 0.85, gold: 0.05, crypto: 0 } },
};
/** Extra yearly income from a side business the player started (flags.sideIncome, in multiples of the median income). */
export function sideIncomeOf(flags, year, med) {
  const k = num(flags && flags.sideIncome, 0);
  if (!(k > 0)) return 0;
  const until = num(flags.sideIncomeUntil, Infinity);
  return year <= until ? Math.min(k, 3) * med : 0;
}
const DIV_YIELD = { cn_stocks: 2.0, jp_stocks: 1.8, in_stocks: 1.3 };
const SIM = {
  // mean of a normal year: crisis years (about 1 in 8 in the world lines, -25%) bring the long-run real average to ~4.5%
  stocks: { mu: 0.08, sd: 0.16 },
  bonds: { mu: 0.012, sd: 0.05 },
  gold: { mu: 0.01, sd: 0.14 },
  property: { mu: 0.012, sd: 0.06 },
  crypto: { mu: 0.04, sd: 0.65 },
  cash: { mu: 0, sd: 0.01 },
};

function branchTilt(world) {
  const out = { stocks: 0, gold: 0, property: 0, crypto: 0 };
  const b = world && isObj(world.branches) ? world.branches : {};
  for (const [dim, br] of Object.entries(b)) {
    const d = String(dim).toLowerCase();
    const v = String(br).toLowerCase();
    if (/ai|tech|automat/.test(d)) {
      if (/transform|fast|rapid|break|boom|accel|surge/.test(v)) { out.stocks += 0.015; out.crypto += 0.05; }
      if (/stall|slow|winter|plateau|restrict|ban/.test(v)) out.stocks -= 0.01;
    }
    if (/geo|conflict|war|order|secur/.test(d)) {
      if (/cold|bloc|frag|conflict|war|tension|split|decoupl|escalat/.test(v)) { out.stocks -= 0.012; out.gold += 0.015; }
      if (/cooperat|multilateral|peace|stable|integr/.test(v)) out.stocks += 0.005;
    }
    if (/clim|warm|carbon/.test(d) && /hot|severe|high|fail|delay|overshoot|worst/.test(v)) out.property -= 0.006;
    if (/econ|growth|debt|financ/.test(d)) {
      if (/crisis|stagn|slow|debt|recess|low/.test(v)) { out.stocks -= 0.012; out.property -= 0.006; out.gold += 0.006; }
      if (/boom|fast|high|strong|renaiss/.test(v)) { out.stocks += 0.01; out.property += 0.004; }
    }
  }
  return out;
}
const tiltCache = new WeakMap();
function tiltOf(world) {
  if (!world || typeof world !== 'object') return { stocks: 0, gold: 0, property: 0, crypto: 0 };
  let t = tiltCache.get(world);
  if (!t) { t = branchTilt(world); tiltCache.set(world, t); }
  return t;
}

function stdNormal(r) {
  let u = r.next();
  if (u <= 1e-12) u = 1e-12;
  const v = r.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Real annual return (fraction) of an asset class in a year (CONTRACT §2 assetReturn(world, assetKey, year, rng)).
 * opts {data, iso3}: with data, 2000–2025 use content.econ.asset_returns (country_market mapping for stocks,
 * converted to real terms with local or US inflation); otherwise and after 2025 the return is simulated per asset,
 * market-wide (the same for every life in the same world line), tilted by the world's economy, AI and geopolitics
 * branches and crashing in years with a severe economic shock. rng is used only when no world is given.
 */
export function assetReturn(world, assetKey, year, rng, opts = {}) {
  const key = ASSET_KEYS.includes(assetKey) || assetKey === 'cash' ? assetKey : 'stocks';
  const data = opts && opts.data;
  const iso = (opts && opts.iso3) || 'USA';
  const y = Math.floor(num(year, 2000));
  if (key === 'crypto' && y < 2011) return 0;
  const ar = data && safe(() => data.content.econ.asset_returns);
  let market = key;
  if (key === 'stocks') {
    const cm = ar && isObj(ar.country_market) ? ar.country_market : {};
    market = typeof cm[iso] === 'string' ? cm[iso] : typeof cm._default === 'string' ? cm._default : 'world_stocks';
    // a market the player chose in their own words (「定投美股」) instead of the home market
    if (typeof opts.market === 'string' && INVEST_MARKETS[opts.market]) market = opts.market;
  }
  if (ar && isObj(ar.series) && Array.isArray(ar.years) && y >= 2000 && y <= 2025) {
    const sk = key === 'stocks' ? market : key === 'bonds' ? 'us_bonds' : key === 'gold' ? 'gold' : key === 'crypto' ? 'bitcoin'
      : key === 'cash' ? 'us_cash' : iso === 'USA' ? 'us_housing' : null;
    const s = sk ? ar.series[sk] : null;
    const idx = ar.years.indexOf(y);
    const v = s && Array.isArray(s.values) && idx >= 0 ? s.values[idx] : null;
    if (isNum(v)) {
      const local = LOCAL_SERIES[sk];
      const infl = local ? num(safe(() => data.series(local, 'inflation', y)), 2) : US_CPI[y - 2000] ?? 2.5;
      const nominal = (v + (DIV_YIELD[sk] || 0)) / 100;
      return clampN((1 + nominal) / (1 + clampN(infl, -5, 60) / 100) - 1, -0.95, 20);
    }
  }
  // simulated: market-wide draw for this world, asset, year and market
  const seed = world && world.seed != null ? world.seed : 'noworld';
  const marketId = key === 'property' ? iso : market;
  const R = world ? new Rng(hashString(`${seed}|asset|${key}|${y}|${marketId}`)) : (rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`asset|${key}|${y}`)));
  const base = SIM[key] || SIM.stocks;
  let mu = base.mu;
  const sd = base.sd;
  const tilt = tiltOf(world);
  if (key in tilt) mu += tilt[key];
  if (key === 'stocks' || key === 'property') {
    const add = num(safe(() => world.modifiers(iso, y).gdp_growth_add), 0);
    mu += (key === 'stocks' ? 0.6 : 0.3) * add / 100;
  }
  if (key === 'property' && data) {
    const g = num(indicator(data, world, iso, 'gdp_growth', y), 2.5);
    mu += clampN(g, -6, 10) * 0.004 - 0.008;
  }
  let shock = 0;
  if (world && y > HISTORY_END) {
    const evs = safe(() => world.events(iso, y)) || [];
    // a crash hits markets in the year the crisis breaks out, not in every year it lasts (markets price it in once)
    if (evs.some((e) => e && e.category === 'economy' && num(e.effects && e.effects.economy) <= -2 && (!isNum(e.year) || e.year === y))) {
      shock = { stocks: -0.25, property: -0.08, gold: 0.1, crypto: -0.4, bonds: 0.02, cash: 0 }[key] || 0;
    }
  }
  const r = mu + sd * stdNormal(R) + shock;
  return clampN(r, key === 'crypto' ? -0.85 : -0.6, key === 'crypto' ? 4 : 1.2);
}

export function portfolioValue(money) {
  const pf = money && isObj(money.portfolio) ? money.portfolio : {};
  let s = 0;
  for (const k of ASSET_KEYS) s += Math.max(0, num(pf[k], 0));
  return s;
}
export function netWorth(money) {
  if (!money) return 0;
  return num(money.cash, 0) + portfolioValue(money) - num(money.debt, 0);
}

/* ------------------------------------------------------------------ retirement */

function parseRetireValue(v, year, from, eduRank) {
  if (isNum(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const segs = v.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
  const seg = segs.length > 1 ? (eduRank >= 5 ? segs[segs.length - 1] : segs[0]) : segs[0] || '';
  const target = /(\d{4})\s*年?\s*(?:到位|完成|全面|实现)/.exec(seg);
  const head = seg.replace(/（[^）]*）|\([^)]*\)/g, '');
  const arrow = /(\d{2})\s*(?:→|->|至|到|－>|=>)\s*(\d{2})/.exec(head);
  if (arrow) {
    const a0 = +arrow[1];
    const a1 = +arrow[2];
    const T = target ? +target[1] : from + 15;
    const k = T > from ? clampN((year - from) / (T - from), 0, 1) : 1;
    return a0 + (a1 - a0) * k;
  }
  const alts = head.split('/').map((s) => (/(\d{2})/.exec(s) || [])[1]).filter(Boolean).map(Number).filter((n) => n >= 40 && n <= 80);
  if (alts.length) return eduRank >= 5 ? alts[alts.length - 1] : alts[0];
  return null;
}

/** Statutory retirement age for this year from lifePath.retirement_age, plus the world line's add-on after 2026. */
export function retirementAgeFor(data, world, iso, year, sex, eduRank = 3) {
  const lp = safe(() => data.lifePath(iso)) || {};
  const list = (Array.isArray(lp.retirement_age) ? lp.retirement_age : []).filter(isObj).slice().sort((a, b) => num(a.from, 0) - num(b.from, 0));
  let entry = null;
  for (const e of list) if (num(e.from, 0) <= year) entry = e;
  if (!entry) entry = list[0] || null;
  const sx = sex === 'female' ? 'female' : 'male';
  let age = entry ? parseRetireValue(entry[sx], year, num(entry.from, 2000), eduRank) : null;
  if (!isNum(age) && entry) age = parseRetireValue(entry[sx === 'male' ? 'female' : 'male'], year, num(entry.from, 2000), eduRank);
  if (!isNum(age)) age = { HIC: 65, UMC: 60, LMC: 60, LIC: 60 }[incomeGroupOf(data, world, iso, year)] || 60;
  const add = year > HISTORY_END ? num(safe(() => world.modifiers(iso, year).retirement_age_add), 0) : 0;
  return Math.round(clampN(age + add, 45, 80));
}

/* ------------------------------------------------------------------ habits (CONTRACT §10) */

export const HABIT_KEYS = ['dining', 'parents', 'travel', 'learning', 'health', 'charity'];
export const HABIT_LABELS = { dining: '聚餐·送礼', parents: '孝亲费', travel: '旅行', learning: '学习投入', health: '健康投入', charity: '捐助' };
export const HABIT_LEVEL_LABELS = ['不花', '一些', '很多'];
// share of the year's income per level
const HABIT_RATE = {
  dining: [0, 0.04, 0.09], parents: [0, 0.06, 0.13], travel: [0, 0.04, 0.1], learning: [0, 0.03, 0.07], health: [0, 0.025, 0.06], charity: [0, 0.02, 0.06],
};
// yearly stat effects per level; the engine applies the difference from what is typical for the person (the
// baseline the simulation is calibrated on), so an ordinary life is neither rewarded nor punished for its habits
const HABIT_FX = {
  dining: [{}, { relationships: 1 }, { relationships: 2.5, happiness: 0.5, health: -0.3 }],
  parents: [{}, { relationships: 0.5, happiness: 0.3 }, { relationships: 1.5, happiness: 0.8 }],
  travel: [{}, { happiness: 1, knowledge: 0.5 }, { happiness: 2, knowledge: 1, relationships: 0.5 }],
  learning: [{}, { knowledge: 1 }, { knowledge: 2 }],
  health: [{}, { health: 0.8 }, { health: 1.6 }],
  charity: [{}, { happiness: 0.8, relationships: 0.5 }, { happiness: 1.2, relationships: 1 }],
};
const HABIT_HINT = {
  dining: '人际↑', parents: '父母更宽裕 人际略↑', travel: '快乐↑ 知识略↑', learning: '知识↑ 晋升略↑', health: '健康↑ 患病风险↓', charity: '快乐略↑ 人际略↑',
};
// regions where adult children commonly give their parents a regular allowance
const FILIAL = new Set(['EAS', 'SEA', 'SAS', 'SSA', 'WAS', 'NAF', 'CAS', 'LAC']);

function anyParentAlive(p) {
  const par = p && isObj(p.parents) ? p.parents : {};
  return ['mother', 'father'].some((r) => isObj(par[r]) && par[r].alive !== false);
}
const habitLevel = (v) => clampN(Math.round(num(v, 0)), 0, 2);

/** The habits an ordinary person in this situation keeps (the calibration baseline; all 0 for minors). */
export function typicalHabits(data, world, state) {
  const p = state.person || {};
  const out = { dining: 0, parents: 0, travel: 0, learning: 0, health: 0, charity: 0 };
  const age = num(state.age, 0);
  if (age < 18) return out;
  const iso = p.country;
  const year = state.year;
  const ig = incomeGroupOf(data, world, iso, year);
  const med = medianIncome(data, world, iso, year);
  const inc = num(p.money && p.money.income, 0);
  const region = safe(() => data.country(iso).region) || '';
  const f = p.flags || {};
  out.dining = 1;
  out.parents = anyParentAlive(p) && age >= 20 && inc > 0 && FILIAL.has(region) ? 1 : 0;
  out.travel = (ig === 'HIC' || ig === 'UMC') && p.urban && inc >= med && num(p.career && p.career.incomePct, 0) >= 0.6 ? 1 : 0;
  out.health = (age >= 50 && inc >= 0.8 * med) || (Array.isArray(p.conditions) && p.conditions.length > 0) ? 1 : 0;
  out.charity = f.volunteer || f.faith ? 1 : 0;
  return out;
}

const TEXTURE_HABITS = {
  steady: { health: 1, learning: 1 },
  adventure: { travel: 1, dining: 1 },
  family: { parents: 1 },
  career: { learning: 1, dining: 1 },
  free: { travel: 1, dining: 1 },
  comfort: { health: 1, travel: 1 },
  giving: { charity: 1, parents: 1 },
};

/** Automatic habit levels for the auto-choose texture (typical levels, nudged by the texture). */
export function autoHabits(data, world, state, texture) {
  const out = typicalHabits(data, world, state);
  if (num(state.age, 0) < 18) return out;
  const add = TEXTURE_HABITS[texture] || {};
  const p = state.person || {};
  const inc = num(p.money && p.money.income, 0);
  const med = medianIncome(data, world, p.country, state.year);
  for (const [k, d] of Object.entries(add)) {
    if (k === 'parents' && !anyParentAlive(p)) continue;
    if (k === 'travel' && inc < 0.6 * med) continue;
    if (k === 'learning' && num(state.age, 0) >= 60) continue;
    out[k] = habitLevel(out[k] + d);
  }
  return out;
}

/**
 * The year's habit plan: for each habit its level, cost (intl $) and the stat effects relative to the typical
 * level. extra = {parents, charity} adds shares of income from the year's focus (照顾父母 / 帮助他人).
 * Returns {items:[{key,label,level,typical,cost,effects,active}], cost, typicalCost, effects, base}.
 */
export function habitPlan(data, world, state, extra = {}) {
  const p = state.person || {};
  const age = num(state.age, 0);
  const levels = isObj(state.habits) ? state.habits : {};
  const typ = typicalHabits(data, world, state);
  const inc = num(p.money && p.money.income, 0);
  const med = medianIncome(data, world, p.country, state.year);
  // what the habits are measured against: the year's income, or a small household allowance without one
  const base = age < 18 ? 0 : inc > 0 ? inc : 0.25 * med;
  const alive = anyParentAlive(p);
  const items = [];
  const effects = { health: 0, happiness: 0, knowledge: 0, relationships: 0 };
  let cost = 0;
  let typicalCost = 0;
  for (const k of HABIT_KEYS) {
    const lv = habitLevel(levels[k]);
    const active = age >= 18 && !(k === 'parents' && !alive);
    const eff = active ? lv : 0;
    const tl = active ? habitLevel(typ[k]) : 0;
    let c = HABIT_RATE[k][eff] * base;
    const tc = HABIT_RATE[k][tl] * base;
    if (k === 'parents' && alive && isNum(extra.parents)) c += extra.parents * base;
    if (k === 'charity' && isNum(extra.charity)) c += extra.charity * base;
    const fx = {};
    for (const s of Object.keys(effects)) {
      const d = num(HABIT_FX[k][eff][s], 0) - num(HABIT_FX[k][tl][s], 0);
      if (d) { fx[s] = d; effects[s] += d; }
    }
    cost += c;
    typicalCost += tc;
    items.push({ key: k, label: HABIT_LABELS[k], level: lv, typical: tl, cost: Math.round(c), effects: fx, active, hint: HABIT_HINT[k] });
  }
  return { items, cost, typicalCost, effects, base };
}

/* ------------------------------------------------------------------ savings allocation */

export const ALLOC_KEYS = ['bank', 'balanced', 'stocks', 'crypto'];
export const ALLOC_LABELS = { bank: '银行储蓄', balanced: '平衡型基金', stocks: '股票指数基金', crypto: '加密资产' };

/** Normalised allocation weights (sum 1) or null for "automatic". */
export function normAllocation(a) {
  if (!isObj(a)) return null;
  const out = {};
  let s = 0;
  for (const k of ALLOC_KEYS) {
    const v = Math.max(0, num(a[k], 0));
    out[k] = v;
    s += v;
  }
  if (!(s > 0)) return null;
  for (const k of ALLOC_KEYS) out[k] = Math.round((out[k] / s) * 1000) / 1000;
  return out;
}

/** Portfolio weights for new savings from an allocation (balanced = 60 % stocks / 40 % bonds; no crypto before 2011). */
function allocWeights(alloc, year) {
  const w = { stocks: alloc.stocks + 0.6 * alloc.balanced, bonds: alloc.bank + 0.4 * alloc.balanced, gold: 0, crypto: alloc.crypto };
  if (year < 2011) {
    w.bonds += w.crypto;
    w.crypto = 0;
  }
  return w;
}

/* ------------------------------------------------------------------ yearly finances */

const HOUSE_K = { HIC: 5.5, UMC: 6, LMC: 5, LIC: 4 };
const DEAR_HOUSING = new Set(['CHN', 'HKG', 'KOR', 'TWN', 'SGP', 'MAC']);

/** Typical price of a home for this person (intl $). */
export function housePrice(data, world, state) {
  const p = state.person;
  const ig = incomeGroupOf(data, world, p.country, state.year);
  let k = HOUSE_K[ig] || 5;
  if (DEAR_HOUSING.has(p.country) && p.urban && state.year >= 2008) k *= 1.6;
  return medianIncome(data, world, p.country, state.year) * k * (p.urban ? 1 : 0.35);
}

function sellLiquid(money, need) {
  const pf = money.portfolio;
  let left = need;
  for (const k of ['bonds', 'stocks', 'gold', 'crypto']) {
    if (left <= 0) break;
    const v = Math.max(0, num(pf[k], 0));
    const take = Math.min(v, left);
    pf[k] = v - take;
    left -= take;
  }
  return need - left;
}

function round2(x) {
  return Math.round(x);
}

/**
 * One year of money for a living person: income, saving or dissaving, debt service, investing, asset returns
 * and (sometimes) buying a home. Mutates state.person.money and returns LogEntry-like notes
 * ({kind, text, tone, tags, headline}) for the engine to log.
 */
export function updateFinances(data, world, state, rng, opts = {}) {
  const p = state.person;
  const m = p.money || (p.money = { cash: 0, debt: 0, income: 0, portfolio: {} });
  if (!isObj(m.portfolio)) m.portfolio = {};
  for (const k of ASSET_KEYS) m.portfolio[k] = Math.max(0, num(m.portfolio[k], 0));
  m.cash = num(m.cash, 0);
  m.debt = Math.max(0, num(m.debt, 0));
  const notes = [];
  const iso = p.country;
  const year = state.year;
  const age = num(state.age, 0);
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`${state.id}|fin|${year}`));
  const ig = incomeGroupOf(data, world, iso, year);
  const med = medianIncome(data, world, iso, year);

  // income (self-employed and farmers carry more year-to-year luck)
  let income = incomeFor(data, world, state);
  const c = p.career || {};
  if (c.status === 'self_employed') income *= Math.exp(clampN(R.normal(0, isFarmer(c) ? 0.12 : 0.2), -0.6, 0.6));
  if (isNum(opts.incomeMult)) income *= clampN(opts.incomeMult, 0.2, 2);
  m.income = Math.max(0, round2(income));

  // the year's focus (CONTRACT §10): 攒钱理财 saves more, 放慢脚步 a little less; 照顾父母 / 帮助他人 spend on others
  const mods = isObj(opts.mods) ? opts.mods : {};
  const saveAdd = clampN(num(mods.save, 0), -0.1, 0.15);

  // saving / dissaving
  if (age >= 16 && m.income > 0) {
    let save = m.income * clampN(savingsRate(data, world, state) + saveAdd, -0.25, 0.55);
    if (p.flags && p.flags.homeowner && m.portfolio.property > 0) save += Math.min(0.02 * m.portfolio.property, 0.3 * m.income);
    m.cash += save;
  } else if (age >= 25 && m.income <= 0 && !['homemaker', 'student'].includes(c.status)) {
    const partner = p.relationship && ['married', 'partnered'].includes(p.relationship.status);
    if (!partner) m.cash -= Math.min(0.08 * med, Math.max(0, m.cash) * 0.2 + 0.02 * med);
  }

  // habits (CONTRACT §10): levels the player did not set follow the auto-choose texture; spending above (below) what
  // is typical comes out of (goes into) savings, and the stat effects are the difference from the typical habits
  if (!isObj(state.habits)) state.habits = { dining: 0, parents: 0, travel: 0, learning: 0, health: 0, charity: 0 };
  const lock = isObj(state.habitLock) ? state.habitLock : {};
  const auto = autoHabits(data, world, state, typeof opts.texture === 'string' ? opts.texture : 'normal');
  for (const k of HABIT_KEYS) {
    if (lock[k] !== true) state.habits[k] = auto[k];
    else state.habits[k] = habitLevel(state.habits[k]);
  }
  if (age >= 18) {
    const plan = habitPlan(data, world, state, { parents: num(mods.spendParents, 0), charity: num(mods.spendCharity, 0) });
    let delta = plan.cost - plan.typicalCost;
    // people cannot spend what they do not have: extra spending is capped by the year's income and a slice of savings
    let scale = 1;
    if (delta > 0) {
      const room = Math.max(0, m.income * 0.45) + Math.max(0, m.cash) * 0.25;
      if (delta > room) scale = room > 0 ? room / delta : 0;
      delta *= scale;
    }
    m.cash -= delta;
    const st = state.stats;
    if (isObj(st)) {
      for (const [k, v] of Object.entries(plan.effects)) {
        if (!v) continue;
        let d = v * (v > 0 ? scale : 1);
        if (k === 'knowledge' && d > 0) d *= clampN((100 - num(st.knowledge, 50)) / 40, 0.04, 1);
        st[k] = clampN(num(st[k], 50) + d, 0, 100);
      }
    }
  }

  // debt service (real interest ≈ 4 %)
  if (m.debt > 0) {
    m.debt *= 1.04;
    // repayments come from savings plus a cut in spending of up to 20 % of income (people tighten their belts)
    const capacity = Math.max(0, m.cash) + 0.2 * m.income;
    const pay = Math.min(m.debt, capacity, Math.max(m.debt * 0.1, 0.2 * m.income));
    m.cash = Math.max(0, m.cash - pay);
    m.debt -= pay;
    if (m.debt < 1) m.debt = 0;
  }

  // shortfall: sell liquid assets, then borrow
  if (m.cash < 0) {
    const got = sellLiquid(m, -m.cash);
    m.cash += got;
    if (m.cash < 0) {
      m.debt += -m.cash;
      m.cash = 0;
    }
  }
  // cap runaway debt for people with no income (informal support from family / write-offs)
  const debtCap = Math.max(2 * med, 3 * m.income) + 0.7 * m.portfolio.property;
  if (m.debt > debtCap) m.debt = debtCap;

  // buy a home
  const flags = p.flags || (p.flags = {});
  if (flags.homeowner && m.portfolio.property <= 0) {
    const price = housePrice(data, world, state);
    m.portfolio.property = price;
    m.debt += price * 0.6;
  } else if (!flags.homeowner && age >= 25 && age <= 58 && m.income > 0.5 * med && m.portfolio.property <= 0) {
    const couple = p.relationship && ['married', 'partnered'].includes(p.relationship.status);
    if (couple || age >= 30) {
      const price = housePrice(data, world, state);
      const share = ig === 'LIC' || ig === 'LMC' ? 0.5 : 0.3;
      const need = price * share;
      const liquid = m.cash + m.portfolio.stocks + m.portfolio.bonds + m.portfolio.gold + m.portfolio.crypto;
      if (liquid >= need * 1.15 && R.chance(0.55)) {
        let left = need;
        const fromCash = Math.min(m.cash, left);
        m.cash -= fromCash;
        left -= fromCash;
        if (left > 0) sellLiquid(m, left);
        m.portfolio.property = price;
        const loan = price - need;
        m.debt += loan;
        flags.homeowner = year;
        if (loan > 0) flags.mortgage = year;
        notes.push({
          kind: 'milestone', tone: 2, tags: ['success', 'money'], tag: 'success', headline: '买了房',
          // with a mortgage the events library tells the "keys to an empty living room" moment, so it is not told here
          text: p.urban ? (loan > 0 ? '你买下了属于自己的房子，也背上了一笔要还很多年的房贷。签完合同，你在楼下站了好一会儿，才想起该给家里打个电话。'
            : '你买下了属于自己的房子。拿到钥匙那天，你在空荡荡的客厅里坐了很久。')
            : `你在老家盖起了新房${loan > 0 ? '，借的钱要慢慢还' : ''}。上梁那天，亲戚邻居都来帮忙。`,
        });
      }
    }
  }

  // invest surplus cash
  const buffer = Math.max(0.5 * m.income, 0.25 * med);
  if (m.cash > buffer + 0.1 * med && age >= 18) {
    const excess = m.cash - buffer;
    const style = INVEST_STYLES[flags.investStyle] || null;
    const k = style ? style.share : ig === 'HIC' || ig === 'UMC' ? 0.6 : 0.4;
    const amt = excess * k;
    m.cash -= amt;
    const eduR = EDU_RANK[p.education && p.education.level] ?? 2;
    const markets = (ig === 'HIC' || ig === 'UMC') && (p.urban || eduR >= 5);
    // the player's allocation (银行储蓄 / 平衡型基金 / 股票指数基金 / 加密资产) steers new savings; null = automatic
    const alloc = normAllocation(m.allocation);
    const w = alloc ? allocWeights(alloc, year) : style ? style.w : markets
      ? { stocks: flags.investor ? 0.65 : 0.45, bonds: 0.38, gold: 0.08, crypto: year >= 2016 && (flags.crypto || (age < 45 && eduR >= 5 && flags.investor)) ? 0.07 : 0 }
      : { stocks: eduR >= 5 && p.urban ? 0.15 : 0, bonds: 0.55, gold: 0.3, crypto: 0 };
    const tot = w.stocks + w.bonds + w.gold + w.crypto;
    for (const a of ['stocks', 'bonds', 'gold', 'crypto']) m.portfolio[a] += (amt * w[a]) / tot;
  }

  // asset returns
  const before = m.portfolio.stocks + m.portfolio.bonds + m.portfolio.gold + m.portfolio.crypto;
  const stocksBefore = m.portfolio.stocks;
  let stockR = null;
  for (const a of ASSET_KEYS) {
    const v = m.portfolio[a];
    if (v <= 0) continue;
    let r = assetReturn(world, a, year, R, { data, iso3: iso, market: a === 'stocks' ? flags.investMarket : undefined });
    // short-term trading: fees and bad timing cost a few points a year on average, and the swings are wider
    if (a === 'stocks' && flags.investStyle === 'trader') r += -0.04 + clampN(R.normal(0, 0.12), -0.3, 0.3);
    if (a === 'stocks') stockR = r;
    if (a === 'property') r += clampN(R.normal(0, 0.03), -0.1, 0.1);
    m.portfolio[a] = Math.max(0, v * (1 + r));
  }
  const after = m.portfolio.stocks + m.portfolio.bonds + m.portfolio.gold + m.portfolio.crypto;
  if (before > Math.max(med, m.income) && before > 0) {
    const ch = after / before - 1;
    // the market the player chose by name gets its own line in a big year (「这一年美股（标普500）跌了约 37%」)
    const mk = INVEST_MARKETS[flags.investMarket];
    if (mk && isNum(stockR) && Math.abs(stockR) >= 0.15 && stocksBefore > 0.5 * before) {
      const pct = Math.round(Math.abs(stockR) * 100);
      notes.push(stockR < 0
        ? { kind: 'milestone', tone: -1, tags: ['crisis', 'money'], tag: 'crisis', headline: '股市下跌', text: `这一年${mk}跌了约 ${pct}%（扣除通胀）。${flags.investStyle === 'dca' ? '你没有停掉定投，跌下去的时候，同样的钱买到了更多份额。' : flags.investStyle === 'trader' ? '你割肉、抄底、再割肉，账户越做越薄。' : '你看着账户缩水，咬着牙没有卖。'}` }
        : { kind: 'milestone', tone: 1, tags: ['success', 'money'], tag: 'success', headline: '股市上涨', text: `这一年${mk}涨了约 ${pct}%（扣除通胀）。${flags.investStyle === 'dca' ? '你一直在定投，这一年账户涨得让你有点不敢相信。' : '你的账户跟着涨了一大截。'}` });
    } else if (ch <= -0.22) notes.push({ kind: 'milestone', tone: -1, tags: ['crisis', 'money'], tag: 'crisis', headline: '投资缩水', text: `这一年市场动荡，你的投资缩水了大约 ${Math.round(-ch * 100)}%。你告诉自己，钱是慢慢挣回来的。` });
    else if (ch >= 0.3) notes.push({ kind: 'milestone', tone: 1, tags: ['success', 'money'], tag: 'success', headline: '投资大涨', text: `这一年行情很好，你的投资涨了大约 ${Math.round(ch * 100)}%。` });
  }

  // tidy
  m.cash = round2(Math.max(0, m.cash));
  m.debt = round2(Math.max(0, m.debt));
  for (const a of ASSET_KEYS) m.portfolio[a] = round2(m.portfolio[a]);
  if (!isNum(m.pension)) delete m.pension;
  return notes;
}

/* ------------------------------------------------------------------ where a year's income goes (estimate) */

/**
 * 一年收入的去向（估算）: the same rules as updateFinances, read without changing anything.
 * opts.mods = the year's focus mods. Returns {income, items:[{key,label,amount,share}], deficit, note?}; the amounts
 * add up to the income (minus the deficit when spending runs above it).
 */
export function incomeBreakdownOf(data, world, state, opts = {}) {
  const p = (state && state.person) || {};
  const m = p.money || {};
  const income = Math.max(0, Math.round(num(m.income, 0)));
  const age = num(state && state.age, 0);
  if (!(income > 0) || age < 16) {
    return { income: 0, items: [], deficit: 0, note: age < 18 ? '还没有自己的收入，吃穿用度都靠家里。' : '这一年没有收入，日子靠积蓄和家人支撑。' };
  }
  const mods = isObj(opts.mods) ? opts.mods : {};
  const rate = clampN(savingsRate(data, world, state) + clampN(num(mods.save, 0), -0.1, 0.15), -0.25, 0.55);
  const plan = habitPlan(data, world, state, { parents: num(mods.spendParents, 0), charity: num(mods.spendCharity, 0) });
  const savings = income * rate - (plan.cost - plan.typicalCost);
  const ig = incomeGroupOf(data, world, p.country, state.year);
  const f = p.flags || {};
  const owner = !!f.homeowner && num(m.portfolio && m.portfolio.property, 0) > 0;
  const rentShare = owner ? 0.03 : p.urban ? (ig === 'HIC' ? 0.25 : ig === 'UMC' ? 0.2 : 0.15) : 0.06;
  const housing = rentShare * income;
  const debt = num(m.debt, 0);
  const debtDue = debt > 0 ? Math.min(debt, Math.max(debt * 0.1, 0.2 * income)) : 0;
  const debtPay = Math.min(debtDue, Math.max(0, savings) + 0.2 * income);
  const saved = Math.max(0, savings - debtPay);
  const fromLiving = Math.max(0, debtPay - Math.max(0, savings));
  let living = income - Math.max(0, savings) - housing - plan.cost - fromLiving;
  let deficit = 0;
  if (living < 0) {
    deficit = -living;
    living = 0;
  }
  const raw = [
    { key: 'living', label: '吃穿用度', amount: living },
    { key: 'housing', label: owner ? '住房维护' : '房租与住房', amount: housing },
  ];
  for (const it of plan.items) if (it.cost > 0) raw.push({ key: it.key, label: it.label, amount: it.cost });
  if (debtPay > 0) raw.push({ key: 'debt', label: owner && f.mortgage ? '还房贷' : '还债', amount: debtPay });
  raw.push({ key: 'savings', label: '存下与投资', amount: saved });
  const items = raw.filter((x) => x.amount >= 0.5).map((x) => ({ ...x, amount: Math.round(x.amount), share: Math.round((x.amount / income) * 1000) / 1000 }));
  return { income, items, deficit: Math.round(deficit) };
}

/* ------------------------------------------------------------------ investment options */

/** Long-run expected real return of an asset on the world line (the simulation's mean, no peeking at draws). */
export function expectedReturn(world, key, iso, year) {
  const tilt = tiltOf(world);
  const base = SIM[key] || SIM.stocks;
  let mu = base.mu + (key in tilt ? tilt[key] : 0);
  if (key === 'stocks') mu += (0.6 * num(safe(() => world.modifiers(iso, year).gdp_growth_add), 0)) / 100;
  return mu;
}

const pctText = (x) => `${x >= 0 ? '+' : '-'}${Math.abs(Math.round(x * 1000) / 10).toFixed(1)}%`;

/**
 * The four places new savings can go (CONTRACT §10 investOptions): label, a hint with the real returns the person
 * could have known (the years before this one, 2000–2025 real data; the world line's expectation afterwards),
 * availability, and the current weight when an allocation is set.
 */
export function investChoices(data, world, state) {
  const p = (state && state.person) || {};
  const iso = p.country || 'USA';
  const year = Math.floor(num(state && state.year, 2000));
  const alloc = normAllocation(p.money && p.money.allocation);
  const last = Math.min(2025, year - 1);
  const ret = (k, y) => num(assetReturn(world, k, y, null, { data, iso3: iso }), 0);
  const series = {
    bank: (y) => ret('bonds', y),
    stocks: (y) => ret('stocks', y),
    balanced: (y) => 0.6 * ret('stocks', y) + 0.4 * ret('bonds', y),
    crypto: (y) => ret('crypto', y),
  };
  const VOL = { bank: '很少亏损', balanced: '有起有落', stocks: '大起大落', crypto: '暴涨暴跌' };
  const out = [];
  for (const id of ALLOC_KEYS) {
    const from = id === 'crypto' ? 2011 : 2000;
    const item = { id, label: ALLOC_LABELS[id], hint: '', available: true, expected: null, worst: null, weight: alloc ? alloc[id] : null };
    if (id === 'crypto' && year < 2011) {
      item.available = false;
      item.hint = '这时还没有出现';
      out.push(item);
      continue;
    }
    if (year <= 2026 && last - from + 1 >= 3) {
      let lg = 0;
      let n = 0;
      let worst = Infinity;
      for (let y = from; y <= last; y++) {
        const r = clampN(series[id](y), -0.95, 20);
        lg += Math.log(1 + r);
        n++;
        worst = Math.min(worst, r);
      }
      item.expected = Math.round((Math.exp(lg / n) - 1) * 1000) / 1000;
      item.worst = Math.round(worst * 1000) / 1000;
      item.hint = `过去${n}年年均实际约${pctText(item.expected)}，${VOL[id]}${item.worst < -0.15 ? `，最差一年${pctText(item.worst)}` : ''}`;
    } else {
      const e = id === 'bank' ? expectedReturn(world, 'bonds', iso, year) : id === 'balanced'
        ? 0.6 * expectedReturn(world, 'stocks', iso, year) + 0.4 * expectedReturn(world, 'bonds', iso, year)
        : expectedReturn(world, id, iso, year);
      item.expected = Math.round(e * 1000) / 1000;
      item.hint = `${year > 2026 ? '按世界线推演，' : '长期看'}年均约${pctText(item.expected)}，${VOL[id]}`;
    }
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ wealth stat */

/**
 * Wealth stat 0..100 from net worth relative to the country's median annual income on a log scale
 * (0 net worth ≈ 30, one year of median income ≈ 44, seven years ≈ 72, 31 years ≈ 100).
 * Children take their family's position; young adults move from the family's to their own.
 */
export function wealthStat(data, world, state) {
  const p = state.person;
  const age = num(state.age, 0);
  const famPct = clampN(num(p.familyPct, 0.5), 0, 1);
  const fam = 8 + 84 * famPct;
  if (age < 18) return Math.round(fam * 10) / 10;
  const m = p.money || {};
  const med = Math.max(100, medianIncome(data, world, p.country, state.year));
  const r = netWorth(m) / med;
  let own = r >= 0 ? 30 + 14 * Math.log2(1 + r) : 30 - (25 * -r) / (1 + -r);
  const inc = num(m.income, 0);
  if (inc > 0) own += clampN(5 * Math.log2(inc / med), -6, 8);
  else if (age < 65) own -= 3;
  const w = age >= 28 ? 1 : (age - 18) / 10;
  return Math.round(clampN(fam * (1 - w) + own * w, 0, 100) * 10) / 10;
}

/* ------------------------------------------------------------------ formatting */

const SIGN_CHARS = /[$¥€£₹₦₩₽₱₫฿₺₴₪₸₵₲₡₭₮₾₼֏₿៛৳؋﷼]/;

function group3(n) {
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}
const trim0 = (s) => s.replace(/\.0(?=\D|$)/, '');

/** Chinese large-number units: 9,999 / 1.2万 / 35万 / 3.4亿 / 1.2万亿 (no sign). */
export function cnAmount(v) {
  const a = Math.abs(num(v, 0));
  if (a >= 1e12) return `${trim0((a / 1e12).toFixed(1))}万亿`;
  if (a >= 1e8) return `${trim0((a / 1e8).toFixed(a >= 1e9 ? 0 : 1))}亿`;
  if (a >= 1e4) return `${trim0((a / 1e4).toFixed(a >= 1e5 ? 0 : 1))}万`;
  return group3(a);
}

/** Amount in international dollars, e.g. "1.2万 国际元". */
export function formatIntl(amount) {
  if (!isNum(amount)) return '—';
  return `${amount < 0 ? '-' : ''}${cnAmount(amount)} 国际元`;
}

/**
 * Local-currency text for an amount stored in 2021 international dollars:
 * amount × 2021 ppp_factor, with the currency symbol in front ("¥4万", "$1,234", "₦31万") or the currency name
 * after it ("1.2万日元"). Falls back to international dollars. opts.note appends "（按2021年物价）".
 */
export function formatMoney(data, iso3, amountIntl, opts = {}) {
  if (!isNum(amountIntl)) return '—';
  const sign = amountIntl < 0 ? '-' : '';
  let factor = safe(() => data.series(iso3, 'ppp_factor', 2021));
  if (!isNum(factor) || factor <= 0) factor = safe(() => data.series(iso3, 'ppp_factor', 2024));
  const cur = safe(() => data.currency(iso3));
  let text;
  if (isNum(factor) && factor > 0 && cur && (cur.symbol || cur.name)) {
    const v = Math.abs(amountIntl * factor);
    const amt = cnAmount(v);
    const sym = typeof cur.symbol === 'string' ? cur.symbol.trim() : '';
    if (sym && sym.length <= 4 && SIGN_CHARS.test(sym)) text = `${sign}${sym}${amt}`;
    else {
      const name = String(cur.name || cur.code || sym || '本地货币');
      text = `${sign}${amt}${/^[A-Za-z]/.test(name) ? ' ' : ''}${name}`;
    }
  } else {
    text = formatIntl(amountIntl);
  }
  return opts && opts.note ? `${text}（按2021年物价）` : text;
}
