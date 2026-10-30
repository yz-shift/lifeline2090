// Tests for the achievement cards: core/achievements.js (pure checks) and social/collection.js (local collection).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new FakeStorage();

const A = await import('../src/core/achievements.js');
const col = await import('../src/social/collection.js');
const saves = await import('../src/social/saves.js');
const { makeDataStore } = await import('../src/core/data.js');
const { createWorld } = await import('../src/core/world.js');
const { randomBirth } = await import('../src/core/person.js');
const { simulateLife } = await import('../src/core/cohort.js');
const { Rng } = await import('../src/core/rng.js');

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const lives = [];
for (let i = 0; i < 24; i++) {
  const world = createWorld(data, 900 + i);
  const spec = randomBirth(data, world, new Rng(700 + i), { yearMode: i % 3 ? '2000' : 'any' });
  if (i % 4 === 0) spec.country = 'CHN';
  const r = simulateLife(data, world, spec, 700 + i);
  lives.push(r.state || r);
}
const regionOf = (iso) => (data.country(iso) || {}).region || null;

test('catalog: unique ids, known categories and tiers, every card has text', () => {
  const ids = new Set();
  for (const a of A.ACHIEVEMENTS) {
    assert.ok(!ids.has(a.id), `duplicate ${a.id}`);
    ids.add(a.id);
    assert.ok(a.cat in A.CATEGORIES, a.id);
    assert.ok(a.tier in A.TIERS, a.id);
    assert.ok(a.title && a.desc && a.icon, a.id);
    assert.equal(typeof a.test, 'function');
  }
  assert.ok(A.ACHIEVEMENTS.length >= 80);
});

test('measured tiers follow the rates', () => {
  for (const a of A.ACHIEVEMENTS) {
    if (typeof a.rate === 'number' && a.cat !== 'player' && a.cat !== 'meta') assert.equal(a.tier, A.tierFor(a.rate), a.id);
  }
});

test('evaluateLife: works on simulated lives and on junk', () => {
  let total = 0;
  for (const st of lives) {
    const got = A.evaluateLife(st);
    for (const id of got) assert.ok(A.achievementDef(id), id);
    total += got.length;
  }
  assert.ok(total / lives.length >= 5, `too few cards per life: ${total / lives.length}`);
  assert.deepEqual(A.evaluateLife(null), []);
  assert.deepEqual(A.evaluateLife({ dead: { age: 'x' }, person: { flags: null }, history: 'no' }).filter((id) => !['millennium'].includes(id)).length >= 0, true);
});

test('player cards need the player: notes, naming, custom choices', () => {
  const st = structuredClone(lives[0]);
  const before = A.evaluateLife(st);
  assert.ok(!before.includes('last_words') && !before.includes('my_way'));
  st.notes = [{ year: 2050, age: 50, kind: 'final', text: '谢谢你' }];
  st.decisions = [...st.decisions, ...[1, 2, 3].map((k) => ({ id: 'c' + k, year: 2010 + k, age: 10 + k, title: '主动选择', choice: '去学画画', custom: true, source: 'local' }))];
  const after = A.evaluateLife(st);
  assert.ok(after.includes('last_words') && after.includes('my_way'));
});

test('recordLife counts a life once and collects its cards', () => {
  localStorage.clear();
  const st = lives.find((x) => x.dead);
  const r1 = col.recordLife(st, { regionOf, now: '2026-10-27T00:00:00Z' });
  assert.ok(r1.fresh.includes('first_life'));
  assert.ok(r1.fresh.length >= r1.earned.length);
  const c1 = col.readCollection();
  assert.equal(c1.lives, 1);
  assert.equal(c1.countries.length, 1);
  const r2 = col.recordLife(st, { regionOf });
  assert.deepEqual(r2.fresh, []);
  assert.equal(col.readCollection().lives, 1);
  // a final sentence written afterwards still earns its card, without counting the life again
  const st2 = structuredClone(st);
  st2.notes = [{ kind: 'final', text: '再见' }];
  const r3 = col.recordLife(st2, { regionOf });
  assert.deepEqual(r3.fresh, ['last_words']);
  assert.equal(col.readCollection().lives, 1);
  for (const x of lives.filter((l) => l.dead)) col.recordLife(x, { regionOf });
  const c2 = col.readCollection();
  assert.equal(c2.lives, lives.filter((l) => l.dead).length);
  assert.ok(c2.cards.lives10, 'ten lives card');
  assert.ok(Object.values(c2.cards).every((c) => c.n >= 1 && c.life));
});

test('collection survives junk storage and travels with the backup file', () => {
  localStorage.setItem('ll2090.lifetime', '{"cards":{"nope":{"n":3},"long90":{"n":"x","at":"bad","life":{"name":5}}},"lives":-4,"countries":["CHN","x"]}');
  const c = col.readCollection();
  assert.deepEqual(Object.keys(c.cards), ['long90']);
  assert.equal(c.lives, 0);
  assert.deepEqual(c.countries, ['CHN']);

  localStorage.clear();
  for (const x of lives.filter((l) => l.dead).slice(0, 5)) { col.recordLife(x, { regionOf }); saves.addPastLife(x, { data }); }
  const backup = saves.exportLives();
  const had = Object.keys(col.readCollection().cards).length;
  assert.ok(JSON.parse(backup).collection.cards.first_life);
  localStorage.clear();
  const res = saves.importLives(backup);
  assert.equal(res.cards, had);
  assert.equal(Object.keys(col.readCollection().cards).length, had);
  assert.equal(col.readCollection().lives, 5);
  // importing the same file again adds nothing new
  assert.equal(saves.importLives(backup).cards ?? 0, 0);
});

test('meta cards: regions and sexes', () => {
  assert.deepEqual(A.evaluateMeta({ lives: 0 }), []);
  const ids = A.evaluateMeta({ lives: 100, sexes: ['male', 'female'], countries: Array.from({ length: 20 }, (_, i) => 'A' + String(i).padStart(2, '0')), regions: Array(12).fill(0).map((_, i) => 'R' + i), cardCount: 60 });
  for (const k of ['first_life', 'lives10', 'lives50', 'lives100', 'both_sexes', 'countries5', 'countries20', 'all_regions', 'collector', 'collector60']) assert.ok(ids.includes(k), k);
});
