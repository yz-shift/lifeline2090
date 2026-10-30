// The life engine (CONTRACT §2–§4): newLife, stepYear, applyResolution, survivalCurve, countryContext.
//
// One stepYear = one calendar year. Order inside a year:
//   relatives age (parents, partner, children; deaths) -> threads that come due -> education -> work ->
//   love, marriage and children -> health (conditions, smoking) -> natural drift of the stats ->
//   world events (scaled by vulnerability; the top one logged as news) -> personal events (events.js) ->
//   money (economy.js) -> mortality (death.js) -> milestone / triggered decision (decisions.js) -> history row.
// The engine only raises the offline decision (state.pending); the UI/director may replace it with an AI one.
// State is plain JSON; every random draw comes from the Rng stored in state.rng, so a saved life resumes exactly.
// Pure module: no DOM, no Math.random, no Date.now.

import { HISTORY_END, MAX_AGE, STATS, YEAR_TAGS, EDU_LEVELS, CAREER_STATUS, RELATIONSHIP_LABELS, EDU_LABELS } from './constants.js';
import { Rng, hashString } from './rng.js';
import { normalizeBirth, childName, guessSurname, normInv, normCdf, makeName } from './person.js';
import * as econ from './economy.js';
import { hazardFor, sampleCause, deathRecord, deathTiming, expectedHealth, smokingPrevalence, personalMultiplier, modsMultiplier } from './death.js';
import * as EVM from './events.js';
import { pickPersonalEvents, personName, keyExams } from './events.js';
import * as DEC from './decisions.js';
import { nextDecisionAge, buildDecisionOffline, triggeredDecision } from './decisions.js';
import { makeCohort, simulateLife } from './cohort.js';
import { eventMortality } from './world.js';
import {
  FOCUS_IDS, FOCUS_NAMES, FOCUS_MIN_AGE, TEXTURES, TEXTURE_IDS, textureOf, stageOf, focusSituation, focusSpec, focusList, focusFits,
  autoFocus, modValue, streakLine,
} from './focus.js';
import { pickSmallChoice, smallOption, autoSmallOption, smallResult, petName } from './smallchoices.js';
import { rollRare } from './rare.js';

/* ------------------------------------------------------------------ helpers */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (isNum(v) ? v : d);
const r1 = (x) => Math.round(x * 10) / 10;
function safe(fn, fb = null) {
  try {
    const v = fn();
    return v === undefined || v === null ? fb : v;
  } catch {
    return fb;
  }
}
const EDU_RANK = { none: 0, preschool: 1, primary: 2, secondary: 3, vocational: 4, tertiary: 5, postgrad: 6 };
const REL_STATUS = Object.keys(RELATIONSHIP_LABELS);
const TAGSET = new Set(YEAR_TAGS);
const OPT_IDS = ['a', 'b', 'c', 'd'];
const DEFAULT_SETTINGS = {
  lifeMinutes: 30, aiMode: 'default', decisionFreq: 'standard', autoChoose: false,
  autoTexture: 'normal', gentle: false, music: false, reflections: true, compareIso: null, compareYear: null,
};
export const REFLECT_AGES = [5, 15, 30, 50, 70];
export const MAX_STARS = 12;
const NOTE_MAX = 200;
const HELP_LINE = '如果你或身边的人也正承受着这样的痛苦，请联系当地的心理援助热线，或告诉一个你信任的人。';
const MAX_THREADS = 40;
const STAT_EFFECT_KEYS = ['health', 'happiness', 'knowledge', 'relationships'];

function cname(data, iso) {
  return safe(() => data.country(iso).name) || iso || '';
}
const zhNum = (n) => ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'][n] || String(n);

/* ------------------------------------------------------------------ country context */

const ctxCache = new WeakMap();
const NO_WORLD = {};

function buildContext(data, world, iso3, year) {
  const C = safe(() => data.country(iso3)) || {};
  const ind = (k) => econ.indicator(data, world, iso3, k, year);
  const events = (safe(() => (world && typeof world.events === 'function' ? world.events(iso3, year) : [])) || []).filter(Boolean);
  let conflict = 0;
  for (const ev of events) {
    if (ev.category !== 'war' && ev.category !== 'conflict') continue;
    const severe = num(ev.effects && ev.effects.safety, -2) <= -2;
    const cs = Array.isArray(ev.countries) ? ev.countries : [];
    // 3 = a war that reaches the whole country (a national casualty estimate of +10 % deaths or more, or an event
    // of the highest importance); an insurgency or cartel war in some provinces is 2, not a war in every home
    const nationwide = eventMortality(ev, iso3) >= 1.1 || num(ev.importance, 2) >= 5;
    if (cs[0] === iso3 && severe) conflict = Math.max(conflict, nationwide ? 3 : 2);
    // other listed countries are a party with casualties of their own (2) or neighbours taking in refugees (1)
    else if (cs.includes(iso3)) conflict = Math.max(conflict, severe && (eventMortality(ev, iso3) > 1 || !ev.mortality) ? 2 : 1);
    else if (ev.scope === 'regions' && Array.isArray(ev.regions) && ev.regions.includes(C.region)) conflict = Math.max(conflict, 1);
  }
  return {
    iso3,
    year,
    country: C.name || iso3,
    region: C.region || '',
    incomeGroup: econ.incomeGroupOf(data, world, iso3, year),
    gdp: ind('gdp_pc_ppp'),
    gdpGrowth: ind('gdp_growth'),
    unemployment: ind('unemployment'),
    youthUnemp: ind('youth_unemp'),
    gini: ind('gini'),
    poverty: ind('poverty'),
    internet: ind('internet'),
    urban: ind('urban'),
    secEnroll: ind('sec_enroll'),
    terEnroll: ind('ter_enroll'),
    lifeExp: ind('le'),
    tfr: ind('tfr'),
    medAge: ind('med_age'),
    conflict,
    events,
    projection: year > HISTORY_END,
    femaleLfp: ind('female_lfp'),
    mac: ind('mac'),
    imr: ind('imr'),
  };
}

/** Context for a country-year (CONTRACT §3), cached per world. Never throws. */
export function countryContext(data, world, iso3, year) {
  const w = world && typeof world === 'object' ? world : NO_WORLD;
  let m = ctxCache.get(w);
  if (!m) {
    m = new Map();
    ctxCache.set(w, m);
  }
  const y = Math.floor(num(+year, 2000));
  const key = `${iso3}|${y}`;
  let c = m.get(key);
  if (c) return c;
  if (m.size > 6000) m.clear();
  try {
    c = buildContext(data, world === NO_WORLD ? null : world, iso3, y);
  } catch {
    c = { iso3, year: y, country: iso3, region: '', incomeGroup: 'UMC', gdp: null, gdpGrowth: null, unemployment: null, youthUnemp: null,
      gini: null, poverty: null, internet: null, urban: null, secEnroll: null, terEnroll: null, lifeExp: null, tfr: null, medAge: null,
      conflict: 0, events: [], projection: y > HISTORY_END };
  }
  m.set(key, c);
  return c;
}

/* ------------------------------------------------------------------ state repair */

function normSettings(s) {
  const o = { ...DEFAULT_SETTINGS };
  if (isObj(s)) {
    if (isNum(s.lifeMinutes) && s.lifeMinutes > 0) o.lifeMinutes = s.lifeMinutes;
    if (['off', 'quick', 'default', 'complex'].includes(s.aiMode)) o.aiMode = s.aiMode;
    if (['sparse', 'standard', 'frequent'].includes(s.decisionFreq)) o.decisionFreq = s.decisionFreq;
    if (typeof s.autoChoose === 'boolean') o.autoChoose = s.autoChoose;
    if (s.headless === true) o.headless = true;
    if (s.cohort === false) o.cohort = false;
  }
  return normExtraSettings(o, isObj(s) ? s : {});
}

/** The interactivity settings (CONTRACT §10), validated in place; `src` supplies values to copy (defaults: o itself). */
function normExtraSettings(o, src = o) {
  o.autoTexture = TEXTURE_IDS.includes(src.autoTexture) ? src.autoTexture : TEXTURE_IDS.includes(o.autoTexture) ? o.autoTexture : 'normal';
  o.gentle = typeof src.gentle === 'boolean' ? src.gentle : o.gentle === true;
  o.music = typeof src.music === 'boolean' ? src.music : o.music === true;
  o.reflections = typeof src.reflections === 'boolean' ? src.reflections : o.reflections !== false;
  const iso = typeof src.compareIso === 'string' ? src.compareIso : o.compareIso;
  o.compareIso = typeof iso === 'string' && /^[A-Z]{3}$/.test(iso) ? iso : null;
  const cy = isNum(src.compareYear) ? src.compareYear : o.compareYear;
  o.compareYear = isNum(cy) ? clampN(Math.round(cy), 1950, 2100) : null;
  return o;
}

const emptyPortfolio = () => ({ stocks: 0, bonds: 0, gold: 0, property: 0, crypto: 0 });

/** Repair a (possibly hand- or AI-edited) state in place so the engine can always run. */
function ensureState(state) {
  const b = isObj(state.birth) ? state.birth : (state.birth = {});
  if (!isObj(state.settings)) state.settings = { ...DEFAULT_SETTINGS };
  if (!isObj(state.person)) state.person = {};
  const p = state.person;
  if (!isNum(state.year)) state.year = num(b.year, 2000);
  if (!isNum(state.age)) state.age = Math.max(0, state.year - num(b.year, state.year));
  if (typeof p.name !== 'string') p.name = b.name || '无名';
  if (p.sex !== 'male' && p.sex !== 'female') p.sex = b.sex === 'female' ? 'female' : 'male';
  if (typeof p.country !== 'string' || !p.country) p.country = b.country || 'CHN';
  if (typeof p.urban !== 'boolean') p.urban = !!b.urban;
  if (!isNum(p.familyPct)) p.familyPct = num(b.familyPct, 0.5);
  if (!isObj(p.education)) p.education = {};
  const e = p.education;
  if (!EDU_LEVELS.includes(e.level)) e.level = 'none';
  e.inSchool = !!e.inSchool;
  if (e.field !== null && typeof e.field !== 'string') e.field = null;
  if (!isNum(e.years)) e.years = 0;
  if (!Array.isArray(e.exams)) e.exams = [];
  if (!isObj(p.career)) p.career = {};
  const c = p.career;
  if (!CAREER_STATUS.includes(c.status)) c.status = state.age < 15 ? 'child' : 'unemployed';
  if (c.title !== null && typeof c.title !== 'string') c.title = null;
  if (c.sector !== null && typeof c.sector !== 'string') c.sector = null;
  if (!isNum(c.incomePct)) c.incomePct = clampN(p.familyPct, 0.02, 0.98);
  if (!isNum(c.years)) c.years = 0;
  if (c.employer === undefined) c.employer = null;
  if (!isObj(p.relationship)) p.relationship = { status: 'single', partner: null };
  const rel = p.relationship;
  if (!REL_STATUS.includes(rel.status)) rel.status = 'single';
  if (!isObj(rel.partner)) rel.partner = null;
  if (['dating', 'married', 'partnered'].includes(rel.status) && !rel.partner) rel.status = 'single';
  if (p.pastPartners !== undefined) {
    if (Array.isArray(p.pastPartners)) p.pastPartners = p.pastPartners.filter((x) => typeof x === 'string' && x).slice(-12);
    else delete p.pastPartners;
  }
  if (!Array.isArray(p.children)) p.children = [];
  p.children = p.children.filter(isObj);
  if (!isObj(p.parents)) p.parents = {};
  for (const k of ['mother', 'father']) {
    if (!isObj(p.parents[k])) p.parents[k] = { age: state.age + (k === 'mother' ? 28 : 31), alive: state.age < 50 };
    if (!isNum(p.parents[k].age)) p.parents[k].age = state.age + 30;
    p.parents[k].alive = p.parents[k].alive !== false;
  }
  if (!isNum(p.siblings)) p.siblings = Math.max(0, Math.round(num(b.siblings, 0)));
  if (!isObj(p.money)) p.money = {};
  const m = p.money;
  for (const k of ['cash', 'debt', 'income']) if (!isNum(m[k])) m[k] = 0;
  if (!isObj(m.portfolio)) m.portfolio = emptyPortfolio();
  for (const k of econ.ASSET_KEYS) if (!isNum(m.portfolio[k])) m.portfolio[k] = 0;
  if (!Array.isArray(p.conditions)) p.conditions = [];
  p.conditions = p.conditions.filter((x) => isObj(x) && typeof x.id === 'string');
  if (!isObj(p.flags)) p.flags = {};
  if (!isObj(state.stats)) state.stats = {};
  for (const k of STATS) state.stats[k] = clampN(num(state.stats[k], 50), 0, 100);
  for (const k of ['history', 'log', 'decisions', 'threads', 'hazardMods', 'cohort']) if (!Array.isArray(state[k])) state[k] = [];
  if (state.pending !== null && !isObj(state.pending)) state.pending = null;
  if (state.dead !== null && !isObj(state.dead)) state.dead = null;
  if (!isObj(state.aiNotes)) state.aiNotes = { birthStory: null, lastSummary: null };
  if (!isObj(state.seen)) state.seen = {};
  if (!Array.isArray(state.rng) || state.rng.length !== 4 || !state.rng.every(isNum)) {
    state.rng = new Rng(hashString(`${state.id || ''}|${state.seed || ''}|${state.year}`)).state();
  }
  ensureInteractive(state);
}

/** Defaults for the interactivity layer (CONTRACT §10); old saves get them on first use. */
function ensureInteractive(state) {
  normExtraSettings(state.settings);
  if (!isObj(state.focus)) state.focus = { current: null, auto: true };
  const fo = state.focus;
  if (fo.current != null && !FOCUS_IDS.includes(fo.current)) fo.current = null;
  if (fo.current === undefined) fo.current = null;
  fo.auto = fo.current == null;
  if (fo.lastAuto != null && !FOCUS_IDS.includes(fo.lastAuto)) delete fo.lastAuto;
  if (!isObj(state.habits)) state.habits = {};
  for (const k of econ.HABIT_KEYS) state.habits[k] = clampN(Math.round(num(state.habits[k], 0)), 0, 2);
  if (!isObj(state.habitLock)) state.habitLock = {};
  for (const k of Object.keys(state.habitLock)) if (!econ.HABIT_KEYS.includes(k) || state.habitLock[k] !== true) delete state.habitLock[k];
  const m = state.person.money;
  m.allocation = econ.normAllocation(m.allocation);
  if (!Array.isArray(state.stars)) state.stars = [];
  state.stars = state.stars.filter((x) => typeof x === 'string' && x).filter((x, i, a) => a.indexOf(x) === i).slice(0, MAX_STARS);
  if (!Array.isArray(state.notes)) state.notes = [];
  state.notes = state.notes.filter((n) => isObj(n) && typeof n.text === 'string');
  for (const k of ['smallPending', 'namingPending', 'reflectPending']) if (!isObj(state[k])) state[k] = null;
  if (!Array.isArray(state.rare)) state.rare = [];
  if (!isObj(state.smallSeen)) state.smallSeen = {};
  if (!Array.isArray(state.person.pets)) state.person.pets = [];
  state.person.pets = state.person.pets.filter((x) => isObj(x) && typeof x.name === 'string');
  // LogEntry ids (unique within the life): stamp entries pushed by other modules or kept in older saves
  if (!isNum(state.logSeq)) {
    let mx = 0;
    for (const e of state.log) {
      const mm = isObj(e) && typeof e.id === 'string' ? /-(\d+)$/.exec(e.id) : null;
      if (mm) mx = Math.max(mx, +mm[1]);
    }
    state.logSeq = mx;
  }
  for (const e of state.log) if (isObj(e) && (typeof e.id !== 'string' || !e.id)) stampId(state, e);
}

function stampId(state, e) {
  state.logSeq = num(state.logSeq, 0) + 1;
  e.id = `${num(e.year, state.year)}-${state.logSeq}`;
  return e;
}

/* ------------------------------------------------------------------ step scaffolding */

function makeStep(data, world, state, rng) {
  const p = state.person;
  const S = {
    data, world, state, p, rng,
    year: state.year,
    age: state.age,
    entries: [],
    ctx: null,
    lp: null,
    milestone: false,
    add(kind, text, tone = 0, tags = [], extra = {}) {
      if (!text) return null;
      const e = { year: state.year, age: state.age, kind, text: String(text), tone: clampN(Math.round(tone), -2, 2), tags: tags.slice(), source: extra.source || 'engine' };
      if (extra.effects) e.effects = extra.effects;
      if (extra.tag && TAGSET.has(extra.tag)) e.tag = extra.tag;
      if (extra.headline) e.headline = String(extra.headline);
      if (extra.title) e.title = String(extra.title);
      S.entries.push(e);
      return e;
    },
  };
  return S;
}

function refreshCtx(S) {
  S.ctx = countryContext(S.data, S.world, S.p.country, S.state.year);
  S.lp = safe(() => S.data.lifePath(S.p.country)) || {};
}

/** The year's focus modifier (CONTRACT §10): additive keys default to 0, multiplicative ones to 1. */
function fm(S, key) {
  return modValue(S && S.fmods, key);
}

/**
 * How far a habit sits above (+) or below (-) what is typical for this person this year (0 for minors). A habit the
 * player did not set follows the auto-choose texture, so with the default texture it is always typical (0).
 */
function habitDiff(S, key) {
  if (!S || S.age < 18) return 0;
  const st = S.state;
  if (!S.habitRef) {
    const typ = safe(() => econ.typicalHabits(S.data, S.world, st), {}) || {};
    const auto = safe(() => econ.autoHabits(S.data, S.world, st, textureOf(st)), {}) || {};
    S.habitRef = { typ, auto };
  }
  const locked = isObj(st.habitLock) && st.habitLock[key] === true;
  const level = locked ? clampN(Math.round(num(st.habits && st.habits[key], 0)), 0, 2) : num(S.habitRef.auto[key], 0);
  return level - num(S.habitRef.typ[key], 0);
}

/**
 * Diminishing returns for knowledge gains near the top of the scale: full speed up to 60, half at 80, a quarter at
 * 90. Without it nearly every adult with secondary schooling pinned the stat at 100 by thirty.
 */
export function knowGain(k, d) {
  return d > 0 ? d * clampN((100 - num(k, 50)) / 40, 0.04, 1) : d;
}

function addStats(state, k, d) {
  if (!isNum(d) || !d) return;
  if (k === 'knowledge') d = knowGain(num(state.stats.knowledge, 50), d);
  state.stats[k] = clampN(num(state.stats[k], 50) + d, 0, 100);
}

/** Move a percentile by dz standard deviations on the normal scale (the same step is worth less near the top). */
export function zAdd(pct, dz) {
  return clampN(normCdf(normInv(clampN(num(pct, 0.5), 0.005, 0.995)) + num(dz, 0)), 0.01, 0.99);
}

/**
 * Experience premium on the percentile's normal scale: +0.003 sd per year of work, up to 25 years. Small, because
 * economy.experienceFactor already carries the age–earnings profile; incomePct is the rank among one's peers.
 */
function expZ(years) {
  return 0.003 * clampN(num(years, 0), 0, 25);
}

/** Remember a former partner's name so a later partner is never given the same name. */
function rememberPartner(p, partner) {
  if (!isObj(partner) || typeof partner.name !== 'string' || !partner.name) return;
  if (!Array.isArray(p.pastPartners)) p.pastPartners = [];
  if (!p.pastPartners.includes(partner.name)) p.pastPartners.push(partner.name);
  if (p.pastPartners.length > 12) p.pastPartners.splice(0, p.pastPartners.length - 12);
}

const givenOf = (n) => String(n || '').split('·')[0].trim();

/** True when name repeats (in full or by its given part) one of the names already in this family's story. */
function nameClash(name, names) {
  const g = givenOf(name);
  return names.some((x) => typeof x === 'string' && x && (x === name || givenOf(x) === g));
}

/** A partner name that is not the person's own name, a former partner's or a child's. */
function freshPartnerName(data, p, sex, rng) {
  const taken = [p.name, ...(Array.isArray(p.pastPartners) ? p.pastPartners : []), ...p.children.map((k) => k && k.name)];
  let name = personName(data, p.country, sex, rng);
  for (let i = 0; i < 6 && nameClash(name, taken); i++) name = personName(data, p.country, sex, rng);
  return name;
}

/** Apply ±stat effects (ints, clamped -15..15) and an optional wealthDelta (intl $, bounded) to a life. */
function applyEffects(data, world, state, eff, scale = 1) {
  if (!isObj(eff)) return { health: 0, happiness: 0, knowledge: 0, relationships: 0, wealthDelta: 0 };
  const out = {};
  for (const k of STAT_EFFECT_KEYS) {
    const v = Math.round(clampN(num(eff[k], 0), -15, 15) * scale);
    out[k] = v;
    addStats(state, k, v);
  }
  let wd = num(eff.wealthDelta, 0) * scale;
  if (wd) {
    const p = state.person;
    const med = econ.medianIncome(data, world, p.country, state.year);
    const cap = Math.max(2000, 5 * Math.max(num(p.money.income, 0), med));
    wd = Math.round(clampN(wd, -cap, cap));
    if (state.age < 16) {
      p.familyPct = clampN(p.familyPct + clampN(wd / (8 * med), -0.04, 0.04), 0.005, 0.995);
    } else {
      moveCash(state, wd);
    }
  }
  out.wealthDelta = wd;
  return out;
}

function moveCash(state, amount) {
  const m = state.person.money;
  m.cash = num(m.cash, 0) + amount;
  if (m.cash < 0) {
    let need = -m.cash;
    for (const k of ['bonds', 'stocks', 'gold', 'crypto']) {
      if (need <= 0) break;
      const take = Math.min(num(m.portfolio[k], 0), need);
      m.portfolio[k] = num(m.portfolio[k], 0) - take;
      need -= take;
    }
    m.cash = 0;
    // children and teenagers do not borrow: parents cover what their pocket money cannot
    if (need > 0 && num(state.age, 0) >= 18) m.debt = num(m.debt, 0) + need;
  }
  m.cash = Math.round(m.cash);
  m.debt = Math.round(num(m.debt, 0));
}

function toneOf(eff) {
  if (!isObj(eff)) return 0;
  let s = 0;
  for (const k of STAT_EFFECT_KEYS) s += num(eff[k], 0);
  return s >= 12 ? 2 : s >= 3 ? 1 : s <= -12 ? -2 : s <= -3 ? -1 : 0;
}

/* ------------------------------------------------------------------ set patches */

function partnerAgeGap(data, state) {
  const region = safe(() => data.country(state.person.country).region) || '';
  return { SSA: 7, SAS: 5, WAS: 5, NAF: 6, CAS: 3.5, SEA: 3, EAS: 2.5, EEU: 2.5, WEU: 2.3, NAM: 2.2, LAC: 3.5, OCE: 2.3 }[region] ?? 3;
}

function normPartner(data, state, v, rng) {
  if (!isObj(v)) return null;
  const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 30) : null;
  if (!name) return null;
  const out = { name, sinceYear: Math.round(num(v.sinceYear, state.year)) };
  if (isNum(v.birthYear)) out.birthYear = Math.round(v.birthYear);
  else {
    const g = partnerAgeGap(data, state);
    const R = rng || new Rng(hashString(`${state.id}|partner|${name}`));
    const d = Math.max(-4, R.normal(g, 3));
    const pa = Math.max(16, Math.round(state.age + (state.person.sex === 'female' ? d : -d)));
    out.birthYear = state.year - pa;
  }
  if (v.sex === 'male' || v.sex === 'female') out.sex = v.sex;
  if (typeof v.surname === 'string' && v.surname.trim()) out.surname = v.surname.trim().slice(0, 12);
  return out;
}

function drawKidTarget(state, ctx, rng) {
  const tfr = num(ctx && ctx.tfr, 2.2);
  const mean = clampN(tfr / 0.9, 0.3, 8);
  return Math.max(0, Math.round(mean + rng.normal(0, Math.max(0.7, 0.4 * mean))));
}

function graduated(state) {
  const f = state.person.flags;
  delete f.gradYear;
  if (f.track === 'uni' || f.track === 'postgrad' || f.track === 'vocational' || f.track === 'academic') delete f.track;
}

/** Move to another country (migration bookkeeping). */
function moveCountry(data, state, iso) {
  const p = state.person;
  const from = p.country;
  p.country = iso;
  const f = p.flags;
  const birthIso = (state.birth && state.birth.country) || from;
  if (iso === birthIso) {
    if (f.migrant) f.migrant = false;
  } else {
    f.migrant = iso;
    if (!f.origin) f.origin = birthIso;
    f.migrantSince = state.year;
    // a newcomer to a richer country starts lower on its ladder than at home (language, diplomas, networks);
    // a career patch in the same resolution still sets the new job's own percentile afterwards
    const IG = { LIC: 0, LMC: 1, UMC: 2, HIC: 3 };
    const gFrom = IG[econ.incomeGroupOf(data, null, from, state.year)] ?? 1;
    const gTo = IG[econ.incomeGroupOf(data, null, iso, state.year)] ?? 1;
    const c = p.career;
    if (gTo > gFrom && isNum(c.incomePct)) {
      c.incomePct = Math.round(zAdd(c.incomePct, -0.4 * (gTo - gFrom)) * 1000) / 1000;
      c.basePct = zAdd(c.incomePct, -expZ(c.years));
    }
  }
  if (typeof f.city === 'string') delete f.city;
  if (!isObj(state.seen)) state.seen = {};
  state.seen[`move:${state.year}`] = from;
}

