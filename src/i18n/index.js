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
const DOTTED = /( · )/;
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
    .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, '$1-$2-$3')
    .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月/g, '$1-$2')
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
    .replace(/(?<![\d.,])1 people\b/g, '1 person')
    .replace(/(?<![\d.,])1 ([a-z]+[^s\W])s\b/g, '1 $1')
    .replace(/([a-z0-9%])\(/g, '$1 (') // a note joined on from a separate string
    .replace(/\b([Aa]) (?=[aeio]|un[^iv]|ho(?:ur|nest))/g, '$1n ') // a/an depends on what was filled in
    .replace(/\b(of|to|with|for|beside|about|remembered) he\b/g, '$1 him')
    .replace(/\b(of|to|with|for|beside|about|remembered) she\b/g, '$1 her')
    .replace(/(?<!\.)\.[ ]*\.(?!\.)/g, '.') // pieces joined at a stop
    .replace(/\.;/g, ';')
    .replace(/([.!?]["')]?[ ]+)([a-z])/g, (_, gap, c) => gap + c.toUpperCase()) // a new sentence after pieces are joined
    .replace(/([a-z]\.)([A-Z])/g, '$1 $2') // pieces joined with no gap
    .replace(/\b([Yy]our) (Big|Little|Older|Younger) /g, (_, y, w) => `${y} ${w.toLowerCase()} `)
    .replace(/ {2,}/g, ' ');
  return /[.!?]["')]?$/.test(singular) ? singular.replace(/^[a-z]/, (c) => c.toUpperCase()) : singular;
}

let lang = 'zh';
let exact = new Map();
let allTemplates = [];
let index = new Map(); // first bigram of a template's longest literal -> templates
let surnames = new Map();
let givenNames = new Map();
let heads = null; // clipped first sentence -> English first sentence, built on first use
let depth = 0;
let scanning = 0;
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
    zh, en, literals: literals.filter(Boolean), weight: cjkCount(literals.join('')), names: zh.match(PLACEHOLDER), re: null,
    // A one-character literal such as "{0} 岁" is only trusted when the capture is a number or other non-Chinese text.
    plainOnly: cjkCount(literals.join('')) < 2,
  };
  let list = index.get(key);
  if (!list) index.set(key, list = []);
  list.push(t);
  allTemplates.push(t);
}

/** Replace the catalog: { zh: en }; keys containing {name} are templates. */
export function setCatalog(map, { merge = false } = {}) {
  if (!merge) { allTemplates = []; exact = new Map(); index = new Map(); surnames = new Map(); givenNames = new Map(); }
  for (const [zh, en] of Object.entries(map)) {
    if (zh.startsWith('@s:')) surnames.set(zh.slice(3), en);
    else if (zh.startsWith('@g:')) givenNames.set(zh.slice(3), en);
    else if (PLACEHOLDER.test(zh)) {
      addTemplate(zh, en);
      // a piece that joins on to the sentence before it: ；每 1000 个…… is also met without its lead-in
      if (/^[。；，]/.test(zh)) addTemplate(zh.slice(1), en.replace(/^[.;,\s]+/, ''));
    }
    else {
      exact.set(zh, en);
      // "。那一年……" joins on to the sentence before it, and splitting into sentences loses the leading stop.
      if (/^[。；，]/.test(zh)) exact.set(zh.slice(1), en.replace(/^[.;,\s]+/, ''));
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
    if (/[（(][^）)]*[）)]/.test(zh)) {
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
  // a label and its number: 健康 76; an amount in a named currency: 3242万印度尼西亚盾
  const stat = /^(\S+) ([-−+]?[\d.,%].*)$/.exec(text);
  if (stat && exact.has(stat[1]) && !CJK.test(stat[2])) return `${exact.get(stat[1])} ${translate(stat[2])}`;
  const money = /^([-−]?[\d.,]+(?:万亿|亿|万)?)\s*([^\d\s]{2,})$/.exec(text);
  if (money && exact.has(money[2])) return `${money[1]} ${exact.get(money[2])}`;
  // effect chips: 知识↑ 快乐略↓ 婚姻更稳
  const chips = text.split(' ');
  if (chips.length > 1 || /[↑↓]$/.test(text)) {
    const named = chips.map((c) => {
      const m = /^(\S+?)(略)?([↑↓])$/.exec(c);
      if (!m) return exact.get(c);
      const label = exact.get(m[1]);
      return label ? `${label} ${m[2] ? 'slightly ' : ''}${m[3]}` : undefined;
    });
    if (named.every((n) => n !== undefined)) return named.join(', ');
  }
  const tag = /^#(\S+)$/.exec(text);
  if (tag && exact.has(tag[1])) return `#${exact.get(tag[1]).toLowerCase()}`;
  const listed = text.split(/(?<=”)、/);
  if (listed.length > 1) {
    const items = listed.map((x) => translate(x));
    if (!items.some((x) => CJK.test(x))) return items.join(', ');
  }
  const bullet = /^· (.+)$/s.exec(text);
  if (bullet) return `· ${translate(bullet[1])}`;
  const quoted = /^[「“](.+)[」”]$/s.exec(text);
  if (quoted && !/[」”].*[「“]/s.test(quoted[1])) return `"${translate(quoted[1])}"`;
  const bracketed = /^（(.+)）$/s.exec(text);
  if (bracketed) return ` (${translate(bracketed[1])})`;
  const noted = /^(.+?)（(.+)）$/s.exec(text);
  if (noted && !CJK.test(translate(noted[1]))) return `${translate(noted[1])} (${translate(noted[2])})`;
  return null;
}

/** A news line: 【推演】title：first sentence of the summary. */
function fromNews(text) {
  const prefix = text.startsWith('【推演】') ? '【推演】' : '';
  const line = text.slice(prefix.length);
  if (/^\d{4} 年，\d+ 岁，/.test(line)) return null; // a life map label has its own template
  // the title itself may hold a colon, so try each one
  for (let at = line.indexOf('：'); at >= 0; at = line.indexOf('：', at + 1)) {
    const head = line.slice(0, at);
    const rest = line.slice(at + 1);
    // projected events name the countries they hit: 特大洪水（中国、印度）
    const place = /^(.+)（([^（）]+)）$/.exec(head);
    const named = place && exact.has(place[1]) ? `${exact.get(place[1])} (${translate(place[2])})` : exact.get(head);
    const title = named ?? translate(head);
    if (CJK.test(title)) continue;
    const body = exact.get(rest) ?? headIndex().get(rest) ?? translate(rest);
    if (CJK.test(body)) continue;
    return `${prefix ? `${exact.get('【推演】') ?? '[Projected]'} ` : ''}${title}: ${body}`;
  }
  return null;
}

function compile(t) {
  if (t.re) return t.re;
  const src = t.zh.split(PLACEHOLDER).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^。！？]*?)').replace(/\(\[\^。！？\]\*\?\)$/, '(.*?)');
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

function compileLooseGreedy(t) {
  if (t.looseGreedy) return t.looseGreedy;
  const src = t.zh.split(PLACEHOLDER).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)');
  t.looseGreedy = new RegExp(`^${src}$`, 's');
  return t.looseGreedy;
}

/** A name can end in the same character the template goes on with: 侯赛因因病…… */
function compileGreedy(t) {
  if (t.greedy) return t.greedy;
  const src = t.zh.split(PLACEHOLDER).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^。！？]*)');
  t.greedy = new RegExp(`^${src}$`, 's');
  return t.greedy;
}

