// English free text: keywords, negation, typed place names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { classifyIntent } from '../src/core/decisions.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const catalog = rd('i18n_en.json');
const inEnglish = Object.assign(Object.create(data), { nameAlias: (zh) => catalog[zh] ?? null });

const top = (text, d = data) => classifyIntent(text, d).intents[0];

test('common English phrasings reach the right intent', () => {
  assert.equal(top('I want to go to university'), 'study');
  assert.equal(top('start a business'), 'start_business');
  assert.equal(top('marry her'), 'marry');
  assert.equal(top('quit smoking'), 'quit_smoking');
  assert.equal(top('buy a house'), 'buy_home');
  assert.equal(top('see a therapist'), 'therapy');
});

test('English negation goes to the opposite intent', () => {
  const c = classifyIntent("don't move abroad", data);
  assert.notEqual(c.intents[0], 'emigrate');
  assert.ok(c.negated.includes('emigrate'));
});

test('crisis language in English is recognised', () => {
  assert.equal(top('I want to end my life'), 'crisis');
});

test('English place names resolve to the same country as Chinese ones', () => {
  assert.equal(classifyIntent('emigrate to Japan', inEnglish).targetCountry, 'JPN');
  assert.equal(classifyIntent('find a job in lagos', inEnglish).targetCity, '拉各斯');
  assert.equal(classifyIntent('normality', inEnglish).targetCountry, null);
});

test('Chinese input behaves as before', () => {
  assert.equal(top('我想去深圳找工作'), 'job_hunt');
  assert.equal(classifyIntent('移民去日本', data).targetCountry, 'JPN');
});
