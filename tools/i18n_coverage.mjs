// How much of a real English play-through is still Chinese? Simulates lives across many countries and birth years,
// runs every line a player would read through tr(), and lists what stays Chinese, most frequent first.
// History events are reported apart while that area is still being translated.
// Usage: node tools/i18n_coverage.mjs [lives per country] [--all]
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';
import { setCatalog, forceLang, tr } from '../src/i18n/index.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const content = rd('content.json');
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content });
setCatalog(rd('i18n_en.json'));
forceLang('en');

const CJK = /[一-鿿]/;
const N = Number(process.argv[2]) || 10;
const historyText = new Set();
const collect = (o) => {
  if (typeof o === 'string') historyText.add(o);
  else if (Array.isArray(o)) o.forEach(collect);
  else if (o && typeof o === 'object') Object.values(o).forEach(collect);
};
collect(content.history);

const ISOS = ['CHN', 'IND', 'USA', 'NGA', 'DEU', 'BRA', 'JPN', 'ETH', 'IDN', 'PAK', 'EGY', 'MEX', 'RUS', 'GBR', 'KOR', 'VNM', 'UKR', 'SDN', 'AUS', 'SAU', 'SYR', 'AFG'];
const YEARS = [2000, 2015, 2030, 2045];
const misses = new Map();
let lines = 0, chinese = 0, fromHistory = 0, unfilled = 0;
const unfilledSamples = new Set();

function read(text) {
  if (typeof text !== 'string' || !text.trim()) return;
  lines++;
  const out = tr(text);
  if (/\{[a-zA-Z]+\}|undefined|NaN/.test(out)) { unfilled++; if (unfilledSamples.size < 12) unfilledSamples.add(out.slice(0, 140)); }
  if (!CJK.test(out)) return;
  if (historyText.has(text) || [...out.matchAll(/[一-鿿][^.!?]*/g)].some((m) => historyText.has(m[0]))) { fromHistory++; return; }
  chinese++;
  misses.set(text, (misses.get(text) || 0) + 1);
}

let lives = 0, failed = 0;
for (const iso of ISOS) {
  for (const year of YEARS) {
    for (let i = 0; i < N; i++) {
      const seed = 5000 + i + year;
      try {
        const world = createWorld(data, seed * 7 + 3);
        const spec = randomBirth(data, world, new Rng(seed), { year });
        spec.country = iso;
        const res = simulateLife(data, world, spec, seed);
        const st = res.state || res;
        lives++;
        for (const e of st.log || []) { read(e.text); read(e.title); }
        for (const d of st.decisions || []) { read(d.title); read(d.situation); read(d.chosen); read(d.outcome); for (const o of d.options || []) { read(o.label); read(o.detail); } }
        read(st.person?.name);
        read(st.dead?.cause);
      } catch (e) {
        failed++;
        if (failed < 4) console.error(iso, year, e.message);
      }
    }
  }
}

console.log(`${lives} lives, ${failed} failed, ${lines} lines read`);
console.log(`Chinese left: ${chinese} lines from game text, ${fromHistory} from history events; ${unfilled} lines with an unfilled slot`);
if (unfilledSamples.size) console.log('unfilled:\n  ' + [...unfilledSamples].join('\n  '));
const top = [...misses.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${top.length} distinct misses:`);
for (const [text, n] of top.slice(0, process.argv.includes('--all') ? 1e9 : 60)) console.log(String(n).padStart(6), text.slice(0, 150).replace(/\n/g, ' '));