/** Merge a partial set patch (events, threads, resolutions; CONTRACT §3 Resolution.set). */
function applySet(data, world, state, set, rng) {
  if (!isObj(set)) return;
  const p = state.person;
  const year = state.year;
  if (typeof set.country === 'string') {
    const iso = set.country.trim().toUpperCase();
    if (iso !== p.country && safe(() => data.country(iso))) moveCountry(data, state, iso);
  }
  if (typeof set.urban === 'boolean') p.urban = set.urban;
  if (isObj(set.education)) {
    const e = p.education;
    const s = set.education;
    if (EDU_LEVELS.includes(s.level)) e.level = s.level;
    if (typeof s.inSchool === 'boolean') e.inSchool = s.inSchool;
    if (s.field === null || typeof s.field === 'string') e.field = s.field === null ? null : s.field.slice(0, 30);
    if (isNum(s.years)) e.years = clampN(Math.round(s.years), 0, 30);
    if (Array.isArray(s.exams)) {
      e.exams = s.exams.filter(isObj).slice(-12).map((x) => ({ age: Math.round(num(x.age, state.age)), name: String(x.name || '考试').slice(0, 30), result: String(x.result || 'pass').slice(0, 12),
        ...(isNum(x.score) ? { score: Math.round(clampN(x.score, 0, 750)) } : {}), ...(isNum(x.year) ? { year: Math.round(x.year) } : {}) }));
    }
    if ((s.level === 'tertiary' || s.level === 'postgrad' || s.level === 'vocational') && s.inSchool === false) {
      graduated(state);
      e.years = Math.max(e.years, s.level === 'postgrad' ? 18 : s.level === 'tertiary' ? 16 : 13);
    }
    if (s.inSchool === true && state.age >= 15 && !['student', 'military'].includes(p.career.status) && !isObj(set.career)) {
      if (p.career.status !== 'employed' || !p.flags.workingStudent) p.career.status = 'student';
    }
  }
  if (isObj(set.career)) {
    const c = p.career;
    const s = set.career;
    const prev = c.status;
    const prevTitle = c.title;
    if (CAREER_STATUS.includes(s.status)) c.status = s.status;
    if (s.title === null || typeof s.title === 'string') c.title = s.title === null ? null : s.title.slice(0, 30);
    if (s.sector === null || typeof s.sector === 'string') c.sector = s.sector === null ? null : s.sector.slice(0, 30);
    if (s.employer === null || typeof s.employer === 'string') c.employer = s.employer === null ? null : s.employer.slice(0, 40);
    if (isNum(s.years)) c.years = clampN(Math.round(s.years), 0, 70);
    if (isNum(s.incomePct)) {
      let v = clampN(s.incomePct, 0.01, 0.99);
      const old = num(c.incomePct, v);
      // a raise is a step up the ladder: above the median the same step is worth fewer percentiles
      if (v > old && old > 0.5) v = zAdd(old, normInv(clampN(0.5 + (v - old), 0.5, 0.99)));
      c.incomePct = Math.round(v * 1000) / 1000;
      c.basePct = zAdd(c.incomePct, -expZ(c.years));
    }
    const working = ['employed', 'self_employed'].includes(c.status);
    if (working && (!['employed', 'self_employed'].includes(prev) || (c.title && c.title !== prevTitle))) c.since = year;
    if (c.status === 'retired' && prev !== 'retired') {
      p.money.pension = econ.pensionFor(data, world, { ...state, person: { ...p, career: { ...c, status: prev } } });
      markRetired(p, year, prev);
    }
    if (['employed', 'self_employed'].includes(c.status) && !['employed', 'self_employed'].includes(prev) && !isNum(s.incomePct) && !isNum(c.basePct)) {
      c.basePct = clampN(c.incomePct, 0.02, 0.98);
    }
    if (['employed', 'self_employed', 'military'].includes(c.status) && p.education.inSchool && !isObj(set.education) && state.age >= 18 && !p.flags.workingStudent) {
      p.education.inSchool = false;
    }
  }
  if (isObj(set.relationship)) {
    const rel = p.relationship;
    const s = set.relationship;
    const prev = rel.status;
    const prevPartner = rel.partner;
    if (REL_STATUS.includes(s.status)) rel.status = s.status;
    if (s.partner === null) rel.partner = null;
    else if (isObj(s.partner)) {
      const keep = rel.partner && rel.partner.name === s.partner.name ? rel.partner : null;
      const np = normPartner(data, state, { ...(keep || {}), ...s.partner, birthYear: isNum(s.partner.birthYear) ? s.partner.birthYear : keep && keep.birthYear }, rng);
      if (np) rel.partner = np;
    }
    if (['dating', 'married', 'partnered'].includes(rel.status) && !rel.partner) {
      const R = rng || new Rng(hashString(`${state.id}|partner|${year}`));
      rel.partner = normPartner(data, state, { name: freshPartnerName(data, p, p.sex === 'female' ? 'male' : 'female', R), sinceYear: year }, R);
    }
    if (!['dating', 'married', 'partnered'].includes(rel.status)) rel.partner = null;
    if (prevPartner && (!rel.partner || rel.partner.name !== prevPartner.name)) rememberPartner(p, prevPartner);
    if ((rel.status === 'married' || rel.status === 'partnered') && prev !== rel.status) {
      if (!p.flags.firstUnion) p.flags.firstUnion = year;
      if (!isNum(p.flags.kidTarget) && rng) p.flags.kidTarget = drawKidTarget(state, countryContext(data, world, p.country, year), rng);
    }
  }
  if (isObj(set.flags)) {
    for (const [k, v] of Object.entries(set.flags)) {
      if (typeof k !== 'string' || !k || k.length > 40 || k === '__proto__') continue;
      if (v === null || v === undefined) delete p.flags[k];
      else if (typeof v === 'boolean' || isNum(v)) p.flags[k] = v;
      else if (typeof v === 'string') p.flags[k] = v.slice(0, 60);
    }
  }
  const addC = set.addCondition;
  if (addC) {
    const c = typeof addC === 'string' ? { id: addC } : isObj(addC) ? addC : null;
    if (c && typeof c.id === 'string' && c.id.trim()) {
      const id = c.id.trim().slice(0, 30);
      const old = p.conditions.find((x) => x.id === id);
      const sev = clampN(Math.round(num(c.severity, 1)), 1, 3);
      if (old) old.severity = Math.max(old.severity, sev);
      else p.conditions.push({ id, name: String(c.name || CONDITION_NAMES[id] || id).slice(0, 20), sinceYear: year, severity: sev });
    }
  }
  const rmC = set.removeCondition;
  if (rmC) {
    const ids = (Array.isArray(rmC) ? rmC : [rmC]).map((x) => (typeof x === 'string' ? x : isObj(x) ? x.id : null)).filter(Boolean);
    if (ids.length) p.conditions = p.conditions.filter((x) => !ids.includes(x.id));
  }
  if (isObj(set.addChild) && typeof set.addChild.name === 'string' && set.addChild.name.trim()) {
    const ch = set.addChild;
    if (!p.children.some((k) => k.name === ch.name.trim())) {
      p.children.push({ name: ch.name.trim().slice(0, 30), sex: ch.sex === 'female' ? 'female' : 'male', birthYear: Math.round(num(ch.birthYear, year)), alive: true, ...(ch.adopted ? { adopted: true } : {}) });
    }
  }
}

/* ------------------------------------------------------------------ threads */

function normThread(t, state, source) {
  if (!isObj(t)) return null;
  const tr = isObj(t.trigger) ? t.trigger : {};
  let year;
  if (isNum(tr.year)) year = Math.round(tr.year);
  else if (isNum(tr.age)) year = num(state.birth && state.birth.year, state.year - state.age) + Math.round(tr.age);
  else if (isNum(tr.afterYears)) year = state.year + Math.max(1, Math.round(tr.afterYears));
  else year = state.year + 1;
  year = clampN(year, state.year + 1, state.year + 90);
  const eff = isObj(t.effects) ? t.effects : {};
  const effects = {};
  for (const k of STAT_EFFECT_KEYS) effects[k] = Math.round(clampN(num(eff[k], 0), -15, 15));
  effects.wealthDelta = Math.round(num(eff.wealthDelta, 0));
  const out = {
    id: typeof t.id === 'string' && t.id ? t.id.slice(0, 60) : `th-${hashString(`${state.id}|${year}|${t.title || ''}|${t.text || ''}`).toString(36)}`,
    title: String(t.title || '后来').slice(0, 30),
    text: String(t.text || t.title || '').slice(0, 400),
    trigger: { year },
    conditions: isObj(t.conditions) ? { ...t.conditions } : { alive: true },
    effects,
    source: t.source === 'ai' || source === 'ai' ? 'ai' : 'local',
  };
  if (isObj(t.set)) out.set = JSON.parse(JSON.stringify(t.set));
  if (isObj(t.decision)) out.decision = JSON.parse(JSON.stringify(t.decision));
  if (isObj(t.hazard) && isNum(t.hazard.mult)) out.hazard = { mult: clampN(t.hazard.mult, 0.5, 2), years: clampN(Math.round(num(t.hazard.years, 1)), 1, 30), reason: String(t.hazard.reason || '').slice(0, 40) };
  return out;
}

function addThreads(state, threads, source) {
  for (const t of Array.isArray(threads) ? threads : []) {
    const n = normThread(t, state, source);
    if (!n) continue;
    if (state.threads.some((x) => x && x.id === n.id)) continue;
    state.threads.push(n);
  }
  if (state.threads.length > MAX_THREADS) {
    state.threads.sort((a, b) => num(a.trigger && a.trigger.year, 0) - num(b.trigger && b.trigger.year, 0));
    state.threads.length = MAX_THREADS;
  }
}

function threadDecision(t, state) {
  const d = t.decision;
  if (!isObj(d) || !Array.isArray(d.options)) return null;
  const seen = new Set();
  const options = [];
  for (const o of d.options) {
    if (!isObj(o) || typeof o.label !== 'string' || !o.label.trim()) continue;
    let id = OPT_IDS.includes(o.id) && !seen.has(o.id) ? o.id : OPT_IDS.find((x) => !seen.has(x));
    if (!id) break;
    seen.add(id);
    options.push({ id, label: o.label.trim().slice(0, 16), detail: String(o.detail || '').slice(0, 80), risk: ['low', 'mid', 'high'].includes(o.risk) ? o.risk : 'mid' });
    if (options.length >= 4) break;
  }
  if (options.length < 2) return null;
  const out = {
    id: typeof d.id === 'string' && d.id ? d.id : `d-thread-${t.id}`,
    year: state.year,
    age: state.age,
    kind: 'triggered',
    title: String(d.title || t.title || '新的岔路口').slice(0, 30),
    situation: String(d.situation || t.text || '').slice(0, 300),
    options,
    allowCustom: true,
    source: d.source === 'ai' || t.source === 'ai' ? 'ai' : 'local',
  };
  if (isObj(d.context)) out.context = d.context;
  return out;
}

function hasPendingSet(state, key) {
  return state.threads.some((t) => t && isObj(t.set) && isObj(t.set[key]));
}

function fireThreads(S) {
  const { state, p, data, world, rng } = S;
  if (!state.threads.length) return;
  const keep = [];
  const due = [];
  for (const t of state.threads) {
    if (!isObj(t)) continue;
    const ty = num(t.trigger && t.trigger.year, state.year + 1);
    if (ty > state.year) keep.push(t);
    else if (ty >= state.year - 6) due.push(t);
  }
  due.sort((a, b) => num(a.trigger.year, 0) - num(b.trigger.year, 0));
  for (const t of due) {
    const cond = isObj(t.conditions) ? t.conditions : {};
    if (cond.alive === false) continue;
    if (typeof cond.country === 'string' && cond.country !== p.country) continue;
    if (t.decision && state.pending) {
      t.trigger = { year: state.year + 1 };
      keep.push(t);
      continue;
    }
    const eff = applyEffects(data, world, state, t.effects);
    if (t.set) applySet(data, world, state, t.set, rng);
    if (t.hazard) state.hazardMods.push({ mult: t.hazard.mult, untilYear: state.year + t.hazard.years - 1, reason: t.hazard.reason });
    const text = t.text && t.text.trim() ? t.text : t.title;
    S.add('thread', text, toneOf(eff), threadTags(t), { title: t.title, headline: t.title, effects: eff, source: t.source === 'ai' ? 'ai' : 'engine' });
    if (t.decision && !state.pending) {
      const d = threadDecision(t, state);
      if (d) state.pending = d;
    }
  }
  state.threads = keep;
}

function threadTags(t) {
  const s = isObj(t.set) ? t.set : {};
  if (typeof s.country === 'string') return ['migration'];
  if (isObj(s.relationship)) return [s.relationship.status === 'married' ? 'love' : s.relationship.status === 'divorced' || s.relationship.status === 'single' ? 'loss' : 'love'];
  if (isObj(s.education)) return ['study'];
  if (isObj(s.career)) return [s.career.status === 'retired' ? 'retire' : s.career.status === 'unemployed' ? 'crisis' : 'work'];
  if (s.addChild) return ['family'];
  if (s.addCondition) return ['illness'];
  const e = t.effects || {};
  return [num(e.happiness, 0) + num(e.health, 0) >= 6 ? 'success' : num(e.happiness, 0) + num(e.health, 0) <= -6 ? 'crisis' : 'calm'];
}

/* ------------------------------------------------------------------ education */

const PRIMARY_YEARS = 6;
const SECONDARY_YEARS = 6;
const FIELDS = [
  { key: 'medicine', label: '临床医学', years: 5, job: '医生', sector: '医疗', pct: 0.78, need: 66, w: 0.8 },
  { key: 'nursing', label: '护理学', years: 3, job: '护士', sector: '医疗', pct: 0.55, need: 45, w: 0.8 },
  { key: 'cs', label: '计算机科学', years: 4, job: '软件工程师', sector: '信息技术', pct: 0.72, need: 58, w: 1, from: 1995 },
  { key: 'ai', label: '人工智能', years: 4, job: 'AI 工程师', sector: '信息技术', pct: 0.76, need: 64, w: 0.6, from: 2018 },
  { key: 'engineering', label: '工程', years: 4, job: '工程师', sector: '工程制造', pct: 0.65, need: 55, w: 1.2 },
  { key: 'business', label: '经济与管理', years: 4, job: '职员', sector: '金融商业', pct: 0.6, need: 50, w: 1.3 },
  { key: 'law', label: '法学', years: 4, job: '律师助理', sector: '法律', pct: 0.62, need: 60, w: 0.6 },
  { key: 'education', label: '师范教育', years: 4, job: '教师', sector: '教育', pct: 0.54, need: 48, w: 1 },
  { key: 'humanities', label: '文史哲', years: 4, job: '编辑', sector: '文化', pct: 0.48, need: 48, w: 0.7 },
  { key: 'arts', label: '艺术设计', years: 4, job: '设计师', sector: '创意产业', pct: 0.5, need: 44, w: 0.6 },
  { key: 'agriculture', label: '农学', years: 4, job: '农业技术员', sector: '农业', pct: 0.45, need: 40, w: 0.5 },
];
const FIELD_BY_LABEL = new Map(FIELDS.map((f) => [f.label, f]));

function pickField(S) {
  const know = num(S.state.stats.knowledge, 50);
  const f = S.rng.weighted(FIELDS, (F) => {
    if (F.from && S.year < F.from) return 0;
    let w = F.w;
    if (know < F.need - 10) w *= 0.3;
    if (F.key === 'agriculture' && S.p.urban) w *= 0.4;
    return w;
  });
  return f || FIELDS[5];
}

function schoolStartAge(lp, year) {
  let a = num(lp && lp.school_start_age, 6);
  const hist = lp && Array.isArray(lp.school_start_age_history) ? lp.school_start_age_history : [];
  for (const h of hist) if (isObj(h) && num(h.from, 9999) <= year && isNum(h.value)) a = h.value;
  return clampN(Math.round(a), 4, 8);
}

function girlGap(S) {
  if (S.p.sex !== 'female') return 0;
  const flfp = num(S.ctx.femaleLfp, 50);
  const sec = num(S.ctx.secEnroll, 60);
  return clampN((52 - flfp) / 100, 0, 0.25) * (sec < 70 ? 1 : 0.3) * clampN(1 - 0.012 * (S.year - 2000), 0.25, 1);
}

function leaveSchool(S, stage) {
  const { p } = S;
  p.education.inSchool = false;
  p.flags.leftSchool = S.year;
  const poor = p.familyPct < 0.35;
  const girl = girlGap(S) > 0.05 && S.rng.chance(0.5);
  if (stage === 'primary') {
    const why = girl ? '家里人觉得女孩读到这里就够了，你把课本仔细收进了箱底。' : poor ? '家里需要人手，你开始帮着干活、照看弟妹。' : '附近没有合适的中学，你没有再继续读下去。';
    S.add('milestone', `小学毕业后，你没有再上学。${why}`, -1, ['childhood', 'study'], { tag: 'childhood', headline: '离开学校' });
  } else if (stage === 'lower') {
    const why = poor ? '家里供不起了，你决定早点出来挣钱。' : '你对读书没了兴趣，想早点去社会上闯一闯。';
    S.add('milestone', `初中毕业后，你离开了学校。${why}`, -1, ['study'], { tag: 'study', headline: '离开学校' });
  } else {
    S.add('milestone', '你没有继续读大学，开始找工作，准备自己养活自己。', 0, ['study', 'work'], { tag: 'work', headline: '走出校门' });
  }
  if (S.age >= 15 && p.career.status === 'student') p.career.status = 'unemployed';
}

function examScoreOf(S) {
  return num(S.state.stats.knowledge, 50) + S.rng.normal(0, 10) + (S.p.urban ? 2 : -2) + (S.p.flags.diligent ? 4 : 0) + fm(S, 'exam');
}
const tierOfScore = (s) => (s >= 78 ? 'top' : s >= 60 ? 'good' : s >= 46 ? 'pass' : 'fail');
/**
 * The 高考 total (out of 750) for an exam strength s. A typical 18-year-old still in school has s ≈ 88 (sd ≈ 13), so
 * the median lands near 470 and 650+ is about the top 2%, close to the real spread of provincial scores.
 */
export function gaokaoPoints(s) {
  return Math.round(clampN(470 + (s - 88) * 7, 150, 735));
}
/** score bands, roughly: 600+ the strong universities, 520+ 一本, 430+ 本科, below that 专科 or a repeat year */
const tierOfGaokao = (pts) => (pts >= 600 ? 'top' : pts >= 520 ? 'good' : pts >= 430 ? 'pass' : 'fail');

/**
 * The key exam of this age. In a decision year only the school-leaving exams (17+) are sat here, before the
 * decision is built, so that the 高考 choice already knows the score; the earlier ones (中考 …) are the decision itself.
 */
function examCheck(S, leavingOnly = false) {
  const e = S.p.education;
  const list = safe(() => keyExams(S.lp, S.p.country, S.year)) || [];
  for (const [age, name] of list) {
    if (age !== S.age || e.exams.some((x) => x && x.age === S.age)) continue;
    if (leavingOnly && age < 17) continue;
    if (/硕士|研究生|考研|公务员|国考|职业资格/.test(name)) continue;
    const s = examScoreOf(S);
    const pts = name === '高考' ? gaokaoPoints(s) : null;
    const tier = pts != null ? tierOfGaokao(pts) : tierOfScore(s);
    const rec = { age: S.age, name, result: tier, year: S.year };
    if (pts != null) rec.score = pts;
    e.exams.push(rec);
    if (e.exams.length > 12) e.exams.splice(0, e.exams.length - 12);
    if (rec.score) {
      const txt = { top: `高考成绩出来了：${rec.score} 分。你盯着屏幕看了好几遍，才敢把这个数字念出声。`, good: `高考成绩出来了：${rec.score} 分，比你心里的预期还高一点。`, pass: `高考成绩出来了：${rec.score} 分。不算好，也不算坏，够得着一些学校。`, fail: `高考成绩出来了：${rec.score} 分。你把自己关在房间里，一整天没出来。` }[tier];
      S.add('milestone', txt, tier === 'top' ? 2 : tier === 'good' ? 1 : tier === 'fail' ? -1 : 0, ['study'], { tag: tier === 'top' ? 'success' : 'study', headline: `高考 ${rec.score} 分` });
      addStats(S.state, 'happiness', { top: 5, good: 3, pass: 0, fail: -4 }[tier]);
      if (tier === 'fail') S.p.flags.examFail = S.year;
      break;
    }
    const txt = { top: `${name}成绩出来了，你考得非常好，老师在班上念了你的名字。`, good: `${name}放榜，你考出了不错的成绩。`, pass: `你参加了${name}，成绩不算突出，但顺利过关。`, fail: `你参加了${name}，成绩不太理想。你难过了好几天。` }[tier];
    S.add('milestone', txt, tier === 'top' ? 2 : tier === 'good' ? 1 : tier === 'fail' ? -1 : 0, ['study'], { tag: tier === 'top' ? 'success' : 'study', headline: name.slice(0, 10) });
    addStats(S.state, 'happiness', { top: 5, good: 3, pass: 0, fail: -4 }[tier]);
    if (tier === 'fail') S.p.flags.examFail = S.year;
    break;
  }
}

function tertiaryEntry(S) {
  const { p, ctx, rng, state } = S;
  const sec = num(ctx.secEnroll, 60);
  const ter = num(ctx.terEnroll, 25);
  const know = num(state.stats.knowledge, 50);
  // the enrolment ratio already is the chance of a typical school leaver; knowledge only shifts it around the
  // typical level of a secondary graduate (about 72), so it no longer adds a bonus to nearly everyone
  let pT = (0.85 * ter) / 100 / Math.max(0.2, Math.min(1, sec / 100)) + 0.25 * (p.familyPct - 0.5) + (know - 72) / 110 + (p.urban ? 0.03 : -0.05) - 0.5 * girlGap(S);
  if ((ctx.incomeGroup === 'LIC' || ctx.incomeGroup === 'LMC') && p.familyPct < 0.3) pT *= 0.6;
  if (p.flags.examFail && S.year - num(p.flags.examFail, 0) <= 2) pT -= 0.1;
  pT += fm(S, 'tertiary');
  if (rng.chance(clampN(pT, 0.02, 0.95))) {
    const F = pickField(S);
    p.flags.track = 'uni';
    p.flags.gradYear = S.year + F.years;
    p.flags.field = F.key;
    p.education.field = F.label;
    p.career.status = 'student';
    p.career.title = null;
    p.career.sector = null;
    S.add('milestone', `你考上了大学，读${F.label}专业。离家那天，你把录取通知书小心地夹在了日记本里。`, 2, ['study', 'success'], { tag: 'study', headline: '上大学' });
  } else {
    leaveSchool(S, 'secondary');
  }
}

