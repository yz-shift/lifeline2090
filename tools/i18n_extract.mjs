// Collect every Chinese string the game can show into i18n/source.json: { area: [zh, ...] }.
// Code is scanned with a small tokenizer (comments and regex literals are skipped, so the Chinese lexicons in
// classifyIntent stay out). `${expr}` becomes {0}, {1}... and literals nested inside expr are collected on their own.
// Usage: node tools/i18n_extract.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
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

function walkData(o, add, key = '') {
  if (typeof o === 'string') { if (CJK.test(o) && !SKIP_FIELDS.has(key)) add(o, key); return; }
  if (Array.isArray(o)) { for (const v of o) walkData(v, add, key); return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walkData(v, add, /^[A-Z]{2,3}$/.test(k) ? key : k);
}

const areas = {};
const seen = new Set();
const put = (area, s) => {
  const t = s.trim();
  if (!t || !CJK.test(t) || seen.has(t)) return;
  seen.add(t);
  (areas[area] ||= []).push(t);
};

for (const p of walkDir(join(root, 'src')).filter((f) => f.endsWith('.js'))) {
  const rel = relative(root, p).split('\\').join('/');
  if (SKIP_FILES.has(rel)) continue;
  const area = rel.startsWith('src/core/') ? 'core_' + rel.split('/').pop().replace('.js', '') : 'ui';
  for (const s of scanJs(readFileSync(p, 'utf8'))) put(area, s);
}
const content = JSON.parse(readFileSync(join(root, 'data/content.json'), 'utf8'));
const NAME_KEYS = new Set(['surnames', 'surnames_female', 'male', 'female']);
walkData(content.names, (s, k) => put(NAME_KEYS.has(k) ? 'names' : 'data_misc', s));
walkData(content.history, (s) => put('history', s));
walkData(content.future, (s) => put('future', s));
walkData(content.lifePaths, (s) => put('lifepaths', s));
walkData(content.econ, (s) => put('data_misc', s));
walkData(JSON.parse(readFileSync(join(root, 'data/countries.json'), 'utf8')).countries, (s, k) => { if (k === 'name') put('countries', s); });
walkData(JSON.parse(readFileSync(join(root, 'web_seed/seed.json'), 'utf8')), (s) => put('seed', s));

writeFileSync(join(root, 'i18n/source.json'), JSON.stringify(areas, null, 1) + '\n');
const zh = (a) => a.reduce((n, s) => n + (s.match(/[\u4e00-\u9fff]/g) || []).length, 0);
for (const [a, v] of Object.entries(areas)) console.log(a.padEnd(22), String(v.length).padStart(6), String(zh(v)).padStart(8));
console.log('TOTAL'.padEnd(22), String(seen.size).padStart(6), String(zh([...seen])).padStart(8));
