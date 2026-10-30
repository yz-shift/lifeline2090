// Prints how a few free-text choices resolve offline: node tests/_intent_resolve.mjs
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear } from '../src/core/engine.js';
import { resolveOffline } from '../src/core/decisions.js';
import { Rng } from '../src/core/rng.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const world = createWorld(data, 11);
const spec = randomBirth(data, world, new Rng(5), {}); spec.country = 'CHN';
const st = newLife(data, world, spec, { autoChoose: true, aiMode: 'off' }, 5);
while (st.age < 24 && !st.dead) { stepYear(data, world, st); st.pending = null; }
const D = { id: 'offer', title: '外地的工作邀请', situation: '一家外地公司给你发来了邀请。', source: 'local', options: [
  { id: 'a', label: '接受外地的工作', detail: '', risk: 'mid' }, { id: 'b', label: '留在本地', detail: '', risk: 'low' }, { id: 'c', label: '先谈谈条件', detail: '', risk: 'mid' }],
  context: { key: 'offer', acts: { a: { act: 'accept_offer', p: {} }, b: { act: 'stay_course', p: {} }, c: { act: 'promotion_push', p: {} } }, labels: { a: '接受外地的工作', b: '留在本地', c: '先谈谈条件' } } };
for (const t of ['好', '算了，还是留下', '先跟他们谈谈工资', '辞职去大理开民宿', '去深圳找工作，顺便每天跑步', '我想换个活法', '嗯……', '变成一只鸟']) {
  const r = resolveOffline(data, world, st, D, { customText: t });
  console.log(`【${t}】 ${r.narrative}\n   ${JSON.stringify(r.effects)} ${r.note || ''}`);
}