function educationStep(S) {
  const { p, rng, state, ctx } = S;
  const e = p.education;
  const f = p.flags;
  const age = S.age;
  const start = schoolStartAge(S.lp, S.year);
  const sec = num(ctx.secEnroll, 60);
  const fam = p.familyPct;
  const urb = p.urban ? 0.05 : -0.06;
  if (age < start) {
    if (age >= 3 && e.level === 'none' && !e.inSchool) {
      if (f['ev:ch_kindergarten'] != null) {
        // the events library already told the first day at kindergarten: enrol without telling it twice
        e.level = 'preschool';
        e.inSchool = true;
        return;
      }
      const pPre = clampN(0.1 + (0.55 * sec) / 100 + 0.25 * (fam - 0.5) + urb, 0.02, 0.95);
      if (rng.chance(age === 3 ? pPre : pPre * 0.5)) {
        e.level = 'preschool';
        e.inSchool = true;
        f['ev:ch_kindergarten'] = S.year; // told here; the events library's kindergarten story would repeat it
        S.add('milestone', p.urban ? '你开始上幼儿园了。第一天你哭着不肯撒手，第二天就交到了朋友。' : '你开始去村里的学前班，跟着老师唱歌、认字。', 1, ['childhood'], { tag: 'childhood', headline: '上幼儿园' });
      }
    }
    return;
  }
  if ((EDU_RANK[e.level] ?? 0) < 2 && !f.noSchool) {
    if (age <= start + 3) {
      const pPrim = clampN(0.5 + 0.5 * Math.min(1, sec / 75) + 0.18 * (fam - 0.5) + urb - girlGap(S), 0.25, 0.995);
      if (rng.chance(age === start ? pPrim : pPrim * 0.45)) {
        e.level = 'primary';
        e.inSchool = true;
        e.years = 0;
        p.career.status = 'student';
        f['ev:ch_first_school'] = S.year; // told here, not again by the events library
        S.add('milestone', p.urban ? '你背上新书包，成了一名小学生。' : '你开始上小学了，每天和小伙伴们走很远的路去学校。', 1, ['study', 'childhood'], { tag: 'study', headline: '上小学' });
        return;
      }
      e.inSchool = false;
      if (age === start + 3) {
        f.noSchool = true;
        S.add('milestone', fam < 0.35 ? '家里实在供不起，你没能走进学校，早早开始帮家里干活。' : '附近没有学校，你没能去上学，跟着大人学着做事。', -1, ['childhood'], { tag: 'childhood', headline: '没能上学' });
      }
      return;
    }
    return;
  }
  if (!e.inSchool) return;
  if (e.level === 'preschool') {
    e.inSchool = false;
    return;
  }
  e.years = num(e.years, 0) + 1;
  const track = f.track;
  const know = num(state.stats.knowledge, 50);
  if (e.level === 'primary' && e.years >= PRIMARY_YEARS) {
    const p2 = clampN(sec / 100 / 0.9 + 0.22 * (fam - 0.5) + (p.urban ? 0.05 : -0.08) + (know - 45) / 220 - girlGap(S) - (f.examFail ? 0.1 : 0) + fm(S, 'school'), 0.03, 0.995);
    if (rng.chance(p2)) {
      e.level = 'secondary';
      S.add('milestone', '小学毕业了，你升入了中学。新学校、新同学，课业也一下子重了起来。', 1, ['study'], { tag: 'study', headline: '升入中学' });
    } else {
      leaveSchool(S, 'primary');
    }
    return;
  }
  // school-leaving and entrance exams belong to the academic track; vocational and university students skip them
  if (!track || track === 'academic') examCheck(S, S.milestone);
  if (e.level === 'secondary' && (!track || track === 'academic')) {
    if (e.years === PRIMARY_YEARS + 3 && !S.milestone && !track) {
      const fail = f.examFail && S.year - num(f.examFail, 0) <= 1;
      const p3 = clampN(0.3 + (0.75 * sec) / 100 + 0.2 * (fam - 0.5) + (know - 50) / 150 + urb - girlGap(S) - (fail ? 0.2 : 0) + fm(S, 'school'), 0.05, 0.99);
      if (!rng.chance(p3)) {
        leaveSchool(S, 'lower');
        return;
      }
    }
    if (e.years >= PRIMARY_YEARS + SECONDARY_YEARS) {
      if (!f.secDone) {
        f.secDone = S.year;
        S.add('milestone', '你中学毕业了。毕业照上，你站在第二排，笑得有点拘谨。', 1, ['study'], { tag: 'study', headline: '中学毕业' });
      }
      if (hasPendingSet(state, 'education')) return;
      if (!S.milestone || e.years > PRIMARY_YEARS + SECONDARY_YEARS) tertiaryEntry(S);
    }
    return;
  }
  // post-secondary tracks (from decisions or from the engine)
  if (track === 'uni' || track === 'postgrad' || track === 'vocational' || e.level === 'vocational' || EDU_RANK[e.level] >= 5) {
    if (hasPendingSet(state, 'education')) return;
    if (!isNum(f.gradYear)) {
      f.gradYear = S.year + (track === 'vocational' ? 2 : track === 'postgrad' ? 2 : 3);
      return;
    }
    if (S.year >= f.gradYear) graduate(S, track);
    return;
  }
  // anything else in school past 25 (repeat years, unknown tracks) finishes
  if (age >= 25 || e.years > 20) {
    e.inSchool = false;
    if (p.career.status === 'student') p.career.status = 'unemployed';
  }
}

function graduate(S, track) {
  const { p } = S;
  const e = p.education;
  const F = FIELD_BY_LABEL.get(e.field) || null;
  e.inSchool = false;
  if (track === 'vocational' || (e.level !== 'tertiary' && e.level !== 'postgrad' && track !== 'uni' && track !== 'postgrad')) {
    e.level = 'vocational';
    S.add('milestone', `你从职业学校毕业了${e.field ? `，学的是${e.field}` : ''}。`, 1, ['study'], { tag: 'study', headline: '职校毕业' });
  } else if (track === 'postgrad' || e.level === 'tertiary') {
    e.level = 'postgrad';
    S.add('milestone', `你拿到了${e.field ? `${e.field}方向的` : ''}研究生学位。`, 2, ['study', 'success'], { tag: 'success', headline: '研究生毕业' });
  } else {
    e.level = 'tertiary';
    S.add('milestone', `你大学毕业了${e.field ? `，拿到了${e.field}专业的学位` : ''}。毕业典礼上，你把学士帽抛得很高。`, 2, ['study', 'success'], { tag: 'success', headline: '大学毕业' });
  }
  e.years = Math.max(e.years, e.level === 'postgrad' ? 18 : e.level === 'tertiary' ? 16 : 13);
  graduated(S.state);
  if (p.career.status === 'student') {
    p.career.status = 'unemployed';
    laborEntry(S, F);
  }
}

/* ------------------------------------------------------------------ work */

const JOBS = {
  low_urban: [['建筑工人', '建筑业', 0.18, 'm'], ['清洁工', '服务业', 0.12], ['小贩', '零售', 0.16, null, true], ['家政工', '家政服务', 0.14, 'f'], ['搬运工', '物流', 0.15, 'm'], ['工厂工人', '制造业', 0.2]],
  low_rural: [['农民', '农业', 0.1, null, true], ['帮工', '农业', 0.08], ['建筑工人', '建筑业', 0.16, 'm']],
  mid_urban: [['店员', '零售', 0.3], ['工厂工人', '制造业', 0.32], ['司机', '运输', 0.35, 'm'], ['文员', '行政', 0.38], ['厨师', '餐饮', 0.3], ['保安', '服务业', 0.25, 'm'], ['销售', '零售', 0.35], ['护工', '护理', 0.28, 'f'], ['快递员', '物流', 0.3, null, false, 2010], ['外卖骑手', '平台服务', 0.3, null, false, 2015], ['网店店主', '电子商务', 0.36, null, true, 2012]],
  mid_rural: [['农民', '农业', 0.15, null, true], ['建筑工人', '建筑业', 0.25, 'm'], ['小卖部店主', '零售', 0.22, null, true], ['工厂工人', '制造业', 0.27], ['司机', '运输', 0.3, 'm']],
  grad: [['职员', '金融商业', 0.6], ['教师', '教育', 0.55], ['工程师', '工程制造', 0.64], ['会计', '金融商业', 0.6], ['公务员', '公共部门', 0.62], ['软件工程师', '信息技术', 0.7, null, false, 2000], ['市场专员', '金融商业', 0.58]],
};
const TRADE_JOBS = { 电工: '建筑与维修', 汽车维修: '维修服务', 护理: '医疗', 厨师: '餐饮', 数控加工: '制造业', 美容美发: '服务业', 电子商务: '平台服务', 新能源设备维护: '能源', 机器人运维: '制造业', 农机维修: '农业' };

function pickJob(S, F) {
  const { p, rng } = S;
  const rank = EDU_RANK[p.education.level] ?? 0;
  const sex = p.sex === 'female' ? 'f' : 'm';
  if (rank >= 5) {
    const fld = F || FIELD_BY_LABEL.get(p.education.field);
    if (fld && rng.chance(0.75)) return { title: fld.job, sector: fld.sector, pct: fld.pct, self: false };
    const list = JOBS.grad.filter((j) => (!j[3] || j[3] === sex) && (!j[5] || S.year >= j[5]));
    const j = rng.pick(list);
    return { title: j[0], sector: j[1], pct: j[2] + (rank === 6 ? 0.06 : 0), self: false };
  }
  if (rank === 4 || p.flags.trade) {
    const trade = typeof p.flags.trade === 'string' ? p.flags.trade : p.education.field;
    if (trade && TRADE_JOBS[trade]) return { title: `${trade}技师`, sector: TRADE_JOBS[trade], pct: 0.42, self: false };
    return { title: '技术工人', sector: '制造业', pct: 0.4, self: false };
  }
  const key = (rank >= 3 ? 'mid_' : 'low_') + (p.urban ? 'urban' : 'rural');
  const list = JOBS[key].filter((j) => (!j[3] || j[3] === sex) && (!j[5] || S.year >= j[5]));
  const j = rng.pick(list);
  return { title: j[0], sector: j[1], pct: j[2], self: !!j[4] };
}

/**
 * Mid-rank (0..1) of an education level among the country's adults, from enrolment rates about 15 years earlier
 * (a proxy for the education of today's workforce).
 */
function eduMidRank(S, rank) {
  const lag = countryContext(S.data, S.world, S.p.country, Math.max(2000, S.year - 15));
  const sec = num(lag.secEnroll, 60);
  const ter = num(lag.terEnroll, 25);
  const pTer = clampN((ter / 100) * 0.85, 0.01, 0.8);
  const pSec = clampN(Math.max((sec / 100) * 0.85, pTer + 0.02), 0.03, 0.97);
  const pPrim = clampN(Math.max(0.6 + (0.4 * sec) / 100, pSec + 0.02), 0.2, 0.995);
  if (rank >= 5) return 1 - pTer * (rank >= 6 ? 0.25 : 0.5);
  if (rank >= 3) return 1 - pSec + (pSec - pTer) * (rank === 4 ? 0.6 : 0.5);
  if (rank === 2) return 1 - pPrim + (pPrim - pSec) / 2;
  return (1 - pPrim) / 2;
}

/** Income percentile for a new job: rank of education in the country, family background, knowledge, job, luck. */
function jobPercentile(S, job) {
  const { p, rng, state } = S;
  const rank = EDU_RANK[p.education.level] ?? 0;
  const know = num(state.stats.knowledge, 50);
  const z = 0.75 * normInv(clampN(eduMidRank(S, rank), 0.01, 0.99)) + 0.25 * normInv(clampN(p.familyPct, 0.01, 0.99))
    + (know - 75) / 60 + (num(job.pct, 0.4) - 0.4) * 0.8 + rng.normal(0, 0.45);
  return clampN(normCdf(z), 0.02, 0.98);
}

function setJob(S, job, status, logIt, text) {
  const { p } = S;
  const c = p.career;
  const pct = jobPercentile(S, job);
  c.status = status;
  c.title = job.title;
  c.sector = job.sector;
  c.incomePct = Math.round(pct * 1000) / 1000;
  c.basePct = zAdd(pct, -expZ(c.years));
  c.employer = null;
  c.since = S.year;
  if (logIt) S.add('milestone', text || `你开始工作了，成了一名${job.title}。`, 1, ['work'], { tag: 'work', headline: '参加工作' });
}

function laborEntry(S, F) {
  const { p, ctx, rng } = S;
  const c = p.career;
  if (S.age < 15) {
    c.status = 'child';
    return;
  }
  const ig = ctx.incomeGroup;
  const rank = EDU_RANK[p.education.level] ?? 0;
  const fam = p.familyPct;
  const female = p.sex === 'female';
  if (!p.urban && rank <= 3 && (ig === 'LIC' || ig === 'LMC' || (ig === 'UMC' && fam < 0.35)) && rng.chance(ig === 'LIC' ? 0.8 : ig === 'LMC' ? 0.6 : 0.35)) {
    setJob(S, { title: '农民', sector: '农业', pct: 0.08 + 0.2 * fam }, 'self_employed', true, '你开始和家里人一起下地干活，成了一名农民。');
    return;
  }
  const flfp = num(ctx.femaleLfp, 50);
  const couple = ['married', 'partnered'].includes(p.relationship.status);
  if (female && rng.chance(clampN((55 - flfp) / 100, 0, 0.45) * (couple ? 1.3 : 0.5) * clampN(1 - 0.012 * (S.year - 2000), 0.3, 1))) {
    c.status = 'homemaker';
    c.title = null;
    c.sector = null;
    S.add('milestone', '你没有出去工作，留在家里操持家务、照顾家人。', 0, ['family'], { tag: 'family', headline: '操持家务' });
    return;
  }
  const yu = num(ctx.youthUnemp, num(ctx.unemployment, 7) * 2);
  if (rng.chance(clampN((yu / 100) * (rank >= 5 ? 0.85 : 1.1), 0.02, 0.6))) {
    c.status = 'unemployed';
    c.title = null;
    c.sector = null;
    S.add('milestone', '你开始四处找工作，投了很多简历、跑了很多地方，一时还没有找到合适的。', -1, ['work', 'crisis'], { tag: 'work', headline: '求职' });
    return;
  }
  const job = pickJob(S, F);
  const informal = { LIC: 0.4, LMC: 0.3, UMC: 0.15, HIC: 0.08 }[ig] || 0.15;
  const self = job.self || rng.chance(rank >= 5 ? informal * 0.3 : informal);
  const text = self && !job.self ? `你没有找到稳定的工作，自己做起了小买卖。` : job.self ? `你自己做起了${job.title}，起早贪黑，赚的都是辛苦钱。` : null;
  setJob(S, self && !job.self ? { title: '个体户', sector: '小生意', pct: Math.max(0.15, job.pct - 0.05) } : job, self ? 'self_employed' : 'employed', true, text);
}

function isFarmer(c) {
  return /农|牧|渔/.test(`${c.sector || ''}${c.title || ''}`);
}

function workStep(S) {
  const { p, ctx, rng, state } = S;
  const c = p.career;
  const age = S.age;
  const f = p.flags;
  if (age < 15) {
    if (!['child', 'student'].includes(c.status)) c.status = p.education.inSchool ? 'student' : 'child';
    else if (p.education.inSchool && c.status === 'child' && age >= 6) c.status = 'student';
    else if (!p.education.inSchool && c.status === 'student') c.status = 'child';
    return;
  }
  if (p.education.inSchool && !f.workingStudent) {
    if (!['student', 'military'].includes(c.status) && (c.status !== 'employed' || age < 18)) c.status = 'student';
    return;
  }
  const rank = EDU_RANK[p.education.level] ?? 0;
  const ra = econ.retirementAgeFor(S.data, S.world, p.country, S.year, p.sex, rank) - (f.earlyRetire ? 3 : 0);
  const ig = ctx.incomeGroup;
  const unemp = num(ctx.unemployment, 6);
  const recession = num(ctx.gdpGrowth, 2) <= -1.5;
  const flfp = num(ctx.femaleLfp, 50);
  switch (c.status) {
    case 'child':
    case 'student':
      if (p.education.inSchool) return;
      laborEntry(S);
      return;
    case 'employed':
    case 'self_employed': {
      c.years = num(c.years, 0) + 1;
      const farmer = isFarmer(c);
      const retireAt = farmer && (ig === 'LIC' || ig === 'LMC') ? Math.max(ra, 63) + (hashString(`${state.id}|ret`) % 6) : c.status === 'self_employed' ? ra + (hashString(`${state.id}|ret`) % 4) : ra;
      if (age >= retireAt && !hasPendingSet(state, 'career')) {
        retire(S);
        return;
      }
      if (S.state.stats.health < 22 && rng.chance(0.25)) {
        c.status = 'unable';
        S.add('milestone', '身体实在撑不住了，你不得不停下工作，在家养病。', -2, ['illness'], { tag: 'illness', headline: '因病离岗' });
        return;
      }
      const yu = num(ctx.youthUnemp, unemp * 2);
      let pLose = ((age < 25 ? yu : unemp) / 100) * 0.4 * (1.3 - c.incomePct) + (recession ? 0.03 : 0) + (ctx.conflict >= 3 ? 0.06 : 0);
      if (farmer) pLose *= 0.15;
      else if (c.status === 'self_employed') pLose *= 0.8;
      if (age >= 55) pLose *= 1.2;
      pLose *= fm(S, 'jobLoss');
      // (a job that only started this year is not lost in the same year)
      if (rng.chance(clampN(pLose, 0.003, 0.3)) && !hasPendingSet(state, 'career') && S.year - num(c.since, -99) >= 1) {
        const wasTitle = c.title;
        const wasSelf = c.status === 'self_employed';
        c.status = 'unemployed';
        c.basePct = clampN(num(c.basePct, c.incomePct) - 0.03, 0.01, 0.99);
        const txt = wasSelf || /个体|小贩|店主/.test(wasTitle || '') ? '生意越来越难做，你最终关掉了摊子，重新开始找出路。'
          : recession ? '经济不景气，单位裁员，你的名字出现在了名单上。' : `你失去了${wasTitle ? `${wasTitle}的` : ''}工作。收拾东西离开的那天，你在门口站了很久。`;
        S.add('milestone', txt, -2, ['crisis', 'work'], { tag: 'crisis', headline: '失业' });
        return;
      }
      // career progression, on the percentile's normal scale so that it slows near the top of the ladder
      if (!isNum(c.basePct)) c.basePct = zAdd(c.incomePct, -expZ(c.years - 1));
      const know = num(state.stats.knowledge, 50);
      c.basePct = Math.min(0.98, zAdd(c.basePct, (know - 85) / 5000 + fm(S, 'raise')));
      const inJob = S.year - num(c.since, S.year - c.years);
      const lastPromo = num(f['ev:a_promotion'], -99);
      if (!farmer && age < 56 && c.years >= 2 && inJob >= 2 && S.year - lastPromo >= 2
        && rng.chance(clampN(clampN(0.02 + (know - 70) / 1500 + (rank >= 5 ? 0.01 : 0), 0.005, 0.06) + fm(S, 'promo') + 0.004 * habitDiff(S, 'learning'), 0.002, 0.08))) {
        c.basePct = Math.min(0.98, zAdd(c.basePct, rng.float(0.08, 0.16)));
        f['ev:a_promotion'] = S.year; // the events library does not tell a second promotion story right after this one
        S.add('milestone', rng.pick(['你在单位里升了职，工资也涨了一截。', '工作上的努力被看见了，你得到了晋升。', '你开始带新人，收入也跟着往上走了一步。']), 1, ['work', 'success'], { tag: 'success', headline: '升职加薪' });
      }
      const target = Math.min(0.98, zAdd(c.basePct, expZ(c.years)));
      c.incomePct = Math.round(clampN(c.incomePct + 0.3 * (target - c.incomePct) + rng.normal(0, 0.012), 0.01, 0.99) * 1000) / 1000;
      // leaving the workforce to care for a family (where that is common)
      if (p.sex === 'female' && num(f.lastBirth, -9) === S.year && rng.chance(clampN((60 - flfp) / 80, 0.03, 0.6) * clampN(1 - 0.012 * (S.year - 2000), 0.3, 1))) {
        c.status = 'homemaker';
        S.add('milestone', '孩子出生后，你辞去了工作，专心照顾家里。', 0, ['family'], { tag: 'family', headline: '回归家庭' });
      }
      return;
    }
    case 'unemployed': {
      if (age >= ra) {
        retire(S);
        return;
      }
      if (hasPendingSet(state, 'career')) return;
      const know = num(state.stats.knowledge, 50);
      const pFind = clampN(clampN(0.6 - (unemp / 100) * 2 + (rank >= 5 ? 0.1 : 0) - (age > 50 ? 0.2 : 0) + (know - 50) / 300 - (ctx.conflict >= 3 ? 0.2 : 0), 0.12, 0.85)
        + fm(S, 'findJob') + 0.03 * habitDiff(S, 'learning'), 0.08, 0.95);
      if (rng.chance(pFind)) {
        const keepTitle = c.title && rng.chance(0.5);
        const job = keepTitle ? { title: c.title, sector: c.sector || '服务业', pct: Math.max(0.1, num(c.basePct, c.incomePct) - 0.02) } : pickJob(S);
        setJob(S, job, job.self ? 'self_employed' : 'employed', true, job.self ? `你自己做起了${job.title}，家里重新有了进项。` : `你找到了一份新工作：${job.title}。`);
      } else if (S.state.stats.health < 22 && rng.chance(0.3)) {
        c.status = 'unable';
      }
      return;
    }
    case 'homemaker': {
      if (age >= ra) {
        p.money.pension = econ.pensionFor(S.data, S.world, state);
        c.status = 'retired';
        markRetired(p, S.year, 'homemaker');
        return;
      }
      const kids = p.children.filter((k) => k.alive !== false);
      const youngest = kids.length ? Math.min(...kids.map((k) => S.year - num(k.birthYear, S.year))) : 99;
      if (age < 55 && youngest >= 6 && rng.chance(clampN(0.06 + flfp / 500, 0.05, 0.25) + fm(S, 'returnWork'))) {
        const job = pickJob(S);
        setJob(S, { ...job, pct: Math.max(0.08, job.pct - 0.06) }, job.self ? 'self_employed' : 'employed', true, `孩子大了，你重新出去工作，做起了${job.title}。`);
      }
      return;
    }
    case 'military': {
      if (hasPendingSet(state, 'career')) return;
      if (f.careerSoldier) {
        c.years = num(c.years, 0) + 1;
        if (age >= ra) retire(S);
        return;
      }
      const since = num(f.enlisted, num(f.served, S.year - 5));
      if (S.year - since >= 3) {
        c.status = 'unemployed';
        c.title = null;
        c.sector = null;
        f.veteran = true;
      }
      return;
    }
    case 'unable':
      if (age >= ra) {
        p.money.pension = econ.pensionFor(S.data, S.world, state);
        c.status = 'retired';
        markRetired(p, S.year, 'unable');
        return;
      }
      if (S.state.stats.health > 45 && rng.chance(0.35)) c.status = 'unemployed';
      return;
    case 'retired':
    default:
      return;
  }
}

/**
 * Bookkeeping when someone stops working for good: the year (flags.retiredYear), what they did before
 * (flags.retiredFrom), no business any more, and the events library's "retirement day" story marked as told,
 * because the engine narrates the retirement itself.
 */
function markRetired(p, year, from) {
  const f = p.flags;
  f.retiredYear = year;
  if (typeof from === 'string') f.retiredFrom = from;
  if (f.business) f.business = false;
  if (f['ev:s_retire_day'] == null) f['ev:s_retire_day'] = year;
}

function retire(S) {
  const { p, state } = S;
  const c = p.career;
  p.money.pension = econ.pensionFor(S.data, S.world, state);
  const farmer = isFarmer(c);
  const was = c.status;
  c.status = 'retired';
  markRetired(p, S.year, was);
  const ig = S.ctx.incomeGroup;
  const text = farmer ? '你干不动重活了，把地交给了年轻人，在家里帮忙看看孩子、喂喂鸡。'
    : was === 'unemployed' ? '到了退休的年纪，你不再找工作，开始领取养老金过日子。'
      : ig === 'LIC' || (ig === 'LMC' && was === 'self_employed') ? '你放下了手里的活计，不再出去挣钱，日子要靠积蓄和孩子们帮衬。'
        : `你办完了退休手续${c.title ? `，结束了${c.title}的职业生涯` : ''}。第二天早上，你照常醒得很早。`;
  S.add('milestone', text, 1, ['retire'], { tag: 'retire', headline: '退休' });
}

/* ------------------------------------------------------------------ love, marriage, children */

const ARRANGED = new Set(['SAS', 'NAF', 'CAS']);
const ULTIMATE = { SAS: 0.98, SSA: 0.95, WAS: 0.95, NAF: 0.95, CAS: 0.95, EAS: 0.92, SEA: 0.92, EEU: 0.9, LAC: 0.88, WEU: 0.82, NAM: 0.85, OCE: 0.85 };
const LOW_MARRIAGE = { JPN: 0.83, KOR: 0.85, TWN: 0.84, HKG: 0.84, SGP: 0.86 };
const DIVORCE = { WEU: 0.011, NAM: 0.012, OCE: 0.011, EEU: 0.013, LAC: 0.008, EAS: 0.007, SEA: 0.005, SAS: 0.0015, WAS: 0.006, NAF: 0.006, SSA: 0.007, CAS: 0.007 };
const COHABIT = new Set(['WEU', 'NAM', 'OCE', 'LAC', 'EEU']);

function arranged(S) {
  const region = S.ctx.region;
  if (ARRANGED.has(region)) return true;
  if (region === 'WAS' && !['ISR', 'CYP', 'GEO', 'ARM'].includes(S.p.country)) return true;
  if (region === 'SSA' && (!S.p.urban || S.p.familyPct < 0.4)) return true;
  return false;
}

function marriageMedian(S) {
  const lp = S.lp || {};
  const mm = isObj(lp.median_first_marriage_age) ? lp.median_first_marriage_age : {};
  let M = num(mm[S.p.sex], S.p.sex === 'female' ? 25 : 28);
  if (!isNum(M) || M < 15 || M > 45) M = S.p.sex === 'female' ? 25 : 28;
  const ref = num(mm.year, 2015);
  const by = num(S.state.birth && S.state.birth.year, S.year - S.age);
  M += clampN((by + M - ref) * 0.05, -2, 3);
  return M;
}

