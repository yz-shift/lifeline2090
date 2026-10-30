// World line ("世界线"): real history up to 2026, a seeded projection after it (CONTRACT §3, SCHEMAS §1–2).
// Pure module: all randomness via Rng streams derived from the world seed, so createWorld(data, seed, branches)
// always rebuilds the same world. Each subsystem (one branch draw per dimension, one stream per milestone, per
// random shock and per region for conflict risk) has its own stream keyed by ids, so adding content or forcing a
// branch never reshuffles unrelated draws.

import { Rng, hashString } from './rng.js';
import { HISTORY_END, LAST_YEAR, FIRST_YEAR, REGIONS, INCOME_THRESHOLDS } from './constants.js';

const YEAR_MAX = 2100;
const FUTURE_FIRST = HISTORY_END + 1;      // 2027
const FAST_RAMP_END = 2031;                // most knobs reach full strength by 2031
const RETIREMENT_RAMP_END = 2060;          // SCHEMAS: retirement_age_add is "years by 2060"
const LE_PER_LOG_MORTALITY = 0.09;         // Gompertz-like slope: +1 year of e0 ≈ hazard × exp(-0.09)

const EFFECT_KEYS = ['economy', 'health', 'happiness', 'safety', 'education', 'tech'];
const SCOPES = ['global', 'regions', 'countries'];
const LOCALIZED = new Set(['war', 'conflict', 'disaster']);
const ARMED = new Set(['war', 'conflict']);

// landlocked countries: sea-level risk does not apply
const LANDLOCKED = new Set(('AFG AND ARM AUT AZE BLR BTN BOL BWA BFA BDI CAF TCD CZE SWZ ETH HUN KAZ KGZ LAO LSO LIE ' +
  'LUX MWI MLI MDA MNG NPL NER MKD PRY RWA SMR SRB SVK SSD CHE TJK TKM UGA UZB VAT ZMB ZWE').split(' '));

// knob -> [min, max]
const KNOB_BOUNDS = {
  gdp_growth_add: [-10, 10],
  unemployment_add: [-20, 30],
  mortality_mult: [0.3, 3],
  inequality_add: [-0.3, 0.3],
  internet_ceiling: [0, 100],
  heat_risk: [0, 3],
  sea_level_risk: [0, 3],
  conflict_risk_add: [0, 0.3],
  migration_push_add: [0, 3],
  retirement_age_add: [-10, 15],
  education_years_add: [-5, 5],
  happiness_add: [-3, 3],
  life_exp_add: [-30, 30],
};
const FAST_ADD = ['gdp_growth_add', 'unemployment_add', 'inequality_add', 'conflict_risk_add', 'migration_push_add',
  'education_years_add', 'happiness_add'];
const CLIMATE_ADD = ['heat_risk', 'sea_level_risk'];
const SOURCE_KNOBS = [...FAST_ADD, ...CLIMATE_ADD, 'mortality_mult', 'internet_ceiling', 'retirement_age_add',
  'life_exp_add_by_2090'];

const NEUTRAL = Object.freeze({
  gdp_growth_add: 0, unemployment_add: 0, mortality_mult: 1, inequality_add: 0, internet_ceiling: 100,
  heat_risk: 0, sea_level_risk: 0, conflict_risk_add: 0, migration_push_add: 0, retirement_age_add: 0,
  education_years_add: 0, happiness_add: 0, life_exp_add: 0,
});

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d);
const ramp = (y, from, to) => clamp((y - from) / (to - from), 0, 1);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/* ------------------------------------------------------------------ normalisation helpers */

function parseYear(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const m = /^(\d{4})/.exec(v.trim());
    if (m) return +m[1];
  }
  return null;
}

function normEffects(e) {
  const o = {};
  for (const k of EFFECT_KEYS) o[k] = Math.round(clamp(num(isObj(e) ? e[k] : 0), -3, 3)) || 0; // no -0
  return o;
}

function normMortality(m) {
  if (!isObj(m)) return undefined;
  const mult = num(m.mult, 1);
  if (!(mult > 0) || Math.abs(mult - 1) < 1e-6) return undefined;
  let lo = 0;
  let hi = 120;
  if (Array.isArray(m.ages) && m.ages.length >= 2) {
    lo = clamp(num(m.ages[0], 0), 0, 120);
    hi = clamp(num(m.ages[1], 120), 0, 120);
    if (hi < lo) [lo, hi] = [hi, lo];
  }
  const out = { mult: clamp(mult, 0.2, 5), ages: [lo, hi] };
  // research files may limit the multiplier to some of the listed countries (the others only take in refugees)
  const at = strArr(m.applies_to).filter((x) => /^[A-Z]{3}$/.test(x));
  if (at.length) out.appliesTo = at;
  if (isObj(m.by_country)) {
    const bc = {};
    for (const [k, v] of Object.entries(m.by_country)) if (/^[A-Z]{3}$/.test(k) && num(v, 0) > 0) bc[k] = clamp(+v, 0.2, 5);
    if (Object.keys(bc).length) out.byCountry = bc;
  }
  return out;
}

