import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear, applyResolution } from '../src/core/engine.js';
import { resolveOffline } from '../src/core/decisions.js';
import { HEADLESS_SETTINGS } from '../src/core/cohort.js';
import { netWorth, medianIncome } from '../src/core/economy.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
let worst = null, bad = 0, n = 0;
for (const iso of ['COL', 'CHN', 'USA', 'IND', 'BRA', 'NGA']) for (let i = 0; i < 40; i++) {
  const seed = 4000 + i, world = createWorld(data, seed);
  const spec = randomBirth(data, world, new Rng(seed), { year: 2000 }); spec.country = iso;
  const st = newLife(data, world, spec, { ...HEADLESS_SETTINGS }, seed);
  const trail = [];
  let g = 0;
  while (!st.dead && g++ < 400) {
    if (st.pending) {
      const d = st.pending, ch = { optionId: d.options[0].id };
      const res = resolveOffline(data, world, st, d, ch, new Rng(seed + g));
      applyResolution(data, world, st, d, ch, res);
      if (st.pending === d) st.pending = null;
      trail.push(`${st.year}:${d.title}->${d.options[0].label} wd=${Math.round(res.effects.wealthDelta || 0)}`);
      continue;
    }
    stepYear(data, world, st);
    const m = st.person.money; trail.push(`${st.year} a${st.age} cash=${Math.round(m.cash)} debt=${Math.round(m.debt)} inc=${Math.round(m.income)} st=${st.person.career.status}`);
  }
  n++;
  const med = medianIncome(data, world, st.person.country, Math.min(st.year, 2090));
  const ratio = netWorth(st.person.money) / med;
  if (ratio < -20) { bad++; if (!worst || ratio < worst.ratio) worst = { iso, ratio, trail }; }
}
console.log('lives', n, 'bad', bad);
if (worst) { console.log('worst', worst.iso, worst.ratio.toFixed(0)); const t = worst.trail; const i = t.findIndex((x) => /debt=([1-9]\d{6,})/.test(x)); console.log(t.slice(Math.max(0, i - 25), i + 8).join('\n')); }
