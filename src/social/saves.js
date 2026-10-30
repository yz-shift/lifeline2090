// Local persistence: the in-progress life (autosaved every in-game year) and the last PAST_LIVES_MAX finished lives.
// Everything goes through `storage` from dom.js (never throws). Imported files are untrusted: every record is
// validated and capped before it is stored. No DOM use here, so this module runs under Node tests.

import { storage } from '../ui/dom.js';
import { STORAGE_KEYS, PAST_LIVES_MAX, YEAR_TAGS, STATS, MAX_AGE } from '../core/constants.js';
import { hashString } from '../core/rng.js';
import { readCollection, mergeCollection } from './collection.js';

export const EXPORT_FORMAT = 'lifeline2090';
export const EXPORT_VERSION = 1;

/** Character budgets (localStorage is ~5M UTF-16 chars per origin in most browsers). */
export const SAVE_LIMITS = {
  current: 1_500_000,      // in-progress life
  pastRecord: 200_000,     // one finished life including its trimmed state
  pastTotal: 2_200_000,    // all finished lives together
  importItems: 200,        // records looked at per import
};

const TAG_SET = new Set(YEAR_TAGS);
const LOG_KINDS = new Set(['birth', 'event', 'news', 'milestone', 'decision', 'choice', 'thread', 'death', 'system']);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,80}$/;

// ---------------------------------------------------------------------------------------------------------------
// helpers

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const jsonLen = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };

