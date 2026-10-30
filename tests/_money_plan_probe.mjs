// Effect of a typed money plan at age 25 on the same lives: node tests/_money_plan_probe.mjs "定投美股" [n]
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear, applyResolution } from '../src/core/engine.js';
import { resolveOffline, autoChoose } from '../src/core/decisions.js';
import { netWorth } from '../src/core/economy.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const text = process.argv[2] || '定投美股';
const N = Number(process.argv[3] || 40);
function run(seed, typed) {
  const world = createWorld(data, seed * 3 + 1);
  const spec = randomBirth(data, world, new Rng(seed), {}); spec.country = 'CHN'; spec.urban = true;
  const st = newLife(data, world, spec, { autoChoose: true, aiMode: 'off' }, seed);
  const notes = [];
  while (!st.dead && st.age < 65) {
    const yr = stepYear(data, world, st);
    for (const e of (yr && yr.entries) || []) if (/股市|投资|副业/.test(e.headline || e.text || '') && st.age >= 25) notes.push(`${st.year}: ${e.text.slice(0, 60)}`);
    if (st.pending) {
      const d = st.pending;
      const ch = autoChoose(st, d, new Rng(seed + st.age));
      applyResolution(data, world, st, d, ch, resolveOffline(data, world, st, d, ch));
      st.pending = null;
    }
    if (typed && st.age === 25 && !st.dead) {
      const D = { id: 'mine', kind: 'custom', title: '主动选择', situation: '', options: [], source: 'local' };
      applyResolution(data, world, st, D, { customText: text }, resolveOffline(data, world, st, D, { customText: text }));
    }
  }
  return { pf: st.person.money.portfolio, cash: st.person.money.cash, debt: st.person.money.debt, home: !!st.person.flags.homeowner, worth: netWorth(st.person.money), dead: !!st.dead && st.age < 65, notes, side: st.person.flags.sideIncome || 0, inc: st.person.money.income };
}
const rows = [];
for (let i = 0; i < N; i++) rows.push([run(100 + i, false), run(100 + i, true)]);
const alive = rows.filter(([a, b]) => !a.dead && !b.dead);
const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
console.log(`「${text}」 lives alive at 65: ${alive.length}/${N}`);
console.log('median net worth at 65 without:', Math.round(med(alive.map((r) => r[0].worth))), ' with:', Math.round(med(alive.map((r) => r[1].worth))));
console.log('better off:', alive.filter(([a, b]) => b.worth > a.worth).length, ' worse off:', alive.filter(([a, b]) => b.worth < a.worth).length);
console.log('got side income:', rows.filter((r) => r[1].side > 0).length);
console.log('sample notes:', rows[0][1].notes.slice(0, 6));
for (const k of ['stocks', 'bonds', 'gold', 'property', 'crypto']) console.log(k.padEnd(9), Math.round(med(alive.map((r) => r[0].pf[k]))), Math.round(med(alive.map((r) => r[1].pf[k]))));
console.log('cash', Math.round(med(alive.map((r) => r[0].cash))), Math.round(med(alive.map((r) => r[1].cash))), 'debt', Math.round(med(alive.map((r) => r[0].debt))), Math.round(med(alive.map((r) => r[1].debt))));
console.log('homeowners', alive.filter((r) => r[0].home).length, alive.filter((r) => r[1].home).length);
