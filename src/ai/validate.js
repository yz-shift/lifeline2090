// Pure validators for everything the AI returns. Every function either returns a clean, bounded object that the
// engine can apply directly, or null when the input is unusable (the director then falls back to the offline engine).
// Nothing here trusts the model: numbers are clamped, enums checked, ISO3 codes verified against the data store,
// unknown fields dropped, text stripped of markup and cut to length. No DOM, no randomness, no clocks.

import { EDU_LEVELS, CAREER_STATUS, RELATIONSHIP_LABELS, FIRST_YEAR } from '../core/constants.js';
import { hashString } from '../core/rng.js';

/** Separator line between the streamed narrative and the trailing JSON in resolution / biography answers. */
export const JSON_MARKER = '===JSON===';

export const LIMITS = Object.freeze({
  effect: 15,              // stat effects are ints in [-15, 15]
  wealthMultiple: 5,       // |wealthDelta| <= 5 x annual income (or the floor below)
  wealthFloor: 1500,       // intl $; minimum "income" used for the cap (children, unemployed)
  wealthAbsCap: 2000000,   // intl $; absolute cap for any single outcome
  hazardMin: 0.5, hazardMax: 2,
  hazardYearsMax: 30,
  threadsPerResolution: 3,
  threadYearsMax: 30,
  flagsPerSet: 8,
  incomePctStep: 0.35,     // largest change of income percentile from a single outcome
  label: 16, title: 18, situation: 180, detail: 60,
  narrative: 600, note: 80, threadTitle: 20, threadText: 160,
  bio: 1600, bioTitle: 24, epitaph: 40, highlight: 40, highlights: 6,
  story: 420, tagline: 24,
});

const RELATIONSHIP_STATUS = Object.keys(RELATIONSHIP_LABELS);
const PARENT_EDU = ['none', 'primary', 'secondary', 'tertiary'];
const RISKS = ['low', 'mid', 'high'];
const DECISION_KINDS = ['milestone', 'triggered', 'custom'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof',
  'isprototypeof', 'propertyisenumerable', 'tolocalestring', '__definegetter__', '__definesetter__',
  '__lookupgetter__', '__lookupsetter__']);
const BIRTH_YEAR_MAX = 2070;