/** ever-in-union CDF shape (log-logistic) calibrated so half are in a first union by the median age. */
function firstUnionHazard(S) {
  const age = S.age;
  const a0 = S.p.sex === 'female' ? 14 : 16;
  if (age <= a0) return 0;
  const region = S.ctx.region;
  let U = LOW_MARRIAGE[S.p.country] ?? ULTIMATE[region] ?? 0.88;
  const by = num(S.state.birth && S.state.birth.year, S.year - S.age);
  if (S.ctx.incomeGroup === 'HIC' || S.ctx.incomeGroup === 'UMC') U -= clampN((by - 2000) * 0.002, 0, 0.12);
  U = clampN(U, 0.55, 0.99);
  const dating = !arranged(S);
  const M = marriageMedian(S) - (dating ? 1.6 : 0);
  const k = 4;
  const mPrime = a0 + Math.max(1, M - a0) * Math.pow(Math.max(0.02, 2 * U - 1), 1 / k);
  const F = (a) => (a <= a0 ? 0 : U / (1 + Math.pow((a - a0) / (mPrime - a0), -k)));
  const f0 = F(age - 0.5);
  const f1 = F(age + 0.5);
  return f1 > f0 ? (f1 - f0) / Math.max(0.01, 1 - f0) : 0;
}

function formUnion(S, status, how) {
  const { p, rng, data, state } = S;
  const sex = p.sex === 'female' ? 'male' : 'female';
  const name = freshPartnerName(data, p, sex, rng);
  const partner = normPartner(data, state, { name, sinceYear: S.year, sex }, rng);
  if (p.relationship.partner) rememberPartner(p, p.relationship.partner);
  p.relationship.status = status;
  p.relationship.partner = partner;
  if ((status === 'married' || status === 'partnered') && !p.flags.firstUnion) p.flags.firstUnion = S.year;
  if (status === 'married' || status === 'partnered') {
    if (!isNum(p.flags.kidTarget)) p.flags.kidTarget = drawKidTarget(state, S.ctx, rng);
  }
  if (status === 'dating') {
    const meet = how || rng.pick([`你在朋友的聚会上认识了${name}，散场后你们又沿着街走了很久。`, `你和${name}在一起了。第一次约会，你紧张得把奶茶打翻在了桌上。`, `你和同事${name}越走越近，终于在一个下雨的傍晚说出了心里话。`]);
    S.add('milestone', meet, 2, ['love'], { tag: 'love', headline: '恋爱' });
  } else {
    S.add('milestone', how || `经家里人介绍，你和${name}结婚了。婚礼上来了很多亲戚，你几乎一整天都在敬酒。`, 2, ['love', 'family'], { tag: 'love', headline: '结婚' });
    addStats(state, 'happiness', 6);
    addStats(state, 'relationships', 6);
  }
}

function familyStep(S) {
  const { p, rng, state, ctx } = S;
  const age = S.age;
  const f = p.flags;
  const rel = p.relationship;
  if (age < 14) return;
  const relSt = num(state.stats.relationships, 55);
  const personal = clampN(Math.exp((relSt - 55) / 60) * (f.singleByChoice ? 0.15 : 1) * (p.education.inSchool && age >= 18 ? 0.7 : 1)
    * (state.stats.health < 30 ? 0.6 : 1) * (f.marriagePressure ? 1.3 : 1), 0.05, 2.5) * fm(S, 'union');
  switch (rel.status) {
    case 'single': {
      if (!f.firstUnion) {
        const h = firstUnionHazard(S) * personal;
        if (h > 0 && rng.chance(clampN(h, 0, 0.9))) {
          if (arranged(S)) formUnion(S, 'married');
          else formUnion(S, 'dating');
        }
      } else if (age < 70 && rng.chance((age < 40 ? 0.12 : age < 60 ? 0.05 : 0.015) * personal)) {
        formUnion(S, 'dating');
      }
      return;
    }
    case 'dating': {
      const partner = rel.partner ? rel.partner.name : 'TA';
      const yrs = S.year - num(rel.partner && rel.partner.sinceYear, S.year);
      if (yrs < 1) return;
      const r = rng.next();
      const cohab = COHABIT.has(ctx.region) ? 0.12 : 0.02;
      const pWed = clampN(0.38 * fm(S, 'marry'), 0, 0.7);
      const pSplit = 0.12 * fm(S, 'breakup');
      if (r < pWed) {
        p.relationship.status = 'married';
        if (!f.firstUnion) f.firstUnion = S.year;
        if (!isNum(f.kidTarget)) f.kidTarget = drawKidTarget(state, ctx, rng);
        S.add('milestone', rng.pick([`你和${partner}结婚了。交换戒指时，你的手有点抖。`, `你和${partner}领了结婚证。那天晚上，你们在小饭馆里点了一桌菜，算是庆祝。`, `你和${partner}办了一场不大的婚礼，来的都是最亲近的人。`]), 2, ['love', 'family'], { tag: 'love', headline: '结婚' });
        addStats(state, 'happiness', 6);
        addStats(state, 'relationships', 5);
      } else if (r < pWed + cohab) {
        p.relationship.status = 'partnered';
        if (!f.firstUnion) f.firstUnion = S.year;
        if (!isNum(f.kidTarget)) f.kidTarget = drawKidTarget(state, ctx, rng);
        S.add('milestone', `你和${partner}搬到了一起住。两个人的东西挤满了小小的房间。`, 1, ['love'], { tag: 'love', headline: '同居' });
      } else if (r < pWed + cohab + pSplit) {
        rememberPartner(p, rel.partner);
        p.relationship.status = 'single';
        p.relationship.partner = null;
        S.add('milestone', `你和${partner}分手了。最后一次见面，你们说了声“保重”。`, -1, ['love', 'loss'], { tag: 'love', headline: '分手' });
        addStats(state, 'happiness', -5);
      }
      return;
    }
    case 'partnered': {
      const partner = rel.partner ? rel.partner.name : 'TA';
      const r = rng.next();
      const pWed = 0.1 * fm(S, 'marry');
      if (r < pWed) {
        p.relationship.status = 'married';
        S.add('milestone', `在一起几年后，你和${partner}决定结婚。`, 2, ['love'], { tag: 'love', headline: '结婚' });
        addStats(state, 'happiness', 4);
      } else if (r < pWed + 0.04 * fm(S, 'divorce') * fm(S, 'breakup')) {
        rememberPartner(p, rel.partner);
        p.relationship.status = 'single';
        p.relationship.partner = null;
        S.add('milestone', `你和${partner}分开了，各自搬了出去。`, -1, ['loss'], { tag: 'loss', headline: '分开' });
        addStats(state, 'happiness', -6);
      }
      return;
    }
    case 'married': {
      const partner = rel.partner ? rel.partner.name : '伴侣';
      const yrs = S.year - num(rel.partner && rel.partner.sinceYear, S.year);
      let pd = (DIVORCE[ctx.region] ?? 0.008) * (yrs <= 1 ? 0.6 : yrs <= 8 ? 1.3 : 0.8);
      if (p.country === 'CHN' || p.country === 'KOR') pd *= 1 + clampN((S.year - 2000) * 0.02, 0, 0.6);
      if (p.country === 'PHL') pd *= 0.25; // no divorce law: marriages end only through rare annulments
      if (state.stats.happiness < 35) pd *= 1.5;
      if (p.children.some((k) => k.alive !== false && S.year - num(k.birthYear, S.year) < 6)) pd *= 0.7;
      pd *= fm(S, 'divorce');
      if (rng.chance(pd)) {
        rememberPartner(p, rel.partner);
        p.relationship.status = 'divorced';
        p.relationship.partner = null;
        const hasKids = p.children.some((k) => k.alive !== false);
        S.add('milestone', hasKids ? `你和${partner}离婚了。最难的是告诉孩子们，你们约好了：不在孩子面前说对方一句坏话。` : `你和${partner}离婚了。办完手续，两个人在台阶上站了一会儿，各自往不同的方向走去。`, -2, ['loss', 'family'], { tag: 'loss', headline: '离婚' });
        addStats(state, 'happiness', -8);
        addStats(state, 'relationships', -5);
        const split = Math.max(0, p.money.cash) * 0.4;
        p.money.cash = Math.round(p.money.cash - split);
      }
      return;
    }
    case 'divorced':
    case 'widowed': {
      if (age >= 75) return;
      const pr = (age < 45 ? 0.1 : age < 65 ? 0.04 : 0.012) * personal;
      if (rng.chance(pr)) {
        if (arranged(S) && rng.chance(0.6)) formUnion(S, 'married', null);
        else formUnion(S, 'dating', rng.pick(['你重新遇到了一个让你心动的人。你们从散步聊天开始，慢慢走近。', '朋友介绍你认识了一个人。你们都经历过一些事，相处起来格外体贴。']));
      }
      return;
    }
    default:
  }
}

function birthsStep(S) {
  const { p, rng, state, ctx, data } = S;
  const rel = p.relationship;
  const f = p.flags;
  if (!['married', 'partnered', 'dating'].includes(rel.status) || !rel.partner) return;
  const motherAge = p.sex === 'female' ? S.age : S.year - num(rel.partner.birthYear, S.year - S.age + 3);
  if (motherAge < 15 || motherAge > 49) return;
  if (f.childfree === true) return;
  const born = p.children.length;
  if (!isNum(f.kidTarget)) f.kidTarget = drawKidTarget(state, ctx, rng);
  let target = f.kidTarget;
  if (isNum(f.wantChild) && S.year - f.wantChild <= 4) target = Math.max(target, born + 1);
  if (f.noMoreKids) target = Math.min(target, born);
  const shape = motherAge < 18 ? 0.6 : motherAge <= 32 ? 1 : motherAge <= 45 ? 1 - (motherAge - 32) / 14 : 0.02;
  let pb = born < target ? (born === 0 ? 0.42 : 0.3) * shape : 0.012 * shape;
  if (isNum(f.childLater) && S.year - f.childLater <= 3) pb *= 0.25;
  if (rel.status === 'dating') pb *= ['LAC', 'SSA', 'WEU', 'NAM', 'OCE'].includes(ctx.region) ? 0.15 : 0.02;
  // a couple that only got together this year rarely has a baby before the year is out; a wedding this year after
  // a courtship sometimes comes with one
  if (num(rel.partner.sinceYear, S.year) >= S.year) pb *= 0.12;
  else if (num(f.firstUnion, 0) === S.year) pb *= 0.4;
  if (num(f.lastBirth, -9) === S.year - 0) return;
  if (num(f.lastBirth, -9) >= S.year - 1) pb *= 0.35;
  if (!rng.chance(clampN(pb, 0, 0.6))) return;
  const srb = num(safe(() => data.series(p.country, 'srb', S.year)), 105);
  const sex = rng.chance(srb / (100 + srb)) ? 'male' : 'female';
  // the children of one couple share a family name: the father's, or the one the first child was given
  let surname = p.sex === 'male' ? p.surname || guessSurname(data, p.country, p.name) : rel.partner.surname || guessSurname(data, p.country, rel.partner.name);
  // never the parent's own name or a brother's or sister's
  const family = [p.name, rel.partner.name, ...p.children.map((k) => k && k.name)];
  let cn = childName(data, p.country, sex, S.year, rng, surname);
  if (!surname && cn.surname) surname = cn.surname;
  for (let i = 0; i < 6 && nameClash(cn.name, family); i++) cn = childName(data, p.country, sex, S.year, rng, surname);
  const name = cn.name;
  if (p.sex === 'female' && !rel.partner.surname && surname) rel.partner.surname = surname;
  const older = p.children.filter((k) => k && k.alive !== false);
  p.children.push({ name, sex, birthYear: S.year, alive: true });
  f.lastBirth = S.year;
  const first = born === 0;
  const word = sex === 'male' ? '儿子' : '女儿';
  const sibWord = older.length === 1 ? (older[0].sex === 'female' ? '姐姐' : '哥哥')
    : older.every((k) => k.sex === 'female') ? '姐姐们' : older.every((k) => k.sex !== 'female') ? '哥哥们' : '哥哥姐姐们';
  const text = first ? `你的${word}${name}出生了。你第一次抱起这个小小的生命时，手足无措，又满心欢喜。你当上了${p.sex === 'male' ? '爸爸' : '妈妈'}。`
    : rng.pick([older.length ? `家里又添了一个${word}，取名${name}。${sibWord}${older.length === 1 ? '趴在摇篮边' : '围着摇篮'}看个不停。` : `家里又添了一个${word}，取名${name}。`, `你的${word}${name}出生了。家里更热闹了，也更忙了。`]);
  const entry = S.add('milestone', text, 2, ['family'], { tag: 'family', headline: first ? '初为父母' : '孩子出生' });
  const idx = p.children.length - 1;
  if (entry) entry.childIdx = idx;
  addStats(state, 'happiness', first ? 8 : 5);
  addStats(state, 'relationships', 4);
  if (p.sex === 'female') addStats(state, 'health', -2);
  // naming (CONTRACT §10): the player may pick another name before the next year; the engine's choice is the default
  if (!state.settings.headless) {
    const suggestions = safe(() => nameSuggestions(data, state, idx, surname), []) || [];
    if (suggestions.length >= 2) {
      state.namingPending = { childIndex: idx, sex, suggestions, surname: surname || '', format: nameFormat(name, surname) };
    }
  }
}

/** 'sg' (surname first, no separator), 'gs' (given·surname) or 'g' (a given name only). */
function nameFormat(name, surname) {
  const n = String(name || '');
  if (n.includes('·')) return 'gs';
  if (surname && n.startsWith(surname) && n.length > surname.length) return 'sg';
  return 'g';
}

/** 3–5 culturally fitting names for a newborn: the engine's choice first, then others with the family name. */
export function nameSuggestions(data, state, childIndex, surname) {
  const p = state.person;
  const k = p.children[childIndex];
  if (!k) return [];
  const sur = typeof surname === 'string' ? surname : '';
  const family = [p.name, p.relationship && p.relationship.partner && p.relationship.partner.name, ...p.children.filter((c, i) => i !== childIndex).map((c) => c && c.name)].filter(Boolean);
  const out = [k.name];
  const R = new Rng(hashString(`${state.id}|names|${k.birthYear}|${childIndex}`));
  for (let i = 0; i < 24 && out.length < 4; i++) {
    const cn = childName(data, p.country, k.sex, num(k.birthYear, state.year), R, sur);
    if (!cn || !cn.name || out.includes(cn.name) || nameClash(cn.name, family) || out.some((x) => givenOf(x) === givenOf(cn.name))) continue;
    out.push(cn.name);
  }
  return out;
}

/* ------------------------------------------------------------------ relatives */

function relativesStep(S) {
  const { p, rng, state, data } = S;
  const origin = (typeof p.flags.origin === 'string' && p.flags.origin) || (state.birth && state.birth.country) || p.country;
  // parents
  for (const role of ['mother', 'father']) {
    const par = p.parents[role];
    if (!par || par.alive === false) continue;
    par.age = num(par.age, 30) + 1;
    // a child who looks after them (照顾父母, a generous 孝亲费) adds a little to their years
    const care = fm(S, 'parentQ') * clampN(1 - 0.05 * habitDiff(S, 'parents'), 0.85, 1.1);
    const q = par.age >= 112 ? 1 : 1 - Math.exp(-num(safe(() => data.mx(origin, S.year, role === 'mother' ? 'female' : 'male', par.age)), 0.01) * care);
    if (rng.chance(q)) {
      par.alive = false;
      par.deathYear = S.year;
      const who = role === 'mother' ? '母亲' : '父亲';
      if (S.age < 18) {
        S.add('milestone', `你的${who}因病去世了，那一年你才 ${S.age} 岁。家里一下子空了许多，你很久都不习惯。`, -2, ['loss', 'family'], { tag: 'loss', headline: `${who}去世` });
        addStats(state, 'happiness', -14);
        addStats(state, 'relationships', -4);
        p.familyPct = clampN(p.familyPct - (role === 'father' ? 0.08 : 0.04), 0.005, 0.995);
      } else {
        const far = origin !== p.country ? `你从${cname(data, p.country)}赶回去，` : '';
        S.add('milestone', `${who}在 ${S.year} 年离开了人世，享年 ${par.age} 岁。${far}${far ? '' : '你'}守在灵前，想起小时候${role === 'mother' ? '她' : '他'}牵着你的手。`, -2, ['loss', 'family'], { tag: 'loss', headline: `${who}去世` });
        addStats(state, 'happiness', -9);
      }
    }
  }
  // partner
  const rel = p.relationship;
  if (rel.partner && ['married', 'partnered'].includes(rel.status)) {
    const pAge = S.year - num(rel.partner.birthYear, S.year - S.age);
    const psex = rel.partner.sex || (p.sex === 'female' ? 'male' : 'female');
    const q = pAge >= 112 ? 1 : 1 - Math.exp(-num(safe(() => data.mx(p.country, S.year, psex, Math.max(0, pAge))), 0.01));
    if (rng.chance(q)) {
      const nm = rel.partner.name;
      const yrs = S.year - num(rel.partner.sinceYear, S.year);
      rememberPartner(p, rel.partner);
      if (!Array.isArray(p.late)) p.late = [];
      p.late.push({ role: 'partner', name: nm, sex: psex, birthYear: num(rel.partner.birthYear, S.year - pAge), year: S.year, years: yrs, married: rel.status === 'married' });
      if (p.late.length > 6) p.late.splice(0, p.late.length - 6);
      rel.status = 'widowed';
      rel.partner = null;
      S.add('milestone', `${yrs >= 2 ? `相伴 ${yrs} 年的` : ''}${nm}离开了你。整理遗物时，你在抽屉里翻出了你们年轻时的合影。`, -2, ['loss', 'family'], { tag: 'loss', headline: '丧偶' });
      addStats(state, 'happiness', -16);
      addStats(state, 'relationships', -8);
      addStats(state, 'health', -3);
    }
  }
  // children
  for (const k of p.children) {
    if (k.alive === false) continue;
    const ka = S.year - num(k.birthYear, S.year);
    if (ka < 1) continue;
    const sx = k.sex === 'female' ? 'female' : 'male';
    const mx = (a) => num(safe(() => data.mx(p.country, S.year, sx, a)), 0.005);
    let m = 0.5 * mx(ka - 1) + 0.5 * mx(ka);
    if (ka === 1) m += 0.5 * mx(0);
    if (rng.chance(1 - Math.exp(-m))) {
      k.alive = false;
      k.deathYear = S.year;
      const word = k.sex === 'female' ? '女儿' : '儿子';
      const text = ka < 5 ? `你的${word}${k.name}没能熬过那场病，永远离开了你，年仅 ${ka} 岁。那段日子，全家人都沉浸在悲痛里。`
        : ka < 18 ? `你的${word}${k.name}因意外和病痛离开了人世，年仅 ${ka} 岁。你常常一个人坐在${k.sex === 'female' ? '她' : '他'}的房间里发呆。`
          : `你的${word}${k.name}先你一步离开了人世，年仅 ${ka} 岁。白发人送黑发人，是你一生中最难熬的日子。`;
      const e = S.add('milestone', text, -2, ['loss', 'family'], { tag: 'loss', headline: '痛失孩子' });
      if (e) {
        e.sens = 'child';
        e.gentleText = `你的${word}${k.name}早早地离开了。那段日子，全家人相互扶持着，慢慢走了过来。你一直记得${k.sex === 'female' ? '她' : '他'}笑起来的样子。`;
      }
      addStats(state, 'happiness', -18);
      addStats(state, 'health', -3);
    }
  }
}

/* ------------------------------------------------------------------ health */

const CONDITION_NAMES = {
  hypertension: '高血压', diabetes: '糖尿病', heart: '冠心病', stroke: '中风后遗症', cancer: '癌症', copd: '慢阻肺', dementia: '认知障碍',
  depression: '抑郁症', arthritis: '骨关节炎', tb: '肺结核', hiv: '艾滋病毒感染', asthma: '哮喘', long_covid: '新冠后遗症',
};
const CONDITIONS = [
  { id: 'hypertension', from: 30, base: 0.004, k: 0.05, cap: 0.045, text: '体检时发现血压偏高，医生叮嘱你少吃盐、按时吃药。', tone: -1 },
  { id: 'diabetes', from: 35, base: 0.002, k: 0.045, cap: 0.022, text: '你被诊断出糖尿病，从此要和血糖仪、药片和忌口打交道。', tone: -1 },
  { id: 'heart', from: 40, base: 0.001, k: 0.07, cap: 0.03, smoke: 1.8, text: '爬楼时胸口一阵阵发紧，检查后确诊了冠心病。', tone: -1 },
  { id: 'stroke', from: 50, base: 0.0008, k: 0.075, cap: 0.025, smoke: 1.6, text: '你突发中风，抢救后保住了性命，但说话和走路都受了影响，需要慢慢康复。', tone: -2, sev: 2 },
  { id: 'cancer', from: 25, base: 0.00025, k: 0.085, cap: 0.03, smoke: 1.6, text: '一次检查后，医生面色凝重地告诉你：是癌症。你在医院走廊里坐了很久。', tone: -2, sev: 2 },
  { id: 'copd', from: 40, base: 0.0008, k: 0.05, cap: 0.02, smoke: 4, text: '咳嗽和气喘越来越重，你被诊断为慢性阻塞性肺疾病。', tone: -1 },
  { id: 'dementia', from: 65, base: 0.002, k: 0.12, cap: 0.07, text: '你开始忘事，常常想不起刚说过的话。医生说，这是认知障碍的早期表现。', tone: -2 },
  { id: 'depression', from: 15, to: 75, base: 0.004, k: 0, cap: 0.012, text: '很长一段时间里，你提不起劲，夜里睡不着。医生说这是抑郁症，需要治疗，也需要身边人的陪伴。', tone: -2 },
  { id: 'arthritis', from: 45, base: 0.005, k: 0.03, cap: 0.03, text: '膝盖和腰越来越疼，阴雨天尤其难受，医生说是骨关节炎。', tone: -1 },
];

function healthStep(S) {
  const { p, rng, state, ctx, data } = S;
  const age = S.age;
  const f = p.flags;
  const ig = ctx.incomeGroup;
  // smoking
  if (age >= 15 && age <= 24 && !f.smoker && !f.exSmoker && f.smoker !== false) {
    const prev = smokingPrevalence(data, p.country, S.year, p.sex);
    let pi = 1 - Math.pow(1 - Math.min(0.9, prev * 1.05), 1 / 10);
    if ((EDU_RANK[p.education.level] ?? 0) >= 5) pi *= 0.7;
    if (p.familyPct < 0.3) pi *= 1.15;
    pi *= fm(S, 'smokeStart');
    // someone who once turned down a cigarette from friends (a small choice) is a little less likely to start
    if (isNum(f.refusedSmoke)) pi *= 0.6;
    if (rng.chance(pi)) {
      f.smoker = true;
      f.smokeSince = S.year;
      if (rng.chance(0.4)) S.add('event', '你学会了抽烟。一开始只是跟着朋友抽几口，后来就成了习惯。', 0, ['health'], { headline: '开始吸烟' });
    }
  } else if (f.smoker === true && age >= 25) {
    const pq = 0.02 + (p.conditions.length ? 0.05 : 0) + (ig === 'HIC' ? 0.015 : 0) + (f.healthyDiet || f.exercise ? 0.02 : 0) + fm(S, 'smokeQuit');
    if (rng.chance(pq)) {
      f.smoker = false;
      f.exSmoker = true;
      S.add('event', p.conditions.length ? '医生的一句“再抽下去就危险了”，让你下定决心戒了烟。' : '你戒掉了烟。最初的几个月很难熬，后来你发现饭菜都变香了。', 1, ['health', 'success'], { headline: '戒烟' });
    }
  }
  // conditions
  const ses = clampN(age < 25 ? p.familyPct : num(p.career.incomePct, p.familyPct), 0, 1);
  const sesF = 1 + 0.4 * (0.5 - ses);
  // lifestyle flags, the year's focus and how much more (or less) than is typical the person spends on health
  const life = (f.healthyDiet ? 0.85 : 1) * (f.exercise ? 0.85 : 1) * fm(S, 'cond') * clampN(1 - 0.07 * habitDiff(S, 'health'), 0.8, 1.2);
  for (const C of CONDITIONS) {
    if (age < C.from || (C.to && age > C.to)) continue;
    if (p.conditions.some((x) => x.id === C.id)) continue;
    let pc = Math.min(C.cap, C.base * Math.exp(C.k * (age - C.from)));
    if (C.smoke && f.smoker === true) pc *= C.smoke;
    else if (C.smoke && f.exSmoker) pc *= 1 + (C.smoke - 1) * 0.4;
    if (C.id === 'depression' && state.stats.happiness < 35) pc *= 2;
    if (C.id === 'depression') pc *= fm(S, 'depr');
    pc *= sesF * life;
    if (rng.chance(pc)) {
      p.conditions.push({ id: C.id, name: CONDITION_NAMES[C.id], sinceYear: S.year, severity: C.sev || 1 });
      S.add('milestone', C.text, C.tone, ['illness'], { tag: 'illness', headline: CONDITION_NAMES[C.id] });
      addStats(state, 'health', C.tone <= -2 ? -8 : -4);
      addStats(state, 'happiness', -3);
      break;
    }
  }
  // infectious diseases where they are common
  if (age >= 15 && (ig === 'LIC' || ig === 'LMC') && !p.conditions.some((x) => x.id === 'tb')) {
    if (rng.chance((ig === 'LIC' ? 0.0012 : 0.0008) * sesF)) {
      p.conditions.push({ id: 'tb', name: CONDITION_NAMES.tb, sinceYear: S.year, severity: 2 });
      S.add('milestone', '你咳了好几个月，检查后确诊肺结核。医生说按疗程吃药，大多数人都能治好。', -1, ['illness'], { tag: 'illness', headline: '肺结核' });
      addStats(state, 'health', -6);
    }
  }
  if (ctx.region === 'SSA' && age >= 15 && age <= 49 && !p.conditions.some((x) => x.id === 'hiv')) {
    const pv = (S.year <= 2010 ? 0.004 : 0.0015) * (S.year > 2030 ? 0.4 : 1);
    if (rng.chance(pv)) {
      p.conditions.push({ id: 'hiv', name: CONDITION_NAMES.hiv, sinceYear: S.year, severity: S.year >= 2008 ? 1 : 2 });
      S.add('milestone', S.year >= 2008 ? '你被检查出感染了艾滋病毒。好在有了免费的抗病毒药物，只要坚持服药，日子还能照常过下去。' : '你被检查出感染了艾滋病毒。那时药物还很难得到，你和家人都很害怕。', -2, ['illness'], { tag: 'illness', headline: '艾滋病毒感染' });
      addStats(state, 'health', -6);
      addStats(state, 'happiness', -8);
    }
  }
  // progression, treatment, recovery
  const cure = { HIC: 0.22, UMC: 0.15, LMC: 0.08, LIC: 0.04 }[ig] ?? 0.1;
  for (const c of p.conditions.slice()) {
    const yrs = S.year - num(c.sinceYear, S.year);
    if (yrs < 1) continue;
    if (c.id === 'cancer' && rng.chance(cure)) {
      p.conditions = p.conditions.filter((x) => x !== c);
      f.cancerSurvivor = S.year;
      S.add('milestone', '经过手术和漫长的治疗，你的病情得到了控制。复查结果出来那天，你给家里每个人都打了电话。', 2, ['success', 'health'], { tag: 'success', headline: '战胜病魔' });
      addStats(state, 'happiness', 6);
    } else if ((c.id === 'depression' || c.id === 'long_covid') && rng.chance(0.25)) {
      p.conditions = p.conditions.filter((x) => x !== c);
      if (c.id === 'depression') S.add('milestone', '在治疗和家人朋友的陪伴下，你慢慢走出了抑郁的阴影，重新感受到了生活的滋味。', 1, ['health'], { headline: '走出阴霾' });
    } else if (c.id === 'tb' && rng.chance(ig === 'LIC' ? 0.5 : 0.7)) {
      p.conditions = p.conditions.filter((x) => x !== c);
    } else if (c.severity < 3 && rng.chance(c.id === 'dementia' ? 0.25 : c.id === 'hiv' ? (S.year >= 2008 ? 0.02 : 0.15) : 0.06)) {
      c.severity += 1;
    }
  }
}

