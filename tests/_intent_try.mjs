// Try free-text choices: node tests/_intent_try.mjs "text" "text" ...
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear } from '../src/core/engine.js';
import { resolveOffline, interpretCustom, interpretLine } from '../src/core/decisions.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const world = createWorld(data, 11);
const spec = randomBirth(data, world, new Rng(5), {}); spec.country = 'CHN';
const st = newLife(data, world, spec, { autoChoose: true, aiMode: 'off' }, 5);
while (st.age < 30 && !st.dead) { stepYear(data, world, st); st.pending = null; }
const D = { id: 'c', kind: 'custom', title: '主动选择', situation: '', options: [], source: 'local' };
for (const t of process.argv.slice(2)) {
  const it = interpretCustom(t, null, data, 'CHN');
  const r = resolveOffline(data, world, st, D, { customText: t });
  console.log(`【${t}】 ${interpretLine(it) || it.kind}\n   ${r.narrative}\n   ${JSON.stringify(r.effects)}`);
}
