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
    .replace(/(-?\d+(?:\.\d+)?)\s*万亿/g, '$1T')
    .replace(/(-?\d+(?:\.\d+)?)\s*亿/g, (_, n) => { const v = +n * 100; return v >= 1000 ? `${+(v / 1000).toFixed(1)}B` : `${+v.toFixed(1)}M`; })
    .replace(/(-?\d+(?:\.\d+)?)\s*万/g, (_, n) => { const v = +n * 10; return v >= 1000 ? `${+(v / 1000).toFixed(1)}M` : `${+v.toFixed(1)}K`; })
    .replace(/(\d{4})\s*年/g, '$1')
    .replace(/(\d+)\s*岁/g, '$1');
}

/** Grammar a filled-in template can't know in advance: singular after 1, and a capital at the start of a full sentence. */
function polishEnglish(s) {
  const singular = s
    .replace(/(?<![\d.,])1 children\b/g, '1 child')
    .replace(/(?<![\d.,])1 lives\b/g, '1 life')
    .replace(/(?<![\d.,])1 ([a-z]+[^s\W])s\b/g, '1 $1')
    .replace(/([a-z0-9%])\(/g, '$1 (') // a note joined on from a separate string
    .replace(/\b([Aa]) (?=[aeio]|un[^iv]|ho(?:ur|nest))/g, '$1n ') // a/an depends on what was filled in
    .replace(/\b(of|to|with|for|beside|about|remembered) he\b/g, '$1 him')
    .replace(/\b(of|to|with|for|beside|about|remembered) she\b/g, '$1 her')
    .replace(/ {2,}/g, ' ');
  return /[.!?]["')]?$/.test(singular) ? singular.replace(/^[a-z]/, (c) => c.toUpperCase()) : singular;
}

let lang = 'zh';
let exact = new Map();
let index = new Map(); // first bigram of a template's longest literal -> templates
let surnames = new Map();
let givenNames = new Map();
let heads = null; // clipped first sentence -> English first sentence, built on first use
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
  if (!merge) { exact = new Map(); index = new Map(); surnames = new Map(); givenNames = new Map(); }
  for (const [zh, en] of Object.entries(map)) {
    if (zh.startsWith('@s:')) surnames.set(zh.slice(3), en);
    else if (zh.startsWith('@g:')) givenNames.set(zh.slice(3), en);
    else if (PLACEHOLDER.test(zh)) addTemplate(zh, en);
    else {
      exact.set(zh, en);
      // "。那一年……" joins on to the sentence before it, and splitting into sentences loses the leading stop.
      if (zh[0] === '。') exact.set(zh.slice(1), en.replace(/^[.\s]+/, ''));
    }
    PLACEHOLDER.lastIndex = 0;
  }
  cache = new Map();
  heads = null;
}

/** The engine shows only an event's first sentence, clipped; this is how it cuts them (engine.js firstSentence). */
function clippedHead(zh) {
  const t = zh.replace(/\s+/g, ' ').trim();
  const i = t.search(/[。！？；]/);
  const one = i >= 0 ? t.slice(0, i + 1) : t;
  return one.length > 70 ? `${one.slice(0, 70)}……` : one.replace(/；$/, '。');
}

function headIndex() {
  if (heads) return heads;
  heads = new Map();
  for (const [zh, en] of exact) {
    // exam and scheme names lose their bracketed notes and are cut short in a sentence (events.js)
    if (/（[^（）]*）/.test(zh)) {
      const short = zh.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim();
      const name = en.replace(/\s*\([^()]*\)/g, '').trim();
      heads.set(short, name);
      heads.set(short.slice(0, 24), name);
    }
    if (zh.length < 12 || !/[。！？；]/.test(zh)) continue;
    const m = /^.*?[.!?;](?=\s|$)/s.exec(en);
    const first = (m ? m[0] : en).replace(/;$/, '.');
    const head = clippedHead(zh);
    heads.set(head, first);
    heads.set(head.replace(/。$/, ''), first);
  }
  return heads;
}

/** Text wrapped by the engine at run time: 「title」 and cause（detail）. */
function fromWrapped(text) {
  const quoted = /^「(.+)」$/s.exec(text);
  if (quoted) return `"${translate(quoted[1])}"`;
  const noted = /^(.+?)（(.+)）$/s.exec(text);
  if (noted && !CJK.test(translate(noted[1]))) return `${translate(noted[1])} (${translate(noted[2])})`;
  return null;
}

/** A news line: 【推演】title：first sentence of the summary. */
function fromNews(text) {
  const m = /^(【推演】)?([^：]{2,60})：(.+)$/s.exec(text);
  if (!m) return null;
  // projected events name the countries they hit: 特大洪水（中国、印度）
  const place = /^(.+)（([^（）]+)）$/.exec(m[2]);
  const title = place && exact.has(place[1]) ? `${exact.get(place[1])} (${translate(place[2])})` : exact.get(m[2]);
  const body =exact.get(m[3]) ?? headIndex().get(m[3]);
  if (title === undefined || body === undefined) return null;
  return `${m[1] ? `${exact.get('【推演】') ?? '[Projected]'} ` : ''}${title}: ${body}`;
}

function compile(t) {
  if (t.re) return t.re;
  const src = t.zh.split(PLACEHOLDER).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^。！？]*?)');
  t.re = new RegExp(`^${src}$`, 's');
  return t.re;
}

