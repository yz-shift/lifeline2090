// English translation at the presentation boundary. The engine, saves and seeds stay in Chinese, so the same seed
// gives the same life in both languages and old saves display in English without migration.
//
// tr(text) looks up, in order: the whole string; a template such as "你找到了一份新工作：{0}。" (captures are translated
// recursively); then the string split into sentences and clauses. Text it cannot resolve stays in Chinese and is
// recorded in misses(), which is what tools/i18n_coverage.mjs reports.

import { BOOT_EN } from './boot_en.js';

const LANG_KEY = 'll2090.lang';
const CATALOG_URL = 'data/i18n_en.json';
export const LANGS = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }];

const CJK = /[一-鿿]/;
const SENTENCE = /([。！？；\n]+)/;
const CLAUSE = /([，、：]+)/;
const PLACEHOLDER = /\{\w+\}/g;
const PUNCT = [
  [/[“”]/g, '"'], [/[‘’]/g, "'"], [/，/g, ', '], [/。/g, '. '], [/！/g, '! '], [/？/g, '? '], [/；/g, '; '], [/：/g, ': '],
  [/、/g, ', '], [/（/g, ' ('], [/）/g, ') '], [/《|》/g, ''], [/ {2,}/g, ' '], [/ +([,.!?;:)])/g, '$1'], [/\( +/g, '('],
];

const store = {
  get() { try { return JSON.parse(localStorage.getItem(LANG_KEY)); } catch { return null; } },
  set(v) { try { localStorage.setItem(LANG_KEY, JSON.stringify(v)); } catch { /* storage blocked: choice lasts this visit */ } },
};

/** Chinese number units and bare year/age suffixes that survive inside otherwise translated text. */
function finishEnglish(s) {
  return s
    .replace(/(-?\d+(?:\.\d+)?)\s*亿/g, (_, n) => { const v = +n * 100; return v >= 1000 ? `${+(v / 1000).toFixed(1)}B` : `${+v.toFixed(1)}M`; })
    .replace(/(-?\d+(?:\.\d+)?)\s*万/g, (_, n) => { const v = +n * 10; return v >= 1000 ? `${+(v / 1000).toFixed(1)}M` : `${+v.toFixed(1)}K`; })
    .replace(/(\d{4})\s*年/g, '$1')
    .replace(/(\d+)\s*岁/g, '$1');
}

let lang = 'zh';
let exact = new Map();
let index = new Map(); // first bigram of a template's longest literal -> templates
let cache = new Map();
let catalogLoaded = false;
const misses = new Set();
const listeners = new Set();

const cjkCount = (s) => (s.match(/[一-鿿]/g) || []).length;

function addTemplate(zh, en) {
  const literals = zh.split(PLACEHOLDER);
  const longest = literals.reduce((a, b) => (cjkCount(b) > cjkCount(a) ? b : a), '');
  const at = longest.search(CJK);
  if (at < 0) return;
  const key = longest.slice(at, at + 2);
  const t = {
    zh, en, weight: cjkCount(literals.join('')), names: zh.match(PLACEHOLDER), re: null,
    // A one-character literal such as "{0} 岁" is only trusted when the capture is a number or other non-Chinese text.
    plainOnly: cjkCount(literals.join('')) < 2,
  };
  let list = index.get(key);
  if (!list) index.set(key, list = []);
  list.push(t);
}

/** Replace the catalog: { zh: en }; keys containing {name} are templates. */
export function setCatalog(map, { merge = false } = {}) {
  if (!merge) { exact = new Map(); index = new Map(); }
  for (const [zh, en] of Object.entries(map)) {
    if (PLACEHOLDER.test(zh)) addTemplate(zh, en);
    else exact.set(zh, en);
    PLACEHOLDER.lastIndex = 0;
  }
  cache = new Map();
}

function compile(t) {
  if (t.re) return t.re;
  const src = t.zh.split(PLACEHOLDER).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^。！？]*?)');
  t.re = new RegExp(`^${src}$`, 's');
  return t.re;
}

function fromTemplate(text) {
  const seen = new Set();
  const found = [];
  const collect = (key) => {
    const list = index.get(key);
    if (list && !seen.has(key)) { seen.add(key); found.push(...list); }
  };
  for (let i = 0; i < text.length; i++) { collect(text.slice(i, i + 1)); collect(text.slice(i, i + 2)); }
  found.sort((a, b) => b.weight - a.weight);
  for (const t of found) {
    const m = compile(t).exec(text);
    if (!m) continue;
    const caps = m.slice(1);
    if (t.plainOnly && caps.some((c) => CJK.test(c))) continue;
    let out = t.en;
    t.names.forEach((name, i) => { out = out.split(name).join(translate(caps[i])); });
    return out;
  }
  return null;
}

/** Split on a delimiter set and translate each piece; null when nothing was split off. */
function bySegments(text, splitter) {
  const parts = text.split(splitter);
  if (parts.length < 2) return null;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (i % 2) { out += p; continue; }
    const delim = parts[i + 1] || '';
    const full = delim ? exact.get(p + delim.slice(0, 1)) : undefined;
    if (full !== undefined) { out += full + ' '; i++; continue; }
    out += translate(p);
  }
  return out;
}

function translate(raw) {
  if (!raw || !CJK.test(raw)) return raw;
  const hit = cache.get(raw);
  if (hit !== undefined) return hit;
  const lead = raw.match(/^\s*/)[0];
  const tail = raw.match(/\s*$/)[0];
  const text = raw.trim();
  const result = exact.get(text) ?? fromTemplate(text) ?? bySegments(text, SENTENCE) ?? bySegments(text, CLAUSE);
  if (result == null) misses.add(text);
  const out = lead + (result ?? text) + tail;
  cache.set(raw, out);
  return out;
}

/** Text as the player should read it in the current language. */
export function tr(text) {
  if (lang === 'zh' || typeof text !== 'string' || !CJK.test(text)) return text;
  const out = finishEnglish(translate(text));
  if (out === text) return text;
  const tidy = PUNCT.reduce((s, [re, to]) => s.replace(re, to), out);
  return /\s$/.test(text) ? tidy : tidy.trimEnd();
}

export const getLang = () => lang;
export const isEn = () => lang === 'en';
export const locale = () => (lang === 'en' ? 'en-AU' : 'zh-CN');
export const missedStrings = () => [...misses];
export const onLangChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function ensureCatalog() {
  if (catalogLoaded) return;
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`${CATALOG_URL}: HTTP ${res.status}`);
  setCatalog(await res.json(), { merge: true });
  catalogLoaded = true;
}

/** Saved choice, else the browser language. Boot strings are available at once, the full catalog after loadLang(). */
export function initLang() {
  const saved = store.get();
  let wanted = saved;
  if (wanted !== 'zh' && wanted !== 'en') {
    const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
    wanted = /^zh/i.test(nav) ? 'zh' : 'en';
  }
  setCatalog(BOOT_EN, { merge: true });
  lang = wanted;
  return lang;
}

export async function loadLang() {
  if (lang === 'en') await ensureCatalog();
}

/** Switch language live. Falls back to the previous language if the catalog cannot be downloaded. */
export async function setLang(next) {
  if (next !== 'zh' && next !== 'en') return lang;
  if (next === 'en') await ensureCatalog();
  lang = next;
  store.set(next);
  for (const fn of listeners) fn(next);
  return lang;
}

/** For tests and tools: run without storage or fetch. */
export function forceLang(next) { lang = next; }
