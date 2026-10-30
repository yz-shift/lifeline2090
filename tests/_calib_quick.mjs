// Calibration quick check, same lives as tests/sim.test.mjs: node tests/_calib_quick.mjs CHN,USA [n]
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const N = Number(process.argv[3] || 400);
for (const iso of (process.argv[2] || 'CHN').split(',')) {
  let sum = 0, males = 0;
  for (let i = 0; i < N; i++) {
    const seed = 1000 + i;
    const world = createWorld(data, seed * 7 + 3);
    const spec = randomBirth(data, world, new Rng(seed), { year: 2000 }); spec.country = iso;
    const r = simulateLife(data, world, spec, seed); const st = r.state || r;
    sum += st.dead.age; if (st.person.sex === 'male') males++;
  }
  const target = (data.cohortLifeExpectancy(iso, 2000, 'male') * males + data.cohortLifeExpectancy(iso, 2000, 'female') * (N - males)) / N;
  console.log(iso, (sum / N).toFixed(2), 'target', target.toFixed(2), 'diff', (sum / N - target).toFixed(2));
}