function str(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function int(v, lo, hi, dflt) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function isoDate(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function stats(v) {
  const src = isObj(v) ? v : {};
  const out = {};
  for (const k of STATS) out[k] = int(src[k], 0, 100, 50);
  return out;
}

const newestFirst = (a, b) => (b.savedAt || '').localeCompare(a.savedAt || '');

function trimMarker(state, removed) {
  const first = state.log.find((e) => isObj(e)) || {};
  return {
    year: typeof first.year === 'number' ? first.year : state.birth?.year ?? state.year,
    age: 0,
    kind: 'system',
    text: `为节省存储空间，较早的 ${removed} 条生平记录已被精简（逐年概况仍完整保留）。`,
    tone: 0,
    tags: ['trimmed'],
    source: 'engine',
  };
}

/**
 * Return a copy of `state` whose JSON fits in `maxChars` by dropping the oldest log entries (the birth entry and every
 * history row are always kept). If the log alone is not enough, peer timelines are shortened too.
 * @returns {{ state: object, chars: number, trimmed: number }}
 */
export function fitState(state, maxChars = SAVE_LIMITS.current) {
  const full = jsonLen(state);
  if (full <= maxChars || !Array.isArray(state.log)) return { state, chars: full, trimmed: 0 };

  const log = state.log;
  const keepHead = log.length && isObj(log[0]) && log[0].kind === 'birth' ? 1 : 0;
  const base = jsonLen({ ...state, log: [] }) + 400; // + room for the marker entry
  const sizes = log.map((e) => jsonLen(e) + 1);
  const headSize = keepHead ? sizes[0] : 0;
  let budget = maxChars - base - headSize;
  let start = log.length;
  while (start > keepHead && budget - sizes[start - 1] >= 0) {
    budget -= sizes[start - 1];
    start -= 1;
  }
  const removed = start - keepHead;
  let out = state;
  if (removed > 0) {
    const kept = log.slice(start);
    out = { ...state, log: [...log.slice(0, keepHead), trimMarker(state, removed), ...kept] };
  }
  let chars = jsonLen(out);
  if (chars > maxChars && Array.isArray(out.cohort)) {
    out = {
      ...out,
      cohort: out.cohort.map((p) => (isObj(p) && Array.isArray(p.timeline) ? { ...p, timeline: p.timeline.slice(-6) } : p)),
    };
    chars = jsonLen(out);
  }
  return { state: out, chars, trimmed: removed };
}

// ---------------------------------------------------------------------------------------------------------------
// current life

/** Save the in-progress life. Trims the oldest log entries above ~1.5 MB. Returns true when stored. */
export function autosave(state) {
  if (!isObj(state)) return false;
  const fitted = fitState(state, SAVE_LIMITS.current).state;
  if (storage.set(STORAGE_KEYS.current, fitted)) return true;
  // storage is full: try a much smaller copy, then make room by shrinking the stored finished lives
  const small = fitState(state, 300_000).state;
  if (storage.set(STORAGE_KEYS.current, small)) return true;
  shrinkPast(60_000);
  return storage.set(STORAGE_KEYS.current, small);
}

function looksLikeLife(s) {
  return isObj(s) && typeof s.id === 'string' && isObj(s.birth) && isObj(s.person) && Array.isArray(s.history) && Array.isArray(s.log);
}

/** The autosaved in-progress life, or null. */
export function loadCurrent() {
  const s = storage.get(STORAGE_KEYS.current, null);
  return looksLikeLife(s) ? s : null;
}

export function clearCurrent() {
  storage.remove(STORAGE_KEYS.current);
}

// ---------------------------------------------------------------------------------------------------------------
// finished lives

function hydrate(rec) {
  if (!isObj(rec.state) || Array.isArray(rec.state.history)) return rec;
  return { ...rec, state: { ...rec.state, history: rec.history } };
}

function dehydrate(rec) {
  if (!isObj(rec.state) || !('history' in rec.state)) return rec;
  const { history, ...rest } = rec.state; // history is already stored on the record itself
  return { ...rec, state: rest };
}

function readPastRaw() {
  const list = storage.get(STORAGE_KEYS.past, []);
  if (!Array.isArray(list)) return [];
  return list.filter((r) => isObj(r) && typeof r.id === 'string' && typeof r.birthYear === 'number');
}

/** Write the list (newest first, capped); on quota errors shrink states, then drop the oldest records. */
function writePast(list) {
  let recs = list.slice().sort(newestFirst).slice(0, PAST_LIVES_MAX).map(dehydrate);
  let total = jsonLen(recs);
  if (total > SAVE_LIMITS.pastTotal) {
    const per = Math.floor(SAVE_LIMITS.pastTotal / Math.max(1, recs.length));
    recs = recs.map((r) => shrinkRecord(r, per));
    total = jsonLen(recs);
  }
  if (storage.set(STORAGE_KEYS.past, recs)) return true;
  recs = recs.map((r) => shrinkRecord(r, 60_000));
  while (recs.length) {
    if (storage.set(STORAGE_KEYS.past, recs)) return true;
    recs = recs.slice(0, -1); // drop the oldest
  }
  storage.remove(STORAGE_KEYS.past);
  return false;
}

function shrinkRecord(rec, maxChars) {
  if (jsonLen(rec) <= maxChars || !isObj(rec.state)) return rec;
  const room = Math.max(10_000, maxChars - jsonLen({ ...rec, state: null }));
  const fitted = fitState(rec.state, room);
  return fitted.chars <= room ? { ...rec, state: fitted.state } : { ...rec, state: null };
}

function shrinkPast(perRecord) {
  const list = readPastRaw();
  if (!list.length) return;
  storage.set(STORAGE_KEYS.past, list.map((r) => shrinkRecord(r, perRecord)));
}

function deriveHighlights(state) {
  const out = [];
  for (const d of Array.isArray(state.decisions) ? state.decisions : []) {
    if (!isObj(d)) continue;
    const title = str(d.title, 24);
    const choice = str(d.choice, 30);
    if (!title || !choice) continue;
    out.push(`${typeof d.age === 'number' ? d.age + ' 岁，' : ''}${title}：${choice}`.slice(0, 60));
  }
  if (out.length <= 6) return out;
  const step = out.length / 6;
  return Array.from({ length: 6 }, (_, i) => out[Math.floor(i * step)]);
}

function makeRecord(state, extras = {}) {
  const bioObj = isObj(extras.biography) ? extras.biography : {};
  const birth = isObj(state.birth) ? state.birth : {};
  const person = isObj(state.person) ? state.person : {};
  const dead = isObj(state.dead) ? state.dead : null;
  const country = birth.country || person.country || '';
  let countryName = typeof extras.countryName === 'string' ? extras.countryName : '';
  if (!countryName && extras.data && typeof extras.data.country === 'function') {
    try { countryName = extras.data.country(country)?.name || ''; } catch { countryName = ''; }
  }
  const highlights = Array.isArray(extras.highlights) ? extras.highlights
    : Array.isArray(bioObj.highlights) ? bioObj.highlights : deriveHighlights(state);
  const id = typeof state.id === 'string' && ID_RE.test(state.id) ? state.id
    : 'life-' + hashString(JSON.stringify([birth, person.name, state.seed ?? null, state.createdAt ?? null])).toString(36);
  const { pending, ...stateCopy } = state; // an unresolved decision is meaningless in an archive

  const rec = {
    v: 1,
    id,
    savedAt: isoDate(extras.savedAt) || new Date().toISOString(),
    name: person.name || birth.name || '',
    sex: person.sex || birth.sex || '',
    mode: state.mode || birth.mode || 'random',
    country,
    countryName: countryName || country,
    place: dead?.place || person.country || country,
    birthYear: birth.year,
    deathYear: dead?.year ?? state.year,
    age: dead?.age ?? state.age,
    alive: !dead,
    cause: dead?.cause?.name || '',
    causeDetail: dead?.cause?.detail || '',
    deathSummary: dead?.summary || '',
    lifeExpAtBirth: typeof dead?.lifeExpAtBirth === 'number' ? dead.lifeExpAtBirth : null,
    percentile: typeof dead?.percentile === 'number' ? dead.percentile : null,
    epitaph: extras.epitaph || bioObj.epitaph || '',
    title: extras.title || bioObj.title || '',
    bio: extras.bio || bioObj.bio || bioObj.text || dead?.summary || '',
    highlights: highlights.filter((x) => typeof x === 'string').slice(0, 12),
    history: Array.isArray(state.history) ? state.history : [],
    decisions: Array.isArray(state.decisions) ? state.decisions : [],
    stats: dead?.stats || state.stats || {},
    worldLabel: state.worldLabel || '',
    sharedId: typeof extras.sharedId === 'string' ? extras.sharedId : null,
    state: stateCopy,
  };
  return shrinkRecord(dehydrate(rec), SAVE_LIMITS.pastRecord);
}

/** Finished lives, newest first (max PAST_LIVES_MAX). Each record's `state` carries its history again. */
export function pastLives() {
  return readPastRaw().sort(newestFirst).slice(0, PAST_LIVES_MAX).map(hydrate);
}

/** One finished life by id, or null. */
export function getPastLife(id) {
  return pastLives().find((r) => r.id === id) || null;
}

/**
 * Archive a finished (or abandoned) life. `extras`: { epitaph, title, bio, highlights, biography, countryName, data,
 * savedAt, sharedId }. Re-saving the same life id replaces the earlier record. Also accepts an already built record.
 * @returns the stored record (hydrated) or null
 */
export function addPastLife(state, extras = {}) {
  if (!isObj(state)) return null;
  const rec = isObj(state.person) ? makeRecord(state, extras) : sanitizeRecord(state);
  if (!rec) return null;
  const list = readPastRaw().filter((r) => r.id !== rec.id);
  list.push(rec);
  writePast(list);
  const stored = readPastRaw().find((r) => r.id === rec.id);
  return stored ? hydrate(stored) : null;
}

/** Merge a few fields into a stored record (e.g. { sharedId } after sharing). Returns the updated record or null. */
export function updatePastLife(id, patch) {
  if (!isObj(patch)) return null;
  const list = readPastRaw();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const allowed = ['sharedId', 'epitaph', 'title', 'bio', 'highlights'];
  const next = { ...list[i] };
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  list[i] = next;
  writePast(list);
  return hydrate(next);
}

export function deletePastLife(id) {
  const list = readPastRaw();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) return false;
  if (!next.length) { storage.remove(STORAGE_KEYS.past); return true; }
  return writePast(next);
}

// ---------------------------------------------------------------------------------------------------------------
// export / import

/** JSON backup of the finished lives: { format:'lifeline2090', v:1, exportedAt, lives:[...] }. */
export function exportLives() {
  return JSON.stringify({
    format: EXPORT_FORMAT,
    v: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    lives: readPastRaw().sort(newestFirst).slice(0, PAST_LIVES_MAX),
    collection: readCollection(),
  });
}

function sanitizeHistoryRow(r) {
  if (!isObj(r)) return null;
  const year = int(r.year, 1900, 2300, null);
  if (year == null) return null;
  return {
    year,
    age: int(r.age, 0, MAX_AGE + 10, 0),
    stats: stats(r.stats),
    tag: TAG_SET.has(r.tag) ? r.tag : 'calm',
    mood: int(r.mood, -2, 2, 0),
    country: typeof r.country === 'string' && /^[A-Z]{3}$/.test(r.country) ? r.country : '',
    headline: str(r.headline, 120),
  };
}

function sanitizeDecision(d) {
  if (!isObj(d)) return null;
  const title = str(d.title, 120);
  if (!title) return null;
  return {
    id: str(String(d.id ?? ''), 80),
    year: int(d.year, 1900, 2300, null),
    age: int(d.age, 0, MAX_AGE + 10, null),
    title,
    choice: str(d.choice, 600),
    custom: d.custom === true,
    source: d.source === 'ai' ? 'ai' : 'local',
  };
}

function sanitizeLogEntry(e) {
  if (!isObj(e)) return null;
  const text = str(e.text, 1200);
  if (!text) return null;
  const out = {
    year: int(e.year, 1900, 2300, null),
    age: int(e.age, 0, MAX_AGE + 10, null),
    kind: LOG_KINDS.has(e.kind) ? e.kind : 'event',
    text,
    tone: int(e.tone, -2, 2, 0),
    tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string').slice(0, 12).map((t) => t.slice(0, 40)) : [],
    source: ['engine', 'ai', 'history', 'future'].includes(e.source) ? e.source : 'engine',
  };
  if (isObj(e.effects)) {
    out.effects = {};
    for (const k of STATS) if (typeof e.effects[k] === 'number' && Number.isFinite(e.effects[k])) out.effects[k] = e.effects[k];
  }
  return out;
}

function sanitizeState(s, history) {
  if (!isObj(s)) return null;
  const copy = { ...s };
  copy.log = Array.isArray(s.log) ? s.log.slice(0, 5000).map(sanitizeLogEntry).filter(Boolean) : [];
  copy.decisions = Array.isArray(s.decisions) ? s.decisions.slice(0, 400).map(sanitizeDecision).filter(Boolean) : [];
  delete copy.history; // re-attached from the record on read
  delete copy.pending;
  if (jsonLen(copy) > SAVE_LIMITS.pastRecord * 3) return null;
  const fitted = fitState({ ...copy, history }, SAVE_LIMITS.pastRecord);
  const { history: _h, ...rest } = fitted.state;
  return rest;
}

/** Validate one imported record. Returns a clean stored-shape record or null. */
export function sanitizeRecord(raw) {
  if (!isObj(raw)) return null;
  const birthYear = int(raw.birthYear, 1900, 2100, null);
  if (birthYear == null) return null;
  const age = int(raw.age, 0, MAX_AGE + 10, 0);
  const history = Array.isArray(raw.history) ? raw.history.slice(0, MAX_AGE + 20).map(sanitizeHistoryRow).filter(Boolean) : [];
  const savedAt = isoDate(raw.savedAt) || new Date().toISOString();
  const name = str(raw.name, 60);
  let id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
  if (!id) id = 'life-' + hashString(JSON.stringify([name, birthYear, age, raw.country ?? '', raw.savedAt ?? ''])).toString(36);
  const highlights = Array.isArray(raw.highlights) ? raw.highlights.map((x) => str(x, 200)).filter(Boolean).slice(0, 12) : [];
  const decisions = Array.isArray(raw.decisions) ? raw.decisions.slice(0, 400).map(sanitizeDecision).filter(Boolean) : [];
  const country = typeof raw.country === 'string' && /^[A-Z]{3}$/.test(raw.country) ? raw.country : '';
  const rec = {
    v: 1,
    id,
    savedAt,
    name,
    sex: raw.sex === 'male' || raw.sex === 'female' ? raw.sex : '',
    mode: raw.mode === 'custom' ? 'custom' : 'random',
    country,
    countryName: str(raw.countryName, 40) || country,
    place: typeof raw.place === 'string' && /^[A-Z]{3}$/.test(raw.place) ? raw.place : country,
    birthYear,
    deathYear: int(raw.deathYear, birthYear, birthYear + MAX_AGE + 10, birthYear + age),
    age,
    alive: raw.alive === true,
    cause: str(raw.cause, 60),
    causeDetail: str(raw.causeDetail, 200),
    deathSummary: str(raw.deathSummary, 1200),
    lifeExpAtBirth: typeof raw.lifeExpAtBirth === 'number' && Number.isFinite(raw.lifeExpAtBirth) ? raw.lifeExpAtBirth : null,
    percentile: typeof raw.percentile === 'number' && Number.isFinite(raw.percentile) ? raw.percentile : null,
    epitaph: str(raw.epitaph, 60),
    title: str(raw.title, 60),
    bio: str(raw.bio, 4000),
    highlights,
    history,
    decisions,
    stats: stats(raw.stats),
    worldLabel: str(raw.worldLabel, 80),
    sharedId: typeof raw.sharedId === 'string' && ID_RE.test(raw.sharedId) ? raw.sharedId : null,
    state: sanitizeState(raw.state, history),
  };
  return rec;
}

/**
 * Import a backup (exportLives() output, a bare array of records, or one record).
 * Invalid records and ids already present are skipped; at most PAST_LIVES_MAX newest lives are kept.
 * @returns {{ added: number, skipped: number, cards?: number, error?: string }}  cards = new achievement cards merged from the backup
 */
export function importLives(json) {
  let parsed;
  try {
    parsed = typeof json === 'string' ? JSON.parse(json.replace(/^﻿/, '').trim()) : json;
  } catch {
    return { added: 0, skipped: 0, error: '内容不是有效的 JSON，请检查是否完整复制了导出的文件。' };
  }
  let items = null;
  if (Array.isArray(parsed)) items = parsed;
  else if (isObj(parsed) && Array.isArray(parsed.lives)) items = parsed.lives;
  else if (isObj(parsed) && typeof parsed.birthYear === 'number') items = [parsed];
  if (!items) return { added: 0, skipped: 0, error: '没有找到可导入的人生记录。' };
  if (isObj(parsed) && parsed.format && parsed.format !== EXPORT_FORMAT) {
    return { added: 0, skipped: items.length, error: '这不是《人生长河》导出的存档文件。' };
  }
  const cards = isObj(parsed) && parsed.format === EXPORT_FORMAT && isObj(parsed.collection) ? mergeCollection(parsed.collection) : 0;

  const existing = readPastRaw();
  const seen = new Set(existing.map((r) => r.id));
  const fresh = [];
  let skipped = Math.max(0, items.length - SAVE_LIMITS.importItems);
  for (const raw of items.slice(0, SAVE_LIMITS.importItems)) {
    const rec = sanitizeRecord(raw);
    if (!rec || seen.has(rec.id)) { skipped += 1; continue; }
    seen.add(rec.id);
    fresh.push(rec);
  }
  const withCards = (r) => (cards ? { ...r, cards } : r);
  if (!fresh.length) return withCards({ added: 0, skipped });
  writePast([...existing, ...fresh]);
  const storedIds = new Set(readPastRaw().map((r) => r.id));
  const added = fresh.filter((r) => storedIds.has(r.id)).length;
  return withCards({ added, skipped: skipped + (fresh.length - added) });
}
