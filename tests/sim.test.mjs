// Whole-life simulation tests: calibration against WPP cohort life expectancy, state sanity, determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { randomBirth } from '../src/core/person.js';
import { newLife, stepYear } from '../src/core/engine.js';
import { simulateLife, autoResolve, HEADLESS_SETTINGS } from '../src/core/cohort.js';
import { netWorth, medianIncome } from '../src/core/economy.js';
import { Rng } from '../src/core/rng.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });

function life(iso, seed, year = 2000) {
  const world = createWorld(data, seed * 7 + 3);
  const spec = randomBirth(data, world, new Rng(seed), { year });
  spec.country = iso;
  return { world, state: simulateLife(data, world, spec, seed) };
}

test('mean age at death tracks WPP cohort life expectancy (±2.5 years, 400 lives each)', () => {
  for (const iso of ['CHN', 'IND', 'USA', 'NGA', 'DEU', 'BRA', 'JPN', 'ETH']) {
    let sum = 0, males = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const { state } = life(iso, 1000 + i);
      assert.ok(state.dead, `${iso} life ${i} ended`);
      sum += state.dead.age;
      if (state.person.sex === 'male') males++;
    }
    const target = (data.cohortLifeExpectancy(iso, 2000, 'male') * males + data.cohortLifeExpectancy(iso, 2000, 'female') * (N - males)) / N;
    const mean = sum / N;
    assert.ok(Math.abs(mean - target) <= 2.5, `${iso}: simulated ${mean.toFixed(1)} vs cohort LE ${target.toFixed(1)}`);
  }
});

test('states stay sane: no NaN, stats in 0..100, readable text, bounded debt', () => {
  for (const iso of ['COL', 'PAK', 'UKR', 'PHL', 'EGY', 'MEX']) {
    for (let i = 0; i < 25; i++) {
      const { world, state } = life(iso, 7000 + i);
      const js = JSON.stringify(state);
      assert.ok(!/NaN|Infinity/.test(js), `${iso} ${i} has NaN/Infinity`);
      for (const row of state.history) for (const v of Object.values(row.stats)) assert.ok(v >= 0 && v <= 100);
      for (const e of state.log) assert.ok(!/undefined|\{[a-z]+\}/.test(e.text), `bad text: ${e.text.slice(0, 80)}`);
      const med = medianIncome(data, world, state.person.country, Math.min(state.year, 2090));
      assert.ok(netWorth(state.person.money) > -20 * med, `${iso} ${i} runaway debt`);
      const perYear = state.log.length / state.history.length;
      assert.ok(perYear >= 1.5 && perYear <= 7, `${iso} log entries per year ${perYear}`);
    }
  }
});

test('lives born in 2040 run past 2090 without errors', () => {
  for (const iso of ['IND', 'NGA', 'CHN']) {
    for (let i = 0; i < 15; i++) {
      const { state } = life(iso, 9000 + i, 2040);
      assert.ok(state.dead);
      assert.ok(state.history[0].year === 2040);
    }
  }
});

test('save and restore mid-life reproduces the same life exactly', () => {
  const world = createWorld(data, 4242);
  const spec = randomBirth(data, world, new Rng(77), { year: 2000 });
  const run = (restoreAt) => {
    let st = newLife(data, world, spec, { ...HEADLESS_SETTINGS }, 77);
    let g = 0;
    while (!st.dead && g++ < 400) {
      if (restoreAt && st.age === restoreAt && !st.pending) st = JSON.parse(JSON.stringify(st));
      if (st.pending) { autoResolve(data, world, st); continue; }
      stepYear(data, world, st);
    }
    return { age: st.dead.age, cause: st.dead.cause.id, log: st.log.length, money: Math.round(netWorth(st.person.money)) };
  };
  assert.deepEqual(run(0), run(30));
});
