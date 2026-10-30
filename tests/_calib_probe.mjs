// Measures the mean raw personal mortality multiplier among the living, by age, to fill death.js R_VALS.
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear } from '../src/core/engine.js';
import { autoResolve, HEADLESS_SETTINGS } from '../src/core/cohort.js';
import { hazardFor } from '../src/core/death.js';
import { Rng } from '../src/core/rng.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const N = Number(process.argv[2] || 120);
const ISOS = ['CHN', 'IND', 'USA', 'NGA', 'DEU', 'BRA', 'JPN', 'ETH'];
const AGES = [0, 5, 15, 30, 45, 60, 70, 80, 90, 100];
const bin = (a) => { let k = 0; for (let i = 0; i < AGES.length; i++) if (a >= AGES[i] - 2) k = i; return k; };
const sumP = new Array(AGES.length).fill(0), sumLogP = new Array(AGES.length).fill(0), sumW = new Array(AGES.length).fill(0), cnt = new Array(AGES.length).fill(0);
const wByYear = {};
for (const iso of ISOS) {
  for (let i = 0; i < N; i++) {
    const seed = 5000 + i;
    const world = createWorld(data, seed * 13 + 1);
    const spec = randomBirth(data, world, new Rng(seed), { year: 2000 });
    spec.country = iso;
    const state = newLife(data, world, spec, { ...HEADLESS_SETTINGS }, seed);
    let guard = 0;
    while (!state.dead && guard++ < 400) {
      if (state.pending) { autoResolve(data, world, state); continue; }
      const h = hazardFor(data, world, state);
      const k = bin(state.age);
      // weight by base hazard so the mean is the effective multiplier on deaths
      sumP[k] += h.parts.personal; cnt[k]++; sumW[k] += h.parts.world;
      const dec = Math.floor(state.year / 10) * 10;
      (wByYear[dec] ||= [0, 0]); wByYear[dec][0] += h.parts.world * h.parts.mods; wByYear[dec][1]++;
      stepYear(data, world, state);
    }
  }
}
console.log('age  meanPersonal  meanWorld  n');
for (let k = 0; k < AGES.length; k++) console.log(AGES[k], (sumP[k] / cnt[k]).toFixed(3), (sumW[k] / cnt[k]).toFixed(3), cnt[k]);
console.log('R_VALS =', JSON.stringify(sumP.map((s, k) => +(s / Math.max(1, cnt[k])).toFixed(3))));
console.log('world*mods by decade', Object.fromEntries(Object.entries(wByYear).map(([d, [s, n]]) => [d, +(s / n).toFixed(3)])));