/** All-cause mortality multiplier an event carries for one country (1 when it does not apply there). */
export function eventMortality(ev, iso3) {
  const m = ev && ev.mortality;
  if (!isObj(m) || !(num(m.mult, 0) > 0)) return 1;
  if (Array.isArray(m.appliesTo) && m.appliesTo.length && !m.appliesTo.includes(iso3)) return 1;
  if (isObj(m.byCountry) && num(m.byCountry[iso3], 0) > 0) return m.byCountry[iso3];
  return m.mult;
}

function inferScope(raw, regions, countries) {
  if (SCOPES.includes(raw)) return raw;
  if (regions.length) return 'regions';
  if (countries.length) return 'countries';
  return 'global';
}

/** Build a WorldEvent (CONTRACT §3) plus its matching sets. */
function makeEntry(src, { source, id, year, endYear, title, regions, countries, scope, projection, extra }) {
  const ev = {
    id,
    source,
    year,
    endYear,
    title,
    summary: typeof src.summary === 'string' && src.summary.trim() ? src.summary.trim()
      : typeof src.description === 'string' && src.description.trim() ? src.description.trim()
        : typeof src.basis === 'string' ? src.basis.trim() : '',
    category: typeof src.category === 'string' && src.category ? src.category : 'society',
    importance: Math.round(clamp(num(src.importance, source === 'shock' ? 3 : 2), 1, 5)),
    scope,
    countries,
    regions,
    effects: normEffects(src.effects),
    migration_push: Math.round(clamp(num(src.migration_push, 0), 0, 3)),
    personal_hooks: strArr(src.personal_hooks).slice(0, 4),
    sources: strArr(src.sources),
    projection,
  };
  const mort = normMortality(src.mortality);
  if (mort) ev.mortality = mort;
  if (typeof src.start === 'string') ev.date = src.start;
  if (projection && typeof src.basis === 'string' && src.basis.trim()) ev.basis = src.basis.trim();
  if (extra) Object.assign(ev, extra);
  return {
    ev,
    scope,
    rs: scope === 'regions' ? new Set(regions) : null,
    cs: scope === 'global' ? null : new Set(countries),
    spec: scope === 'countries' ? 2 : scope === 'regions' ? 1 : 0,
  };
}

function entryMatches(en, iso3, region) {
  if (en.scope === 'global') return true;
  if (en.cs.has(iso3)) return true;
  return en.scope === 'regions' && region != null && en.rs.has(region);
}

function compareEntries(a, b) {
  return (b.ev.importance - a.ev.importance) || (b.spec - a.spec) || (b.ev.year - a.ev.year) ||
    (a.ev.id < b.ev.id ? -1 : a.ev.id > b.ev.id ? 1 : 0);
}

/* ------------------------------------------------------------------ per-DataStore caches (shared by all worlds) */

const SHARED = new WeakMap();

function shared(data) {
  let s = SHARED.get(data);
  if (s) return s;
  s = { history: buildHistoryIndex(data), pools: new Map() };
  SHARED.set(data, s);
  return s;
}

function validRegions(list) {
  return strArr(list).filter((r) => Object.prototype.hasOwnProperty.call(REGIONS, r));
}

function validCountries(data, list) {
  return strArr(list).map((c) => c.toUpperCase()).filter((c) => !!data.country(c));
}

function buildHistoryIndex(data) {
  const byYear = new Map();
  const history = (data.content && Array.isArray(data.content.history)) ? data.content.history : [];
  const seen = new Set();
  for (const raw of history) {
    if (!isObj(raw) || typeof raw.title !== 'string' || !raw.title.trim()) continue;
    const year = parseYear(raw.year) ?? parseYear(raw.start);
    if (year == null || year > HISTORY_END) continue;
    let endYear = parseYear(raw.end_year) ?? parseYear(raw.end) ?? year;
    if (endYear < year) endYear = year;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : `history_${year}_${seen.size}`;
    while (seen.has(id)) id += '_';
    seen.add(id);
    const regions = validRegions(raw.regions);
    const countries = validCountries(data, raw.countries);
    const scope = inferScope(raw.scope, regions, countries);
    const en = makeEntry(raw, {
      source: 'history', id, year, endYear, title: raw.title.trim(), regions, countries, scope, projection: false,
    });
    const from = Math.max(FIRST_YEAR, year);
    const to = Math.min(HISTORY_END, endYear);
    for (let y = from; y <= to; y++) {
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(en);
    }
  }
  return byYear;
}

// armed conflict on a country's own soil is far more frequent in poorer countries
const INCOME_CONFLICT_WEIGHT = { LIC: 2.5, LMC: 1.6, UMC: 0.8, HIC: 0.12 };

/** Candidate countries of a game region with conflict-site weights (population and income based). */
function regionPool(data, region) {
  const s = shared(data);
  let pool = s.pools.get(region);
  if (pool) return pool;
  pool = [];
  for (const iso of data.isoList) {
    const c = data.country(iso);
    if (!c || c.region !== region) continue;
    const pop = data.series(iso, 'pop', 2025);
    if (!(pop > 150)) continue; // skip micro-states (pop in thousands)
    pool.push({ iso, w: Math.sqrt(pop) * (INCOME_CONFLICT_WEIGHT[data.incomeGroup(iso, 2025)] || 1) });
  }
  s.pools.set(region, pool);
  return pool;
}