/**
 * Short labels cut an entry at its first clause, or after so many characters: 你开始怕黑 / 一位老师发现你的作业本总是写到….
 * Slow, so only for a whole piece of text and never while trying out splits.
 */
function fromPrefix(text) {
  if (scanning || depth > 1 || text.length < 4) return null;
  const clipped = text.endsWith('…');
  const start = clipped ? text.replace(/…+$/, '') : text;
  for (const [zh, en] of exact) {
    if (!zh.startsWith(start) || zh.length === start.length) continue;
    if (!clipped && !/[，。：；！？]/.test(zh[start.length])) continue;
    const m = /^.*?[.!?;](?=\s|$)/s.exec(en);
    return (m ? m[0] : en).replace(/[.;]$/, '');
  }
  return null;
}

/**
 * The life map's headline is an event cut at its first clause, after the slots are filled:
 * {kin}去世了，…… shows as 祖母去世了. Read it with the template's first clause, and the English up to its first break.
 */
function fromClause(text) {
  if (scanning || depth > 2 || /[。！？]/.test(text)) return null;
  const clipped = text.endsWith('…');
  const start = text.replace(/…+$/, '').replace(/^「/, '');
  if (start.length < 2) return null;
  if (clipped && start.includes('（') && exact.has(start.split('（')[0])) return exact.get(start.split('（')[0]);
  for (const t of allTemplates) {
    const stop = t.zh.search(/[，。：；！？]/);
    if (stop < 2) continue;
    const head = t.zh.slice(0, stop);
    let clause = /^[^,.;:!?]*/.exec(t.en)[0].trim();
    if (!clause) continue;
    const names = head.match(PLACEHOLDER) || [];
    if (!(clause.match(PLACEHOLDER) || []).every((n) => names.includes(n)) || (clipped && t.zh.startsWith(start) && names.length)) {
      // the English goes on to a slot this text never got to: stop short of it
      const cut = clause.search(PLACEHOLDER);
      PLACEHOLDER.lastIndex = 0;
      const hasHead = clipped ? t.zh.startsWith(start) : head === start;
      if (!hasHead || cut < 8) continue;
      return `${clause.slice(0, cut).trim()}…`;
    }
    if (!names.length) {
      if (clipped ? t.zh.startsWith(start) : head === start) return clause;
      continue;
    }
    const literals = head.split(PLACEHOLDER);
    if (clipped || cjkCount(literals.join('')) < 2) continue;
    t.headRe ??= new RegExp(`^${literals.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)')}$`, 's');
    const m = t.headRe.exec(start);
    if (!m) continue;
    let out = clause;
    let clean = true;
    names.forEach((name, i) => {
      const piece = translate(m[i + 1]);
      if (CJK.test(piece)) clean = false;
      out = out.split(name).join(piece);
    });
    if (clean) return out;
  }
  if (clipped || start.length >= 10) {
    for (const [zh, en] of exact) if (zh.length > start.length && zh.startsWith(start)) return /^.*?[.!?;](?=\s|$)/s.exec(en)?.[0].replace(/[.;]$/, '') ?? en;
  }
  return clipped ? fromCutTemplate(start) : null;
}

