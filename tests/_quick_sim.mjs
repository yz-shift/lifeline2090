// Quick calibration probe: node tests/_quick_sim.mjs [n]
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { simulateLife } from '../src/core/cohort.js';
import { Rng } from '../src/core/rng.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const N = Number(process.argv[2] || 300);
const ISOS = (process.argv[3] || 'CHN,IND,USA,NGA,DEU,BRA,JPN,ETH').split(',');
let errors = 0;
const badText = [];
for (const iso of ISOS) {
  const t0 = performance.now();
  let sumAge = 0, n = 0, married = 0, tert = 0, entries = 0, years = 0, males = 0;
  for (let i = 0; i < N; i++) {
    const seed = 1000 + i;
    const world = createWorld(data, seed * 7 + 3);
    const rng = new Rng(seed);
    try {
      const spec = randomBirth(data, world, rng, { year: 2000 });
      spec.country = iso;
      const res = simulateLife(data, world, spec, seed);
      const st = res.state || res;
      if (!st.dead) { errors++; continue; }
      sumAge += st.dead.age; n++;
      if (st.person.sex === 'male') males++;
      if (st.history.some((h) => h.age <= 50) && (st.person.relationship.status !== 'single' || st.decisions.length >= 0) && st.log.some((e) => /结婚|婚礼|成婚/.test(e.text))) married++;
      if (['tertiary', 'postgrad'].includes(st.person.education.level)) tert++;
      entries += st.log.length; years += st.history.length;
      for (const e of st.log) if (/undefined|NaN|\{[a-z]+\}/.test(e.text) && badText.length < 8) badText.push(e.text.slice(0, 120));
      const js = JSON.stringify(st);
      if (/NaN|null,"health"/.test(js) && badText.length < 8) badText.push('NaN in state ' + iso);
    } catch (e) {
      errors++;
      if (errors < 4) console.error(iso, e.stack.split('\n').slice(0, 4).join(' | '));
    }
  }
  const ms = (performance.now() - t0) / N;
  const leM = data.cohortLifeExpectancy(iso, 2000, 'male'), leF = data.cohortLifeExpectancy(iso, 2000, 'female');
  const target = (leM * males + leF * (n - males)) / Math.max(1, n);
  console.log(iso, 'mean death age', (sumAge / n).toFixed(1), 'cohort LE', target.toFixed(1),
    'married~', (married / n).toFixed(2), 'tertiary', (tert / n).toFixed(2), 'log/yr', (entries / years).toFixed(2), 'ms/life', ms.toFixed(1));
}
console.log('errors', errors, 'badText', badText);
