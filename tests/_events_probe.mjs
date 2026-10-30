import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
for (const iso of ['COL', 'CHN', 'IND', 'DEU']) {
  const cat = {}, src = {}; let yrs = 0, tot = 0, neg = 0; const ids = {};
  for (let s = 1; s <= 40; s++) {
    const w = createWorld(data, s * 101);
    for (let y = 2027; y <= 2090; y++) {
      yrs++;
      const ev = w.events(iso, y);
      tot += ev.length;
      for (const e of ev) { cat[e.category] = (cat[e.category] || 0) + 1; src[e.source] = (src[e.source] || 0) + 1; ids[e.id] = (ids[e.id] || 0) + 1;
        const ef = e.effects || {}; if (Math.min(ef.economy || 0, ef.health || 0, ef.happiness || 0, ef.safety || 0) <= -2) neg++; }
    }
  }
  console.log(iso, 'events/yr', (tot / yrs).toFixed(2), 'severe(<=-2)/yr', (neg / yrs).toFixed(2), JSON.stringify(src), JSON.stringify(cat));
  console.log('   top ids', Object.entries(ids).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ':' + (v / 40).toFixed(1)).join(' '));
}
for (const iso of ['COL', 'CHN']) { let t = 0, n = 0; const w = createWorld(data, 7); for (let y = 2001; y <= 2025; y++) { t += w.events(iso, y).length; n++; } console.log(iso, 'history events/yr', (t / n).toFixed(2)); }
