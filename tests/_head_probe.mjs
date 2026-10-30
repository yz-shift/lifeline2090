import { readFileSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
const w = createWorld(data, 5);
for (const [iso, y] of [['IDN', 2005], ['COL', 2015], ['CHN', 2008], ['USA', 2020], ['IND', 2026], ['NGA', 2040]]) console.log(iso, y, w.headlines(y, iso, 4).map((e) => e.year + ' ' + e.title).join(' | '));