/* ------------------------------------------------------------------ natural drift */

function driftStep(S) {
  const { p, rng, state, ctx } = S;
  const st = state.stats;
  const age = S.age;
  const f = p.flags;
  const H = expectedHealth(age, num(ctx.lifeExp, 72));
  let off = 0;
  for (const c of p.conditions) off -= 4 * clampN(num(c.severity, 1), 1, 3);
  if (f.smoker === true && age >= 25) off -= 4;
  if (f.exercise) off += 3;
  if (f.healthyDiet) off += 2;
  off += (clampN(age < 25 ? p.familyPct : num(p.career.incomePct, p.familyPct), 0, 1) - 0.5) * 6;
  st.health = clampN(st.health + 0.18 * (H + off - st.health) + rng.normal(0, 1.2), 0, 100);
  // relationships
  const rel = p.relationship;
  const kidsAlive = p.children.filter((k) => k.alive !== false).length;
  const parentsAlive = (p.parents.mother.alive !== false ? 1 : 0) + (p.parents.father.alive !== false ? 1 : 0);
  let R = 44 + (['married', 'partnered'].includes(rel.status) ? 12 : rel.status === 'dating' ? 7 : 0) + Math.min(kidsAlive, 3) * 3 + parentsAlive * 2
    + Math.min(num(p.siblings, 0), 3) * 1.5 + (p.education.inSchool && age < 25 ? 4 : 0) + (['employed', 'self_employed', 'military'].includes(p.career.status) ? 3 : 0);
  if (f.migrant && S.year - num(f.migrantSince, S.year) < 5) R -= 6;
  if (age > 80) R -= 6;
  if (f.sociable) R += 4;
  st.relationships = clampN(st.relationships + 0.2 * (R - st.relationships) + rng.normal(0, 1.5), 0, 100);
  // happiness
  const hAdd = S.year > HISTORY_END ? num(safe(() => S.world.modifiers(p.country, S.year).happiness_add), 0) : 0;
  let T = 58 + 0.2 * (st.relationships - 55) + 0.12 * (st.wealth - 45) + 0.15 * (st.health - H) + 2 * hAdd;
  if (p.conditions.some((c) => c.id === 'depression')) T -= 8;
  if (p.career.status === 'unemployed' && age >= 18) T -= 6;
  if (p.career.status === 'retired') T += 2;
  if (ctx.conflict >= 2) T -= 4 * (ctx.conflict - 1);
  st.happiness = clampN(st.happiness + 0.25 * (T - st.happiness) + rng.normal(0, 2), 0, 100);
  // knowledge
  const e = p.education;
  const apt = clampN(num(f.aptitude, 1), 0.5, 1.6);
  let dk = 0;
  if (e.inSchool) {
    const sec = num(ctx.secEnroll, 60);
    const quality = 0.78 + 0.22 * Math.min(1, sec / 100) + 0.1 * (p.familyPct - 0.5) + (p.urban ? 0.03 : -0.04);
    const base = e.level === 'preschool' ? 2 : f.track === 'uni' ? 3.4 : f.track === 'postgrad' ? 3 : f.track === 'vocational' ? 3 : e.level === 'primary' ? 4.6 : 4.4;
    dk = base * apt * quality;
  } else if (age < 15) dk = 1.1 * apt;
  else if (['employed', 'self_employed', 'military'].includes(p.career.status)) dk = (EDU_RANK[e.level] >= 5 ? 0.9 : 0.5) * apt;
  else dk = 0.2;
  if (age > 72) dk -= 0.3;
  const dem = p.conditions.find((c) => c.id === 'dementia');
  if (dem) dk -= 2.5 * num(dem.severity, 1);
  st.knowledge = clampN(st.knowledge + knowGain(st.knowledge, dk + rng.normal(0, 0.4)), 0, 100);
}

/* ------------------------------------------------------------------ world events */

function vulnerability(S) {
  const { p, state } = S;
  const age = S.age;
  const ses = clampN(age < 18 ? p.familyPct : num(p.career.incomePct, p.familyPct), 0, 1);
  const health = (age < 5 ? 1.4 : age < 15 ? 0.9 : age < 60 ? 0.8 : age < 75 ? 1.2 : 1.5) * (1 + 0.6 * (0.5 - ses)) * (p.urban ? 1 : 1.1);
  const econV = (age < 18 ? 0.6 : p.career.status === 'retired' ? 0.5 : 1) * (1 + 0.8 * (0.5 - ses));
  const mood = age < 10 ? 0.7 : 1;
  return { health, econ: econV, mood, ses, state };
}

const NEWS_TAG = { war: 'war', conflict: 'war', disaster: 'crisis', epidemic: 'illness', economy: 'crisis', technology: 'calm', politics: 'calm', policy: 'calm', society: 'calm', science: 'success', sport: 'success', culture: 'calm' };

function firstSentence(s, max = 70) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const i = t.search(/[。！？；]/);
  let one = i >= 0 ? t.slice(0, i + 1) : t;
  if (one.length > max) return `${one.slice(0, max)}……`;
  if (/[；，、：]$/.test(one)) one = `${one.slice(0, -1)}。`;
  else if (!/[。！？…”」）)]$/.test(one)) one += '。';
  return one;
}

/** A short headline from an event title: the part before any comma or bracketed note, at most max characters. */
export function titleHead(title, max = 14) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  const cut = t.search(/[，。：；]/);
  if (cut > 1) t = t.slice(0, cut);
  if (t.length > max) t = t.replace(/[（(][^）)]*[）)]?$/, '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

function worldStep(S) {
  const { p, state, ctx, data } = S;
  const evs = ctx.events;
  if (!evs.length) return;
  const seen = state.seen;
  const v = vulnerability(S);
  const iso = p.country;
  const tot = { health: 0, happiness: 0, knowledge: 0 };
  let wealth = 0;
  let newsPick = null;
  let newsScore = -1;
  for (const ev of evs) {
    if (!ev || !ev.id) continue;
    const first = seen[ev.id] == null;
    if (first) seen[ev.id] = S.year;
    // a world event hits hardest the first year a person lives through it; long-running ones keep a light touch
    const scale = first ? 1 : S.year <= num(ev.endYear, ev.year) ? 0.12 : 0;
    if (!scale) continue;
    const listed = Array.isArray(ev.countries) && ev.countries.includes(iso);
    const geo = ev.scope === 'global' ? (listed ? 1 : 0.35) : 1;
    const e = ev.effects || {};
    const k = geo * scale;
    tot.health += (num(e.health) * 0.7 + Math.min(0, num(e.safety)) * 0.4) * k * v.health;
    tot.happiness += (num(e.happiness) * 1.2 + Math.min(0, num(e.safety)) * 0.5 + num(e.economy) * 0.4) * k * v.mood;
    tot.knowledge += num(e.education) * (p.education.inSchool ? 1.2 : 0.3) * k;
    if (S.age >= 18 && num(e.economy)) wealth += num(e.economy) * 0.05 * Math.max(num(p.money.income, 0), 0) * k * v.econ;
    if (first) {
      const sc = num(ev.importance, 2) * 10 + (listed || ev.scope !== 'global' ? 12 : 0) + (ev.year === S.year ? 4 : 0);
      if ((num(ev.importance, 2) >= 3 || listed || ev.scope !== 'global') && sc > newsScore) {
        newsScore = sc;
        newsPick = ev;
      }
    }
  }
  addStats(state, 'health', clampN(Math.round(tot.health), -12, 8));
  addStats(state, 'happiness', clampN(Math.round(tot.happiness), -12, 8));
  addStats(state, 'knowledge', clampN(Math.round(tot.knowledge), -5, 5));
  if (wealth) moveCash(state, clampN(wealth, -0.5 * Math.max(1, num(p.money.income, 0)) - 0, 0.3 * Math.max(1, num(p.money.income, 0))));
  if (newsPick) {
    const ev = newsPick;
    const e = ev.effects || {};
    const s = num(e.economy) + num(e.health) + num(e.happiness) + num(e.safety);
    const tone = s <= -4 ? -2 : s <= -1 ? -1 : s >= 4 ? 2 : s >= 1 ? 1 : 0;
    const summary = firstSentence(ev.summary);
    let tag = NEWS_TAG[ev.category] || 'calm';
    if (tag === 'war' && ctx.conflict < 2) tag = 'crisis';
    if (tag === 'crisis' && num(e.economy) > -1 && ev.category === 'economy') tag = 'calm';
    const text = `${ev.projection ? '【推演】' : ''}${ev.title}${summary ? `：${summary}` : '。'}`;
    S.add('news', text, tone, ['world', ev.category || 'society'], { tag, headline: titleHead(ev.title), source: ev.projection || ev.source !== 'history' ? 'future' : 'history' });
  }
}

/* ------------------------------------------------------------------ personal events */

// "nothing happened this year" stories, which must not sit next to a diagnosis, a wedding or a death in the family
const QUIET_EVENTS = new Set(['g_quiet_year', 'e_peaceful']);
// stories that belong to the first years after retirement
const RETIREMENT_EVENTS = new Set(['s_pension']);
const WORKING = ['employed', 'self_employed', 'military'];

function eventsStep(S) {
  const { data, world, state, ctx, rng, p } = S;
  let list = [];
  try {
    list = pickPersonalEvents(data, world, state, ctx, rng) || [];
  } catch {
    list = [];
  }
  const loud = (e) => e && e.kind !== 'news' && Math.abs(num(e.tone, 0)) >= 2;
  const busy = S.entries.some(loud) || list.some((x) => x && !QUIET_EVENTS.has(x.id) && Math.abs(num(x.tone, 0)) >= 2);
  for (const ev of list) {
    if (!ev || typeof ev.text !== 'string') continue;
    if (QUIET_EVENTS.has(ev.id) && (busy || (/上班/.test(ev.text) && !WORKING.includes(p.career.status)))) continue;
    if (RETIREMENT_EVENTS.has(ev.id) && !(isNum(p.flags.retiredYear) && S.year - p.flags.retiredYear <= 2)) continue;
    const tags = Array.isArray(ev.tags) ? ev.tags.filter((t) => typeof t === 'string') : [];
    const isWorld = tags.includes('world');
    // A personal reaction to a war, epidemic or disaster must not add mortality on top of the data: WPP death rates
    // already contain real crises up to 2024 and world.mortalityMult carries the world line's events after 2026
    // (CONTRACT §1). Such a story keeps its mood effects; its toll on the health stat is halved and it adds no hazard.
    let effIn = ev.effects;
    if (isWorld && isObj(effIn) && num(effIn.health, 0) < 0) effIn = { ...effIn, health: num(effIn.health, 0) / 2 };
    const eff = applyEffects(data, world, state, effIn);
    if (ev.set) applySet(data, world, state, ev.set, rng);
    if (!isWorld && isObj(ev.hazard) && isNum(ev.hazard.mult)) {
      state.hazardMods.push({ mult: clampN(ev.hazard.mult, 0.5, 2), untilYear: S.year + clampN(Math.round(num(ev.hazard.years, 1)), 1, 30) - 1, reason: String(ev.hazard.reason || '').slice(0, 40) });
    }
    S.add('event', ev.text, num(ev.tone, toneOf(eff)), tags, { tag: ev.tag, effects: eff, source: isWorld ? (S.year > HISTORY_END ? 'future' : 'history') : 'engine' });
    if (ev.decision && !state.pending && isObj(ev.decision)) state.pending = { ...ev.decision, year: S.year, age: S.age };
  }
}

/* ------------------------------------------------------------------ history row */

const TAG_BONUS = { death: 100, war: 3, migration: 3, loss: 2.5, love: 1.5, family: 1.5, illness: 1, crisis: 1, success: 0.6, retire: 1.2, study: 0.3, work: 0.3, birth: 5, childhood: 0, calm: -0.5 };

function entryTag(e) {
  if (e.tag && TAGSET.has(e.tag)) return e.tag;
  for (const t of e.tags || []) if (TAGSET.has(t)) return t;
  if (e.kind === 'death') return 'death';
  return null;
}

function defaultTag(state) {
  const p = state.person;
  if (state.age <= 5) return 'childhood';
  if (p.education.inSchool) return 'study';
  if (['employed', 'self_employed', 'military'].includes(p.career.status)) return 'work';
  if (p.career.status === 'retired') return 'retire';
  if (state.age < 15) return 'childhood';
  return 'calm';
}

/** Headline for a log line without one: a quoted 「title」 when there is one, else the first meaningful clause. */
export function shortHeadline(text) {
  const t = String(text || '').replace(/^【推演】/, '').replace(/\s+/g, ' ').trim();
  const q = /「([^」]{2,14})」/.exec(t);
  if (q) return q[1].trim();
  const parts = t.split(/[，。！？；：]/).map((x) => x.trim()).filter(Boolean);
  let h = parts[0] || t;
  if (parts.length > 1 && (h.length < 4 || /^(在这条世界线上|这一年|那一年|后来|这些年|那几年)$/.test(h))) h = parts[1];
  return h.length > 16 ? `${h.slice(0, 15)}…` : h;
}

const QUIET_LINES = {
  baby: ['你在家人的怀抱里又长大了一岁。', '你学会了更多的字词，开始满屋子跑。'],
  small: ['你在家附近和小伙伴们玩耍，一年很快就过去了。', '你跟在大人身后，看他们忙进忙出，问了无数个“为什么”。'],
  pupil: ['你按部就班地上学、放学、写作业，这一年平平稳稳。', '课本换了新的一册，同桌换了新的面孔，日子照常往前走。'],
  child: ['你帮家里做些力所能及的活，日子一天天过去。', '你在家里帮忙，闲下来就和附近的孩子们一起玩。'],
  work: ['你照常上班，日子按部就班地过着。', '这一年工作上没有大起大落，你把手头的事一件件做好。'],
  idle: ['你一边打零工一边留意招聘消息，这一年过得有些紧巴。', '你在家里帮衬着，也在等一个新的机会。'],
  home: ['你操持着家里的大小事务，一年又这样过去了。', '买菜、做饭、照看家人，你把日子安排得井井有条。'],
  sick: ['你在家里休养，身体时好时坏，日子过得很慢。', '你按时吃药、复查，盼着身体一点点好起来。'],
  retired: ['你过着退休后的日子：散步、买菜、和老朋友聊天。', '你的日子慢了下来，常常在窗边一坐就是一个下午。'],
  old: ['你的步子慢了，可每个清晨醒来，你都觉得这又是新的一天。', '这一年你大多待在家里，听听广播，看看老照片。'],
};

/** A gentle line for a year in which nothing else happened to the person (so no year of a life is blank). */
function quietLine(S) {
  const { p, rng } = S;
  const age = S.age;
  const st = p.career.status;
  const key = age < 3 ? 'baby' : age >= 85 ? 'old' : p.education.inSchool ? 'pupil' : age < 6 ? 'small' : age < 15 ? 'child'
    : st === 'retired' ? 'retired' : WORKING.includes(st) ? 'work' : st === 'homemaker' ? 'home' : st === 'unable' ? 'sick' : 'idle';
  S.add('event', rng.pick(QUIET_LINES[key]), 0, ['calm'], { headline: '平常的一年' });
}

function historyRow(state, entries, ctx) {
  let best = null;
  let bestScore = 0;
  const scores = {};
  let moodSum = 0;
  let moodW = 0;
  for (const e of entries) {
    const tag = entryTag(e);
    const w = (1 + Math.abs(num(e.tone, 0))) * (e.kind === 'news' ? 0.35 : 1);
    if (e.kind !== 'news' && e.kind !== 'decision') {
      moodSum += num(e.tone, 0) * w;
      moodW += w;
    }
    if (!tag) continue;
    // world news colours a year only weakly: the life map should show the person's own year, not the headlines
    let s = w + (TAG_BONUS[tag] ?? 0) * (e.kind === 'news' ? 0.3 : 1);
    if (tag === 'war' && ctx && ctx.conflict >= 2) s += 3;
    scores[tag] = (scores[tag] || 0) + s;
    if (scores[tag] > bestScore) {
      bestScore = scores[tag];
      best = { tag, e };
    }
  }
  let tag = best && bestScore >= 1.6 ? best.tag : defaultTag(state);
  if (state.dead) tag = 'death';
  let headline = '';
  const lead = state.dead ? entries.find((e) => e.kind === 'death') : best && best.tag === tag ? best.e : null;
  if (lead) headline = lead.headline || shortHeadline(lead.text);
  else if (entries.length) {
    const e = entries.find((x) => x.kind !== 'news') || entries[0];
    headline = e.headline || shortHeadline(e.text);
  }
  const stats = {};
  for (const k of STATS) stats[k] = Math.round(state.stats[k]);
  return {
    year: state.year,
    age: state.age,
    stats,
    tag,
    mood: moodW ? clampN(Math.round(moodSum / moodW), -2, 2) : 0,
    country: state.person.country,
    headline: headline || '平常的一年',
  };
}

/* ------------------------------------------------------------------ newLife */

function familyWords(pct) {
  return pct < 0.2 ? '十分拮据' : pct < 0.4 ? '比较紧张' : pct < 0.6 ? '在当地算是中等' : pct < 0.8 ? '比较宽裕' : '相当优渥';
}

function birthText(data, birth) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth.date || '');
  const t = /^(\d{2}):(\d{2})/.exec(birth.time || '');
  const when = d ? `${d[1]} 年 ${+d[2]} 月 ${+d[3]} 日${t ? ` ${+t[1]} 时 ${+t[2]} 分` : ''}` : `${birth.year} 年`;
  const cn = cname(data, birth.country);
  const sibs = birth.siblings > 0 ? `家里还有 ${birth.siblings} 个兄弟姐妹` : '你是家里唯一的孩子';
  return `${when}，你出生在${cn}的${birth.urban ? '一座城市' : '一个村庄'}，取名${birth.name}。家里的经济条件${familyWords(birth.familyPct)}，${sibs}。`;
}

/**
 * Create a new life at birth (CONTRACT §2). settings: {lifeMinutes, aiMode, decisionFreq, autoChoose, createdAt?,
 * cohort?:false, headless?:true}. The same-second cohort is simulated here unless settings.cohort === false or
 * settings.headless (cohort peers themselves are headless).
 */
export function newLife(data, world, birthSpec, settings, seed) {
  const seedVal = typeof seed === 'number' || typeof seed === 'string' ? seed : hashString(JSON.stringify(birthSpec || {}));
  const rng = new Rng(seedVal);
  const birth = normalizeBirth(data, world, rng.fork('birth'), birthSpec);
  const s = normSettings(settings);
  const id = `L${hashString(`${seedVal}|${birth.date}|${birth.time}|${birth.country}|${birth.name}`).toString(36)}${hashString(`id|${seedVal}`).toString(36).slice(0, 4)}`;
  const r = rng.fork('init');
  const imr = num(safe(() => data.series(birth.country, 'imr', birth.year)), 20);
  const stats = {
    health: r1(clampN(84 - imr / 25 + r.normal(0, 5), 45, 98)),
    happiness: r1(clampN(62 + (birth.familyPct - 0.5) * 10 + r.normal(0, 7), 25, 95)),
    knowledge: r1(clampN(2 + r.normal(0, 0.8), 0, 6)),
    relationships: r1(clampN(54 + Math.min(birth.siblings, 4) * 2 + r.normal(0, 6), 25, 90)),
    wealth: r1(8 + 84 * birth.familyPct),
  };
  const person = {
    name: birth.name,
    sex: birth.sex,
    country: birth.country,
    urban: birth.urban,
    familyPct: birth.familyPct,
    education: { level: 'none', inSchool: false, field: null, years: 0, exams: [] },
    career: { status: 'child', title: null, sector: null, incomePct: clampN(birth.familyPct, 0.02, 0.98), years: 0, employer: null },
    relationship: { status: 'single', partner: null },
    children: [],
    parents: { mother: { age: birth.motherAge, alive: true }, father: { age: birth.fatherAge, alive: true } },
    siblings: birth.siblings,
    money: { cash: 0, debt: 0, income: 0, portfolio: emptyPortfolio() },
    conditions: [],
    flags: { aptitude: Math.round(clampN(r.normal(1, 0.18), 0.55, 1.5) * 100) / 100 },
  };
  if (birth.surname) person.surname = birth.surname;
  const state = {
    v: 1,
    id,
    seed: seedVal,
    rng: [0, 0, 0, 0],
    createdAt: isObj(settings) && typeof settings.createdAt === 'string' ? settings.createdAt : null,
    mode: birth.mode,
    worldSeed: world && world.seed != null ? world.seed : null,
    worldLabel: (world && typeof world.label === 'string' && world.label) || '',
    settings: s,
    birth,
    year: birth.year,
    age: 0,
    person,
    stats,
    history: [],
    log: [],
    decisions: [],
    threads: [],
    hazardMods: [],
    pending: null,
    dead: null,
    cohort: [],
    aiNotes: { birthStory: null, lastSummary: null },
    seen: {},
    // interactivity layer (CONTRACT §10)
    focus: { current: null, auto: true },
    habits: { dining: 0, parents: 0, travel: 0, learning: 0, health: 0, charity: 0 },
    habitLock: {},
    stars: [],
    notes: [],
    smallPending: null,
    namingPending: null,
    reflectPending: null,
    rare: [],
    smallSeen: {},
    logSeq: 0,
  };
  person.pets = [];
  person.money.allocation = null;
  const entry = { year: birth.year, age: 0, kind: 'birth', text: birthText(data, birth), tone: 1, tags: ['birth'], tag: 'birth', source: 'engine', headline: '出生' };
  state.log.push(stampId(state, entry));
  if (birth.customText) state.log.push(stampId(state, { year: birth.year, age: 0, kind: 'system', text: `特殊出身：${birth.customText}`, tone: 0, tags: ['birth'], source: 'engine' }));
  state.history.push({ year: birth.year, age: 0, stats: Object.fromEntries(STATS.map((k) => [k, Math.round(stats[k])])), tag: 'birth', mood: 1, country: birth.country, headline: '出生', focus: null, income: 0 });
  if (s.cohort !== false && !s.headless) {
    state.cohort = safe(() => makeCohort(data, world, birth, rng.fork('cohort')), []) || [];
  }
  state.rng = rng.state();
  return state;
}

/* ------------------------------------------------------------------ stepYear */

function isMilestoneAge(state, age) {
  const probe = { age: age - 1, settings: state.settings, seed: state.seed, id: state.id };
  return safe(() => nextDecisionAge(probe, state.settings && state.settings.decisionFreq), 999) === age;
}

