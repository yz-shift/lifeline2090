// Offline decisions (CONTRACT §2, §3, §4 "Decisions" and "Threads").
//
//  - nextDecisionAge(state, frequency) -> the next age (> state.age) with a milestone decision, 999 when none is left.
//  - buildDecisionOffline(data, world, state, ctx, rng) -> Decision for the current age, adapted to country, income
//    group, city/village, sex, schooling, career, relationship, era, world line and active world events.
//  - triggeredDecision(data, world, state, ctx, rng) -> Decision|null (war, layoff, illness, offers, disasters ...),
//    at most about one every few years.
//  - resolveOffline(data, world, state, decision, choice, rng) -> Resolution (CONTRACT §3) with feasibility checks,
//    stochastic outcomes and follow-up Threads so later life depends on the choice.
//  - classifyIntent(text, data) -> {intents, targetCountry, targetCity, keywords, negated} for free-text actions.
//  - autoChoose(state, decision, rng) -> {optionId}.
//
// Decisions built here carry `context: {key, acts:{a:{act,p}}, auto:{a:weight}}`; resolveOffline uses it to know
// what each option means. Decisions without it (AI decisions, thread decisions whose context was dropped) are
// resolved by classifying the option text with the same lexicon used for free text.
//
// Pure module: no DOM, no Math.random, no Date.

import { DECISION_AGES, DECISION_FREQUENCY, MAX_AGE } from './constants.js';
import { Rng, hashString } from './rng.js';
import { lifeFacts, fillText, keyExams, personName, CITIES, GULF } from './events.js';

/* ------------------------------------------------------------------ small helpers */

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
function num(...xs) {
  for (const x of xs) {
    if (isNum(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(+x)) return +x;
  }
  return null;
}
const clampN = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const safe = (fn, fb = null) => { try { const v = fn(); return v === undefined || v === null ? fb : v; } catch { return fb; } };
const ci = (v) => Math.round(clampN(num(v, 0), -15, 15));
const OPT_IDS = ['a', 'b', 'c', 'd'];
const ED = ['none', 'preschool', 'primary', 'secondary', 'vocational', 'tertiary', 'postgrad'];

function lab(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= 16 ? t : t.slice(0, 16);
}
function nameOf(data, iso) {
  return safe(() => data.country(iso).name) || safe(() => data.countries[iso].name) || '国外';
}
function shortText(t, n = 30) {
  const s = String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '……' : s;
}
const PCT = (f, d) => clampN(Math.round((f.incomePct + d) * 1000) / 1000, 0.02, 0.98);
const setPct = (v) => clampN(Math.round(v * 1000) / 1000, 0.02, 0.98);
function rngFor(state, label) {
  return new Rng(hashString(`${(state && (state.id || state.seed)) || 'life'}:${label}`));
}
function bigCity(f) {
  const list = CITIES[f.iso];
  return list && list.length ? list[hashString(`${f.state.id || ''}|${f.iso}|big`) % Math.min(3, list.length)] : '首都';
}
function popOf(data, iso, year) { return num(safe(() => data.series(iso, 'pop', year)), 0); }

/* ------------------------------------------------------------------ resolution builders */

/** months of the person's own monthly income (household's for young adults); children never move money */
function money(f, months) {
  if (!months || f.age < 16) return 0;
  return Math.round(clampN(months * f.monthRef, -3e6, 3e6));
}
function fxOf(f, arr, rng) {
  const a = Array.isArray(arr) ? arr : [];
  const j = (v) => (rng && v && Math.abs(v) >= 3 ? v + rng.int(-1, 1) : v);
  return { health: ci(j(num(a[0], 0))), happiness: ci(j(num(a[1], 0))), knowledge: ci(j(num(a[2], 0))), relationships: ci(j(num(a[3], 0))), wealthDelta: money(f, num(a[4], 0)) };
}
function hz(mult, years, reason) {
  return { mult: clampN(Math.round(num(mult, 1) * 100) / 100, 0.5, 2), years: clampN(Math.round(num(years, 1)), 1, 30), reason: String(reason || '') };
}
/** Thread helper: fires `years` from now (absolute year trigger). Text is filled now. */
function th(f, X, years, title, text, arr, set, extra = {}) {
  const year = f.year + Math.max(1, Math.round(years));
  const id = `th-${hashString(`${X.key}|${title}|${year}|${f.state.id || f.state.seed || ''}|${X.rng.int(0, 1e6)}`).toString(36)}`;
  const t = {
    id, title: String(title), text: X.fill(text), trigger: { year },
    conditions: { alive: true, ...(extra.conditions || {}) },
    effects: fxOf(f, arr, null), source: 'local',
  };
  if (set && typeof set === 'object' && Object.keys(set).length) t.set = set;
  if (extra.decision) t.decision = extra.decision;
  return t;
}
/** Resolution helper. opt: {set, threads, hz:[mult,years,reason], feasible, note} */
function out(f, X, narrative, arr, opt = {}) {
  const r = {
    narrative: X.fill(narrative),
    effects: fxOf(f, arr, X.rng),
    set: opt.set && typeof opt.set === 'object' ? opt.set : {},
    threads: Array.isArray(opt.threads) ? opt.threads.filter(Boolean) : [],
    feasible: opt.feasible !== false,
  };
  if (opt.hz) r.hazard = hz(opt.hz[0], opt.hz[1], opt.hz[2]);
  if (opt.note) r.note = String(opt.note);
  return r;
}
function merge(a, b) {
  const o = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) o[k] = { ...o[k], ...v };
    else o[k] = v;
  }
  return o;
}

/* ------------------------------------------------------------------ places and family */

/** the city this person lives in now (null in the countryside) */
function hereCity(f, X) {
  if (!f.u) return null;
  return (typeof f.flags.city === 'string' && f.flags.city) || X.fill('{city}');
}
/** a big city of the current country other than the one the person lives in; null when there is none (city-states) */
function otherCity(f, X, pool = 4) {
  const here = hereCity(f, X);
  const list = CITIES[f.iso] || [];
  const big = bigCity(f);
  if (big !== here) return big;
  const tops = list.slice(0, pool).filter((c) => c !== here);
  return tops.length ? tops[hashString(`${f.state.id || ''}|${f.iso}|other`) % tops.length] : null;
}
/**
 * A person with a partner or children who moves away: does the family come along?
 * Returns null for someone without a family to take, else {alone, together, behind, home} text fragments
 * (together: "和{partner}带着孩子"; behind: "{partner}和孩子留在了家里").
 */
function familyMove(f, X, alonePref = 0.4) {
  const kids = f.kids.some((k) => k.age < 18);
  if (!f.couple && !kids) return null;
  // a partner already left behind earlier stays behind; children never travel alone with nobody
  const alone = f.couple ? X.rng.chance(clampN(alonePref, 0, 1)) : false;
  const who = f.couple ? (kids ? '{partner}和孩子' : '{partner}') : '孩子';
  return {
    alone,
    who,
    together: f.couple ? (kids ? '和{partner}带着孩子' : '和{partner}一起') : '带着孩子',
    behind: `${who}留在了家里`,
    we: '你们',
  };
}

/* ------------------------------------------------------------------ university odds */

const logit = (p) => Math.log(p / (1 - p));
const sigm = (z) => 1 / (1 + Math.exp(-z));
/** share of a cohort aimed for relative to gross tertiary enrolment (which also counts older students and repeaters) */
const UNI_AIM = 0.88;
/** enrolled at university now (or in graduate school) */
const uniStudent = (f) => f.inSchool && (f.eduRank >= 5 || f.track === 'uni' || f.track === 'postgrad');
/**
 * A school leaver who could apply to university now: finishing secondary school (academic track), or out of school
 * with a completed secondary or vocational qualification, aged 16-25 and not yet a student or graduate.
 */
function canApply(f) {
  if (f.age < 16 || f.age > 25 || f.eduRank >= 5 || f.eduRank < 3 || uniStudent(f)) return false;
  if (f.inSchool) return f.eduRank === 3 && f.track !== 'vocational' && f.age >= 17;
  if (f.flags.droppedOut) return false;
  return f.eduRank === 4 || !!f.flags.secDone || !!f.flags.repeatYear || !!f.flags.examFail;
}
/** gross tertiary enrolment (0..1) of the country in the decision year, as published (data.series) */
function terShare(f, X) {
  const v = num(safe(() => X.data.series(f.iso, 'ter_enroll', f.year)), f.terEnroll, 25);
  return clampN(v / 100, 0.005, 1);
}
/**
 * Probability that this school leaver starts university this year. It is anchored on the country's tertiary enrolment
 * that year among those who finish secondary school, and shifted by family percentile, knowledge, city or countryside
 * and track, so that a cohort's share of graduates lands a little below the enrolment ratio.
 */
function uniOdds(f, X) {
  const ter = terShare(f, X);
  const sec = clampN(num(safe(() => X.data.series(f.iso, 'sec_enroll', f.year)), f.secEnroll, 60) / 100, 0.25, 1);
  // about 85% of a cohort with near-universal secondary enrolment reaches this decision as a possible applicant
  const base = clampN((UNI_AIM * ter) / (0.85 * sec), 0.01, 0.97);
  // a typical secondary graduate's knowledge in a country with near-universal schooling is about 80, lower elsewhere
  const kRef = 58 + 22 * sec;
  let z = logit(base) + 2.2 * (f.fam - 0.5) + clampN((f.know - kRef) * 0.035, -0.7, 0.7) + (f.u ? 0.12 : -0.2);
  // vocational graduates go on less often, except where tertiary education is near universal (colleges take them)
  if (!f.inSchool) z -= f.eduRank === 4 ? 0.3 + 0.7 * (1 - ter) : 0.35;
  if (f.flags.olympiad) z += 0.4;
  if (f.flags.diligent) z += 0.15;
  if (f.fe && f.femaleLfp < 30) z -= 0.4;
  if (f.age >= 21) z -= 0.3;
  // someone who already left school without a university place (decided at the end of school) seldom applies later
  if (!f.inSchool && f.age >= 19 && isNum(num(f.flags.leftSchool))) z -= 0.9;
  // the result of the school-leaving exam just sat
  const ex = leavingExam(f);
  if (ex) z += { top: 0.5, good: 0.25, pass: 0, fail: -0.35 }[ex.result] || 0;
  return clampN(sigm(z), 0.01, 0.97);
}
/** the school-leaving exam sat in the last year (engine examCheck), if any: {name, result, score?} */
function leavingExam(f) {
  const ex = (f.state && f.state.person && f.state.person.education && Array.isArray(f.state.person.education.exams) ? f.state.person.education.exams : [])
    .filter((x) => x && x.age >= 17 && x.age >= f.age - 1);
  return ex.length ? ex[ex.length - 1] : null;
}
/** the odds split into the wish to apply and the chance that an application succeeds (wish x admit = odds) */
const uniAdmit = (f, X) => Math.pow(uniOdds(f, X), 0.4);
const uniWish = (f, X) => Math.pow(uniOdds(f, X), 0.6);
/** how readily a 15-year-old picks the vocational track: rarer where nearly everyone goes on to tertiary education */
const vocTrackWeight = (f, X, w) => w * clampN(1.6 - 1.2 * terShare(f, X), 0.4, 1);
/** autoChoose weight for university options so that they are picked with probability `wish` against `others` */
const wishWeight = (wish, others) => (clampN(wish, 0.03, 0.97) / (1 - clampN(wish, 0.03, 0.97))) * Math.max(0.2, others);

/* ------------------------------------------------------------------ feasibility */

/** spendable resources in intl $ (family help counts for young people) */
function resources(f) {
  const own = Math.max(0, f.cash + 0.6 * f.portfolio - 0.5 * f.debt);
  const fam = f.age < 27 ? f.famIncome * f.fam * (f.famRich ? 1.2 : 0.5) : 0;
  return own + fam;
}
const MIG_COST = { HIC: 9000, UMC: 3500, LMC: 1300, LIC: 700 };
const REGION_DEST = {
  EAS: ['USA', 'JPN', 'AUS', 'CAN', 'SGP', 'KOR'], SEA: ['SGP', 'MYS', 'JPN', 'AUS', 'USA', 'ARE'],
  SAS: ['ARE', 'SAU', 'GBR', 'USA', 'CAN', 'QAT'], CAS: ['RUS', 'KAZ', 'TUR', 'KOR', 'DEU'],
  WAS: ['DEU', 'TUR', 'USA', 'ARE', 'GBR'], NAF: ['FRA', 'ESP', 'ITA', 'DEU', 'SAU'],
  SSA: ['ZAF', 'GBR', 'USA', 'FRA', 'ARE'], EEU: ['DEU', 'POL', 'CZE', 'GBR', 'ITA'],
  WEU: ['GBR', 'DEU', 'USA', 'CHE', 'AUS', 'ESP'], NAM: ['CAN', 'GBR', 'MEX', 'AUS', 'DEU'],
  LAC: ['USA', 'ESP', 'CAN', 'ARG', 'CHL'], OCE: ['AUS', 'NZL', 'GBR', 'USA'],
};
function destGroup(X, f, iso) { return safe(() => X.data.incomeGroup(iso, f.year)) || safe(() => X.data.countries[iso].income_now) || 'UMC'; }

/** candidate destinations for a mode ('study'|'skilled'|'labor'|'family'|'refugee') */
function destinations(f, X, mode) {
  const has = (iso) => !!safe(() => X.data.country(iso)) || !!safe(() => X.data.countries[iso]);
  const lp = f.lp || {};
  let list = Array.isArray(lp.common_destinations) ? lp.common_destinations.slice() : [];
  if (mode === 'labor' && (f.sas || f.sea || f.naf || f.ssa || f.was)) list = ['ARE', 'SAU', 'QAT', 'KWT', 'OMN', 'MYS', ...list];
  if (mode === 'refugee') {
    const reg = f.reg;
    const near = (X.data.isoList || Object.keys(X.data.countries || {}))
      .filter((iso) => iso !== f.iso && safe(() => X.data.countries[iso].region) === reg)
      .sort((a, b) => popOf(X.data, b, f.year) - popOf(X.data, a, f.year)).slice(0, 5);
    list = [...near, ...list];
  }
  list = list.concat(REGION_DEST[f.reg] || REGION_DEST.WEU);
  const seen = new Set();
  // the Gulf monarchies take labour migrants, not refugees (no asylum system)
  return list.filter((iso) => typeof iso === 'string' && iso !== f.iso && iso !== f.origin && has(iso) && !(mode === 'refugee' && GULF.has(iso)) && !seen.has(iso) && seen.add(iso));
}
function pickDest(f, X, mode, exclude = []) {
  // nobody is offered a job in, or flees towards, a country at war
  const list = destinations(f, X, mode).filter((d) => !exclude.includes(d) && !destAtWar(X, d, f.year));
  if (!list.length) return null;
  return X.rng.weighted(list, (_, i) => 1 / (1 + i * 0.6)) || list[0];
}
/** {p, cost, affordable, ok, group, common, why} */
function migrationCheck(f, X, dest, mode) {
  const g = destGroup(X, f, dest);
  let cost = MIG_COST[g] || 3000;
  if (mode === 'study') cost *= 2.5;
  if (mode === 'retire') cost *= 2;
  if (mode === 'labor') cost *= 0.6;
  if (mode === 'refugee') cost *= 0.35;
  const res = resources(f);
  const lp = f.lp || {};
  const common = Array.isArray(lp.common_destinations) && lp.common_destinations.includes(dest);
  let p = 0.22 + 0.06 * f.eduRank + (f.know - 50) / 220 + (common ? 0.12 : -0.04) + Math.min(0.22, Math.log10(1 + res / cost) * 0.3);
  if (f.flags.lang) p += 0.06;
  if (mode === 'labor') p += 0.15;
  if (mode === 'study') p += (f.know - 60) / 120;
  if (mode === 'family') p += 0.2;
  if (mode === 'retire') p += 0.15;
  if (mode === 'refugee') p = f.war || f.displaced ? 0.6 : 0.15;
  if (g === 'HIC' && f.eduRank < 4 && mode !== 'labor' && mode !== 'refugee' && mode !== 'family') p -= 0.15;
  if (f.age >= 60) p -= 0.15;
  if (f.proj && f.geoL === 'high' && mode !== 'refugee') p -= 0.08;
  let why = '';
  if (f.age < 16) { p = 0; why = 'young'; }
  if (f.age < 20 && f.famPoor && mode !== 'refugee') { p = Math.min(p, 0.03); why = why || 'poor'; }
  p = clampN(p, 0, 0.92);
  const affordable = mode === 'refugee' || res >= cost * (mode === 'labor' ? 0.25 : 0.6);
  if (!affordable) why = why || 'money';
  return { p, cost, affordable, ok: affordable && p >= 0.1, group: g, common, why };
}
/** the destination is the main party of a serious armed conflict this year: nobody moves there for work or a holiday */
function destAtWar(X, iso, year) {
  const evs = safe(() => (X.world && typeof X.world.events === 'function' ? X.world.events(iso, year) : []), []) || [];
  return evs.some((e) => e && (e.category === 'war' || e.category === 'conflict') && num(e.effects && e.effects.safety, -2) <= -2 && Array.isArray(e.countries) && e.countries[0] === iso);
}
/** rich countries whose public universities charge no or only nominal fees (student aid covers living costs) */
const FREE_TUITION = new Set(['DEU', 'AUT', 'NOR', 'SWE', 'FIN', 'DNK', 'ISL', 'CZE', 'SVK', 'SVN', 'POL', 'EST', 'LTU', 'GRC', 'FRA', 'BEL', 'LUX', 'CHE', 'IRL']);
function tuitionHard(f) {
  if (f.famRich) return false;
  if (FREE_TUITION.has(f.iso) && !f.poorC) return false;
  if (['USA', 'GBR', 'AUS', 'CAN', 'NZL', 'KOR', 'JPN', 'CHL'].includes(f.iso)) return f.fam < 0.6;
  return f.poorC ? f.fam < 0.4 : f.fam < 0.2;
}
function examTier(f, rng, boost = 0) {
  const s = f.know + rng.normal(0, 11) + boost + (f.flags.diligent ? 4 : 0) + (f.flags.olympiad ? 5 : 0) + (f.u ? 2 : -2);
  return s >= 78 ? 'top' : s >= 60 ? 'good' : s >= 46 ? 'pass' : 'fail';
}
/** retirement age from the life path (handles strings like "60→63 渐进") plus world-line add-on after 2026 */
function retirementAge(f, X) {
  const list = Array.isArray(f.lp && f.lp.retirement_age) ? f.lp.retirement_age : [];
  let entry = null;
  for (const e of list) if (e && num(e.from, 0) <= f.year) entry = e;
  let v = entry ? entry[f.sex] : null;
  let age = null;
  if (isNum(v)) age = v;
  else if (typeof v === 'string') {
    const head = v.replace(/[（(][^）)]*[）)]/g, '');
    const ns = (head.match(/\d{2}/g) || []).map(Number).filter((x) => x >= 40 && x <= 75);
    if (ns.length) age = /→|->|至|渐进/.test(head) && f.year >= 2032 ? Math.max(...ns) : ns[0];
  }
  if (!isNum(age)) age = f.hic ? 65 : f.umc ? 60 : 60;
  const add = f.year > 2026 ? num(safe(() => X.world.modifiers(f.iso, f.year).retirement_age_add), 0) : 0;
  return Math.round(age + add);
}

/* ------------------------------------------------------------------ jobs and fields */

const FIELDS = {
  medicine: { label: '临床医学', short: '医学', years: 5, job: '医生', sector: '医疗', pct: 0.8, need: 68 },
  nursing: { label: '护理学', short: '护理', years: 3, job: '护士', sector: '医疗', pct: 0.56, need: 45 },
  cs: { label: '计算机科学', short: '计算机', years: 4, job: '软件工程师', sector: '信息技术', pct: 0.74, need: 60 },
  ai: { label: '人工智能', short: 'AI', years: 4, job: 'AI 工程师', sector: '信息技术', pct: 0.78, need: 66 },
  engineering: { label: '工程', short: '工科', years: 4, job: '工程师', sector: '工程制造', pct: 0.66, need: 57 },
  business: { label: '经济与管理', short: '商科', years: 4, job: '职员', sector: '金融商业', pct: 0.62, need: 52 },
  law: { label: '法学', short: '法学', years: 4, job: '律师助理', sector: '法律', pct: 0.64, need: 62 },
  education: { label: '师范教育', short: '师范', years: 4, job: '教师', sector: '教育', pct: 0.55, need: 50 },
  humanities: { label: '文史哲', short: '文科', years: 4, job: '编辑', sector: '文化', pct: 0.48, need: 50 },
  arts: { label: '艺术设计', short: '艺术', years: 4, job: '设计师', sector: '创意产业', pct: 0.5, need: 45 },
  agriculture: { label: '农学', short: '农学', years: 4, job: '农业技术员', sector: '农业', pct: 0.45, need: 42 },
};
function tradesFor(f) {
  const t = ['电工', '汽车维修', '护理', '厨师', '数控加工', '美容美发'];
  if (f.year >= 2015) t.push('电子商务');
  if (f.year >= 2022) t.push('新能源设备维护');
  if (f.year >= 2030) t.push('机器人运维');
  if (f.r) t.push('农机维修');
  return t;
}
const TRADE_SECTOR = { 电工: '建筑与维修', 汽车维修: '维修服务', 护理: '医疗', 厨师: '餐饮', 数控加工: '制造业', 美容美发: '服务业', 电子商务: '平台服务', 新能源设备维护: '能源', 机器人运维: '制造业', 农机维修: '农业' };
/** what someone who learned a trade is called at work, and the trade's typical income percentile */
const TRADE_JOB = { 电工: ['电工', 0.4], 汽车维修: ['汽修师傅', 0.38], 护理: ['护理员', 0.3], 厨师: ['厨师', 0.33], 数控加工: ['数控技工', 0.4], 美容美发: ['美发师', 0.3], 电子商务: ['电商运营', 0.4], 新能源设备维护: ['新能源运维技工', 0.45], 机器人运维: ['机器人运维技工', 0.48], 农机维修: ['农机修理工', 0.32] };
function tradeJob(trade) {
  const t = TRADE_JOB[trade];
  return { title: t ? t[0] : `${trade}技工`, sector: TRADE_SECTOR[trade] || '技术服务', pct: t ? t[1] : 0.38 };
}

/* ------------------------------------------------------------------ pay of a new job */

// Typical income percentile of a job within its country (the engine's job table uses the same scale). When a
// resolution gives the person a new occupation it sets a percentile for that job, nudged by knowledge and family
// background, carrying over a little of the previous pay (experience) instead of keeping the old percentile.
const JOB_PCT = {
  农民: 0.14, 帮工: 0.1, 学徒: 0.16, 临时工: 0.12, 摊贩: 0.16, 搬运工: 0.15, 家政工: 0.15, 护工: 0.24, 护理员: 0.28,
  工人: 0.24, 工厂工人: 0.25, 建筑工人: 0.22, 仓库工人: 0.24, 餐馆服务员: 0.22, 店员: 0.28, 外卖骑手: 0.3, 快递员: 0.3,
  网约车司机: 0.33, 出租车司机: 0.32, 士兵: 0.24, 技术兵: 0.3, 社会服务人员: 0.15, 职员: 0.55, 公务员: 0.62,
  研究员: 0.7, 程序员: 0.64, 'AI 应用工程师': 0.7, 技术员: 0.45, 设计师: 0.5, 教师: 0.55, 培训老师: 0.4, 修理工: 0.32,
  地面支持工程师: 0.68, 职业运动员: 0.6, 医药公司职员: 0.62,
};
for (const F of Object.values(FIELDS)) if (!(F.job in JOB_PCT)) JOB_PCT[F.job] = F.pct;
for (const [t, b] of Object.values(TRADE_JOB)) if (!(t in JOB_PCT)) JOB_PCT[t] = b;
/** income percentile for a new job titled `title` (base: the job's typical percentile; carry: share of old pay kept) */
function jobPct(f, title, base, carry = 0.2) {
  const b = num(base, JOB_PCT[title], 0.4);
  const prev = f.working ? clampN(f.incomePct, 0.02, 0.98) : b;
  return setPct(b * (1 - carry) + prev * carry + clampN((f.know - 65) / 400, -0.06, 0.06) + (f.fam - 0.5) * 0.06);
}
function basicJob(f) {
  if (f.farmer && f.r) return { title: '农民', sector: '农业' };
  if (f.eduRank >= 5) return { title: '职员', sector: f.field ? '专业服务' : '服务业' };
  if (f.u) return f.year >= 2016 && f.mobilePay ? { title: '店员', sector: '零售' } : { title: '工人', sector: '制造业' };
  return { title: '帮工', sector: '农业' };
}
function migrantJob(f, mode, g, dest) {
  if (mode === 'labor') return GULF.has(dest) ? { title: f.fe ? '家政工' : '建筑工人', sector: f.fe ? '家政服务' : '建筑业', pct: 0.2 } : { title: f.fe ? '护工' : '工厂工人', sector: f.fe ? '护理' : '制造业', pct: 0.2 };
  if (f.eduRank >= 5) return { title: f.title && f.title !== 'null' ? f.title : '工程师', sector: f.sector || '专业服务', pct: g === 'HIC' ? 0.42 : 0.58 };
  return { title: f.fe ? '护工' : '仓库工人', sector: '服务业', pct: 0.22 };
}
const ALT_SERVICE = new Set(['AUT', 'CHE', 'FIN', 'DEU', 'GRC', 'NOR', 'SWE', 'DNK', 'EST', 'LTU', 'LVA', 'CYP', 'TWN']);
const altServiceOk = (f) => ALT_SERVICE.has(f.iso) || (f.iso === 'KOR' && f.year >= 2020);

/* ------------------------------------------------------------------ intent lexicon (free text) */

// Each intent: id, act (resolver), kw (Chinese/English keywords, longest wins), p (params), neg (intent used when negated).
const INTENTS = [
  { id: 'study', act: 'study_more', neg: 'drop_out', kw: ['继续读书', '读书', '上学', '学习', '深造', '进修', '读大学', '考大学', '上大学', '复习', '念书', '报考', '自考', '夜校', '网课', 'MBA', '拿学位', '考证书', '考证', 'study'] },
  { id: 'grad', act: 'grad_school', neg: 'drop_out', kw: ['考研', '读研', '读博', '考博', '读硕士', '研究生', '硕士', '博士'] },
  { id: 'drop_out', act: 'drop_out_work', kw: ['退学', '辍学', '不读了', '不上学', '休学', '不念了'] },
  { id: 'change_major', act: 'change_major', boost: 3, kw: ['转专业', '换专业', '改专业', '换个专业', '转系'] },
  { id: 'study_abroad', act: 'emigrate', p: { mode: 'study' }, boost: 3, kw: ['出国留学', '留学', '出国读书', '出国念书', '国外读书', '交换生', '去国外读'] },
  { id: 'labor_abroad', act: 'emigrate', p: { mode: 'labor' }, boost: 2, kw: ['出国打工', '劳务输出', '海外务工', '去中东打工', '出国务工', '外派'] },
  { id: 'emigrate', act: 'emigrate', neg: 'stay', kw: ['移民', '出国', '去国外', '定居国外', '移居', '海外生活', '绿卡', '拿身份', '永居', '入籍', 'emigrate'] },
  { id: 'move_city', act: 'migrate_city', neg: 'stay', kw: ['进城', '去城里', '大城市', '搬到城里', '北漂', '沪漂', '深漂', '外出打工', '打工', '去省城', '换个城市', '去首都', '搬家', '搬去', '搬到', '定居', '闯一闯', '去外地', '离开这个家', '离家出走', '离开家'] },
  { id: 'return_home', act: 'return_home', neg: 'stay', kw: ['回老家', '回乡', '返乡', '回家乡', '回国', '落叶归根', '回到故乡', '回村', '回故乡'] },
  { id: 'job_hunt', act: 'job_switch', neg: 'quit_job', kw: ['找工作', '求职', '换工作', '跳槽', '投简历', '应聘', '找份工作', '找个工作', '面试', '找活干', '上班', '新工作'] },
  { id: 'career_change', act: 'career_switch', kw: ['转行', '换行业', '换个行业', '改行'] },
  { id: 'quit_job', act: 'quit_job', neg: 'stay', kw: ['辞职', '裸辞', '不干了', '离职', '辞掉工作', '炒老板', '不想上班', '不想工作', '不工作了', '辞工', 'quit'] },
  { id: 'gig', act: 'gig', kw: ['送外卖', '跑外卖', '外卖骑手', '开网约车', '跑滴滴', '开出租', '打零工', '零工', '送快递', '快递员', '日结'] },
  { id: 'civil_service', act: 'civil_service', kw: ['考公', '公务员', '编制', '事业单位', '考编', '进国企'] },
  { id: 'start_business', act: 'start_business', neg: 'stay', kw: ['创业', '开店', '做生意', '开公司', '开餐馆', '开饭店', '开饭馆', '摆摊', '做买卖', '当老板', '开工厂', '开网店', '开咖啡馆', '开一家', 'startup'] },
  { id: 'promotion', act: 'promotion_push', kw: ['升职', '加薪', '晋升', '拼事业', '努力工作', '加班', '奋斗', '当领导'] },
  { id: 'side_hustle', act: 'side_hustle', kw: ['副业', '兼职', '接私活', '做直播', '直播带货', '自媒体', '做博主', '当网红', '网上卖', '卖东西', '带货', '摆地摊'] },
  { id: 'learn_ai', act: 'retrain_ai', kw: ['人工智能', '学ai', '学 ai', '编程', '写代码', '程序员', '学计算机', '数据分析', '机器学习', '大模型', '码农', 'python', 'ai', 'coding'] },
  { id: 'learn_trade', act: 'learn_trade', kw: ['学手艺', '学技术', '技校', '学徒', '学厨师', '学电工', '学汽修', '学修车', '职业培训', '技能培训', '学理发', '学裁缝', '拜师'] },
  { id: 'learn_language', act: 'learn_language', kw: ['学英语', '学外语', '学日语', '学韩语', '学法语', '学德语', '学西班牙语', '学中文', '雅思', '托福', '学语言'] },
  { id: 'medicine', act: 'uni', p: { field: 'medicine' }, kw: ['学医', '当医生', '医学院', '考医学', '读医', '做医生', '成为医生'] },
  { id: 'nursing', act: 'uni', p: { field: 'nursing' }, kw: ['当护士', '学护理', '做护士'] },
  { id: 'teach', act: 'career_switch', p: { to: 'teacher' }, kw: ['当老师', '教书', '支教', '做教师', '当教师', '做老师', '成为老师'] },
  { id: 'farming', act: 'farming', kw: ['种地', '务农', '种田', '养殖', '养猪', '养鸡', '养牛', '养羊', '种果树', '开农场', '放牧', '种菜', '承包土地'] },
  { id: 'military', act: 'military', neg: 'avoid_military', p: { voluntary: true }, kw: ['参军', '当兵', '入伍', '服兵役', '从军', '考军校', '打仗', '上战场', '上前线'] },
  { id: 'avoid_military', act: 'alt_service', kw: ['替代役', '缓役', '社会服务役', '拒服兵役', '逃避兵役'] },
  { id: 'date', act: 'seek_partner', neg: 'stay_single', kw: ['谈恋爱', '恋爱', '表白', '找对象', '相亲', '约会', '追求', '脱单', '交友软件', '找女朋友', '找男朋友', '喜欢上'] },
  { id: 'marry', act: 'marry', neg: 'stay_single', kw: ['结婚', '求婚', '娶', '嫁给', '成家', '领证', '办婚礼', 'marry'] },
  { id: 'stay_single', act: 'stay_single', kw: ['单身', '不婚', '一个人过', '独身'] },
  { id: 'breakup', act: 'breakup', kw: ['分手', '断了联系', '不再见面'] },
  { id: 'divorce', act: 'divorce', neg: 'reconcile', kw: ['离婚', '分居'] },
  { id: 'reconcile', act: 'reconcile', kw: ['和好', '道歉', '和解', '原谅', '复合', '修复关系', '重归于好', '挽回', '冰释前嫌'] },
  { id: 'have_child', act: 'have_child', neg: 'childfree', kw: ['生孩子', '要孩子', '要个孩子', '生个孩子', '二胎', '三胎', '备孕', '怀孕', '生娃', '当爸爸', '当妈妈', '生宝宝'] },
  { id: 'childfree', act: 'childfree', boost: 2, kw: ['丁克', '不要孩子', '不生孩子'] },
  { id: 'adopt', act: 'adopt', boost: 2, kw: ['领养', '收养'] },
  { id: 'family_time', act: 'family_time', kw: ['陪孩子', '陪家人', '陪老婆', '陪老公', '陪伴家人', '多陪', '回家吃饭', '陪伴孩子', '写作业', '辅导孩子', '辅导作业', '接送孩子', '陪娃', '带孩子', '做家务', '全家福', '陪伴'] },
  { id: 'kid_abroad', act: 'kid_abroad', kw: ['送孩子出国', '送孩子留学'] },
  { id: 'kid_tutor', act: 'kid_tutor', kw: ['给孩子报班', '给孩子请家教'] },
  { id: 'care_parents', act: 'care_parents', kw: ['照顾父母', '照顾爸妈', '照顾母亲', '照顾父亲', '照顾妈妈', '照顾爸爸', '陪父母', '孝顺', '接父母', '赡养', '照顾老人', '陪爸妈', '陪伴父母', '看望父母', '回家看看', '陪妈妈', '陪爸爸', '给妈妈', '给爸爸', '给父母', '孝敬'] },
  { id: 'exercise', act: 'exercise', neg: 'ignore_health', kw: ['锻炼', '跑步', '健身', '运动', '马拉松', '游泳', '瑜伽', '打球', '爬山', '骑行', '散步', '打太极', '跳舞', 'gym'] },
  { id: 'quit_smoking', act: 'quit_smoking', kw: ['戒烟', '戒酒', '少喝酒', '不抽烟', '不喝酒', '戒掉', '少抽烟'] },
  { id: 'smoke', act: 'ignore_health', neg: 'quit_smoking', kw: ['抽烟', '吸烟', '酗酒', '借酒消愁', '熬夜'] },
  { id: 'diet', act: 'diet', kw: ['减肥', '节食', '吃素', '健康饮食', '少吃', '控糖', '少油', '少盐'] },
  { id: 'screen', act: 'diet', p: { kind: 'screen' }, kw: ['戒掉手机', '戒手机', '少玩手机', '少刷手机', '放下手机', '戒网', '戒游戏', '少打游戏', '少刷短视频', '戒短视频'] },
  { id: 'sleep', act: 'diet', p: { kind: 'sleep' }, kw: ['早睡', '早起', '规律作息', '作息', '睡个好觉', '多睡', '不熬夜', '少熬夜', '别熬夜'] },
  { id: 'health_check', act: 'health_check', neg: 'ignore_health', kw: ['体检', '看病', '就医', '去医院', '检查身体', '看医生', '治病', '做手术', '吃药'] },
  { id: 'therapy', act: 'therapy', kw: ['心理咨询', '心理医生', '抑郁', '焦虑', '心理治疗', '倾诉', '压力太大', '失眠', '压力很大', '压力好大', '压力大', '睡不着', '心情不好', '情绪低落', '心累', '崩溃'] },
  { id: 'crisis', act: 'crisis_support', boost: 10, kw: ['自杀', '不想活', '轻生', '结束生命', '活不下去', '想死', '了结自己', '活着没意思', '活着没劲', '活着有什么意义', '撑不下去', '寻死', '想跳楼', '要跳楼', '去跳楼', '割腕', '一了百了', '离开这个世界'] },
  { id: 'faith', act: 'faith', kw: ['信仰', '宗教', '信教', '出家', '修行', '礼拜', '去教堂', '去寺庙', '清真寺', '念经', '祈祷', '受洗', '朝圣', '禅修', '信佛', '基督', '天主', '佛教', '道教', '伊斯兰', '教会', '皈依', '圣经', '古兰经', '拜佛', '烧香'] },
  { id: 'volunteer', act: 'volunteer', kw: ['志愿', '义工', '公益', '慈善', '捐款', '捐钱', '帮助别人', '回馈社会', '做好事', '捐赠'] },
  { id: 'activism', act: 'activism', kw: ['环保', '社会运动', '倡导', '请愿', '维权', '游行', '社区组织', '发声', '参政', '竞选', '从政', '保护动物'] },
  { id: 'travel', act: 'travel', neg: 'stay', kw: ['旅行', '旅游', '环游', '背包', '自驾', '看世界', '出去走走', '度假', '游玩', '去看看', '看海', '海边', '出去玩', '散散心', '看雪', '看极光', '露营', '徒步', '迪士尼', '游乐园', '动物园', 'travel'] },
  { id: 'rest', act: 'rest', kw: ['休息', '躺平', '休假', '间隔年', 'gap', '放空', '歇一歇', '慢下来', '休养', '好累', '太累', '歇歇', '缓一缓', '放个假', 'relax'] },
  { id: 'invest_stocks', act: 'invest_stocks', neg: 'save', kw: ['炒股', '股票', '基金', '理财', '指数', '投资', '定投', '美股', '标普', '纳斯达克', '纳指', 'etf', 'a股', '港股', '恒生', '沪深300', '梭哈', '全仓', '满仓', '短线', '买黄金', '国债', '债券', '道琼斯'] },
  { id: 'ai_money', act: 'ai_hustle', kw: ['ai赚钱', '用ai', '利用ai', '靠ai', '借助ai', 'ai副业', 'ai接单', 'ai绘画', 'ai画', 'ai写', 'ai做', 'ai视频', 'ai搞钱', 'ai变现', 'aigc', 'chatgpt', 'gpt', 'deepseek', '豆包', 'kimi', '通义', '文心一言', 'midjourney', '提示词'] },
  { id: 'invest_crypto', act: 'invest_crypto', neg: 'save', kw: ['比特币', '加密货币', '虚拟货币', '数字货币', '币圈', '挖矿', '以太坊', '炒币'] },
  { id: 'invest_property', act: 'invest_property', neg: 'save', kw: ['炒房', '投资房产', '买第二套房', '收租', '当房东', '投资房子'] },
  { id: 'buy_home', act: 'buy_home', neg: 'rent', kw: ['买房', '首付', '买套房', '房贷', '买个房子', '置业', '买学区房', '买房子', '大房子', '换房', '新房子'] },
  { id: 'rent', act: 'rent_invest', kw: ['租房', '不买房'] },
  { id: 'save', act: 'save', kw: ['存钱', '攒钱', '储蓄', '省钱', '节俭', '记账', '还债', '还贷', '节约', '存起来', '攒起来', '存银行', '存款', '还清', '还钱', '信用卡', '少花钱'] },
  { id: 'spend', act: 'spend', neg: 'save', kw: ['买车', '消费', '花钱', '奢侈', '享受生活', '犒劳自己', '买新衣服', '大吃一顿', '换车', '买新车', '买手机', '换手机', '购物', '逛街', '吃顿好的'] },
  { id: 'gamble', act: 'gamble', neg: 'save', kw: ['赌博', '赌钱', '赌场', '彩票', '博彩', '下注', '赌一把', '押注', '刮刮乐'] },
  { id: 'artist', act: 'art_career', p: { kind: 'artist' }, kw: ['画画', '画家', '艺术', '绘画', '摄影', '雕塑', '插画', '设计'] },
  { id: 'writer', act: 'art_career', p: { kind: 'writer' }, kw: ['写作', '写小说', '作家', '写书', '写诗', '编剧', '当记者', '出书', '写剧本'] },
  { id: 'musician', act: 'art_career', p: { kind: 'musician' }, kw: ['音乐', '乐队', '唱歌', '歌手', '弹吉他', '作曲', '钢琴', '说唱', '乐器', '写歌', '写首歌', '写一首歌'] },
  { id: 'athlete', act: 'athlete_career', kw: ['运动员', '职业球员', '踢球', '打职业', '奥运', '体育生', '电竞选手', '职业电竞', '电竞', '职业选手'] },
  { id: 'learn_hobby', act: 'learn_hobby', boost: 1, kw: ['学做', '学画', '学弹', '学跳', '学拉', '学吹', '学唱', '学摄影', '学书法', '学烹饪', '学开车', '学织', '学种', '学插花', '学茶艺', '学吉他', '学钢琴', '学乐器', '学游泳', '学下棋', '学围棋', '学瑜伽', '学魔术', '学滑雪', '学潜水', '学骑马', '考驾照', '学车'] },
  { id: 'retire_early', act: 'retire_early', boost: 3, kw: ['提前退休', '财务自由', 'fire', '早点退休'] },
  { id: 'retire', act: 'retire', neg: 'keep_working', kw: ['退休', '告老还乡', '安享晚年'] },
  { id: 'keep_working', act: 'keep_working', kw: ['继续工作', '返聘', '再干几年', '退而不休', '再就业'] },
  { id: 'grandkids', act: 'grandkids_care', kw: ['带孙子', '带孙女', '带孙辈', '带外孙', '含饴弄孙', '帮忙带孩子'] },
  { id: 'memoir', act: 'write_memoir', kw: ['回忆录', '自传', '写下一生', '记录人生', '口述历史', '写家史'] },
  { id: 'will', act: 'will', kw: ['遗嘱', '后事', '遗产', '安排身后'] },
  { id: 'nursing_home', act: 'nursing_home', kw: ['养老院', '护理院', '敬老院', '疗养院'] },
  { id: 'reunion', act: 'reunion', kw: ['老同学', '同学会', '同学聚会', '聚一聚', '老友', '老朋友', '老战友', '发小'] },
  { id: 'friends', act: 'friends', kw: ['交朋友', '聚会', '社交', '朋友'] },
  { id: 'pet', act: 'pet', neg: 'stay', kw: ['养狗', '养猫', '宠物', '养只', '养条'] },
  { id: 'longevity', act: 'longevity_treatment', kw: ['抗衰老', '延寿', '长生', '逆龄', '基因治疗', '返老还童'] },
  { id: 'space', act: 'space_trip', kw: ['太空', '火星', '月球', '宇航', '去外太空', '太空旅行'] },
  { id: 'illegal', act: 'illegal', kw: ['偷东西', '偷窃', '抢劫', '贩毒', '诈骗', '走私', '犯罪', '黑社会', '偷渡', '洗钱'] },
  { id: 'stay', act: 'stay_course', kw: ['维持现状', '保持现状', '按部就班', '顺其自然', '什么都不做', '坚持下去', '留下来', '不变', '随便', '都行', '无所谓', '听天由命', '本职工作', '踏实工作', '安心工作'] },
  { id: 'ignore_health', act: 'ignore_health', kw: ['不管身体', '不去医院'] },
];
/** study that leads to a degree (university, graduate school, an adult degree), not a short course */
const DEGREE_RE = /大学|深造|学位|学历|文凭|本科|专升本|自考|报考|读研|研究生|硕士|博士|继续读书|上学|念书|读书/;
/** pets, not children: 领养一只狗 / 养了两只猫 */
const PET_RE = /(?:领养|收养|养)(?:了)?(?:一|两|几)?(?:只|条|个)?(?:小)?(?:猫|狗|宠物|鱼|鸟|兔子|仓鼠|乌龟|鹦鹉)/;
/** 开一家咖啡馆 / 开个小饭馆 / 回老家开厂 */
const SHOP_RE = /开(?:一家|一间|一个|个|家|间)?[一-龥]{0,5}?(?:店|馆|铺|公司|工厂|厂|工作室|诊所|农场|民宿|超市)/;
/** wishes nobody can carry out in a life story */
const FANTASY_RE = /变成(?:一只|一条|一个)?(?:鸟|鱼|猫|狗|龙|神|超人)|穿越|回到过去|时光倒流|超能力|隐身|长出翅膀|会飞|永生|魔法|统治世界|当皇帝|外星人/;
/** 当一名医生 -> 当医生, 养两只猫 -> 养猫, 写一本小说 -> 写小说, 开一家店 -> 开店 (measure words between verb and object) */
function normalizeIntentText(low) {
  return low.replace(/\s+(?=[一-龥])|(?<=[一-龥])\s+/g, '')
    .replace(/成为/g, '当')
    .replace(/([写养当买开学做读考找换种拿])(?:一|两|几)?(?:本|部|篇|个|只|条|名|位|辆|门|份|套|台)(?=[一-龥a-z])/g, '$1');
}
/** a line with no recognisable meaning: keyboard mash, a repeated syllable, punctuation only */
function looksLikeNoise(text) {
  const s = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  if (s.length <= 1) return true;
  const cjk = s.match(/[一-龥]/g) || [];
  // the game speaks Chinese: Latin letters or digits that matched no English keyword are treated as noise
  if (!cjk.length) return true;
  return cjk.length === s.length && /^[啊哈呵嘿嗯哦呃额喔唉哎呀嘻噢哇呜嗷]+$/.test(s);
}
const INTENT_BY_ID = new Map(INTENTS.map((i) => [i.id, i]));
// everyday phrasings players type that the base keyword lists missed (found with tests/_intent_probe.mjs)
const EXTRA_KW = {
  study: ['复读', '再考一次', '考证', '考个证', '提升学历', '专升本', '自考', '多读书', '看书', '充电'],
  grad: ['读个博士', '读个硕士', '考博'],
  civil_service: ['体制内', '国企', '央企', '事业单位', '考编', '铁饭碗', '上岸', '进银行'],
  gig: ['开滴滴', '跑滴滴', '开网约车', '跑网约车', '开出租', '送快递', '跑快递', '跑腿'],
  move_city: ['进厂', '进工厂', '南下', '北漂', '沪漂', '深漂', '闯一闯', '闯荡', '去大城市'],
  job_hunt: ['找份工作', '找个工作', '找活干', '上班去'],
  career_change: ['换个活法', '换种活法', '重新开始', '从头再来'],
  date: ['追她', '追他', '追求', '喜欢的女生', '喜欢的男生', '喜欢的人', '约会', '脱单', '找对象', '找个对象'],
  marry: ['领证', '办婚礼', '成家'],
  care_parents: ['接过来住', '接爸妈', '接父母', '照顾妈妈', '照顾爸爸', '照顾老人', '孝顺', '尽孝', '给家里寄钱', '寄钱回家', '给爸妈钱', '赡养'],
  family_time: ['陪陪家人', '陪爸妈', '回家看看', '常回家'],
  promotion: ['谈工资', '谈薪', '谈条件', '涨工资', '要加薪', '提加薪'],
  quit_smoking: ['少喝点酒', '不喝酒', '少抽点烟', '不抽烟'],
  therapy: ['冥想', '正念', '调整心态', '看开点'],
  learn_trade: ['驾照', '学车', '挖掘机', '学厨师', '当厨师', '电工', '焊工', '美容美发', '月嫂', '修车', '学修'],
  stay: ['好好过日子', '走一步看一步', '随缘', '照旧', '过好眼前', '安安稳稳', '平平淡淡', '踏踏实实'],
  rest: ['再想想', '先缓缓', '冷静一下', '歇一歇'],
  exercise: ['游泳', '打球', '爬山', '骑车', '练瑜伽'],
  save: ['省钱', '少花钱', '理财'],
};
for (const [id, list] of Object.entries(EXTRA_KW)) {
  const it = INTENT_BY_ID.get(id);
  if (it) for (const k of list) if (!it.kw.includes(k)) it.kw.push(k);
}

/** Short Chinese name of each intent, used to tell the player how a free-text choice was understood. */
export const INTENT_LABELS = {
  study: '用功读书', grad: '读研深造', drop_out: '不再读书，去工作', change_major: '换专业', study_abroad: '出国留学', labor_abroad: '出国打工',
  emigrate: '移居国外', move_city: '去大城市闯荡', return_home: '回老家', job_hunt: '找工作/换工作', career_change: '转行', quit_job: '辞职',
  gig: '跑外卖/开网约车', civil_service: '考公务员/进体制', start_business: '创业开店', promotion: '争取升职加薪', side_hustle: '搞副业',
  learn_ai: '学编程和 AI 技能', ai_money: '用 AI 搞副业赚钱', learn_trade: '学一门手艺', learn_language: '学外语', medicine: '学医', nursing: '学护理', teach: '当老师',
  farming: '种地务农', military: '参军', avoid_military: '服替代役', date: '谈恋爱', marry: '结婚', stay_single: '保持单身', breakup: '分手',
  divorce: '离婚', reconcile: '和好', have_child: '要孩子', childfree: '不要孩子', adopt: '领养孩子', family_time: '多陪家人',
  kid_abroad: '送孩子出国读书', kid_tutor: '给孩子报班', care_parents: '照顾父母', exercise: '锻炼身体', quit_smoking: '戒烟戒酒',
  smoke: '抽烟喝酒', diet: '管住嘴', screen: '少玩手机', sleep: '规律作息', health_check: '去体检看病', therapy: '照顾好心理',
  crisis: '心里很难受', faith: '寻找信仰', volunteer: '做志愿者', activism: '投身公益倡导', travel: '出去旅行', rest: '休息一阵',
  invest_stocks: '买股票基金', invest_crypto: '买加密货币', invest_property: '投资房产', buy_home: '买房', rent: '租房', save: '存钱',
  spend: '花钱享受', gamble: '赌一把', artist: '走艺术的路', writer: '写作', musician: '玩音乐', athlete: '当运动员', learn_hobby: '学一样爱好',
  retire_early: '提前退休', retire: '退休', keep_working: '继续工作', grandkids: '帮忙带孙辈', memoir: '写回忆录', will: '立遗嘱',
  nursing_home: '住养老院', reunion: '见老同学', friends: '多交朋友', pet: '养宠物', longevity: '尝试延寿疗法', space: '去太空',
  illegal: '冒险做违法的事', stay: '维持现状', ignore_health: '不管身体',
};
// A negation counts only when it governs the keyword: 「我不想出国」「不要去打仗」「别再抽烟」, not 「没钱也要出国」.
const NEG_TAIL = /(?:不|没|别|勿)[太想要再会去能肯愿意用必打算准备有了]{0,3}$|(?:拒绝|放弃|停止)[一-龥]?$/;
const NOT_NEG = /不得不|不管|不论|不错|不久|不少|不如|要不|不然|不仅|不但/g;
function negatedAt(low, idx) {
  return NEG_TAIL.test(low.slice(Math.max(0, idx - 6), idx).replace(NOT_NEG, '，'));
}
const COUNTRY_ALIAS = {
  美利坚: 'USA', 美国: 'USA', 硅谷: 'USA', 纽约: 'USA', 加州: 'USA', 英格兰: 'GBR', 伦敦: 'GBR', 苏格兰: 'GBR', 澳洲: 'AUS', 悉尼: 'AUS',
  香港: 'HKG', 台湾: 'TWN', 澳门: 'MAC', 迪拜: 'ARE', 阿联酋: 'ARE', 沙特: 'SAU', 东京: 'JPN', 大阪: 'JPN', 首尔: 'KOR', 南韩: 'KOR',
  巴黎: 'FRA', 柏林: 'DEU', 欧洲: 'DEU', 北美: 'USA', 刚果: 'COD', 多米尼加: 'DOM', 波黑: 'BIH', 马其顿: 'MKD', 新西兰: 'NZL',
  中东: 'ARE', 卡塔尔: 'QAT', 俄国: 'RUS', 莫斯科: 'RUS', 温哥华: 'CAN', 多伦多: 'CAN', 曼谷: 'THA', 吉隆坡: 'MYS', 狮城: 'SGP',
};
/** Chinese provinces and cities players type as destinations ("去海南定居", "去西藏支教") beyond the CITIES list */
const CN_PLACES = ('海南 三亚 海口 云南 昆明 大理 丽江 西藏 拉萨 新疆 乌鲁木齐 内蒙古 呼和浩特 广西 南宁 桂林 广东 东莞 佛山 珠海 福建 厦门 福州 '
  + '浙江 宁波 温州 江苏 无锡 山东 青岛 济南 河南 河北 石家庄 山西 太原 陕西 甘肃 兰州 敦煌 青海 西宁 宁夏 银川 四川 贵州 贵阳 湖南 湖北 '
  + '江西 南昌 安徽 合肥 黄山 黑龙江 哈尔滨 吉林 长春 辽宁 沈阳 大连').split(' ');
let NAME_INDEX = null;
let NAME_INDEX_SRC = null;
function nameIndex(data) {
  const src = data && (data.countries || null);
  if (NAME_INDEX && NAME_INDEX_SRC === src) return NAME_INDEX;
  const list = [];
  if (src) for (const [iso, c] of Object.entries(src)) if (c && typeof c.name === 'string' && c.name.length >= 2) list.push([c.name.replace(/[（(].*$/, ''), iso, 'country']);
  for (const [k, iso] of Object.entries(COUNTRY_ALIAS)) list.push([k, iso, 'country']);
  for (const [iso, cities] of Object.entries(CITIES)) for (const c of cities) if (c.length >= 2) list.push([c, iso, 'city']);
  for (const c of CN_PLACES) list.push([c, 'CHN', 'city']);
  list.sort((a, b) => b[0].length - a[0].length);
  NAME_INDEX = list;
  NAME_INDEX_SRC = src;
  return list;
}

/**
 * Classify a free-text action (Chinese, a little English).
 * @returns {{intents: string[], targetCountry: string|null, targetCity: string|null, keywords: string[], negated: string[]}}
 */
export function classifyIntent(text, data) {
  const raw = String(text == null ? '' : text).slice(0, 400);
  const low = normalizeIntentText(raw.toLowerCase());
  const score = new Map();
  const keywords = [];
  const negated = [];
  const add = (id, v) => score.set(id, (score.get(id) || 0) + v);
  for (const it of INTENTS) {
    for (const kwRaw of it.kw) {
      // keywords go through the same normalisation as the text (换个城市 -> 换城市, 成为医生 -> 当医生)
      const kw = normalizeIntentText(kwRaw.toLowerCase());
      if (/^[a-z ]+$/.test(kw)) {
        const re = new RegExp(`(^|[^a-z])${kw.replace(/ /g, '\\s*')}([^a-z]|$)`);
        if (!re.test(low)) continue;
        score.set(it.id, (score.get(it.id) || 0) + kw.length + 1);
        keywords.push(kwRaw);
        continue;
      }
      let from = 0;
      let idx;
      while ((idx = low.indexOf(kw, from)) >= 0) {
        from = idx + kw.length;
        const isNeg = !/^不/.test(kw) && negatedAt(low, idx);
        const target = isNeg ? it.neg : it.id;
        if (isNeg) negated.push(it.id);
        if (target) score.set(target, (score.get(target) || 0) + kw.length + (isNeg ? 1 : 0));
        keywords.push(kwRaw);
        break;
      }
    }
    if (it.boost && score.has(it.id)) score.set(it.id, score.get(it.id) + it.boost);
  }
  // phrases the keyword list cannot see on its own
  const negBefore = (m) => !!m && negatedAt(low, m.index);
  const pet = PET_RE.exec(low);
  if (pet && !negBefore(pet)) { add('pet', 6); score.delete('adopt'); score.delete('farming'); }
  const shop = SHOP_RE.exec(low);
  if (shop && !/开(?:车|会|学|心|始|玩笑|家长会)/.test(shop[0])) {
    if (negBefore(shop)) add('stay', 3);
    else { add('start_business', 5); if (score.has('return_home')) score.set('return_home', Math.min(score.get('return_home'), 3)); }
  }
  // 「生意撑不下去了」 is about a business, not a life (other crisis words still count)
  if (score.has('crisis') && /(?:生意|公司|店|厂|项目|买卖|摊子)[一-龥，,]{0,3}撑不下去/.test(low)
    && !INTENT_BY_ID.get('crisis').kw.some((k) => k !== '撑不下去' && low.includes(k))) score.delete('crisis');
  // a boyfriend or girlfriend is not "making friends"; going back to the village to farm is farming
  if (score.has('friends') && /[男女]朋友/.test(low) && !/交朋友|聚会|社交|多交/.test(low)) score.delete('friends');
  if (score.has('farming') && score.has('return_home')) add('farming', 3);
  if (/照顾.{0,4}(?:妈|爸|父|母|老人|奶奶|爷爷|外婆|外公)/.test(low)) add('care_parents', 5);
  // earning with AI is a side business, not a course: 「利用AI赚钱」「学AI，接外包项目」
  if (/ai|人工智能|gpt|大模型/.test(low) && /赚|挣|收入|接单|变现|卖|收费|副业|外包|搞钱|接项目|生意|创收/.test(low)) {
    add('ai_money', 8 + (score.get('learn_ai') || 0) + (score.get('side_hustle') || 0));
  }
  if (score.has('ai_money')) { score.delete('learn_ai'); score.delete('side_hustle'); }
  // 「好好过日子」「随缘」 only decide a line that names nothing more specific (「不想离婚，想好好过日子」 is about the marriage)
  if (score.has('stay') && [...score.keys()].some((k) => k !== 'stay' && score.get(k) > 0)) score.delete('stay');
  // volunteering at a care home is not moving into one; homework is not a writing career
  if (score.has('volunteer') && score.has('nursing_home')) score.delete('nursing_home');
  if (score.has('family_time') && /写作业|辅导/.test(low)) score.delete('writer');
  // schooling for one's child: 「存钱给孩子上大学」「送孩子出国留学」「给孩子报补习班」
  if (/(?:给|为|让|供|送|帮)(?:孩子|儿子|女儿|娃|小孩)/.test(low) && (score.has('study') || score.has('study_abroad') || /补习|家教|报班/.test(low))) {
    const s = Math.max(score.get('study') || 0, score.get('study_abroad') || 0, 3);
    score.delete('study'); score.delete('study_abroad');
    if (/出国|留学/.test(low)) add('kid_abroad', s + 2);
    else if (/补习|家教|报班/.test(low)) add('kid_tutor', s + 2);
  }
  // destination detection (longest names first; a matched span is blanked so 中国 does not hit inside 中国台湾)
  let scan = raw;
  let targetCountry = null;
  let targetCity = null;
  for (const [nm, iso, kind] of nameIndex(data)) {
    const i = scan.indexOf(nm);
    if (i < 0) continue;
    if (kind === 'city' && !targetCity) targetCity = nm;
    if (!targetCountry) targetCountry = iso;
    scan = scan.slice(0, i) + '□'.repeat(nm.length) + scan.slice(i + nm.length);
    if (targetCountry && targetCity) break;
  }
  if (targetCountry && data && !safe(() => data.country(targetCountry)) && !safe(() => data.countries[targetCountry])) targetCountry = null;
  // a bare destination is a trip; living, working or studying there is a move
  if (targetCountry && !score.size) score.set(/住|定居|生活|工作|打工|搬|发展|读书|上学|移民|扎根|落户/.test(raw) ? 'emigrate' : 'travel', 1);
  // a named place plus a trip word is a trip, whoever comes along
  if (targetCountry && score.has('travel')) add('travel', 2);
  // ties go to the intent named first in the text ("回国照顾父母": the purpose and the move score alike)
  const firstAt = (id) => {
    const it = INTENT_BY_ID.get(id);
    let best = 1e9;
    for (const k of (it ? it.kw : [])) { const i = low.indexOf(k.toLowerCase()); if (i >= 0 && i < best) best = i; }
    return best;
  };
  const intents = [...score.entries()].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1] || firstAt(a[0]) - firstAt(b[0])).map((e) => e[0]);
  return { intents, targetCountry, targetCity, keywords: [...new Set(keywords)], negated: [...new Set(negated)] };
}

/* ------------------------------------------------------------------ concrete money plans written in the player's own words */

const MARKET_RES = [
  ['us_stocks', /美股|标普|标准普尔|s&p|spx|spy|voo|纳斯达克|纳指|qqq|道琼斯|道指|美国股/],
  ['cn_stocks', /a股|沪深|上证|深证|创业板|科创板|中证|沪深300|国内股市/],
  ['jp_stocks', /日股|日经|日本股/],
  ['in_stocks', /印度股|印度基金|nifty/],
  ['eu_stocks', /欧股|欧洲股|德国股|dax/],
  ['em_stocks', /港股|恒生|恒指|新兴市场/],
  ['world_stocks', /全球股|全世界股|msci|全球指数|全球基金/],
];
/**
 * The concrete investing plan in a line of text: which market and which style.
 * @returns {{market: string|null, style: 'dca'|'all_in'|'trader'|'gold'|'bonds', label: string}}
 */
export function investPlanOf(text) {
  const t = String(text || '').toLowerCase();
  const market = (MARKET_RES.find(([, re]) => re.test(t)) || [null])[0];
  const style = /黄金|金条|金币/.test(t) && !/股|基金|etf/.test(t) ? 'gold'
    : /国债|债券|债基/.test(t) && !/股/.test(t) ? 'bonds'
      : /梭哈|全仓|满仓|all ?in|全部(?:买|投|押)|所有(?:钱|积蓄)|杠杆|借钱(?:炒|买)/.test(t) ? 'all_in'
        : /短线|做t|日内|天天(?:看盘|盯盘)|盯盘|打板|追涨|波段|炒股|炒/.test(t) && !/定投|长期/.test(t) ? 'trader'
          : 'dca';
  const where = market === 'us_stocks' ? (/纳斯达克|纳指|qqq/.test(t) ? '美股（纳斯达克）' : /标普|标准普尔|s&p|spx|spy|voo/.test(t) ? '美股（标普500）' : '美股')
    : market ? MARKET_NAMES[market] : style === 'gold' || style === 'bonds' ? '' : style === 'trader' ? '股票' : '指数基金';
  const label = style === 'gold' ? '定期买黄金' : style === 'bonds' ? '买国债和债券基金'
    : style === 'all_in' ? `把积蓄几乎全部买入${where}` : style === 'trader' ? `炒${where}短线` : `长期定投${where}`;
  return { market, style, label, where };
}
const MARKET_NAMES = { us_stocks: '美股（标普500）', cn_stocks: 'A股', jp_stocks: '日股', in_stocks: '印度股市', eu_stocks: '欧洲股市', em_stocks: '港股和新兴市场', world_stocks: '全球股市' };

const AI_KINDS = [
  ['content', /自媒体|短视频|博主|公众号|小红书|抖音|快手|b站|视频号|直播|账号|up主|网红/, 'AI 做自媒体'],
  ['copy', /文案|写作|翻译|代写|写稿|写文章|论文|简历/, 'AI 写文案接单'],
  ['art', /画|绘|头像|插画|设计|海报|图片|壁纸|表情包/, 'AI 画图卖图'],
  ['app', /开发|小程序|app|应用|产品|网站|插件|工具|saas|智能体|agent/, '用 AI 做产品收费'],
  ['shop', /电商|带货|网店|淘宝|拼多多|亚马逊|跨境|闲鱼/, 'AI 辅助开网店'],
  ['teach', /卖课|课程|培训|教人|教别人|社群|知识付费/, '教别人用 AI'],
  ['freelance', /外包|接单|私活|项目|甲方/, 'AI 提速接外包'],
];
/** Which way of earning money with AI a line describes. */
export function aiKindOf(text) {
  const t = String(text || '').toLowerCase();
  const hit = AI_KINDS.find(([, re]) => re.test(t));
  return hit ? { kind: hit[0], label: hit[2] } : { kind: 'mixed', label: '用 AI 搞副业赚钱' };
}

/* ------------------------------------------------------------------ free text read against the decision at hand */

const CN_NUM = { 一: 0, 二: 1, 三: 2, 四: 3, 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
const OPT_REF_RE = /^(?:我)?(?:还是|就|决定)?(?:(?:选|选择|挑)(?:第)?|第)([一二三四1-4])(?:个|项|条|种|号)?|^([一二三四1-4])(?:个|项|号)?$|^(?:我)?(?:还是|就)?(?:选|选择)(?:项)?\s*([abcd])(?![a-z])|^([abcd])$/;
const AFFIRM_RE = /^(?:好|好的|行|可以|同意|答应|接受|愿意|要|去|去吧|我去|没问题|就这么办|冲|干了|试试|试一试|抓住|把握|ok|yes)/;
const DECLINE_RE = /^(?:不|别|算了|拒绝|不要|不去|不了|不行|不答应|不接受|还是不|婉拒|放弃|no)/;
const YES_OPT_RE = /接受|答应|同意|去|试|抓住|加入|报名|搬|走|买|结婚|生|读|留学|出国|创业|辞|换|闯/;
const NO_OPT_RE = /拒绝|不|留下|留在|算了|放弃|婉拒|维持|再等|观望|暂缓|按兵不动|保持|稳/;
const LISTEN_RE = /听(?:从)?(?:爸妈|父母|家里|家人|妈妈|爸爸|老师|朋友|伴侣|老婆|老公)(?:的)?(?:话|意见|安排)?/;

const squash = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return (2 * n) / (A.size + B.size);
}

/**
 * How the built-in engine reads a free-text choice, taking the decision's own options into account.
 * Pure; used by resolveOffline and by the UI to show "将理解为…" while the player types.
 * @returns {{kind:'option', optionId, label, how} | {kind:'intent', intents:string[], labels:string[], place:string|null}
 *          | {kind:'unclear'|'noise'|'fantasy'}}
 */
export function interpretCustom(text, decision, data, home = null) {
  const raw = String(text == null ? '' : text).slice(0, 400).trim();
  const t = squash(raw);
  const opts = (decision && Array.isArray(decision.options) ? decision.options : []).filter((o) => o && o.id && o.label);
  // one-character answers (「好」「C」) are only noise when there is no question to answer
  const answers = opts.length && (OPT_REF_RE.test(t) || (t.length <= 8 && (AFFIRM_RE.test(t) || DECLINE_RE.test(t))));
  if (!raw || (!answers && looksLikeNoise(raw))) return { kind: 'noise' };
  if (FANTASY_RE.test(raw)) return { kind: 'fantasy' };
  const ctx = decision && decision.context && typeof decision.context === 'object' ? decision.context : {};
  const actOf = (o) => (ctx.acts && ctx.acts[o.id] && (!ctx.labels || ctx.labels[o.id] === o.label) ? ctx.acts[o.id].act : null);
  const pickOpt = (o, how) => ({ kind: 'option', optionId: o.id, label: o.label, how });

  if (opts.length) {
    // 「选第二个」「B」「就第一个吧」
    const ref = OPT_REF_RE.exec(t);
    if (ref) {
      const i = CN_NUM[ref[1] || ref[2] || ref[3] || ref[4]];
      if (opts[i]) return pickOpt(opts[i], 'ref');
    }
    if (/^(?:我)?(?:选)?前者/.test(t)) return pickOpt(opts[0], 'ref');
    if (/^(?:我)?(?:选)?后者/.test(t) && opts.length === 2) return pickOpt(opts[1], 'ref');
    // the text names an option outright: 「接受这份工作」 contains 「接受」 … only when the option label is specific enough
    const named = opts.filter((o) => { const l = squash(o.label); return l.length >= 3 && t.includes(l); });
    if (named.length === 1) return pickOpt(named[0], 'named');
  }

  const c = classifyIntent(raw, data);
  if (c.intents.length) {
    // the intent matches what one of the options does: take the option (it carries this decision's details)
    const act = effectiveAct(c, home);
    if (opts.length && act) {
      const same = opts.filter((o) => actOf(o) === act);
      if (same.length === 1) return pickOpt(same[0], 'same');
    }
    const short = t.length <= 6;
    if (!(short && opts.length && c.intents[0] === 'stay' && (AFFIRM_RE.test(t) || DECLINE_RE.test(t)))) {
      const labels = c.intents.slice(0, 2).map((id) => (id === 'invest_stocks' ? investPlanOf(raw).label : id === 'ai_money' ? aiKindOf(raw).label : INTENT_LABELS[id] || id));
      if (act === 'emigrate' && c.intents[0] !== 'emigrate') labels[0] = /study|grad|learn_language/.test(c.intents[0]) ? '出国读书' : '去国外生活工作';
      if (act === 'migrate_city' && c.intents[0] !== 'move_city') labels[0] = `去${c.targetCity || '外地'}发展`;
      const place = c.targetCity || (c.targetCountry && data ? safe(() => data.country(c.targetCountry).name) : null) || null;
      return { kind: 'intent', intents: c.intents.slice(0, 3), labels, place };
    }
  }

  if (opts.length) {
    // short yes / no answers to the question: 「好」「答应他」「算了」「不去」
    if (t.length <= 8 && (AFFIRM_RE.test(t) || DECLINE_RE.test(t))) {
      const yes = !DECLINE_RE.test(t);
      const fit = opts.filter((o) => {
        const l = o.label;
        return yes ? YES_OPT_RE.test(l) && !NO_OPT_RE.test(l) : NO_OPT_RE.test(l);
      });
      if (fit.length) return pickOpt(fit[0], yes ? 'yes' : 'no');
    }
    // 「听爸妈的」: the option that mentions them
    const listen = LISTEN_RE.exec(t);
    if (listen) {
      const who = listen[0].replace(/^听(?:从)?|的.*$|话|意见|安排/g, '');
      const re = /爸妈|父母|家里|家人|妈妈|爸爸/.test(who) ? /父母|爸妈|家里|家人|母亲|父亲|妈|爸/ : new RegExp(who);
      const fit = opts.filter((o) => re.test(`${o.label}${o.detail || ''}`));
      if (fit.length === 1) return pickOpt(fit[0], 'listen');
    }
    // closest wording
    const sims = opts.map((o) => ({ o, s: Math.max(dice(t, squash(o.label)), dice(t, squash(`${o.label}${o.detail || ''}`)) * 0.9) }))
      .sort((a, b) => b.s - a.s);
    if (sims[0].s >= 0.34 && (!sims[1] || sims[0].s - sims[1].s >= 0.08)) return pickOpt(sims[0].o, 'similar');
  }
  return { kind: 'unclear' };
}

/** The action resolveCustom would run for these intents, destination included (home = the person's country). */
function effectiveAct(c, home) {
  const I = INTENT_BY_ID.get(c.intents[0]);
  if (!I) return null;
  let act = I.act;
  if (!c.targetCountry) return act;
  if (home && c.targetCountry === home) {
    if (act === 'emigrate') return 'migrate_city';
    if (c.targetCity && ['job_switch', 'work_now', 'gig'].includes(act)) return 'migrate_city';
    return act;
  }
  if (act === 'travel') return act;
  if (['study_more', 'uni', 'grad_school', 'learn_language', 'migrate_city', 'job_switch', 'accept_offer', 'move_city', 'stay_course', 'gig', 'work_now'].includes(act)) return 'emigrate';
  return act;
}

/** One line for the UI: how the built-in engine will read this text (null while there is nothing to say). */
export function interpretLine(it) {
  if (!it) return null;
  if (it.kind === 'option') return `会按选项「${it.label}」来推演，并记下你自己的话。`;
  if (it.kind === 'intent') return `会理解为：${it.labels.join(' + ')}${it.place ? `（${it.place}）` : ''}`;
  if (it.kind === 'fantasy') return '这个愿望现实里做不到，只会被记在日记里。';
  if (it.kind === 'unclear') return '还没看懂具体要做什么。写得具体一点会更准，比如「去深圳找工作」「和她结婚」「选第二个」。';
  return null;
}

/* ------------------------------------------------------------------ decision object helpers */

/** option spec: label (<=16), detail (1 sentence), risk, act, params, auto weight, ok (availability) */
function opt(label, detail, risk, act, p, w, ok = true) {
  return ok ? { label, detail, risk, act, p: p || {}, w: num(w, 1) } : null;
}
function makeDecision(f, X, spec, kind, at) {
  const year = at ? at.year : f.year;
  const age = at ? at.age : f.age;
  const opts = (spec.options || []).filter(Boolean);
  const fill = (s) => X.fill(s, spec.vars);
  const seen = new Set();
  const list = [];
  for (const o of opts) {
    const l = lab(fill(o.label));
    if (!l || seen.has(l)) continue;
    seen.add(l);
    list.push({ ...o, label: l });
    if (list.length === 4) break;
  }
  const fallbacks = [opt('顺其自然', '不刻意改变什么，先把眼前的日子过好。', 'low', 'stay_course'), opt('先停一停', '给自己一点时间想清楚再说。', 'low', 'rest')];
  for (const fb of fallbacks) if (list.length < 2 && !seen.has(fb.label)) list.push(fb);
  const options = list.map((o, i) => ({ id: OPT_IDS[i], label: o.label, detail: fill(o.detail), risk: ['low', 'mid', 'high'].includes(o.risk) ? o.risk : 'mid' }));
  // labels let the resolver notice when an AI rewrote an option under the same id (then its text decides, not the act)
  const context = { key: spec.key, acts: {}, auto: {}, labels: {} };
  if (spec.vars && typeof spec.vars === 'object') context.vars = { ...spec.vars };
  list.forEach((o, i) => { context.acts[OPT_IDS[i]] = { act: o.act, p: o.p || {} }; context.auto[OPT_IDS[i]] = Math.round(num(o.w, 1) * 1000) / 1000; context.labels[OPT_IDS[i]] = options[i].label; });
  return {
    id: `d-${spec.key}-${year}-${age}-${hashString(`${f.state.id || ''}|${spec.key}|${year}`).toString(36).slice(0, 5)}`,
    year, age, kind, title: fill(spec.title), situation: fill(spec.situation), options, allowCustom: true, source: 'local', context,
  };
}
/** a decision that a Thread raises later (CONTRACT §3 Thread.decision) */
function threadDecision(f, X, years, spec) {
  const d = makeDecision(f, X, spec, 'triggered', { year: f.year + years, age: f.age + years });
  return d;
}

/* ------------------------------------------------------------------ actions (option and intent resolvers) */

const A = Object.create(null);

// ---- childhood: families decide together with the child; effects are mostly on stats
A.child_books = (f, X, p = {}) => out(f, X, p.audit
  ? '你常常跑到学校的教室窗外，踮着脚听老师讲课，回家就用树枝在地上一笔一画地写。老师见你来得勤，干脆让你搬个小板凳坐在最后一排。'
  : f.poorC && f.r
    ? X.pick(['家里没有几本书，你就把亲戚家孩子用过的旧课本翻得卷了边，认字比同龄人快了一大截。', '你缠着大人教你认字，没多久就能把墙上的年画、日历一个字一个字地念出来。'])
    : X.pick(['你成了家里最爱翻书的孩子，常常抱着一本绘本就忘了吃饭。', '你缠着大人教你认字，没多久就能把路边的招牌一个字一个字地念出来。']),
[0, 2, 5, 0, 0], { set: { flags: { bookworm: true } }, threads: [th(f, X, 5, '爱读书的孩子', '从小养成的阅读习惯一直跟着你。老师在你的作文本上写了一句评语：“有自己的想法。”', [0, 2, 3, 1, 0])] });
A.child_play = (f, X, p = {}) => out(f, X, p.sport
  ? '你被送去学游泳和球类，每次下课都饿得能吃下两碗饭，个子也比同龄人蹿得快。'
  : X.pick(['你整天在外面跑跳，爬树、追鸡、跳房子，膝盖上的伤疤一个接一个，身体却结结实实。', '你是巷子里跑得最快的孩子，天黑了还要大人一遍遍喊才肯回家。']),
[5, 4, 0, 2, 0], { set: { flags: { active: true } }, threads: [th(f, X, 7, '跑出来的好身体', '小时候跑出来的好底子，让你在学校的运动会上总能拿到名次。', [3, 2, 0, 2, 0])] });
A.child_arts = (f, X) => {
  const poor = f.famPoor && (f.poorC || f.r);
  const prize = X.rng.chance(0.3);
  return out(f, X, poor ? '家里买不起颜料，你就用树枝在地上画、用木炭在墙上画，画得像模像样。' : '你开始学画画和唱歌，一有空就趴在桌上涂涂画画，家里的墙也没能幸免。',
    [0, 4, 2, 1, 0], { set: { flags: { artsy: true } }, threads: [th(f, X, 7, '童年的画笔', prize ? '你画的一幅画在比赛中获了奖，被挂在了学校的走廊上。' : '画画成了你的爱好，心烦的时候，拿起笔就能静下来。', prize ? [0, 4, 1, 1, 0] : [0, 2, 0, 0, 0])] });
};
A.child_social = (f, X) => out(f, X, X.pick(['你成了一群孩子的“孩子王”，谁家有好玩的都会来叫你。', '你交到了几个形影不离的小伙伴，你们约定长大了也要做朋友。']),
  [1, 4, 0, 5, 0], { set: { flags: { sociable: true } }, threads: [th(f, X, 14, '童年的朋友', '多年以后，一位童年的伙伴在你最需要帮忙的时候伸出了手。你们笑着说起小时候的约定。', [0, 3, 0, 4, 0])] });
A.child_chores = (f, X) => out(f, X, f.farmer || f.r ? '你跟着大人下地、放牛、拾柴，小小年纪就知道什么时候该播种、什么时候要防雨。' : '你帮着家里看店、做饭、照看更小的孩子，早早就学会了照顾别人。',
  [1, -1, 1, 3, 0], { set: { flags: { responsible: true } }, threads: [th(f, X, 12, '早熟的孩子', '小时候吃过的苦让你比同龄人更能扛事，遇到难处时，你总能想出办法。', [0, 1, 1, 2, 0])] });
A.child_care_sib = (f, X) => out(f, X, '你背着更小的孩子玩耍、喂饭、哄睡，大人们都说你像个小大人。', [0, -1, -1, 4, 0], { set: { flags: { responsible: true } } });
A.child_classes = (f, X) => {
  if (f.famPoor) return out(f, X, '家里拿不出上兴趣班的钱。你就跟着邻居家的哥哥姐姐学，学得慢一点，却一点也没落下。', [0, 1, 2, 1, 0], { feasible: false, note: '兴趣班费用超出家庭能力' });
  return out(f, X, `你的周末被各种兴趣班填满了：${f.english ? '外语' : '英语'}、数学、钢琴。你学会了很多，也常常羡慕在楼下疯玩的孩子。`, [-1, -2, 5, -1, 0], { set: { flags: { tutored: true } }, threads: [th(f, X, 6, '起跑线', '小时候的补习让你在升学考试中多了几分底气。', [0, 1, 3, 0, 0])] });
};
A.child_stay_grand = (f, X) => {
  const reunite = X.rng.chance(0.45 + f.fam * 0.3);
  return out(f, X, '你留在了{granny}身边。父母走的那天清晨，你追着车跑了很远，{granny}把你抱回来，往你手里塞了一颗糖。',
    [0, -4, 0, 1, 0], { set: { flags: { leftBehind: true, parentAway: true } }, threads: [th(f, X, 5, '父母回来的那一年', reunite ? '父母终于在城里站稳了脚跟，把你接到了身边。新学校里，你的口音让你紧张了好一阵子。' : '这些年你在{granny}身边长大，和父母的电话越来越短。你学会了自己拿主意，也学会了不说想念。', reunite ? [0, 4, 1, 2, 0] : [0, -2, 1, 1, 0], reunite ? { urban: true, flags: { leftBehind: false, city: bigCity(f) } } : null)] });
};
A.child_follow_parents = (f, X) => {
  if (f.fam < 0.25 && !X.rng.chance(0.35)) {
    return out(f, X, `城里的房租和学费太贵，父母最终还是把你留在了老家。临走前，${f.momAlive ? '母亲' : '父亲'}答应你每年都${f.chn ? '回来过年' : '回来看你'}。`, [0, -4, 0, 1, 0], { feasible: false, note: '随迁入学成本过高', set: { flags: { leftBehind: true, parentAway: true } } });
  }
  return out(f, X, f.chn ? '你跟着父母去了{bigcity}，住进了城中村的出租屋，在一所打工子弟学校上学。日子挤了点，但一家人在一起。' : '你跟着父母搬去了{bigcity}，一家人挤在一间小屋里。日子紧了点，但每天晚上都能一起吃饭。',
    [0, 2, 1, 3, 0], { set: { urban: true, flags: { city: bigCity(f), migrantChild: true } } });
};
A.child_parents_stay = (f, X) => out(f, X, '你抱着父母的腿不肯撒手。他们商量了一夜，决定先不走了，就在附近找点活干。家里的钱紧了些，可你每天都能见到他们。',
  [0, 4, 0, 4, 0], { set: { flags: { parentsStayed: true } } });

// ---- school years
function nextExam(f) {
  // each exam as it will be called in the year it is sat (exams are renamed and replaced over the decades)
  const ex = keyExams(f.lp, f.iso).filter((e) => e[0] > f.age && e[0] <= f.age + 6
    && keyExams(f.lp, f.iso, f.year + e[0] - f.age).some((g) => g[0] === e[0] && g[1] === e[1]) && !/硕士|研究生|公务员|资格/.test(e[1]));
  return ex.length ? ex[0] : null;
}
A.study_hard = (f, X, p = {}) => {
  if (uniStudent(f)) {
    return out(f, X, '你在大学里沉下心来：专业课认真听、实验报告认真写，课余还常泡在图书馆。期末的成绩单上，你的名字排在了前面。', [-1, 2, 5, 0, 0], { set: { flags: { diligent: true } } });
  }
  if (p.goal === 'key') {
    const ok = X.rng.chance(clampN(0.3 + (f.know - 50) / 80 + (f.fam - 0.5) * 0.2, 0.08, 0.85));
    return out(f, X, `为了考进重点中学，你每天比别人早起一个小时，周末也在做题。${ok ? '升学考试放榜，你如愿考进了重点中学，全家人高兴了好几天。' : '升学考试差了几分，你进了一所普通中学。可那段拼劲，你一直留着。'}`,
      ok ? [-1, 4, 5, 0, 0] : [-1, -2, 4, 0, 0], { set: { flags: { diligent: true, schoolTier: ok ? 'top' : 'pass' } } });
  }
  const ex = nextExam(f);
  const later = ex ? th(f, X, ex[0] - f.age, `${ex[1]}前的冲刺`, `${ex[1]}来了。这些年埋头苦读的底子，让你走进考场时心里有数。`, [0, 2, 3, 0, 0]) : th(f, X, 3, '厚积薄发', '这些年的苦读开始见到回报，你在班上的名次稳稳地排在前面。', [0, 2, 3, 0, 0]);
  return out(f, X, p.phone ? '你在手机上装了词典和网课，遇到不会的题就查一查、问一问。手机成了你的随身图书馆，成绩也一点点往上爬。'
    : X.pick(['你把心思都放在了学习上，每天最早到教室、最晚离开，错题本写满了好几本。', '你给自己定了严格的作息表，周末也泡在图书馆里，成绩一点点往上爬。']),
  [-2, -2, 6, -1, 0], { set: { flags: { diligent: true } }, threads: [later] });
};
A.compete = (f, X) => {
  const win = X.rng.chance(clampN(0.15 + (f.know - 55) / 60, 0.05, 0.8));
  return out(f, X, win ? '你报名参加了学科竞赛，熬了几个月的夜，最后捧回了一个奖。老师说，这可能会为你的升学加分。' : '你报名参加了学科竞赛，最后没拿到名次。可那几个月钻研难题的日子，让你学会了怎样啃硬骨头。',
    win ? [-1, 5, 6, 1, 0] : [-1, -1, 4, 0, 0], { set: win ? { flags: { olympiad: true } } : {} });
};
A.sports_track = (f, X) => {
  const good = X.rng.chance(clampN(0.15 + (f.health - 60) / 80, 0.05, 0.6));
  return out(f, X, '你加入了学校的运动队，每天清晨和傍晚都在操场上训练，汗水把球衣湿透了一件又一件。',
    [6, 3, -1, 3, 0], { set: { flags: { athlete: true } }, threads: [th(f, X, 3, '赛场', good ? '你在省级比赛中拿到了名次，有体育院校的教练来找你谈话。' : '你没能走上专业道路，但运动成了你一辈子的习惯。', good ? [2, 5, 0, 2, 0] : [2, 1, 0, 1, 0], good ? { flags: { athleteTalent: true } } : null)] });
};
A.arts_track = (f, X) => {
  const good = X.rng.chance(0.2 + (f.flags.artsy ? 0.15 : 0));
  return out(f, X, '你把课余时间都给了画室和琴房。手指磨出了茧，你却越来越清楚自己喜欢什么。',
    [0, 5, 2, 1, 0], { set: { flags: { artsy: true } }, threads: [th(f, X, 3, '艺考', good ? '你考进了一所艺术院校，第一次觉得自己的爱好被认真对待。' : '你没有走专业的路，但每当心里有事，你还是会坐到琴前或画板前。', good ? [0, 5, 3, 1, 0] : [0, 2, 1, 0, 0])] });
};
A.enjoy_youth = (f, X) => out(f, X, X.pick(['你决定不把青春全押在书本上：和朋友们骑车去郊外、在夜市里吃到撑、在操场上看星星。', '你把很多时间花在了朋友身上，成绩不算拔尖，可那几年的笑声你记了一辈子。']),
  [1, 5, -2, 5, 0], { set: { flags: { sociable: true } } });
A.stay_school = (f, X, p = {}) => {
  // someone who never went to school does not "go back": a literacy class at the village school or a night school
  if (f.eduRank < 2 && f.age >= 10) {
    return out(f, X, f.r ? '你报名了村里的识字班，从一笔一画学起。白天干活，晚上就着灯光写字，没多久就能自己读信、算账了。' : '你报名了夜校的识字班，从一笔一画学起。白天干活，晚上就去上课，没多久就能自己读通知、算清账了。',
      [0, 3, 5, 1, 0], { set: { flags: { literacy: f.year, nightSchool: true } } });
  }
  if (p.back && !f.inSchool) {
    return out(f, X, '你回到了学校，坐在比你小一两岁的同学中间，把落下的课一点点补回来。第一次考试拿到及格分时，你偷偷把卷子拍下来发给了家里。',
      [0, 3, 4, 1, 0], { set: { education: { inSchool: true }, flags: { backToSchool: f.year } } });
  }
  if (p.commute) {
    return out(f, X, '你每天天不亮就出门，走很远的路去上学，傍晚踩着夕阳回家。路上背的课文，比在教室里记得还牢。', [1, 0, 4, 1, 0], { set: { education: { inSchool: true }, flags: { persevered: true } } });
  }
  const aid = X.rng.chance(clampN(0.25 + (f.know - 50) / 80, 0.1, 0.85));
  return out(f, X, aid ? '你咬着牙坚持读书。老师帮你申请到了助学金，家里的担子轻了一些，你的成绩也没有让人失望。' : '你坚持继续读书。家里为此吃了不少苦，你放学后还要帮忙干活，常常在油灯下写作业到深夜。',
    aid ? [0, 3, 5, 2, 0] : [-2, -1, 4, 2, 0], { set: { education: { inSchool: true }, flags: { persevered: true } } });
};
A.study_and_work = (f, X) => out(f, X, '你白天上学，傍晚和周末帮家里干活，一分钱一分钱地攒学费。累是累，可书一天也没落下。',
  [-2, 0, 3, 3, 0], { set: { education: { inSchool: true }, flags: { workingStudent: true } } });
A.drop_out_work = (f, X) => {
  if (f.age < 12) return A.child_chores(f, X);
  // an adult who is not studying "drops" only the plan to study more
  if (!f.inSchool && f.age >= 16) {
    return out(f, X, f.working ? '你放下了继续读书的念头，把心思放回眼前的工作上。少了一份惦记，日子反倒过得踏实了些。' : '你放下了继续读书的念头，开始认真盘算眼前的生计。', [0, 1, 0, 0, 0], { set: { flags: { declinedStudy: f.year } } });
  }
  const job = f.u ? { title: f.year >= 2016 ? '店员' : '学徒', sector: '服务业' } : f.farmer ? { title: '农民', sector: '农业' } : { title: '帮工', sector: '农业' };
  const later = f.know >= 50 && X.rng.chance(0.55);
  return out(f, X, `你离开了学校，开始当${job.title}挣钱。第一次把工钱交到家里时，${f.parentAlive ? '父母' : '家里人'}的表情有欣慰，也有说不出的愧疚。`,
    [-1, -2, -3, 1, 1], { set: { education: { inSchool: false }, career: { status: 'employed', title: job.title, sector: job.sector, incomePct: jobPct(f, job.title) }, flags: { droppedOut: f.year } },
      threads: [th(f, X, 6, '没读完的书', later ? '你报了夜校，把当年落下的书一点点补了回来，还拿到了一张毕业证。' : '你偶尔会想：如果当年继续读书，现在会是什么样子？', later ? [0, 3, 4, 1, 0] : [0, -2, 0, 0, 0], later ? { flags: { nightSchool: true } } : null)] });
};
A.vocational = (f, X, p = {}) => {
  // someone who already holds a vocational qualification learns a second trade on a short course instead
  if (f.eduRank >= 4 && !f.inSchool) return A.learn_trade(f, X, p);
  const trades = tradesFor(f).filter((t) => t !== f.flags.trade);
  const trade = p.trade && trades.includes(p.trade) ? p.trade : X.pick(trades);
  const good = X.rng.chance(0.55 + (f.know - 50) / 150 + (f.gdpGrowth > 3 ? 0.1 : 0));
  const J = tradeJob(trade);
  return out(f, X, `你选择了职业教育，学${trade}。实训车间里的第一堂课，师傅说：“手上的本事，谁也拿不走。”`,
    [0, 2, 3, 1, 0], { set: { education: { inSchool: true, field: trade }, career: { status: 'student', title: null, sector: null }, flags: { track: 'vocational', trade } },
      threads: [th(f, X, 3, '出师', good ? `你从职业学校毕业，当上了${J.title}，很快就有好几家单位抢着要人。` : `你从职业学校毕业，凭着${trade}手艺找到了一份${J.title}的工作，工资不高，但心里踏实。`, good ? [0, 4, 2, 1, 2] : [0, 1, 1, 1, 1],
        { education: { inSchool: false, level: 'vocational', field: trade }, career: { status: 'employed', title: J.title, sector: J.sector, incomePct: jobPct(f, J.title, J.pct + (good ? 0.04 : -0.04), 0) } })] });
};
A.exam_push = (f, X, p = {}) => {
  const exName = p.exam || (nextExam(f) || [0, '升学考试'])[1];
  const tier = examTier(f, X.rng, 6);
  const exams = [...(Array.isArray(f.state.person.education && f.state.person.education.exams) ? f.state.person.education.exams : []), { age: f.age, name: exName, result: tier }];
  if (tier === 'fail') {
    const voc = A.vocational(f, X);
    voc.narrative = `你为${exName}拼了最后几个月，成绩出来还是差了几分，没能上普通高中。` + voc.narrative;
    voc.set = merge(voc.set, { education: { exams } });
    return voc;
  }
  const txt = { top: `${exName}放榜，你考进了当地最好的学校，全家人高兴得一晚上没睡着。`, good: `${exName}放榜，你考上了一所不错的学校。你长长地舒了一口气。`, pass: `${exName}放榜，你压着线考上了普通高中。虽然不算理想，但路还在脚下。` }[tier];
  return out(f, X, txt, tier === 'top' ? [-1, 6, 4, 2, 0] : tier === 'good' ? [-1, 4, 3, 1, 0] : [-1, 1, 2, 0, 0],
    { set: { education: { inSchool: true, exams }, flags: { track: 'academic', schoolTier: tier } } });
};
A.exam_repeat = (f, X, p = {}) => {
  if (f.eduRank >= 5 || uniStudent(f)) return A.study_hard(f, X);
  // a repeat year helps a little; the odds still follow the country's university places that year
  const ok = X.rng.chance(clampN(uniAdmit(f, X) + 0.06, 0.05, 0.95));
  const threads = [];
  const field = FIELDS[p.field] ? p.field : pickField(f, X);
  const F = FIELDS[field];
  if (ok) {
    threads.push(th(f, X, 1, '再战告捷', `复读一年后再进考场，你考出了比去年好得多的成绩，被${F.label}专业录取了。`, [0, 6, 3, 1, 0], { education: { inSchool: true, field: F.label }, career: { status: 'student', title: null, sector: null }, flags: { track: 'uni' } }));
    threads.push(th(f, X, 1 + F.years, '毕业', `你从${F.label}专业毕业，开始了第一份工作。那一年复读的苦，后来你提起时只剩笑。`, [0, 4, 2, 1, 2], { education: { inSchool: false, level: 'tertiary', field: F.label }, career: { status: 'employed', title: F.job, sector: F.sector, incomePct: jobPct({ ...f, working: false }, F.job, F.pct - 0.04) } }));
  } else {
    threads.push(th(f, X, 1, '再一次落榜', '复读一年，成绩还是不尽如人意。你决定不再执着于这一条路，去外面的世界找机会。', [0, -4, 1, 0, 0], { education: { inSchool: false }, career: { status: 'unemployed' } }));
  }
  return out(f, X, '你决定复读一年。教室里坐满了和你一样不甘心的人，墙上贴着“再拼一年”。', [-2, -4, 4, -1, 0],
    { set: { education: { inSchool: true }, career: { status: 'student' }, flags: { repeatYear: f.year } }, threads });
};
A.exchange_abroad = (f, X, p = {}) => {
  if (!(f.famRich || resources(f) > 20000)) {
    const r = A.learn_language(f, X);
    r.feasible = false;
    r.note = p.full ? '出国读书的费用超出家庭能力' : '出国交换的费用超出家庭能力';
    r.narrative = `${p.full ? '出国读高中' : '出国交换'}要花的钱，抵得上家里好几年的积蓄。你把这个念头放进了心里，先从学好外语开始。` + r.narrative;
    return r;
  }
  if (p.full) return out(f, X, '你出国读了高中，住进了寄宿家庭。头一个学期你几乎不敢开口，第二年已经能和同学们争论课堂上的问题了。', [0, 3, 6, 0, -10], { set: { flags: { abroadExp: true, lang: true, abroadSchool: f.year } } });
  return out(f, X, '你去国外交换了一年，在陌生的课堂里举手发言，在寄宿家庭的餐桌上学会了另一种生活方式。', [0, 4, 6, 1, -6], { set: { flags: { abroadExp: true, lang: true } } });
};
A.elite_school = (f, X) => {
  if (!f.famRich) return out(f, X, '民办学校的学费让父母犹豫了很久，最后还是选择了离家近的公立学校。你在那里也遇到了好老师。', [0, 0, 2, 1, 0], { feasible: false, note: '学费过高' });
  return out(f, X, '你进了一所昂贵的私立学校，小班上课、外教授课，同学们的家境都差不多。你学到了很多，也偶尔觉得和老街坊的孩子们越来越远。', [0, 1, 5, -1, 0], { set: { flags: { eliteSchool: true } } });
};
A.boarding = (f, X) => out(f, X, f.u ? '你进了一所寄宿学校，周一早上拖着行李箱去报到，周五傍晚才回家。第一次一个人过集体生活，你学会了自己洗衣服，也学会了想家。'
  : f.chn ? '你去县城的学校寄宿，每周背着一袋米和一罐咸菜出门。夜里想家时，你就把被子蒙过头顶背单词。' : '你去镇上的学校寄宿，每周背着一袋口粮出门，周末才回家。夜里想家时，你就把被子蒙过头顶背课文。',
  [-1, -2, 4, -1, 0], { set: { flags: { boarding: true } } });
A.kid_help_home = (f, X) => out(f, X, f.hasSib ? '你决定先帮家里扛一扛：不再去学校，每天下地、赶集、照看更小的孩子，把弟弟妹妹的学费一点点攒了出来。' : '你决定先帮家里扛一扛：不再去学校，每天下地、赶集，帮着父母撑起这个家。', [-1, -2, -2, 4, 0], { set: { education: { inSchool: false }, flags: { responsible: true, droppedOut: f.year } }, threads: [th(f, X, 8, '没读完的书', '你常常在夜里翻那几本旧课本。后来村里办了识字班和夜校，你是来得最早的那一个。', [0, 2, 3, 1, 0], { flags: { nightSchool: true } })] });

// ---- after school: university, work, the city, abroad, service
function pickField(f, X) {
  const w = (k) => {
    const F = FIELDS[k];
    let x = 1;
    if (f.know < F.need - 10) x *= 0.3;
    if (k === 'ai' && f.year < 2018) x = 0;
    if (k === 'cs' && f.year >= 2035 && f.aiL === 'high') x *= 0.6;
    if (k === 'agriculture' && !f.r) x *= 0.4;
    if (k === 'medicine' && f.know >= 70) x *= 1.5;
    return x;
  };
  return X.rng.weighted(Object.keys(FIELDS), w) || 'business';
}
A.uni = (f, X, p = {}) => {
  if (f.age < 15) return A.study_hard(f, X);
  // a graduate applying again means graduate school; an enrolled student is already there
  if (f.eduRank >= 5) return A.grad_school(f, X, p);
  if (uniStudent(f)) return A.study_hard(f, X);
  if (f.age >= 30 || f.eduRank < 3) return A.study_more(f, X, { ...p, degree: true });
  const key = FIELDS[p.field] ? p.field : pickField(f, X);
  const F = FIELDS[key];
  const ex = keyExams(f.lp, f.iso, f.year).find((e) => e[0] >= 16 && e[0] <= 19);
  const exName = ex ? ex[1] : '入学考试';
  // admission follows the country's university places that year (see uniOdds); a demanding field is a bit harder
  let chance = uniAdmit(f, X) * (key === 'medicine' ? 0.9 : 1) * (f.know < F.need - 12 ? 0.8 : 1) + num(p.boost, 0) / 100;
  const hard = tuitionHard(f);
  const loan = hard && (f.nam || f.oce || ['GBR', 'KOR', 'JPN', 'CHL'].includes(f.iso));
  // some admitted students cannot pay; part of that loss is offset so the overall rate keeps following enrolment
  const moneyBlock = hard && !loan ? clampN(0.5 - (f.know - 70) / 90, 0.15, 0.6) : 0;
  if (moneyBlock) chance /= 1 - moneyBlock * 0.5;
  const admitted = X.rng.chance(clampN(chance, 0.02, 0.98));
  // the exam result is told relative to this country's school leavers (it no longer decides admission on its own)
  const sec = clampN(num(safe(() => X.data.series(f.iso, 'sec_enroll', f.year)), f.secEnroll, 60) / 100, 0.25, 1);
  const rel = (f.know - (58 + 22 * sec)) / 10 + X.rng.normal(0, 0.8) + (f.flags.olympiad ? 0.6 : 0);
  const tier = !admitted ? 'fail' : rel > 0.9 ? 'top' : rel > -0.3 ? 'good' : 'pass';
  if (!admitted) {
    const odds = uniOdds(f, X);
    const fallback = f.eduRank >= 4
      ? (f.working ? opt('回去干本行', '手艺还在，先把日子过好。', 'low', 'stay_course', { say: '你把落榜的事放下了，回到原来的岗位上。师傅拍拍你的肩：“手艺人，到哪儿都饿不着。”' }, 1) : opt('先找份工作', '凭手艺先挣钱。', 'low', 'work_now', {}, 1))
      : opt('学一门手艺', '去职业学校学一门实在的技术。', 'low', 'vocational', {}, 1);
    const dec = threadDecision(f, X, 1, {
      key: 'retry', title: '落榜之后的一年', situation: '落榜已经一年了。身边的人有的复读，有的去了城里。你还在想，接下来该怎么走。',
      options: [opt('复读再考一次', '再拼一年，赌一个不一样的结果。', 'mid', 'exam_repeat', { field: key }, 0.25 + 1.5 * odds),
        f.u ? opt('先找份工作', '先挣钱养活自己，边干边看。', 'mid', 'work_now', {}, 1.1) : opt('去城里打工', '先挣钱养活自己，边干边看。', 'mid', 'migrate_city', {}, 1.1),
        fallback],
    });
    return out(f, X, `${exName}的成绩出来，离${F.label}专业的录取线还差一截。你在房间里坐了很久，最后对自己说：路不止一条。`, [0, -6, 1, 0, 0],
      { set: { education: { inSchool: false }, career: f.working ? undefined : { status: 'unemployed' }, flags: { examFail: f.year } }, threads: [th(f, X, 1, '落榜之后', '又到了填志愿的季节，你看着别人的录取通知书，心里有了新的打算。', [0, 0, 1, 0, 0], null, { decision: dec })] });
  }
  if (moneyBlock && X.rng.chance(moneyBlock)) {
    const later = th(f, X, 4, '没读成的大学', '你报名了成人教育，下了班就去上课。几年后，你终于拿到了那张迟到的文凭。', [0, 3, 4, 0, 0], { flags: { nightSchool: true } });
    if (f.working) {
      return out(f, X, `你考上了${F.label}专业，可一年的学费和生活费抵得上家里好几年的收入。你把录取通知书压在枕头底下，第二天照常去上班。`, [-1, -7, 1, 1, 0],
        { feasible: false, note: '学费超出家庭承受能力', set: { education: { inSchool: false }, flags: { admittedNoMoney: f.year } }, threads: [later] });
    }
    const city = f.u ? null : bigCity(f);
    return out(f, X, `你考上了${F.label}专业，可一年的学费和生活费抵得上家里好几年的收入。你把录取通知书压在枕头底下，${city ? `跟着同乡去了${city}打工` : '在城里找了份工厂的活'}。`, [-1, -7, 1, 1, 1],
      { feasible: false, note: '学费超出家庭承受能力', set: { education: { inSchool: false }, urban: true, career: { status: 'employed', title: '工厂工人', sector: '制造业', incomePct: jobPct(f, '工厂工人') }, flags: { city: city || hereCity(f, X), admittedNoMoney: f.year } },
        threads: [later] });
  }
  const aid = hard ? (loan ? '你背上了一笔助学贷款。' : '你申请到了助学金和勤工俭学的岗位。') : '';
  const tierTxt = tier === 'top' ? '一所名校' : tier === 'good' ? '一所不错的大学' : '一所普通院校';
  const success = X.rng.chance(clampN(0.55 + (f.know - F.need) / 60 + (tier === 'top' ? 0.1 : 0), 0.25, 0.95));
  const pct = jobPct({ ...f, working: false }, F.job, F.pct + (tier === 'top' ? 0.08 : tier === 'pass' ? -0.06 : 0));
  const threads = [];
  const gradSet = { education: { inSchool: false, level: 'tertiary', field: F.label } };
  if (key === 'medicine') {
    threads.push(th(f, X, F.years, '实习医生', '你从医学院毕业，在医院轮转实习。第一次独立值夜班时，你的手心全是汗。', [-2, 2, 4, 1, 0], merge(gradSet, { career: { status: 'employed', title: '住院医师', sector: '医疗', incomePct: setPct(pct - 0.18) } })));
    threads.push(success
      ? th(f, X, F.years + 2, '穿上白大褂', '你通过了执业考试，正式成为一名医生。第一位病人出院时塞给你一篮鸡蛋，你推了三次才推回去。', [0, 6, 3, 3, 3], { career: { status: 'employed', title: '医生', sector: '医疗', incomePct: pct } })
      : th(f, X, F.years + 2, '离开临床', '高强度的临床工作让你身心俱疲。你最终离开了医院，去了一家医药公司，偶尔还会梦见病房的灯。', [1, -2, 2, 0, 2], { career: { status: 'employed', title: '医药公司职员', sector: '医药', incomePct: setPct(pct - 0.1) } }));
  } else {
    threads.push(th(f, X, F.years, '毕业', success ? `你从${F.label}专业毕业，找到了一份${F.job}的工作。第一天上班，你提前一个小时就到了。` : `你从${F.label}专业毕业，没能进入本行，先在一家公司做起了普通职员。`, success ? [0, 5, 3, 2, 2] : [0, -1, 2, 1, 1],
      merge(gradSet, { career: { status: 'employed', title: success ? F.job : '职员', sector: success ? F.sector : '服务业', incomePct: success ? pct : setPct(pct - 0.12) } })));
  }
  const lead = p.away ? '你离开了战火逼近的家乡，去外地读书。' : '';
  return out(f, X, `${lead}${exName}之后，你被${tierTxt}的${F.label}专业录取了。${aid}拖着行李走进校门时，你回头看了一眼送你来的家人。`, [0, 6, 4, 1, loan ? -6 : hard ? -1 : -2],
    { set: { education: { inSchool: true, field: F.label }, career: { status: 'student', title: null, sector: null }, flags: { track: 'uni', uniTier: tier, field: key } }, threads });
};
/** an evening or distance degree for an adult with a secondary or vocational qualification */
function adultDegree(f, X) {
  const done = X.rng.chance(clampN(0.35 + (f.know - 60) / 120 - (f.hasKids && f.age > 30 ? 0.05 : 0), 0.15, 0.75));
  const raise = f.working && done;
  return out(f, X, f.working ? '你报考了成人本科，白天上班，晚上和周末去上课。作业常常写到半夜，身边的同学有的比你小十几岁，你也不觉得难为情。' : '你报考了成人本科，白天泡在教室和图书馆里，把落下的东西一点点补回来。身边的同学有的比你小十几岁，你也不觉得难为情。',
    [-1, 2, 6, 0, -2], { set: { flags: { adultLearner: f.year } },
      threads: [th(f, X, 3, '迟来的文凭', done ? `几年的夜读终于有了结果，你拿到了本科文凭。${raise ? '单位给你调了岗，工资也涨了一些。' : ''}` : '工作和家务压得太紧，你没能读完。可那些课让你看问题的眼光变了。', done ? [0, 5, 4, 0, raise ? 2 : 0] : [0, -2, 2, 0, 0],
        done ? merge({ education: { level: 'tertiary', inSchool: false } }, raise ? { career: { incomePct: PCT(f, 0.06) } } : {}) : null)] });
}
A.study_more = (f, X, p = {}) => {
  if (f.age < 15) return A.study_hard(f, X);
  if (p.degree) {
    // formal study: graduate school for graduates, university for school leavers, an adult degree for everyone else
    if (f.eduRank >= 5) return A.grad_school(f, X, p);
    if (uniStudent(f)) return A.study_hard(f, X);
    if (canApply(f) && (f.age <= 20 || !f.working)) return A.uni(f, X, p);
    if (f.inSchool) return A.study_hard(f, X);
    if (f.age <= 20 && (f.eduRank < 3 || (f.eduRank === 3 && !f.flags.secDone))) return A.stay_school(f, X, { back: true });
    if (f.eduRank >= 3 && f.age < 60) return adultDegree(f, X);
  }
  if (uniStudent(f)) return A.study_hard(f, X);
  if (f.eduRank < 2 && f.age >= 10 && f.age < 60) return A.stay_school(f, X);
  // a short course: no new degree
  const done = X.rng.chance(0.6 + (f.know - 50) / 150);
  const raise = f.working && done;
  return out(f, X, f.age >= 60 ? '你报名了老年大学的课程，每周按时去上课，作业写得比年轻时还认真。' : f.working ? '你报了一门在职进修课，下了班就往教室赶，周末泡在图书馆。身边的同学有的比你小十几岁，你也不觉得难为情。' : '你报了一门进修课，白天泡在教室和图书馆里，把落下的东西一点点补回来。身边的同学有的比你小十几岁，你也不觉得难为情。',
    [-1, 2, 6, 1, -1], { set: { flags: { adultLearner: f.year } }, threads: [th(f, X, 2, '进修', done ? `那门课你坚持学完了，拿到了结业证书。${raise ? '单位给你调了岗，工资也涨了一些。' : ''}` : '工作和家务压得太紧，你没能学完。可那些课让你看问题的眼光变了。', done ? [0, 4, 3, 0, raise ? 2 : 0] : [0, -1, 2, 0, 0], raise ? { career: { incomePct: PCT(f, 0.04) } } : null)] });
};
A.work_now = (f, X) => {
  // someone who already has a job looks for a better one instead of starting from scratch
  if (f.working && f.age >= 16) return A.job_switch(f, X);
  const job = basicJob(f);
  const lower = f.age >= 22 && !f.inSchool;
  const pct = jobPct(f, job.title, num(JOB_PCT[job.title], 0.3) - (lower && f.eduRank >= 5 ? 0.08 : 0));
  const up = X.rng.chance(0.5 + (f.know - 50) / 120);
  const lead = job.title === '农民' ? '你没有继续读书，回家接过了地里的活。' : !lower ? `你没有继续读书，直接找了份${job.title}的工作。` : `你降低了要求，先找了份${job.title}的工作干起来。`;
  return out(f, X, `${lead}第一个月的工钱不多，你还是给家里买了些东西。`, [0, 2, -1, 1, 2],
    { set: { education: { inSchool: false }, career: { status: 'employed', title: job.title, sector: job.sector, incomePct: pct } },
      threads: [th(f, X, 5, '几年工龄', up ? '几年下来你成了单位里的熟手，开始带新人，工资也涨了一截。' : '几年过去，工作还是老样子。你开始琢磨要不要学点新东西。', up ? [0, 3, 2, 1, 2] : [0, -1, 1, 0, 0], up ? { career: { incomePct: setPct(pct + 0.08) } } : null)] });
};
A.migrate_city = (f, X, p = {}) => {
  if (p.city && p.cityIso && p.cityIso !== f.iso) return A.emigrate(f, X, { dest: p.cityIso, mode: f.eduRank >= 5 ? 'skilled' : 'labor' });
  // where the person lives now: a city dweller asking to "go to the city" goes to another big city, if there is one
  const here = hereCity(f, X);
  const city = p.city && p.city !== here ? p.city : otherCity(f, X);
  if (!city) {
    // nowhere else to go inside the country (a city-state): a pupil leaves school to work, others change jobs
    if (f.inSchool && f.age < 22 && f.age >= 15) return A.drop_out_work(f, X);
    const r = A.job_switch(f, X, { move: true });
    r.narrative = `在${nameOf(X.data, f.iso)}，能去的城市就只有这一座。` + r.narrative;
    return r;
  }
  const settle = X.rng.chance(clampN(0.45 + (f.know - 50) / 120 + (f.eduRank >= 5 ? 0.15 : 0) + (f.gdpGrowth > 4 ? 0.1 : 0), 0.15, 0.9));
  const skilled = f.eduRank >= 5;
  const job = skilled ? { title: f.title && f.employed ? f.title : '职员', sector: f.employed && f.sector ? f.sector : '服务业' } : f.year >= 2015 && f.mobilePay && X.rng.chance(0.4) ? { title: '外卖骑手', sector: '平台服务' } : X.pick([{ title: '工厂工人', sector: '制造业' }, { title: '建筑工人', sector: '建筑业' }, { title: '餐馆服务员', sector: '餐饮' }]);
  // the same title keeps most of its pay; a new job gets its own level, a little higher in the big city
  const pct = job.title === f.title && f.working ? jobPct(f, job.title, f.incomePct + 0.04, 0.5) : jobPct(f, job.title, num(JOB_PCT[job.title], 0.3) + 0.03, 0.15);
  // a married person (or a parent) either takes the family along or leaves them at home for now
  const fam = familyMove(f, X, f.r && f.poorC ? 0.65 : 0.35);
  const go = p.kin ? `去${city}投奔亲戚` : `坐上了去${city}的车`;
  const head = !fam ? (p.kin ? `你收拾好行李，${go}。` : `你收拾好行李，${go}。`)
    : fam.alone ? `你收拾好行李，一个人${go}，${fam.behind}。` : `你${fam.together}${go}。`;
  const withFam = fam && !fam.alone;
  const room = f.chn ? '没有本地户口，租房、看病都要多跑几趟手续，' : f.poorC ? (withFam ? '你们在城边的棚户区租下了一间小屋，' : '你在城边的棚户区租下了一个床位，') : (withFam ? '你们在城里租了一套小房子，' : '你在城里租了一间小屋，');
  const work = skilled ? `很快在那里找到了一份${job.title}的工作。` : `第二周就找到了一份${job.title}的活。`;
  const tail = withFam ? '日子紧了些，可一家人总算在一起。' : fam ? '夜里给家里打电话时，你总是说一切都好。' : '城市很大，你一个人站在天桥上看了很久的车流。';
  return out(f, X, head + room + work + tail, [-1, 1, 1, withFam ? -1 : -3, 2],
    { set: { urban: true, career: { status: 'employed', title: job.title, sector: job.sector, incomePct: pct }, education: f.inSchool && f.age >= 15 ? { inSchool: false } : undefined, flags: { city, migratedCity: f.year, familyBehind: fam && fam.alone ? f.year : undefined } },
      threads: [th(f, X, 3, '在城里站稳脚跟', settle ? `在${city}的第三年，你换了一份更好的工作，也有了几个可以一起过节的朋友。` : `在${city}打拼了几年，房租和物价压得你喘不过气。你回到了家乡，带回了一些积蓄和见识。`, settle ? [0, 4, 2, 3, 2] : [1, -2, 1, 2, 0], settle ? { career: { incomePct: setPct(pct + 0.07) } } : { urban: f.u, flags: { city: here, returnedHome: true, familyBehind: false } })] });
};
A.job_bigcity = (f, X, p = {}) => {
  const here = hereCity(f, X);
  const city = p.city && p.city !== here ? p.city : otherCity(f, X);
  const good = X.rng.chance(clampN(0.5 + (f.know - 55) / 80, 0.15, 0.9));
  const F = f.field ? Object.values(FIELDS).find((x) => x.label === f.field) : null;
  const title = F ? F.job : f.eduRank >= 5 || uniStudent(f) ? '职员' : '店员';
  const pct = jobPct(f, title, num(F && F.pct, JOB_PCT[title], 0.5) + 0.06, 0.2);
  const place = /医生|护士/.test(title) ? '一家忙碌的大医院' : title === '教师' ? '一所大学校' : title === '律师助理' ? '一家律师事务所' : '一家节奏很快的公司';
  const desk = /医生|护士/.test(title) ? '夜班一个接一个，你常常在值班室里和衣而睡。' : title === '教师' ? '班上学生很多，你常常是办公室里最后一个批完作业的人。' : '工位很小，窗外的楼很高，你常常是整层最后一个关灯的人。';
  const fam = city ? familyMove(f, X, 0.4) : null;
  const go = !city ? `你留在${here || '城里'}，` : !fam ? `你去了${city}，` : fam.alone ? `你一个人去了${city}，${fam.behind}，` : `你${fam.together}去了${city}，`;
  return out(f, X, `${go}进了${place}做${title}。${desk}`, [-2, 2, 3, -1, 3],
    { set: { urban: true, education: { inSchool: false }, career: { status: 'employed', title, sector: (F && F.sector) || f.sector || '服务业', incomePct: pct }, flags: { city: city || here, familyBehind: fam && fam.alone ? f.year : undefined } },
      threads: [th(f, X, 4, city ? '大城市的第四年' : '第四年', good ? '你在公司里升了职，开始带一个小团队。加班依旧，可你觉得自己在往上走。' : '长期的加班让你的身体亮起了红灯。体检报告上的几个箭头，让你开始重新想“值不值得”。', good ? [-1, 4, 2, 1, 4] : [-4, -3, 1, -1, 1], good ? { career: { incomePct: setPct(pct + 0.08) } } : null)] });
};
A.job_hometown = (f, X) => {
  const job = f.eduRank >= 5 ? { title: '职员', sector: '公共服务' } : basicJob(f);
  return out(f, X, f.chn || f.examCulture ? '你回到家乡，在当地找了一份稳定的工作。工资不算高，可下班能回家吃饭，周末能陪父母说说话。' : '你回到家乡附近工作。日子不算精彩，但离家人近，心里踏实。',
    [1, 3, 0, 4, 1], { set: { education: { inSchool: false }, career: { status: 'employed', title: job.title, sector: job.sector, incomePct: jobPct(f, job.title, num(JOB_PCT[job.title], 0.35) - 0.04, 0.2) } },
      threads: [th(f, X, 5, '小城的日子', '几年下来，你在家乡有了自己的小圈子。偶尔看到在大城市打拼的同学发的照片，你也说不清自己羡不羡慕。', [1, 2, 0, 3, 0])] });
};
A.grad_school = (f, X, p = {}) => {
  // a graduate programme needs a first degree (or one about to be finished)
  if (f.eduRank < 5 && !uniStudent(f)) return A.study_more(f, X, { ...p, degree: true });
  const ok = X.rng.chance(clampN(0.3 + (f.know - 55) / 50, 0.05, 0.92));
  if (!ok) return out(f, X, '你备考了大半年，成绩出来还是差了一点。你决定先去工作，把读研的念头放一放。', [-1, -4, 3, 0, 0], { set: { flags: { gradFail: f.year } } });
  const fieldLabel = f.field || (FIELDS[p.field] || FIELDS.business).label;
  const F = Object.values(FIELDS).find((x) => x.label === fieldLabel);
  // a working graduate past the mid-twenties studies part-time and keeps the job
  if (p.partTime || (f.working && f.age >= 26)) {
    return out(f, X, `你考上了${fieldLabel}方向的在职研究生，白天上班，晚上和周末去上课。最忙的那两年，你常常在地铁上看论文。`, [-2, 2, 6, -1, -2],
      { set: { flags: { partTimeGrad: f.year } },
        threads: [th(f, X, 3, '研究生毕业', '你拿到了硕士学位。单位给你换了一个更重要的岗位，工资也涨了一截。', [0, 4, 3, 0, 2], { education: { inSchool: false, level: 'postgrad', field: fieldLabel }, career: f.working ? { incomePct: PCT(f, 0.06) } : undefined })] });
  }
  const job = F ? F.job : '研究员';
  return out(f, X, `你考上了研究生，继续在${fieldLabel}方向深造。实验室的灯常常亮到半夜，你也渐渐找到了自己真正感兴趣的问题。`, [-1, 4, 6, 0, -1],
    { set: { education: { inSchool: true, field: fieldLabel }, career: { status: 'student', title: null, sector: null }, flags: { track: 'postgrad' } },
      threads: [th(f, X, 3, '研究生毕业', `你拿到了硕士学位，进了一家看重学历的单位做${job}，起薪比本科同学高出一截。`, [0, 4, 3, 1, 3], { education: { inSchool: false, level: 'postgrad', field: fieldLabel }, career: { status: 'employed', title: job, sector: (F && F.sector) || f.sector || '专业服务', incomePct: jobPct({ ...f, working: false }, job, num(F && F.pct, 0.62) + 0.08, 0) } })] });
};
A.start_business = (f, X, p = {}) => {
  const capM = f.poorC ? 4 : 8;
  const capital = capM * f.monthRef;
  const res = resources(f);
  const borrowed = res < capital;
  const pSucc = clampN(0.28 + (f.know - 50) / 200 + f.gdpGrowth / 40 + (f.fam - 0.5) * 0.2 + (f.eduRank >= 5 ? 0.05 : 0) - (f.recession ? 0.15 : 0) - (borrowed ? 0.06 : 0), 0.05, 0.75);
  const roll = X.rng.next();
  const kind = p.kind || (f.r ? '小卖部' : f.year >= 2016 && f.internet >= 50 ? X.pick(['网店', '小餐馆', '工作室']) : X.pick(['小餐馆', '杂货店', '修理铺']));
  const outcome = roll < pSucc ? 'good' : roll < pSucc + 0.35 ? 'flat' : 'bad';
  // a new shop earns what a small business earns, plus a little of what its owner made before
  const startPct = jobPct(f, `${kind}老板`, f.r ? 0.3 : 0.4, 0.35);
  const thr = {
    good: th(f, X, 3, `${kind}的第三年`, `你的${kind}站稳了脚跟，雇了几个人，还开了第二家。你第一次觉得，命运真的可以握在自己手里。`, [0, 6, 2, 2, capM * 2.5], { career: { incomePct: setPct(Math.max(startPct, 0.45) + 0.15) } }),
    flat: th(f, X, 3, `${kind}的第三年`, `${kind}不赚不赔地撑着，你每天起早贪黑。说不上成功，可这是你自己的事业。`, [-2, 1, 1, 0, 0]),
    bad: th(f, X, 3, `${kind}关门了`, `生意终究没能做起来。${kind}关门那天，你把招牌拆下来放进了仓库，又开始找工作。`, [-2, -6, 2, -1, -capM * 0.5], { career: { status: 'unemployed' }, flags: { business: false, businessFailed: true } }),
  }[outcome];
  const abroadHome = p.hometown && f.migrant && f.origin && f.origin !== f.iso;
  const old = f.selfEmp && f.title ? f.title.replace(/老板$/, '') : '';
  const home = p.hometown ? (abroadHome ? `你回到了${nameOf(X.data, f.origin)}，` : '你回到了家乡，') : old && old !== kind ? `你把原来的${old}盘了出去，` : '你';
  const set = { career: { status: 'self_employed', title: `${kind}老板`, sector: '个体经营', incomePct: startPct }, flags: { business: true, businessSince: f.year } };
  if (abroadHome) Object.assign(set, { country: f.origin, flags: { ...set.flags, migrant: false, returnee: f.year, city: null } });
  else if (p.hometown) Object.assign(set, { urban: f.ruralOrigin ? false : f.u, flags: { ...set.flags, returnedHome: true, city: null } });
  return out(f, X, `${home}拿出${borrowed ? '东拼西凑借来的钱' : '攒下的积蓄'}，开了一家${kind}。${f.sinic || f.iso === 'VNM' ? '开张那天放了一挂鞭炮，你站在门口，心跳得比鞭炮还响。' : '开张那天，朋友们都来捧场，你站在门口迎客，紧张得手心直冒汗。'}`, [-1, 4, 2, p.hometown ? 2 : 0, -capM],
    { set, threads: [thr] });
};
A.civil_service = (f, X) => {
  const base = f.chn ? 0.12 : ['KOR', 'IND', 'VNM', 'EGY', 'NGA', 'BGD', 'PAK'].includes(f.iso) ? 0.08 : 0.3;
  const pass = X.rng.chance(clampN(base + (f.know - 55) / 120 + (f.eduRank >= 5 ? 0.05 : -0.05), 0.02, 0.8));
  if (!pass) {
    const dec = threadDecision(f, X, 1, { key: 'cs_retry', title: '再考一次？', situation: '又到了公职考试报名的时候。去年的落榜还历历在目，身边已经有人考了第三次。', options: [opt('再考一次', '继续备考，再拼一年。', 'mid', 'civil_service', {}, 1), opt('去企业工作', '先进企业积累经验。', 'low', 'job_switch', {}, 1.3), opt('自己闯一闯', '做点小生意试试。', 'high', 'start_business', {}, 0.5)] });
    return out(f, X, '你报名参加了公职考试。一个岗位，几百人竞争。成绩出来，你差了几名。', [-1, -4, 3, 0, 0], { set: { flags: { civilFail: f.year } }, threads: [th(f, X, 1, '又一年备考季', '新一年的招考公告发布了，你盯着那张表看了很久。', [0, 0, 1, 0, 0], null, { decision: dec })] });
  }
  return out(f, X, '你考上了公务员。拿到通知的那天，父母打电话通知了所有亲戚。工作稳定、按部就班，你也开始学着适应会议和公文。', [0, 5, 1, 3, 1],
    { set: { education: { inSchool: false }, career: { status: 'employed', title: '公务员', sector: '公共部门', incomePct: jobPct(f, '公务员', 0.62, 0.25) }, flags: { civilServant: true } } });
};
A.learn_trade = (f, X, p = {}) => {
  if (f.age < 15) return A.child_chores(f, X);
  const trades = tradesFor(f).filter((t) => t !== f.flags.trade);
  const trade = p.trade && trades.includes(p.trade) ? p.trade : X.pick(trades);
  const good = X.rng.chance(0.6 + (f.know - 50) / 150);
  const J = tradeJob(trade);
  return out(f, X, `你拜师学${trade}，从打下手开始，手上磨出了茧，也慢慢摸到了门道。`, [-1, 2, 4, 1, -1],
    { set: { flags: { trade, learningTrade: f.year } }, threads: [th(f, X, 2, '手艺人', good ? `你成了一名熟练的${J.title}，找你干活的人越来越多。` : `你学会了${trade}，可这一行的活不太好找，只能边干边等机会。`, good ? [0, 4, 2, 1, 2] : [0, 0, 1, 0, 0],
      { career: { status: 'employed', title: J.title, sector: J.sector, incomePct: jobPct(f, J.title, J.pct + (good ? 0.04 : -0.04), 0.15) } })] });
};
A.farming = (f, X, p = {}) => {
  const modern = f.smart && X.rng.chance(0.4 + (f.know - 50) / 120);
  const work = p.kind === 'herd' ? '放羊' : p.kind === 'livestock' ? '搞养殖' : '种地';
  return out(f, X, f.u ? `你离开了城市，回到乡下${work}。第一年你晒得黝黑，腰酸背疼，可每天日落时都觉得心里很满。` : p.kind === 'herd' ? '你留在村里，赶着羊群上山。哪片草场的草长得好、哪天要变天，你渐渐都心里有数了。' : p.kind === 'livestock' ? '你留在村里，盖起了圈舍，搞起了养殖。防疫、饲料、行情，样样都得操心，一年忙到头。' : '你留在村里，接过了家里的田地。天不亮就下地，看天吃饭，一年的收成全凭老天和你的汗水。',
    [2, 2, 0, 3, -1], { set: { urban: false, career: { status: 'self_employed', title: '农民', sector: '农业', incomePct: f.title === '农民' ? setPct(f.incomePct) : jobPct(f, '农民', 0.15, 0.15) }, flags: { farmer: true } },
      threads: [th(f, X, 5, '田里的年景', modern ? '你学着用手机看行情、用新品种和滴灌，还把农产品卖到了网上。收成一年比一年好。' : '这些年有丰年也有歉年，你学会了和天气讨价还价，也攒下了一点家底。', modern ? [0, 4, 3, 1, 3] : [0, 1, 1, 1, 1], modern ? { career: { incomePct: setPct((f.title === '农民' ? f.incomePct : 0.15) + 0.12) } } : null)] });
};
A.gig = (f, X, p = {}) => {
  const modern = f.year >= 2015 && f.mobilePay;
  const t = typeof p.title === 'string' && p.title && (modern || !/外卖|网约车/.test(p.title)) ? p.title : modern ? X.pick(['外卖骑手', '网约车司机', '快递员']) : X.pick(['临时工', '搬运工', '摊贩']);
  return out(f, X, `你先做起了${t}，按单算钱，多跑多挣。风里雨里，你熟悉了这座城市的每一条小路。`, [-2, -1, 0, 0, 1],
    { set: { career: { status: 'employed', title: t, sector: '零工', incomePct: jobPct(f, t, num(JOB_PCT[t], 0.25), 0.1) } } });
};
A.rest = (f, X) => out(f, X, f.age >= 60 ? '你决定慢下来，把日子过得松一点：晒晒太阳、看看书、和老朋友喝喝茶。' : X.pick(['你决定给自己放个假，睡到自然醒，把搁置很久的书读完，把很多事情重新想了一遍。', '你暂时停下来，回家休整了一段时间。身边有人着急，你却第一次觉得自己在好好呼吸。']),
  [3, 4, 1, 1, -1]);
/** keep things as they are; a template can say what that means in its own situation (p.say, optional p.fx) */
A.stay_course = (f, X, p = {}) => out(f, X, typeof p.say === 'string' && p.say ? p.say
  : X.pick(['你决定不折腾，继续沿着现在的路走下去。日子平平稳稳，也没什么不好。', '你把这个念头放下了，按部就班地过好眼前的日子。有时候，不变也是一种选择。']),
Array.isArray(p.fx) ? p.fx : [0, 1, 0, 1, 1]);
A.job_switch = (f, X, p = {}) => {
  if (f.inSchool && f.age < 22) return out(f, X, '你找了一份兼职，课余时间去打工。挣得不多，却让你提前看到了社会的样子。', [-1, 1, 1, 1, 1]);
  const ok = X.rng.chance(clampN(0.55 + (f.know - 50) / 120 - (num(f.unemp, 6) - 6) / 40 - (f.age > 45 ? 0.15 : 0), 0.1, 0.9));
  if (!f.working) {
    const job = basicJob(f);
    return ok ? out(f, X, '你四处投简历、跑招聘会，终于在一家单位找到了工作。入职那天，你把工牌端端正正地挂在了胸前。', [0, 5, 1, 1, 1], { set: { career: { status: 'employed', title: job.title, sector: job.sector, incomePct: jobPct(f, job.title) } } })
      : out(f, X, '你投出了一份又一份简历，回音寥寥。你开始打零工，一边干一边继续找。', [-1, -4, 1, 0, 0], { threads: [th(f, X, 1, '还在找工作', '又找了一年，你终于等来了一份合适的工作。', [0, 4, 0, 1, 1], { career: { status: 'employed', title: job.title, sector: job.sector, incomePct: jobPct(f, job.title, num(JOB_PCT[job.title], 0.3) - 0.03) } })] });
  }
  return ok ? out(f, X, p.move ? '你换了一家公司，也换了一个街区生活。新同事很友好，工资也比原来高了一些。' : '你跳槽去了一家更好的单位，工资涨了一截，也终于摆脱了原来那位难缠的上司。', [0, 4, 2, 0, 1], { set: { career: { status: 'employed', incomePct: PCT(f, 0.07) } } })
    : out(f, X, '你试着换工作，面了好几家都不太合适。最后你决定先留在原岗位，把手上的事做好。', [0, -2, 1, 0, 0]);
};
A.quit_job = (f, X, p = {}) => {
  if (!f.working) return A.rest(f, X);
  const ok = X.rng.chance(clampN(0.5 + (f.know - 50) / 120 - (num(f.unemp, 6) - 6) / 40, 0.1, 0.9));
  return out(f, X, p.severance ? '你接受了公司的补偿方案，签完字，抱着纸箱走出了大楼。拿着这笔补偿金，你决定先好好歇一歇，再想下一步。' : '你递交了辞职信。走出公司大门的那一刻，你觉得浑身轻松，也有一点空落落的。', p.severance ? [2, 1, 0, 1, 4] : [2, 4, 0, 0, -2],
    { set: { career: { status: 'unemployed' } }, threads: [th(f, X, 1, p.severance ? '离开以后' : '辞职以后', ok ? '休整了一阵子后，你找到了一份更合心意的工作，薪水也没少。' : '找工作比你想的难。积蓄一天天变少，你开始怀疑当初的决定，最后接受了一份不太理想的工作。', ok ? [0, 4, 1, 1, 1] : [0, -3, 0, 0, -1], { career: { status: 'employed', incomePct: ok ? PCT(f, 0.03) : PCT(f, -0.08) } })] });
};
A.promotion_push = (f, X, p = {}) => {
  if (!f.working) return A.job_switch(f, X);
  if (p.leverage) {
    // an outside offer used to ask for a raise
    const up = X.rng.chance(clampN(0.45 + (f.know - 55) / 100, 0.15, 0.8));
    return up ? out(f, X, '你拿着那份邀请去找了上司。谈话不长，第二周，加薪的通知就下来了。', [0, 4, 1, 0, 2], { set: { career: { incomePct: PCT(f, 0.06) } } })
      : out(f, X, '你拿着那份邀请去谈加薪，上司客客气气地说“再等等”。你没有走，心里却开始留意别的机会。', [0, -2, 1, 0, 0]);
  }
  const up = X.rng.chance(clampN(0.35 + (f.know - 55) / 80, 0.1, 0.8));
  if (f.selfEmp) {
    return out(f, X, '你把心思全扑在了生意上：添设备、跑客户、琢磨新花样，天不亮就出门。家里人说你瘦了，你说忙完这阵就好。', [-3, -1, 3, -2, -1],
      { threads: [th(f, X, 2, '生意的起色', up ? '这两年的辛苦有了回报，生意比从前红火了不少，你还请了两个帮手。' : '投进去的钱和力气没有换来多少回头客，你把摊子收小了一些，心里却更清楚该怎么做了。', up ? [-1, 5, 1, 0, 3] : [-1, -3, 1, 0, -1], up ? { career: { incomePct: PCT(f, 0.08) } } : null)] });
  }
  return out(f, X, '你决定拼一把：主动接下最难的项目，周末也泡在单位。家里人说你瘦了，你说忙完这阵就好。', [-3, -1, 3, -2, 1],
    { threads: [th(f, X, 1, '拼来的结果', up ? '你的努力被看见了，你升了职，也拿到了一笔不小的奖金。' : '晋升名单上没有你的名字。你在楼下的便利店坐了很久，然后给家里打了个电话。', up ? [-1, 5, 1, 0, 3] : [-2, -4, 1, 1, 0], up ? { career: { incomePct: PCT(f, 0.08) } } : null)] });
};
A.side_hustle = (f, X) => {
  const good = X.rng.chance(0.4 + (f.know - 50) / 150);
  const what = f.year >= 2017 && f.shortVideo ? '在网上做内容、接小单' : '周末摆摊、接零活';
  return out(f, X, `你开始${what}，把下班后的时间也用了起来。累是累，可多一份收入让你心里有了底。`, [-2, 1, 2, 1, 1],
    { set: { flags: { sideHustle: true } }, threads: [th(f, X, 2, '副业', good ? '副业慢慢有了起色，每个月的收入快赶上一份工资了。' : '副业做了两年，挣得不多，你最终把精力收了回来。', good ? [0, 3, 1, 0, 4] : [1, 0, 1, 0, 0])] });
};
A.downshift = (f, X) => out(f, X, f.selfEmp ? '你把生意收小了一些，少接几单活，早早关门回家。挣得少了一截，可你终于能在天黑前坐下来好好吃顿饭。' : '你主动换了一份轻松些的工作。工资少了一截，可你终于能在天亮时出门、天黑前回家。', [3, 4, 0, 3, -1], { set: { career: { incomePct: PCT(f, -0.08) } } });
A.family_time = (f, X, p = {}) => {
  if (p.kind === 'photo') {
    return out(f, X, f.hasKids ? '你把孩子们和孙辈们都叫了回来，一大家子挤在客厅里，拍了一张全家福。照片洗出来以后，你把它挂在了床头，每天醒来第一眼就能看到。'
      : f.couple ? '你和{partner}去照相馆拍了一张合影，又把几位老亲戚、老朋友请到家里吃了顿饭，大家一起拍了张照。那张照片被你摆在了床头。'
        : '你把还走得动的亲戚和老朋友都请到了家里，大家挤在一起拍了一张合影。照片洗出来以后，你把它摆在了床头。', [0, 6, 0, 6, -0.5], { set: { flags: { familyPhoto: f.year } } });
  }
  if (p.kind === 'grandkids') {
    return out(f, X, '你没有搬过去，只在周末和放假时去{child}家帮着带带孩子。不用天天围着锅台转，祖孙俩见面反倒更亲。', [0, 4, 0, 5, 0], { set: { flags: { grandparent: true } } });
  }
  const young = f.kids.some((k) => k.age <= 15);
  const txt = f.age < 16 ? '你把更多时间留给了家里：陪大人做饭、听长辈讲过去的事，周末一家人出去走走。'
    : young ? (f.working ? '你推掉了一些应酬，每天按时回家。陪孩子写作业、周末一起去公园，你发现孩子长得比你想象中快。' : '你把大把时间花在了孩子身上：一起搭积木、读绘本、去公园喂鸽子。孩子笑起来的样子，你怎么也看不够。')
      : f.hasKids ? '你常把孩子们叫回家吃饭，一大家子挤在一张桌上，说说各自的近况。散了以后，屋里还留着热闹的余温。'
        : f.parentAlive ? '你把更多时间留给了家人：周末回家吃饭，陪长辈散步，听他们讲那些讲过很多遍的故事。'
          : f.couple ? '你把更多时间留给了{partner}：一起做饭、散步、翻看旧照片，把从前没空说的话慢慢说完。'
            : '你常去看望亲戚和老朋友，一起吃饭、聊天、翻看旧照片。人和人之间的牵挂，你越来越珍惜。';
  return out(f, X, txt, [1, 4, 0, 6, 0], { set: { career: f.working ? { incomePct: PCT(f, -0.02) } : undefined } });
};
A.career_switch = (f, X, p = {}) => {
  // what one can switch to depends on schooling: a teaching post needs a degree
  const grad = f.eduRank >= 5;
  const TEACH = grad ? { title: '教师', sector: '教育' } : { title: '培训老师', sector: '教育' };
  const CARE = { title: '护理员', sector: '养老护理' };
  const HANDS = [CARE, { title: '电工', sector: '建筑与维修' }, { title: '厨师', sector: '餐饮' }, { title: '修理工', sector: '维修服务' }];
  const to = p.to === 'teacher' ? TEACH : p.to === 'care' ? CARE : p.to === 'hands' ? X.pick(HANDS)
    : X.pick(grad ? [TEACH, { title: '设计师', sector: '创意产业' }, { title: '技术员', sector: '新能源' }, CARE] : [CARE, { title: '技术员', sector: '新能源' }, { title: '厨师', sector: '餐饮' }, { title: '电工', sector: '建筑与维修' }]);
  const ok = X.rng.chance(clampN(0.45 + (f.know - 50) / 100 - (f.age > 45 ? 0.1 : 0), 0.15, 0.85));
  // a newcomer starts near the bottom of the new trade's ladder and keeps only a little of the old pay
  const pct = jobPct(f, to.title, num(JOB_PCT[to.title], 0.4) - 0.03, 0.25);
  return out(f, X, `你决定转行做${to.title}。从头学起的那几个月，你常常觉得自己像个新人，可心里的那团火一直没灭。`, [0, 3, 4, 0, -2],
    { set: { career: { status: 'employed', title: to.title, sector: to.sector, incomePct: pct } }, threads: [th(f, X, 3, '转行之后', ok ? `转行第三年，你成了一名口碑不错的${to.title}，收入也一年比一年好。` : '新行业比想象的难，你时常怀念从前的工作，但也没有回头。', ok ? [0, 4, 2, 2, 2] : [0, -2, 1, 0, 0], ok ? { career: { incomePct: setPct(pct + 0.08) } } : null)] });
};
/** a job at the ground station of the Mars programme (the world line's space branch) */
A.mars_ground = (f, X) => {
  const title = '地面支持工程师';
  return out(f, X, '你没有报名去火星，而是去了火星项目的地面支持中心工作：盯着屏幕上的数据，替远在另一颗星球上的人排查故障、安排补给。你常说，自己离火星只差一块屏幕。', [0, 4, 4, 1, 1],
    { set: { career: { status: 'employed', title, sector: '航天', incomePct: jobPct(f, title, 0.68, 0.3) }, flags: { marsGround: f.year } } });
};
A.change_major = (f, X, p = {}) => {
  if (!f.uni) return A.career_switch(f, X, p);
  const key = FIELDS[p.field] ? p.field : pickField(f, X);
  const ok = X.rng.chance(clampN(0.5 + (f.know - 60) / 80, 0.1, 0.9));
  return ok ? out(f, X, `你通过了转专业考核，转到了${FIELDS[key].label}专业。新课程很难，但你每天都带着好奇去上课。`, [0, 4, 3, 0, 0], { set: { education: { field: FIELDS[key].label }, flags: { field: key, changedMajor: true } } })
    : out(f, X, '转专业的名额太少，你没能如愿。你开始在原专业里寻找自己感兴趣的方向，也去旁听了想学的课。', [0, -2, 3, 0, 0]);
};
A.retrain_ai = (f, X) => {
  const isAI = f.year >= 2023;
  const good = X.rng.chance(clampN(0.35 + (f.know - 50) / 80 - (f.age > 50 ? 0.1 : 0), 0.08, 0.85));
  const title = isAI ? 'AI 应用工程师' : '程序员';
  const can = f.working || f.unemployed;
  if (f.age < 18) {
    return out(f, X, isAI ? '你跟着网上的免费课程学写代码，又学着让 AI 帮你查错。第一个能运行的小程序，让你兴奋得一夜没睡着。' : '你跟着网上的免费课程学会了写代码。第一个能运行的小游戏，让你兴奋得一夜没睡着。',
      [-1, 3, 6, 0, 0], { set: { flags: { coder: true, aiSkill: isAI } } });
  }
  // a new tech job pays like one (a little less for someone without a degree), not like the old job plus a bit
  const pct = jobPct(f, title, num(JOB_PCT[title], 0.65) - (f.eduRank >= 5 ? 0 : 0.08), 0.25);
  // only a better-paid post is worth switching for; otherwise the skill is used in the current job
  const job = good && can && (pct > f.incomePct + 0.02 || !f.working);
  return out(f, X, isAI ? '你报了 AI 课程，从提示词学到模型微调。深夜对着屏幕调试代码时，你觉得自己又回到了学生时代。' : '你开始自学编程，从最简单的网页做起。第一次看到自己写的程序跑起来，你在屋里转了好几圈。',
    [-1, 2, 7, 0, -1], { set: { flags: { coder: true, aiSkill: isAI } }, threads: [th(f, X, 2, '新技能', job ? `你凭新学的本事换了一份${title}的工作，收入涨了一截。` : f.working ? '新技能没有立刻换来新工作，但你在原岗位上用它省下了很多时间。' : '新技能没有立刻换来新工作，可你的简历上多了一行，面试时也更有底气了。', job ? [0, 5, 2, 0, 3] : [0, 1, 2, 0, 1], job ? { career: { status: 'employed', title, sector: '信息技术', incomePct: pct } } : null)] });
};

// ---- relationships and family
A.seek_partner = (f, X, p = {}) => {
  if (f.hasPartner) return out(f, X, '你把更多心思放在了和{partner}的感情上：一起做饭、一起散步，把从前没说出口的话慢慢说开。', [0, 3, 0, 5, 0]);
  if (f.age < 16) return out(f, X, '你偷偷喜欢上了一个人，每天找各种理由从TA的座位旁经过。这份心事，你只写在了日记里。', [0, 3, 0, 1, 0]);
  const pm = clampN(0.4 + f.relSt / 220 + (f.u ? 0.05 : 0) - (f.age > 45 ? 0.15 : 0) + (p.style === 'match' ? 0.1 : 0), 0.1, 0.85);
  if (!X.rng.chance(pm)) return out(f, X, p.style === 'match' ? '你见了好几个相亲对象，客客气气地吃饭、礼貌地道别，始终没有遇到心动的人。' : '你试着走出去认识新的人，参加聚会、下载交友软件，却始终没有遇到合适的人。你也因此更了解自己想要什么。', [0, -1, 1, 1, 0]);
  const nm = personName(X.data, f.iso, f.m ? 'female' : 'male', X.rng);
  const how = p.style === 'match' ? `经人介绍，你认识了${nm}。第一次见面有些拘谨，第二次你们就聊到了餐馆打烊。` : f.year >= 2014 && f.smart && f.u && X.rng.chance(0.4) ? `你在交友软件上认识了${nm}。你们约在一家小书店见面，聊得比想象中投机。` : `你在朋友的聚会上认识了${nm}。散场后你们又沿着街走了很久。`;
  return out(f, X, how, [0, 6, 0, 4, -0.3], { set: { relationship: { status: 'dating', partner: { name: nm, sinceYear: f.year } } } });
};
A.stay_single = (f, X) => {
  if (f.couple) return out(f, X, '你想了很久关于婚姻的那些事，最后决定先不做什么大的改变，而是把心里的话慢慢说给{partner}听。', [0, 0, 1, 1, 0]);
  if (f.dating) return out(f, X, '你和{partner}认真谈了一次：你们都不急着结婚，就这样好好在一起。说开以后，两个人都轻松了不少。', [0, 2, 0, 2, 0], { set: { flags: { noWeddingPlan: f.year } } });
  return out(f, X, '你决定不再为了别人的期待去找对象。一个人吃饭、一个人旅行，你把日子过得有声有色。', [0, 3, 1, -1, 1], { set: { flags: { singleByChoice: true } } });
};
A.focus_career = (f, X) => out(f, X, '你把感情的事暂时放到了一边，全身心扑在工作上。身边的人一个个成了家，你偶尔也会在深夜问自己值不值得。', [-1, 0, 3, -2, 2], { threads: [th(f, X, 3, '事业为先', '这几年的投入有了回报，你在单位里成了骨干。', [0, 3, 1, 0, 2], { career: { incomePct: PCT(f, 0.05) } })] });
A.marry = (f, X) => {
  if (!f.hasPartner) {
    const r = A.seek_partner(f, X);
    r.feasible = false;
    r.note = '还没有伴侣';
    r.narrative = '你想成家，可身边还没有那个人。' + r.narrative;
    return r;
  }
  if (f.married) return out(f, X, '你和{partner}早已成家。你们找了个周末补拍了一组照片，像是又结了一次婚。', [0, 4, 0, 4, -0.5]);
  const cost = f.sinic || f.sas ? 8 : f.mena || f.ssa ? 6 : 3;
  return out(f, X, f.sinic ? '你和{partner}结婚了。婚礼上两家亲戚坐满了大厅，敬酒敬到最后，你已经分不清谁是谁的二舅。' : f.sas ? '你和{partner}结婚了。婚礼热热闹闹办了好几天，前来道贺的亲戚多得你根本记不住名字，只记得{partner}在人群里朝你笑。' : '你和{partner}结婚了。没有太多排场，只有最亲近的人。交换誓言时，你的声音有点发抖。',
    [1, 7, 0, 5, -cost], { set: { relationship: { status: 'married', partner: { name: f.partnerName, sinceYear: f.partnerSince } }, flags: { marriedYear: f.year } }, threads: [th(f, X, 1, '新婚', '婚后的第一年，你们为了谁洗碗吵过，也在深夜的厨房里一起煮过面。', [0, 3, 0, 3, 0])] });
};
A.cohabit = (f, X) => {
  if (!f.hasPartner) return A.seek_partner(f, X);
  return out(f, X, '你和{partner}搬到了一起住。两个人的东西挤满了小小的房间，牙刷并排放在杯子里。', [0, 4, 0, 4, 0.5], { set: { relationship: { status: 'partnered', partner: { name: f.partnerName, sinceYear: f.partnerSince } } } });
};
A.wait_marriage = (f, X) => {
  if (!f.hasPartner) return A.seek_partner(f, X);
  const split = X.rng.chance(0.35);
  return out(f, X, '你对{partner}说，想再等一等，等工作稳定一些。TA沉默了一会儿，说“好”。', [0, -1, 0, -1, 0],
    { threads: [th(f, X, 2, '等待的答案', split ? '等待让两个人渐行渐远。一个下雨的晚上，你们平静地说了分手。' : '又过了两年，你们终于把婚事定了下来。领证那天，两个人都笑得像傻子。', split ? [0, -5, 0, -2, 0] : [0, 6, 0, 4, -3], split ? { relationship: { status: 'single', partner: null } } : { relationship: { status: 'married', partner: { name: f.partnerName, sinceYear: f.partnerSince } } })] });
};
A.breakup = (f, X) => {
  if (!f.hasPartner) return out(f, X, '你决定把一段放不下的旧事彻底放下。删掉那些聊天记录的时候，你没有哭。', [0, 1, 1, 0, 0]);
  if (f.married) return A.divorce(f, X);
  return out(f, X, '你和{partner}分手了。最后一次见面，你们把彼此的东西还给对方，说了声“保重”。', [0, -5, 1, -2, 0],
    { set: { relationship: { status: 'single', partner: null } }, threads: [th(f, X, 1, '走出来', '一年过去，你已经能平静地想起那段感情，也重新开始期待新的相遇。', [0, 4, 0, 1, 0])] });
};
A.divorce = (f, X) => {
  if (!f.couple) return A.breakup(f, X);
  const split = Math.min(Math.max(0, f.assets) * 0.3, 12 * f.monthRef);
  const months = split / Math.max(1, f.monthRef);
  return out(f, X, f.hasKids ? '你和{partner}离婚了。最难的是告诉孩子们，你们约好了：不在孩子面前说对方一句坏话。' : '你和{partner}离婚了。办完手续走出大门，两个人在台阶上站了一会儿，各自往不同的方向走去。',
    [-1, -5, 1, f.hasKids ? -4 : -2, -months], { set: { relationship: { status: 'divorced', partner: null } }, threads: [th(f, X, 2, '新的开始', '离婚后的第二年，你重新布置了屋子，学会了一个人生活，也重新找回了一些自己。', [1, 5, 1, 1, 0])] });
};
A.reconcile = (f, X) => out(f, X, f.couple ? '你主动向{partner}道了歉，把憋了很久的话说开了。那天晚上，你们很久没有这样好好聊过天了。' : '你主动联系了那个闹僵多年的人。电话接通时你们都沉默了几秒，然后同时笑了。',
  [0, 4, 0, 6, 0]);
A.have_child = (f, X) => {
  if (!f.couple && !f.dating) return out(f, X, '你想要一个孩子，可眼下还没有可以一起抚养孩子的伴侣。你把这个愿望放在心里，也开始了解领养和独自养育的路。', [0, -1, 1, 0, 0], { feasible: false, note: '没有伴侣' });
  const tooOld = f.fe ? f.age > 45 : f.age > 60;
  if (tooOld) return out(f, X, '医生说，以你们现在的年纪，再要孩子会很难。你们沉默了很久，最后决定把这份爱给身边的晚辈。', [0, -3, 0, 2, 0], { feasible: false, note: '年龄所限' });
  return out(f, X, f.hasKids ? '你和{partner}商量好了，决定再要一个孩子。家里又开始收拾出一个小小的角落。' : '你和{partner}决定要一个孩子。你们开始调整作息、存钱，偷偷给未来的孩子想名字。孩子什么时候来，就交给缘分吧。',
    [0, 3, 0, 3, -0.5], { set: { flags: { wantChild: f.year, childfree: false } } });
};
A.wait_child = (f, X) => out(f, X, '你们决定再等几年，先把工作和住处安顿好。父母那边的催促，你们笑着应付了过去。', [0, 0, 0, 0, 1], { set: { flags: { childLater: f.year } } });
A.childfree = (f, X) => out(f, X, '你们认真想过，决定不要孩子。两个人的生活也可以很完整。亲戚的追问，你们学会了微笑带过。', [0, 2, 0, -1, 1], { set: { flags: { childfree: true, wantChild: false } } });
A.adopt = (f, X) => {
  const able = (f.couple || f.hic) && f.age >= 25 && f.age <= 60 && resources(f) > 6 * f.monthRef;
  if (!able) return out(f, X, '你打听了领养的手续：年龄、收入、家庭状况，每一项都有要求。眼下的条件还不够，你把材料清单仔细收了起来。', [0, -1, 1, 0, 0], { feasible: false, note: '领养条件不足' });
  const sex = X.rng.chance(0.5) ? 'female' : 'male';
  const nm = personName(X.data, f.iso, sex, X.rng);
  const we = f.couple ? '你们' : '你';
  const t = th(f, X, 2, '家里来了一个孩子', `漫长的手续终于办完，${we}把${nm}接回了家。第一晚TA紧紧攥着你的衣角睡着了。`, [0, 7, 0, 5, -3], { flags: { adopted: nm } });
  t.set.addChild = { name: nm, sex, birthYear: f.year - X.rng.int(1, 5), adopted: true };
  return out(f, X, `${we}递交了领养申请，接受了家访和培训。等待的日子里，${we}把一间小屋刷成了浅黄色。`, [0, 3, 1, 2, -1], { set: { flags: { adoptPlan: f.year } }, threads: [t] });
};
A.care_parents = (f, X, p = {}) => {
  if (!f.parentAlive) return out(f, X, '父母已经不在了。你把这份心意给了身边的长辈：常去看看楼下独居的老人，帮他们买菜、修修东西。', [0, 2, 0, 4, 0], { feasible: false, note: '父母已故' });
  const mode = p.mode || 'visit';
  const pw = parentWord(f);
  const they = pw === '父母' ? '他们' : pw === '母亲' ? '她' : '他';
  const call = f.videoCall ? '视频' : '打电话';
  const T = {
    move_in: [`你把年迈的${pw}接到身边同住。家里挤了些，饭桌上却热闹了。只是老人住不惯新地方，总念叨着老家的院子。`, [-1, 1, 0, 6, -2], { flags: { parentsLiveIn: true } }],
    move_back: [`你辞掉了外地的工作，搬回${pw}身边照顾${they}。收入少了一大截，可每天都能陪${they}吃饭、散步。`, [0, 2, 0, 7, -4], { urban: f.ruralOrigin ? false : f.u, career: f.working ? { incomePct: PCT(f, -0.12) } : undefined, flags: { returnedHome: true, caregiver: true } }],
    hire: [`你给${pw}请了护工，每个月的开销不小。你每周${call}、每月回去一次，心里还是常常放不下。`, [0, -1, 0, 2, -6], { flags: { hiredCarer: true } }],
    home: [`你们商量后，把${pw}送进了一家口碑不错的养老院。第一次离开时，${pw === '父母' ? '母亲' : pw}站在窗口一直看着你，你在车里坐了很久才开走。`, [0, -3, 0, 1, -5], { flags: { parentsCareHome: true } }],
    visit: [`你答应自己：再忙也要常回家看看。你开始每周给${pw}${call}，每月回去一趟，把家里的灯泡、水管都修好。`, [-1, 2, 0, 5, -1], { flags: { visitParents: true } }],
  }[mode] || null;
  const [txt, arr, set] = T || [`你开始花更多时间照顾${pw}。`, [0, 2, 0, 5, -1], {}];
  const later = { move_in: '同住的这几年，你学会了做老人爱吃的软烂饭菜，也学会了耐心听那些讲过很多遍的故事。', move_back: '回到老人身边的这几年，你错过了一些机会，却从没后悔过。', hire: '护工换过两任，你也终于找到了一位让人放心的。每次视频，老人都会夸TA几句。', home: '养老院的日子比你想象的好。老人在那里交了朋友，每次去看望，都有说不完的新鲜事。', visit: `这几年，你陪着${pw}走过了不少病痛和节日。${they}常说：“有你在，就不怕。”` }[mode] || `这几年，你陪着${pw}走过了不少病痛和节日。`;
  return out(f, X, txt, arr, { set, threads: [th(f, X, 3, `${pw}的晚年`, later, [0, 3, 0, 4, 0])] });
};
A.bring_parents = (f, X, p = {}) => {
  // a partner or children who stayed at home when the person left come first
  if (f.flags.familyBehind && (f.couple || f.hasKids)) {
    const ok = resources(f) > 6 * f.monthRef && X.rng.chance(0.65);
    const who = f.couple ? (f.hasKids ? '{partner}和孩子' : '{partner}') : '孩子';
    return ok ? out(f, X, `你给${who}办好了手续，把${who === '孩子' ? '他们' : '一家人'}接了过来。在机场接到他们的那一刻，你才发现自己有多想念。从此一家人又能围着一张桌子吃饭了。`, [0, 7, 0, 7, -5], { set: { flags: { familyBehind: false, familyJoined: f.year } } })
      : out(f, X, `你想把${who}接过来，可签证和费用都卡在那里。你们只好约定，每天晚上视频说说话，等条件好了再团聚。`, [0, -3, 0, 1, -0.5], { feasible: false, note: '签证或费用受限' });
  }
  if (!f.parentAlive) return A.care_parents(f, X);
  const pw = parentWord(f);
  const ok = resources(f) > 8 * f.monthRef && X.rng.chance(0.55);
  return ok ? out(f, X, `你给${pw}办好了签证，把${pw === '父母' ? '他们' : pw === '母亲' ? '她' : '他'}接到身边住了一段时间。老人每天在小区里散步，学会了用当地话说“你好”。`, [0, 5, 0, 6, -4], { set: { flags: { parentsVisited: true } } })
    : out(f, X, `你想把${pw}接来，可签证和费用都卡在那里。你们只好约定，每年视频里一起过节。`, [0, -3, 0, 1, -0.5], { feasible: false, note: '签证或费用受限' });
};
A.grandkids_care = (f, X) => out(f, X, '你接过了带孙辈的担子：早上送去学校、傍晚接回来、晚上陪着写作业。腰酸背疼，可孩子一声软软的呼唤，你就什么都忘了。',
  [-1, 4, 0, 6, -0.5], { set: { flags: { grandparent: true, grandkidCare: true } } });
A.kid_abroad = (f, X) => {
  const we = f.couple ? '你们' : '你';
  if (resources(f) < 30 * f.monthRef && !f.famRich) return out(f, X, `送孩子出国读书的花费，抵得上家里多年的积蓄。${f.couple ? '你们商量后' : '你想了很久'}，决定让孩子在国内好好读，将来再说。`, [0, -1, 0, 2, 0], { feasible: false, note: '留学费用过高' });
  const stay = X.rng.chance(0.5);
  return out(f, X, `${we}送{child}出国读书。机场分别时，你一直挥手到看不见TA的背影，回家的路上${f.couple ? '谁也没说话' : '你一句话也没说'}。`, [0, -2, 0, 1, -18],
    { set: { flags: { kidAbroad: true } }, threads: [th(f, X, 5, '远方的孩子', stay ? `{child}在国外找到了工作，决定留在那里。${we}隔着时差视频，看着TA一点点长成大人。` : `{child}学成回国，在离家不远的城市工作。${we}终于又能常常一起吃饭了。`, stay ? [0, 1, 0, -1, 0] : [0, 4, 0, 3, 0])] });
};
A.kid_tutor = (f, X) => out(f, X, '你给{child}报了补习班，周末接送、陪着刷题。孩子的成绩提高了一些，你们之间的话却少了。', [-1, -1, 0, -1, -3]);
A.kid_free = (f, X, p = {}) => out(f, X, p.young
  ? '你没有给{child}报一堆补习班，放学后就让TA去玩、去读自己喜欢的书。成绩不算拔尖，可孩子每天都乐呵呵的，好奇心也一直没丢。'
  : '你决定让{child}自己选择。TA选了一条你没想到的路，你忍住了劝阻，只说了一句：“家永远在这儿。”', [0, 2, 0, 4, 0]);
A.school_district = (f, X) => {
  const r = A.buy_home(f, X, { district: true });
  r.narrative = '为了孩子上一所好学校，' + r.narrative;
  return r;
};

// ---- money
A.buy_home = (f, X, p = {}) => {
  if (p.hometown && f.age >= 18) {
    const needH = (f.chn || f.hic ? 14 : 10) * f.monthRef;
    if (resources(f) < needH * 0.6) return out(f, X, '老家的房子便宜不少，可首付还是差了一截。你和家里商量，再攒两年。', [0, -1, 1, 0, 0], { feasible: false, note: '首付不足', set: { flags: { savingForHome: f.year } } });
    return out(f, X, `你在老家的${f.chn ? '县城' : '镇上'}买了一套房子。月供不重，逢年过节回去，终于有了一个属于自己的落脚处。${f.parentAlive ? '父母隔三岔五就去帮你开窗通风。' : ''}`, [0, 4, 0, 3, -4],
      { set: { flags: { homeowner: true, mortgage: f.year, hometownHome: true } } });
  }
  const downM = f.chn || f.hic ? 36 : f.umc ? 24 : 18;
  const need = downM * f.monthRef;
  const res = resources(f);
  const help = f.age <= 40 && f.fam >= 0.55;
  if (res < need * 0.6 && !help) {
    return out(f, X, '你算了又算，首付还差一大截。你把看过的房子信息存在手机里，决定再攒几年。', [0, -2, 1, 0, 0], { feasible: false, note: '首付不足', set: { flags: { savingForHome: f.year } }, threads: [th(f, X, 4, '攒首付', '几年省吃俭用，你的存款终于够得上一套小房子的首付了。', [0, 2, 0, 0, 2])] });
  }
  const later = f.chn && f.year + 5 >= 2022 && f.year + 5 <= 2030 ? 'down' : f.recession ? 'down' : X.rng.chance(0.6) ? 'up' : 'flat';
  const tx = { down: '房价一路下跌，你的房子比买入时便宜了不少。好在你是自己住，也就不去多想了。', up: '这几年房价涨了一些，你的房子成了家里最值钱的东西，月供也不再那么吃力。', flat: '房价起起落落，房贷一个月一个月地还着。这套房子渐渐有了家的样子。' }[later];
  return out(f, X, `${help && res < need ? '在家里的帮助下，' : ''}你付了首付，签下了长长的贷款合同。拿到钥匙那天，你在空荡荡的客厅里坐了很久。`, [0, 5, 0, 2, -3],
    { set: { flags: { homeowner: true, mortgage: f.year } }, threads: [th(f, X, 5, '房子', tx, later === 'down' ? [0, -3, 0, 0, 0] : later === 'up' ? [0, 3, 0, 0, 2] : [0, 1, 0, 1, 0])] });
};
A.rent_invest = (f, X) => {
  const r = X.rng.normal(f.finCrisis ? -0.2 : 0.25, 0.3);
  return out(f, X, '你决定继续租房，把攒下的钱拿去做长期投资。房东换了两任，你的账户在慢慢变厚。', [0, 1, 1, 0, 0],
    { set: { flags: { investor: 'stocks' } }, threads: [th(f, X, 5, '五年的账', r >= 0 ? '五年下来，你的投资涨了不少，租房的日子也过得心安理得。' : '五年下来，市场起伏，账户上的数字并不好看。你开始怀疑当初的选择。', r >= 0 ? [0, 3, 1, 0, Math.round(r * 24)] : [0, -3, 1, 0, Math.round(r * 18)])] });
};
A.invest_stocks = (f, X, p = {}) => {
  const mu = f.finCrisis ? -0.15 : f.recession ? -0.05 : 0.18;
  const r = X.rng.normal(mu, 0.28);
  return out(f, X, p.windfall ? '你把这笔钱买了指数基金，告诉自己十年之内不去动它。' : '你拿出一部分积蓄买了股票和基金。最初的几个月，你每天都要看好几遍行情。', p.windfall ? [0, 2, 1, 0, 6] : [0, 1, 2, 0, 0],
    { set: { flags: { investor: 'stocks' } }, threads: [th(f, X, 3, '股市三年', r >= 0.1 ? '三年过去，你的投资收获颇丰。你学会了不追涨杀跌，也学会了耐心。' : r >= -0.1 ? '三年过去，账户不赚不赔，你倒是学会了心平气和地看待涨跌。' : '一场下跌让你的账户缩水了一大截。你把软件删了，决定以后只买指数、不再频繁操作。', r >= 0.1 ? [0, 3, 1, 0, Math.round(r * 15)] : r >= -0.1 ? [0, 0, 1, 0, 0] : [0, -4, 1, 0, Math.round(r * 12)])] });
};
A.invest_crypto = (f, X) => {
  if (f.year < 2011) return A.save(f, X);
  const roll = X.rng.next();
  const res = roll < 0.35 ? 'boom' : roll < 0.8 ? 'bust' : 'flat';
  return out(f, X, '你拿了一笔钱买加密货币，研究了一晚上的白皮书和行情图，半夜还在刷论坛。', [-1, 1, 1, 0, 0],
    { set: { flags: { crypto: true } }, threads: [th(f, X, 2, '币圈两年', { boom: '行情暴涨，你的账户翻了好几倍。你在高点卖掉了一半，手还在抖。', bust: '一轮暴跌之后，你的投入只剩下零头。你关掉了所有群聊，决定不再碰它。', flat: '两年来大起大落，最后你不赚不赔地离了场，倒是练出了一颗大心脏。' }[res], res === 'boom' ? [0, 5, 1, 0, 14] : res === 'bust' ? [-1, -6, 1, -1, -6] : [0, -1, 1, 0, 0])] });
};
// a concrete investing plan from the player's own words (investPlanOf): the market and style go into flags, and from
// then on the yearly finances follow that market's real returns (2000-2025) or the world line's projection
A.invest_plan = (f, X, p = {}) => {
  const style = ['dca', 'all_in', 'trader', 'gold', 'bonds'].includes(p.style) ? p.style : 'dca';
  const M = p.where || (p.market ? MARKET_NAMES[p.market] : '指数基金');
  if (f.age < 18) {
    return out(f, X, '你还没成年，开不了自己的账户。你把压岁钱交给爸妈，请他们帮你存起来，等长大了再说。', [0, 1, 1, 0, 0],
      { feasible: false, note: '未成年不能自己开户', set: { flags: { saver: true } } });
  }
  const flags = { investStyle: style, investSince: f.year, investMarket: p.market || null, investor: style === 'gold' || style === 'bonds' ? null : 'stocks' };
  if (style === 'gold') return out(f, X, '你开始每个月买一点黄金，放在银行的账户里。涨涨跌跌你不太在意，图的是一个踏实。', [0, 1, 1, 0, 0], { set: { flags } });
  if (style === 'bonds') return out(f, X, '你把闲钱放进了国债和债券基金。收益不高，但几乎不用操心，每年稳稳地多出一点。', [0, 1, 1, 0, 0], { set: { flags } });
  if (style === 'all_in') {
    return out(f, X, `你把手头大部分积蓄一次性买进了${M}，只留了一点应急的钱。按下确认键的那一刻，你手心全是汗。`, [-1, 0, 1, -1, 0],
      { set: { flags } });
  }
  if (style === 'trader') {
    return out(f, X, `你开始炒${M}的短线：每天盯盘、追消息、看各路分析，上班时也忍不住打开行情软件。`, [-2, -1, 2, -1, 0],
      { set: { flags } });
  }
  const abroad = p.market && p.market !== 'cn_stocks' && f.chn;
  return out(f, X, `你${abroad ? '买了跟踪' : '开了证券账户，买了'}${M}${abroad ? '的 QDII 基金' : '的指数基金'}，设好每月发工资后自动定投。你给自己定了规矩：跌了不卖，涨了不追，十年之内不去动它。`,
    [0, 1, 2, 0, 0], { set: { flags } });
};

// earning money with AI tools (aiKindOf): the plan is concrete, the outcome is not guaranteed; a success adds a side
// income for some years (flags.sideIncome, in median incomes), until competition catches up
A.ai_hustle = (f, X, p = {}) => {
  if (f.year < 2016) return A.side_hustle(f, X);
  if (f.age < 14) return A.retrain_ai(f, X);
  const kind = p.kind || 'mixed';
  const early = f.year < 2023 ? -0.12 : f.year <= 2028 ? 0.08 : f.year >= 2040 ? -0.08 : 0;
  const skill = (f.flags.aiSkill ? 0.12 : 0) + (f.flags.coder && (kind === 'app' || kind === 'freelance') ? 0.12 : 0) + (f.eduRank >= 5 ? 0.05 : 0);
  const hard = { app: -0.08, content: -0.06, shop: -0.04, teach: 0, copy: 0.04, art: 0.02, freelance: 0, mixed: -0.04 }[kind] || 0;
  // most side businesses do not take off; knowledge, real skill and being early help
  const pGood = clampN(0.15 + (f.know - 60) / 150 + early + skill + hard - (f.age > 60 ? 0.1 : 0), 0.05, 0.7);
  const good = X.rng.chance(pGood);
  const big = good && X.rng.chance(kind === 'app' || kind === 'content' ? 0.18 : 0.08);
  const start = {
    content: '你开了一个账号，用 AI 写脚本、配音、剪视频，下班后一周更新三条。',
    copy: '你在接单平台上挂出了“AI 辅助文案”：AI 起草，你自己改稿把关，一单几十到几百块。',
    art: '你用 AI 绘图工具做头像、插画和海报，挂在网店里卖，也接定制。',
    app: '你让 AI 帮你写代码，花了几个月下班时间，做出一个能解决小麻烦的工具，上线后开始收费。',
    shop: '你开了一家网店，用 AI 写商品文案、做主图、回客服消息，一个人顶了一个小团队。',
    teach: '你把自己摸索出的 AI 用法整理成课程和社群，开始在网上招学员。',
    freelance: '你学着用 AI 给自己提速，在外包平台上接项目，同样的活儿比以前快了一倍。',
    mixed: '你琢磨怎么用 AI 赚钱：做内容、接文案单、卖图，一样一样地试。',
  }[kind];
  const yrs = X.rng.int(1, 2);
  const k = big ? (kind === 'app' ? 2 : 1.2) : good ? 0.25 + X.rng.next() * 0.35 : 0;
  const lasts = big ? X.rng.int(6, 12) : X.rng.int(3, 7);
  const share = k >= 1 ? `比你的工资还多` : k >= 0.45 ? '快赶上半份工资了' : '每个月能多出一笔零花钱';
  const later = big
    ? { content: '账号突然火了，粉丝涨到几十万，广告商开始主动找上门。', app: '工具被越来越多人用上，付费用户一个月比一个月多。' }[kind] || '口碑慢慢传开，回头客和转介绍越来越多。'
    : null;
  const text = good
    ? `${later || '一开始没什么动静，你没有放弃，一点点摸到了门道。'}这份用 AI 做起来的副业，${share}。`
    : {
      content: '做了一年多，播放量一直上不去。用 AI 做视频的人太多了，你的内容淹没在里面，最后停更了。',
      copy: '单价被越压越低：客户发现自己也会用 AI 了。你接的单越来越少，最后不了了之。',
      art: '平台上 AI 图越来越多，价格一路被压到几块钱一张。你算了算时间成本，收了手。',
      app: '产品上线后用的人不多，服务器和接口的钱倒是每个月都在扣。你把它下线了，学到的东西留了下来。',
      shop: '流量越来越贵，同款越来越多。网店撑了一阵，最后关掉了。',
      teach: '学员没招到几个，同类课程铺天盖地。你把课程挂在网上，没再花心思。',
      freelance: '项目时有时无，回款也慢。你最后还是把重心放回了本职工作上。',
      mixed: '试了一圈，每样都挣到一点点，但没有一样做得起来。你最后收了心。',
    }[kind];
  return out(f, X, start, [-1, 1, 3, 0, kind === 'app' ? -0.5 : -0.2], {
    set: { flags: { aiSkill: true, sideHustle: true, aiHustle: kind } },
    threads: [th(f, X, yrs, 'AI 副业', text, good ? [0, big ? 6 : 3, 2, 0, 0] : [0, -2, 2, 0, 0],
      good ? { flags: { sideIncome: Math.round(k * 100) / 100, sideIncomeUntil: f.year + yrs + lasts } } : null)],
  });
};
A.invest_property = (f, X) => {
  if (resources(f) < 30 * f.monthRef) {
    return out(f, X, '你看了好几套房子，算来算去，首付还是凑不齐。你决定把钱先存着，等手头宽裕了再说。', [0, -1, 1, 0, 0], { feasible: false, note: '首付不足', set: { flags: { saver: true } } });
  }
  const down = (f.chn && f.year >= 2019) || f.recession;
  return out(f, X, '你又买了一套房子用来出租。看房、谈价、装修，你忙了大半年，第一个租客搬进来时你松了一口气。', [-1, 2, 1, 0, -6],
    { set: { flags: { landlord: true } }, threads: [th(f, X, 5, '房东的账', down ? '房价下跌、租客难找，这套房子成了一笔沉甸甸的负担。' : '租金稳稳地进账，房子也升了值。这笔投资让你的晚年多了一份底气。', down ? [-1, -4, 1, 0, -6] : [0, 3, 1, 0, 10])] });
};
A.save = (f, X, p = {}) => out(f, X, p.windfall ? '你把这笔钱原封不动地存进了银行，没对太多人提起。心里多了一份底气，走路都踏实了些。' : X.pick(['你开始认真记账，每个月发了工资先存一部分。看着存款一点点变多，你心里踏实了不少。', '你给自己立了规矩：不乱花钱、不跟风消费。一年下来，存下的钱比你想象的多。']),
  p.windfall ? [0, 3, 0, 0, 8] : [0, 1, 1, 0, 0], { set: { flags: { saver: true } }, threads: [th(f, X, 5, '攒下的底气', '几年攒下来的钱，在一次急用时派上了大用场。你庆幸自己当初的坚持。', [0, 3, 0, 1, 4])] });
A.spend = (f, X, p = {}) => out(f, X, p.windfall ? '你用这笔钱带全家出去玩了一趟，又给每个人都买了一样念叨很久的东西。钱花出去了，笑声留了下来。' : '你决定犒劳自己一回：买了一直想要的东西，带家人去吃了一顿好的。钱花出去了，笑声也留了下来。', p.windfall ? [0, 6, 0, 4, 4] : [0, 5, 0, 2, -4]);
A.gamble = (f, X, p = {}) => {
  if (p.kind === 'lottery') {
    return X.rng.chance(0.12) ? out(f, X, '你买的彩票中了个小奖，不多不少，刚好够请全家人吃一顿好的。', [0, 3, 0, 1, 0.5])
      : out(f, X, '你隔三岔五买上几张彩票，开奖前总要想一想中了奖怎么花。一年下来没中什么大奖，你也就当花钱买了个念想。', [0, 1, 0, 0, -0.3]);
  }
  const win = X.rng.chance(0.15);
  return win ? out(f, X, '你试了试手气，竟然赢了一笔。朋友们起哄让你请客，你却把这笔钱存了起来，从此再没碰过。', [0, 4, 0, 1, 3])
    : out(f, X, '你一次次想把输掉的赢回来，结果越陷越深。等你清醒过来，积蓄已经少了一大截，家人看你的眼神也变了。', [-1, -6, 0, -4, -6], { set: { flags: { gambler: true } }, threads: [th(f, X, 2, '戒赌', '你在家人的陪伴下戒了赌，把欠的钱一笔笔还上。那段日子，你不愿再提起。', [0, 3, 1, 3, 0], { flags: { gambler: false } })] });
};

// ---- health
A.exercise = (f, X) => out(f, X, f.age >= 60 ? '你每天早上去公园走两圈、打一套拳，风雨无阻。几个月后，上楼梯不再喘了。' : X.pick(['你开始每天跑步，从两公里跑到五公里。三个月后，你发现自己的睡眠和心情都好了许多。', '你办了健身卡，又约了朋友一起打球。身上的赘肉少了，精神头足了。']),
  [5, 3, 0, 1, -0.2], { hz: [0.9, 10, '坚持锻炼'], set: { flags: { exercise: true } }, threads: [th(f, X, 5, '坚持的回报', '几年的锻炼让你比同龄人显得年轻，体检报告上的箭头也少了。', [3, 2, 0, 1, 0])] });
A.quit_smoking = (f, X) => {
  if (!f.smoker) return out(f, X, '你本来就不抽烟，于是把“戒烟”换成了戒掉熬夜和少喝酒。几个月后，你发现早上起床轻松了很多。', [3, 2, 0, 0, 0], { hz: [0.95, 5, '改掉坏习惯'] });
  const ok = X.rng.chance(clampN(0.4 + (f.health < 50 ? 0.12 : 0) + (f.couple ? 0.05 : 0), 0.2, 0.7));
  return ok ? out(f, X, '你把最后一包烟扔进了垃圾桶。最难熬的头几个月，你嚼了无数块口香糖。一年后，你爬楼梯时终于不再咳嗽了。', [5, 2, 0, 1, 1], { hz: [0.85, 15, '戒烟'], set: { flags: { smoker: false, exSmoker: true } } })
    : out(f, X, '你试着戒烟，坚持了三个月，又在一个加班的深夜复吸了。你对自己说：下次一定。', [0, -2, 0, 0, 0], { threads: [th(f, X, 2, '再戒一次', '这一次，你在医生的帮助下终于戒掉了烟。', [4, 3, 0, 1, 0], { flags: { smoker: false, exSmoker: true } })] });
};
A.diet = (f, X, p = {}) => (p.kind === 'screen'
  ? out(f, X, '你给手机设了使用时限，晚上把它放在客厅充电。头几天手痒得难受，后来发现一天里多出了好多时间：读书、散步、和身边的人好好说话。', [1, 2, 2, 1, 0], { set: { flags: { screenLimit: f.year } } })
  : p.kind === 'sleep'
  ? out(f, X, '你给自己定了规矩：晚上十一点前放下手机，早上按时起床。头几周辗转反侧，后来渐渐睡得踏实了，白天的精神也好了许多。', [3, 2, 1, 0, 0], { hz: [0.96, 5, '规律作息'], set: { flags: { goodSleep: true } } })
  : out(f, X, '你开始调整饮食：少油少盐、多吃蔬菜，晚饭只吃七分饱。体重慢慢降了下来，体检报告也好看了。', [3, 1, 1, 0, 0], { hz: [0.95, 6, '健康饮食'], set: { flags: { healthyDiet: true } } }));
A.health_check = (f, X) => {
  const found = X.rng.chance(clampN(0.15 + f.age / 220, 0.1, 0.6));
  const has = (id) => f.hasCond(id);
  const cond = !has('hypertension') ? { id: 'hypertension', name: '高血压', severity: 1 } : !has('diabetes') ? { id: 'diabetes', name: '糖尿病', severity: 1 } : null;
  if (found && cond && f.age >= 30) return out(f, X, `体检查出了早期的${cond.name}。医生说发现得早，按时吃药、调整生活习惯，完全可以控制住。你庆幸自己来了这一趟。`, [-1, -2, 1, 0, -0.5], { hz: [0.92, 8, '早发现早治疗'], set: { addCondition: cond } });
  return out(f, X, f.physicians < 0.5 ? '你走了很远的路去县里的医院做了检查。医生说没什么大问题，叮嘱你注意休息。回来的路上，你觉得脚步都轻了。' : '你做了一次全面体检，结果大多正常。医生叮嘱了几句，你把报告仔细收好，心里一块石头落了地。', [1, 3, 0, 0, -0.3], { hz: [0.97, 3, '定期体检'] });
};
A.therapy = (f, X) => {
  const lift = X.rng.chance(0.65);
  const set = f.hasCond('depression') && lift ? { removeCondition: 'depression' } : {};
  return out(f, X, f.physicians < 0.6 ? '你鼓起勇气，把压在心里的事告诉了社区里的健康工作者，又加入了一个互助小组。说出口的那一刻，你觉得胸口松了一些。' : '你开始定期去见心理咨询师。一开始你不知道该说什么，后来你发现，原来那些情绪都有名字，也都有办法。',
    [1, 5, 1, 3, -1], { set, threads: [th(f, X, 1, '慢慢变好', lift ? '一年后，你发现自己又能为小事开心了。你学会了照顾自己的情绪。' : '情绪时好时坏，但你知道该向谁求助了，这本身就是很大的进步。', lift ? [1, 4, 0, 1, 0] : [0, 1, 0, 1, 0])] });
};
A.crisis_support = (f, X) => out(f, X, '在最难熬的那个夜里，你拨通了一个信得过的人的电话，把一切都说了出来。第二天，你在家人的陪伴下去见了医生。日子没有一下子变好，但你不再是一个人扛着了。（如果你在现实中也有这样的念头，请联系身边信任的人或当地的心理援助热线。）',
  [1, 4, 0, 5, 0], { set: { flags: { soughtHelp: f.year } }, threads: [th(f, X, 1, '一点点亮起来', '这一年，你按时复诊、慢慢运动，也重新联系上了几个老朋友。某个清晨，你发现自己期待起了新的一天。', [2, 5, 0, 3, 0])] });
A.ignore_health = (f, X) => {
  const scare = X.rng.chance(0.4 + f.age / 300);
  return out(f, X, '你觉得自己身体还扛得住，体检通知被扔在了一边，熬夜、外卖照旧。', [0, 1, 0, 0, 0], { hz: [1.15, 5, '忽视健康'], threads: [th(f, X, 3, '身体的账单', scare ? '一次突然的晕倒把你送进了医院。医生的话很直接：“你的身体在报警。”' : '这几年你常常觉得累，精神也大不如前。', scare ? [-6, -4, 0, 1, -1] : [-3, -1, 0, 0, 0])] });
};
A.treatment_aggressive = (f, X) => {
  const cost = f.hic ? 3 : f.umc ? 8 : 12;
  const afford = resources(f) > cost * f.monthRef * 0.7 || f.hic;
  const ok = X.rng.chance(clampN(0.5 + (f.health - 40) / 120 + f.physicians / 20, 0.2, 0.85));
  return out(f, X, `${afford ? '' : '为了凑治疗费，家里四处借钱。'}你选择了最积极的治疗：手术、住院、一轮又一轮的复查。那段日子很难熬，家人轮流守在你身边。`, [-3, -2, 0, 3, -cost],
    { hz: ok ? [0.7, 6, '积极治疗'] : [0.9, 3, '积极治疗'], set: ok && f.conds.some((c) => num(c.severity, 1) >= 2) ? { removeCondition: f.conds.find((c) => num(c.severity, 1) >= 2).id } : {}, feasible: true, note: afford ? undefined : '治疗费用沉重',
      threads: [th(f, X, 2, '治疗之后', ok ? '复查结果让医生都露出了笑容，病情得到了控制。你开始重新安排自己的日子。' : '治疗的效果不如预期，但你学会了和疾病共处，珍惜每一个平常的日子。', ok ? [4, 5, 0, 2, 0] : [-2, -1, 0, 2, 0])] });
};
A.treatment_standard = (f, X) => out(f, X, '你听从医生的建议，按部就班地治疗、吃药、复查。病情稳住了，生活也慢慢回到了正轨。', [1, 1, 0, 1, -2], { hz: [0.88, 4, '规范治疗'] });
A.treatment_traditional = (f, X) => out(f, X, '你在规范治疗之外，也试了些传统疗法和调养的办法。身体说不上好了多少，但心里安稳了许多。医生提醒你，复查一次都不能落下。', [0, 3, 0, 1, -1], { hz: [0.97, 3, '调养'] });
A.treatment_palliative = (f, X) => out(f, X, '你和家人商量后，选择了舒缓治疗：不再追求延长时间，而是让每一天都少些痛苦。你把想见的人都见了一遍，把想说的话都说了出来。',
  [0, 5, 0, 6, -1], { set: { flags: { palliative: f.year } } });
A.treatment_abroad = (f, X) => {
  // "elsewhere" is another big city of the country (or, from a city-state, a hospital abroad)
  const city = otherCity(f, X);
  const where = city || '国外';
  if (resources(f) < (city ? 18 : 30) * f.monthRef) {
    const r = A.treatment_standard(f, X);
    r.feasible = false;
    r.note = '异地就医费用过高';
    r.narrative = `去${where}看病的路费、住宿和医药费加起来太多，你最终留在本地治疗。` + r.narrative;
    return r;
  }
  return out(f, X, `你去了${city ? `${city}的大医院` : '国外的一家大医院'}看病。陌生的地方、排不完的队，可那里的医生给了你新的希望。`, [-1, 2, 1, 2, city ? -18 : -30], { hz: [0.75, 5, '异地治疗'] });
};

// ---- meaning, people, the wider world
A.volunteer = (f, X, p = {}) => out(f, X, p.windfall ? '你把这笔钱的一部分捐给了家乡的学校，剩下的存了起来。开学那天，校长发来一张照片：新书桌上贴着一张小小的感谢卡。' : X.pick(['你开始周末去做志愿者：在社区教孩子读书、陪独居老人聊天。忙了一天回家，心里反倒很满。', '你加入了一个公益团体，帮着筹物资、搬东西、做登记。你在那里认识了一群可爱的人。']),
  p.windfall ? [0, 5, 0, 4, 3] : [1, 4, 1, 5, 0], { set: { flags: { volunteer: true } }, threads: [th(f, X, 3, '志愿路上的人', '做志愿时认识的朋友，成了你生活里重要的一部分。有一次你遇到难处，第一个赶来的就是他们。', [0, 3, 0, 4, 0])] });
A.faith = (f, X, p = {}) => {
  const T = {
    mosque: f.muslim ? '你更常去清真寺了。在礼拜的寂静里，你找到了一种安宁，也认识了许多互相照应的邻里。' : '你开始去清真寺参加聚礼，跟着学习经文。在礼拜的寂静里，你找到了一种安宁，也认识了许多互相照应的人。',
    church: '你开始去教堂参加礼拜，在歌声和祈祷里找到了平静，也找到了一群彼此扶持的人。',
    temple: f.buddhist ? '你开始在清晨给化缘的僧人布施，节日里去寺院静坐、听经。心里的那些焦躁，好像慢慢沉了下去。' : '你开始去寺庙里静坐、听讲，也跟着做一些善事。心里的那些焦躁，好像慢慢沉了下去。',
    monastic: '你去寺院住了一段时间，跟着早晚课作息，扫地、劈柴、抄经。外面的世界照常喧闹，你的心却慢慢安静下来。',
    taoist: '你开始去山上的道观走走，学着打坐、练功，也读了几本老庄。心里的那些焦躁，好像慢慢沉了下去。',
  };
  const kind = T[p.kind] ? p.kind : f.muslim ? 'mosque' : f.buddhist || f.sinic || ['JPN', 'KOR', 'VNM', 'NPL', 'BTN'].includes(f.iso) ? 'temple' : null;
  return out(f, X, kind ? T[kind] : '你开始参加宗教聚会，在歌声和祈祷里找到了平静，也找到了一群彼此扶持的人。',
    [0, 4, 1, 4, 0], { set: { flags: { faith: p.kind || true } } });
};
A.activism = (f, X) => {
  const change = X.rng.chance(0.4);
  return out(f, X, '你开始参与社区里的公共事务：开会、写倡议、组织邻居一起发声。你学会了和不同意见的人好好说话。', [-1, 2, 3, 4, 0],
    { set: { flags: { civic: true } }, threads: [th(f, X, 2, '一点点改变', change ? '你们推动的事情终于有了结果，街角多了一座小公园。邻居们见了你都会打招呼。' : '事情推进得很慢，有人放弃了，你也累过。可你觉得，至少大家开始在乎了。', change ? [0, 5, 1, 3, 0] : [-1, -1, 1, 1, 0])] });
};
A.travel = (f, X, p = {}) => {
  const far = resources(f) > 6 * f.monthRef && !f.lic;
  const where = p.dest && p.dest !== f.iso ? nameOf(X.data, p.dest) : typeof p.place === 'string' && p.place ? p.place.slice(0, 8) : null;
  const abroad = !!(p.dest && p.dest !== f.iso);
  if (!far) return out(f, X, '远行的钱一时凑不齐，你就去了附近从没去过的山和湖。原来身边也有这么多风景。', [1, 4, 1, 1, -0.5], { feasible: !abroad, note: abroad ? '出国旅行的费用不足' : undefined });
  if (abroad && destAtWar(X, p.dest, f.year)) return out(f, X, `你本想去${where}看看，可那里正在打仗，航班停了，签证也办不下来。你把这趟旅行改成了国内的几个地方，心里却一直惦记着那边的人。`, [1, 3, 1, 1, -1.5], { feasible: false, note: '目的地正处于战乱' });
  if (p.together) return out(f, X, where ? `你带着家人去了${where}。一路上有争吵也有大笑，回来以后，那些照片被你们翻看了一遍又一遍。` : '你带着家人出门旅行了一趟。一路上有争吵也有大笑，回来以后，那些照片被你们翻看了一遍又一遍。', [2, 6, 1, 5, -4], { set: { flags: { traveler: true } } });
  return out(f, X, where ? (abroad ? `你去了${where}旅行。陌生的语言、陌生的街道，你在那里迷了路，也遇见了很多好人。` : `你去了${where}旅行。陌生的街道、地道的小吃，你在那里迷过路，也遇见了不少热心人。`) : '你背上行囊去了远方。站在从没到过的地方，你觉得世界很大，自己的烦恼很小。', [2, 6, 3, 1, -3], { set: { flags: { traveler: true } } });
};
A.learn_hobby = (f, X, p = {}) => {
  const thing = typeof p.thing === 'string' && p.thing ? p.thing.slice(0, 8) : '一门新手艺';
  return out(f, X, `你开始学${thing}。头几次手忙脚乱，后来渐渐有了样子，你把成果拿给身边的人看，大家都夸你进步快。`, [1, 4, 3, 2, -0.3], { set: { flags: { hobby: thing } } });
};
A.art_career = (f, X, p = {}) => {
  const kind = p.kind || 'artist';
  // [what you devote yourself to, who you become, what you make, what you do in the evenings]
  const K = { artist: ['画画', '画家', '画作', '画画'], writer: ['写作', '作家', '书', '写作'], musician: ['音乐', '音乐人', '歌', '玩音乐'] }[kind] || ['创作', '创作者', '作品', '创作'];
  const young = f.age >= 18 && f.age <= 32 && !f.couple;
  const big = X.rng.chance(clampN(0.06 + (f.know - 50) / 400 + (f.flags.artsy ? 0.06 : 0), 0.02, 0.2));
  const mid = !big && X.rng.chance(0.4);
  const set = young ? { career: { status: 'self_employed', title: `自由${K[1]}`, sector: '文化艺术', incomePct: setPct(Math.min(f.incomePct, 0.3)) }, flags: { creative: kind } } : { flags: { creative: kind } };
  return out(f, X, young ? `你决定全身心投入${K[0]}，做一名自由${K[1]}。收入不稳定，房租常常要靠朋友周转，可你每天醒来都知道自己要做什么。` : `你开始利用业余时间认真${K[3]}。夜深人静的时候，那是只属于你自己的时间。`,
    young ? [-1, 5, 3, 0, -2] : [0, 4, 2, 0, 0], { set, threads: [th(f, X, 5, `${K[1]}之路`, big ? `你的${K[2]}被越来越多的人看到，有人专门写信告诉你，它陪自己度过了难关。` : mid ? `你的${K[2]}有了一小群忠实的读者和听众，虽然发不了财，但足以让你坚持下去。` : `坚持了几年，你的${K[2]}没有什么水花。你找了份正经工作，但${K[0]}还是留在了生活里。`, big ? [0, 8, 2, 3, 10] : mid ? [0, 4, 1, 2, 1] : [0, -2, 1, 0, 1], big ? { career: { incomePct: setPct(f.incomePct + 0.3) } } : !mid && young ? { career: { status: 'employed', title: '职员', sector: '服务业', incomePct: setPct(Math.max(f.incomePct, 0.35)) } } : null)] });
};
A.athlete_career = (f, X) => {
  if (f.age > 26 || f.health < 55) return out(f, X, '职业运动员的路已经不适合你了，你就做一名认真的业余选手：参加比赛、带带新手，赢了就请大家喝汽水。', [4, 4, 0, 3, 0], { set: { flags: { amateurAthlete: true } } });
  const pro = X.rng.chance(clampN(0.05 + (f.health - 60) / 300 + (f.flags.athleteTalent ? 0.15 : 0), 0.02, 0.3));
  return out(f, X, '你全身心投入训练，每天六个小时泡在场馆里。伤病、汗水、一次次的选拔，你都咬牙扛了下来。', [4, 2, -1, 2, -1],
    { set: { flags: { athlete: true } }, threads: [th(f, X, 3, '赛场', pro ? '你签下了第一份职业合同，穿上了梦寐以求的队服。' : '你没能入选职业队。告别训练场那天，你把球鞋擦得干干净净，放进了柜子。', pro ? [3, 7, 0, 3, 6] : [0, -4, 1, 1, 0], pro ? { career: { status: 'employed', title: '职业运动员', sector: '体育', incomePct: jobPct(f, '职业运动员', 0.6, 0.1) } } : null)] });
};
A.learn_language = (f, X) => out(f, X, '你每天早起背单词、跟着音频练口语，周末去语言角和陌生人聊天。半年后，你第一次看懂了一部没有字幕的电影。', [0, 2, 5, 1, -0.5], { set: { flags: { lang: true } } });
A.friends = (f, X) => out(f, X, X.pick(['你主动约了好久没见的朋友，大家一起吃饭、唱歌，聊到很晚。原来你一直没有被忘记。', '你开始参加兴趣小组，认识了一群志同道合的人。周末的日程表一下子满了起来。']), [0, 4, 0, 6, -0.5]);
A.pet = (f, X, p = {}) => out(f, X, `你养了${typeof p.kind === 'string' && p.kind ? p.kind : '一只小动物'}。${p.kind === '一缸鱼' ? '每天下班看着它们在水草间游来游去，心里就静了下来。' : '它每天在门口等你回家，让你的日子多了很多牵挂，也多了很多笑声。'}`, [1, 5, 0, 1, -0.5], { set: { flags: { pet: f.year } } });
A.illegal = (f, X) => {
  const stop = X.rng.chance(0.55);
  return stop ? out(f, X, '这个念头在你脑子里转了好几天。最后你还是收了手——你想到了家人，也想到了一旦走上这条路就很难回头。', [0, -1, 1, 1, 0])
    : out(f, X, '你还是走了那一步，很快就出了事：罚款、调查、亲友的失望。那是你人生里最想抹掉的一段日子。', [-2, -8, 0, -6, -8], { set: { flags: { record: f.year } } });
};

// ---- later life
A.retire = (f, X, p = {}) => {
  // retiring and moving in one step: "回乡养老", "退休后去旅居"
  if (p.then && A[p.then] && p.then !== 'retire') {
    const r = A[p.then](f, X, { ...p, then: undefined });
    if (f.retired || !f.working) return r;
    r.narrative = `你办完了退休手续。${r.narrative}`;
    r.set = merge(r.set || {}, { career: { status: 'retired' } });
    return r;
  }
  if (f.retired) return A.rest(f, X);
  const noPension = f.poorC && (f.farmer || f.selfEmp || !f.employed);
  return out(f, X, noPension ? '你放下了手里的活，决定歇一歇。没有退休金，日子要靠积蓄和孩子们帮衬，可你终于有时间好好睡个午觉了。' : '你办完了退休手续，把工位上的东西收进一个纸箱。第二天早上，你照常醒得很早，然后笑了笑，又闭上了眼睛。',
    noPension ? [2, 2, 0, 2, -1] : [2, 4, 0, 2, 0], { set: { career: { status: 'retired' } }, threads: [th(f, X, 2, '退休后的节奏', `退休第二年，你找到了自己的节奏：早上锻炼，白天读书或带孩子，晚上和${f.couple ? '老伴' : '老朋友'}一起散步。`, [2, 3, 0, 2, 0])] });
};
A.retire_early = (f, X) => {
  const ok = resources(f) > 36 * f.monthRef || (f.hic && f.age >= 55);
  if (!ok) {
    const r = A.part_time(f, X);
    r.feasible = false;
    r.note = '积蓄不足以支撑提前退休';
    r.narrative = '你算了算，积蓄撑不起提前退休的日子。' + r.narrative;
    return r;
  }
  return out(f, X, '你决定提前退休，把余下的时间留给自己。养老金会少一些，可你终于不用再看着闹钟过日子。', [3, 5, 0, 2, -6], { set: { career: { status: 'retired' }, flags: { earlyRetire: f.year } } });
};
A.keep_working = (f, X, p = {}) => {
  if (p.rehire && f.working && !f.retired) {
    return out(f, X, '你办完了退休手续，没过几天又被原单位返聘了回去，干着自己熟悉的活。工资比从前少了些，可年轻人遇到难题都来找你，你觉得自己还有用。', [-1, 2, 1, 2, 3],
      { set: { career: { status: 'employed', incomePct: PCT(f, -0.1) }, flags: { rehired: f.year } } });
  }
  return out(f, X, f.retired ? '你退而不休，被原单位返聘回去，干着自己熟悉的活。年轻人有问题都来找你，你觉得自己还有用。' : '你决定继续工作。身体还行，手艺还在，多干几年也能给家里多攒一点。',
    [-1, 1, 1, 2, 4], { set: f.retired ? { career: { status: 'employed', incomePct: PCT(f, -0.1) } } : {} });
};
A.part_time = (f, X) => out(f, X, '你换成了兼职，每周干三天。剩下的时间，你学会了慢慢喝一杯茶。', [2, 3, 0, 2, 1], { set: { career: { status: f.working ? f.status : 'employed', incomePct: PCT(f, -0.12) } } });
A.senior_school = (f, X) => out(f, X, '你报名了老年大学，学书法、摄影、智能手机。同学们的年纪加起来上千岁，课堂上却总是笑声不断。', [2, 4, 4, 4, -0.5]);
A.return_home = (f, X, p = {}) => {
  const visit = p.visit || f.age >= 85;
  if (f.migrant && f.origin && f.origin !== f.iso) {
    const O = nameOf(X.data, f.origin);
    if (visit) return out(f, X, `你回了一趟${O}。下飞机时闻到熟悉的味道，你在出口站了很久。老街变了很多，可乡音一句没变。`, [0, 6, 0, 3, -3]);
    // the family left at home is waiting; a family abroad comes back together (or the partner stays, if not)
    const behind = !!f.flags.familyBehind && (f.couple || f.hasKids);
    const fam = behind ? null : familyMove(f, X, 0.15);
    const lead = behind ? `你决定回${O}去，和留在家里的${f.couple ? '{partner}' : '孩子'}团聚。` : !fam ? `你决定回${O}去。` : fam.alone ? `你决定回${O}去，{partner}留在了这边，你们约好常常视频。` : `你${fam.together}，决定一起回${O}去。`;
    return out(f, X, `${lead}收拾行李时你发现，自己在异乡攒下的不只是钱，还有一大箱舍不得扔的回忆。`, [1, behind ? 6 : 4, 1, behind ? 5 : 2, -3],
      { set: { country: f.origin, flags: { migrant: false, returnee: f.year, city: null, familyBehind: false } }, threads: [th(f, X, 2, '回来的人', '回来的第二年，你已经重新习惯了家乡的节奏，偶尔也会想念在国外的那些日子。', [0, 2, 0, 2, 0])] });
  }
  if (p.shelter) {
    return out(f, X, '城里的工作停了，你回老家住了几个月：陪家人吃饭，帮着干点农活，夜里听着虫鸣入睡。等城里的日子恢复正常，你又收拾行李回去了。', [1, 4, 0, 4, -1], { set: { flags: { shelteredHome: f.year } } });
  }
  if (visit) {
    return out(f, X, f.ruralOrigin ? '你回了一趟老家。老房子还在，门前的树更粗了，认识你的人却没剩几个。你在村口坐了一下午。'
      : '你回了一趟小时候住过的老街区。老邻居搬走了大半，街角的小店换了招牌，你在曾经的家门口站了很久。', [0, 4, 0, 2, -1]);
  }
  if (!f.ruralOrigin) {
    return out(f, X, '你回到了从小长大的那座城市，在离老房子不远的地方住了下来。早上去熟悉的早点铺，傍晚在小时候常去的公园里散步，日子慢了下来。', [1, 4, 0, 3, -2],
      { set: { urban: true, flags: { returnedHome: true, city: null } }, threads: [th(f, X, 2, '故乡的日子', '回来的日子过得安稳。你常常想，人这一辈子，绕了一大圈，还是想回到出发的地方。', [1, 3, 0, 2, 0])] });
  }
  return out(f, X, '你回到了故乡。翻修了老屋，在院子里种上了菜，傍晚和老邻居们坐在门口聊天。', [2, 4, 0, 3, -2],
    { set: { urban: false, flags: { returnedHome: true, city: null } }, threads: [th(f, X, 2, '故乡的日子', '回乡的日子过得安稳。你常常想，人这一辈子，绕了一大圈，还是想回到出发的地方。', [1, 3, 0, 2, 0])] });
};
A.move_to_kids = (f, X) => {
  if (!f.hasKids) return A.friends(f, X);
  return out(f, X, `${f.couple ? '你和{partner}' : '你'}搬去和{child}一家同住。新地方不认识人，你每天在楼下转悠，慢慢和几个老人成了朋友。孙辈放学回来，第一句就是喊你。`, [0, 2, 0, 5, 0], { set: { urban: true, flags: { livingWithKids: true } } });
};
A.move_warm = (f, X) => out(f, X, `${f.couple ? '你和{partner}' : '你'}搬去了一个气候温暖的地方过冬。海边的阳光让你的关节不再疼，你在那里也认识了一群候鸟一样的老人。`, [3, 4, 0, 0, -4], { set: { flags: { snowbird: true } } });
A.nursing_home = (f, X) => {
  if (f.lic && f.r) return A.home_care(f, X);
  if (f.flags.careHome) return out(f, X, '你在养老院里住惯了，成了楼层里最受欢迎的老人之一：教新来的人下棋，给护工讲年轻时的故事。', [1, 3, 0, 3, -3], { hz: [0.95, 3, '专业照护'] });
  return out(f, X, '你搬进了一家养老院。房间不大，护工很耐心，每周都有人来唱歌、下棋。你把家人的照片摆满了窗台。', [2, -1, 0, 1, -6], { hz: [0.93, 3, '专业照护'], set: { flags: { careHome: true } } });
};
A.home_care = (f, X, p = {}) => out(f, X, p.hospital ? `你决定不再住院，回到了自己的家里。熟悉的床、熟悉的窗外，${f.hasKids ? '孩子们轮流回来陪着你' : f.couple ? '{partner}守在你身边' : '社区的医生隔几天就来看看'}，日子过得慢，心里却安稳。`
  : f.flags.homeCare ? '你还是住在自己的老房子里。护工换了一位，邻居家的孩子也常来帮你取快递、读报纸，日子过得慢，却不孤单。'
    : f.hasKids && (f.poorC || f.sinic) ? '你留在自己家里养老，孩子们轮流回来照看，社区的人也常来问候。熟悉的屋子、熟悉的街坊，让你心里踏实。' : '你选择居家养老，请了钟点护工，家里装上了扶手和呼叫器。你还是喜欢在自己的阳台上晒太阳。',
[1, 2, 0, 3, -3], { set: { flags: { homeCare: true } } });
A.smart_care = (f, X) => {
  if (!f.robots && !f.aiDoctor) return A.home_care(f, X);
  return out(f, X, '家里装上了智能照护系统：护理机器人扶你起身、提醒吃药，健康监测随时连着医生。你嘴上说不习惯，心里其实挺依赖它。', [3, 1, 0, 0, -3], { hz: [0.9, 5, '智能照护'], set: { flags: { smartCare: true } } });
};
A.write_memoir = (f, X, p = {}) => (p.tell
  ? out(f, X, `你把${f.hasKids ? '孩子和晚辈们' : '亲戚家的晚辈和邻居家的孩子'}叫到身边，讲你这一辈子走过的路：{birthyear}年的那个家、换过的工作、遇到过的人。他们听得入神，有一个还拿出本子记了下来。`, [0, 5, 1, 5, 0], { set: { flags: { toldStory: f.year } } })
  : out(f, X, '你开始写回忆录，从{birthyear}年出生写起。写着写着，好多早已忘记的人和事又回来了，你常常写到一半就停下来发呆。', [0, 4, 2, 2, 0], { set: { flags: { memoir: true } } }));
A.reunion = (f, X) => out(f, X, '你张罗了一次老友聚会。来的人比上次少了一些，大家互相辨认着当年的模样，说着说着又笑出了眼泪。', [0, 5, 0, 6, -0.5]);
A.will = (f, X) => out(f, X, '你把身后的事一件件安排好：遗嘱、存款、想留给每个人的话。签完字，你觉得一身轻松。', [0, 2, 0, 2, 0], { set: { flags: { will: true } } });
A.learn_tech = (f, X) => out(f, X, f.year >= 2030 ? '你跟着年轻人学会了用最新的智能设备：和 AI 助手说话、用眼镜看实时翻译。你说，活到老学到老。' : '你学会了用智能手机视频、付款、看新闻。遇到不会的，你就记在小本子上，下次再问。', [0, 3, 3, 3, 0]);
A.welfare = (f, X) => {
  const ok = !f.lic && X.rng.chance(f.umc || f.hic ? 0.8 : 0.45);
  return ok ? out(f, X, '你去社区申请了生活补助。手续跑了好几趟，最后批下来了。钱不多，但每个月能按时到账。', [0, 2, 0, 1, 3], { set: { flags: { welfare: true } } })
    : out(f, X, '你打听了补助的事，条件卡得很严，最后没能申请下来。你只好继续靠一点积蓄和亲戚们的帮衬过日子。', [0, -2, 0, 1, 0], { feasible: false, note: '社会救助覆盖有限' });
};

// ---- the future (gated by world line and year)
A.longevity_treatment = (f, X) => {
  if (f.age < 45) return out(f, X, '你认真打听了那些抗衰老疗法。医生笑着说，你还年轻，眼下最好的“抗衰老”就是好好吃饭、好好睡觉、常常走动。', [2, 1, 1, 0, 0], { feasible: false, note: '年纪尚轻，用不上' });
  if (!f.longevity) return out(f, X, '你打听了那些抗衰老疗法，它们大多还停留在新闻和实验室里。你决定先做好能做的：好好吃饭、好好睡觉、常常走动。', [2, 1, 1, 0, 0], { feasible: false, note: '疗法尚不可及' });
  const cost = f.hic ? 10 : 24;
  if (resources(f) < cost * f.monthRef * 0.6) return out(f, X, '疗法已经有了，可价格贵得吓人。你在等医保覆盖的消息，先做好了日常的保养。', [1, -1, 1, 0, 0], { feasible: false, note: '费用过高' });
  const ok = X.rng.chance(0.7);
  return out(f, X, '你接受了新一代抗衰老治疗：基因检测、细胞疗法、定期监测。几个月后，你的体力和睡眠都明显好了起来。', ok ? [6, 4, 1, 0, -cost] : [-2, -2, 1, 0, -cost], { hz: ok ? [0.75, 15, '抗衰老治疗'] : [1, 1, '治疗反应'], set: { flags: { longevityTx: f.year } } });
};
/** saying no (or "not yet") to an offered treatment */
A.decline_treatment = (f, X, p = {}) => out(f, X, p.wait
  ? '你决定再观察几年，等这项疗法更成熟、价格也降下来再说。你把医生给的资料收进了抽屉，先把日常的保养做好。'
  : '你谢绝了这项疗法。生老病死自有规律，你更想把余下的日子过得踏实：按时吃饭、常常走动、多陪陪身边的人。', [1, 2, 0, 1, 0]);
A.space_trip = (f, X) => {
  if (!f.spaceTour) return out(f, X, '太空旅行还只属于极少数人。你买了一架望远镜，晴朗的夜里就在阳台上看月亮和星星。', [0, 3, 2, 0, -0.5], { feasible: false, note: '太空旅行尚不可及' });
  if (resources(f) < 60 * f.monthRef) return out(f, X, '一张太空船票的价格超出了你的想象。你在发射场外的人群里看了一次火箭升空，也算圆了半个梦。', [0, 3, 1, 0, -1], { feasible: false, note: '票价过高' });
  return out(f, X, '你登上了飞往近地轨道的飞船。失重的那几分钟里，你看着蓝色的地球边缘，忽然觉得很多烦恼都不值一提。', [0, 8, 3, 1, -36], { hz: [1.02, 1, '太空飞行'] });
};
A.mars_colony = (f, X) => {
  const sel = X.rng.chance(clampN(0.04 + (f.know - 60) / 300 + (f.eduRank >= 6 ? 0.05 : 0), 0.01, 0.2));
  return out(f, X, sel ? '你通过了层层选拔，进入了火星项目的后备队伍。体检、训练、模拟舱里的封闭生活，你一样不落地扛了下来。' : '你报名了火星定居项目，没能通过最后一轮选拔。你把那封婉拒信钉在了墙上，转而去地面支持中心应聘。',
    sel ? [2, 6, 4, -2, 0] : [0, -2, 2, 0, 0], { set: { flags: { marsApplicant: f.year, marsReserve: sel } } });
};
A.bci = (f, X) => out(f, X, '你参加了脑机接口的试验项目，学会了用意念控制屏幕上的光标。兴奋之余，你也常常想：哪些想法，应该只属于自己？', [0, 2, 5, 0, -4], { hz: [1.03, 3, '植入试验'], set: { flags: { bci: true } } });

// ---- war, disaster, offers
A.flee_war = (f, X, p = {}) => {
  if (p.mode === 'abroad' && f.age >= 16) return A.emigrate(f, X, { mode: 'refugee', dest: p.dest });
  if (f.age < 16) {
    return out(f, X, p.mode === 'abroad' && f.fam >= 0.5 ? '家人带着你辗转去了国外投奔亲戚。陌生的语言、陌生的学校，你花了很久才敢在课堂上开口。' : '家人带着你挤上了离开的车，投奔了外地的亲戚。你抱着自己最喜欢的东西，一路上没敢睡着。',
      [-2, -4, -1, 1, 0], { hz: [0.8, 2, '离开战区'], set: { flags: { displaced: f.year } }, threads: [th(f, X, 3, '回不去的家', '后来你常常梦见原来的家：门口的台阶、窗外的树、小伙伴喊你名字的声音。', [0, -1, 0, 1, 0])] });
  }
  return out(f, X, f.hasKids ? '你带着家人挤上了离开的车，投奔了外地的亲戚。新的地方很陌生，但夜里终于能睡个整觉了。'
    : f.couple ? '你和{partner}各背着一个包，跟着人流离开了战区，在一个安全些的城镇落了脚，从头开始找活干。'
      : '你收拾了一个背包，跟着人流离开了战区，在一个安全些的城镇落了脚，开始从头打零工。',
    [-2, -4, 0, 1, -4], { hz: [0.8, 2, '离开战区'], set: { flags: { displaced: f.year } }, threads: [th(f, X, 3, '回不去的家', X.rng.chance(0.5) ? '战事平息后，你回到了家乡。房子受了损，可邻居们都回来了，大家一起把街道收拾干净。' : '战火迟迟没有停歇，你在异地安了家。偶尔你会翻出那把老房子的钥匙，看上一会儿。', [0, 2, 0, 2, 0])] });
};
A.stay_war = (f, X) => out(f, X, f.age < 16 ? '家里决定留下来。你学会了在警报响起时躲进地下室，学会了在停电的夜里借着烛光写作业。' : '你决定留下来。有人需要照顾，有家要守。你学会了在警报声里分辨远近，学会了在停电的夜里点着蜡烛给家人讲故事。',
  [-3, -4, 0, 4, -3], { hz: [1.35, 2, '留守战区'], threads: [th(f, X, 2, '熬过来的日子', '最艰难的那段日子过去了。你们一家都还在，这比什么都重要。', [0, 4, 0, 3, 0])] });
A.rebuild = (f, X, p = {}) => (p.fortify
  ? out(f, X, '你决定留下来，把房子好好加固了一遍：垫高了地基，装上了挡水板和遮阳棚，又和邻居们一起疏通了排水沟。花了不少钱，可住着心里踏实了些。', [0, 1, 0, 4, -6],
    { hz: [0.95, 5, '加固住房'], threads: [th(f, X, 3, '扛住的房子', '这几年的极端天气一次比一次凶，加固过的房子都扛住了。邻居们也跟着学，整条街都变了样。', [0, 3, 0, 2, 0])] })
  : out(f, X, '你决定留下来重建家园。和邻居们一起清淤、修房、补路，几个月后，街上又飘起了饭菜的香味。', [-1, -1, 0, 5, -5], { threads: [th(f, X, 3, '重建之后', '新房子比原来的更结实了。你在门口种了一棵树，说要看着它长大。', [0, 4, 0, 2, 1])] }));
A.relocate_disaster = (f, X) => out(f, X, '你决定搬去更安全的地方。离开前你在老房子里转了好几圈，把门口的那块石头也搬上了车。', [0, -2, 0, -2, -4], { hz: [0.92, 6, '迁往安全地带'], set: { flags: { relocated: f.year } } });
A.accept_offer = (f, X, p = {}) => {
  if (p.dest && p.dest !== f.iso) return A.emigrate(f, X, { dest: p.dest, mode: 'skilled', offer: true });
  const here = hereCity(f, X);
  const city = p.city && p.city !== here ? p.city : p.same ? null : otherCity(f, X);
  if (!city) {
    // the offer comes from another employer in the same city: no move
    return out(f, X, '你接受了邀请，换到了一家更大的公司。新岗位的挑战不小，薪水也涨了一大截，通勤的路却还是那条熟悉的路。', [-1, 4, 3, 0, 2],
      { set: { career: { status: 'employed', incomePct: PCT(f, 0.1) } } });
  }
  const fam = familyMove(f, X, 0.3);
  const go = !fam ? `你接受了${city}的工作邀请，带着两个箱子去报到。` : fam.alone ? `你接受了${city}的工作邀请，一个人带着两个箱子去报到，${fam.behind}，你每个周末都赶回去。` : `你接受了${city}的工作邀请，${fam.together}搬了过去。`;
  return out(f, X, `${go}新岗位的挑战不小，薪水也涨了一大截。`, [-1, 3, 3, fam && !fam.alone ? -1 : -2, 2],
    { set: { urban: true, career: { status: 'employed', incomePct: PCT(f, 0.1) }, flags: { city, familyBehind: fam && fam.alone ? f.year : undefined } } });
};
A.decline_offer = (f, X) => out(f, X, '你婉拒了那份邀请。家人在这里，朋友在这里，你觉得眼下的生活就挺好。', [0, 1, 0, 3, 0]);
A.early_marriage = (f, X) => {
  const nm = personName(X.data, f.iso, f.m ? 'female' : 'male', X.rng);
  return out(f, X, f.inSchool ? `你没能拒绝家里的安排，嫁给了${nm}。离开学校那天，你把课本一本本包好，放进了嫁妆箱的最底层。` : `你没能拒绝家里的安排，嫁给了${nm}。出嫁那天，你回头看了很久那间住了十几年的屋子。`, [-2, -6, -3, 0, 0],
    { set: { relationship: { status: 'married', partner: { name: nm, sinceYear: f.year } }, education: { inSchool: false }, flags: { earlyMarriage: f.year } }, hz: [1.1, 5, '早婚早育风险'] });
};
A.seek_help = (f, X) => {
  const ok = X.rng.chance(0.55);
  const helper = f.inSchool ? `老师和村里${f.chn ? '的妇女主任' : '一位说得上话的长辈'}` : `村里${f.chn ? '的妇女主任' : '一位说得上话的长辈'}`;
  if (ok && f.inSchool) {
    const r = A.stay_school(f, X);
    r.narrative = `你去找了${helper}。他们上门劝了好几次，家里终于松了口。` + r.narrative;
    return r;
  }
  if (ok) return out(f, X, `你去找了${helper}。他们上门劝了好几次，家里终于松了口：婚事以后再说。你松了一口气，开始盘算自己的打算。`, [0, 3, 1, 2, 0], { set: { flags: { marriagePressure: f.year } } });
  return out(f, X, f.inSchool ? `${helper}来家里劝过，可家里还是坚持。婚事暂时缓了一年，你抓紧每一天去上学。` : `${helper}来家里劝过，可家里还是坚持。婚事暂时缓了一年，你抓紧这一年学着自己挣钱。`, [0, -2, 2, 2, 0], { set: { flags: { marriagePressure: f.year } } });
};

// ---- migration
A.emigrate = (f, X, p = {}) => {
  // past working age a move abroad is a retirement move, never a new job
  const older = f.retired || f.age >= 62;
  let mode = p.mode || (f.war ? 'refugee' : older ? 'retire' : f.eduRank >= 5 ? 'skilled' : f.age < 26 && f.know >= 65 && resources(f) > 15000 ? 'study' : 'labor');
  if (older && mode !== 'refugee') mode = 'retire';
  const dest = p.dest && p.dest !== f.iso ? p.dest : pickDest(f, X, mode);
  if (!dest || dest === f.iso) {
    if (older) return out(f, X, '你打听了一圈，没找到合适的落脚地。你决定还是留在熟悉的地方，把日子过好。', [0, -1, 0, 0, 0], { feasible: false, note: '没有合适的去处' });
    const r = A.migrate_city(f, X);
    r.narrative = '一时找不到能去的国家，你决定先在国内换个地方闯一闯。' + r.narrative;
    return r;
  }
  const D = nameOf(X.data, dest);
  if (mode !== 'refugee' && destAtWar(X, dest, f.year)) {
    return out(f, X, `你本打算去${D}，可那里正处在战火之中：航班停了，使馆关了，新闻里每天都是逃难的人。你只好把这个计划放了下来。`, [0, -2, 1, 0, 0],
      { feasible: false, note: '目的地正处于战乱', set: { flags: { emigrationDream: dest } } });
  }
  const chk = migrationCheck(f, X, dest, mode);
  if (!chk.ok) {
    const why = chk.why === 'young' ? '你还太小，没法一个人出远门。' : chk.why === 'poor' ? `去${D}的路费和中介费，比家里好几年的收入还多。` : chk.why === 'money' ? `算上路费、签证和最初几个月的生活费，去${D}要花的钱远远超出了你的积蓄。` : `去${D}的门槛很高：学历、语言、担保，每一样都让你望而却步。`;
    const alt = !f.u && f.age >= 16 ? '你决定先去本国的大城市闯一闯，把出国的梦想放在心里。' : '你把出国的念头放进了心里，开始一点点攒钱、学外语。';
    return out(f, X, why + alt, [0, -3, 1, 0, 0], { feasible: false, note: '出国条件不足', set: { flags: { emigrationDream: dest } },
      threads: [th(f, X, 4, '远方的门', resources(f) > chk.cost * 0.3 ? `几年过去，你离去${D}的条件近了一些，那个念头又冒了出来。` : '几年过去，出国的念头渐渐淡了，你在本地扎下了根。', [0, 1, 1, 0, 0])] });
  }
  if (!X.rng.chance(chk.p + 0.15)) {
    const alt = otherCity(f, X);
    const dec = threadDecision(f, X, 2, { key: 'mig_retry', title: '再试一次？', situation: `两年前去${D}的申请没有成功。如今又有了新的机会，你还想走吗？`,
      options: [opt(`再申请去${D}`, '准备更充分的材料，再试一次。', 'high', 'emigrate', { dest, mode }, 1), opt('留在国内发展', '把心思放在眼前的生活上。', 'low', 'stay_course', { say: '你把出国的材料收进了抽屉，决定留在国内好好发展。身边的人都在，日子也有奔头。' }, 1.5),
        alt ? opt(`先去${alt}`, '在国内的大城市积累经验。', 'mid', 'migrate_city', { city: alt }, 1) : null] });
    return out(f, X, `你递交了去${D}的申请，等了好几个月，最后收到的是一封拒签信。你把那封信折好收了起来。`, [0, -4, 1, 0, -1], { set: { flags: { visaRefused: f.year } }, threads: [th(f, X, 2, '又一次机会', '新的一年，出国的机会又摆在了面前。', [0, 0, 0, 0, 0], null, { decision: dec })] });
  }
  const g = chk.group;
  const costM = chk.cost / Math.max(1, f.monthRef);
  const city = (CITIES[dest] || [])[0] || null;
  const since = f.year;
  const set = { country: dest, urban: true, flags: { migrant: dest, origin: f.origin || f.iso, migrantSince: since, city, displaced: mode === 'refugee' ? f.year : undefined } };
  if (set.flags.displaced === undefined) delete set.flags.displaced;
  const threads = [];
  const cond = { country: dest };
  // a partner and children: refugees and retirees go together; workers and students often go first, alone
  const fam = familyMove(f, X, mode === 'labor' ? 0.8 : mode === 'study' ? 0.7 : mode === 'skilled' ? 0.3 : 0);
  if (fam && fam.alone) set.flags.familyBehind = f.year;
  const famTxt = !fam ? '' : fam.alone
    ? (mode === 'labor' ? `${fam.behind}，你答应每个月往家里寄钱。` : mode === 'study' ? `${fam.behind}，你们约好每天晚上视频。` : `${fam.behind}，等你站稳脚跟再团聚。`)
    : `${fam.who}也跟着你一起去了。`;
  let txt;
  if (mode === 'study') {
    // a graduate (or a final-year student) goes abroad for a master's degree, not for a second bachelor's
    const grad = f.eduRank >= 5 || (uniStudent(f) && f.age >= 21);
    const own = grad && f.field ? Object.values(FIELDS).find((x) => x.label === f.field) : null;
    const F = own || (FIELDS[p.field] ? FIELDS[p.field] : FIELDS[pickField(f, X)]);
    const yrs = grad ? 2 : F.years;
    const level = grad ? 'postgrad' : 'tertiary';
    set.education = { inSchool: true, field: F.label };
    set.career = { status: 'student', title: null, sector: null };
    set.flags.track = grad ? 'postgrad' : 'uni';
    txt = `你拿到了${D}一所大学的${grad ? '研究生' : ''}录取通知书。登机前，家人塞给你一包家乡的零食，你在飞机上一直没舍得拆。${famTxt}`;
    const stay = X.rng.chance(0.5);
    const base = F.pct + (grad ? 0.06 : 0);
    const nf = { ...f, working: false };
    threads.push(th(f, X, 1, '异乡的第一年', '语言关比想象中难。第一学期你常常听不懂课，就把课堂录音一遍遍地听，夜里在宿舍里想家。', [0, -2, 4, -1, 0], null, { conditions: cond }));
    threads.push(th(f, X, yrs, '毕业的岔路口', stay ? `你拿到了${F.label}专业的${grad ? '硕士' : ''}学位，在${D}找到了工作，决定先留下来。` : `你拿到了${F.label}专业的${grad ? '硕士' : ''}学位，带着文凭回到了家乡，找到了一份不错的工作。`, [0, 4, 3, 1, 2],
      stay ? { education: { inSchool: false, level, field: F.label }, career: { status: 'employed', title: F.job, sector: F.sector, incomePct: jobPct(nf, F.job, base - 0.12, 0) } } : { country: f.iso, education: { inSchool: false, level, field: F.label }, career: { status: 'employed', title: F.job, sector: F.sector, incomePct: jobPct(nf, F.job, base + 0.05, 0) }, flags: { migrant: false, returnee: f.year + yrs, city: null, familyBehind: false } }, { conditions: cond }));
  } else if (mode === 'refugee') {
    set.career = { status: 'unemployed', title: null, sector: null };
    const kids = f.kids.some((k) => k.age < 18);
    txt = fam ? `你${fam.together}，背着几件行李，辗转来到了${D}。在难民登记处排队的那个下午，你一直攥着家里的钥匙。` : `你带着几件行李，辗转来到了${D}。在难民登记处排队的那个下午，你一直攥着家里的钥匙。`;
    threads.push(th(f, X, 1, '安置', `你在${D}领到了临时证件，开始学当地的语言，打一些零工。${kids ? '孩子们终于能重新上学了。' : '你终于有了一张可以安睡的床。'}`, [1, 2, 3, 1, 1], { career: { status: 'employed', title: '临时工', sector: '服务业', incomePct: 0.12 } }, { conditions: cond }));
  } else if (mode === 'retire') {
    txt = `${f.couple ? '你和{partner}' : '你'}卖掉了老房子，带着积蓄搬去了${D}。新的地方气候宜人，只是语言和饮食都要重新适应。`;
    threads.push(th(f, X, 1, '异乡的第一年', `在${D}的第一年，你学着用当地话买菜、问路，也在附近的公园里认识了几位同样从远方来的老人。`, [1, 2, 2, 1, 0], null, { conditions: cond }));
  } else {
    const job = migrantJob(f, mode, g, dest);
    set.career = { status: 'employed', title: job.title, sector: job.sector, incomePct: setPct(job.pct) };
    txt = (mode === 'labor'
      ? X.pick([`你通过中介拿到了去${D}的工作签证，签了两年的合同。出发那天，全家人送你到车站，${f.momAlive ? '母亲' : '家里人'}一直没松开你的手。`, `你借了一笔中介费，拿到了去${D}的劳务合同。飞机起飞时，你把额头贴在舷窗上，看着家乡越来越小。`])
      : X.pick([`你带着行李和一纸工作合同去了${D}。落地那天下着雨，你在机场给家里报了平安。`, `你拿到了${D}的工作签证。出发前一晚，你把家里的每个角落都看了一遍，又把一小包家乡的土塞进了行李箱。`, `你在${D}找到了一份工作。第一天上班，你提前一个小时就到了，在公司楼下反复默念自我介绍。`])) + famTxt;
    threads.push(th(f, X, 1, '异乡的第一年', mode === 'labor' ? '工作很辛苦，宿舍很挤，可每个月寄回家的钱让家里的日子好过了许多。' : '语言、饮食、办事的规矩，什么都要重新学。第一个冬天，你特别想家。', mode === 'labor' ? [-2, -1, 1, 0, 2] : [0, -2, 3, -1, 0], null, { conditions: cond }));
  }
  // the third choice brings over whoever is still at home: the family left behind, else the parents
  const third = fam && fam.alone ? opt('把家人接来', '想办法让家人也来这里团聚。', 'high', 'bring_parents', {}, 0.8)
    : f.parentAlive && f.age < 60 ? opt('把父母接来', '想办法让父母也来这里看看。', 'high', 'bring_parents', {}, 0.6) : null;
  const decide = threadDecision(f, X, 3, {
    key: 'mig_stay', title: '去还是留', situation: `在${D}的第三年。你已经习惯了这里的生活，可每到节日，还是会想起家乡的味道。`,
    options: [opt('留下来扎根', `继续在${D}${mode === 'retire' ? '安度晚年' : '打拼'}，申请长期居留。`, 'mid', 'settle', {}, 1.4), opt('回到故乡', '带着这些年的积蓄和见识回家。', 'low', 'return_home', {}, 1), third],
  });
  threads.push(th(f, X, 3, '第三年', `在${D}已经三年了。`, [0, 0, 1, 0, 0], null, { conditions: cond, decision: decide }));
  return out(f, X, txt, [0, 3, 3, fam && fam.alone ? -6 : -4, -Math.min(costM, 24)], { set, threads, hz: mode === 'refugee' ? [0.8, 3, '逃离战乱'] : undefined });
};
A.settle = (f, X) => {
  const years = f.year - num(f.flags.migrantSince, f.year);
  return out(f, X, years >= 5 ? '你申请了长期居留，又在几年后入了籍。宣誓那天，你想起了刚落地时的那场雨。' : '你决定留下来，在这里扎根。你开始学着把这里叫做“家”，也开始给远方的父母寄这里的特产。',
    [0, 3, 1, 1, 1], { set: { flags: { settled: f.year, citizen: years >= 5 ? true : undefined } } });
};

// ---- service
A.military = (f, X, p = {}) => {
  if (f.age < 17 || f.age > 45) {
    return out(f, X, f.age < 17 ? '你还不到参军的年龄。你把这份向往放在心里，每天早上去操场跑步。' : '你已经过了参军的年龄。你去社区报名做了应急志愿者，换一种方式出一份力。', [2, 1, 0, 1, 0], { feasible: false, note: '年龄不符', set: { flags: { volunteer: f.age > 45 ? true : undefined } } });
  }
  const consc = f.consc;
  const months = consc ? consc.months : p.voluntary ? 36 : 24;
  const years = Math.max(1, Math.round(months / 12));
  const injured = f.war && X.rng.chance(0.18);
  const head = consc && !p.voluntary ? `你按规定入伍，开始了为期${months}个月的兵役。剃头那天，你在镜子里几乎认不出自己。` : '你报名参了军。新兵连的第一个早晨，起床号一响，你就从床上弹了起来。';
  return out(f, X, head + (f.war ? '战事正紧，训练比往年短了许多。' : ''), [3, -2, 1, 3, 0],
    { set: { career: { status: 'military', title: p.tech ? '技术兵' : '士兵', sector: '军队', incomePct: jobPct({ ...f, working: false }, p.tech ? '技术兵' : '士兵', consc && !p.voluntary ? 0.16 : num(JOB_PCT[p.tech ? '技术兵' : '士兵'], 0.24), 0) }, education: f.inSchool ? { inSchool: false } : undefined, flags: { served: f.year, enlisted: f.year } }, hz: f.war ? [1.6, years, '战时服役'] : undefined,
      threads: [th(f, X, years, '退伍', injured ? '你在服役中受了伤，提前退伍。回家的火车上，你一直望着窗外，很久没有说话。' : `${months}个月的军旅生活结束了。你脱下军装，带着一身好体格和几个可以托付的战友回到了家。`, injured ? [-6, -3, 1, 2, 1] : [2, 3, 1, 3, 1], { career: { status: 'unemployed', title: null, sector: null }, flags: { veteran: true } })] });
};
A.defer_military = (f, X, p = {}) => {
  const r = A.uni(f, X, p);
  if (r.set && r.set.career && r.set.career.status === 'student') {
    r.narrative = '你申请了缓役，先去读大学。' + r.narrative;
    r.set = merge(r.set, { flags: { deferred: f.year } });
    const months = f.consc ? f.consc.months : 18;
    const alt = altServiceOk(f);
    const dec = threadDecision(f, X, 4, {
      key: 'serve_now', title: '服役不能再拖了', situation: `缓役期满，入伍通知寄到了家里。按规定，你需要服大约${months}个月的兵役。`,
      options: [opt('按时入伍', '完成兵役，再回来继续生活。', 'mid', 'military', {}, 1.5), alt ? opt('申请替代役', '在公共服务岗位上完成义务。', 'low', 'alt_service', {}, 1) : opt('争取技术兵种', '把专业所学用在部队的技术岗位上。', 'mid', 'military', { tech: true }, 1)],
    });
    r.threads.push(th(f, X, 4, '入伍通知', '缓役期满，入伍通知寄到了家里。', [0, -1, 0, 0, 0], null, { decision: dec }));
  }
  return r;
};
A.alt_service = (f, X) => {
  if (!f.consc) {
    return out(f, X, f.war ? '战事吃紧，你还是决定不拿起武器。你在后方帮着运送物资、照顾伤员，用另一种方式出一份力。' : '你没有去当兵。在{country}，这本来就是各人自己的选择，你把心思放回了自己的日子上。',
      f.war ? [-1, -1, 1, 3, 0] : [0, 1, 0, 0, 0], f.war ? { set: { flags: { volunteer: true } } } : {});
  }
  if (!altServiceOk(f)) {
    const r = A.military(f, X, {});
    r.feasible = false;
    r.note = '当地没有替代役';
    r.narrative = '你打听了替代役，可{country}并没有这样的安排。' + r.narrative;
    return r;
  }
  const months = Math.round(f.consc.months * 1.5);
  return out(f, X, `你申请了替代役，在公共服务岗位上服役${months}个月：在养老院照顾老人、在消防站值班。时间比兵役长，可你觉得很踏实。`, [1, 1, 1, 4, 0],
    { set: { career: { status: 'employed', title: '社会服务人员', sector: '公共服务', incomePct: 0.15 }, education: f.inSchool ? { inSchool: false } : undefined, flags: { served: f.year, altService: true } },
      threads: [th(f, X, Math.max(1, Math.round(months / 12)), '服役期满', '替代役结束了。那些在养老院里陪老人说话的下午，让你对“照顾”这两个字有了新的理解。', [0, 3, 1, 2, 0], { career: { status: 'unemployed', title: null, sector: null }, flags: { veteran: true } })] });
};

// ---- small family / farm extras
A.child_dream = (f, X, p = {}) => out(f, X, f.age < 12 ? '你把这个愿望认认真真地讲给了家里人听。大人们笑着摸摸你的头：“等你长大了再说。”你把它写进了日记本，在旁边画了一颗星星。' : '这件事得等你再长大一些才能做。你把它记在了心里，开始一点点为那一天做准备。',
  [0, 1, 1, 1, 0], { feasible: false, note: '年龄还小', set: { flags: { childDream: p.act || true } } });
A.kid_local = (f, X) => out(f, X, '你们让{child}留在本地读大学，周末就能回家吃饭。你常常借口送汤，去学校看TA一眼。', [0, 3, 0, 4, -2]);
A.kid_vocational = (f, X) => out(f, X, '你支持{child}去读职业学校，学一门实在的手艺。亲戚们有些议论，可孩子学得很开心，毕业前就被单位定了下来。', [0, 2, 0, 3, -1]);
A.enough_kids = (f, X) => out(f, X, '你们商量后决定，一个孩子就够了，把更多的时间和心思留给眼前这个小家。', [0, 2, 0, 1, 1], { set: { flags: { noMoreKids: true, wantChild: false } } });
A.farm_expand = (f, X) => {
  const good = X.rng.chance(clampN(0.45 + f.gdpGrowth / 30 - (f.drought || f.flood ? 0.25 : 0), 0.1, 0.8));
  return out(f, X, '你承包了更多的地，又添了些牲口。贷款压在身上，你每天天不亮就出门。', [-1, 1, 1, 0, -4],
    { set: { flags: { bigFarm: true } }, threads: [th(f, X, 3, '扩大之后', good ? '几年下来，你成了村里的种养大户，还带着几户乡亲一起干。' : '赶上了坏年景，收成和价格都不好，你花了好几年才把贷款还清。', good ? [0, 5, 1, 2, 8] : [-1, -4, 1, 0, -3], good ? { career: { incomePct: PCT(f, 0.12) } } : null)] });
};
A.farm_tech = (f, X) => out(f, X, f.smart ? '你跟着农技站和手机上的课程学新技术：测土配方、滴灌、网上卖货。第一年就省下了不少化肥钱。' : '你去农技站听了几次课，学会了新的育种和施肥方法。邻居们起初不信，秋收时都来向你讨教。',
  [0, 3, 4, 2, 2], { set: { flags: { farmTech: true } }, threads: [th(f, X, 3, '新法种田', '用上新方法后，你家的收成比往年高了一截。', [0, 3, 1, 1, 3], { career: { incomePct: PCT(f, 0.06) } })] });
A.couple_therapy = (f, X) => {
  if (!f.couple) return A.therapy(f, X);
  const ok = X.rng.chance(0.55);
  return out(f, X, '你和{partner}一起去做了婚姻咨询。第一次坐在咨询室里，你们谁都不肯先开口。慢慢地，那些积压多年的话终于说了出来。', [0, 2, 1, 3, -1],
    { threads: [th(f, X, 2, '婚姻的修补', ok ? '你们学会了好好吵架，也学会了好好和好。家里的气氛一点点暖了回来。' : '咨询没能挽回什么。你们心平气和地决定分开，各自重新开始。', ok ? [0, 4, 0, 4, 0] : [0, -4, 1, -2, -2], ok ? null : { relationship: { status: 'divorced', partner: null } })] });
};
A.separate = (f, X) => {
  if (!f.couple) return A.rest(f, X);
  const back = X.rng.chance(0.5);
  return out(f, X, '你们决定分开住一段时间，各自冷静一下。一个人的房间很安静，你终于有空把很多事情想清楚。', [0, -2, 1, -2, -1],
    { threads: [th(f, X, 1, '分开之后', back ? '分开的这一年，你们反而更懂得对方了。{partner}搬回来的那天，带了一束你最喜欢的花。' : '分开一年后，你们决定正式离婚。没有争吵，只有一声叹息。', back ? [0, 4, 0, 4, 0] : [0, -3, 1, -2, -2], back ? null : { relationship: { status: 'divorced', partner: null } })] });
};

/* ------------------------------------------------------------------ action dispatch with life-stage guards */

const CHILD_OK = new Set(['learn_hobby', 'child_books', 'child_play', 'child_arts', 'child_social', 'child_chores', 'child_care_sib', 'child_classes', 'child_stay_grand', 'child_follow_parents', 'child_parents_stay', 'study_hard', 'compete', 'sports_track', 'arts_track', 'enjoy_youth', 'stay_school', 'study_and_work', 'kid_help_home', 'boarding', 'elite_school', 'exchange_abroad', 'friends', 'pet', 'exercise', 'diet', 'learn_language', 'volunteer', 'rest', 'stay_course', 'faith', 'travel', 'reconcile', 'health_check', 'therapy', 'crisis_support', 'family_time', 'learn_tech', 'write_memoir', 'flee_war', 'stay_war', 'retrain_ai', 'art_career', 'athlete_career', 'seek_partner', 'study_more', 'child_dream', 'illegal', 'save', 'quit_smoking', 'activism', 'reunion', 'care_parents']);
const TEEN_OK = new Set([...CHILD_OK, 'vocational', 'exam_push', 'exam_repeat', 'drop_out_work', 'learn_trade', 'migrate_city', 'work_now', 'early_marriage', 'seek_help', 'uni', 'military', 'emigrate', 'gig', 'farming', 'side_hustle', 'job_switch', 'spend', 'breakup', 'stay_single', 'change_major', 'defer_military', 'alt_service', 'gamble']);
const OLD_ONLY = new Set(['retire', 'retire_early', 'nursing_home', 'smart_care', 'will', 'move_to_kids', 'move_warm', 'grandkids_care', 'senior_school', 'longevity_treatment']);
function guardAct(act, f) {
  if (!A[act]) return null;
  if (f.age < 12 && !CHILD_OK.has(act)) return 'child_dream';
  if (f.age < 16 && !TEEN_OK.has(act)) return 'child_dream';
  if (f.age < 18 && ['marry', 'divorce', 'have_child', 'adopt', 'buy_home', 'invest_property', 'invest_crypto', 'invest_stocks', 'civil_service', 'start_business', 'kid_abroad', 'kid_tutor', 'kid_free', 'school_district', 'cohabit', 'wait_marriage', 'bring_parents', 'settle', 'mars_colony', 'mars_ground', 'space_trip', 'bci', 'decline_treatment'].includes(act)) return 'child_dream';
  if (OLD_ONLY.has(act) && f.age < 45 && !['will', 'senior_school', 'longevity_treatment'].includes(act)) return act === 'retire' || act === 'retire_early' ? 'rest' : act === 'grandkids_care' || act === 'move_to_kids' ? 'family_time' : act === 'nursing_home' ? 'volunteer' : 'rest';
  if (['kid_abroad', 'kid_tutor', 'kid_free', 'kid_local', 'kid_vocational', 'school_district', 'move_to_kids'].includes(act) && !f.hasKids) return 'family_time';
  return act;
}
function runAct(act, f, X, p) {
  const a = guardAct(act, f) || 'stay_course';
  X.key = X.key || a;
  const r = A[a](f, X, { ...(p || {}), act });
  // an option tagged {decline:'topic'} remembers the refusal so the same offer does not come back for years
  if (p && p.decline && r) r.set = merge(r.set || {}, { flags: { [`declined:${p.decline}`]: f.year } });
  // an option may frame the shared outcome text with a sentence of its own (p.lead), when the action was not redirected
  if (p && typeof p.lead === 'string' && p.lead && r && a === act) r.narrative = X.fill(p.lead) + r.narrative;
  return r;
}
const declinedRecently = (f, topic, years = 15) => isNum(num(f.flags[`declined:${topic}`])) && f.year - num(f.flags[`declined:${topic}`]) < years;

/* ------------------------------------------------------------------ milestone decision templates */

const TPL = [];
function T(slots, fn) { TPL.push({ slots, fn }); }
const SLOTS = [5, 12, 15, 18, 22, 26, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85];
const ADULT = [22, 26, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85];
/** years before "your parents are getting old" may come up again (milestone or triggered) */
const PARENT_GAP = 12;
function slotFor(age) { let s = 5; for (const a of SLOTS) if (age >= a) s = a; return s; }
const parentWord = (f) => (f.momAlive && f.dadAlive ? '父母' : f.momAlive ? '母亲' : '父亲');
/** {child} for a decision: the matching child (youngest first) */
const kidVar = (f, pred) => { const k = f.kids.filter(pred).sort((a, b) => a.age - b.age)[0]; return k ? { child: k.name } : undefined; };
/** "大约53%" / "几乎所有" for (gross, possibly >100) enrolment rates */
const share = (x) => { const v = Math.round(clampN(num(x, 0), 0, 150)); return v >= 95 ? '几乎所有' : v <= 2 ? '极少数' : `大约${v}%`; };

// age 5
T([5], (f) => ({ key: 'k5_interest', w: 1, title: '童年的样子', situation: `{name}${f.age}岁了。${f.u ? '小区里' : '村子里'}的孩子们各有各的玩法，大人们也在悄悄观察：这个孩子到底喜欢什么？`,
  options: [opt('看书识字', '缠着大人讲故事、教认字。', 'low', 'child_books', {}, 1), opt('满世界跑跳', '爬树、追跑，一刻也闲不住。', 'low', 'child_play', {}, 1.2), opt('画画唱歌', '拿起笔、听见歌就停不下来。', 'low', 'child_arts', {}, 0.8), opt('和小伙伴玩', '走到哪儿身边都围着一群朋友。', 'low', 'child_social', {}, 1)] }));
T([5], (f) => {
  const cn = f.chn && f.r && f.year <= 2022 && f.fam < 0.6;
  const rem = f.remitC && f.poorC && f.r && (f.sas || f.sea || f.lac || f.cas);
  if (!cn && !rem) return null;
  return { key: 'k5_left_behind', w: 4, title: cn ? '父母要外出打工' : '家里有人要出远门挣钱',
    situation: cn ? '家里的地养不活一家人，父母打算去{bigcity}打工。他们问你：是留在{granny}身边，还是跟着一起走？' : '家里的收成不够过日子，父母打算去外地甚至国外打工，好几年才能回来一次。',
    options: [opt('留在{granny}身边', cn ? '在熟悉的村子里长大，等父母过年回来。' : '在熟悉的村子里长大，等父母每年回来看你。', 'low', 'child_stay_grand', {}, 1.6), opt('跟着父母进城', '一家人在一起，但城里的日子并不容易。', 'mid', 'child_follow_parents', {}, 0.8), opt('哭着不让他们走', '也许他们会留下来，日子会更紧。', 'mid', 'child_parents_stay', {}, 0.6)] };
});
T([5], (f) => (f.r && f.poorC ? { key: 'k5_farm', w: 2, title: '家里的活计', situation: '农忙时节，大人们从早忙到晚。{name}也该学着帮点忙了——还是先去村里的学校看看？',
  options: [opt('跟大人下地', '学着干农活、放牲口。', 'low', 'child_chores', {}, 1.3), opt('去学校旁听', '趴在教室窗外听老师讲课。', 'low', 'child_books', { audit: true }, 1), opt('照看更小的孩子', '让大人们能安心干活。', 'low', 'child_care_sib', {}, 1, f.hasSib), opt('和伙伴们疯跑', '田野和小河就是游乐场。', 'low', 'child_play', {}, 0.8)] } : null));
T([5], (f) => (f.u && f.fam >= 0.45 && (f.umc || f.hic || f.chn) ? { key: 'k5_classes', w: 2, title: '要不要上兴趣班', situation: '身边的孩子都在上兴趣班。父母拿着几张宣传单，问你想学点什么。',
  options: [opt('学画画', '每周去两次画室。', 'low', 'child_arts', {}, 1), opt(f.english ? '学外语和数学' : '学英语和数学', '为以后的学习打基础。', 'low', 'child_classes', {}, f.examCulture ? 1.6 : 1), opt('学游泳打球', '把身体练结实。', 'low', 'child_play', { sport: true }, 1), opt('自由自在地玩', '童年就该好好玩。', 'low', 'child_play', {}, 0.8)] } : null));
T([5, 12], (f) => (f.war ? { key: 'kc_war', w: 6, title: '炮火下的童年', situation: '战事越来越近，大人们整夜整夜地商量要不要走。你抱着最喜欢的东西，不知道明天会在哪里。',
  options: [opt('跟家人去避难', '投奔外地的亲戚，离战火远一点。', 'mid', 'flee_war', {}, 1.4), opt('留在家里', '守着家，盼着战事早点过去。', 'high', 'stay_war', {}, 0.8), opt('去国外投亲', '远走他乡，也许再也回不来。', 'high', 'flee_war', { mode: 'abroad' }, 0.5, f.fam >= 0.5)] } : null));

// age 12
T([12], (f) => (f.inSchool ? { key: 'k12_middle', w: 1, title: '升入中学', situation: `{name}${f.age}岁，上了中学。新学校、新同学，课业也一下子重了起来。`,
  options: [opt('埋头苦读', '把心思都放在学习上。', 'low', 'study_hard', {}, 1.2), opt('参加学科竞赛', '去挑战更难的题目。', 'mid', 'compete', {}, 0.7, f.know >= 50), opt('加入运动队', '在操场上挥洒汗水。', 'low', 'sports_track', {}, 0.9), opt('交朋友享受校园', '青春不只有课本。', 'low', 'enjoy_youth', {}, 1)] } : null));
T([12], (f) => (f.poorC && f.r && f.famPoor && f.secEnroll < 85 && f.inSchool ? { key: 'k12_dropout', w: 3, title: '家里需要帮手',
  situation: `家里的日子越来越紧。在{country}，不少和你一样大的孩子已经不再上学了。${f.fe ? '亲戚们说，女孩子读那么多书没用。' : ''}${parentWord(f)}问你，还想不想继续读。`,
  options: [opt('坚持上学', '再难也要把书读下去。', 'mid', 'stay_school', {}, 1.2), opt('边上学边干活', '放学后帮家里分担。', 'mid', 'study_and_work', {}, 1.2), opt('回家帮忙', '先让家里渡过难关。', 'low', 'kid_help_home', {}, 0.9)] } : null));
T([12], (f) => (f.u && f.examCulture && f.fam >= 0.4 && f.inSchool ? { key: 'k12_school_choice', w: 2.5, title: '小升初', situation: '小学毕业了。就近的普通中学、要考试的重点中学，还有学费不菲的私立学校，摆在你面前。',
  options: [opt('冲刺重点中学', '再拼一把，考进好学校。', 'mid', 'study_hard', { goal: 'key' }, 1.2), opt('就近入学', '离家近，轻松一些。', 'low', 'stay_course', { say: '你在离家不远的中学上学，走几分钟就到校门口。省下来的时间，你用来看书、睡觉，也常和楼下的朋友一起玩。', fx: [1, 3, 1, 2, 0] }, 1), opt('上私立学校', '小班教学，学费不菲。', 'mid', 'elite_school', {}, 0.6, f.fam >= 0.7), opt('去寄宿学校', '早早学会独立。', 'mid', 'boarding', {}, 0.5)] } : null));
T([12], (f) => (f.r && (f.chn || f.lmc || f.lic) && f.inSchool && !f.famPoor ? { key: 'k12_boarding', w: 1.5, title: '去镇上读初中', situation: `村里没有中学。要继续读书，就得去${f.chn ? '镇上或县城' : '镇上'}寄宿，每周回家一次。`,
  options: [opt(f.chn ? '去县城寄宿' : '去镇上寄宿', '条件好些，但要离开家。', 'mid', 'boarding', {}, 1.3), opt('每天走读', '起早贪黑地赶路上学。', 'mid', 'stay_school', { commute: true }, 1), opt('留在家里帮忙', '书先不读了。', 'low', 'kid_help_home', {}, 0.5)] } : null));
T([12], (f) => (f.smart && f.year >= 2012 && f.inSchool ? { key: 'k12_phone', w: 0.8, title: '第一部手机', situation: '你有了第一部手机。游戏、短视频、聊天群，一个新世界在屏幕里向你招手。',
  options: [opt('用它查资料学习', '把手机当成学习工具。', 'low', 'study_hard', { phone: true }, 0.8), opt('和朋友们聊天', '群里的消息永远看不完。', 'low', 'enjoy_youth', {}, 1.2), opt('学着写代码', '自己做一个小程序。', 'mid', 'retrain_ai', {}, 0.5, f.internet >= 50), opt('交给父母保管', '先把心思放在学习上。', 'low', 'stay_course', { say: '你把手机交给父母保管，只在周末拿回来用一会儿。少了屏幕的打扰，晚上的作业写得快多了。', fx: [1, -1, 3, 0, 0] }, 0.5)] } : null));

// age 15
T([15], (f) => (f.chn && f.inSchool && f.eduRank <= 3 && !f.track ? { key: 'k15_zhongkao', w: 6, title: '中考', situation: '中考就要到了。在你们这里，大约一半的同学能上普通高中，另一半会去职业学校。',
  options: [opt('全力冲刺普高', '最后几个月，拼了。', 'mid', 'exam_push', { exam: '中考' }, 1.5), opt('读职业高中', '早点学一门手艺。', 'low', 'vocational', {}, 0.8), opt('出去打工', '早点挣钱帮家里。', 'high', f.u ? 'drop_out_work' : 'migrate_city', {}, 0.4, f.famPoor), opt('出国读高中', '换一条完全不同的路。', 'high', 'exchange_abroad', { full: true }, 0.4, f.famRich)] } : null));
T([15], (f, X) => {
  const ex = keyExams(f.lp, f.iso, f.year).find((e) => e[0] >= 14 && e[0] <= 16);
  if (f.chn || !f.inSchool || !ex || f.track === 'vocational') return null;
  return { key: 'k15_exam', w: 3, title: ex[1], situation: `${ex[1]}快到了，它会决定你接下来走哪条路。`,
    options: [opt('全力备考', '把所有时间都给复习。', 'mid', 'exam_push', { exam: ex[1] }, 1.5), opt('转读职业教育', '学一门实在的技术。', 'low', 'vocational', {}, vocTrackWeight(f, X, 0.8)), opt('先去工作', '早点自食其力。', 'high', 'drop_out_work', {}, 0.4, f.poorC), opt('顺其自然', '考成什么样都接受。', 'low', 'enjoy_youth', {}, 0.6)] };
});
T([15], (f, X) => (f.inSchool && f.track !== 'vocational' ? { key: 'k15_track', w: 1, title: '十五岁的分岔路', situation: `在{country}，${share(f.secEnroll)}的同龄人还在读中学。你也站到了人生的第一个岔路口。`,
  // leaving school at fifteen is common only where many teenagers are already out of school
  options: [opt('继续读高中', '朝着大学的方向努力。', 'low', 'study_hard', {}, 1.3), opt('读职业学校', '学一门手艺，早点工作。', 'low', 'vocational', {}, vocTrackWeight(f, X, 0.9)), opt('出去工作', '帮家里分担。', 'mid', 'drop_out_work', {}, (f.poorC ? 0.8 : 0.2) * clampN((1.05 - f.secEnroll / 100) * 4, 0.15, 1)), opt('出国交换一年', '去看看外面的世界。', 'mid', 'exchange_abroad', {}, 0.4, f.famRich)] } : null));
T([15], (f) => (!f.inSchool ? { key: 'k15_out', w: 3, title: '十五岁的出路', situation: '你已经不在学校了。同龄人有的进城打工，有的跟着师傅学手艺，有的留在家里种地。',
  options: [f.u ? opt(f.working ? '换份更好的工' : '在城里找份工', '早点挣钱养活自己。', 'mid', 'work_now', {}, 1.2) : opt('进城打工', `去${bigCity(f)}闯一闯。`, 'mid', 'migrate_city', { city: bigCity(f) }, 1.2), opt('学一门手艺', '拜师学艺，手上有活。', 'low', 'learn_trade', {}, 1.2),
    f.eduRank >= 2 ? opt('回学校读书', '把落下的书再捡起来。', 'mid', 'stay_school', { back: true }, 0.6) : opt('去上识字班', '先把字认全。', 'low', 'stay_school', {}, 0.6), opt('在家务农', '和家里人一起种地。', 'low', 'farming', {}, 1, f.r)] } : null));
T([15, 18], (f) => (f.fe && f.adolFert >= 80 && f.poorC && f.r && !f.couple ? { key: 'k15_marriage', w: 4, title: '有人上门提亲', situation: `媒人来了好几趟，家里人说对方家境不错。你才${f.age}岁，${f.inSchool ? '课本还摊在桌上' : '心里还有很多想做的事'}。`,
  options: [f.inSchool || (f.age < 16 && f.eduRank >= 2) ? opt('拒绝，继续读书', '我想先把书读完。', 'high', 'stay_school', { back: true }, 0.9) : opt('拒绝，先学门手艺', '靠自己的手艺站稳脚跟。', 'high', 'learn_trade', {}, 0.9), opt(f.inSchool ? '请老师帮忙说情' : '请长辈帮忙说情', '找能说上话的人来劝劝家里。', 'mid', 'seek_help', {}, 0.9), opt('听从家里安排', '也许这就是命。', 'high', 'early_marriage', {}, 0.8), opt('离家去城里', '一个人去外面闯。', 'high', 'migrate_city', {}, 0.3)] } : null));

// age 18
/**
 * Give the university options (uni, deferring service to study, study abroad) weights so that together they are
 * auto-chosen with probability `wish` (from the country's tertiary enrolment that year, see uniOdds). Only the first
 * four options count, as makeDecision keeps four. `share` in the option weights splits the total among them.
 */
function weighUni(options, wish) {
  const list = options.filter(Boolean).slice(0, 4);
  const isUni = (o) => o.act === 'uni' || o.act === 'defer_military' || (o.act === 'emigrate' && o.p && o.p.mode === 'study');
  const uni = list.filter(isUni);
  if (!uni.length) return options;
  const total = wishWeight(wish, list.filter((o) => !isUni(o)).reduce((s, o) => s + num(o.w, 1), 0));
  const shares = uni.map((o) => Math.max(0.05, num(o.w, 1)));
  const sum = shares.reduce((s, x) => s + x, 0);
  uni.forEach((o, i) => { o.w = (total * shares[i]) / sum; });
  return options;
}
T([18], (f, X) => {
  if (!f.chn || !f.inSchool || !canApply(f)) return null;
  const tech = f.year >= 2019 ? 'ai' : 'cs';
  const second = X.rng.chance(0.4) ? 'medicine' : X.rng.chance(0.5) ? 'education' : 'nursing';
  const options = [
    opt(`报考${FIELDS[tech].label}`, '热门专业，竞争激烈。', 'mid', 'uni', { field: tech }, 1.2),
    second === 'medicine' ? opt('报考医学', '学制长、压力大，但能治病救人。', 'mid', 'uni', { field: 'medicine' }, 0.8) : opt(`报考${FIELDS[second].label}`, '求稳，毕业好就业。', 'low', 'uni', { field: second }, 1),
    opt('读高职学门技术', '去职业院校学一门实在的手艺。', 'low', 'vocational', {}, 1),
    f.famPoor ? opt('不读了，去打工', '早点挣钱帮家里。', 'mid', f.u ? 'work_now' : 'migrate_city', f.u ? {} : { city: bigCity(f) }, 0.7) : opt('复读再战', '分数不理想，再拼一年。', 'high', 'exam_repeat', {}, 0.3),
  ];
  const gk = leavingExam(f);
  const said = gk && isNum(gk.score) ? `你考了 ${gk.score} 分${{ top: '，能挑的好学校不少', good: '，过了一本线', pass: '，过了本科线，但好学校够不着', fail: '，没过本科线' }[gk.result] || ''}。` : '';
  return { key: 'k18_gaokao', w: 8, title: gk && isNum(gk.score) ? `高考 ${gk.score} 分` : '高考志愿', situation: `高考结束了，${said}在{country}，这一年${share(terShare(f, X) * 100)}的同龄人能读大学。你拿着志愿表，笔迟迟落不下去。`,
    options: weighUni(options, uniWish(f, X)) };
});
T([18, 22], (f, X) => {
  if (!f.consc || f.flags.served || f.military || f.age > 28) return null;
  if (f.age >= 22 && !f.flags.deferred) return null;
  const options = [opt('现在就入伍', '早去早回，把义务先尽了。', f.war ? 'high' : 'mid', 'military', {}, 1.2), opt('先上大学再服役', '申请缓役，先读书。', 'mid', 'defer_military', { field: pickField(f, X) }, 1, f.age < 22 && canApply(f)), opt('申请替代役', '在公共服务岗位上完成义务。', 'low', 'alt_service', {}, 0.5, altServiceOk(f)), opt('出国留学', '去国外读书，暂缓服役。', 'high', 'emigrate', { mode: 'study' }, 0.3, f.famRich && f.age < 22 && canApply(f))];
  return { key: 'k18_conscript', w: 7, title: '兵役', situation: `按照{country}的规定，你需要服大约${f.consc.months}个月的兵役。${f.war ? '而此刻，战事正紧。' : ''}`,
    options: canApply(f) ? weighUni(options, 0.9 * uniWish(f, X)) : options };
});
T([18], (f, X) => {
  // school leavers who could go on to university (China's in-school leavers have the gaokao template instead)
  if (!canApply(f) || (f.chn && f.inSchool)) return null;
  const k1 = pickField(f, X);
  let k2 = pickField(f, X);
  for (let g = 0; g < 5 && k2 === k1; g++) k2 = pickField(f, X);
  if (k2 === k1) k2 = k1 === 'business' ? 'engineering' : 'business';
  const voc = f.eduRank >= 4;
  const poorOut = f.poorC && (f.famPoor || !f.inSchool);
  const abroad = opt('出国留学', '去国外读大学，花费不菲。', 'high', 'emigrate', { mode: 'study' }, 0.3, f.famRich || (f.fam > 0.6 && f.know >= 70));
  // a vocational graduate is not offered vocational school again; someone with a job is not offered "start working"
  const third = abroad || (voc ? null : opt('读职业学校', '学一门手艺，早点工作。', 'low', 'vocational', {}, 0.9));
  const work = f.working
    ? opt(voc ? '安心干本行' : '安心工作', voc ? '手艺在身，先把日子过好。' : '先把手上的工作做好。', 'low', 'stay_course', { say: voc ? '你没有去考大学，安心干起了本行。手上的活越来越熟，师傅开始把难活交给你。' : '你没有去考大学，把心思放在了手上的工作上。踏踏实实干了一年，你成了单位里靠得住的人。' }, 1)
    : poorOut && !f.u ? opt(`去${bigCity(f)}打工`, '先挣到钱再说。', 'mid', 'migrate_city', { city: bigCity(f) }, 1.2)
      : opt('直接工作', voc ? '凭手艺先挣钱。' : '先挣钱，再看机会。', 'low', 'work_now', {}, f.poorC ? 1.2 : 0.8);
  const options = [opt(`报考${FIELDS[k1].label}`, '去大学里系统地学一门专业。', 'mid', 'uni', { field: k1 }, 1.2), opt(`报考${FIELDS[k2].label}`, '换一个方向，也许更适合你。', 'mid', 'uni', { field: k2 }, 1), third, work];
  const ter = share(terShare(f, X) * 100);
  return { key: 'k18_uni', w: f.consc && !f.flags.served ? 2.5 : 5, title: voc ? '职校毕业以后' : '十八岁的路口',
    situation: voc ? `职业学校毕业了。在{country}，${ter}的同龄人能读大学。你是继续考大学，还是凭手艺工作？` : f.inSchool ? `中学快毕业了。在{country}，${ter}的同龄人能读大学。你得决定下一步怎么走。` : `中学毕业已经有一段时间了。在{country}，${ter}的同龄人能读大学。你还想不想去考一考？`,
    options: weighUni(options, uniWish(f, X)) };
});
T([18], (f) => {
  // out of school without a diploma that opens university: work, a trade, the city, or back to school
  if (canApply(f) || uniStudent(f) || f.inSchool || f.age > 25) return null;
  const back = f.eduRank >= 2 && f.eduRank < 4 && f.age <= 20 && !f.flags.secDone;
  return { key: 'k18_poor', w: f.poorC ? 3 : 2, title: f.poorC ? '出门闯荡' : '十八岁',
    situation: !f.poorC ? '你十八岁了，早早离开了学校。同龄人有的还在读书，你已经在社会上摸爬滚打了一阵。' : f.u ? '你十八岁了。家里需要钱，街坊里的年轻人有的进了工厂，有的去了更远的地方。' : '你十八岁了。家里需要钱，村里的年轻人一批批地走了，有的去了{bigcity}，有的去了更远的地方。',
    options: [f.u ? opt(f.working ? '换份更好的工' : '在城里找份工', '进工厂、做服务员，先挣到钱再说。', 'mid', 'work_now', {}, 1.5) : opt(`去${bigCity(f)}打工`, '进工厂、上工地，先挣到钱再说。', 'mid', 'migrate_city', { city: bigCity(f) }, 1.5),
      opt('出国务工', '工钱高，但要背井离乡好几年。', 'high', 'emigrate', { mode: 'labor' }, 0.7, f.remitC && f.poorC), opt('学一门手艺', '学门技术，走得更远。', 'low', 'learn_trade', {}, 1),
      f.r ? opt('留在家乡', '守着家里的地和老人。', 'low', 'farming', {}, 1) : back ? opt('回学校读完中学', '把没读完的书补上。', 'mid', 'stay_school', { back: true }, 0.5) : null] };
});
T(ADULT.concat([18]), (f, X) => {
  if (!f.war || f.age < 16) return null;
  // a school leaver can also leave the war zone to study elsewhere
  const study = canApply(f);
  const flee = opt(f.hasKids ? '带家人离开' : '去安全的地方', '投奔外地的亲友，从头再来。', 'mid', 'flee_war', {}, 1.2);
  const abroad = opt('出国避难', '走得更远，也许很久回不来。', 'high', 'flee_war', { mode: 'abroad' }, 0.6);
  const stay = opt('留下守着家', '这里有需要你的人。', 'high', 'stay_war', {}, 1);
  const army = opt('参军', '拿起武器保卫家园。', 'high', 'military', { voluntary: true }, 0.5, f.age <= 45 && !f.military);
  const options = study ? weighUni([flee, opt('去外地读大学', '离开战区，把书读下去。', 'mid', 'uni', { away: true }, 1), stay, army, abroad], 0.85 * uniWish(f, X)) : [flee, abroad, stay, army];
  return { key: 'k_war', w: study ? 2 : 7, title: '战火逼近', situation: `战事没有停歇的迹象。${f.hasKids ? '孩子们夜里总被惊醒。' : ''}留下，还是离开？`, options };
});

// 22
T([22], (f, X) => {
  if (!(uniStudent(f) || f.eduRank >= 5)) return null;
  const city = otherCity(f, X);
  const ops = [city ? opt(`去${city}闯一闯`, '机会多、节奏快、房租贵。', 'mid', 'job_bigcity', { city }, 1.3) : opt('进一家大公司', '机会多、节奏快、压力大。', 'mid', 'job_bigcity', {}, 1.3), opt('回家乡工作', '离家近，生活安稳。', 'low', 'job_hometown', {}, 1)];
  if (f.chn || f.iso === 'KOR' || f.iso === 'IND' || f.iso === 'VNM') ops.push(opt('考公务员', '求一个稳定的“铁饭碗”。', 'mid', 'civil_service', {}, 1.1));
  ops.push(opt('继续读研', '再读几年，把学历往上提。', 'mid', 'grad_school', {}, 0.8, f.know >= 50));
  ops.push(opt('出国深造', '出国读研究生，去更大的世界看看。', 'high', 'emigrate', { mode: 'study' }, 0.6, f.famRich || f.know >= 72));
  ops.push(opt('自己创业', '和同学一起做点事。', 'high', 'start_business', {}, 0.4));
  return { key: 'k22_grad', w: 3, title: '毕业去向', situation: `毕业季到了。${isNum(f.youthUnemp) ? `这一年{country}的青年失业率约为${f.youthUnemp.toFixed(1)}%。` : ''}同学们各奔东西，你也得选一条路。`, options: ops };
});
T([22], (f) => (!uniStudent(f) && f.eduRank < 5 && (f.working || f.unemployed) ? { key: 'k22_worker', w: 2, title: '二十出头', situation: '工作了几年，你开始琢磨：一辈子就这样了吗？',
  options: [opt('换个城市', `去${bigCity(f)}找更好的机会。`, 'mid', 'migrate_city', { city: bigCity(f) }, 1, !f.u), opt('学门技术', '有一技之长，腰杆才硬。', 'low', 'learn_trade', {}, 1.2), opt('开个小店', '自己当老板。', 'high', 'start_business', {}, 0.6), opt('出国务工', '工钱高，但要离家好几年。', 'high', 'emigrate', { mode: 'labor' }, 0.6, f.remitC), opt(f.working ? '换份工作' : '找份工作', '找个更合适的单位。', 'mid', 'job_switch', {}, 1)] } : null));
T([22, 26], (f) => (f.unemployed && !f.inSchool ? { key: 'k22_unemp', w: 3, title: '找不到工作', situation: `你已经找了好几个月工作。${isNum(f.youthUnemp) && f.youthUnemp >= 10 ? `{country}的青年失业率高达${f.youthUnemp.toFixed(1)}%。` : ''}存款一天天变少。`,
  options: [opt('先就业再择业', '降低要求，先干起来。', 'low', 'work_now', {}, 1.3), opt('跑零工', '按单挣钱，时间自由。', 'mid', 'gig', {}, 0.8, f.u), opt(f.eduRank >= 5 ? '考研深造' : '继续深造', f.eduRank >= 5 ? '读个研究生，避开这波寒潮。' : '去读个文凭，避开这波寒潮。', 'mid', 'study_more', { degree: true }, 0.6), opt('回家休整', '先缓一缓，再出发。', 'low', 'rest', {}, 0.5)] } : null));

// love and family (26-35)
T([26, 30], (f) => (f.single && !f.hasPartner ? { key: 'k_single', w: 2, title: '感情这件事', situation: f.sinic || f.sas || f.mena ? '身边的朋友一个个成了家，父母的电话里，问得最多的就是你的终身大事。' : '朋友们陆续有了伴侣。周末的晚上，你偶尔会觉得屋子太安静。',
  options: [opt('主动去认识人', '聚会、兴趣小组、交友软件。', 'mid', 'seek_partner', {}, 1.2), opt('接受相亲', '让家里人帮忙介绍。', 'low', 'seek_partner', { style: 'match' }, 1, f.sinic || f.sas || f.mena || f.iso === 'KOR'), opt('先专注事业', '感情的事，随缘吧。', 'low', 'focus_career', {}, 1), opt('一个人也很好', '不必为了结婚而结婚。', 'low', 'stay_single', {}, 0.6)] } : null));
T([22, 26, 30, 35, 40], (f) => (f.dating && f.hasPartner ? { key: 'k_dating', w: 3, title: '要不要结婚', situation: '你和{partner}在一起已经有一段时间了。两家人开始旁敲侧击，你们也偶尔会聊起以后。',
  options: [opt('结婚', '就是这个人了。', 'mid', 'marry', {}, 1.4), opt('再相处看看', '不急，再多了解一些。', 'low', 'wait_marriage', {}, 1), opt('先搬到一起住', '先过过两个人的日子。', 'mid', 'cohabit', {}, 0.8, !(f.sinic || f.mena || f.sas)), opt('分开', '也许彼此并不合适。', 'mid', 'breakup', {}, 0.3)] } : null));
T([26, 30], (f) => (f.employed ? { key: 'k26_career', w: 1.5, title: '事业起步', situation: '工作几年了，你对这一行越来越熟悉，也越来越清楚它的天花板在哪里。',
  options: [opt('跳槽涨薪', '去更好的平台。', 'mid', 'job_switch', {}, 1.2), opt('拼一把晋升', '在现在的单位往上走。', 'mid', 'promotion_push', {}, 1), opt('辞职创业', '自己做点事。', 'high', 'start_business', {}, 0.4), opt('出国发展', '去国外找机会。', 'high', 'emigrate', { mode: 'skilled' }, 0.4, f.eduRank >= 5 && !f.migrant), opt('学一门新技能', f.year >= 2023 ? '学 AI，为下一个十年做准备。' : '学编程或新技术，多一条路。', 'low', 'retrain_ai', {}, 0.6, f.internet >= 40)] } : null));
T([26, 30, 35], (f) => (f.couple && !f.hasKids && !f.flags.childfree && (f.fe ? f.age <= 40 : f.age <= 48) ? { key: 'k_child', w: 2.5, title: '要孩子吗',
  situation: `你和{partner}在一起有些年头了。${f.examCulture || f.sas ? '父母那边催得越来越紧，' : ''}你们也开始认真想这件事。${isNum(f.tfr) && f.tfr < 1.6 ? `在{country}，平均每位女性一生只生育约${f.tfr.toFixed(1)}个孩子。` : ''}`,
  options: [opt('现在要孩子', '趁年轻，迎接一个新生命。', 'mid', 'have_child', {}, 1.5), opt('再等几年', '先把工作和住处安顿好。', 'low', 'wait_child', {}, 1), opt('先买房再说', '给孩子一个稳定的家。', 'mid', 'buy_home', {}, 0.6, f.u && !f.homeowner), opt('决定不要孩子', '两个人的生活也很完整。', 'mid', 'childfree', {}, 0.4)] } : null));
T([30, 35], (f) => (f.couple && f.nKids === 1 && (f.fe ? f.age <= 40 : f.age <= 50) && !f.flags.noMoreKids ? { key: 'k_second', w: 1.5, title: '要不要再生一个', situation: '{child}一天天长大，常常问能不能有个弟弟妹妹。你们算了算时间、精力和钱。',
  options: [opt('再要一个', '让孩子有个伴。', 'mid', 'have_child', {}, 1), opt('一个就够了', '把心思都给这个孩子。', 'low', 'enough_kids', {}, 1.2), opt('过几年再说', '先顾好眼前。', 'low', 'wait_child', {}, 0.8)] } : null));

// 30
T([30, 35], (f, X) => {
  if (!(f.u && f.working && !f.homeowner && !f.lic)) return null;
  const other = otherCity(f, X);
  return { key: 'k30_home', w: 2.5, title: '买房还是租房', situation: `在{city}，一套小房子的首付抵得上好几年的收入。${f.couple ? '{partner}' : parentWord(f)}说，有房才算有个家。`,
    options: [opt('贷款买房', '背上房贷，换一个安稳。', 'mid', 'buy_home', {}, 1.3), opt('租房，钱拿去投资', '保持灵活。', 'mid', 'rent_invest', {}, 0.8), opt('回老家买房', '房价低，压力小。', 'low', 'buy_home', { hometown: true }, 0.6, f.ruralOrigin),
      other ? opt(`搬去${other}生活`, '换一个城市，重新开始。', 'mid', 'migrate_city', { city: other }, 0.4) : null] };
});
T([26, 30, 35], (f, X) => {
  if (f.eduRank < 5 || f.migrant || f.hic || f.age > 40) return null;
  const d1 = pickDest(f, X, 'skilled');
  if (!d1) return null;
  const d2 = pickDest(f, X, 'skilled', [d1]);
  const n1 = nameOf(X.data, d1);
  return { key: 'k_emigrate', w: 1.5, title: '出国的机会', situation: `一位在${n1}工作的老同学说，那边正缺你这样的人。你心动了，也犹豫着。`,
    options: [opt(`移民${n1}`, '带上行李和学历，从头再来。', 'high', 'emigrate', { dest: d1, mode: 'skilled' }, 0.8), d2 ? opt(`去${nameOf(X.data, d2)}工作`, '换一个国家试试。', 'high', 'emigrate', { dest: d2, mode: 'skilled' }, 0.5) : null,
      opt('留在{country}', '这里有家人和朋友。', 'low', 'stay_course', { say: '你谢过老同学的好意，决定留在{country}。家人朋友都在身边，你把心思放回了眼前的工作上。' }, 1.5), opt('先把外语学好', '机会留给有准备的人。', 'low', 'learn_language', {}, 1)] };
});
T([30], (f) => (f.working ? { key: 'k30_pivot', w: 1, title: '三十而立', situation: '三十岁了。同学有的当了领导，有的还在原地，有的已经转了好几次行。',
  options: [opt('转行', '去做真正想做的事。', 'high', 'career_switch', {}, 0.7),
    f.eduRank >= 5 ? opt('读在职研究生', '给自己充充电。', 'mid', 'grad_school', { partTime: true }, 0.6) : f.eduRank >= 3 ? opt('读个成人本科', '给自己补一张文凭。', 'mid', 'study_more', { degree: true }, 0.6) : opt('报个进修班', '给自己充充电。', 'low', 'study_more', {}, 0.6),
    opt(f.selfEmp ? '换个生意做' : '自己创业', '赌一把。', 'high', 'start_business', {}, 0.5), opt(f.selfEmp ? '守好现在的生意' : '稳住现在的工作', '一步一个脚印。', 'low', 'stay_course', { say: f.selfEmp ? '你没有跟风折腾，把心思放在了现在的生意上。熟客越来越多，日子过得踏实。' : '你没有跟风折腾，把心思放在了手上的工作上。一步一个脚印，日子过得踏实。' }, 1.4)] } : null));
T([22, 26, 30, 35, 40, 45, 50], (f) => (f.farmer && f.r && (f.title === '农民' || /农/.test(f.sector)) ? { key: 'k_farm', w: 2, title: '种地的出路', situation: `今年的{crop}价格${f.gdpGrowth > 3 ? '还算不错' : '一般'}，村里的年轻人越来越少了。`,
  options: [opt('扩大种植养殖', '多承包些地，搏一搏。', 'high', 'farm_expand', {}, 0.8), opt('学新的种植技术', '让每一亩地多打些粮。', 'low', 'farm_tech', {}, 1.2), opt('进城打工', `去${bigCity(f)}挣钱。`, 'mid', 'migrate_city', { city: bigCity(f) }, 1), opt('出国务工', '工钱高，但要离家几年。', 'high', 'emigrate', { mode: 'labor' }, 0.5, f.remitC && f.age <= 45)] } : null));

// 35-50
T([35], (f) => (f.working ? { key: 'k35_mid', w: 2, title: '中年的门槛', situation: `三十五岁了。${f.chn ? '招聘启事上“35岁以下”的字样越来越扎眼，' : '年轻同事一茬一茬地进来，'}你开始想，下半场怎么打。`,
  options: [opt(f.year >= 2023 ? '学 AI 新技能' : '学一门新技能', '为下一个十年做准备。', 'mid', 'retrain_ai', {}, 1, f.internet >= 30), opt(f.selfEmp ? '把生意做大' : '拼一把晋升', '再往上走一步。', 'mid', 'promotion_push', {}, 1), opt(f.selfEmp ? '换个生意做' : '辞职创业', '为自己干。', 'high', 'start_business', {}, 0.5), opt('多陪陪家人', '有些东西比升职更重要。', 'low', 'family_time', {}, 1)] } : null));
T([35, 40, 45], (f) => (f.kidSchool ? { key: 'k_kids_edu', w: 2, title: '孩子的教育', vars: kidVar(f, (k) => k.age >= 6 && k.age <= 17), situation: '{child}正在读书，成绩起起伏伏。你想给TA最好的，可“最好”到底是什么？',
  options: [opt('买学区房', '为了一所好学校。', 'high', 'school_district', {}, 0.8, f.chn && f.u), opt('报补习班', '多学一点，总没坏处。', 'mid', 'kid_tutor', {}, 1, !(f.chn && f.year >= 2021 && f.year <= 2025)), opt('让孩子自由成长', '快乐比分数重要。', 'low', 'kid_free', { young: true }, 1), opt('送出国读书', '去看更大的世界。', 'high', 'kid_abroad', {}, 0.4, f.kidTeen && (f.famRich || f.wealth >= 70))] } : null));
T([35, 40, 45, 50], (f) => (f.couple && f.happy < 45 ? { key: 'k_marriage_trouble', w: 2, title: '婚姻亮起红灯', situation: '你和{partner}之间的争吵越来越多，冷战一次比一次长。',
  options: [opt('一起去做咨询', '再给彼此一次机会。', 'mid', 'couple_therapy', {}, 1.2), opt('分开冷静一段', '各自想清楚。', 'mid', 'separate', {}, 0.8), opt('离婚', '长痛不如短痛。', 'high', 'divorce', {}, 0.5),
    opt('为了家维持现状', '日子总得过下去。', 'low', 'stay_course', { say: '你和{partner}谁也没再提分开的事。为了这个家，日子还是一天天过下去，只是饭桌上的话少了很多。', fx: [0, -2, 0, -1, 0] }, 1)] } : null));
T([35, 40], (f) => (f.neverMarried && !f.hasPartner ? { key: 'k35_single', w: 1.2, title: '一个人的日子', situation: `${f.age}岁，一个人。有人替你着急，你自己倒越来越习惯了。`,
  options: [opt('再试试找个伴', '也许缘分还在路上。', 'mid', 'seek_partner', {}, 1), opt('一个人也很好', '把日子过成自己喜欢的样子。', 'low', 'stay_single', {}, 1.2), opt('养只宠物', '家里多一个等你回来的。', 'low', 'pet', {}, 0.8), opt('考虑领养孩子', '给一个孩子一个家。', 'high', 'adopt', {}, 0.3, f.hic || f.umc)] } : null));
T([40], () => ({ key: 'k40_health', w: 1.5, title: '体检报告', situation: '四十岁的体检报告上多了几个向上的箭头。医生推了推眼镜：“该注意了。”',
  options: [opt('开始锻炼', '每天动起来。', 'low', 'exercise', {}, 1.2), opt('戒烟戒酒', '把坏习惯戒掉。', 'mid', 'quit_smoking', {}, 1.2), opt('调整饮食作息', '少油少盐，早睡早起。', 'low', 'diet', {}, 1), opt('不当回事', '身体还扛得住。', 'high', 'ignore_health', {}, 0.5)] }));
// a parent's old age comes up at most once in twelve years (milestone or trigger), and only while a parent is alive
T([40, 45, 50, 55, 60, 65], (f) => (f.parentOld && f.parentAlive ? { key: 'k_parents', w: 2, cooldown: PARENT_GAP, title: `${parentWord(f)}老了`, situation: `${parentWord(f)}的身体大不如前了。上次回家，你发现${parentWord(f) === '父母' ? '他们' : parentWord(f)}连楼梯都走得很吃力。`,
  options: [opt('接到身边同住', '一家人在一起，彼此照应。', 'mid', 'care_parents', { mode: 'move_in' }, 1), opt('搬回去照顾', '放下手头的一切，回到老人身边。', 'high', 'care_parents', { mode: 'move_back' }, 0.6), opt('请护工照顾', '花钱买专业的照护。', 'mid', 'care_parents', { mode: 'hire' }, 0.8, !f.lic), opt('常回家看看', '多打电话，多回去。', 'low', 'care_parents', { mode: 'visit' }, 1.2)] } : null));
T([40, 45, 50], (f) => (f.working && f.cash + f.portfolio > 12 * f.monthRef ? { key: 'k_money', w: 1.5, title: '一笔积蓄', situation: '这些年你攒下了一笔钱。银行理财、股票、房子……身边每个人都有自己的主意。',
  options: [opt('买股票基金', '让钱生钱。', 'mid', 'invest_stocks', {}, 1), opt('再买一套房', '看得见摸得着。', 'mid', 'invest_property', {}, 0.8, f.cash + f.portfolio > 30 * f.monthRef), opt('存着最踏实', '以备不时之需。', 'low', 'save', {}, 1.2), opt('买点加密货币', '高风险，高波动。', 'high', 'invest_crypto', {}, 0.3, f.year >= 2013)] } : null));
T([45], (f) => (f.working ? { key: 'k45_career', w: 1.5, title: '职业下半场', situation: '四十五岁。你在这一行积累了不少经验，也看到了身体和精力的边界。',
  options: [opt(f.selfEmp ? '把生意做大' : '争取管理岗', f.selfEmp ? '多雇几个人，往上走。' : '带团队，往上走。', 'mid', 'promotion_push', {}, 1), opt(f.selfEmp ? '把生意收小一点' : '换个轻松的工作', '少挣点，多活得像自己。', 'low', 'downshift', {}, 0.8), opt(f.selfEmp ? '换个生意做' : '自己出来干', '把经验变成事业。', 'high', 'start_business', {}, 0.5), opt('学点新东西', '别被时代甩下。', 'low', 'study_more', {}, 0.8)] } : null));
T([45, 50], (f) => (f.kids.some((k) => k.age >= 15 && k.age <= 18) ? { key: 'k_kid_future', w: 2, title: '孩子的升学', vars: kidVar(f, (k) => k.age >= 15 && k.age <= 18), situation: '{child}快要中学毕业了，一家人围着饭桌讨论了好几个晚上。',
  options: [opt('送出国读书', '多花些钱，见更大的世界。', 'high', 'kid_abroad', {}, 0.5, f.famRich || f.wealth >= 65), opt('在本地读大学', '离家近，彼此有个照应。', 'low', 'kid_local', {}, 1.2), opt('让TA自己决定', '孩子的路，孩子自己走。', 'low', 'kid_free', {}, 1), opt('读职业学校', '学一门实在的手艺。', 'low', 'kid_vocational', {}, 0.6)] } : null));
T([30, 35, 40, 45, 50, 55, 60], (f) => (f.migrant ? { key: 'k_migrant', w: 3, title: '回去还是留下', situation: `在{country}生活了${Math.max(1, f.year - num(f.flags.migrantSince, f.year - 3))}年，你常常在深夜想起{origin}。`,
  options: [opt('留下来扎根', '这里已经是第二个家。', 'mid', 'settle', {}, 1.4), opt('回到故乡', '落叶归根。', 'mid', 'return_home', {}, 1), opt('把父母接来', '一家人团聚。', 'high', 'bring_parents', {}, 0.5, f.parentAlive), opt('再去别的国家', '继续往前走。', 'high', 'emigrate', {}, 0.3)] } : null));
T([50], () => ({ key: 'k50_second', w: 1.2, title: '五十岁', situation: '五十岁了。孩子大了，事业也到了一个平台。你想给后半生找点新的意义。',
  options: [opt('学一门新东西', '活到老，学到老。', 'low', 'study_more', {}, 1), opt('做志愿服务', '帮帮需要帮助的人。', 'low', 'volunteer', {}, 1), opt('去远方旅行', '看看从没去过的地方。', 'mid', 'travel', {}, 1), opt('开始写作或画画', '把心里的东西留下来。', 'low', 'art_career', { kind: 'writer' }, 0.7)] }));
T([40, 45, 50, 55, 60, 65, 70, 75, 80], (f) => (f.sick ? { key: 'k_illness', w: 4, title: '治疗方案', situation: `医生把几种治疗方案摆在你面前，每一种都有代价。${f.physicians < 0.8 ? '好的医院离家很远，' : ''}家人在门外等着你的决定。`,
  options: [opt('积极治疗', '能做的都做，不留遗憾。', 'high', 'treatment_aggressive', {}, 1.2), opt('规范保守治疗', '按医生的方案，稳扎稳打。', 'low', 'treatment_standard', {}, 1.2), opt('配合传统调养', '在治疗之外调养身心。', 'mid', 'treatment_traditional', {}, 0.6, f.sinic || f.sas || f.ssa || f.sea), opt('去外地求医', '去医疗条件更好的地方。', 'high', 'treatment_abroad', {}, 0.5, f.wealth >= 55)] } : null));
T([26, 30, 35, 40, 45, 50, 55, 60], (f) => (f.automation && f.employed ? { key: 'k_automation', w: 4, title: '自动化浪潮', situation: '公司宣布引入新的智能系统，很多岗位将被重新“优化”。会议室里一片安静。',
  options: [opt('学习 AI 转岗', '和机器一起工作。', 'mid', 'retrain_ai', {}, 1.2), opt('转行做护理或手艺', '做机器替代不了的事。', 'mid', 'career_switch', { to: 'hands' }, 1), opt('拿补偿先休息', '缓一缓再出发。', 'mid', 'quit_job', { severance: true }, 0.6), opt('自己创业', '与其等待，不如出击。', 'high', 'start_business', {}, 0.4)] } : null));

// 55-70
T([55], (f, X) => {
  if (!f.working) return null;
  const ra = retirementAge(f, X);
  return { key: 'k55_plan', w: 2, title: '退休倒计时', situation: `离{country}的法定退休年龄（约${ra}岁）越来越近了。${f.poorC && (f.farmer || f.selfEmp) ? '可你没有正式的养老金。' : ''}`,
    options: [opt('提前退休', '把时间还给自己。', 'mid', 'retire_early', {}, 0.8), opt('干到法定年龄', '站好最后一班岗。', 'low', 'keep_working', {}, 1.3), opt('转成兼职', '工作和生活各一半。', 'low', 'part_time', {}, 0.8), opt('再创一次业', '人生没有太晚的开始。', 'high', 'start_business', {}, 0.3)] };
});
T([55, 60, 65], (f) => (f.kids.some((k) => k.age >= 25) ? { key: 'k_grandkids', w: 1.5, title: '帮忙带孙辈', vars: kidVar(f, (k) => k.age >= 25), situation: '{child}的工作很忙，想请你帮忙带孩子。',
  options: [opt('搬过去帮忙带', '一家人在一起。', 'low', 'grandkids_care', {}, 1.2), opt('偶尔帮帮忙', '周末去看看。', 'low', 'family_time', { kind: 'grandkids' }, 1), opt('过自己的日子', '辛苦了一辈子，该为自己活了。', 'low', 'travel', { lead: '你跟{child}说好，孩子还是由他们自己带，你想趁身体还好，多出去走走。' }, 0.6), opt('去上老年大学', '学点自己喜欢的。', 'low', 'senior_school', {}, 0.5)] } : null));
T([60, 65], (f, X) => {
  const ra = retirementAge(f, X);
  if (!f.working || f.age < ra - 1 || (f.poorC && (f.farmer || f.selfEmp))) return null;
  return { key: 'k60_retire', w: 4, title: '到了退休的年纪', situation: `你到了{country}的退休年龄（约${ra}岁）。单位里已经有人开始和你交接工作。`,
    options: [opt('按时退休', '好好歇一歇。', 'low', 'retire', {}, 1.5), opt('返聘继续干', '手艺还在，还想发挥余热。', 'low', 'keep_working', { rehire: true }, 0.7), opt('退休后去旅居', '去暖和的地方过冬。', 'mid', 'retire', { then: 'move_warm' }, 0.4, f.wealth >= 55), opt('回乡养老', '回到出发的地方。', 'low', 'retire', { then: 'return_home' }, 0.5, f.ruralOrigin || f.migrant)] };
});
T([60, 65, 70], (f) => (f.poorC && !f.retired && (f.farmer || f.selfEmp || f.unemployed) ? { key: 'k60_nopension', w: 3, title: '没有退休金的晚年', situation: '同龄人有的开始领退休金了，可你没有。往后的日子怎么过，得早做打算。',
  options: [opt('继续干活', '能干一天是一天。', 'mid', 'keep_working', {}, 1.3), opt('投靠子女', '让孩子们帮衬着。', 'low', 'move_to_kids', {}, 1, f.hasKids), opt('做点小生意', '摆个小摊，补贴家用。', 'mid', 'start_business', {}, 0.5), opt('申请社会救助', '去问问有没有补助。', 'low', 'welfare', {}, 0.8)] } : null));
T([60, 65, 70], (f) => (f.retired ? { key: 'k_where', w: 2, title: '在哪里养老', situation: '退休以后，住在哪里成了一家人讨论的话题。',
  options: [opt('留在这里', '熟悉的街坊，熟悉的医院。', 'low', 'stay_course', { say: '你决定哪儿也不去，就在住了几十年的地方养老。熟悉的街坊、熟悉的医院，出门遛个弯都能碰到老朋友。' }, 1.3), opt('回老家', '叶落归根。', 'low', 'return_home', {}, 0.8, f.ruralOrigin || f.migrant), opt('搬去子女那里', '离孩子近一点。', 'low', 'move_to_kids', {}, 0.8, f.hasKids), opt('去温暖的地方', '让关节少受点罪。', 'mid', 'move_warm', {}, 0.4, f.wealth >= 55)] } : null));
T([65], (f) => ({ key: 'k65_life', w: 1.5, title: f.retired ? '退休生活' : '六十五岁', situation: f.retired ? '日子一下子空了出来。你想好好安排一下这份难得的自由。' : '六十五岁了。不管还在不在干活，你都想给往后的日子添点自己喜欢的东西。',
  options: [opt('上老年大学', '学书法、摄影、乐器。', 'low', 'senior_school', {}, 1), opt('帮忙带孙辈', '享受天伦之乐。', 'low', 'grandkids_care', {}, 1, f.kids.some((k) => k.age >= 20) || !!f.flags.grandparent), opt('跳舞交朋友', '热热闹闹地过日子。', 'low', 'friends', {}, 1), opt('做志愿者', '发挥余热。', 'low', 'volunteer', {}, 0.8)] }));

// 70+
T([70, 75, 80], (f) => ({ key: 'k_care', w: f.health < 50 ? 3 : 1.5, title: '养老的安排', situation: `{name}，你${f.age}岁了。腿脚不如从前，${f.single || f.widowed ? '一个人住，' : ''}${f.hasKids ? '孩子们总不放心。' : '邻居们常来敲门问候。'}`,
  options: [opt('居家养老', '在熟悉的家里慢慢变老。', 'low', 'home_care', {}, 1.3), opt('住进养老院', '有专业的人照顾。', 'mid', 'nursing_home', {}, 0.7, !(f.lic && f.r)), opt('和子女同住', '一家人互相照应。', 'low', 'move_to_kids', {}, 1, f.hasKids), opt('用上智能照护', '让机器帮把手。', 'mid', 'smart_care', {}, 0.8, f.robots || f.aiDoctor)] }));
T([70, 75], () => ({ key: 'k_legacy', w: 1.5, title: '留下些什么', situation: '你开始想，这一辈子，要给后来的人留下些什么。',
  options: [opt('写回忆录', '把这一生写下来。', 'low', 'write_memoir', {}, 1), opt('立好遗嘱', '把身后事安排清楚。', 'low', 'will', {}, 0.8), opt('回故乡看看', '再看一眼出发的地方。', 'low', 'return_home', { visit: true }, 1), opt('和老朋友聚聚', '趁大家都还在。', 'low', 'reunion', {}, 1)] }));
T([75, 80, 85], (f) => (f.year >= 2012 ? { key: 'k_tech', w: 1, title: '跟上这个时代', situation: f.year >= 2035 ? '家里的机器越来越聪明，孙辈说的新词你越来越听不懂。' : '手机能付款、能视频、能叫车，可那些按钮你总是记不住。',
  options: [opt('学用新科技', '不服老，跟上趟。', 'low', 'learn_tech', {}, 1), opt('安静地过日子', '老办法也挺好。', 'low', 'rest', {}, 1), opt('多陪陪家人', '最好的科技是陪伴。', 'low', 'family_time', {}, 1), opt('写下这一生', '把故事留给后人。', 'low', 'write_memoir', {}, 0.6)] } : null));
T([55, 60, 65, 70, 75, 80, 85], (f) => (f.longevity && !f.flags.longevityTx && !declinedRecently(f, 'longevity') ? { key: 'k_longevity', w: 3, title: '延寿疗法', situation: '新一代抗衰老疗法已经进入医院。医生说，你的身体条件适合尝试，但费用不低。',
  options: [opt('接受治疗', '多一些健康的年头。', 'mid', 'longevity_treatment', {}, 1), opt('顺其自然', '生老病死，自有规律。', 'low', 'decline_treatment', { decline: 'longevity' }, 1), opt('再观察几年', '等技术更成熟一些。', 'low', 'decline_treatment', { decline: 'longevity', wait: true }, 0.8)] } : null));
T([85], (f) => ({ key: 'k85_wishes', w: 2, title: '最后的心愿', situation: `你${f.age}岁了。很多事情都慢了下来，你开始想，还有什么心愿没有了却。`,
  options: [opt('回故乡看一看', '再闻一闻家乡的味道。', 'low', 'return_home', { visit: true }, 1), opt(f.hasKids ? '拍一张全家福' : '和亲友拍张合影', '把所有人都叫回来。', 'low', 'family_time', { kind: 'photo' }, 1.2), opt('把故事讲给后辈', '让他们记得来时的路。', 'low', 'write_memoir', { tell: true }, 1), opt('安安静静过日子', '晒晒太阳，喝喝茶。', 'low', 'rest', {}, 1)] }));
T([85], (f) => (f.sick || f.health < 35 ? { key: 'k85_medical', w: 3, title: '治疗的选择', situation: '医生说，病情到了需要做选择的时候。家人围在床边，等你开口。',
  options: [opt('积极治疗', '再拼一次。', 'high', 'treatment_aggressive', {}, 0.6), opt('舒缓治疗', '少些痛苦，多些陪伴。', 'low', 'treatment_palliative', {}, 1.3), opt('回家休养', '在熟悉的地方。', 'low', 'home_care', { hospital: true }, 1)] } : null));

// world line overlays
T([22, 26, 30, 35, 40], (f) => (f.mars && f.age <= 45 && f.eduRank >= 5 && f.health >= 60 && !f.flags.marsApplicant && !declinedRecently(f, 'mars', 30) ? { key: 'kx_mars', w: 1, title: '火星招募', situation: '火星定居项目开始面向全球招募新一批成员。报名表上写着：单程，至少十年。',
  options: [opt('报名火星项目', '去另一颗星球上生活。', 'high', 'mars_colony', {}, 0.5), opt('留在地球', '这里有你爱的人。', 'low', 'stay_course', { decline: 'mars', say: '你把报名表放回了抽屉。火星很远，身边的人很近，你决定留在地球上，好好过自己的日子。' }, 1.5), opt('去地面中心工作', '换一种方式参与。', 'mid', 'mars_ground', { decline: 'mars' }, 0.6)] } : null));
T(ADULT, (f) => ((f.seaRisk || (f.heat && f.proj && f.climateBad)) && !f.flags.relocated && !declinedRecently(f, 'climate', 12) ? { key: 'kx_climate', w: 2.5, title: '气候迁移', situation: f.seaRisk ? '海水一年比一年逼近，社区开始讨论整体搬迁。你家的保险公司也寄来了停保通知。' : '夏天一年比一年难熬，最热的那几周，屋里像蒸笼一样。邻居们有的已经搬走了。',
  options: [opt('搬去更安全的地方', '离开熟悉的家园。', 'mid', 'relocate_disaster', {}, 1.2), opt('留下加固房子', '这里是我的家。', 'mid', 'rebuild', { decline: 'climate', fortify: true }, 1), opt('移民他国', '去一个更适合生活的地方。', 'high', 'emigrate', {}, 0.4, (f.eduRank >= 4 || f.wealth >= 60) && f.age <= 75)] } : null));
T(ADULT, (f) => (f.covid && f.working && f.u && f.ruralOrigin ? { key: 'kx_pandemic', w: 1.5, title: '疫情中的去留', situation: `城市一次次${f.chn ? '封控' : '封城'}，生意和工作都停摆了。老家的亲人打来电话，让你回去避一避。`,
  options: [opt('回老家避一避', '一家人在一起心里踏实。', 'mid', 'return_home', { visit: true, shelter: true }, 1), opt('留在城里坚持', '工作不能丢。', 'mid', 'stay_course', { say: '你留在了城里，守着工作和出租屋。封控的日子里，你和邻居们互相送菜、一起团购，熬过了最难的那段时间。', fx: [0, -1, 0, 2, 1] }, 1), opt('居家学新技能', '把时间用起来。', 'low', 'retrain_ai', {}, 0.6, f.internet >= 40), opt('换个行业', '找个更稳的饭碗。', 'mid', 'career_switch', {}, 0.4)] } : null));
// always-available fallback
T(SLOTS, (f) => ({ key: 'k_generic', w: 0.15, title: '新的一年', situation: `${f.age}岁的这一年，你想给生活添点什么？`,
  options: f.age < 16 ? [opt('多读几本书', '让书带你去远方。', 'low', 'child_books', {}, 1), opt('交几个好朋友', '一起玩，一起长大。', 'low', 'child_social', {}, 1), opt('多到户外跑跑', '把身体练结实。', 'low', 'child_play', {}, 1)]
    : [opt('学点新东西', '给脑子充充电。', 'low', 'study_more', {}, 1), opt('多陪陪家人', '时间要花在重要的人身上。', 'low', 'family_time', {}, 1), opt('锻炼身体', '健康是一切的本钱。', 'low', 'exercise', {}, 1), opt('出去走走', '看看不一样的风景。', 'mid', 'travel', {}, 0.8)] }));

/** template key -> last year it was used in this life (parsed from decision ids) */
function usedKeys(state) {
  const s = new Map();
  for (const d of Array.isArray(state && state.decisions) ? state.decisions : []) {
    const m = /^d-(.+?)-(\d{4})-\d+-/.exec(String((d && d.id) || ''));
    if (m) s.set(m[1], Math.max(s.get(m[1]) || 0, +m[2]));
  }
  return s;
}
function chooseSpec(f, X, slot) {
  const used = usedKeys(f.state);
  const specs = [];
  for (const t of TPL) {
    if (!t.slots.includes(slot)) continue;
    let s = null;
    try { s = t.fn(f, X); } catch { s = null; }
    if (!s || !Array.isArray(s.options) || s.options.filter(Boolean).length < 2) continue;
    const last = used.get(s.key);
    const gap = last == null ? 99 : f.year - last;
    // a template with its own cooldown never repeats within it
    if (isNum(s.cooldown) && gap < s.cooldown) continue;
    // the same dilemma does not come back within 4 years (unless nothing else fits); later it is rarer
    const damp = gap <= 4 ? 0 : gap <= 10 ? 0.2 : gap < 99 ? 0.6 : 1;
    specs.push({ s, w: num(s.w, 1) * damp, gap });
  }
  if (!specs.length) return null;
  const fresh = specs.filter((x) => x.w > 0);
  if (!fresh.length) return specs.sort((a, b) => b.gap - a.gap)[0].s;
  return (X.rng.weighted(fresh, (x) => x.w) || fresh[0]).s;
}

/* ------------------------------------------------------------------ triggered decisions */

const TRIGGERS = [
  { key: 'war', gap: 1, p: 0.6, when: (f) => f.war && !f.displaced && f.age >= 12, spec: (f, X) => TPL_BY_KEY('k_war', f, X) || TPL_BY_KEY('kc_war', f, X) },
  { key: 'layoff', gap: 3, p: 0.35, when: (f) => f.unemployed && !f.inSchool && (f.recession || f.automation || f.covid) && f.in(22, 62), spec: (f) => ({ key: 't_layoff', title: '失业之后', situation: '失业已经几个月了。存款一天天变少，招聘网站上的岗位越来越少。',
    // "going home" only for someone who left a home somewhere else
    options: [opt('学新技能转行', '为下一份工作做准备。', 'mid', 'retrain_ai', {}, 1), opt('先打零工', '先把日子撑住。', 'mid', 'gig', {}, 1), opt('回老家', '回去从长计议。', 'low', 'return_home', {}, 0.6, f.ruralOrigin || f.migrant || !!f.flags.migratedCity), opt('自己做点小生意', '与其等，不如干。', 'high', 'start_business', {}, 0.4)] }) },
  { key: 'automation', gap: 8, p: 0.18, when: (f) => f.employed && f.automation && f.in(25, 62), spec: (f, X) => TPL_BY_KEY('k_automation', f, X) },
  { key: 'illness', gap: 5, p: 0.4, when: (f) => f.sick && f.age >= 30, spec: (f, X) => TPL_BY_KEY('k_illness', f, X) || TPL_BY_KEY('k85_medical', f, X) },
  { key: 'offer', gap: 5, p: 0.06, when: (f) => f.employed && f.know >= 60 && f.in(24, 50), spec: (f, X) => {
    const abroad = f.eduRank >= 5 && !f.migrant && X.rng.chance(0.35);
    const dest = abroad ? pickDest(f, X, 'skilled') : null;
    // a domestic offer comes from another big city of the country the person lives in now, never from their own city;
    // where there is no other city (a city-state) the offer is a better job in the same city
    const here = hereCity(f, X);
    const others = (CITIES[f.iso] || []).slice(0, 5).filter((c) => c !== here && c !== f.flags.city);
    const where = dest ? nameOf(X.data, dest) : others.length ? others[X.rng.int(0, others.length - 1)] : null;
    const back = opt('拿邀请谈加薪', '让现在的单位看到你的价值。', 'mid', 'promotion_push', { leverage: true }, 0.6);
    if (!where) {
      return { key: 't_offer', title: '一份邀请', situation: '一家更大的公司向你发来了邀请，薪水比现在高出不少。',
        options: [opt('接受邀请', '换一家公司，挑战更大。', 'mid', 'accept_offer', { same: true }, 0.8), opt('婉拒邀请', '留在熟悉的地方。', 'low', 'decline_offer', {}, 1.2), back] };
    }
    return { key: 't_offer', title: '一份邀请', situation: `一家${dest ? '国外' : '外地'}公司向你发来了邀请：去${where}工作，薪水比现在高出不少。`,
      options: [opt(`去${where}`, '换一片天地，挑战更大。', 'high', 'accept_offer', dest ? { dest } : { city: where }, 0.8), opt('婉拒邀请', '留在熟悉的地方。', 'low', 'decline_offer', {}, 1.2), back] };
  } },
  { key: 'parent', gap: PARENT_GAP, p: 0.1, when: (f) => f.parentOld && f.parentAlive && f.in(35, 70), spec: (f, X) => TPL_BY_KEY('k_parents', f, X) },
  { key: 'disaster', gap: 8, p: 0.12, when: (f) => (f.flood || f.quake || f.storm) && f.age >= 18, spec: (f) => ({ key: 't_disaster', title: '灾后', situation: `${f.quake ? '地震' : f.flood ? '洪水' : '风暴'}过后，你家受了损。救援队走了，日子还得继续。`,
    options: [opt('留下重建家园', '和邻居们一起把家修好。', 'mid', 'rebuild', {}, 1.3), opt('搬去更安全的地方', '换个地方重新开始。', 'mid', 'relocate_disaster', {}, 0.8), opt(`去${bigCity(f)}投亲`, '先找个落脚的地方。', 'low', 'migrate_city', { kin: true, city: bigCity(f) }, 0.5, !f.u)] }) },
  { key: 'climate', gap: 6, p: 0.12, when: (f) => f.seaRisk && f.in(25, 80), spec: (f, X) => TPL_BY_KEY('kx_climate', f, X) },
  { key: 'windfall', gap: 6, p: 0.02, when: (f) => f.in(25, 75), spec: () => ({ key: 't_windfall', title: '一笔意外之财', situation: '一位远房长辈留给你一笔钱。不算巨款，却足够让你认真想想怎么用。',
    options: [opt('存起来', '以备不时之需。', 'low', 'save', { windfall: true }, 1.2), opt('投资理财', '让它慢慢长大。', 'mid', 'invest_stocks', { windfall: true }, 0.8), opt('捐出一部分', '帮帮需要的人。', 'low', 'volunteer', { windfall: true }, 0.5), opt('犒劳一下家人', '吃顿好的，买点东西。', 'low', 'spend', { windfall: true }, 0.8)] }) },
  { key: 'proposal', gap: 3, p: 0.18, when: (f) => f.dating && f.hasPartner && f.year - f.partnerSince >= 2 && f.in(20, 50), spec: (f, X) => TPL_BY_KEY('k_dating', f, X) },
  { key: 'longevity', gap: 12, p: 0.15, when: (f) => f.longevity && f.age >= 55 && !f.flags.longevityTx, spec: (f, X) => TPL_BY_KEY('k_longevity', f, X) },
  { key: 'homesick', gap: 5, p: 0.08, when: (f) => f.migrant && f.year - num(f.flags.migrantSince, f.year) >= 3, spec: (f, X) => TPL_BY_KEY('k_migrant', f, X) },
  { key: 'mars', gap: 10, p: 0.04, when: (f) => f.mars && f.in(22, 45) && f.eduRank >= 5, spec: (f, X) => TPL_BY_KEY('kx_mars', f, X) },
  { key: 'marriage_pressure', gap: 3, p: 0.15, when: (f) => f.fe && f.in(13, 17) && f.adolFert >= 80 && f.poorC && f.r && !f.couple, spec: (f, X) => TPL_BY_KEY('k15_marriage', f, X) },
];
const TPL_KEYS = new Map();
/** the milestone template with this key, evaluated for this life (null when it does not apply) */
function TPL_BY_KEY(key, f, X) {
  if (!TPL_KEYS.size) {
    for (const t of TPL) {
      const m = /key:\s*["'`]([a-z0-9_]+)["'`]/.exec(String(t.fn));
      if (m && !TPL_KEYS.has(m[1])) TPL_KEYS.set(m[1], t);
    }
  }
  const t = TPL_KEYS.get(key);
  if (t) {
    try {
      const s = t.fn(f, X);
      if (s && s.key === key) return s;
    } catch { /* fall through */ }
  }
  // robust fallback (e.g. if a build step rewrote function sources): evaluate templates until one yields the key
  for (const u of TPL) {
    if (u === t) continue;
    try {
      const s = u.fn(f, X);
      if (s && s.key === key) return s;
    } catch { /* ignore */ }
  }
  return null;
}

/* ------------------------------------------------------------------ public API */

const FREQ_CACHE = new Map();
function frequentAges(seed) {
  const k = String(seed);
  if (FREQ_CACHE.has(k)) return FREQ_CACHE.get(k);
  const out = [];
  for (let a = 5; a <= MAX_AGE; a += 2 + (hashString(`${k}:freq:${a}`) % 2)) out.push(a);
  if (FREQ_CACHE.size > 50) FREQ_CACHE.clear();
  FREQ_CACHE.set(k, out);
  return out;
}
function decisionAges(state, frequency) {
  const freq = frequency || (state && state.settings && state.settings.decisionFreq) || 'standard';
  if (Array.isArray(DECISION_FREQUENCY[freq])) return DECISION_FREQUENCY[freq];
  if (freq === 'frequent') return frequentAges((state && (state.seed || state.id)) || 1);
  return DECISION_AGES;
}

/** Next milestone age strictly after the current age (999 when none remains). */
export function nextDecisionAge(state, frequency) {
  const age = Math.max(0, Math.floor(num(state && state.age, 0)));
  const n = decisionAges(state, frequency).find((a) => a > age);
  return n == null ? 999 : n;
}

function makeX(data, world, state, ctx, rng, f, extra = {}) {
  const fctx = ctx && typeof ctx === 'object' ? ctx : {};
  const base = extra.vars && typeof extra.vars === 'object' ? extra.vars : null;
  return {
    data, world, state, ctx: fctx, rng, key: extra.key || '',
    fill: (s, vars) => fillText(s, state, fctx, rng, base || vars ? { ...(base || {}), ...(vars || {}) } : undefined, f),
    pick: (arr) => rng.pick(arr),
  };
}
function factsFor(data, world, state, ctx) {
  return lifeFacts(data, world, state, ctx && typeof ctx === 'object' ? ctx : {});
}

/** Offline milestone decision for the current life-year (never throws, always 2-4 options). */
export function buildDecisionOffline(data, world, state, ctx, rng) {
  const R = rng && typeof rng.next === 'function' ? rng : rngFor(state, `decision:${state && state.year}:${state && state.age}`);
  let f;
  try { f = factsFor(data, world, state, ctx); } catch { f = null; }
  if (!f) return fallbackDecision(state);
  const X = makeX(data, world, state, ctx, R, f);
  try {
    const spec = chooseSpec(f, X, slotFor(f.age));
    if (spec) return makeDecision(f, X, spec, 'milestone');
  } catch { /* fall through */ }
  return fallbackDecision(state);
}
function fallbackDecision(state) {
  const year = num(state && state.year, 2000);
  const age = num(state && state.age, 0);
  return {
    id: `d-k_generic-${year}-${age}-fb`, year, age, kind: 'milestone', title: '新的一年', situation: '这一年，你想给生活添点什么？',
    options: [{ id: 'a', label: '学点新东西', detail: '给脑子充充电。', risk: 'low' }, { id: 'b', label: '多陪陪家人', detail: '时间要花在重要的人身上。', risk: 'low' }, { id: 'c', label: '锻炼身体', detail: '健康是一切的本钱。', risk: 'low' }],
    allowCustom: true, source: 'local',
    context: { key: 'k_generic', acts: { a: { act: 'study_more', p: {} }, b: { act: 'family_time', p: {} }, c: { act: 'exercise', p: {} } }, auto: { a: 1, b: 1, c: 1 } },
  };
}

/**
 * A decision forced by circumstances (war, layoff, illness, offers, disasters ...), or null.
 * At most about one every few years; never on a milestone age; marks state.person.flags['trig:last'].
 */
export function triggeredDecision(data, world, state, ctx, rng) {
  if (!state || state.dead || !state.person || state.pending) return null;
  const R = rng && typeof rng.next === 'function' ? rng : rngFor(state, `trigger:${state.year}`);
  let f;
  try { f = factsFor(data, world, state, ctx); } catch { return null; }
  if (f.age < 5) return null;
  if (decisionAges(state).includes(f.age)) return null;
  if ((Array.isArray(state.decisions) ? state.decisions : []).some((d) => d && num(d.year, -99) >= f.year - 1)) return null;
  const flags = state.person.flags || (state.person.flags = {});
  const last = num(flags['trig:last']);
  const sinceAny = last == null ? 99 : f.year - last;
  const X = makeX(data, world, state, ctx, R, f);
  const cands = TRIGGERS.filter((t) => {
    try {
      if (!t.when(f)) return false;
    } catch { return false; }
    const lk = num(flags[`trig:${t.key}`]);
    const minGap = t.gap <= 1 ? 1 : 3;
    return sinceAny >= minGap && (lk == null || f.year - lk >= t.gap);
  });
  if (!cands.length) return null;
  const t = R.weighted(cands, (c) => c.p) || cands[0];
  if (!R.chance(t.p)) return null;
  let spec = null;
  try { spec = t.spec(f, X); } catch { spec = null; }
  if (!spec) return null;
  // the same dilemma as a recent decision is not asked again (war and disasters excepted), nor within its own cooldown
  const lastSame = usedKeys(state).get(spec.key);
  if (lastSame != null && t.gap > 1 && f.year - lastSame < Math.max(5, num(spec.cooldown, 0))) return null;
  X.key = spec.key;
  const d = makeDecision(f, X, spec, 'triggered');
  flags['trig:last'] = f.year;
  flags[`trig:${t.key}`] = f.year;
  return d;
}

/** Choice a typical person in this life would make (weights from the decision context, risk and mood). */
export function autoChoose(state, decision, rng) {
  const opts = decision && Array.isArray(decision.options) ? decision.options.filter((o) => o && o.id) : [];
  if (!opts.length) return { customText: '顺其自然，先把眼前的日子过好。' };
  const R = rng && typeof rng.next === 'function' ? rng : rngFor(state, `auto:${decision && decision.id}`);
  const st = (state && state.stats) || {};
  const age = num(state && state.age, 30);
  const bold = clampN(0.5 + (num(st.happiness, 50) - 50) / 200 + (num(st.wealth, 50) - 50) / 250 + (age < 30 ? 0.12 : age > 60 ? -0.15 : 0), 0.15, 0.9);
  const riskW = { low: 1.2 - bold * 0.4, mid: 1, high: 0.3 + bold * 0.8 };
  // the weights belong to the offline options; options rewritten by the AI under the same ids get no preference
  const ctx = decision.context && typeof decision.context === 'object' ? decision.context : {};
  const auto = ctx.auto || {};
  const own = (o) => !ctx.labels || ctx.labels[o.id] === o.label;
  const pick = R.weighted(opts, (o) => Math.max(0.02, own(o) ? num(auto[o.id], 1) : 1) * (riskW[o.risk] || 1)) || opts[0];
  return { optionId: pick.id };
}

/* ------------------------------------------------------------------ resolution */

function genericByRisk(f, X, label, risk) {
  const r = risk === 'high' ? 'high' : risk === 'low' ? 'low' : 'mid';
  if (r === 'low') return out(f, X, `你选择了「${label}」。日子照常往前走，这个决定让你心里踏实了一些。`, [0, 2, 1, 1, 0]);
  const good = X.rng.chance(r === 'high' ? 0.45 : 0.6);
  if (r === 'mid') return good ? out(f, X, `你选择了「${label}」。起初有些磕磕绊绊，后来事情慢慢顺了起来，你庆幸自己迈出了这一步。`, [0, 4, 2, 1, 1]) : out(f, X, `你选择了「${label}」。结果不太如意，但你从中学到了不少，也更清楚下一步该怎么走。`, [0, -2, 2, 0, -0.5]);
  return good ? out(f, X, `你选择了「${label}」，这是一次冒险。好在运气站在了你这边，事情的发展超出了你的预期。`, [0, 6, 2, 2, 3]) : out(f, X, `你选择了「${label}」，这是一次冒险。事情没有朝你希望的方向发展，你花了不少时间才缓过来。`, [-1, -5, 2, -1, -3]);
}
function genericCustom(f, X, text) {
  const q = shortText(text, 30);
  if (looksLikeNoise(text)) {
    return out(f, X, '你脑子里闪过一个念头，可一时也说不清具体要做什么。这一年，日子照常往前走。', [0, 0, 0, 0, 0],
      { feasible: false, note: '没能理解这个想法，可以换个更具体的说法' });
  }
  if (FANTASY_RE.test(text)) {
    return out(f, X, `「${q}」——这个愿望只能留在梦里了。你笑了笑，把它写进日记本，转身去过眼前真实的日子。`, [0, 1, 0, 0, 0], { feasible: false, note: '现实中做不到' });
  }
  const tone = X.rng.next();
  const txt = tone < 0.4 ? `你把「${q}」这个念头认真放在了心上，一点点去做。过程比想象中曲折，但这段经历让你更了解自己。`
    : tone < 0.75 ? `「${q}」——你这样想，也这样去做了。起初身边的人不太理解，后来也慢慢接受了。这件事在你的生活里留下了一道浅浅的印记。`
      : `你试着去做「${q}」。事情没有完全按计划进行，可你并不后悔试过。`;
  return out(f, X, txt, [0, X.rng.int(0, 2), X.rng.int(0, 1), X.rng.int(0, 1), -0.2]);
}
const LIGHT_ACTS = new Set(['travel', 'exercise', 'quit_smoking', 'diet', 'learn_hobby', 'learn_language', 'volunteer', 'family_time',
  'care_parents', 'friends', 'pet', 'save', 'health_check', 'therapy', 'faith', 'rest', 'retrain_ai', 'side_hustle', 'write_memoir', 'reunion']);
function resolveCustom(f, X, text) {
  const c = classifyIntent(text, X.data);
  const top = c.intents[0];
  if (!top) return genericCustom(f, X, text);
  const I = INTENT_BY_ID.get(top);
  let act = I.act;
  const p = { ...(I.p || {}) };
  if (c.targetCountry) {
    if (c.targetCountry === f.iso) {
      if (act === 'emigrate') act = 'migrate_city';
      if (c.targetCity) {
        p.city = c.targetCity; p.cityIso = c.targetCountry;
        // "去深圳找工作" means moving there for work, unless the person already lives there
        if (['job_switch', 'work_now', 'gig'].includes(act) && f.flags.city !== c.targetCity) act = 'migrate_city';
        if (act === 'travel') p.place = c.targetCity;
      }
    } else if (act !== 'travel') {
      p.dest = c.targetCountry;
      if (['study_more', 'uni', 'grad_school', 'learn_language'].includes(act) && f.age >= 16) { act = 'emigrate'; p.mode = 'study'; }
      if (['migrate_city', 'job_switch', 'accept_offer', 'move_city', 'stay_course', 'gig', 'work_now'].includes(act)) act = 'emigrate';
      if (act === 'emigrate' && !p.mode && /留学|读书|上学|读研|读大学|硕士|博士/.test(text)) p.mode = 'study';
      if (act === 'emigrate' && !p.mode && /打工|务工|干活|工地|做工/.test(text)) p.mode = 'labor';
    } else p.dest = c.targetCountry;
  } else if (c.targetCity && act === 'migrate_city') p.city = c.targetCity;
  // details the player gave in their own words
  const shop = /开(?:一家|一间|一个|个|家|间)?([一-龥]{0,6}?(?:咖啡馆|奶茶店|餐馆|饭店|小吃店|书店|花店|面馆|超市|网店|工作室|诊所|理发店|修车铺|服装店|面包店|民宿|农场|工厂|公司|小店|店|馆|铺))/.exec(text);
  if (shop && act === 'start_business') p.kind = shop[1].replace(/^(?:一家|一间|一个)/, '');
  if (/爸妈|父母|家人|孩子|老婆|老公|伴侣|全家|妈妈|爸爸/.test(text)) p.together = true;
  const hobby = /学(?:会|着)?((?:做|画|弹|跳|拉|吹|唱|拍|写|织|种|养|开)[一-龥]{1,5})/.exec(text);
  if (act === 'learn_hobby') {
    if (hobby) p.thing = hobby[1].replace(/[了吧吗呢啊呀的]+$/, '');
    else { const k = c.keywords.find((w) => /^学./.test(w) && INTENT_BY_ID.get('learn_hobby').kw.includes(w)); if (k) p.thing = k.slice(1); }
  }
  if (act === 'start_business' && /回老家|回乡|返乡|回家乡|回村|回国|回故乡/.test(text)) p.hometown = true;
  if (act === 'study_more' && DEGREE_RE.test(text)) p.degree = true;
  if (act === 'faith') p.kind = /基督|教堂|天主|受洗|圣经|教会|做礼拜|主日/.test(text) ? 'church' : /清真|伊斯兰|古兰|穆斯林|朝觐/.test(text) ? 'mosque' : /出家|剃度/.test(text) ? 'monastic' : /佛|寺|禅|念经|烧香/.test(text) ? 'temple' : /道观|道教/.test(text) ? 'taoist' : undefined;
  if (act === 'gamble' && /彩票|刮刮乐|双色球|大乐透/.test(text) && !/赌场|赌博|赌钱|博彩/.test(text)) p.kind = 'lottery';
  if (act === 'pet') p.kind = /猫/.test(text) ? '一只猫' : /狗/.test(text) ? '一只狗' : /鱼/.test(text) ? '一缸鱼' : /鸟|鹦鹉/.test(text) ? '一只鸟' : undefined;
  if (act === 'farming') p.kind = /养羊|放羊|放牧/.test(text) ? 'herd' : /养猪|养鸡|养牛|养殖/.test(text) ? 'livestock' : undefined;
  if (act === 'gig') p.title = /外卖/.test(text) ? '外卖骑手' : /网约车|滴滴/.test(text) ? '网约车司机' : /出租/.test(text) ? '出租车司机' : /快递/.test(text) ? '快递员' : undefined;
  if (act === 'invest_stocks') { act = 'invest_plan'; const plan = investPlanOf(text); p.market = plan.market; p.style = plan.style; p.where = plan.where; }
  if (act === 'ai_hustle') p.kind = aiKindOf(text).kind;
  X.key = `custom-${top}`;
  const r = runAct(act, f, X, p);
  // a second, lighter plan in the same sentence (「辞职去旅行」「戒烟，每天跑步」) leaves a trace at half strength;
  // only actions that do not change school, work, partner or country, so the two never contradict each other
  const second = c.intents.slice(1).map((id) => INTENT_BY_ID.get(id)).find((I2) => I2 && LIGHT_ACTS.has(I2.act) && I2.act !== act);
  if (second && r && r.feasible !== false) {
    try {
      X.key = `custom-${second.id}`;
      const r2 = runAct(second.act, f, X, {});
      if (r2 && r2.feasible !== false) {
        const first = String(r2.narrative || '').match(/^[^。！？]*[。！？]/);
        if (first) r.narrative = `${r.narrative}${first[0]}`;
        const e = r.effects || (r.effects = {});
        for (const [k, v] of Object.entries(r2.effects || {})) if (typeof v === 'number') e[k] = (Number(e[k]) || 0) + v * 0.5;
        if (r2.set && r2.set.flags) r.set = merge(r.set || {}, { flags: r2.set.flags });
      }
    } catch { /* the main plan stands on its own */ }
  }
  const q = shortText(text, 24);
  const lead = top === 'crisis' ? `那段时间，你心里压着很重的东西，甚至说出了「${q}」这样的话。`
    : top === 'illegal' ? `你动过一个危险的念头：「${q}」。`
      : r.feasible === false ? `你想过：「${q}」。` : top === 'stay' ? `你对自己说：「${q}」。` : `你下定决心：「${q}」。`;
  r.narrative = lead + r.narrative;
  return r;
}
function resolveByText(f, X, opt0) {
  const text = `${opt0.label || ''} ${opt0.detail || ''}`;
  const c = classifyIntent(text, X.data);
  if (!c.intents.length) return genericByRisk(f, X, opt0.label || '这个选择', opt0.risk);
  const I = INTENT_BY_ID.get(c.intents[0]);
  const p = { ...(I.p || {}) };
  if (c.targetCountry && c.targetCountry !== f.iso) p.dest = c.targetCountry;
  if (I.act === 'study_more' && DEGREE_RE.test(text)) p.degree = true;
  X.key = `opt-${I.id}`;
  const r = runAct(c.targetCountry && c.targetCountry !== f.iso && I.act === 'migrate_city' ? 'emigrate' : I.act, f, X, p);
  r.narrative = `你选择了「${opt0.label}」。` + r.narrative;
  return r;
}

const RES_EFFECTS = ['health', 'happiness', 'knowledge', 'relationships'];
function cleanObj(o) {
  try { return JSON.parse(JSON.stringify(o || {})); } catch { return {}; }
}
function finalize(r, f) {
  const res = r && typeof r === 'object' ? r : {};
  const eff = res.effects || {};
  const effects = {};
  for (const k of RES_EFFECTS) effects[k] = ci(eff[k]);
  const cap = Math.max(1000, f.monthRef * 60);
  effects.wealthDelta = Math.round(clampN(num(eff.wealthDelta, 0), -cap, cap));
  let narrative = String(res.narrative || '').replace(/\{\w+\}/g, '').trim();
  if (!narrative) narrative = '你做出了选择。日子照常往前走，结果还要慢慢显现。';
  const outR = {
    narrative,
    effects,
    set: cleanObj(res.set),
    threads: (Array.isArray(res.threads) ? res.threads : []).filter((t) => t && t.id && t.trigger).map((t) => {
      const te = t.effects || {};
      const e2 = {};
      for (const k of RES_EFFECTS) e2[k] = ci(te[k]);
      e2.wealthDelta = Math.round(clampN(num(te.wealthDelta, 0), -cap, cap));
      const th2 = { ...t, text: String(t.text || '').replace(/\{\w+\}/g, ''), effects: e2 };
      if (t.set) th2.set = cleanObj(t.set);
      if (t.decision) th2.decision = cleanObj(t.decision);
      return th2;
    }),
    feasible: res.feasible !== false,
  };
  if (res.hazard && isNum(res.hazard.mult)) outR.hazard = hz(res.hazard.mult, res.hazard.years, res.hazard.reason);
  if (res.note) outR.note = String(res.note);
  return outR;
}

/**
 * Resolve a decision offline (CONTRACT §3 Resolution). choice: {optionId} | {customText} | optionId string.
 * Never throws; always returns a complete Resolution.
 */
export function resolveOffline(data, world, state, decision, choice, rng) {
  const R = rng && typeof rng.next === 'function' ? rng : rngFor(state, `resolve:${decision && decision.id}:${JSON.stringify(choice || null)}`);
  let f;
  try { f = factsFor(data, world, state, {}); } catch { f = null; }
  if (!f) {
    return { narrative: '你做出了选择。日子照常往前走，结果还要慢慢显现。', effects: { health: 0, happiness: 0, knowledge: 0, relationships: 0, wealthDelta: 0 }, set: {}, threads: [], feasible: true };
  }
  const dctx = decision && decision.context && typeof decision.context === 'object' ? decision.context : {};
  const vars = dctx.vars && typeof dctx.vars === 'object' ? Object.fromEntries(Object.entries(dctx.vars).filter(([k, v]) => /^\w+$/.test(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 40)])) : null;
  const X = makeX(data, world, state, {}, R, f, { key: dctx.key || (decision && decision.id) || 'decision', vars });
  let r = null;
  try {
    const custom = choice && typeof choice === 'object' && typeof choice.customText === 'string' ? choice.customText.trim() : '';
    // free text is read against this decision first: 「选第二个」「答应他」「听爸妈的」 pick an option, in the player's words
    const read = custom ? interpretCustom(custom, decision, data, f.iso) : null;
    if (custom && read.kind !== 'option') r = resolveCustom(f, X, custom);
    else {
      const id = read ? read.optionId : typeof choice === 'string' ? choice : choice && choice.optionId;
      const opts = decision && Array.isArray(decision.options) ? decision.options : [];
      const o = opts.find((x) => x && x.id === id) || opts[0];
      // the stored act belongs to the offline option with this id; an option rewritten by the AI is read by its text
      const labels = dctx.labels && typeof dctx.labels === 'object' ? dctx.labels : null;
      const same = o && (labels ? labels[o.id] === o.label : decision.source !== 'ai');
      const a = o && same && decision.context && decision.context.acts ? decision.context.acts[o.id] : null;
      if (a && A[a.act]) r = runAct(a.act, f, X, a.p || {});
      else if (o) r = resolveByText(f, X, o);
      else r = genericCustom(f, X, (decision && decision.situation) || '顺其自然');
      if (read && r) r.narrative = `「${shortText(custom, 24)}」——你最后这样决定了。${r.narrative || ''}`;
    }
  } catch {
    r = null;
  }
  if (!r) r = { narrative: '你做出了选择。日子照常往前走，结果还要慢慢显现。', effects: {}, set: {}, threads: [], feasible: true };
  return finalize(r, f);
}

/** Exposed for tests and the integrator: every action key the resolver understands. */
export const ACTION_KEYS = Object.freeze(Object.keys(A));
export const INTENT_IDS = Object.freeze(INTENTS.map((i) => i.id));