/** A label cut in the middle of a template, after some of its slots: 你的姐姐玛丽·里希特因病离开… */
function fromCutTemplate(start) {
  const esc = (x) => x.replace(/[.*+?^${}()|[]\]/g, '\$&');
  for (const t of allTemplates) {
    if (!t.literals.length || !start.startsWith(t.zh.split(PLACEHOLDER)[0])) continue;
    const lits = t.zh.split(PLACEHOLDER);
    for (let k = 1; k < lits.length; k++) {
      const next = lits[k];
      if (cjkCount(next) < 2) continue;
      const m = new RegExp(`^${lits.slice(0, k).map(esc).join('(.+?)')}(.+)$`, 's').exec(start);
      if (!m) continue;
      const caps = m.slice(1);
      const last = caps[caps.length - 1];
      let cut = 0;
      for (let n = Math.min(next.length, last.length - 1); n >= 2 && !cut; n--) if (next.startsWith(last.slice(-n))) cut = n;
      if (!cut) continue;
      caps[caps.length - 1] = last.slice(0, -cut);
      splitAdjacent(t, caps);
      const clause = /^[^,.;:!?]*/.exec(t.en)[0].trim();
      const filled = t.names.slice(0, k);
      if (!(clause.match(PLACEHOLDER) || []).every((n) => filled.includes(n))) continue;
      let out = clause;
      filled.forEach((name, i) => { out = out.split(name).join(translate(caps[i])); });
      if (!CJK.test(out)) return out;
    }
  }
  return null;
}

/** A sentence that opens with a generated name and nothing else to match on: 西曼准塔克心春读了职业学校，…… */
function fromNamed(text) {
  if (scanning || depth > 1) return null;
  for (let n = Math.min(text.length - 1, 10); n >= 2; n--) {
    const name = fromName(text.slice(0, n));
    if (!name) continue;
    const rest = translate(text.slice(n));
    if (!CJK.test(rest)) return `${name} ${rest}`;
  }
  return null;
}

/** In {0}{1} a lazy match gives everything to one capture; find the cut where both sides are known text. */
function splitAdjacent(t, caps) {
  const known = (s) => !CJK.test(translate(s));
  scanning++;
  for (let i = 0; i + 1 < caps.length; i++) {
    if (!t.zh.includes(t.names[i] + t.names[i + 1])) continue;
    const joined = caps[i] + caps[i + 1];
    for (let k = joined.length - 1; k >= 1; k--) {
      if (known(joined.slice(0, k)) && known(joined.slice(k))) {
        caps[i] = joined.slice(0, k);
        caps[i + 1] = joined.slice(k);
        break;
      }
    }
  }
  scanning--;
}