/** A long template may also hold whole sentences in a slot: {0}……{1}窗外安静。 */
function compileLoose(t) {
  if (t.loose) return t.loose;
  const src = t.zh.split(PLACEHOLDER).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*?)');
  t.loose = new RegExp(`^${src}$`, 's');
  return t.loose;
}

/** In {0}{1} a lazy match gives everything to one capture; find the cut where both sides are known text. */
function splitAdjacent(t, caps) {
  const known = (s) => !CJK.test(s) || exact.has(s) || fromName(s) != null;
  for (let i = 0; i + 1 < caps.length; i++) {
    if (!t.zh.includes(t.names[i] + t.names[i + 1])) continue;
    const joined = caps[i] + caps[i + 1];
    for (let k = 1; k < joined.length; k++) {
      if (known(joined.slice(0, k)) && known(joined.slice(k))) {
        caps[i] = joined.slice(0, k);
        caps[i + 1] = joined.slice(k);
        break;
      }
    }
  }
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
    const m = compile(t).exec(text) ?? (t.weight >= 5 ? compileLoose(t).exec(text) : null);
    if (!m) continue;
    const caps = m.slice(1);
    if (t.plainOnly && caps.some((c) => CJK.test(translate(c)))) continue;
    splitAdjacent(t, caps);
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
    // a catalog entry can span several sentences: try the longest run first
    let joined = false;
    for (let j = parts.length - 2; j > i + 1 && !joined; j -= 2) {
      const run = parts.slice(i, j + 1).join('');
      const hit = exact.get(run);
      if (hit !== undefined) { out += hit + ' '; i = j; joined = true; }
    }
    if (joined) continue;
    const delim = parts[i + 1] || '';
    const whole = delim ? p + delim.slice(0, 1) : '';
    const full = delim ? exact.get(whole) ?? headIndex().get(whole) ?? fromTemplate(whole) : null;
    if (full != null) { out += full + ' '; i++; continue; }
    out += translate(p);
  }
  return out;
}

/** A generated name: 阿尔琼·辛格 and 约翰 史密斯 by their parts, 王浩然 and 欧阳浩然 as surname + given name. */
function fromName(text) {
  if (/[·\s]/.test(text)) {
    const parts = text.split(/[·\s]+/);
    return parts.every((p) => exact.has(p)) ? parts.map((p) => exact.get(p)).join(' ') : null;
  }
  for (const n of [2, 1]) {
    const sur = surnames.get(text.slice(0, n));
    const given = givenNames.get(text.slice(n));
    if (sur && given) return `${sur} ${given}`;
  }
  return null;
}

function translate(raw) {
  if (!raw || !CJK.test(raw)) return raw;
  const hit = cache.get(raw);
  if (hit !== undefined) return hit;
  const lead = raw.match(/^\s*/)[0];
  const tail = raw.match(/\s*$/)[0];
  const text = raw.trim();
  const result = exact.get(text) ?? headIndex().get(text) ?? fromName(text) ?? fromWrapped(text) ?? fromNews(text) ?? fromTemplate(text) ?? bySegments(text, SENTENCE) ?? bySegments(text, CLAUSE);
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
  const tidy = polishEnglish(PUNCT.reduce((s, [re, to]) => s.replace(re, to), out));
  return /\s$/.test(text) ? tidy : tidy.trimEnd();
}

/** The catalog's English for an exact string, whatever the current language; used to recognise typed place names. */
export const englishOf = (zh) => exact.get(zh) ?? null;

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
