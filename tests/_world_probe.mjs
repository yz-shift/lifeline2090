import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
let t = performance.now();
const worlds = [];
for (let s = 1; s <= 300; s++) worlds.push(createWorld(data, s * 7919));
console.log('createWorld ms each', ((performance.now() - t) / 300).toFixed(2));
for (const iso of ['CHN', 'NGA', 'USA', 'IND']) {
  const row = [];
  for (const y of [2030, 2050, 2070, 2090]) {
    let lg = 0, br = 0;
    for (const w of worlds) { lg += Math.log(w.mortalityMult(iso, y, 70)); const m = w.modifiers(iso, y); br += -0.09 * m.life_exp_add + Math.log(m.mortality_mult); }
    row.push(`${y}: all ${Math.exp(lg / worlds.length).toFixed(3)} branches ${Math.exp(br / worlds.length).toFixed(3)}`);
  }
  console.log(iso, row.join(' | '));
}