function fromTemplate(text) {
  const seen = new Set();
  const found = [];
  const collect = (key) => {
    const list = index.get(key);
    if (list && !seen.has(key)) { seen.add(key); found.push(...list); }
  };
  for (let i = 0; i < text.length; i++) { collect(text.slice(i, i + 1)); collect(text.slice(i, i + 2)); }
  const possible = found.filter((t) => t.literals.every((l) => text.includes(l)));
  possible.sort((a, b) => b.weight - a.weight);
  const fill = (t, m) => {
    const caps = m.slice(1);
    if (t.plainOnly && caps.some((c) => CJK.test(translate(c)))) return null;
    splitAdjacent(t, caps);
    let out = t.en;
    t.names.forEach((name, i) => { out = out.split(name).join(translate(caps[i])); });
    return out;
  };
  // the first fully translated reading wins; a partial one is only kept in case nothing better turns up
  let partial = null;
  depth++;
  try {
    if (depth > 8) return null;
    for (const t of possible.slice(0, 40)) {
      for (const m of [compile(t).exec(text), t.weight >= 4 ? compileGreedy(t).exec(text) : null, ...(t.weight >= 4 && (/[。！？]./.test(t.zh) || t.zh.includes('「')) ? [compileLoose(t).exec(text), compileLooseGreedy(t).exec(text)] : [])]) {
        if (!m) continue;
        const out = fill(t, m);
        if (out == null) continue;
        if (!CJK.test(out)) return out;
        partial ??= out;
      }
    }
  } finally {
    depth--;
  }
  return partial;
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
    if (i > 0 && i + 2 < parts.length) {
      const rest = parts.slice(i).join('');
      const tail = exact.get(rest) ?? fromTemplate(rest);
      if (tail != null && !CJK.test(tail)) return `${out}${tail}`;
    }
    for (let j = parts.length - 2; j > i + 1 && !joined; j -= 2) {
      const run = parts.slice(i, j + 1).join('');
      const tried = exact.get(run) ?? fromTemplate(run);
      const hit = tried != null && !CJK.test(tried) ? tried : undefined;
      if (hit !== undefined) { out += hit + ' '; i = j; joined = true; }
    }
    if (joined) continue;
    const delim = parts[i + 1] || '';
    const whole = delim && !/^\s/.test(delim) ? p + delim.slice(0, 1) : '';
    const full = whole ? exact.get(whole) ?? headIndex().get(whole) ?? fromTemplate(whole) : null;
    if (full != null) { out += full + ' '; i++; continue; }
    out += translate(p);
  }
  return out;
}

/** A generated name: 阿尔琼·辛格 and 约翰 史密斯 by their parts, 王浩然 and 欧阳浩然 as surname + given name. */
function fromName(text) {
  if (/[·\s]/.test(text)) {
    const parts = text.split(/[·\s]+/);
    const named = [];
    for (let i = 0; i < parts.length;) {
      let j = parts.length;
      while (j > i && !exact.has(parts.slice(i, j).join('·'))) j--;
      if (j === i) return null;
      named.push(exact.get(parts.slice(i, j).join('·')));
      i = j;
    }
    return named.join(' ');
  }
  for (let n = Math.min(text.length - 1, 8); n >= 1; n--) {
    const sur = surnames.get(text.slice(0, n));
    const given = givenNames.get(text.slice(n));
    if (sur && given) return `${sur} ${given}`;
  }
  for (let n = Math.min(text.length - 1, 3); n >= 2; n--) {
    const given = givenNames.get(text.slice(n));
    const sur = surnames.get(text[0]);
    if (sur && given) return `${sur} ${given}`;
  }
  return null;
}

/** The text with a stop added, only if that reads completely. */
function wholeStopped(stopped) {
  if (!stopped) return null;
  const hit = exact.get(stopped) ?? fromTemplate(stopped);
  return hit != null && !CJK.test(hit) ? hit : null;
}

function translate(raw) {
  if (!raw || !CJK.test(raw)) return raw;
  const hit = cache.get(raw);
  if (hit !== undefined) return hit;
  const lead = raw.match(/^\s*/)[0];
  const tail = raw.match(/\s*$/)[0];
  const text = raw.trim().replace(/『/g, '“').replace(/』/g, '”');
  const stopped = /[。！？，；]$/.test(text) ? null : `${text}。`; // a clause cut from a sentence whose entry ends in a stop
  const dotted = text.includes(' · ') && !exact.has(text) ? bySegments(text, DOTTED) : null;
  const direct = exact.get(text) ?? (dotted != null && !CJK.test(dotted) ? dotted : null) ?? headIndex().get(text) ?? fromName(text) ?? fromWrapped(text) ?? fromNews(text);
  const templated = (direct != null && !CJK.test(direct) ? direct : null) ?? fromTemplate(text) ?? direct;
  const clean = templated != null && !CJK.test(templated) ? templated
    : wholeStopped(stopped) ?? fromPrefix(text) ?? fromClause(text) ?? fromNamed(text) ?? dotted ?? bySegments(text, SENTENCE) ?? bySegments(text, CLAUSE);
  const result = clean ?? templated;
  const out = lead + (result ?? text) + tail;
  cache.set(raw, out);
  return out;
}

/** Text as the player should read it in the current language. */
export function tr(text) {
  if (lang === 'zh' || typeof text !== 'string') return text;
  if (text === '「') return '“'; // quote marks written as their own text node, around an epitaph
  if (text === '」') return '”';
  if (!CJK.test(text)) return text;
  const out = finishEnglish(translate(text));
  if (CJK.test(out)) misses.add(text);
  if (out === text) return text;
  const tidy = polishEnglish(PUNCT.reduce((s, [re, to]) => s.replace(re, to), out));
  return /[\s，：]$/.test(text) ? tidy : tidy.trimEnd(); // a clause ending in a comma runs on into the next piece
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
