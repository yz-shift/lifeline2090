import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { netWorth, medianIncome } from '../src/core/economy.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const tags = {}; let crisisYears = 0, projYears = 0, bad = 0, n = 0; const titles = {};
for (const iso of ['COL', 'CHN', 'USA', 'IND', 'NGA', 'DEU']) {
  for (let i = 0; i < 60; i++) {
    const seed = 900 + i, world = createWorld(data, seed);
    const spec = randomBirth(data, world, new Rng(seed), { year: 2000 }); spec.country = iso;
    const st = simulateLife(data, world, spec, seed);
    n++;
    const nw = netWorth(st.person.money), med = medianIncome(data, world, st.person.country, Math.min(st.year, 2090));
    if (nw < -20 * med) { bad++; if (bad <= 5) console.log('NEG', iso, st.dead.age, 'nw/medInc', (nw / med).toFixed(1), JSON.stringify(st.person.money).slice(0, 300)); }
    for (const hrow of st.history) { tags[hrow.tag] = (tags[hrow.tag] || 0) + 1; if (hrow.year > 2026) { projYears++; if (hrow.tag === 'crisis') crisisYears++; } }
    for (const d of st.decisions) titles[d.title] = (titles[d.title] || 0) + 1;
  }
}
console.log('lives', n, 'net worth < -20x median income:', bad);
console.log('tags', tags, 'crisis share of projected years', (crisisYears / projYears).toFixed(2));
console.log('top decision titles', Object.entries(titles).sort((a, b) => b[1] - a[1]).slice(0, 15));
