// Social layer: shared lives, candles, messages and feedback.
// Shared mode uses the artifact `db` capability (one store per artifact, shared by its viewers). When the page runs
// without it (local file, capability absent or declined) everything falls back to the viewer's own localStorage so the
// social screens still work offline. Every row read from the shared store is untrusted: it is re-validated here
// (types, lengths, enums) before any screen sees it, and screens only ever insert it with textContent.
//
// Read helpers never throw and always return usable values (arrays / numbers / null).
// Write helpers never throw and resolve { ok: true, ... } or { ok: false, error, message } where `error` is one of
// 'readonly' | 'quota' | 'busy' | 'network' | 'degraded' | 'invalid' | 'empty' | 'notfound' and `message` is
// player-facing Chinese text.

import { storage, bus } from '../ui/dom.js';
import { REGIONS, YEAR_TAGS, STATS, FIRST_YEAR, MAX_AGE } from '../core/constants.js';

// ---------------------------------------------------------------------------------------------------------------
// constants

export const SHARE_VERSION = 1;
export const SHARE_LIMITS = {
  name: 40, countryName: 30, cause: 40, highlights: 6, highlight: 60, epitaph: 30, bio: 1200, worldLabel: 60,
  lifemap: 130, message: 200, feedback: 1000, page: 40,
};
const FEED_WINDOW = 300;          // newest shared lives kept live in the feed subscription
const LOCAL_LIVES_MAX = 60;
const LOCAL_MSGS_MAX = 100;
const LOCAL_FEEDBACK_MAX = 50;
const MESSAGE_COOLDOWN_MS = 8000;
const FEEDBACK_COOLDOWN_MS = 20000; // the shared store holds at most 25,000 documents for everyone: no feedback floods
const LAST_BIRTH_YEAR = 2070;

const KEYS = {
  lives: 'll2090.social.lives',
  candles: 'll2090.social.candles',
  messages: 'll2090.social.messages',
  feedback: 'll2090.social.feedback',
  anon: 'll2090.social.anon',
};

/** Birth-era filter buckets used by the shared feed and memorial. */
import { loadSeed, SEED_PHOTO_RE } from './seed.js';

export const ERAS = [
  { id: 'real', label: '真实人生（真实人物）', from: 1800, to: 1999, real: true },
  { id: '2000s', label: '2000–2009 年出生', from: 2000, to: 2009 },
  { id: '2010s', label: '2010–2019 年出生', from: 2010, to: 2019 },
  { id: '2020s', label: '2020–2029 年出生', from: 2020, to: 2029 },
  { id: '2030s', label: '2030–2039 年出生', from: 2030, to: 2039 },
  { id: '2040s', label: '2040–2049 年出生', from: 2040, to: 2049 },
  { id: '2050s', label: '2050–2059 年出生', from: 2050, to: 2059 },
  { id: '2060s', label: '2060–2070 年出生', from: 2060, to: 2070 },
];

export const SOCIAL_MESSAGES = {
  readonly: '你目前只能浏览，不能在这里写入内容。',
  quota: '共享空间已满，暂时无法添加新内容。请稍后再试，或请页面所有者清理旧记录。',
  busy: '操作有些频繁，请稍等片刻再试。',
  network: '网络暂时不可用，请稍后再试。',
  degraded: '共享功能当前不可用，页面显示的是最近加载的内容。',
  invalid: '内容格式不正确，未能保存。',
  empty: '请先写下想说的话。',
  notfound: '没有找到这段人生，它可能已被移除。',
};

// one character per life-map year tag (mnemonic, stable even if YEAR_TAGS is reordered)
const TAG_CHARS = {
  birth: 'b', childhood: 'c', study: 's', work: 'w', love: 'l', family: 'f', loss: 'x', illness: 'i',
  crisis: 'k', war: 'z', migration: 'm', success: 'u', calm: 'q', retire: 'r', death: 'd',
};
const CHAR_TAGS = Object.fromEntries(Object.entries(TAG_CHARS).map(([t, c]) => [c, t]));
const UNKNOWN_TAG_CHAR = '.';

// ---------------------------------------------------------------------------------------------------------------
// module state

const S = {
  mode: 'local',
  db: null,
  user: null,
  platformId: null,   // the viewer's id from the user capability (stored as authorId, never displayed)
  viewerId: null,     // platformId or a per-browser anonymous id (only used to keep one candle per viewer)
  canWrite: null,     // true | false | null (null = platform said nothing: keep controls, let a write decide)
  owner: false,
  readOnly: false,
  degraded: false,
  data: null,
  initPromise: null,
  ready: false,
  lastMessageAt: 0,
  lastFeedbackAt: 0,
};

// One write at a time per document (db.d.ts): a second identical request while the first one is still running (a
// double click, two screens) shares the first one's result instead of writing the same documents again.
const inflight = new Map();
function single(key, fn) {
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// small sanitizers (shared data is untrusted)

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;

/** one-line text: control chars removed, whitespace collapsed, trimmed, capped */
export function cleanLine(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(CTRL, '').replace(/\s+/g, ' ').trim();
  return capChars(s, max);
}

/** multi-line text: keeps single blank lines, removes control chars, capped */
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\r\n?/g, '\n').replace(CTRL, '').replace(/[ \t\f\v]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return capChars(s, max);
}

function capChars(s, max) {
  if (!max || s.length <= max) return s;
  // do not cut a surrogate pair in half
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function toInt(v, lo, hi, dflt) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

const ISO3_RE = /^[A-Z]{3}$/;
function cleanIso(v) { return typeof v === 'string' && ISO3_RE.test(v) ? v : ''; }

const SEG_RE = /^[A-Za-z0-9_\-.~:@+]{1,80}$/;
function cleanId(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v);
  return SEG_RE.test(s) && s !== '.' && s !== '..' ? s : '';
}