/**
 * Advance exactly one calendar year (CONTRACT §2). Mutates state; returns
 * {year, age, entries, news, decision, died, stats}. Does nothing while a decision is pending or after death.
 */
export function stepYear(data, world, state) {
  if (!state || typeof state !== 'object') {
    return { year: 0, age: 0, entries: [], news: [], decision: null, died: null, stats: {} };
  }
  ensureState(state);
  if (state.dead) return { year: state.year, age: state.age, entries: [], news: [], decision: null, died: state.dead, stats: { ...state.stats } };
  if (state.pending) return { year: state.year, age: state.age, entries: [], news: [], decision: state.pending, died: null, stats: { ...state.stats } };

  // what last year left open: an unanswered small choice resolves itself, the newborn keeps the suggested name,
  // an unwritten reflection is let go
  const pre = settleOpen(data, world, state);

  const rng = new Rng(state.rng);
  state.year += 1;
  state.age += 1;
  const S = makeStep(data, world, state, rng);
  S.milestone = state.age >= 5 && isMilestoneAge(state, state.age);
  state.hazardMods = state.hazardMods.filter((h) => isObj(h) && (!isNum(h.untilYear) || h.untilYear >= state.year));
  refreshCtx(S);

  const run = (fn) => {
    try {
      fn(S);
    } catch (err) {
      if (typeof globalThis !== 'undefined' && globalThis.__LL_DEBUG__) throw err;
    }
  };
  run(chooseFocus);
  run(relativesStep);
  run(siblingsStep);
  run(petsStep);
  run(fireThreads);
  refreshCtx(S);
  run(educationStep);
  run(workStep);
  run(familyStep);
  run(birthsStep);
  run(healthStep);
  run(driftStep);
  run(focusStep);
  run(worldStep);
  run(eventsStep);
  run(syncPets);
  run(rareStep);
  refreshCtx(S);
  let finNotes = [];
  try {
    finNotes = econ.updateFinances(data, world, state, rng, { mods: S.fmods, texture: textureOf(state) }) || [];
  } catch {
    finNotes = [];
  }
  for (const n of finNotes) S.add(n.kind || 'milestone', n.text, n.tone, n.tags || [], { tag: n.tag, headline: n.headline });
  for (const k of STATS) state.stats[k] = r1(clampN(num(state.stats[k], 50), 0, 100));
  state.stats.wealth = safe(() => econ.wealthStat(data, world, state), state.stats.wealth);

  // mortality
  let died = null;
  const hz = safe(() => hazardFor(data, world, state), null);
  if (hz && rng.next() < hz.q) {
    const timing = deathTiming(state, hz.parts, rng);
    const cause = safe(() => sampleCause(data, world, state, rng, S.ctx), { id: 'other', name: '疾病', detail: '' });
    died = deathRecord(data, world, state, cause, timing);
    state.dead = died;
    state.pending = null;
    state.smallPending = null;
    state.namingPending = null;
    state.reflectPending = null;
    const old = died.age >= 85;
    const text = `${died.date.slice(0, 4)} 年，${state.person.name}因${cause.name}${cause.detail ? `（${cause.detail}）` : ''}离开了这个世界，享年 ${died.age} 岁。${old ? '走的时候很安详。' : ''}`;
    const de = S.add('death', text, -2, ['death'], { tag: 'death', headline: '离世' });
    const sens = cause.id === 'suicide' ? 'suicide' : cause.id === 'violence' ? 'violence' : died.age < 5 ? 'child' : null;
    if (de && sens) {
      de.sens = sens;
      de.gentleText = died.age < 5
        ? `${died.date.slice(0, 4)} 年，${state.person.name}离开了这个世界。这个小小的生命在世上停留的时间很短，却被深深地爱过。`
        : `${died.date.slice(0, 4)} 年，${state.person.name}${sens === 'violence' && S.ctx.conflict < 2 ? '在一场不幸中' : ''}离开了这个世界，享年 ${died.age} 岁。`;
      if (sens !== 'child') died.causeGentle = { name: sens === 'violence' && S.ctx.conflict >= 2 ? '战乱' : '离世', detail: '' };
    }
  }

  // decisions
  if (!state.dead && !state.pending && state.age >= 5) {
    try {
      if (S.milestone) {
        const d = buildDecisionOffline(data, world, state, S.ctx, rng.fork(`decision:${state.year}`));
        if (d && Array.isArray(d.options) && d.options.length >= 2) state.pending = { ...d, kind: 'milestone' };
      } else {
        const d = triggeredDecision(data, world, state, S.ctx, rng.fork(`trigger:${state.year}`));
        if (d && Array.isArray(d.options) && d.options.length >= 2) state.pending = d;
      }
    } catch {
      /* no decision this year */
    }
  }
  if (!state.dead && !state.pending && !S.entries.some((e) => e.kind !== 'news' && e.kind !== 'system')) {
    try {
      quietLine(S);
    } catch {
      /* a blank year is still a valid year */
    }
  }
  // the interactive moments of the year (CONTRACT §10): a small choice, a reflection
  if (!state.dead) {
    run(offerSmall);
    run(offerReflection);
  }

  const row = historyRow(state, S.entries, S.ctx);
  row.focus = S.focus || null;
  if (S.focus) row.focusAuto = !!S.focusAuto;
  row.income = Math.max(0, Math.round(num(state.person.money.income, 0)));
  state.history.push(row);
  for (const e of S.entries) state.log.push(finishEntry(state, e));
  state.rng = rng.state();
  const news = safe(() => world.headlines(state.year, state.person.country, 6), []) || [];
  return { year: state.year, age: state.age, entries: pre.concat(S.entries), news, decision: state.pending || null, died, stats: { ...state.stats } };
}

/* ------------------------------------------------------------------ applyResolution */

function choiceLabel(decision, choice) {
  if (choice && typeof choice === 'object' && typeof choice.customText === 'string' && choice.customText.trim()) {
    return { label: choice.customText.replace(/\s+/g, ' ').trim().slice(0, 120), custom: true };
  }
  const id = typeof choice === 'string' ? choice : choice && choice.optionId;
  const opts = decision && Array.isArray(decision.options) ? decision.options : [];
  const o = opts.find((x) => x && x.id === id);
  return { label: o ? String(o.label) : id ? String(id) : '顺其自然', custom: false };
}

function choiceTags(before, state, set) {
  const p = state.person;
  if (before.country !== p.country) return ['migration'];
  if (before.rel !== p.relationship.status) {
    if (p.relationship.status === 'married' || p.relationship.status === 'dating' || p.relationship.status === 'partnered') return ['love'];
    return ['loss'];
  }
  if (before.kids !== p.children.length) return ['family'];
  if (before.status !== p.career.status) return [p.career.status === 'retired' ? 'retire' : p.career.status === 'student' ? 'study' : p.career.status === 'unemployed' ? 'crisis' : 'work'];
  if (isObj(set) && isObj(set.education)) return ['study'];
  if (isObj(set) && set.addCondition) return ['illness'];
  return [];
}

/**
 * Apply the result of a decision (CONTRACT §2): effects, set, threads, hazard; record the choice; clear the pending
 * decision it answers. Returns the LogEntries it added (also pushed to state.log). Never throws.
 */
export function applyResolution(data, world, state, decision, choice, resolution) {
  if (!state || typeof state !== 'object') return [];
  ensureState(state);
  const d = isObj(decision) ? decision : {};
  const r = isObj(resolution) ? resolution : {};
  const p = state.person;
  const entries = [];
  const src = d.source === 'ai' || r.source === 'ai' ? 'ai' : 'engine';
  const { label, custom } = choiceLabel(d, choice);
  const rng = new Rng(state.rng).fork(`apply:${d.id || ''}:${label}`);
  const before = { country: p.country, rel: p.relationship.status, kids: p.children.length, status: p.career.status };
  const mk = (kind, text, tone, tags, extra = {}) => {
    const e = { year: state.year, age: state.age, kind, text: String(text), tone: clampN(Math.round(num(tone, 0)), -2, 2), tags, source: extra.source || 'engine' };
    if (extra.effects) e.effects = extra.effects;
    if (extra.tag) e.tag = extra.tag;
    if (extra.headline) e.headline = extra.headline;
    entries.push(e);
    return e;
  };
  try {
    state.decisions.push({
      id: String(d.id || `d-${state.year}-${state.age}`), year: state.year, age: state.age, title: String(d.title || (custom ? '主动选择' : '抉择')).slice(0, 30),
      choice: label, custom, source: d.source === 'ai' ? 'ai' : 'local',
    });
    mk('decision', custom ? `你决定：「${label}」` : `「${String(d.title || '人生的岔路口').slice(0, 30)}」——你选择了「${label}」。`, 0, ['decision'], { headline: String(d.title || '抉择').slice(0, 14) });
    const eff = applyEffects(data, world, state, r.effects);
    if (isObj(r.set)) applySet(data, world, state, r.set, rng);
    addThreads(state, r.threads, src === 'ai' ? 'ai' : 'local');
    if (isObj(r.hazard) && isNum(r.hazard.mult)) {
      state.hazardMods.push({ mult: clampN(r.hazard.mult, 0.5, 2), untilYear: state.year + clampN(Math.round(num(r.hazard.years, 1)), 1, 30) - 1, reason: String(r.hazard.reason || '').slice(0, 40) });
    }
    const tags = choiceTags(before, state, r.set);
    const narrative = typeof r.narrative === 'string' && r.narrative.trim() ? r.narrative.trim() : '你做出了选择。日子照常往前走，结果还要慢慢显现。';
    mk('choice', narrative, toneOf(eff), tags.length ? tags : ['decision'], { effects: eff, tag: tags[0], source: src });
    if (r.feasible === false && typeof r.note === 'string' && r.note.trim()) mk('system', `（这条路没能走通：${r.note.trim().slice(0, 40)}）`, 0, ['note']);
    // derived values
    if (before.status !== p.career.status || isObj(r.set && r.set.career)) {
      p.money.income = Math.round(safe(() => econ.incomeFor(data, world, state), p.money.income));
    }
    for (const k of STATS) state.stats[k] = r1(clampN(num(state.stats[k], 50), 0, 100));
    state.stats.wealth = safe(() => econ.wealthStat(data, world, state), state.stats.wealth);
    // the year's history row reflects the choice
    const row = state.history.length ? state.history[state.history.length - 1] : null;
    if (row && row.year === state.year && !state.dead) {
      for (const k of STATS) row.stats[k] = Math.round(state.stats[k]);
      row.country = p.country;
      if (tags.length && TAGSET.has(tags[0]) && ['migration', 'love', 'family', 'loss'].includes(tags[0]) && !['war', 'death', 'loss'].includes(row.tag)) {
        row.tag = tags[0];
        row.headline = String(d.title || label).slice(0, 14);
      } else if (['calm', 'childhood', 'study', 'work', 'retire'].includes(row.tag) && (row.headline === '平常的一年' || !row.headline)) {
        row.headline = String(d.title || label).slice(0, 14);
      }
    }
  } catch {
    /* keep whatever was applied */
  }
  if (state.pending && (state.pending === decision || (d.id && state.pending.id === d.id))) state.pending = null;
  // a pet the resolution brought into the life gets a name and a place in the family panel
  safe(() => adoptPetFromFlag(state, typeof r.narrative === 'string' ? r.narrative : ''));
  for (const e of entries) state.log.push(finishEntry(state, e));
  return entries;
}

/* ------------------------------------------------------------------ survival curve */

/**
 * Survival from the current age (CONTRACT §2): ages = [age .. 115]; personal[i] / baseline[i] = probability of being
 * alive at ages[i] given alive now, with and without this person's multiplier (which fades toward 1 over ~25 years)
 * and active hazardMods. Both follow the birth cohort's diagonal of the residence country's tables and the world line.
 */
export function survivalCurve(data, world, state) {
  const ages = [];
  const personal = [];
  const baseline = [];
  if (!state || !state.person) return { ages, personal, baseline };
  const p = state.person;
  const iso = p.country;
  const sex = p.sex === 'female' ? 'female' : 'male';
  const age0 = Math.max(0, Math.floor(num(state.age, 0)));
  const by = num(state.year, 2000) - age0;
  if (state.dead) return { ages: [age0], personal: [0], baseline: [0] };
  let pm = 1;
  try {
    pm = clampN(personalMultiplier(data, world, state).mult, 0.25, 6);
  } catch {
    pm = 1;
  }
  let sp = 1;
  let sb = 1;
  let ep = 0;
  let eb = 0;
  ages.push(age0);
  personal.push(1);
  baseline.push(1);
  for (let x = age0; x < MAX_AGE; x++) {
    const y = by + x + 1;
    const m = num(safe(() => data.mx(iso, Math.min(y, 2100), sex, x)), 0.01) * num(safe(() => world.mortalityMult(iso, y, x)), 1);
    const fade = Math.exp(-(x - age0) / 25);
    const mult = clampN((1 + (pm - 1) * fade) * modsMultiplier(state, y), 0.25, 6);
    const psb = Math.exp(-m);
    const psp = Math.exp(-m * mult);
    eb += sb * (1 + psb) / 2;
    ep += sp * (1 + psp) / 2;
    sb *= psb;
    sp *= psp;
    ages.push(x + 1);
    personal.push(Math.round(sp * 1e5) / 1e5);
    baseline.push(Math.round(sb * 1e5) / 1e5);
  }
  return { ages, personal, baseline, remaining: { personal: r1(ep), baseline: r1(eb) } };
}

/* ------------------------------------------------------------------ small public helpers */

/** Short Chinese status line for a life in its current year (used by the cohort timeline). */
export function statusLine(data, state) {
  const p = state.person;
  if (state.dead) return '已离世';
  const age = state.age;
  const e = p.education;
  const c = p.career;
  let s;
  if (age < 3) s = '襁褓之中';
  else if (e.inSchool) {
    const tr = p.flags.track;
    s = e.level === 'preschool' ? '上幼儿园' : tr === 'uni' ? '读大学' : tr === 'postgrad' ? '读研究生' : tr === 'vocational' ? '读职业学校'
      : e.level === 'primary' ? '读小学' : age < 15 ? '读初中' : age < 19 ? '读高中' : '在读书';
  } else if (age < 6) s = '还没上学';
  else if (age < 15) s = p.flags.noSchool ? '没能上学，在家帮忙' : '在家帮忙';
  else {
    switch (c.status) {
      case 'employed': s = c.title ? `做${c.title}` : '在工作'; break;
      case 'self_employed': s = /农/.test(`${c.title || ''}${c.sector || ''}`) ? '务农' : c.title ? `做${c.title}` : '做小生意'; break;
      case 'unemployed': s = '在找工作'; break;
      case 'homemaker': s = '操持家务'; break;
      case 'military': s = '在服役'; break;
      case 'retired': s = '已退休'; break;
      case 'unable': s = '因病休养'; break;
      default: s = '在家';
    }
  }
  const rel = p.relationship.status;
  const relTxt = age >= 18 ? { married: '已婚', partnered: '同居', divorced: '离异', widowed: '丧偶' }[rel] : '';
  const kids = p.children.filter((k) => k.alive !== false).length;
  const birthIso = state.birth && state.birth.country;
  const place = p.country !== birthIso ? `在${cname(data, p.country)}` : '';
  return [place ? `${place}${s}` : s, relTxt, kids ? `${zhNum(Math.min(kids, 10))}个孩子` : ''].filter(Boolean).join('·');
}

/* ================================================================== interactivity layer (CONTRACT §10) */

/* ------------------------------------------------------------------ log entries: ids, help line, gentle mode */

const SENS_RE = {
  suicide: /自杀|轻生|寻短见|了结自己|结束(?:自己的)?生命|不想活/,
  child: /夭折/,
  violence: /家暴|虐待|殴打|暴力事件|遇害|枪击|枪战|抢劫|性侵|袭击/,
};
/** 'suicide' | 'child' | 'violence' for a personal entry whose subject is one of them, else null (news are left as they are). */
function sensOf(e) {
  if (!isObj(e) || e.kind === 'news' || typeof e.text !== 'string') return null;
  if (e.sens === 'suicide' || e.sens === 'child' || e.sens === 'violence') return e.sens;
  for (const k of ['suicide', 'child', 'violence']) if (SENS_RE[k].test(e.text)) return k;
  return null;
}
const SOFT_WORDS = [
  [/遭遇暴力事件/g, '遭遇了不幸'], [/在战乱中遇难/g, '在战乱中离世'], [/遇难|遇害/g, '离世'], [/家暴/g, '家里的伤害'],
  [/虐待|殴打|性侵/g, '伤害'], [/枪击|枪战|袭击|抢劫/g, '意外'], [/夭折/g, '早早地离开'], [/「[^」]*」这样的话/g, '很重的话'],
  [/自杀|轻生|寻短见|了结自己|结束(?:自己的)?生命/g, '放弃'], [/不想活/g, '撑不下去'],
];
function softWords(text) {
  let t = String(text || '');
  for (const [re, s] of SOFT_WORDS) t = t.replace(re, s);
  return t;
}

/** Switch one entry between its full and its gentle wording (keeps the original in e.orig). */
function applyGentle(e, on) {
  if (!isObj(e) || !e.sens) return false;
  if (on) {
    if (e.orig != null) return false;
    const soft = e.gentleText || softWords(e.text);
    if (!soft || soft === e.text) return false;
    e.orig = e.text;
    e.text = soft;
    return true;
  }
  if (e.orig == null) return false;
  e.text = e.orig;
  delete e.orig;
  return true;
}

/**
 * Final touches before an entry joins the log: a unique id, one line pointing to help on suicide-related text
 * (generic, no phone numbers), and the gentle wording when settings.gentle is on.
 */
function finishEntry(state, e) {
  if (!isObj(e)) return e;
  if (typeof e.id !== 'string' || !e.id) stampId(state, e);
  const sens = sensOf(e);
  if (sens) {
    e.sens = sens;
    if (sens === 'suicide') {
      if (e.kind === 'decision' && !e.gentleText) e.gentleText = '你把压在心里很久的话说了出来。';
      if (e.kind !== 'decision' && !/心理援助/.test(e.text)) e.text = `${e.text}${HELP_LINE}`;
      if (e.gentleText && e.kind !== 'decision' && !/心理援助/.test(e.gentleText)) e.gentleText = `${e.gentleText}${HELP_LINE}`;
    }
    if (state.settings && state.settings.gentle) applyGentle(e, true);
  }
  return e;
}

/**
 * Turn gentle mode (略过可怕的情节) on or off for a life: settings.gentle, and the wording of every entry already in
 * the log. Statistics are untouched. Returns the number of entries rewritten.
 */
