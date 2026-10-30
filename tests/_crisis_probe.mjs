import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const heads = {}; const ent = {};
for (const iso of ['COL', 'CHN', 'USA', 'IND', 'DEU']) for (let i = 0; i < 40; i++) {
  const seed = 300 + i, world = createWorld(data, seed);
  const spec = randomBirth(data, world, new Rng(seed), { year: 2000 }); spec.country = iso;
  const st = simulateLife(data, world, spec, seed);
  for (const h of st.history) if (h.tag === 'crisis') heads[h.headline] = (heads[h.headline] || 0) + 1;
  for (const e of st.log) if ((e.tags || []).includes('crisis') && e.kind !== 'news') { const k = e.kind + ':' + e.text.slice(0, 18); ent[k] = (ent[k] || 0) + 1; }
}
console.log(Object.entries(heads).sort((a, b) => b[1] - a[1]).slice(0, 20));
console.log(Object.entries(ent).sort((a, b) => b[1] - a[1]).slice(0, 15));
