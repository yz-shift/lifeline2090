// Measures how often each achievement card is earned by auto-played random lives: node tests/_ach_rates.mjs [n] [--write]
// 70% of births use the default year mode (2000), 30% any year, like the birth screen's options. --write stores the
// rates in the RATES block of src/core/achievements.js (tiers follow from them).
import { readFileSync, writeFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';
import { ACHIEVEMENTS, evaluateLife, tierFor } from '../src/core/achievements.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const N = Number(process.argv[2] || 1000);
const chn = process.argv.includes('CHN');
const doWrite = process.argv.includes('--write');
const count = {};
let n = 0, t0 = performance.now();
for (let i = 0; i < N; i++) {
  const seed = 50000 + i;
  const world = createWorld(data, seed * 13 + 1);
  const spec = randomBirth(data, world, new Rng(seed), { yearMode: i % 10 < 7 ? '2000' : 'any' });
  if (chn) spec.country = 'CHN';
  const res = simulateLife(data, world, spec, seed);
  const st = res.state || res;
  if (!st.dead) continue;
  n++;
  for (const id of evaluateLife(st)) count[id] = (count[id] || 0) + 1;
}
console.log('lives', n, 'ms/life', ((performance.now() - t0) / N).toFixed(0));
const rates = {};
for (const a of ACHIEVEMENTS.filter((x) => !['player', 'meta'].includes(x.cat))) {
  const r = (count[a.id] || 0) / n;
  rates[a.id] = Number(r.toFixed(4));
  console.log(a.id.padEnd(16), a.tier.padEnd(4), '->', tierFor(r).padEnd(4), (r * 100).toFixed(2) + '%');
}
if (doWrite && !chn) {
  const file = new URL('../src/core/achievements.js', import.meta.url);
  const src = readFileSync(file, 'utf8');
  const body = Object.entries(rates).map(([k, v]) => `  ${k}: ${v},`).join('\n');
  const out = src.replace(/(\/\/ RATES:BEGIN[^\n]*\n)[\s\S]*?(\/\/ RATES:END)/, `$1// ${n} simulated lives\nconst RATES = {\n${body}\n};\n$2`);
  writeFileSync(file, out);
  console.log('wrote RATES for', Object.keys(rates).length, 'cards');
}
