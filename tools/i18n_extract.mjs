// Collect every Chinese string the game can show into i18n/source.json: { area: [zh, ...] }.
// Code is scanned with a small tokenizer (comments and regex literals are skipped, so the Chinese lexicons in
// classifyIntent stay out). `${expr}` becomes {0}, {1}... and literals nested inside expr are collected on their own.
// Usage: node tools/i18n_extract.mjs
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CJK = /[\u4e00-\u9fff]/;
// Prompts are only read by the AI, never by the player.
const SKIP_FILES = new Set(['src/ai/prompts.js']);
// Content fields the player never sees: citations, modelling notes and AI-only context.
const SKIP_FIELDS = new Set(['sources', 'source', 'basis', 'destinations_basis', 'statement', 'era_note', 'measure', 'fields', 'generated', 'notes', 'note', 'description']);

/** Literal strings in JS source, normalised to text with {n} placeholders. */
export function scanJs(code) {
  const out = [];
  let i = 0, prev = '';
  const BACKSLASH = String.fromCharCode(92);
  const regexAllowed = () => prev === '' || /[(,=:\[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of|delete|void)$/.test(prev);
  function unescape1() {
    const c = code[i + 1];
    i += 2;
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'u') { const hex = code.slice(i, i + 4); i += 4; return String.fromCharCode(parseInt(hex, 16)); }
    return c;
  }
  function quoted() {
    const q = code[i++];
    let text = '';
    while (i < code.length && code[i] !== q) text += code[i] === BACKSLASH ? unescape1() : code[i++];
    i++;
    if (CJK.test(text)) out.push(text);
  }
  function skipRegex() {
    i++;
    let cls = false;
    while (i < code.length && (code[i] !== '/' || cls)) {
      if (code[i] === BACKSLASH) i++;
      else if (code[i] === '[') cls = true;
      else if (code[i] === ']') cls = false;
      i++;
    }
    i++;
  }
  function template() {
    i++; // opening backtick
    let text = '', n = 0;
    while (i < code.length && code[i] !== '`') {
      if (code[i] === BACKSLASH) { text += unescape1(); continue; }
      if (code[i] === '$' && code[i + 1] === '{') {
        const start = i + 2;
        i = start;
        let depth = 1;
        while (i < code.length && depth) {
          const c = code[i];
          if (c === '{') { depth++; i++; } else if (c === '}') { depth--; i++; }
          else if (c === '`') template();
          else if (c === '"' || c === "'") quoted();
          else if (c === '/' && /[(,=:]\s*$/.test(code.slice(Math.max(start, i - 4), i))) skipRegex();
          else i++;
        }
        text += `{${n++}}`;
        continue;
      }
      text += code[i++];
    }
    i++;
    if (CJK.test(text)) out.push(text);
  }
  while (i < code.length) {
    const c = code[i];
    // kw: [...] lists are what free-text input is matched against; the player never reads them.
    if (c === '[' && /(^|[^\w])kw:$/.test(prev)) {
      while (i < code.length && code[i] !== ']') {
        if (code[i] === "'" || code[i] === '"') { const q = code[i++]; while (code[i] !== q) i += code[i] === BACKSLASH ? 2 : 1; }
        i++;
      }
      prev = 'x';
      continue;
    }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue; }
    if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i) + 2; continue; }
    if (c === '/' && regexAllowed()) { skipRegex(); prev = '/x'; continue; }
    if (c === '`') { template(); prev = 'x'; continue; }
    if (c === '"' || c === "'") { quoted(); prev = 'x'; continue; }
    if (!/\s/.test(c)) prev = (prev + c).slice(-8);
    i++;
  }
  return out;
}

function walkDir(d) {
  return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walkDir(p) : [p]; });
}