function pickDistinct(rng, items, weights, n) {
  const its = items.slice();
  const ws = weights.slice();
  const out = [];
  while (out.length < n && its.length) {
    const it = rng.weighted(its, ws);
    if (it === undefined) break;
    const i = its.indexOf(it);
    out.push(it);
    its.splice(i, 1);
    ws.splice(i, 1);
  }
  return out;
}

/* ------------------------------------------------------------------ normal distribution (poverty model) */

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function normInv(p) {
  // Acklam's rational approximation (relative error < 1.2e-9)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const giniSigma = (g) => Math.SQRT2 * normInv((clamp(g, 5, 90) / 100 + 1) / 2);

/**
 * Lognormal headcount model: keep the poverty line implied by the baseline (poverty, gdp, gini) and recompute the
 * share below it after the scenario changes mean income (gdpRatio) and inequality (gini).
 */
function adjustPoverty(p0, gini0, gini1, gdpRatio) {
  if (Math.abs(gdpRatio - 1) < 1e-9 && Math.abs(gini1 - gini0) < 1e-9) return p0;
  const s0 = giniSigma(gini0);
  const s1 = giniSigma(gini1);
  const p = clamp(p0 / 100, 1e-5, 0.995);
  const k = s0 * normInv(p) - (s0 * s0) / 2; // ln z - ln mean
  const k1 = k - Math.log(Math.max(1e-6, gdpRatio));
  return clamp(100 * normCdf(k1 / s1 + s1 / 2), 0, 100);
}

/* ------------------------------------------------------------------ text */

const ARMED_HOOKS = [
  '新闻里不断传来冲突地区的消息，物价和人心都受到影响。',
  '有人开始收拾行李，考虑暂时离开家乡投奔亲友。',
];

function joinNames(data, isos) {
  return isos.map((i) => (data.country(i) ? data.country(i).name : i)).join('、');
}

function worldCode(seedStr) {
  const h = hashString('LL2090|' + seedStr).toString(36).toUpperCase().padStart(6, '0').slice(-6);
  return `${h.slice(0, 3)}-${h.slice(3)}`;
}

/* ------------------------------------------------------------------ createWorld */

/**
 * @param {object} data            DataStore
 * @param {number|string} worldSeed
 * @param {object} [forcedBranches] {dimensionId: branchId} (partial allowed; unknown ids ignored)
 */
export function createWorld(data, worldSeed, forcedBranches) {
  const seed = worldSeed == null ? 0 : worldSeed;
  const seedStr = String(seed);
  const forced = isObj(forcedBranches) ? forcedBranches : {};
  const future = (data.content && isObj(data.content.future)) ? data.content.future : {};
  const hist = shared(data).history;

  /* ---------- branches ---------- */
  const dims = [];
  const branches = {};
  const chosen = []; // {dim, branch} with raw objects
  const seenDims = new Set();
  let centerLE = 0;
  let centerLogM = 0;
  for (const dim of Array.isArray(future.dimensions) ? future.dimensions : []) {
    if (!isObj(dim) || typeof dim.id !== 'string' || seenDims.has(dim.id)) continue;
    const brs = (Array.isArray(dim.branches) ? dim.branches : []).filter((b) => isObj(b) && typeof b.id === 'string');
    if (!brs.length) continue;
    seenDims.add(dim.id);
    const u = new Rng(hashString(`${seedStr}|dim|${dim.id}`)).next(); // always drawn, forced or not
    const ws = brs.map((b) => Math.max(0, num(b.prob, 0)));
    let tot = ws.reduce((s, w) => s + w, 0);
    if (!(tot > 0)) { ws.fill(1); tot = ws.length; }
    let bi = typeof forced[dim.id] === 'string' ? brs.findIndex((b) => b.id === forced[dim.id]) : -1;
    if (bi < 0) {
      let acc = 0;
      bi = brs.length - 1;
      for (let i = 0; i < brs.length; i++) {
        acc += ws[i] / tot;
        if (u < acc) { bi = i; break; }
      }
    }
    const br = brs[bi];
    branches[dim.id] = br.id;
    chosen.push({ dim, branch: br });
    // Ensemble centring: WPP medium already contains expected mortality progress, so the probability-weighted
    // mean of each dimension's longevity knobs is subtracted. The average world line then equals WPP medium;
    // individual world lines stay above or below it.
    for (let i = 0; i < brs.length; i++) {
      const m = isObj(brs[i].modifiers) ? brs[i].modifiers : {};
      const p = ws[i] / tot;
      const le = num(m.life_exp_add_by_2090, NaN);
      if (Number.isFinite(le)) centerLE += p * le;
      const mm = num(m.mortality_mult, NaN);
      if (Number.isFinite(mm) && mm > 0) centerLogM += p * Math.log(mm);
    }
    dims.push({
      id: dim.id,
      title: typeof dim.title === 'string' ? dim.title : dim.id,
      branch: {
        id: br.id,
        title: typeof br.title === 'string' ? br.title : br.id,
        description: typeof br.description === 'string' ? br.description : '',
        prob: Math.round((ws[bi] / tot) * 10000) / 10000,
      },
    });
  }

  function requiresOk(req) {
    if (!isObj(req)) return true;
    for (const [dimId, want] of Object.entries(req)) {
      if (!seenDims.has(dimId)) continue; // dimension not in content: condition cannot be evaluated, ignore it
      const list = Array.isArray(want) ? want : typeof want === 'string' ? [want] : [];
      if (list.length && !list.includes(branches[dimId])) return false;
    }
    return true;
  }

  /* ---------- modifiers ---------- */
  // effective numeric knobs of each chosen branch for a region / country (region_overrides replace base values)
  const effCache = new Map();
  function branchKnobs(region, iso3) {
    const key = `${region || ''}|${iso3 || ''}`;
    let list = effCache.get(key);
    if (list) return list;
    list = chosen.map(({ branch }) => {
      const out = {};
      const layers = [branch.modifiers];
      const ov = isObj(branch.region_overrides) ? branch.region_overrides : {};
      if (region && isObj(ov[region])) layers.push(ov[region]);
      if (iso3 && isObj(ov[iso3])) layers.push(ov[iso3]);
      for (const layer of layers) {
        if (!isObj(layer)) continue;
        for (const k of SOURCE_KNOBS) {
          const v = num(layer[k], NaN);
          if (Number.isFinite(v)) out[k] = v;
        }
      }
      return out;
    });
    effCache.set(key, list);
    return list;
  }

  function computeMods(region, iso3, y) {
    const out = { ...NEUTRAL };
    if (!(y > HISTORY_END)) return out;
    const yy = Math.min(y, YEAR_MAX);
    const fFast = ramp(yy, HISTORY_END, FAST_RAMP_END);
    const fLong = ramp(yy, HISTORY_END, LAST_YEAR);
    const fRet = ramp(yy, HISTORY_END, RETIREMENT_RAMP_END);
    for (const k of branchKnobs(region, iso3)) {
      for (const f of FAST_ADD) if (k[f] !== undefined) out[f] += k[f] * fFast;
      for (const f of CLIMATE_ADD) if (k[f] !== undefined) out[f] += k[f] * fLong;
      if (k.life_exp_add_by_2090 !== undefined) out.life_exp_add += k.life_exp_add_by_2090 * fLong;
      if (k.retirement_age_add !== undefined) out.retirement_age_add += k.retirement_age_add * fRet;
      if (k.mortality_mult !== undefined && k.mortality_mult > 0) out.mortality_mult *= Math.pow(k.mortality_mult, fFast);
      if (k.internet_ceiling !== undefined) {
        const c = clamp(k.internet_ceiling, 0, 100);
        out.internet_ceiling = Math.min(out.internet_ceiling, 100 - (100 - c) * fFast);
      }
    }
    out.life_exp_add -= centerLE * fLong;
    out.mortality_mult /= Math.exp(centerLogM * fFast);
    for (const [k, [lo, hi]] of Object.entries(KNOB_BOUNDS)) out[k] = clamp(out[k], lo, hi);
    if (iso3 && LANDLOCKED.has(iso3)) out.sea_level_risk = 0;
    return out;
  }

  const modsCache = new Map(); // iso3 -> array indexed by year - FUTURE_FIRST
  function modsFor(iso3, year) {
    const y = Math.floor(+year);
    if (!(y > HISTORY_END)) return NEUTRAL;
    const yy = Math.min(y, YEAR_MAX);
    let arr = modsCache.get(iso3);
    if (!arr) {
      arr = new Array(YEAR_MAX - HISTORY_END);
      modsCache.set(iso3, arr);
    }
    const i = yy - FUTURE_FIRST;
    let m = arr[i];
    if (!m) {
      const c = data.country(iso3);
      m = Object.freeze(computeMods(c ? c.region : undefined, iso3, yy));
      arr[i] = m;
    }
    return m;
  }

  const regionModsCache = new Map();
  function regionMods(region, y) {
    const key = `${region}|${y}`;
    let m = regionModsCache.get(key);
    if (!m) {
      m = computeMods(region, null, y);
      regionModsCache.set(key, m);
    }
    return m;
  }

  /* ---------- future timeline ---------- */
  const futureItems = []; // entries
  const usedIds = new Set();
  const uniqueId = (id) => {
    let u = id;
    let i = 2;
    while (usedIds.has(u)) u = `${id}_${i++}`;
    usedIds.add(u);
    return u;
  };

  // milestones
  const seenMs = new Set();
  for (const m of Array.isArray(future.milestones) ? future.milestones : []) {
    if (!isObj(m) || typeof m.id !== 'string' || typeof m.title !== 'string' || seenMs.has(m.id)) continue;
    seenMs.add(m.id);
    if (!requiresOk(m.requires)) continue;
    const r = new Rng(hashString(`${seedStr}|ms|${m.id}`));
    const occurs = r.next() < clamp(num(m.prob, 1), 0, 1);
    const year = sampleMilestoneYear(m, r);
    if (!occurs || year == null) continue;
    let dur = 1;
    if (num(m.duration_years, 0) >= 1) dur = Math.round(num(m.duration_years, 1));
    else if (parseYear(m.end_year) != null && parseYear(m.year) != null) dur = parseYear(m.end_year) - parseYear(m.year) + 1;
    dur = clamp(dur, 1, 60);
    const regions = validRegions(m.regions);
    const countries = validCountries(data, m.countries);
    const scope = inferScope(m.scope, regions, countries);
    futureItems.push(makeEntry(m, {
      source: 'future', id: uniqueId(m.id), year, endYear: year + dur - 1, title: m.title.trim(),
      regions, countries, scope, projection: true, extra: { refId: m.id, prob: clamp(num(m.prob, 1), 0, 1) },
    }));
  }

  // random shocks
  const seenSh = new Set();
  for (const sh of Array.isArray(future.random_shocks) ? future.random_shocks : []) {
    if (!isObj(sh) || typeof sh.id !== 'string' || typeof sh.title !== 'string' || seenSh.has(sh.id)) continue;
    seenSh.add(sh.id);
    if (!requiresOk(sh.requires)) continue;
    const p = clamp(num(sh.annual_prob, 0), 0, 0.5);
    if (!(p > 0)) continue;
    const dur = clamp(Math.round(num(sh.duration_years, 1)) || 1, 1, 20);
    let from = FUTURE_FIRST;
    let to = LAST_YEAR;
    if (Array.isArray(sh.year_range) && sh.year_range.length >= 2) {
      from = Math.max(from, parseYear(sh.year_range[0]) ?? from);
      to = Math.min(to, parseYear(sh.year_range[1]) ?? to);
    }
    const maxOcc = num(sh.max_occurrences, 0) >= 1 ? Math.floor(num(sh.max_occurrences, 0)) : Infinity;
    const r = new Rng(hashString(`${seedStr}|shock|${sh.id}`));
    const baseRegions = validRegions(sh.regions);
    const baseCountries = validCountries(data, sh.countries);
    const baseScope = inferScope(sh.scope, baseRegions, baseCountries);
    const cat = typeof sh.category === 'string' ? sh.category : '';
    let activeUntil = 0;
    let count = 0;
    for (let y = FUTURE_FIRST; y <= LAST_YEAR; y++) {
      const u = r.next(); // one draw per year keeps the stream aligned
      if (y <= activeUntil || y < from || y > to || count >= maxOcc || u >= p) continue;
      const pr = new Rng(hashString(`${seedStr}|shock|${sh.id}|${y}`));
      const place = placeShock(sh, cat, baseScope, baseRegions, baseCountries, pr);
      if (!place) continue;
      const title = place.picked ? `${sh.title.trim()}（${joinNames(data, place.countries)}）` : sh.title.trim();
      futureItems.push(makeEntry(sh, {
        source: 'shock', id: uniqueId(`${sh.id}_${y}`), year: y, endYear: y + dur - 1, title,
        regions: place.regions, countries: place.countries, scope: place.scope, projection: true,
        extra: { refId: sh.id },
      }));
      activeUntil = y + dur - 1;
      count++;
    }
  }

  function placeShock(sh, cat, scope, regions, countries, pr) {
    const explicit = num(sh.pick, 0) >= 1 ? Math.floor(num(sh.pick, 0)) : 0;
    const two = pr.chance(0.3);
    // armed conflicts touch one named country unless the content asks otherwise (never implies a war between two picks)
    const n = explicit || (ARMED.has(cat) ? 1 : two ? 2 : 1);
    if (scope === 'countries' && countries.length && (explicit || (LOCALIZED.has(cat) && countries.length > 3))) {
      const ws = countries.map((iso) => Math.sqrt(Math.max(1, data.series(iso, 'pop', 2025) || 1)));
      const picked = pickDistinct(pr, countries, ws, Math.min(n, countries.length));
      return { scope: 'countries', regions: [], countries: picked, picked: true };
    }
    // regional disasters and epidemics strike a few countries of the region, not the whole region at once
    // (a bad wildfire season in the Americas does not put smoke over every city from Canada to Chile)
    if (scope === 'regions' && (cat === 'disaster' || cat === 'epidemic') && !explicit) {
      const k = two ? 3 : 2;
      if (countries.length) {
        const ws = countries.map((iso) => Math.sqrt(Math.max(1, data.series(iso, 'pop', 2025) || 1)));
        const picked = pickDistinct(pr, countries, ws, Math.min(k, countries.length));
        return { scope: 'countries', regions: [], countries: picked, picked: true };
      }
      if (regions.length) {
        const reg = pr.pick(regions);
        const pool = regionPool(data, reg);
        const picked = pickDistinct(pr, pool.map((x) => x.iso), pool.map((x) => x.w), k);
        if (picked.length) return { scope: 'countries', regions: [reg], countries: picked, picked: true };
      }
    }
    if (scope === 'regions' && regions.length && (explicit || ARMED.has(cat))) {
      const reg = pr.pick(regions);
      const pool = regionPool(data, reg);
      const picked = pickDistinct(pr, pool.map((x) => x.iso), pool.map((x) => x.w), n);
      if (!picked.length) return null;
      return { scope: 'countries', regions: [reg], countries: picked, picked: true };
    }
    return { scope, regions, countries, picked: false };
  }

  // regional armed-conflict risk from the conflict_risk_add knob (annual probability per region)
  if (chosen.length) {
    for (const region of Object.keys(REGIONS)) {
      const pFull = regionMods(region, LAST_YEAR).conflict_risk_add; // ramps up monotonically to this value
      if (!(pFull > 0)) continue;
      const r = new Rng(hashString(`${seedStr}|conflict|${region}`));
      let activeUntil = 0;
      for (let y = FUTURE_FIRST; y <= LAST_YEAR; y++) {
        const u = r.next();
        if (y <= activeUntil || u >= pFull) continue;
        const p = regionMods(region, y).conflict_risk_add;
        if (!(p > 0) || u >= p) continue;
        // one affected country, named neutrally ("波及"), never framed as a war between two named states
        const pr = new Rng(hashString(`${seedStr}|conflict|${region}|${y}`));
        const pool = regionPool(data, region);
        const picked = pickDistinct(pr, pool.map((x) => x.iso), pool.map((x) => x.w), 1);
        if (!picked.length) continue;
        const dur = pr.weighted([1, 2, 3, 4, 5], [3, 3, 2, 1, 1]);
        const names = joinNames(data, picked);
        // a local conflict is diluted across a large population: full strength at <= 20 million people
        const popK = data.series(picked[0], 'pop', y) || 20000;
        const reach = clamp(Math.sqrt(20000 / popK), 0.08, 1);
        const sc = (v) => Math.round(v * (reach < 0.5 ? 0.5 : 1));
        futureItems.push(makeEntry({
          summary: `推演情景：${REGIONS[region]}局部地区爆发武装冲突，波及${names}，局势动荡，部分居民被迫离开家园。`,
          category: 'war', importance: 3, personal_hooks: ARMED_HOOKS,
          effects: { economy: sc(-2), health: sc(-1), happiness: sc(-2), safety: sc(-3), education: sc(-1), tech: 0 },
          mortality: { mult: Math.round((1 + 0.25 * reach) * 1000) / 1000, ages: [0, 120] }, migration_push: reach < 0.5 ? 1 : 2,
          basis: `由本世界线的地区冲突风险参数随机生成（${REGIONS[region]}，当年约 ${(p * 100).toFixed(1)}%）。`,
        }, {
          source: 'shock', id: uniqueId(`conflict_${region.toLowerCase()}_${y}`), year: y, endYear: y + dur - 1,
          title: `局部武装冲突（${REGIONS[region]}）`, regions: [region], countries: picked, scope: 'countries', projection: true,
          extra: { refId: 'regional_conflict' },
        }));
        activeUntil = y + dur - 1;
      }
    }
  }

  futureItems.sort((a, b) => (a.ev.year - b.ev.year) || compareEntries(a, b));

  const futureByYear = new Map();
  for (const en of futureItems) {
    for (let y = Math.max(FUTURE_FIRST, en.ev.year); y <= Math.min(YEAR_MAX, en.ev.endYear); y++) {
      if (!futureByYear.has(y)) futureByYear.set(y, []);
      futureByYear.get(y).push(en);
    }
  }

  function entriesFor(y) {
    if (y <= HISTORY_END) return hist.get(y) || [];
    return futureByYear.get(y) || [];
  }

  /* ---------- events / headlines ---------- */
  const evCache = new Map();
  function eventsFor(iso3, year) {
    const y = Math.floor(+year);
    if (!(y >= FIRST_YEAR && y <= YEAR_MAX)) return [];
    const key = `${iso3}|${y}`;
    let list = evCache.get(key);
    if (!list) {
      const c = data.country(iso3);
      const region = c ? c.region : null;
      list = entriesFor(y).filter((en) => entryMatches(en, iso3, region)).sort(compareEntries).map((en) => en.ev);
      evCache.set(key, list);
    }
    return list;
  }

  function headlines(year, iso3, n = 6) {
    const y = Math.floor(+year);
    if (!(y >= FIRST_YEAR && y <= YEAR_MAX)) return [];
    const c = iso3 ? data.country(iso3) : null;
    const region = c ? c.region : null;
    const scored = [];
    for (const en of entriesFor(y)) {
      const g = en.scope === 'global';
      const local = iso3 ? entryMatches(en, iso3, region) : false;
      if (!g && !local && en.ev.importance < 4) continue;
      // this year's news first: ongoing events fade with every year since they began; the person's own country
      // outranks other countries' national news, which only shows when it is very important
      const since = Math.max(0, y - num(en.ev.year, y));
      const foreign = !g && !local;
      const score = en.ev.importance * 10 + (local && !g ? 20 : 0) + (local && g ? 6 : 0) + (g ? 4 : 0) - (foreign ? 14 : 0)
        + (since === 0 ? 15 : -4 * Math.min(since, 5));
      scored.push({ en, score });
    }
    scored.sort((a, b) => (b.score - a.score) || compareEntries(a.en, b.en));
    // greedy pick with a penalty for repeating a category, so one crisis does not fill every slot
    const lim = Math.max(0, Math.floor(num(n, 6)));
    const out = [];
    const catCount = {};
    const pool = scored.slice();
    while (out.length < lim && pool.length) {
      let bi = 0;
      let best = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const v = pool[i].score - 18 * (catCount[pool[i].en.ev.category] || 0);
        if (v > best) { best = v; bi = i; }
      }
      const [pick] = pool.splice(bi, 1);
      catCount[pick.en.ev.category] = (catCount[pick.en.ev.category] || 0) + 1;
      out.push(pick.en.ev);
    }
    return out;
  }

  /* ---------- mortality ---------- */
  const mmCache = new Map(); // iso3 -> array by year of {base, ranges}
  function mmState(iso3, y) {
    let arr = mmCache.get(iso3);
    if (!arr) {
      arr = new Array(YEAR_MAX - HISTORY_END);
      mmCache.set(iso3, arr);
    }
    const i = y - FUTURE_FIRST;
    let st = arr[i];
    if (!st) {
      const m = modsFor(iso3, y);
      const base = Math.exp(-LE_PER_LOG_MORTALITY * m.life_exp_add) * m.mortality_mult;
      const ranges = [];
      for (const ev of eventsFor(iso3, y)) {
        if (!ev.mortality || !ev.projection) continue;
        const mm = eventMortality(ev, iso3);
        if (mm !== 1) ranges.push(ev.mortality.ages[0], ev.mortality.ages[1], mm);
      }
      st = { base, ranges: Float64Array.from(ranges) };
      arr[i] = st;
    }
    return st;
  }

  function mortalityMult(iso3, year, age) {
    const y = Math.floor(+year);
    if (!(y > HISTORY_END)) return 1;
    const st = mmState(iso3, y > YEAR_MAX ? YEAR_MAX : y);
    let m = st.base;
    const r = st.ranges;
    for (let i = 0; i < r.length; i += 3) if (age >= r[i] && age <= r[i + 1]) m *= r[i + 2];
    return m < 0.2 ? 0.2 : m > 5 ? 5 : m;
  }

  const leCache = new Map();
  function lifeExpectancy(iso3, year, sex) {
    const y = clamp(Math.floor(num(year, FIRST_YEAR)), FIRST_YEAR, YEAR_MAX);
    if (y <= HISTORY_END) return data.periodLifeExpectancy(iso3, y, sex);
    const key = `${iso3}|${y}|${sex}`;
    let v = leCache.get(key);
    if (v === undefined) {
      v = data.periodLifeExpectancy(iso3, y, sex, (yy, age) => mortalityMult(iso3, yy, age));
      leCache.set(key, v);
    }
    return v;
  }

  const cohortCache = new Map();
  function cohortLifeExpectancy(iso3, birthYear, sex, fromAge = 0) {
    const mult = (yy, age) => mortalityMult(iso3, yy, age);
    if (fromAge) return data.cohortLifeExpectancy(iso3, birthYear, sex, mult, fromAge);
    const key = `${iso3}|${birthYear}|${sex}`;
    let v = cohortCache.get(key);
    if (v === undefined) {
      v = data.cohortLifeExpectancy(iso3, birthYear, sex, mult);
      cohortCache.set(key, v);
    }
    return v;
  }

  function cohortSurvival(iso3, birthYear, sex, fromAge = 0) {
    return data.cohortSurvival(iso3, birthYear, sex, fromAge, (yy, age) => mortalityMult(iso3, yy, age));
  }

  /* ---------- indicators ---------- */
  const gdpCache = new Map();
  function gdpFactor(iso3, y) {
    if (y <= HISTORY_END) return 1;
    let arr = gdpCache.get(iso3);
    if (!arr) {
      arr = new Float64Array(YEAR_MAX - HISTORY_END);
      let f = 1;
      for (let yy = FUTURE_FIRST; yy <= YEAR_MAX; yy++) {
        f *= 1 + modsFor(iso3, yy).gdp_growth_add / 100;
        arr[yy - FUTURE_FIRST] = f;
      }
      gdpCache.set(iso3, arr);
    }
    return arr[Math.min(y, YEAR_MAX) - FUTURE_FIRST];
  }

  function indicator(iso3, key, year) {
    const base = data.series(iso3, key, year);
    if (base == null || !(year > HISTORY_END)) return base;
    const y = Math.min(Math.floor(+year), YEAR_MAX);
    if (y <= HISTORY_END) return base;
    const m = modsFor(iso3, y);
    switch (key) {
      case 'gdp_pc_ppp':
      case 'health_exp_pc':
        return base * gdpFactor(iso3, y);
      case 'gdp_growth':
        return base + m.gdp_growth_add;
      case 'unemployment':
        return clamp(base + m.unemployment_add, 0.1, 60);
      case 'youth_unemp':
        return clamp(base + 2 * m.unemployment_add, 0.2, 80);
      case 'gini':
        return clamp(base + 100 * m.inequality_add, 15, 75);
      case 'internet':
        return Math.min(base, m.internet_ceiling);
      case 'poverty': {
        const g0 = data.series(iso3, 'gini', year);
        const gini0 = g0 == null ? 38 : g0;
        const gini1 = clamp(gini0 + 100 * m.inequality_add, 15, 75);
        return adjustPoverty(base, gini0, gini1, gdpFactor(iso3, y));
      }
      case 'le':
      case 'le_m':
      case 'le_f':
        return base + m.life_exp_add - Math.log(m.mortality_mult) / LE_PER_LOG_MORTALITY;
      case 'imr':
      case 'q5':
      case 'maternal_mort':
        return base * Math.exp(-LE_PER_LOG_MORTALITY * m.life_exp_add) * m.mortality_mult;
      case 'sec_enroll':
        return clamp(base + 3 * m.education_years_add, 0, Math.max(base, 130));
      case 'ter_enroll':
        return clamp(base + 6 * m.education_years_add, 0, Math.max(base, 120));
      default:
        return base;
    }
  }

  function incomeGroup(iso3, year) {
    const gdp = indicator(iso3, 'gdp_pc_ppp', year == null ? 2025 : year);
    if (gdp == null) return data.incomeGroup(iso3, year);
    for (const t of INCOME_THRESHOLDS) if (gdp < t.max) return t.id;
    return 'HIC';
  }

  /* ---------- labels ---------- */
  const code = worldCode(seedStr);
  const order = dims.map((d, i) => ({ d, i })).sort((a, b) => (a.d.branch.prob - b.d.branch.prob) || (a.i - b.i));
  const distinctive = order.slice(0, 3).sort((a, b) => a.i - b.i).map((x) => x.d.branch.title);
  const label = `世界线 ${code} · ${distinctive.length ? distinctive.join(' · ') : '基准趋势'}`;

  const timelineEvents = futureItems.map((en) => en.ev);
  const description = describe();

  function describe() {
    const parts = [`这是一条推演中的世界线（编号 ${code}）。2000—2026 年与真实历史一致；2027 年以后的走向由今天的趋势推演而来。`];
    if (!dims.length) {
      parts.push('目前没有载入情景分支，2027 年以后沿用联合国人口展望与世界银行数据的基准趋势。');
    } else {
      parts.push(`在这条世界线上，${dims.map((d) => `${d.title}为“${d.branch.title}”`).join('；')}。`);
      const rare = dims.filter((d) => d.branch.prob > 0 && d.branch.prob < 0.2);
      if (rare.length) {
        parts.push(`其中${rare.map((d) => `“${d.branch.title}”（约 ${Math.max(1, Math.round(d.branch.prob * 100))}%）`).join('、')}属于小概率情景。`);
      }
    }
    const ms = timelineEvents.filter((e) => e.source === 'future');
    if (ms.length) {
      const top = ms.slice().sort((a, b) => (b.importance - a.importance) || (a.year - b.year)).slice(0, 3)
        .sort((a, b) => a.year - b.year);
      parts.push(`可能出现的关键节点包括：${top.map((e) => `${e.year} 年前后的“${e.title}”`).join('、')}。`);
    }
    const shocks = timelineEvents.filter((e) => e.source === 'shock');
    if (shocks.length) {
      parts.push(`此外还抽到了 ${shocks.length} 次突发事件，最早的是 ${shocks[0].year} 年的“${shocks[0].title}”。`);
    } else if (dims.length) {
      parts.push('这一次没有抽到大的突发冲击。');
    }
    parts.push('以上均为基于当前趋势的情景推演，不是预测，更不是事实。');
    return parts.join('');
  }

  return {
    seed,
    code,
    branches: { ...branches },
    label,
    description,
    dims,
    assumptions: Array.isArray(future.baseline_assumptions) ? future.baseline_assumptions : [],
    modifiers(iso3, year) {
      return { ...modsFor(iso3, year) };
    },
    indicator,
    incomeGroup,
    lifeExpectancy,
    cohortLifeExpectancy,
    cohortSurvival,
    mortalityMult,
    events(iso3, year) {
      return eventsFor(iso3, year).slice();
    },
    headlines,
    isProjection(year) {
      return year > HISTORY_END;
    },
    timeline() {
      return timelineEvents.slice();
    },
    toJSON() {
      return { seed, branches: { ...branches } };
    },
  };
}

/** Milestone year: triangular around `year` inside `year_range` (inclusive), clamped to the projection window. */
function sampleMilestoneYear(m, r) {
  const y0 = parseYear(m.year);
  const rg = Array.isArray(m.year_range) && m.year_range.length >= 2
    ? [parseYear(m.year_range[0]), parseYear(m.year_range[1])] : null;
  const u = r.next(); // always drawn
  if (rg && rg[0] != null && rg[1] != null) {
    let lo = Math.max(FUTURE_FIRST, Math.min(rg[0], rg[1]));
    let hi = Math.min(LAST_YEAR, Math.max(rg[0], rg[1]));
    if (hi < lo) {
      if (y0 == null) return null;
      lo = hi = clamp(y0, FUTURE_FIRST, LAST_YEAR);
    }
    if (hi === lo) return lo;
    const a = lo;
    const b = hi + 1;
    const c = clamp((y0 == null ? (lo + hi) / 2 : y0) + 0.5, a, b);
    const fc = (c - a) / (b - a);
    const x = u < fc ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
    return clamp(Math.floor(x), lo, hi);
  }
  if (y0 == null) return null;
  return clamp(y0, FUTURE_FIRST, LAST_YEAR);
}