export function setGentle(state, on) {
  if (!state || typeof state !== 'object') return 0;
  ensureState(state);
  state.settings.gentle = !!on;
  let n = 0;
  for (const e of state.log) {
    const s = sensOf(e);
    if (!s) continue;
    e.sens = s;
    if (applyGentle(e, !!on)) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ shared helpers */

function factsOf(data, world, state, ctx) {
  if (typeof EVM.lifeFacts !== 'function') return null;
  return safe(() => EVM.lifeFacts(data, world, state, ctx || countryContext(data, world, state.person.country, state.year)));
}
function fillWith(state, ctx, f, text) {
  if (typeof EVM.fillText !== 'function') return String(text || '').replace(/\{\w+\}/g, '');
  return safe(() => EVM.fillText(text, state, ctx, null, undefined, f), String(text || '').replace(/\{\w+\}/g, ''));
}
function monthRefOf(f, data, world, state) {
  if (f && isNum(f.monthRef)) return f.monthRef;
  const inc = num(state.person.money.income, 0);
  return Math.max(25, (inc > 0 ? inc : econ.medianIncome(data, world, state.person.country, state.year)) / 12);
}
const pronoun = (sex) => (sex === 'female' ? '她' : '他');

/** Keep the stats tidy after an in-year change and let the year's history row follow it. */
function syncRow(data, world, state) {
  for (const k of STATS) state.stats[k] = r1(clampN(num(state.stats[k], 50), 0, 100));
  state.stats.wealth = safe(() => econ.wealthStat(data, world, state), state.stats.wealth);
  const row = state.history.length ? state.history[state.history.length - 1] : null;
  if (row && row.year === state.year && !state.dead && isObj(row.stats)) for (const k of STATS) row.stats[k] = Math.round(state.stats[k]);
}

/** At the start of a year: what the last year left open settles itself (CONTRACT §10). Returns the entries added. */
function settleOpen(data, world, state) {
  let out = [];
  if (state.smallPending) out = safe(() => resolveSmall(data, world, state, null), []) || [];
  state.smallPending = null;
  // the engine already gave the newborn the first suggested name
  state.namingPending = null;
  state.reflectPending = null;
  return out;
}

/* ------------------------------------------------------------------ the year's focus */

function chooseFocus(S) {
  const { state } = S;
  S.focus = null;
  S.focusAuto = true;
  S.fspec = null;
  S.fmods = {};
  if (state.age < FOCUS_MIN_AGE) return;
  const x = focusSituation(state, 0);
  const fo = state.focus;
  let id = null;
  if (fo.current) {
    if (focusFits(fo.current, x)) {
      id = fo.current;
      S.focusAuto = false;
    } else {
      const was = FOCUS_NAMES[fo.current] || '原来的重心';
      S.add('system', `「${was}」已经不太适合现在的你了，这一年的重心交给了自动安排。`, 0, ['focus'], { headline: '重心改为自动' });
      fo.current = null;
      fo.auto = true;
    }
  }
  if (!id) {
    id = autoFocus(state, x, textureOf(state), fo.lastAuto);
    if (id) fo.lastAuto = id;
  }
  S.focus = id;
  S.fspec = id ? focusSpec(id, x) : null;
  S.fmods = S.fspec ? S.fspec.mods || {} : {};
}

const HOBBIES = {
  child: ['画画', '下棋', '踢毽子', '拼积木', '养蚕', '跳绳'],
  teen: ['弹吉他', '画画', '打篮球', '写小说', '摄影', '编程'],
  adult: ['钓鱼', '摄影', '跑步', '烘焙', '书法', '养花', '徒步'],
  old: ['书法', '养花', '下棋', '太极', '合唱', '钓鱼'],
};

/** The focus's yearly stat effects, and now and then a line telling what several years of it have done. */
function focusStep(S) {
  const sp = S.fspec;
  if (!sp) return;
  const { state, p } = S;
  for (const [k, v] of Object.entries(sp.stats || {})) if (STAT_EFFECT_KEYS.includes(k) && isNum(v) && v) addStats(state, k, v);
  if (sp.mods && isNum(sp.mods.pocket) && S.age >= 16) {
    moveCash(state, Math.round((sp.mods.pocket * econ.medianIncome(S.data, S.world, p.country, S.year)) / 12));
  }
  let n = 1;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const r = state.history[i];
    if (r && r.focus === S.focus) n++;
    else break;
  }
  if (n !== 3 && !(n > 3 && (n - 3) % 7 === 0)) return;
  if (S.entries.filter((e) => e.kind !== 'news' && e.kind !== 'system').length >= 3) return;
  const R = S.rng.fork(`streak:${S.year}`);
  let line = streakLine(S.focus, stageOf(S.age), R);
  if (S.focus === 'hobby') {
    if (typeof p.flags.hobby !== 'string' || !p.flags.hobby) {
      const st = stageOf(S.age);
      p.flags.hobby = R.pick(HOBBIES[st === 'young' ? 'adult' : st] || HOBBIES.adult);
    }
    line = `这几年你一直坚持着${p.flags.hobby}的爱好。它不能当饭吃，却让日子有了光。`;
  }
  if (line) S.add('event', line, 1, ['focus'], { headline: FOCUS_NAMES[S.focus] || '这几年' });
}

/** Options for the year about to be lived (CONTRACT §10 focusOptions); [] before age 6. */
export function focusOptions(data, world, state) {
  if (!state || !state.person) return [];
  ensureState(state);
  if (state.dead) return [];
  const x = focusSituation(state, 1);
  if (x.age < FOCUS_MIN_AGE) return [];
  const cur = state.focus.current;
  return focusList(x).map((s) => {
    const o = { id: s.id, label: s.label, hint: s.available ? s.hint : s.why, available: s.available, selected: cur === s.id };
    if (!s.available) o.why = s.why;
    return o;
  });
}

/** Choose the focus for this and the following years; null lets the engine decide each year. Returns true when set. */
export function setFocus(state, focusId) {
  if (!state || typeof state !== 'object') return false;
  ensureState(state);
  if (focusId == null || focusId === 'auto') {
    state.focus.current = null;
    state.focus.auto = true;
    return true;
  }
  if (!FOCUS_IDS.includes(focusId)) return false;
  if (!focusFits(focusId, focusSituation(state, 1))) return false;
  state.focus.current = focusId;
  state.focus.auto = false;
  return true;
}

/** Set a spending habit (0 none, 1 some, 2 a lot; clamped). null / 'auto' hands it back to the auto texture. */
export function setHabit(state, key, level) {
  if (!state || typeof state !== 'object' || !econ.HABIT_KEYS.includes(key)) return null;
  ensureState(state);
  if (level == null || level === 'auto') {
    delete state.habitLock[key];
    return state.habits[key];
  }
  const lv = clampN(Math.round(num(+level, 0)), 0, 2);
  state.habits[key] = lv;
  state.habitLock[key] = true;
  return lv;
}

/** Steer new savings: {bank, balanced, stocks, crypto} weights (normalised) or null for automatic. */
export function setAllocation(state, alloc) {
  if (!state || typeof state !== 'object') return null;
  ensureState(state);
  state.person.money.allocation = econ.normAllocation(alloc);
  return state.person.money.allocation;
}

/* ------------------------------------------------------------------ siblings */

const sibCache = new Map();

/**
 * The person's brothers and sisters (BirthSpec.siblings), deterministic for a life: names that follow the family's
 * naming, birth years around the person's, and a life length drawn from the birth country's life tables.
 */
export function siblingsOf(data, state) {
  const b = state.birth || {};
  const p = state.person;
  const n = clampN(Math.round(num(p.siblings, num(b.siblings, 0))), 0, 12);
  if (!n) return [];
  const key = `${state.id}|${n}|${b.year}|${b.country}|${b.surname || ''}`;
  const hit = sibCache.get(key);
  if (hit) return hit;
  const R = new Rng(hashString(`${state.id}|siblings`));
  const by = num(b.year, state.year - state.age);
  const origin = b.country || p.country;
  const momAge = num(b.motherAge, 28);
  const nOld = clampN(Math.round(clampN((momAge - 17) / 2.5, 0, n) * R.float(0.6, 1)), 0, n);
  const list = [];
  const taken = [p.name];
  let yOld = by;
  let yYoung = by;
  for (let i = 0; i < n; i++) {
    const older = i < nOld;
    const gap = R.int(1, 4);
    const year = older ? (yOld -= gap) : (yYoung += gap);
    const sex = R.chance(0.512) ? 'male' : 'female';
    let nm = null;
    for (let t = 0; t < 6; t++) {
      const c = safe(() => childName(data, origin, sex, year, R, b.surname || ''), null);
      if (c && c.name && !nameClash(c.name, taken)) {
        nm = c.name;
        break;
      }
    }
    const role = older ? (sex === 'male' ? '哥哥' : '姐姐') : sex === 'male' ? '弟弟' : '妹妹';
    if (!nm) nm = role;
    taken.push(nm);
    list.push({ i, name: nm, sex, birthYear: year, older, role, deathYear: null });
  }
  for (const s of list) {
    const D = new Rng(hashString(`${state.id}|sib|${s.i}|${s.birthYear}`));
    for (let y = Math.max(by + 1, s.birthYear + 1); y <= s.birthYear + 112; y++) {
      const q = 1 - Math.exp(-num(safe(() => data.mx(origin, Math.min(y, 2100), s.sex, y - s.birthYear)), 0.01));
      if (D.chance(q)) {
        s.deathYear = y;
        break;
      }
    }
    if (s.deathYear == null) s.deathYear = s.birthYear + 112;
  }
  if (sibCache.size > 400) sibCache.clear();
  sibCache.set(key, list);
  return list;
}

/** A younger sibling is only born while the mother lives. */
function sibBorn(state, s, year) {
  if (s.birthYear > year) return false;
  const mo = state.person.parents && state.person.parents.mother;
  if (!s.older && mo && mo.alive === false && isNum(mo.deathYear) && mo.deathYear < s.birthYear) return false;
  return true;
}

function siblingsStep(S) {
  const { state, data } = S;
  for (const s of siblingsOf(data, state)) {
    if (s.deathYear !== S.year || !sibBorn(state, s, S.year) || s.birthYear >= S.year) continue;
    const a = S.year - s.birthYear;
    const pr = pronoun(s.sex);
    const text = a < 18 ? `你的${s.role}${s.name}因病离开了，那一年${pr}才 ${a} 岁。家里很长一段时间都很安静。`
      : `你的${s.role}${s.name}去世了，享年 ${a} 岁。${S.age >= 60 ? '你们一起长大的那些日子，如今只剩你一个人记得了。' : '你赶去送了最后一程，一路上想起很多小时候的事。'}`;
    const e = S.add('milestone', text, -2, ['loss', 'family'], { tag: 'loss', headline: `${s.role}去世` });
    if (e && a < 18) {
      e.sens = 'child';
      e.gentleText = `你的${s.role}${s.name}早早地离开了。家里人把${pr}的照片一直摆在桌上。`;
    }
    addStats(state, 'happiness', a < 18 || S.age < 18 ? -8 : -6);
    addStats(state, 'relationships', -2);
  }
}

/* ------------------------------------------------------------------ pets */

const PET_LIFE = { 狗: [10, 15], 猫: [12, 18], 鱼: [3, 6], 鸟: [6, 14], 兔子: [7, 11] };

function addPet(state, kind, name, year) {
  const p = state.person;
  const k = PET_LIFE[kind] ? kind : '狗';
  const nm = String(name || '').trim().slice(0, 12) || petName(p.country, new Rng(hashString(`${state.id}|petname|${year}`)));
  const R = new Rng(hashString(`${state.id}|pet|${year}|${nm}`));
  p.pets.push({ name: nm, kind: k, since: year, life: R.int(PET_LIFE[k][0], PET_LIFE[k][1]), alive: true });
  if (p.pets.length > 8) p.pets.splice(0, p.pets.length - 8);
  p.flags.pet = year;
}

function adoptPetFromText(state, text, year) {
  const t = String(text || '');
  const kind = /猫/.test(t) ? '猫' : /鱼/.test(t) ? '鱼' : /鸟|鹦鹉/.test(t) ? '鸟' : /兔/.test(t) ? '兔子' : '狗';
  addPet(state, kind, petName(state.person.country, new Rng(hashString(`${state.id}|petname|${year}`))), year);
}

/** A pet that an event or a decision brought this year (flags.pet = year) without a record gets one. */
function adoptPetFromFlag(state, text) {
  const p = state.person;
  if (num(p.flags.pet, -1) === state.year && !p.pets.some((x) => x.since === state.year)) adoptPetFromText(state, text, state.year);
}

/** Pets grow old; at the end of a pet's years it is told gently (at most one a year). */
function petsStep(S) {
  const { state, p } = S;
  for (const pet of p.pets) {
    if (!pet.alive) continue;
    const age = S.year - num(pet.since, S.year);
    if (age < num(pet.life, 12)) continue;
    pet.alive = false;
    pet.deathYear = S.year;
    // the events library's own farewell to a childhood pet would tell it twice
    p.flags['ev:ch_pet_gone'] = S.year;
    const who = pet.kind === '鸟' ? '小鸟' : pet.kind === '兔子' ? '小兔子' : pet.kind === '猫' ? '猫' : '狗';
    const text = pet.kind === '鱼' ? `那缸陪了你 ${age} 年的鱼，一条条老去了。你把鱼缸擦得干干净净，收进了柜子里。`
      : `陪了你 ${age} 年的${who}${pet.name}老了，在一个安静的早晨离开了。你把它葬在了${p.urban ? '它最爱去的那片草地边' : '屋后的树下'}。`;
    S.add('event', text, -1, ['pet', 'loss'], { headline: `${pet.name}走了` });
    addStats(state, 'happiness', -3);
    break;
  }
}

/** After the events: name a pet an event brought, and mark the pet whose farewell an event told. */
function syncPets(S) {
  const { p } = S;
  if (num(p.flags.pet, -1) === S.year && !p.pets.some((x) => x.since === S.year)) {
    adoptPetFromText(S.state, S.entries.filter((e) => e.kind === 'event').map((e) => e.text).join(' '), S.year);
  }
  if (num(p.flags['ev:ch_pet_gone'], -1) === S.year && !p.pets.some((x) => x.deathYear === S.year)) {
    const pet = p.pets.find((x) => x.alive && x.since < S.year);
    if (pet) {
      pet.alive = false;
      pet.deathYear = S.year;
    }
  }
}

/* ------------------------------------------------------------------ rare moments */

function rareStep(S) {
  const { state, data, world } = S;
  if (S.age < 6 || state.dead) return;
  const f = factsOf(data, world, state, S.ctx);
  if (!f) return;
  const r = rollRare(state, f, S.fmods, S.rng.fork(`rare:${S.year}`), (t) => fillWith(state, S.ctx, f, t));
  if (!r) return;
  state.rare.push({ id: r.id, year: S.year, age: S.age, title: r.title });
  const eff = applyEffects(data, world, state, r.effects);
  if (r.cash > 0 && S.age >= 16) moveCash(state, r.cash);
  if (r.flags) applySet(data, world, state, { flags: r.flags }, S.rng.fork('rareflags'));
  S.add('milestone', r.text, 2, ['rare', 'success'], { tag: 'success', headline: r.title, title: r.title, effects: eff });
}

/* ------------------------------------------------------------------ small choices */

/** About one small choice every 1–2 years from age 6, never beside a pending decision or an unnamed newborn. */
function offerSmall(S) {
  const { state } = S;
  if (state.pending || state.smallPending || state.namingPending || S.age < 6) return;
  const gap = state.year - num(state.smallLast, -99);
  const p = gap >= 3 ? 0.95 : gap === 2 ? 0.8 : gap === 1 ? 0.4 : 0;
  const R = S.rng.fork(`small:${state.year}`);
  if (!R.chance(p)) return;
  const f = factsOf(S.data, S.world, state, S.ctx);
  if (!f) return;
  const ch = pickSmallChoice(f, state.smallSeen, R);
  if (!ch) return;
  state.smallPending = ch;
  state.smallLast = state.year;
}

function smallAct(data, world, state, act, f) {
  const p = state.person;
  const fl = p.flags;
  const m = p.money;
  switch (act) {
    case 'prepay': {
      const amt = Math.max(0, Math.min(num(m.cash, 0) - 3 * monthRefOf(f, data, world, state), num(m.debt, 0) * 0.3));
      if (amt > 0) {
        m.cash = Math.round(num(m.cash, 0) - amt);
        m.debt = Math.max(0, Math.round(num(m.debt, 0) - amt));
      }
      return;
    }
    case 'quitSmoke':
      if (fl.smoker === true) {
        fl.smoker = false;
        fl.exSmoker = true;
      }
      return;
    case 'startSmoke':
      if (fl.smoker !== true) {
        fl.smoker = true;
        fl.smokeSince = state.year;
      }
      return;
    case 'refuseSmoke':
      fl.refusedSmoke = state.year;
      return;
    default:
  }
}

/**
 * Answer the pending small choice (CONTRACT §10). optionId null = the engine's automatic answer (texture-biased),
 * used when the choice expires. Returns the LogEntries added (also pushed to state.log).
 */
export function resolveSmall(data, world, state, optionId) {
  if (!state || typeof state !== 'object') return [];
  ensureState(state);
  const ch = state.smallPending;
  if (!isObj(ch)) return [];
  const opts = Array.isArray(ch.options) ? ch.options.filter(isObj) : [];
  const auto = optionId == null;
  let oid = auto ? null : String(optionId);
  if (!auto && !opts.some((o) => o.id === oid)) return [];
  if (auto) oid = autoSmallOption(ch, textureOf(state), state.id);
  const opt = smallOption(ch, oid);
  state.smallPending = null;
  if (typeof ch.tpl === 'string') state.smallSeen[ch.tpl] = num(ch.year, state.year);
  if (!opt) return [];
  const p = state.person;
  const ctx = countryContext(data, world, p.country, state.year);
  const f = factsOf(data, world, state, ctx);
  const R = new Rng(hashString(`${state.id}|small|${ch.id}|${oid}`));
  const fx = Array.isArray(opt.fx) ? opt.fx : [];
  const eff = { health: num(fx[0]), happiness: num(fx[1]), knowledge: num(fx[2]), relationships: num(fx[3]) };
  const months = num(fx[4]);
  if (months && state.age >= 16) eff.wealthDelta = Math.round(months * monthRefOf(f, data, world, state));
  const applied = applyEffects(data, world, state, eff);
  if (isObj(opt.flags)) applySet(data, world, state, { flags: { ...opt.flags } }, R);
  // the player's own answers become their habits and savings plan; an automatic answer only colours the year
  if (!auto && isObj(opt.habit)) for (const [k, v] of Object.entries(opt.habit)) setHabit(state, k, v);
  if (!auto && isObj(opt.alloc)) setAllocation(state, opt.alloc);
  if (opt.pet) addPet(state, opt.pet, ch.vars && ch.vars.petname, state.year);
  smallAct(data, world, state, opt.act, f);
  const label = (opts.find((o) => o.id === oid) || {}).label || '';
  let text = f ? safe(() => smallResult(ch, opt, f, R), '') : '';
  if (!text) text = `「${String(ch.title || '一个小选择')}」——你选了「${label}」。`;
  const e = {
    year: state.year, age: state.age, kind: 'choice', text, tone: toneOf(applied),
    tags: ['small', ch.kind === 'family' ? 'family-choice' : 'small-choice'].concat(auto ? ['auto'] : []),
    source: 'engine', effects: applied, headline: String(ch.title || '小选择').slice(0, 14), title: String(ch.title || ''), choice: label, smallId: ch.id,
  };
  syncRow(data, world, state);
  state.log.push(finishEntry(state, e));
  return [e];
}

/* ------------------------------------------------------------------ naming, notes, stars */

const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

/**
 * Name the player's child (CONTRACT §10). A bare given name gets the family name the way the family's names are
 * written. Allowed while naming is pending for that child (or in the year after the birth). Returns LogEntry[].
 */
export function nameChild(state, childIndex, name) {
  if (!state || typeof state !== 'object') return [];
  ensureState(state);
  const p = state.person;
  const idx = Math.round(num(+childIndex, -1));
  const k = p.children[idx];
  if (!k || k.alive === false) return [];
  const np = state.namingPending;
  const pending = isObj(np) && np.childIndex === idx;
  if (!pending && num(k.birthYear, -99) < state.year - 1) return [];
  let nm = cleanName(name);
  if (!nm) return [];
  const old = k.name;
  const fmt = pending ? np.format : nameFormat(old, '');
  const sur = pending ? String(np.surname || '') : old.includes('·') ? old.slice(old.lastIndexOf('·') + 1) : '';
  if (sur && fmt === 'gs' && !nm.includes('·') && !/\s/.test(nm)) nm = `${nm}·${sur}`;
  else if (sur && fmt === 'sg' && !nm.startsWith(sur) && nm.length <= 2) nm = sur + nm;
  nm = nm.slice(0, 24);
  if (nm === old) {
    if (pending) state.namingPending = null;
    return [];
  }
  if (p.children.some((c, i) => i !== idx && c && c.name === nm) || nm === p.name) return [];
  k.name = nm;
  // the birth story already told the old name
  for (const e of state.log) {
    if (!isObj(e) || !(e.childIdx === idx || (e.year === k.birthYear && e.kind === 'milestone'))) continue;
    for (const f of ['text', 'gentleText', 'orig']) if (typeof e[f] === 'string') e[f] = e[f].split(old).join(nm);
  }
  if (pending) state.namingPending = null;
  const word = k.sex === 'female' ? '女儿' : '儿子';
  const e = finishEntry(state, {
    year: state.year, age: state.age, kind: 'choice', text: `你给${word}取名「${nm}」。这个名字，你在心里念了很多遍。`, tone: 1,
    tags: ['family', 'naming'], source: 'engine', headline: '取名字', childIdx: idx,
  });
  state.log.push(e);
  return [e];
}

/**
 * Keep a note (CONTRACT §10): kind 'reflection' (answers reflectPending), 'thought' or 'final' (one last sentence;
 * a new one replaces the old). Text is trimmed to 200 characters and never interpreted. Returns LogEntry[] (a
 * 'system' entry, which the AI prompts skip).
 */
export function addNote(state, text, kind, prompt) {
  if (!state || typeof state !== 'object') return [];
  ensureState(state);
  const t = String(text == null ? '' : text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, NOTE_MAX);
  if (!t) return [];
  const k = ['reflection', 'thought', 'final'].includes(kind) ? kind : 'thought';
  let pr = typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 120) : null;
  if (!pr && k === 'reflection' && isObj(state.reflectPending)) pr = String(state.reflectPending.prompt || '') || null;
  if (k === 'final') state.notes = state.notes.filter((n) => n.kind !== 'final');
  state.notes.push({ year: state.year, age: state.age, kind: k, prompt: pr, text: t });
  if (state.notes.length > 80) {
    const i = state.notes.findIndex((n) => n.kind === 'thought');
    state.notes.splice(i >= 0 ? i : 0, 1);
  }
  if (k === 'reflection') state.reflectPending = null;
  const who = state.person.name || '你';
  const line = k === 'final' ? `留给${who}的最后一句话：「${t}」` : k === 'reflection' ? `${state.age} 岁的你写下：「${t}」` : `你写下：「${t}」`;
  const e = finishEntry(state, { year: state.year, age: state.age, kind: 'system', text: line, tone: 0, tags: ['note', k], source: 'engine', headline: k === 'final' ? '最后一句话' : '写下的话' });
  state.log.push(e);
  return [e];
}

/** Star or unstar a log entry as 值得记住的时刻 (at most 12). */
export function toggleStar(state, entryId) {
  if (!state || typeof state !== 'object') return { starred: false };
  ensureState(state);
  const id = typeof entryId === 'string' ? entryId : entryId != null ? String(entryId) : '';
  const i = state.stars.indexOf(id);
  if (i >= 0) {
    state.stars.splice(i, 1);
    return { starred: false };
  }
  if (!id || !state.log.some((e) => isObj(e) && e.id === id)) return { starred: false, missing: true };
  if (state.stars.length >= MAX_STARS) return { starred: false, full: true };
  state.stars.push(id);
  return { starred: true };
}

/* ------------------------------------------------------------------ reflections */

/** A gentle question that fits the life so far, for the pauses at 5, 15, 30, 50 and 70. */
export function reflectionPrompt(data, state) {
  const p = state.person;
  const age = state.age;
  const f = p.flags || {};
  const par = p.parents || {};
  const parentGone = ['mother', 'father'].some((r) => par[r] && par[r].alive === false);
  const kids = p.children.filter((k) => k && k.alive !== false);
  const rel = p.relationship.status;
  const partner = p.relationship.partner && p.relationship.partner.name;
  const war = safe(() => countryContext(data, null, p.country, state.year).conflict, 0) >= 2;
  const migrant = !!f.migrant && f.migrant !== 'false';
  const country = cname(data, p.country);
  if (age <= 5) {
    if (parentGone) return '五岁的你，已经经历过一次离别。你想对一直陪着你的人说些什么？';
    if (war) return '外面不太平的日子里，有什么东西总能让你觉得安心？';
    return '五岁了。你最喜欢的东西是什么？长大以后，你想成为什么样的人？';
  }
  if (age <= 15) {
    if (!p.education.inSchool) return '十五岁，你已经开始帮家里分担了。你心里还藏着什么样的梦想？';
    if (war) return '十五岁。在这样不安稳的年月里，你最想守护的是什么？';
    return '十五岁。有什么事情是你现在很在意、但大人们不太懂的？如果能给五年后的自己捎一句话，你想说什么？';
  }
  if (age <= 30) {
    if (migrant) return `三十岁，你在${country}生活。离开家乡的这些年，你最想念的是什么？`;
    if (kids.length) return `三十岁，你已经是${kids[kids.length - 1].name}的${p.sex === 'female' ? '妈妈' : '爸爸'}了。这些年，你最想守护的是什么？`;
    if (p.career.status === 'unemployed') return '三十岁，日子有些难。你想对此刻的自己说点什么？';
    if (rel === 'single') return '三十岁。一个人走过的这些年里，最让你骄傲的是什么？';
    return '三十而立。回头看二十岁的自己，你想对那时的自己说些什么？';
  }
  if (age <= 50) {
    if (parentGone && !['mother', 'father'].some((r) => par[r] && par[r].alive !== false)) return '五十岁了。如果还能和父母再说一次话，你想说什么？';
    if (p.conditions.length) return '五十岁，身体开始提醒你慢下来。现在，什么对你最重要？';
    if (kids.some((k) => state.year - num(k.birthYear, state.year) >= 18)) return '五十岁，孩子们都长大了。你希望他们记住你的哪一点？';
    return '五十岁。有没有一个人，你一直想对他或她说一声谢谢？';
  }
  if (rel === 'widowed') return `七十岁。身边少了一个人的日子里，你最常想起的是哪一天？`;
  if (f.grandparent || kids.some((k) => state.year - num(k.birthYear, state.year) >= 30)) return '七十岁。你想给孙辈们留下一句什么话？';
  if (partner && rel === 'married') return `七十岁。和${partner}一起走过的这些年里，哪一刻你最想再过一遍？`;
  return '七十岁。回头看，哪一年你最想再过一遍？为什么？';
}

function offerReflection(S) {
  const { state } = S;
  if (!REFLECT_AGES.includes(state.age) || state.settings.reflections === false || state.settings.headless) return;
  state.reflectPending = { age: state.age, prompt: reflectionPrompt(S.data, state) };
}

/** The question for the last sentence to the person, on the death screen. */
export function finalNotePrompt(state) {
  const name = (state && state.person && state.person.name) || 'TA';
  return `这一生就要合上了。最后，你想对${name}说一句什么？`;
}

/* ------------------------------------------------------------------ family view */

const WEST_SURNAME = new Set(['WEU', 'NAM', 'OCE']);

/** Deterministic names for the person's parents, following the family's naming. */
function parentNames(data, state) {
  const b = state.birth || {};
  const p = state.person;
  const iso = b.country || p.country;
  const sur = b.surname || safe(() => guessSurname(data, iso, p.name), '') || '';
  const R = new Rng(hashString(`${state.id}|parents`));
  const by = num(b.year, state.year - state.age);
  const fa = safe(() => makeName(data, iso, 'male', by - num(b.fatherAge, 30), R), null) || { name: '父亲', given: '父亲' };
  const mo = safe(() => makeName(data, iso, 'female', by - num(b.motherAge, 28), R), null) || { name: '母亲', given: '母亲' };
  const fmt = nameFormat(p.name, sur);
  const region = safe(() => data.country(iso).region, '');
  let father = fa.name;
  let mother = mo.name;
  if (sur && fmt === 'sg') father = sur + fa.given;
  else if (sur && fmt === 'gs') {
    father = `${fa.given}·${sur}`;
    if (WEST_SURNAME.has(region)) mother = `${mo.given}·${sur}`;
  }
  if (father === p.name) father = fa.name;
  return { father, mother };
}

/** Peers simulated for the player's grown children, keyed by life, world, child and seed. */
const kidCache = new Map();

function careYearsFor(state, k) {
  const by = num(k.birthYear, state.year);
  return state.history.filter((r) => r && r.focus === 'kids' && r.year >= by && r.year - by < 18).length;
}

function childSpec(data, state, k) {
  const p = state.person;
  const by = num(k.birthYear, state.year);
  const row = state.history.find((r) => r && r.year === by) || state.history[state.history.length - 1] || {};
  const iso = (typeof row.country === 'string' && safe(() => data.country(row.country)) && row.country) || p.country;
  const wealth = num(row.stats && row.stats.wealth, 50);
  const fam = clampN((wealth - 8) / 84 + 0.012 * careYearsFor(state, k), 0.02, 0.98);
  const myAge = by - num(state.birth && state.birth.year, by - 28);
  const partnerBy = p.relationship.partner && isNum(p.relationship.partner.birthYear) ? p.relationship.partner.birthYear : null;
  const otherAge = partnerBy != null ? by - partnerBy : myAge + (p.sex === 'female' ? 3 : -3);
  const motherAge = clampN(Math.round(p.sex === 'female' ? myAge : otherAge), 15, 50);
  const fatherAge = clampN(Math.round(p.sex === 'male' ? myAge : otherAge), 16, 80);
  const simYear = clampN(by, 2000, 2070);
  const R = new Rng(hashString(`${state.id}|kid|${k.name}|${by}`));
  const lvl = p.education.level;
  const parentsEdu = lvl === 'tertiary' || lvl === 'postgrad' ? 'tertiary' : lvl === 'secondary' || lvl === 'vocational' ? 'secondary' : lvl === 'primary' ? 'primary' : 'none';
  return {
    mode: 'custom', year: simYear, date: `${simYear}-${String(R.int(1, 12)).padStart(2, '0')}-${String(R.int(1, 28)).padStart(2, '0')}`,
    time: `${String(R.int(0, 23)).padStart(2, '0')}:${String(R.int(0, 59)).padStart(2, '0')}:00`, country: iso,
    sex: k.sex === 'female' ? 'female' : 'male', urban: !!p.urban, familyPct: Math.round(fam * 1000) / 1000, parentsEdu,
    siblings: clampN(p.children.length - 1, 0, 20), motherAge, fatherAge, name: String(k.name || '孩子').slice(0, 24), notes: [],
    offset: by - simYear,
  };
}