function walkData(o, add, key = '', skip = SKIP_FIELDS) {
  if (typeof o === 'string') { if (CJK.test(o) && !skip.has(key)) add(o, key); return; }
  if (Array.isArray(o)) { for (const v of o) walkData(v, add, key, skip); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walkData(v, add, /^[A-Z]{2,3}$/.test(k) ? key : k, skip);
}

const areas = {};
const seen = new Set();
const NAME_TABLE = /^[^|,]+\|[A-Za-z]/; // "王|Wang,李|Li": romanised names, taken from person.js below
const CURRENCY_ROW = /^[A-Z,]+:[A-Z]{3}:([^:]+):/; // "CHN:CNY:人民币:¥": only the name is shown
const put = (area, s) => {
  const t = s.trim();
  const currency = CURRENCY_ROW.exec(t);
  if (currency) { put(area, currency[1]); return; }
  if (!t || !CJK.test(t) || seen.has(t) || NAME_TABLE.test(t) || /^https?:/.test(t) || /^\{0\} ?(万亿|亿|万)$/.test(t)) return; // number units are converted by finishEnglish
  seen.add(t);
  (areas[area] ||= []).push(t);
};

for (const p of walkDir(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  const rel = relative(root, p).split('\\').join('/');
  if (SKIP_FILES.has(rel)) continue;
  const area = rel.startsWith('src/core/') ? 'core_' + rel.split('/').pop().replace('.js', '') : 'ui';
  // Lookup tables that only match what the player types, never shown.
  const code = readFileSync(p, 'utf8').replace(/const EXTRA_KW = \{[\s\S]*?\n\};/, '').replace(/const CN_PLACES = [\s\S]*?\.split\(' '\);/, '');
  for (const s of scanJs(code)) if (s !== '撑不下去' && s !== '当') put(area, s);
}
const content = JSON.parse(readFileSync(join(root, 'data/content.json'), 'utf8'));

// Names already carry their romanisation, so they need no translating. @s:/@g: mark surnames and given names, which
// lets tr() read a joined name such as 王浩然, or a child's name that mixes two countries.
const nameEntries = {};
const addName = (zh, en, tag) => {
  if (!zh || !en) return;
  nameEntries[zh] ??= en;
  if (tag) nameEntries[`@${tag}:${zh}`] ??= en;
};
const pairs = (s) => s.split(',').map((x) => x.split('|'));
const personJs = readFileSync(join(root, 'src/core/person.js'), 'utf8');
for (const m of personJs.matchAll(/\w+: \{ fmt: '(sg|gs)', sur: P\('([^']+)'\)[\s\S]*?male: P\('([^']+)'\),?\s*female: P\('([^']+)'\)/g)) {
  for (const [zh, en] of pairs(m[2])) addName(zh, en, 's');
  for (const [zh, en] of [...pairs(m[3]), ...pairs(m[4])]) addName(zh, en, 'g');
}
for (const m of personJs.matchAll(/surF: P\('([^']+)'\)/g)) for (const [zh, en] of pairs(m[1])) addName(zh, en, '');
const countryNames = Object.entries(content.names.countries);
countryNames.sort(([a], [b]) => (a === 'CHN' ? -1 : b === 'CHN' ? 1 : 0));
for (const [, c] of countryNames) {
  for (const [key, tag] of [['surnames', 's'], ['surnames_female', 's'], ['male', 'g'], ['female', 'g']]) {
    (c[key] || []).forEach((zh, i) => addName(zh, c.latin?.[key]?.[i], tag));
  }
}
const COMPOUND = { 欧阳: 'Ouyang', 司马: 'Sima', 上官: 'Shangguan', 诸葛: 'Zhuge', 东方: 'Dongfang', 皇甫: 'Huangfu', 尉迟: 'Yuchi', 公孙: 'Gongsun', 慕容: 'Murong', 长孙: 'Zhangsun', 宇文: 'Yuwen', 司徒: 'Situ', 夏侯: 'Xiahou', 令狐: 'Linghu', 端木: 'Duanmu', 南宫: 'Nangong' };
for (const [zh, en] of Object.entries(COMPOUND)) { nameEntries[`@s:${zh}`] = en; seen.add(zh); }
mkdirSync(join(root, 'i18n/en'), { recursive: true });
// "0_" sorts first, so a real translation of the same text wins over a name when the catalog is built.
writeFileSync(join(root, 'i18n/en/0_names.json'), JSON.stringify(nameEntries, null, 0).replace(/","/g, '",\n"') + '\n');

walkData(content.history, (s) => put('history', s));
walkData(content.future, (s) => put('future', s), '', new Set(['sources', 'source', 'fields', 'generated']));
walkData(content.lifePaths, (s) => put('lifepaths', s));
// the one note per country shown on the birth card as local background (person.js)
for (const c of Object.values(content.lifePaths.countries)) {
  const n = (Array.isArray(c.notes) ? c.notes : []).find((x) => typeof x === 'string' && x.trim() && x.length <= 90);
  if (n) put('lifepaths', n);
}
walkData(content.econ, (s) => put('data_misc', s));
walkData(JSON.parse(readFileSync(join(root, 'data/countries.json'), 'utf8')).countries, (s, k) => { if (k === 'name') put('countries', s); });
walkData(JSON.parse(readFileSync(join(root, 'web_seed/seed.json'), 'utf8')), (s) => put('seed', s));

// A short string that is also a generated name already has its English.
for (const a of Object.keys(areas)) if (a !== 'ui') areas[a] = areas[a].filter((s) => !(s in nameEntries));
writeFileSync(join(root, 'i18n/source.json'), JSON.stringify(areas, null, 1) + '\n');
const zh = (a) => a.reduce((n, s) => n + (s.match(/[\u4e00-\u9fff]/g) || []).length, 0);
for (const [a, v] of Object.entries(areas)) console.log(a.padEnd(22), String(v.length).padStart(6), String(zh(v)).padStart(8));
console.log('TOTAL'.padEnd(22), String(seen.size).padStart(6), String(zh([...seen])).padStart(8));
