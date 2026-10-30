// How many Chinese lives sit the 高考 and what they score: node tests/_gaokao_probe.mjs [n]
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const N = Number(process.argv[2] || 300);
let sat = 0, scored = 0, uni = 0, uniSat = 0; const pts = []; let line = null;
for (let i = 0; i < N; i++) {
  const seed = 5000 + i;
  const world = createWorld(data, seed * 7 + 3);
  const spec = randomBirth(data, world, new Rng(seed), { year: 2000 }); spec.country = 'CHN';
  const r = simulateLife(data, world, spec, seed); const st = r.state || r;
  const gk = (st.person.education.exams || []).filter((x) => x.name === '高考');
  const isUni = ['tertiary', 'postgrad'].includes(st.person.education.level);
  if (isUni) uni++;
  if (gk.length) { sat++; if (isUni) uniSat++; }
  for (const g of gk) if (typeof g.score === 'number') { scored++; pts.push(g.score); }
  if (!line) line = (st.log || st.entries || []).find((e) => /高考成绩出来了/.test(e.text || ''));
}
pts.sort((a, b) => a - b);
const q = (p) => pts[Math.floor(p * (pts.length - 1))];
console.log({ N, sat, scored, uni, uniSat, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: pts[pts.length - 1] });
console.log(line && line.text);