/** Simulate one grown child's life headless and keep a compact record of it. */
function runChild(data, world, spec, seed) {
  const timeline = [];
  const titles = [];
  let last = '';
  let everUnion = false;
  const { offset, ...birth } = spec;
  const st = simulateLife(data, world, birth, seed, {
    onYear(s) {
      const c = s.person.career;
      if (c && c.title && ['employed', 'self_employed'].includes(c.status)) titles.push(c.title);
      if (['married', 'partnered', 'widowed', 'divorced'].includes(s.person.relationship.status)) everUnion = true;
      if (s.dead) return;
      const line = safe(() => statusLine(data, s), '');
      if (line && line !== last) {
        timeline.push({ year: s.year + offset, status: line });
        last = line;
      }
    },
  });
  const d = st.dead;
  const kids = st.person.children.filter((x) => x && x.alive !== false).length;
  return {
    timeline: timeline.slice(-60),
    deathYear: d ? d.year + offset : null,
    deathAge: d ? d.age : null,
    cause: d ? { id: d.cause.id, name: d.cause.name } : null,
    edu: st.person.education.level,
    titles: titles.filter((x, i) => titles.indexOf(x) === i).slice(0, 2),
    homemaker: st.person.career.status === 'homemaker' || st.person.flags.retiredFrom === 'homemaker',
    everUnion,
    kids,
    everKids: st.person.children.length,
    country: st.person.country,
    born: st.birth.country,
  };
}

/** The simulated life of a grown child that agrees with the player's life: alive at least until aliveUntil. */
function childPeer(data, world, state, k, aliveUntil) {
  const spec = childSpec(data, state, k);
  let peer = null;
  for (let t = 0; t < 6; t++) {
    const key = `${state.id}|${world && world.seed}|${k.name}|${k.birthYear}|${spec.familyPct}|${spec.country}|${t}`;
    peer = kidCache.get(key);
    if (!peer) {
      peer = safe(() => runChild(data, world, spec, hashString(`${state.id}|child|${k.name}|${k.birthYear}|${t}`)), null);
      if (!peer) return null;
      if (kidCache.size > 300) kidCache.clear();
      kidCache.set(key, peer);
    }
    if (peer.deathYear == null || peer.deathYear >= aliveUntil) return peer;
  }
  return { ...peer, deathYear: null, deathAge: null, cause: null, forced: true };
}

function peerStatus(peer, year) {
  let s = '';
  for (const t of peer.timeline) if (t.year <= year) s = t.status;
  return s;
}

function kidStatus(age, p) {
  if (age < 1) return '刚出生不久';
  if (age < 3) return '还是个小婴儿';
  if (age < 6) return p.urban ? '上幼儿园' : '在家里跑来跑去';
  if (age < 12) return '读小学';
  return '读中学';
}

function sibStatus(age, key) {
  if (age < 3) return '还是个小婴儿';
  if (age < 6) return '还没上学';
  if (age < 12) return '读小学';
  if (age < 18) return '读中学';
  if (age < 23) return '读书或刚工作';
  if (age < 62) return hashString(key) % 3 ? '成家了，在工作' : '在工作';
  return '已经退休';
}

/**
 * 家人与生活 (CONTRACT §10): family members with ages, closeness and a short note; friends; pets; habits;
 * conditions. Read-only except for filling defaults on an old save.
 */
export function familyView(data, world, state) {
  const out = { members: [], friends: 0, pets: [], habits: [], conditions: [] };
  if (!state || !state.person) return out;
  ensureState(state);
  const p = state.person;
  const year = state.year;
  const relSt = num(state.stats.relationships, 55);
  const recent = state.history.slice(-10);
  const fy = (id) => recent.filter((r) => r && r.focus === id).length;
  const jitter = (key) => (((hashString(`${state.id}|close|${key}`) % 1000) / 1000) - 0.5) * 0.2;
  const level = (s) => (s >= 0.66 ? 'close' : s >= 0.4 ? 'ok' : 'distant');
  const origin = (typeof p.flags.origin === 'string' && p.flags.origin) || (state.birth && state.birth.country) || p.country;
  const away = p.country !== origin;
  const members = out.members;
  // partner
  const r = p.relationship;
  if (r.partner && ['dating', 'married', 'partnered'].includes(r.status)) {
    const psex = r.partner.sex || (p.sex === 'female' ? 'male' : 'female');
    const yrs = year - num(r.partner.sinceYear, year);
    const s = 0.55 + (num(state.stats.happiness, 55) - 55) / 120 + (relSt - 55) / 120 + 0.03 * (fy('love') + fy('family')) - 0.02 * fy('work') + jitter('partner');
    members.push({
      role: r.status === 'married' ? (psex === 'male' ? '丈夫' : '妻子') : r.status === 'partnered' ? '伴侣' : '恋人',
      name: r.partner.name, sex: psex, age: isNum(r.partner.birthYear) ? year - r.partner.birthYear : null, alive: true,
      status: yrs <= 0 ? '今年刚走到一起' : `在一起 ${yrs} 年了`, closeness: level(s),
      note: fy('love') >= 3 ? '这些年你很用心地经营着这段感情' : state.habits.travel >= 1 && p.money.income > 0 ? '你们常常一起出去走走' : '',
    });
  }
  for (const lp of Array.isArray(p.late) ? p.late : []) {
    if (!isObj(lp)) continue;
    members.push({
      role: lp.married ? (lp.sex === 'male' ? '故去的丈夫' : '故去的妻子') : '故去的伴侣', name: String(lp.name || ''), sex: lp.sex === 'female' ? 'female' : 'male',
      age: isNum(lp.birthYear) ? num(lp.year, year) - lp.birthYear : null, alive: false, status: `${lp.year} 年离世`, closeness: 'close',
      note: num(lp.years, 0) >= 2 ? `你们相伴了 ${lp.years} 年` : '',
    });
  }
  // parents
  const names = parentNames(data, state);
  for (const role of ['mother', 'father']) {
    const par = p.parents[role];
    if (!isObj(par)) continue;
    const alive = par.alive !== false;
    const pa = Math.round(num(par.age, state.age + 30));
    const s = 0.55 + (relSt - 55) / 100 + 0.06 * state.habits.parents * (state.age >= 18 ? 1 : 0) + 0.04 * fy('care') + 0.02 * fy('family')
      - (away ? 0.15 : 0) - (p.flags.leftBehind ? 0.05 : 0) - (role === 'father' && p.flags.parentsDivorced ? 0.12 : 0) + jitter(role);
    const word = role === 'mother' ? '她' : '他';
    const note = !alive ? '' : state.age >= 20 && state.habits.parents >= 1 && p.money.income > 0 ? (state.habits.parents >= 2 ? `你每月给${word}寄一笔不小的生活费` : `你每月给${word}寄些生活费`)
      : fy('care') >= 2 ? `这些年你常回去陪着${word}` : away ? '隔着很远，你们常常打电话' : '';
    members.push({
      role: role === 'mother' ? '母亲' : '父亲', name: role === 'mother' ? names.mother : names.father, sex: role === 'mother' ? 'female' : 'male',
      age: pa, alive, status: alive ? (pa < 60 ? '还在工作' : pa < 80 ? '已经退休' : '年事已高') : `${isNum(par.deathYear) ? par.deathYear : '早'}年离世`,
      closeness: alive ? level(s) : 'close', note,
    });
  }
  // brothers and sisters
  for (const sb of siblingsOf(data, state)) {
    if (!sibBorn(state, sb, year)) continue;
    const alive = sb.deathYear > year;
    const a = (alive ? year : sb.deathYear) - sb.birthYear;
    const s = 0.47 + (relSt - 55) / 120 + 1.5 * jitter(`sib${sb.i}`) - (away ? 0.1 : 0) + 0.02 * fy('family');
    members.push({ role: sb.role, name: sb.name, sex: sb.sex, age: a, alive, status: alive ? sibStatus(a, `${state.id}|${sb.i}`) : `${sb.deathYear} 年离世`, closeness: alive ? level(s) : 'ok', note: '' });
  }
  // children
  p.children.forEach((k, i) => {
    if (!isObj(k)) return;
    const alive = k.alive !== false;
    const ka = (alive ? year : num(k.deathYear, year)) - num(k.birthYear, year);
    const care = careYearsFor(state, k);
    let status;
    if (!alive) status = `${num(k.deathYear, year)} 年离世`;
    else if (ka < 18) status = kidStatus(ka, p);
    else {
      const peer = childPeer(data, world, state, k, year);
      status = (peer && peerStatus(peer, year)) || (ka < 23 ? '读书或刚工作' : '在工作');
    }
    const s = 0.55 + (relSt - 55) / 110 + 0.035 * care + 0.015 * fy('family') + 0.03 * fy('kids') - (ka >= 13 && ka <= 17 ? 0.08 : 0)
      - (r.status === 'divorced' ? 0.05 : 0) + jitter(`kid${i}`);
    members.push({
      role: k.sex === 'female' ? '女儿' : '儿子', name: k.name, sex: k.sex === 'female' ? 'female' : 'male', age: Math.max(0, ka), alive, status,
      closeness: alive ? level(s) : 'close', note: k.adopted ? '领养的孩子' : alive && care >= 5 ? `你陪着${pronoun(k.sex)}长大` : '', childIndex: i,
    });
  });
  // friends
  const sociable = p.flags.sociable ? 2 : 0;
  let friends = Math.round(clampN((relSt - 25) / 7, 0, 11) + sociable + 0.5 * fy('friends') + (p.flags.volunteer ? 1 : 0));
  if (state.age < 6) friends = Math.min(friends, 3);
  if (state.age >= 80) friends = Math.max(0, friends - 2);
  out.friends = Math.max(0, friends);
  out.pets = p.pets.filter((x) => x.alive).map((x) => ({ name: x.name, kind: x.kind, age: Math.max(0, year - num(x.since, year)) }));
  const plan = safe(() => econ.habitPlan(data, world, state, {}), null);
  out.habits = (plan ? plan.items : econ.HABIT_KEYS.map((k) => ({ key: k, label: econ.HABIT_LABELS[k], level: state.habits[k], cost: 0, active: false, hint: '' }))).map((it) => ({
    key: it.key, label: it.label, level: it.level, levelLabel: econ.HABIT_LEVEL_LABELS[it.level] || '', auto: state.habitLock[it.key] !== true,
    cost: it.cost, hint: it.hint || '', active: !!it.active,
  }));
  out.conditions = p.conditions.map((c) => ({ id: c.id, name: c.name, sinceYear: c.sinceYear, severity: c.severity, label: ['轻度', '中度', '重度'][clampN(num(c.severity, 1), 1, 3) - 1] }));
  out.self = { name: p.name, age: state.age, status: safe(() => statusLine(data, state), '') };
  return out;
}

/* ------------------------------------------------------------------ money panels */

/** 一年收入的去向（估算）(CONTRACT §10). */
export function incomeBreakdown(data, world, state) {
  if (!state || !state.person) return { income: 0, items: [], deficit: 0 };
  ensureState(state);
  const id = state.focus.current || (state.history.length ? state.history[state.history.length - 1].focus : null);
  const sp = id ? focusSpec(id, focusSituation(state, 0)) : null;
  return safe(() => econ.incomeBreakdownOf(data, world, state, { mods: sp && sp.available ? sp.mods : {} }), { income: 0, items: [], deficit: 0 });
}

/** Where new savings can go (CONTRACT §10 investOptions). */
export function investOptions(data, world, state) {
  if (!state || !state.person) return [];
  ensureState(state);
  return safe(() => econ.investChoices(data, world, state), []) || [];
}

/* ------------------------------------------------------------------ life summary */

const FOCUS_PHRASE = {
  study: '埋头读书的日子', play: '无忧无虑玩耍的童年', hobby: '沉浸在爱好里的时光', friends: '和朋友们在一起的岁月', family: '陪伴家人的时光',
  love: '用心经营感情的日子', work: '埋首工作的岁月', money: '精打细算攒钱的日子', health: '用心照顾身体的年头', rest: '放慢脚步的日子',
  care: '照顾父母的年月', kids: '陪伴孩子的日子', help: '帮助别人的时光',
};

/**
 * A few humane lines about the whole life (CONTRACT §10): the happiest year, the year with the highest income, the
 * years given to each focus, and more. Also returns hardestAge and the year numbers for the UI.
 */
export function lifeSummary(data, world, state) {
  const out = { lines: [], happiestAge: null, richestAge: null, focusYears: {} };
  if (!state || !Array.isArray(state.history)) return out;
  ensureState(state);
  const rows = state.history.filter((r) => isObj(r) && isNum(r.age) && isObj(r.stats));
  for (const r of rows) if (r.focus && FOCUS_IDS.includes(r.focus)) out.focusYears[r.focus] = (out.focusYears[r.focus] || 0) + 1;
  const lived = rows.filter((r) => r.tag !== 'death' || rows.length === 1);
  let happy = null;
  for (const r of lived) if (r.age >= 3 && (!happy || num(r.stats.happiness) > num(happy.stats.happiness))) happy = r;
  let rich = null;
  for (const r of lived) if (num(r.income, 0) > 0 && (!rich || r.income > rich.income)) rich = r;
  let hard = null;
  for (const r of lived) if (r.age >= 6 && (!hard || num(r.stats.happiness) < num(hard.stats.happiness))) hard = r;
  const plain = (h) => !h || /平常的一年|^出生$/.test(h);
  if (happy) {
    out.happiestAge = happy.age;
    out.happiestYear = happy.year;
    out.lines.push(`最快乐的一年是 ${happy.age} 岁（${happy.year} 年）${plain(happy.headline) ? '。那一年没有什么大事，日子却格外顺心。' : `，那一年的大事是：${happy.headline}。`}`);
  }
  if (rich) {
    out.richestAge = rich.age;
    out.richestYear = rich.year;
    out.richestIncome = rich.income;
    const iso = rich.country || state.person.country;
    out.lines.push(`赚钱最多的一年是 ${rich.age} 岁，那一年的收入约为 ${econ.formatMoney(data, iso, rich.income)}（按2021年物价）。`);
  }
  const fys = Object.entries(out.focusYears).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (fys.length) out.lines.push(`${fys.map(([id, n]) => `${FOCUS_PHRASE[id] || FOCUS_NAMES[id]}有 ${n} 年`).join('，')}。`);
  if (hard && num(hard.stats.happiness) < 40 && (!happy || hard.year !== happy.year)) {
    out.hardestAge = hard.age;
    out.hardestYear = hard.year;
    out.lines.push(`最难熬的是 ${hard.age} 岁那年${plain(hard.headline) ? '' : `（${hard.headline}）`}，可你还是一步一步走了过来。`);
  }
  const places = [];
  for (const r of rows) if (typeof r.country === 'string' && !places.includes(r.country)) places.push(r.country);
  if (places.length > 1) out.lines.push(`你在 ${places.length} 个国家生活过：${places.slice(0, 4).map((x) => cname(data, x)).join('、')}。`);
  const p = state.person;
  const kids = p.children.length;
  const unionYrs = (() => {
    const pr = p.relationship.partner;
    if (pr && ['married', 'partnered'].includes(p.relationship.status)) return state.year - num(pr.sinceYear, state.year);
    const lp = Array.isArray(p.late) && p.late.length ? p.late[p.late.length - 1] : null;
    return lp ? num(lp.years, 0) : 0;
  })();
  if (kids || unionYrs >= 2) {
    const a = unionYrs >= 2 ? `和最亲近的那个人相伴了 ${unionYrs} 年` : '';
    const b = kids ? `养育了 ${kids} 个孩子` : '';
    out.lines.push(`你${[a, b].filter(Boolean).join('，')}。`);
  }
  const small = state.log.filter((e) => isObj(e) && Array.isArray(e.tags) && e.tags.includes('small'));
  if (small.length >= 3) {
    const fam = small.filter((e) => e.tags.includes('family-choice')).length;
    out.lines.push(`你做过 ${small.length} 个小小的选择${fam ? `，其中 ${fam} 个是和家人一起决定的` : ''}。`);
  }
  if (state.rare.length) out.lines.push(`你遇到过很少有人遇到的事：${state.rare.map((r) => r.title).join('、')}。`);
  if (state.stars.length || state.notes.length) {
    out.lines.push(`你把 ${state.stars.length} 个时刻标记为值得记住${state.notes.length ? `，写下了 ${state.notes.length} 段话` : ''}。`);
  }
  out.lines = out.lines.slice(0, 8);
  return out;
}

/* ------------------------------------------------------------------ children's lives */

const EDU_DONE = { none: '没能上学', preschool: '没能上学', primary: '读完了小学', secondary: '读完了中学', vocational: '读了职业学校', tertiary: '读完了大学', postgrad: '读到了研究生' };
const MEMORY = [
  (pr) => `${pr}常说，小时候你陪着${pr}的那些年，是${pr}这辈子最踏实的日子。`,
  (pr) => `很多年后，${pr}还记得你陪${pr}写作业、讲睡前故事的那些晚上。`,
  (pr) => `${pr}后来也学着你的样子，把很多时间留给了自己的家人。`,
];

/**
 * 子女们的人生 (CONTRACT §10): one line for each child about what became of them. Grown children are simulated
 * headless (cohort.simulateLife) from their birth year, country and the family's means at their birth, consistent
 * with the player's life (alive at least as long as the player knew them). Deterministic for a life and world.
 */
export function childrenFates(data, world, state) {
  if (!state || !state.person) return [];
  ensureState(state);
  const p = state.person;
  const until = state.dead ? num(state.dead.year, state.year) : state.year;
  const gentle = !!state.settings.gentle;
  let memories = 0;
  return p.children.filter(isObj).map((k, i) => {
    const name = String(k.name || '孩子');
    const sex = k.sex === 'female' ? 'female' : 'male';
    const pr = pronoun(sex);
    const by = num(k.birthYear, state.year);
    const base = { name, sex, birthYear: by };
    if (k.alive === false) {
      const ka = num(k.deathYear, until) - by;
      return { ...base, line: ka < 1 ? `${name}来到这个世界不久就离开了。你一直记得${pr}小小的样子。` : `${name}在 ${ka} 岁时先你一步离开了。你一直记得${pr}的样子。`, alive: false, deathYear: num(k.deathYear, null) };
    }
    const peer = childPeer(data, world, state, k, until);
    if (!peer) return { ...base, line: `${name}后来过着自己的日子。`, alive: true };
    const parts = [];
    const lived = peer.deathAge != null ? peer.deathAge : 80;
    if (lived >= 18) parts.push(EDU_DONE[peer.edu] || '长大成人');
    if (peer.titles.length) parts.push(`做过${peer.titles.join('、')}`);
    else if (peer.homemaker) parts.push('操持着一个家');
    if (peer.country && peer.country !== peer.born) parts.push(`后来去了${cname(data, peer.country)}生活`);
    if (lived >= 30) parts.push(peer.everUnion ? (peer.everKids ? `成了家，有${zhNum(Math.min(peer.everKids, 10))}个孩子` : '成了家') : '一直一个人生活，过得自在');
    let line = `${name}${parts.length ? parts.join('，') : '平平安安地长大了'}`;
    if (peer.deathYear != null) {
      const sensitive = peer.cause && ['suicide', 'violence'].includes(peer.cause.id);
      line += gentle && sensitive ? `；${peer.deathAge} 岁那年（${peer.deathYear} 年），${pr}离开了这个世界。` : `；${peer.deathAge} 岁那年（${peer.deathYear} 年），${pr}因${peer.cause ? peer.cause.name : '病'}离世。`;
    } else line += '。';
    if (careYearsFor(state, k) >= 8 && memories < 2) {
      line += MEMORY[(hashString(`${state.id}|${name}`) + memories) % MEMORY.length](pr);
      memories++;
    }
    return { ...base, line, alive: true, deathYear: peer.deathYear, deathAge: peer.deathAge };
  });
}

/* ------------------------------------------------------------------ comparison with a real birthplace */

/**
 * Compare the circumstances of this birth with being born in settings.compareIso (or iso) in compareYear (default:
 * the same birth year): life expectancy, infant mortality, schooling, income, internet. Rows keep raw numbers.
 */
export function compareBirthplace(data, world, state, iso, year) {
  if (!state || !state.person) return null;
  const s = state.settings || {};
  const other = typeof iso === 'string' ? iso : s.compareIso;
  if (!other || !safe(() => data.country(other))) return null;
  const b = state.birth || {};
  const mine = b.country || state.person.country;
  const by = num(b.year, state.year - state.age);
  const oy = clampN(Math.round(num(year, num(s.compareYear, by))), 2000, 2100);
  const sex = state.person.sex === 'female' ? 'female' : 'male';
  const ind = (c, k, y) => econ.indicator(data, world, c, k, Math.min(y, 2100));
  const leOf = (c, y) => safe(() => data.cohortLifeExpectancy(c, Math.min(y, 2070), sex), null) ?? ind(c, sex === 'female' ? 'le_f' : 'le_m', y);
  const rows = [
    { key: 'le', label: '出生时预期寿命', unit: '岁', mine: leOf(mine, by), theirs: leOf(other, oy), better: 'high' },
    { key: 'imr', label: '婴儿死亡率', unit: '‰', mine: ind(mine, 'imr', by), theirs: ind(other, 'imr', oy), better: 'low' },
    { key: 'sec', label: '中学入学率（12 岁时）', unit: '%', mine: ind(mine, 'sec_enroll', by + 12), theirs: ind(other, 'sec_enroll', oy + 12), better: 'high' },
    { key: 'ter', label: '大学入学率（18 岁时）', unit: '%', mine: ind(mine, 'ter_enroll', by + 18), theirs: ind(other, 'ter_enroll', oy + 18), better: 'high' },
    { key: 'gdp', label: '人均 GDP（国际元）', unit: '', mine: ind(mine, 'gdp_pc_ppp', by), theirs: ind(other, 'gdp_pc_ppp', oy), better: 'high' },
    { key: 'net', label: '互联网普及率（15 岁时）', unit: '%', mine: ind(mine, 'internet', by + 15), theirs: ind(other, 'internet', oy + 15), better: 'high' },
  ].map((r) => ({ ...r, mine: isNum(r.mine) ? Math.round(r.mine * 10) / 10 : null, theirs: isNum(r.theirs) ? Math.round(r.theirs * 10) / 10 : null }));
  const le = rows[0];
  let line = '';
  if (isNum(le.mine) && isNum(le.theirs)) {
    const d = Math.round((le.theirs - le.mine) * 10) / 10;
    line = Math.abs(d) < 1 ? `如果出生在${cname(data, other)}，预期寿命和这一生差不多。`
      : `如果${oy === by ? '同一年' : ` ${oy} 年`}出生在${cname(data, other)}，预期寿命会${d > 0 ? '多' : '少'}约 ${Math.abs(d)} 岁。`;
  }
  return { iso: other, year: oy, mineIso: mine, mineYear: by, rows, line };
}

/* ------------------------------------------------------------------ automatic choices with a texture */

const ACT_TAGS = [
  [/study|uni|grad|school|exam|learn|olymp|compete|book|elite|exchange|retrain|language/, 'study'],
  [/job|work|offer|promot|career|business|startup|accept|overtime|lead|retrain/, 'career'],
  [/family|kid|child|parent|care|marr|wed|reunion|grand|home|together|adopt|reconcile|stay_near/, 'family'],
  [/emigrate|migrate|business|invest|crypto|gamble|travel|athlete|art_|move|abroad|exchange|start/, 'bold'],
  [/stay|save|keep|insur|decline|wait|careful|check/, 'safe'],
  [/rest|retire|slow|relax|enjoy|leisure|stay_course/, 'comfort'],
  [/volunteer|donat|charity|help|activism|teach|care_parents/, 'give'],
  [/exercise|diet|health|quit|therapy|check/, 'health'],
  [/save|invest|money|frugal/, 'money'],
  [/travel|hobby|art|enjoy|youth|friends|play|free/, 'free'],
  [/friends|social|party|reunion|dating|seek_partner/, 'social'],
];

/**
 * Like decisions.autoChoose, but leaning the way settings.autoTexture points (稳妥 picks low-risk options, 闯荡 bold
 * ones, 顾家 family ones ...). With the default texture it is exactly decisions.autoChoose.
 */
export function autoChooseTextured(state, decision, rng) {
  const tex = textureOf(state);
  const opts = decision && Array.isArray(decision.options) ? decision.options.filter((o) => o && o.id) : [];
  if (tex === 'normal' || !opts.length) {
    if (typeof DEC.autoChoose === 'function') return DEC.autoChoose(state, decision, rng);
    return opts.length ? { optionId: opts[0].id } : { customText: '顺其自然，先把眼前的日子过好。' };
  }
  const R = rng && typeof rng.next === 'function' ? rng : new Rng(hashString(`${state && state.id}|auto|${decision && decision.id}|${tex}`));
  const T = TEXTURES[tex] || TEXTURES.normal;
  const ctxD = (decision && decision.context) || {};
  const auto = ctxD.auto || {};
  const acts = ctxD.acts || {};
  const pick = R.weighted(opts, (o) => {
    let w = Math.max(0.02, num(auto[o.id], 1));
    const act = String((acts[o.id] && acts[o.id].act) || '');
    const tags = new Set(o.risk === 'high' ? ['bold'] : o.risk === 'low' ? ['safe'] : []);
    for (const [re, tag] of ACT_TAGS) if (re.test(act)) tags.add(tag);
    for (const t of tags) w *= num(T.tags[t], 1);
    return w;
  }) || opts[0];
  return { optionId: pick.id };
}