// A shared row dated in the future would stay pinned to the top of every newest-first list (the feed, messages);
// such dates are dropped (the row sorts last). Two days of slack tolerate viewers whose clocks run behind.
const FUTURE_SLACK_MS = 2 * 24 * 3600 * 1000;
function cleanIsoDate(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= Date.now() + FUTURE_SLACK_MS ? new Date(t).toISOString() : '';
}

function cleanStats(v) {
  const out = {};
  const src = v && typeof v === 'object' ? v : {};
  for (const k of STATS) out[k] = toInt(src[k], 0, 100, 50);
  return out;
}

function cleanSex(v) { return v === 'male' || v === 'female' ? v : ''; }

function cleanLifemapString(v) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v.slice(0, SHARE_LIMITS.lifemap)) out += CHAR_TAGS[ch] || ch === UNKNOWN_TAG_CHAR ? ch : UNKNOWN_TAG_CHAR;
  return out;
}

function randomId(prefix = '') {
  let r = '';
  try {
    const a = new Uint32Array(3);
    globalThis.crypto.getRandomValues(a);
    r = Array.from(a, (x) => x.toString(36)).join('');
  } catch {
    r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  return prefix + r.slice(0, 20);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------------------
// life-map encoding

/** history rows -> compact string, one char per lived year (dominant tag) */
export function encodeLifemap(history) {
  if (!Array.isArray(history)) return '';
  let out = '';
  for (const row of history.slice(0, SHARE_LIMITS.lifemap)) {
    const tag = row && typeof row === 'object' ? row.tag : row;
    out += TAG_CHARS[tag] || UNKNOWN_TAG_CHAR;
  }
  return out;
}

/** compact string -> array of YEAR_TAGS ids (null for unknown cells) */
export function decodeLifemap(str) {
  if (typeof str !== 'string') return [];
  return Array.from(str.slice(0, SHARE_LIMITS.lifemap), (ch) => CHAR_TAGS[ch] || null);
}

// ---------------------------------------------------------------------------------------------------------------
// init / status

async function useCap(name) {
  try {
    const c = globalThis.window ? globalThis.window.claude : undefined;
    if (!c || typeof c.use !== 'function') return null;
    const ns = await c.use(name);
    return ns || null;
  } catch {
    return null;
  }
}

async function safeCall(fn, dflt) {
  try { const v = await fn(); return v === undefined ? dflt : v; } catch { return dflt; }
}

function localViewerId() {
  let id = storage.get(KEYS.anon, null);
  if (!cleanId(id)) {
    id = randomId('anon-');
    storage.set(KEYS.anon, id);
  }
  return id;
}

/**
 * Detect the db/user capabilities once. Resolves { mode: 'shared' | 'local' }.
 * opts.data (optional DataStore) lets the store derive country names and regions.
 */
export function initSocial(opts = {}) {
  if (opts && opts.data) S.data = opts.data;
  if (!S.initPromise) S.initPromise = doInit();
  return S.initPromise;
}

async function doInit() {
  const [db, user] = await Promise.all([useCap('db'), useCap('user')]);
  S.user = user;
  if (!db) {
    // standalone website: bundled real lives stand in for the shared feed
    try { S.seedLives = (await loadSeed()).lives; } catch { S.seedLives = []; }
    S.mode = 'local';
    S.viewerId = localViewerId();
    S.owner = true;
    S.canWrite = true;
    S.ready = true;
    emitStatus();
    return { mode: 'local' };
  }
  S.db = db;
  S.mode = 'shared';
  if (user) {
    const [id, owner, can] = await Promise.all([
      safeCall(() => user.id(), null),
      safeCall(() => user.isOwner(), false),
      safeCall(() => user.can('data.write'), null),
    ]);
    S.platformId = cleanId(id) || null;
    S.owner = owner === true;
    S.canWrite = can === true ? true : can === false ? false : null;
  }
  S.viewerId = S.platformId || localViewerId();
  S.ready = true;
  emitStatus();
  return { mode: 'shared' };
}

/** Let the store resolve country names / regions (screens call this with app.data; idempotent). */
export function setDataSource(data) { if (data) S.data = data; }

function canWriteNow() {
  if (S.mode === 'local') return true;
  if (S.degraded || S.readOnly || !S.db) return false;
  return S.canWrite !== false;
}

/** Synchronous snapshot of the social status for rendering banners and gating controls. */
export function socialStatus() {
  return {
    mode: S.mode,
    ready: S.ready,
    canWrite: canWriteNow(),
    owner: S.mode === 'local' ? true : S.owner,
    readOnly: S.readOnly || (S.mode === 'shared' && S.canWrite === false),
    degraded: S.degraded,
  };
}

/** Whether this viewer may write shared data (user.can('data.write'); unknown -> true until a write is refused). */
export async function canWrite() {
  await initSocial();
  return canWriteNow();
}

/** Whether this viewer owns the artifact (local mode: the viewer owns their own device data). */
export async function isOwner() {
  await initSocial();
  return S.mode === 'local' ? true : S.owner;
}

/** Subscribe to status changes (mode, read-only, degraded). Returns an unsubscribe function. */
export function onSocialStatus(fn) { return bus.on('social:status', fn); }

function emitStatus() { bus.emit('social:status', socialStatus()); }

function setReadOnly() {
  if (!S.readOnly) { S.readOnly = true; emitStatus(); }
}

function degrade() {
  if (!S.degraded) {
    S.degraded = true;
    stopFeedListener();
    emitStatus();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// error handling

const STORE_CODES = new Set(['invalid_argument', 'resource_exhausted', 'quota_exceeded', 'unavailable', 'revoked',
  'not_granted', 'capability_disabled', 'capability_removed', 'transform_error']);

function codeOf(e) {
  if (e && typeof e === 'object' && typeof e.code === 'string') return STORE_CODES.has(e.code) ? e.code : 'unavailable';
  if (e instanceof TypeError) return 'bad_path';
  return 'unavailable';
}

function fail(error) {
  return { ok: false, error, message: SOCIAL_MESSAGES[error] || SOCIAL_MESSAGES.network };
}

/**
 * Run one store call with the DbError policy:
 * invalid_argument on a (well-formed) write -> read-only for the visit; quota_exceeded -> tell the viewer;
 * unavailable -> one retry after a short random delay; revoked / lifecycle codes -> degrade.
 */
async function run(op, { write = false, readOnlyOnInvalid = write, retry = true } = {}) {
  if (S.degraded) return fail('degraded');
  try {
    return { ok: true, value: await op() };
  } catch (e) {
    let code = codeOf(e);
    if (code === 'unavailable' && retry) {
      await delay(250 + Math.floor(Math.random() * 650));
      try {
        return { ok: true, value: await op() };
      } catch (e2) {
        code = codeOf(e2);
      }
    }
    return handleCode(code, { write, readOnlyOnInvalid });
  }
}

function handleCode(code, { write, readOnlyOnInvalid }) {
  switch (code) {
    case 'invalid_argument':
    case 'transform_error':
      if (write && readOnlyOnInvalid) { setReadOnly(); return fail('readonly'); }
      return fail('invalid');
    case 'bad_path':
      return fail('invalid');
    case 'quota_exceeded':
      return fail('quota');
    case 'resource_exhausted':
      return fail('busy');
    case 'revoked':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      degrade();
      return fail('degraded');
    default:
      return fail('network');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// record shaping

function regionOf(iso3) {
  try {
    const r = S.data && typeof S.data.country === 'function' ? S.data.country(iso3)?.region : null;
    return REGIONS[r] ? r : '';
  } catch {
    return '';
  }
}

function countryNameOf(iso3) {
  try {
    const c = S.data && typeof S.data.country === 'function' ? S.data.country(iso3) : null;
    return c && typeof c.name === 'string' ? c.name : '';
  } catch {
    return '';
  }
}

/** A readable country name: the given one unless it is empty or just the ISO3 code, then the data store's name. */
function displayCountryName(given, iso3) {
  const name = cleanLine(given, SHARE_LIMITS.countryName);
  if (name && name !== iso3) return name;
  return cleanLine(countryNameOf(iso3), SHARE_LIMITS.countryName) || name || iso3;
}

function deriveHighlights(src, st) {
  const decisions = Array.isArray(src.decisions) ? src.decisions : Array.isArray(st?.decisions) ? st.decisions : [];
  const out = [];
  for (const d of decisions) {
    if (!d || typeof d !== 'object') continue;
    const title = cleanLine(d.title, 24);
    // the player's own written words stay private: shared lives only say that a choice was self-written
    const choice = d.custom ? '（自己写下的选择）' : cleanLine(d.choice, 30);
    const age = toInt(d.age, 0, MAX_AGE + 5, null);
    if (!title || !choice) continue;
    out.push(cleanLine(`${age != null ? age + ' 岁，' : ''}${title}：${choice}`, SHARE_LIMITS.highlight));
  }
  // spread picks across the life rather than taking only the first ones
  if (out.length <= SHARE_LIMITS.highlights) return out;
  const step = out.length / SHARE_LIMITS.highlights;
  return Array.from({ length: SHARE_LIMITS.highlights }, (_, i) => out[Math.floor(i * step)]);
}

/**
 * Build a share record from a finished-life record (saves.addPastLife), a LifeState, or an already shaped record.
 * Returns null when the input lacks a usable birth year.
 */
export function buildShareRecord(src) {
  if (!src || typeof src !== 'object') return null;
  const isState = !!(src.birth && src.person);
  const st = isState ? src : src.state && typeof src.state === 'object' ? src.state : null;
  const birth = st?.birth || {};
  const person = st?.person || {};
  const dead = st?.dead || null;

  const birthYear = toInt(isState ? birth.year : src.birthYear ?? birth.year, FIRST_YEAR, LAST_BIRTH_YEAR, null);
  if (birthYear == null) return null;
  const ageRaw = isState ? dead?.age ?? st.age : src.age ?? dead?.age ?? st?.age;
  const age = toInt(ageRaw, 0, MAX_AGE + 5, 0);
  const deathYear = toInt(isState ? dead?.year ?? st.year : src.deathYear ?? dead?.year,
    birthYear, birthYear + MAX_AGE + 5, birthYear + age);
  const country = cleanIso(isState ? birth.country || person.country : src.country || birth.country || person.country);
  const history = isState ? st.history : Array.isArray(src.history) ? src.history : st?.history;
  const lifemap = !isState && typeof src.lifemap === 'string' ? cleanLifemapString(src.lifemap) : encodeLifemap(history);
  const causeRaw = isState ? dead?.cause : src.cause ?? dead?.cause;
  const cause = typeof causeRaw === 'string' ? causeRaw : causeRaw && typeof causeRaw === 'object' ? causeRaw.name : '';
  let highlights = Array.isArray(src.highlights) ? src.highlights : [];
  highlights = highlights.map((x) => cleanLine(x, SHARE_LIMITS.highlight)).filter(Boolean).slice(0, SHARE_LIMITS.highlights);
  if (!highlights.length) highlights = deriveHighlights(src, st);
  const modeRaw = src.mode === 'custom' || birth.mode === 'custom' || st?.mode === 'custom' ? 'custom' : 'random';

  return {
    v: SHARE_VERSION,
    lifeId: cleanId(isState ? st.id : src.lifeId || src.id || st?.id) || randomId('life-'),
    createdAt: nowIso(),
    authorId: null,
    name: cleanLine(isState ? person.name || birth.name : src.name || person.name || birth.name, SHARE_LIMITS.name) || '无名者',
    sex: cleanSex(isState ? person.sex || birth.sex : src.sex || person.sex || birth.sex),
    country,
    countryName: displayCountryName(!isState && src.countryName, country),
    region: REGIONS[src.region] ? src.region : regionOf(country),
    birthYear,
    deathYear,
    age,
    cause: cleanLine(cause, SHARE_LIMITS.cause),
    stats: cleanStats(isState ? dead?.stats || st.stats : src.stats || dead?.stats || st?.stats),
    lifemap,
    highlights,
    epitaph: cleanLine(src.epitaph, SHARE_LIMITS.epitaph),
    bio: cleanText(src.bio, SHARE_LIMITS.bio) || cleanText(dead?.summary, SHARE_LIMITS.bio),
    worldLabel: cleanLine(isState ? st.worldLabel : src.worldLabel || st?.worldLabel, SHARE_LIMITS.worldLabel),
    mode: modeRaw,
    candles: 0,
  };
}

/**
 * Validate one shared row. Returns a fresh plain object (never the frozen snapshot) or null when unusable.
 * authorId is replaced by `mine` (never exposed to screens).
 */
export function sanitizeLife(docId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lifeId = cleanId(docId) || cleanId(raw.lifeId);
  if (!lifeId) return null;
  // real lives (documented real people, added by the page owner) may be born long before 2000
  const real = raw.kind === 'real';
  const birthYear = toInt(raw.birthYear, real ? 1800 : FIRST_YEAR, real ? 2026 : LAST_BIRTH_YEAR, null);
  if (birthYear == null) return null;
  const age = toInt(raw.age, 0, MAX_AGE + 5, 0);
  const deathYear = toInt(raw.deathYear, birthYear, birthYear + MAX_AGE + 5, birthYear + age);
  const country = cleanIso(raw.country);
  const highlights = Array.isArray(raw.highlights)
    ? raw.highlights.slice(0, SHARE_LIMITS.highlights).map((x) => cleanLine(x, SHARE_LIMITS.highlight)).filter(Boolean)
    : [];
  const authorId = typeof raw.authorId === 'string' ? raw.authorId : null;
  return {
    v: toInt(raw.v, 1, 99, 1),
    lifeId,
    createdAt: cleanIsoDate(raw.createdAt),
    name: cleanLine(raw.name, SHARE_LIMITS.name) || '无名者',
    sex: cleanSex(raw.sex),
    country,
    countryName: displayCountryName(raw.countryName, country) || '未知地区',
    region: REGIONS[raw.region] ? raw.region : regionOf(country),
    birthYear,
    deathYear,
    age,
    cause: cleanLine(raw.cause, SHARE_LIMITS.cause),
    stats: cleanStats(raw.stats),
    lifemap: cleanLifemapString(raw.lifemap),
    highlights,
    epitaph: cleanLine(raw.epitaph, SHARE_LIMITS.epitaph),
    bio: cleanText(raw.bio, SHARE_LIMITS.bio),
    worldLabel: cleanLine(raw.worldLabel, SHARE_LIMITS.worldLabel),
    mode: raw.mode === 'custom' ? 'custom' : 'random',
    candles: toInt(raw.candles, 0, 1000, 0),
    // example lives seeded by the page owner (simulated by this engine), always labelled as such
    seed: raw.seed === true,
    real,
    ordinary: real && raw.ordinary === true,
    photo: real && typeof raw.photo === 'string' && (/^[0-9a-f]{32}$/.test(raw.photo) || SEED_PHOTO_RE.test(raw.photo)) ? raw.photo : null,
    photoCredit: real && raw.photoCredit && typeof raw.photoCredit === 'object' ? {
      author: cleanLine(raw.photoCredit.author, 80), license: cleanLine(raw.photoCredit.license, 40),
      note: cleanLine(raw.photoCredit.note, 60),
      url: typeof raw.photoCredit.url === 'string' && /^https:\/\/[^\s"'<>]{4,300}$/.test(raw.photoCredit.url) ? raw.photoCredit.url : '',
    } : null,
    sources: real && Array.isArray(raw.sources) ? raw.sources.slice(0, 4).map((x) => ({
      name: cleanLine(x && x.name, 40),
      url: x && typeof x.url === 'string' && /^https:\/\/[^\s"'<>]{4,300}$/.test(x.url) ? x.url : '',
    })).filter((x) => x.name && x.url) : [],
    mine: S.mode === 'local' ? raw.local === true : !!(authorId && S.platformId && authorId === S.platformId),
  };
}

function sanitizeMessage(docId, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanId(docId) || cleanId(raw.id);
  const text = cleanText(raw.text, SHARE_LIMITS.message);
  if (!id || !text) return null;
  const authorId = typeof raw.authorId === 'string' ? raw.authorId : null;
  return {
    id,
    text,
    at: cleanIsoDate(raw.at),
    mine: S.mode === 'local' ? true : !!(authorId && S.platformId && authorId === S.platformId),
  };
}

const byNewest = (field) => (a, b) => (b[field] || '').localeCompare(a[field] || '');

function eraRange(era) {
  if (!era) return null;
  if (typeof era === 'object' && Number.isFinite(era.from) && Number.isFinite(era.to)) return era;
  return ERAS.find((e) => e.id === era) || null;
}

/** Client-side filter used by screens and listShared: { region, country, era } (all optional). */
export function filterLives(lives, { region = '', country = '', era = '' } = {}) {
  const range = eraRange(era);
  return (lives || []).filter((l) => {
    if (country && l.country !== country) return false;
    if (region && l.region !== region) return false;
    if (range && (l.birthYear < range.from || l.birthYear > range.to)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// local-mode storage

function localLives() {
  const list = storage.get(KEYS.lives, []);
  return Array.isArray(list) ? list : [];
}
function saveLocalLives(list) { return storage.set(KEYS.lives, list.slice(0, LOCAL_LIVES_MAX)); }
function localCandles() { const m = storage.get(KEYS.candles, {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }
function localMessages() { const m = storage.get(KEYS.messages, {}); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }

function localLifeList() {
  const candles = localCandles();
  const own = localLives()
    .map((r) => sanitizeLife(r && r.lifeId, { ...r, local: true, candles: candles[r && r.lifeId] ? 1 : 0 }))
    .filter(Boolean)
    .sort(byNewest('createdAt'));
  const seed = (S.seedLives || [])
    .map((r) => sanitizeLife(r && r.lifeId, { ...r, local: false, candles: candles[r && r.lifeId] ? 1 : 0 }))
    .filter(Boolean)
    .sort(byNewest('createdAt'));
  return own.concat(seed);
}

// ---------------------------------------------------------------------------------------------------------------
// shared lives

/**
 * Share one finished life. Accepts a past-life record, a LifeState, or a shaped record.
 * Resolves { ok, lifeId, local? } or { ok:false, error, message }.
 */
export async function shareLife(input) {
  await initSocial();
  const rec = buildShareRecord(input);
  if (!rec) return fail('invalid');
  return single('share:' + rec.lifeId, () => shareRecord(rec));
}

async function shareRecord(rec) {
  if (S.mode === 'local') {
    const list = localLives().filter((r) => r && r.lifeId !== rec.lifeId);
    const prev = localLives().find((r) => r && r.lifeId === rec.lifeId);
    if (prev && cleanIsoDate(prev.createdAt)) rec.createdAt = prev.createdAt;
    list.unshift(rec);
    if (!saveLocalLives(list)) return fail('quota');
    bus.emit('social:lives');
    return { ok: true, lifeId: rec.lifeId, local: true };
  }

  if (!canWriteNow()) return fail(S.degraded ? 'degraded' : 'readonly');
  rec.authorId = S.platformId;

  // Re-sharing the same life keeps its date and candle count; an id taken by someone else gets a fresh id.
  const existing = await run(() => S.db.doc('lives/' + rec.lifeId).get());
  if (existing.ok && existing.value && existing.value.exists) {
    const prev = existing.value.data() || {};
    if (S.platformId && prev.authorId === S.platformId) {
      rec.createdAt = cleanIsoDate(prev.createdAt) || rec.createdAt;
      rec.candles = toInt(prev.candles, 0, 1000, 0);
    } else {
      rec.lifeId = randomId('life-');
    }
  } else if (!existing.ok && existing.error === 'degraded') {
    return existing;
  }

  const body = { ...rec };
  const res = await run(() => S.db.doc('lives/' + body.lifeId).set(body), { write: true });
  if (!res.ok) return res;
  return { ok: true, lifeId: body.lifeId };
}

/** Read one shared life (sanitized) or null. */
export async function getShared(lifeId) {
  await initSocial();
  const id = cleanId(lifeId);
  if (!id) return null;
  if (S.mode === 'local') return localLifeList().find((l) => l.lifeId === id) || null;
  const cached = feed.lives && feed.lives.find((l) => l.lifeId === id);
  const r = await run(() => S.db.doc('lives/' + id).get());
  if (!r.ok || !r.value) return cached || null;
  return r.value.exists ? sanitizeLife(r.value.id, r.value.data()) : null;
}

/**
 * One-off list of shared lives, newest first.
 * opts: { limit = 60, region, country, era ('2000s' | {from,to}) }. Always resolves an array.
 */
export async function listShared(opts = {}) {
  await initSocial();
  const limit = toInt(opts.limit, 1, 1000, 60);
  const filter = { region: opts.region || (opts.filter && opts.filter.region) || '', country: opts.country || (opts.filter && opts.filter.country) || '', era: opts.era || (opts.filter && opts.filter.era) || '' };
  if (S.mode === 'local') return filterLives(localLifeList(), filter).slice(0, limit);
  const country = cleanIso(filter.country);
  const windowSize = Math.min(1000, filter.region || filter.era ? limit * 4 : limit);
  const r = await run(() => {
    let q = S.db.collection('lives');
    if (country) q = q.where('country', '==', country);
    return q.orderBy('createdAt', 'desc').limit(windowSize).get();
  });
  if (!r.ok || !r.value) return (feed.lives ? filterLives(feed.lives, filter) : []).slice(0, limit);
  const lives = r.value.docs.map((d) => sanitizeLife(d.id, d.data())).filter(Boolean).sort(byNewest('createdAt'));
  return filterLives(lives, filter).slice(0, limit);
}

// feed subscription: one live query shared by every screen that subscribes (ref-counted)
const feed = {
  listeners: new Set(),
  lives: null,
  meta: { loading: true, error: null },
  unsub: null,
  offLocal: null,
  starting: false,
  retries: 0,
  retryTimer: null,
};

function deliverFeed() {
  const lives = feed.lives || [];
  for (const fn of Array.from(feed.listeners)) {
    try { fn(lives, { ...feed.meta }); } catch (e) { console.error('subscribeShared listener', e); }
  }
}

function stopFeedListener() {
  if (feed.unsub) { try { feed.unsub(); } catch { /* ignore */ } feed.unsub = null; }
  if (feed.offLocal) { feed.offLocal(); feed.offLocal = null; }
  if (feed.retryTimer) { clearTimeout(feed.retryTimer); feed.retryTimer = null; }
}

function startSharedQuery() {
  if (feed.unsub || !S.db || S.degraded || !feed.listeners.size) return;
  try {
    const q = S.db.collection('lives').orderBy('createdAt', 'desc').limit(FEED_WINDOW);
    feed.unsub = q.onSnapshot(
      (snap) => {
        feed.retries = 0;
        feed.lives = snap.docs.map((d) => sanitizeLife(d.id, d.data())).filter(Boolean).sort(byNewest('createdAt'));
        feed.meta = { loading: false, error: null, fromCache: !!(snap.metadata && snap.metadata.fromCache) };
        deliverFeed();
      },
      (err) => onFeedError(err),
    );
  } catch (e) {
    onFeedError(e);
  }
}

async function feedFallbackGet() {
  const r = await run(() => S.db.collection('lives').orderBy('createdAt', 'desc').limit(FEED_WINDOW).get(), { retry: false });
  if (r.ok && r.value) {
    feed.lives = r.value.docs.map((d) => sanitizeLife(d.id, d.data())).filter(Boolean).sort(byNewest('createdAt'));
    feed.meta = { loading: false, error: null };
  } else {
    feed.meta = { loading: false, error: r.message || SOCIAL_MESSAGES.network };
  }
  deliverFeed();
}

function onFeedError(err) {
  feed.unsub = null;
  const code = codeOf(err);
  if (code === 'revoked' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') {
    degrade();
    feed.meta = { loading: false, error: SOCIAL_MESSAGES.degraded };
    deliverFeed();
    return;
  }
  if (code === 'unavailable' && feed.retries < 3) {
    // the bridge stopped answering: a fresh subscription is the only recovery
    feed.retries += 1;
    feed.retryTimer = setTimeout(() => { feed.retryTimer = null; startSharedQuery(); }, 600 + Math.floor(Math.random() * 1400) * feed.retries);
    return;
  }
  // resource_exhausted / invalid_argument / repeated unavailability: fall back to a single read
  feedFallbackGet();
}

async function ensureFeed() {
  if (feed.starting || feed.unsub || feed.offLocal) return;
  feed.starting = true;
  try {
    await initSocial();
  } finally {
    feed.starting = false;
  }
  if (!feed.listeners.size) return;
  if (S.mode === 'local') {
    const refresh = () => {
      feed.lives = localLifeList();
      feed.meta = { loading: false, error: null, local: true };
      deliverFeed();
    };
    feed.offLocal = bus.on('social:lives', refresh);
    refresh();
    return;
  }
  if (S.degraded) {
    feed.meta = { loading: false, error: SOCIAL_MESSAGES.degraded };
    feed.lives = feed.lives || [];
    deliverFeed();
    return;
  }
  startSharedQuery();
}

/**
 * Live list of shared lives (newest first, up to 300). cb(lives, meta) fires now (if cached) and on every change.
 * One underlying subscription is shared by all callers. Returns unsubscribe.
 */
export function subscribeShared(cb) {
  if (typeof cb !== 'function') return () => {};
  feed.listeners.add(cb);
  if (feed.lives) {
    const lives = feed.lives;
    const meta = { ...feed.meta };
    Promise.resolve().then(() => { if (feed.listeners.has(cb)) cb(lives, meta); });
  }
  ensureFeed();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    feed.listeners.delete(cb);
    if (!feed.listeners.size) stopFeedListener();
  };
}

/**
 * Remove a shared life and its candles/messages. Allowed for the artifact owner and the life's author.
 */
export async function deleteShared(lifeId) {
  await initSocial();
  const id = cleanId(lifeId);
  if (!id) return fail('invalid');
  if (S.mode === 'local') {
    saveLocalLives(localLives().filter((r) => r && r.lifeId !== id));
    const c = localCandles(); delete c[id]; storage.set(KEYS.candles, c);
    const m = localMessages(); delete m[id]; storage.set(KEYS.messages, m);
    bus.emit('social:lives');
    return { ok: true };
  }
  if (!canWriteNow()) return fail(S.degraded ? 'degraded' : 'readonly');
  const got = await run(() => S.db.doc('lives/' + id).get());
  if (!got.ok) return got;
  if (got.value && got.value.exists) {
    const authorId = (got.value.data() || {}).authorId;
    const mine = !!(S.platformId && authorId === S.platformId);
    if (!S.owner && !mine) return fail('readonly');
  }
  // nested documents survive a parent delete, so clear them first (best effort, bounded)
  for (const sub of ['candles', 'messages']) {
    const list = await run(() => S.db.collection(`lives/${id}/${sub}`).limit(1000).get(), { retry: false });
    if (!list.ok || !list.value) continue;
    const docs = list.value.docs.slice();
    const workers = Array.from({ length: 4 }, async () => {
      while (docs.length) {
        const d = docs.pop();
        await run(() => S.db.doc(`lives/${id}/${sub}/${d.id}`).delete(), { write: true, readOnlyOnInvalid: false, retry: false });
      }
    });
    await Promise.all(workers);
  }
  const res = await run(() => S.db.doc('lives/' + id).delete(), { write: true });
  return res.ok ? { ok: true } : res;
}

// ---------------------------------------------------------------------------------------------------------------
// candles

/** Count candles for a life: a number, or the string '1000+' at the cap. null when the count is unavailable. */
export async function candleCount(lifeId) {
  await initSocial();
  const id = cleanId(lifeId);
  if (!id) return null;
  if (S.mode === 'local') return localCandles()[id] ? 1 : 0;
  const r = await run(() => S.db.collection(`lives/${id}/candles`).limit(1000).get());
  if (!r.ok || !r.value) return null;
  return r.value.size >= 1000 ? '1000+' : r.value.size;
}

/** Whether this viewer already lit a candle for the life. */
export async function hasLitCandle(lifeId) {
  await initSocial();
  const id = cleanId(lifeId);
  if (!id) return false;
  if (S.mode === 'local') return !!localCandles()[id];
  const r = await run(() => S.db.doc(`lives/${id}/candles/${S.viewerId}`).get());
  return !!(r.ok && r.value && r.value.exists);
}

/**
 * Light one candle (one per viewer; repeating is a no-op).
 * Resolves { ok, already?, count? } or { ok:false, error, message }.
 */
export async function lightCandle(lifeId) {
  await initSocial();
  const id = cleanId(lifeId);
  if (!id) return fail('invalid');
  return single('candle:' + id, () => lightCandleNow(id));
}

async function lightCandleNow(id) {
  if (S.mode === 'local') {
    const c = localCandles();
    if (c[id]) return { ok: true, already: true, count: 1 };
    c[id] = nowIso();
    if (!storage.set(KEYS.candles, c)) return fail('quota');
    bus.emit('social:candles', { lifeId: id });
    bus.emit('social:lives');
    return { ok: true, count: 1 };
  }
  if (!canWriteNow()) return fail(S.degraded ? 'degraded' : 'readonly');
  const ref = () => S.db.doc(`lives/${id}/candles/${S.viewerId}`);
  const prev = await run(() => ref().get());
  if (prev.ok && prev.value && prev.value.exists) return { ok: true, already: true };
  const res = await run(() => ref().set({ at: nowIso() }), { write: true });
  if (!res.ok) return res;
  // keep a cached count on the life document so the feed and memorial can sort without counting each life
  const n = await candleCount(id);
  if (typeof n === 'number' || n === '1000+') {
    const value = n === '1000+' ? 1000 : n;
    await run(() => S.db.doc('lives/' + id).update({ candles: value }), { write: true, readOnlyOnInvalid: false, retry: false });
  }
  return { ok: true, count: n };
}

/** Live candle state for one life: cb({ count, label, mine }). Returns unsubscribe. */
export function subscribeCandles(lifeId, cb) {
  const id = cleanId(lifeId);
  if (!id || typeof cb !== 'function') return () => {};
  let stopped = false;
  let unsub = null;
  let off = null;
  const send = (count, mine) => {
    if (stopped) return;
    try { cb({ count, label: count >= 1000 ? '1000+' : String(count), mine }); } catch (e) { console.error(e); }
  };
  const once = async () => {
    const [n, mine] = await Promise.all([candleCount(id), hasLitCandle(id)]);
    send(n === '1000+' ? 1000 : typeof n === 'number' ? n : 0, mine);
  };
  initSocial().then(() => {
    if (stopped) return;
    if (S.mode === 'local' || S.degraded) {
      once();
      if (S.mode === 'local') off = bus.on('social:candles', (e) => { if (e && e.lifeId === id) once(); });
      return;
    }
    try {
      unsub = S.db.collection(`lives/${id}/candles`).limit(1000).onSnapshot(
        (snap) => send(snap.size, snap.docs.some((d) => d.id === S.viewerId)),
        (err) => { unsub = null; const code = codeOf(err); if (code === 'revoked') degrade(); once(); },
      );
    } catch {
      once();
    }
  });
  return () => {
    stopped = true;
    if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
    if (off) { off(); off = null; }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// messages

/** Leave a short message (<= 200 chars) under a shared life. Resolves { ok, message } or an error result. */
export async function addMessage(lifeId, text) {
  await initSocial();
  const id = cleanId(lifeId);
  if (!id) return fail('invalid');
  const t = cleanText(text, SHARE_LIMITS.message);
  if (!t) return fail('empty');
  const now = Date.now();
  if (now - S.lastMessageAt < MESSAGE_COOLDOWN_MS) return fail('busy');
  const at = nowIso();
  // claim the cooldown before writing, so a double click cannot post the same message twice; give it back on failure
  const prevAt = S.lastMessageAt;
  S.lastMessageAt = now;

  if (S.mode === 'local') {
    const all = localMessages();
    const list = Array.isArray(all[id]) ? all[id] : [];
    const msg = { id: randomId('m-'), text: t, at };
    all[id] = [msg, ...list].slice(0, LOCAL_MSGS_MAX);
    if (!storage.set(KEYS.messages, all)) { S.lastMessageAt = prevAt; return fail('quota'); }
    bus.emit('social:messages', { lifeId: id });
    return { ok: true, message: { ...msg, mine: true } };
  }
  if (!canWriteNow()) { S.lastMessageAt = prevAt; return fail(S.degraded ? 'degraded' : 'readonly'); }
  const msgId = randomId('m-');
  const body = { v: 1, text: t, at, authorId: S.platformId };
  const res = await run(() => S.db.doc(`lives/${id}/messages/${msgId}`).set(body), { write: true });
  if (!res.ok) { S.lastMessageAt = prevAt; return res; }
  return { ok: true, message: { id: msgId, text: t, at, mine: true } };
}

/** Newest-first messages for a life (max 100), sanitized: [{ id, text, at, mine }]. */
export async function listMessages(lifeId, limit = 100) {
  await initSocial();
  const id = cleanId(lifeId);
  const n = toInt(limit, 1, 100, 100);
  if (!id) return [];
  if (S.mode === 'local') {
    const list = localMessages()[id];
    return (Array.isArray(list) ? list : []).map((m) => sanitizeMessage(m && m.id, m)).filter(Boolean).sort(byNewest('at')).slice(0, n);
  }
  const r = await run(() => S.db.collection(`lives/${id}/messages`).orderBy('at', 'desc').limit(n).get());
  if (!r.ok || !r.value) return [];
  return r.value.docs.map((d) => sanitizeMessage(d.id, d.data())).filter(Boolean).sort(byNewest('at'));
}

/** Live messages for one life: cb(messages, meta). Returns unsubscribe. */
export function subscribeMessages(lifeId, cb, limit = 100) {
  const id = cleanId(lifeId);
  if (!id || typeof cb !== 'function') return () => {};
  const n = toInt(limit, 1, 100, 100);
  let stopped = false;
  let unsub = null;
  let off = null;
  const send = (list, meta = {}) => { if (!stopped) { try { cb(list, meta); } catch (e) { console.error(e); } } };
  const once = async (meta) => send(await listMessages(id, n), meta);
  initSocial().then(() => {
    if (stopped) return;
    if (S.mode === 'local' || S.degraded) {
      once();
      if (S.mode === 'local') off = bus.on('social:messages', (e) => { if (e && e.lifeId === id) once(); });
      return;
    }
    try {
      unsub = S.db.collection(`lives/${id}/messages`).orderBy('at', 'desc').limit(n).onSnapshot(
        (snap) => send(snap.docs.map((d) => sanitizeMessage(d.id, d.data())).filter(Boolean).sort(byNewest('at'))),
        (err) => {
          unsub = null;
          const code = codeOf(err);
          if (code === 'revoked') degrade();
          once({ error: code === 'revoked' ? SOCIAL_MESSAGES.degraded : null });
        },
      );
    } catch {
      once();
    }
  });
  return () => {
    stopped = true;
    if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
    if (off) { off(); off = null; }
  };
}

/** Delete one message (artifact owner, or the viewer's own message). */
export async function deleteMessage(lifeId, messageId) {
  await initSocial();
  const id = cleanId(lifeId);
  const mid = cleanId(messageId);
  if (!id || !mid) return fail('invalid');
  if (S.mode === 'local') {
    const all = localMessages();
    all[id] = (Array.isArray(all[id]) ? all[id] : []).filter((m) => m && m.id !== mid);
    storage.set(KEYS.messages, all);
    bus.emit('social:messages', { lifeId: id });
    return { ok: true };
  }
  if (!canWriteNow()) return fail(S.degraded ? 'degraded' : 'readonly');
  const path = `lives/${id}/messages/${mid}`;
  if (!S.owner) {
    const got = await run(() => S.db.doc(path).get());
    if (!got.ok) return got;
    const authorId = got.value && got.value.exists ? (got.value.data() || {}).authorId : null;
    if (!(S.platformId && authorId === S.platformId)) return fail('readonly');
  }
  const res = await run(() => S.db.doc(path).delete(), { write: true });
  return res.ok ? { ok: true } : res;
}

// ---------------------------------------------------------------------------------------------------------------
// feedback

/** Send feedback text (<= 1000 chars) with the page/screen name. Anonymous: no viewer id is stored. */
export async function sendFeedback(text, page = '') {
  await initSocial();
  const t = cleanText(text, SHARE_LIMITS.feedback);
  if (!t) return fail('empty');
  const body = { v: 1, text: t, page: cleanLine(page, SHARE_LIMITS.page), at: nowIso() };
  if (S.mode === 'local') {
    const list = storage.get(KEYS.feedback, []);
    const next = [{ id: randomId('f-'), ...body }, ...(Array.isArray(list) ? list : [])].slice(0, LOCAL_FEEDBACK_MAX);
    if (!storage.set(KEYS.feedback, next)) return fail('quota');
    return { ok: true, local: true, mode: 'local' };
  }
  if (!canWriteNow()) return fail(S.degraded ? 'degraded' : 'readonly');
  const now = Date.now();
  if (now - S.lastFeedbackAt < FEEDBACK_COOLDOWN_MS) return fail('busy');
  const prevAt = S.lastFeedbackAt;
  S.lastFeedbackAt = now;
  const res = await run(() => S.db.doc('feedback/' + randomId('f-')).set(body), { write: true });
  if (!res.ok) S.lastFeedbackAt = prevAt;
  return res.ok ? { ok: true, mode: 'shared' } : res;
}

/** Newest feedback entries (for the owner's review). Always resolves an array of { id, text, page, at }. */
export async function listFeedback(limit = 100) {
  await initSocial();
  const n = toInt(limit, 1, 500, 100);
  const clean = (id, raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const text = cleanText(raw.text, SHARE_LIMITS.feedback);
    return text ? { id: cleanId(id) || '', text, page: cleanLine(raw.page, SHARE_LIMITS.page), at: cleanIsoDate(raw.at) } : null;
  };
  if (S.mode === 'local') {
    const list = storage.get(KEYS.feedback, []);
    return (Array.isArray(list) ? list : []).map((f) => clean(f && f.id, f)).filter(Boolean).slice(0, n);
  }
  const r = await run(() => S.db.collection('feedback').orderBy('at', 'desc').limit(n).get());
  if (!r.ok || !r.value) return [];
  return r.value.docs.map((d) => clean(d.id, d.data())).filter(Boolean);
}

/** Shared connection details for sibling modules (stories.js): the db namespace, viewer ids and mode. */
export async function socialContext() {
  await initSocial();
  return { mode: S.mode, db: S.db || null, viewerId: S.viewerId, platformId: S.platformId || null, owner: !!S.owner, canWrite: canWriteNow() };
}