/* ------------------------------------------------------------------ small helpers */

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Finite number from a number or numeric string, else null. */
export function toNum(v) {
  if (typeof v === 'string') {
    const t = v.trim().replace(/[,，\s]/g, '');
    if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
    v = Number(t);
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function clampInt(v, lo, hi, dflt = 0) {
  const n = toNum(v);
  return n == null ? dflt : Math.round(clampNum(n, lo, hi));
}

/** Code-point aware truncation. Long prose is cut at the last sentence end when possible. */
export function truncate(s, max, ellipsis = true) {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max).join('');
  if (max >= 40) {
    let best = -1;
    for (const p of ['。', '！', '？', '!', '?', '；', '\n']) best = Math.max(best, cut.lastIndexOf(p));
    if (best >= Math.floor(cut.length * 0.6)) return cut.slice(0, best + 1).trim();
  }
  if (!ellipsis) return cut.trim();
  return Array.from(cut).slice(0, Math.max(1, max - 1)).join('').trim() + '…';
}

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

/**
 * Clean untrusted text: drops HTML tags (and script/style bodies), angle brackets, control and bidi characters,
 * Markdown emphasis/headers; collapses whitespace; truncates to `max` code points.
 * Numbers are accepted and stringified; anything else becomes ''.
 */
export function cleanText(v, max = 200, { multiline = false, ellipsis = true } = {}) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  let s = v.length > 20000 ? v.slice(0, 20000) : v;
  s = s.replace(/<\s*(script|style|iframe|object|embed|svg|math|template)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '');
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '');
  s = s.replace(/<\/?[a-z!?][^<>]*>?/gi, '');
  s = s.replace(/&(lt|gt|amp|quot|apos|#39|nbsp);/gi, (m, e) => ({ lt: '', gt: '', amp: '&', quot: '"', apos: "'", '#39': "'", nbsp: ' ' })[e.toLowerCase()]);
  s = s.replace(/[<>]/g, '');
  s = s.replace(CONTROL_RE, '');
  s = s.replace(/\*\*|__|`+/g, '');
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  s = s.replace(/\bjavascript\s*:/gi, '');
  if (multiline) {
    s = s.replace(/\r\n?/g, '\n').replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }
  s = s.trim();
  return truncate(s, max, ellipsis);
}

const len = (s) => Array.from(s || '').length;

/** True when iso is an uppercase ISO3 code that exists in the data store. */
export function hasIso(data, iso) {
  if (typeof iso !== 'string' || !/^[A-Z]{3}$/.test(iso) || !data) return false;
  try {
    if (typeof data.country === 'function') return !!data.country(iso);
  } catch { /* fall through */ }
  const c = data.countries;
  return !!(c && Object.prototype.hasOwnProperty.call(c, iso) && c[iso]);
}

/** Normalise a country reference (ISO3 in any case, or a Chinese / English country name) to an existing ISO3. */
export function resolveIso(data, v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  const up = t.toUpperCase();
  if (hasIso(data, up)) return up;
  const list = isoListOf(data);
  const low = t.toLowerCase();
  for (const iso of list) {
    const c = countryOf(data, iso);
    if (!c) continue;
    if (c.name === t || (typeof c.en === 'string' && c.en.toLowerCase() === low)) return iso;
  }
  return null;
}

export function isoListOf(data) {
  if (!data) return [];
  if (Array.isArray(data.isoList)) return data.isoList;
  return data.countries ? Object.keys(data.countries).filter((k) => /^[A-Z]{3}$/.test(k)).sort() : [];
}

export function countryOf(data, iso) {
  if (!data || typeof iso !== 'string') return undefined;
  try {
    if (typeof data.country === 'function') return data.country(iso) || undefined;
  } catch { /* fall through */ }
  return data.countries && Object.prototype.hasOwnProperty.call(data.countries, iso) ? data.countries[iso] : undefined;
}

function seriesOf(data, iso, key, year) {
  try {
    const v = data && typeof data.series === 'function' ? data.series(iso, key, year) : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function safeKey(k) {
  if (typeof k !== 'string') return null;
  const t = k.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(t) || UNSAFE_KEYS.has(t)) return null;
  return t;
}

const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

/* ------------------------------------------------------------------ JSON extraction (streamed answers) */

/** Tolerant JSON parse: whole text, a fenced block, or first '{' .. last '}' (trailing commas repaired). Objects only. */
export function parseLooseJSON(text) {
  if (isObj(text)) return text;
  if (typeof text !== 'string') return null;
  let t = text.trim();
  if (!t) return null;
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  const candidates = [t];
  if (fence) candidates.push(fence[1].trim());
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
  for (const c of candidates) {
    for (const variant of [c, c.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const v = JSON.parse(variant);
        if (isObj(v)) return v;
      } catch { /* try next */ }
    }
  }
  return null;
}

// The marker is asked for on its own line, but models also write it at the end of the last sentence, with the JSON
// on the same line, or in Markdown emphasis (**===JSON===**): accept it anywhere.
const MARKER_RE = /[*_`]*={2,}[ \t]*json[ \t]*={2,}[*_`]*/i;
// a marker still being written at the very end of a streamed text ("…。==", "…。===JS", "…。**===JSON")
const PARTIAL_MARKER_TAIL_RE = /[*_`]*(={2,}[ \t]*(j(s(o(n)?)?)?)?|=[ \t]*j(s(o(n)?)?)?)[ \t]*=*[*_`]*$/i;
const JSON_START_RE = /(^|\n)[ \t]*(```(?:json)?[ \t]*\n?[ \t]*\{|\{[ \t]*\n?[ \t]*")/i;

/**
 * Split a "narrative, then ===JSON===, then JSON" answer. Tolerates a missing marker when the JSON
 * starts on its own line. Returns {narrative, json|null, hasMarker}.
 */
export function splitNarrativeJSON(text) {
  if (typeof text !== 'string') return { narrative: '', json: null, hasMarker: false };
  const m = MARKER_RE.exec(text);
  let narrative = text;
  let rest = '';
  if (m) {
    narrative = text.slice(0, m.index);
    rest = text.slice(m.index + m[0].length);
  } else {
    const j = JSON_START_RE.exec(text);
    if (j) {
      const at = j.index + j[1].length;
      narrative = text.slice(0, at);
      rest = text.slice(at);
    }
  }
  narrative = narrative.replace(/```[a-z]*\s*$/i, '').trim();
  return { narrative, json: parseLooseJSON(rest), hasMarker: !!m };
}

/** The part of a streaming answer that may be shown to the player (everything before the JSON, partial markers hidden). */
export function visibleNarrative(text) {
  if (typeof text !== 'string' || !text) return '';
  let t = text;
  const m = MARKER_RE.exec(t);
  if (m) t = t.slice(0, m.index);
  const j = JSON_START_RE.exec(t);
  if (j) t = t.slice(0, j.index + j[1].length);
  const nl = t.lastIndexOf('\n');
  const tail = t.slice(nl + 1);
  if (/^[ \t]*(=+[ \t]*(j(s(o(n)?)?)?)?[ \t]*=*|`{1,3}[a-z]*|\{[ \t]*)$/i.test(tail) && tail.trim()) t = t.slice(0, nl + 1);
  t = t.replace(PARTIAL_MARKER_TAIL_RE, '');
  return t.replace(/\s+$/, '');
}

/* ------------------------------------------------------------------ decisions */

function validateOptions(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  const seen = new Set();
  for (const o of arr.slice(0, 8)) {
    const src = typeof o === 'string' ? { label: o } : o;
    if (!isObj(src)) continue;
    const label = cleanText(src.label ?? src.title ?? src.text, LIMITS.label, { ellipsis: false });
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const detail = cleanText(src.detail ?? src.description ?? '', LIMITS.detail);
    const risk = RISKS.includes(src.risk) ? src.risk : 'mid';
    out.push({ id: 'abcd'[out.length], label, detail, risk });
    if (out.length === 4) break;
  }
  return out.length >= 2 ? out : null;
}

/**
 * validateDecision(raw, fallback) -> Decision|null
 * `fallback` (usually the offline decision for the same moment) supplies id/year/age/kind/context;
 * without it raw.year and raw.age are required.
 */
export function validateDecision(raw, fallback = null) {
  if (!isObj(raw)) return null;
  if (isObj(raw.decision) && !Array.isArray(raw.options)) raw = raw.decision;
  const title = cleanText(raw.title, LIMITS.title);
  const situation = cleanText(raw.situation ?? raw.description, LIMITS.situation);
  const options = validateOptions(raw.options);
  if (!title || len(situation) < 6 || !options) return null;
  const fb = isObj(fallback) ? fallback : {};
  const year = toNum(fb.year) ?? toNum(raw.year);
  const age = toNum(fb.age) ?? toNum(raw.age);
  if (year == null || age == null || year < FIRST_YEAR || year > 2300 || age < 0 || age > 130) return null;
  const kind = DECISION_KINDS.includes(fb.kind) ? fb.kind : DECISION_KINDS.includes(raw.kind) ? raw.kind : 'milestone';
  const id = typeof fb.id === 'string' && fb.id ? fb.id
    : `ai-${Math.round(year)}-${Math.round(age)}-${hashString(title + situation).toString(36)}`;
  const out = { id, year: Math.round(year), age: Math.round(age), kind, title, situation, options, allowCustom: true, source: 'ai' };
  if (isObj(fb.context)) out.context = fb.context;
  return out;
}

/* ------------------------------------------------------------------ resolutions */

/** Largest |wealthDelta| allowed for this person (intl $). */
export function wealthCap(state, data) {
  const p = state && state.person;
  const income = Math.max(0, toNum(p && p.money && p.money.income) || 0);
  const iso = (p && p.country) || (state && state.birth && state.birth.country);
  const gdp = seriesOf(data, iso, 'gdp_pc_ppp', (state && state.year) || 2025) || 0;
  const base = Math.max(income, LIMITS.wealthFloor, 0.4 * gdp);
  return Math.round(Math.min(LIMITS.wealthAbsCap, LIMITS.wealthMultiple * base));
}

/** {health,happiness,knowledge,relationships: ints -15..15, wealthDelta: bounded int} — always returns an object. */
export function validateEffects(raw, cap = LIMITS.wealthAbsCap) {
  const e = isObj(raw) ? raw : {};
  const out = {};
  for (const k of ['health', 'happiness', 'knowledge', 'relationships']) out[k] = clampInt(e[k], -LIMITS.effect, LIMITS.effect, 0);
  const w = toNum(e.wealthDelta ?? e.wealth_delta ?? e.money);
  out.wealthDelta = w == null ? 0 : Math.round(clampNum(w, -cap, cap));
  return out;
}

export function validateHazard(raw) {
  if (!isObj(raw)) return null;
  const m = toNum(raw.mult ?? raw.multiplier);
  if (m == null) return null;
  const mult = Math.round(clampNum(m, LIMITS.hazardMin, LIMITS.hazardMax) * 100) / 100;
  if (Math.abs(mult - 1) < 0.02) return null;
  const years = clampInt(raw.years, 1, LIMITS.hazardYearsMax, 5);
  const reason = cleanText(raw.reason, 30) || (mult > 1 ? '健康风险上升' : '生活方式改善');
  return { mult, years, reason };
}

/**
 * Flags whose value the engine itself maintains and relies on (a country code for the parents' life tables, the
 * school track, the home purchase and its loan, migration status that follows real moves). A model answer must not
 * overwrite them: `origin: "MARS"` would break the parents' mortality lookups for the rest of the life, and
 * `homeowner: true` would buy a house on credit for a child. Migration is expressed through `set.country`.
 */
export const ENGINE_FLAGS = new Set(['origin', 'track', 'field', 'trade', 'homeowner', 'mortgage', 'migrant', 'migrantsince', 'gradyear', 'kidtarget', 'firstunion']);
/** Flags the engine reads as "the year this began": a plain `true` from the model becomes the current year. */
const YEAR_FLAGS = new Set(['pet', 'displaced', 'examfail']);

/** validateFlags(raw, {year}?) -> at most 8 safe flags, or null. */
export function validateFlags(raw, { year = null } = {}) {
  if (!isObj(raw)) return null;
  const out = {};
  let n = 0;
  const y = toNum(year);
  for (const [k0, v] of Object.entries(raw)) {
    if (n >= LIMITS.flagsPerSet) break;
    const k = safeKey(k0);
    if (!k || ENGINE_FLAGS.has(k)) continue;
    let val = null;
    if (typeof v === 'boolean') val = v;
    else if (typeof v === 'number') val = Number.isFinite(v) ? Math.round(clampNum(v, -1e6, 1e6) * 100) / 100 : null;
    else if (typeof v === 'string') val = bool(v.trim().toLowerCase()) ?? (cleanText(v, 24) || null);
    if (val === null) continue;
    if (YEAR_FLAGS.has(k)) {
      if (val === true && y != null) val = Math.round(y);
      else if (!(val === false || (typeof val === 'number' && val >= FIRST_YEAR && val <= 2300))) continue;
    }
    out[k] = val;
    n++;
  }
  return n ? out : null;
}

function legalMarriageAge(state, data) {
  try {
    const lp = data && typeof data.lifePath === 'function' ? data.lifePath(state.person.country) : null;
    const v = lp && lp.legal_marriage_age && toNum(lp.legal_marriage_age[state.person.sex]);
    if (v != null) return clampNum(v, 14, 25);
  } catch { /* default */ }
  return 16;
}

/**
 * validateSet(raw, state, data, {feasible}) -> Resolution.set (possibly {}).
 * education/career/relationship are partial patch objects of the person's sub-objects.
 */
export function validateSet(raw, state, data, { feasible = true } = {}) {
  const out = {};
  if (!isObj(raw)) return out;
  const p = (state && state.person) || {};
  const age = toNum(state && state.age) ?? 30;
  const year = toNum(state && state.year) ?? 2025;

  // education
  const edRaw = typeof raw.education === 'string' ? { level: raw.education } : raw.education;
  if (isObj(edRaw)) {
    const ed = {};
    if (EDU_LEVELS.includes(edRaw.level)) {
      const cur = EDU_LEVELS.indexOf((p.education && p.education.level) || 'none');
      const nxt = EDU_LEVELS.indexOf(edRaw.level);
      if (cur < 0 || (nxt >= cur && nxt - cur <= 2)) ed.level = edRaw.level;
    }
    const inSchool = bool(edRaw.inSchool);
    if (inSchool !== null) ed.inSchool = inSchool;
    const field = cleanText(edRaw.field, 16);
    if (field) ed.field = field;
    if (Object.keys(ed).length) out.education = ed;
  }

  // career
  const crRaw = typeof raw.career === 'string' ? { status: raw.career } : raw.career;
  if (isObj(crRaw)) {
    const cr = {};
    const st = crRaw.status;
    if (CAREER_STATUS.includes(st)) {
      const ok = (st === 'child' && age < 15) || (st === 'retired' && age >= 35) || (st === 'military' && age >= 16)
        || (['employed', 'self_employed', 'unemployed', 'homemaker'].includes(st) && age >= 12)
        || st === 'student' || st === 'unable';
      if (ok) cr.status = st;
    }
    const title = cleanText(crRaw.title, 16);
    if (title) cr.title = title;
    const sector = cleanText(crRaw.sector, 12);
    if (sector) cr.sector = sector;
    const employer = cleanText(crRaw.employer, 20);
    if (employer) cr.employer = employer;
    let ip = toNum(crRaw.incomePct);
    if (ip != null) {
      if (ip > 1 && ip <= 100) ip /= 100;
      if (ip >= 0 && ip <= 1) {
        const cur = toNum(p.career && p.career.incomePct);
        if (cur != null) ip = clampNum(ip, cur - LIMITS.incomePctStep, cur + LIMITS.incomePctStep);
        cr.incomePct = Math.round(clampNum(ip, 0.01, 0.995) * 1000) / 1000;
      }
    }
    if (Object.keys(cr).length) out.career = cr;
  }

  // relationship
  const rlRaw = typeof raw.relationship === 'string' ? { status: raw.relationship } : raw.relationship;
  if (isObj(rlRaw) && RELATIONSHIP_STATUS.includes(rlRaw.status)) {
    const st = rlRaw.status;
    const cur = (p.relationship && p.relationship.status) || 'single';
    let ok = true;
    if (st === 'married' || st === 'partnered') ok = age >= legalMarriageAge(state, data);
    if (st === 'dating') ok = age >= 14;
    if (st === 'divorced') ok = cur === 'married' || cur === 'partnered';
    // a partner's death comes from the engine's life tables (CONTRACT §5: the model never kills relatives)
    if (st === 'widowed') ok = false;
    if (ok && st !== cur) {
      const rl = { status: st };
      if (st === 'married' || st === 'partnered' || st === 'dating') {
        const pr = isObj(rlRaw.partner) ? rlRaw.partner : typeof rlRaw.partner === 'string' ? { name: rlRaw.partner } : null;
        const name = pr ? cleanText(pr.name, 12) : '';
        const existing = p.relationship && p.relationship.partner;
        if (name) rl.partner = { name, sinceYear: Math.round(year) };
        else if (existing && (cur === 'dating' || cur === 'partnered' || cur === 'married')) rl.partner = existing;
        else if (st === 'married' || st === 'partnered') rl.partner = { name: '伴侣', sinceYear: Math.round(year) };
      } else {
        rl.partner = null;
      }
      out.relationship = rl;
    }
  }

  // country (only when the outcome actually happened)
  if (feasible && typeof raw.country === 'string') {
    const iso = raw.country.trim().toUpperCase();
    if (hasIso(data, iso) && iso !== p.country) out.country = iso;
  }

  const urban = bool(raw.urban);
  if (urban !== null && urban !== p.urban) out.urban = urban;

  const flags = validateFlags(raw.flags, { year });
  if (flags) out.flags = flags;

  if (isObj(raw.addCondition)) {
    const c = raw.addCondition;
    const name = cleanText(c.name, 12);
    if (name) {
      const id = safeKey(c.id) || 'c_' + hashString(name).toString(36);
      out.addCondition = { id, name, sinceYear: Math.round(year), severity: clampInt(c.severity, 1, 3, 1) };
    }
  }
  if (raw.removeCondition != null) {
    const rid = typeof raw.removeCondition === 'string' ? raw.removeCondition : isObj(raw.removeCondition) ? raw.removeCondition.id : null;
    const conds = Array.isArray(p.conditions) ? p.conditions : [];
    if (typeof rid === 'string' && conds.some((c) => c && c.id === rid)) out.removeCondition = rid;
  }
  return out;
}

function threadTrigger(t, state) {
  const year = toNum(state && state.year) ?? 2025;
  const age = toNum(state && state.age);
  const tr = isObj(t.trigger) ? t.trigger : {};
  let ahead = toNum(tr.afterYears ?? t.afterYears);
  if (ahead == null) {
    const y = toNum(tr.year ?? t.year);
    if (y != null) ahead = y - year;
  }
  if (ahead == null && age != null) {
    const a = toNum(tr.age ?? t.age);
    if (a != null) ahead = a - age;
  }
  if (ahead == null) ahead = 3;
  ahead = Math.round(clampNum(ahead, 1, LIMITS.threadYearsMax));
  return { year: Math.round(year + ahead) };
}

/** Thread[] (max 3; max 1 when the life already has 10+ pending threads). */
export function validateThreads(arr, state, data) {
  if (!Array.isArray(arr)) return [];
  const pending = Array.isArray(state && state.threads) ? state.threads.length : 0;
  const max = pending >= 10 ? 1 : LIMITS.threadsPerResolution;
  const cap = wealthCap(state, data);
  const out = [];
  const year = toNum(state && state.year) ?? 2025;
  arr.slice(0, 6).forEach((t, i) => {
    if (out.length >= max || !isObj(t)) return;
    const title = cleanText(t.title, LIMITS.threadTitle);
    const text = cleanText(t.text ?? t.summary ?? t.description, LIMITS.threadText);
    if (!title || len(text) < 4) return;
    const th = {
      id: `t-${Math.round(year)}-${hashString(title + '|' + i + '|' + year + '|' + text).toString(36)}`,
      title, text,
      trigger: threadTrigger(t, state),
      conditions: { alive: true },
      effects: validateEffects(t.effects, cap),
      source: 'ai',
    };
    if (isObj(t.conditions) && typeof t.conditions.country === 'string') {
      const iso = t.conditions.country.trim().toUpperCase();
      if (hasIso(data, iso)) th.conditions.country = iso;
    }
    const set = validateSet(t.set, state, data, { feasible: true });
    if (Object.keys(set).length) th.set = set;
    if (isObj(t.decision)) {
      const dTitle = cleanText(t.decision.title, LIMITS.title);
      const dSit = cleanText(t.decision.situation, LIMITS.situation);
      const opts = validateOptions(t.decision.options);
      if (dTitle && len(dSit) >= 6 && opts) th.decision = { title: dTitle, situation: dSit, options: opts };
    }
    out.push(th);
  });
  return out;
}

/**
 * validateResolution(raw, state, data?) -> Resolution|null
 * raw: {narrative, effects, set, threads, hazard, feasible, note}. Null when the narrative is missing.
 */
export function validateResolution(raw, state, data = null) {
  if (!isObj(raw)) return null;
  const narrative = cleanText(raw.narrative ?? raw.text ?? raw.story, LIMITS.narrative, { multiline: true });
  if (len(narrative) < 8) return null;
  const feasible = !(raw.feasible === false || raw.feasible === 'false');
  const out = {
    narrative,
    effects: validateEffects(raw.effects, wealthCap(state, data)),
    set: validateSet(raw.set, state, data, { feasible }),
    threads: validateThreads(raw.threads, state, data),
    feasible,
  };
  const hazard = validateHazard(raw.hazard);
  if (hazard) out.hazard = hazard;
  const note = cleanText(raw.note, LIMITS.note);
  if (note) out.note = note;
  return out;
}

/* ------------------------------------------------------------------ custom birth */

function validDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1)) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * validateBirthParse(raw, data) -> partial BirthSpec | null (null when no field is usable).
 * Out-of-range birth years are moved to the nearest playable year with an explanatory note.
 */
export function validateBirthParse(raw, data) {
  if (!isObj(raw)) return null;
  const out = {};
  const notes = [];

  let year = toNum(raw.year);
  let m = null, d = null;
  if (typeof raw.date === 'string') {
    const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.date.trim());
    if (dm) {
      const [yy, mm, dd] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
      if (validDate(yy, mm, dd)) { m = mm; d = dd; if (year == null) year = yy; }
    }
  }
  if (year != null) {
    year = Math.round(year);
    if (year >= 1900 && year <= 2200) {
      if (year < FIRST_YEAR) { notes.push(`出生年份已调整为 ${FIRST_YEAR} 年（本游戏从 ${FIRST_YEAR} 年开始）`); year = FIRST_YEAR; }
      if (year > BIRTH_YEAR_MAX) { notes.push(`出生年份已调整为 ${BIRTH_YEAR_MAX} 年（最晚可出生年份）`); year = BIRTH_YEAR_MAX; }
      out.year = year;
    }
  }
  if (out.year != null && m != null) {
    if (!validDate(out.year, m, d)) d = 28;
    out.date = `${out.year}-${pad2(m)}-${pad2(d)}`;
  }
  if (typeof raw.time === 'string') {
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.time.trim());
    if (tm && +tm[1] < 24 && +tm[2] < 60 && (tm[3] == null || +tm[3] < 60)) out.time = `${pad2(+tm[1])}:${tm[2]}:${tm[3] || '00'}`;
  }

  const iso = resolveIso(data, raw.country);
  if (iso) out.country = iso;

  const sx = typeof raw.sex === 'string' ? raw.sex.trim().toLowerCase() : '';
  if (['male', 'm', '男', 'boy'].includes(sx)) out.sex = 'male';
  else if (['female', 'f', '女', 'girl'].includes(sx)) out.sex = 'female';

  let urban = bool(raw.urban);
  if (urban === null && typeof raw.urban === 'string') urban = /城|urban|city/i.test(raw.urban) ? true : /乡|村|rural/i.test(raw.urban) ? false : null;
  if (urban !== null) out.urban = urban;

  let fp = toNum(raw.familyPct);
  if (fp != null) {
    if (fp > 1 && fp <= 100) fp /= 100;
    if (fp >= 0 && fp <= 1) out.familyPct = Math.round(clampNum(fp, 0.01, 0.99) * 100) / 100;
  }

  if (PARENT_EDU.includes(raw.parentsEdu)) out.parentsEdu = raw.parentsEdu;
  if (toNum(raw.siblings) != null && toNum(raw.siblings) >= 0) out.siblings = clampInt(raw.siblings, 0, 12, 0);
  const ma = toNum(raw.motherAge);
  if (ma != null && ma >= 12 && ma <= 60) out.motherAge = Math.round(clampNum(ma, 15, 50));
  const fa = toNum(raw.fatherAge);
  if (fa != null && fa >= 12 && fa <= 90) out.fatherAge = Math.round(clampNum(fa, 15, 75));

  const name = cleanText(raw.name, 16);
  if (name) out.name = name;
  if (typeof raw.nameLatin === 'string') {
    const nl = raw.nameLatin.replace(/[^A-Za-z .'\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (nl) out.nameLatin = nl;
  }

  if (Array.isArray(raw.notes)) {
    for (const n of raw.notes.slice(0, 6)) {
      const t = cleanText(n, 40);
      if (t && notes.length < 5 && !notes.includes(t)) notes.push(t);
    }
  }
  const fields = Object.keys(out).length;
  if (!fields && !notes.length) return null;
  if (notes.length) out.notes = notes;
  return out;
}

/* ------------------------------------------------------------------ biography and birth story */

/** validateBiography(raw) -> {title, bio, epitaph, highlights[]} | null (null without a usable bio). Missing title/epitaph are ''. */
export function validateBiography(raw) {
  if (!isObj(raw)) return null;
  const bio = cleanText(raw.bio ?? raw.biography ?? raw.text, LIMITS.bio, { multiline: true });
  if (len(bio) < 20) return null;
  const highlights = [];
  if (Array.isArray(raw.highlights)) {
    for (const h of raw.highlights.slice(0, 12)) {
      const t = cleanText(h, LIMITS.highlight);
      if (t && !highlights.includes(t)) highlights.push(t);
      if (highlights.length >= LIMITS.highlights) break;
    }
  }
  return {
    title: cleanText(raw.title, LIMITS.bioTitle),
    bio,
    epitaph: cleanText(raw.epitaph, LIMITS.epitaph),
    highlights,
  };
}

/** validateBirthStory(raw) -> {story, tagline} | null */
export function validateBirthStory(raw) {
  const src = typeof raw === 'string' ? { story: raw } : raw;
  if (!isObj(src)) return null;
  const story = cleanText(src.story ?? src.text, LIMITS.story, { multiline: true });
  if (len(story) < 20) return null;
  return { story, tagline: cleanText(src.tagline, LIMITS.tagline) };
}
