// Generate example shared lives (simulated by this engine) for the 大家的人生 feed.
// Writes tools/out/seed_lives.json as an ArtifactData batch: [{op:'set', collection:'lives', doc_id, data}].
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { makeDataStore } from '../src/core/data.js';
import { createWorld } from '../src/core/world.js';
import { customBirth } from '../src/core/person.js';
import { lifeSummary } from '../src/core/engine.js';
import { simulateLife } from '../src/core/cohort.js';
import { templateBiography } from '../src/ai/director.js';
import { setDataSource, buildShareRecord } from '../src/social/store.js';
import { Rng } from '../src/core/rng.js';

const rd = (f) => JSON.parse(readFileSync(new URL('../data/' + f, import.meta.url), 'utf8'));
const data = makeDataStore({ countries: rd('countries.json'), mortality: rd('mortality.json'), content: rd('content.json') });
setDataSource(data);

// country, birth year: a spread of regions, incomes and eras
const PLAN = [
  ['CHN', 2000], ['IND', 2000], ['NGA', 2000], ['USA', 2000], ['BRA', 2000], ['IDN', 2000],
  ['PAK', 2003], ['DEU', 2001], ['JPN', 2002], ['MEX', 2004], ['ETH', 2005], ['PHL', 2006],
  ['EGY', 2008], ['VNM', 2010], ['UKR', 2010], ['FRA', 2012], ['BGD', 2014], ['KEN', 2015],
  ['CHN', 2018], ['IND', 2020], ['TUR', 2022], ['COD', 2024], ['KOR', 2026], ['NGA', 2035],
];
const docs = [];
let i = 0;
const usedEp = new Set();
for (const [iso, year] of PLAN) {
  // try a few seeds per slot so the feed is not dominated by infant deaths
  for (let k = 0; k < 12; k++) {
    const seed = 70000 + i * 97 + k;
    const world = createWorld(data, seed * 3 + 11);
    const spec = customBirth(data, world, new Rng(seed), { country: iso, year });
    const st = simulateLife(data, world, spec, seed);
    if (!st.dead || (st.dead.age < 5 && k < 11)) continue;
    const bio = templateBiography(st, data) || {};
    const rec = buildShareRecord({ ...st, createdAt: undefined });
    if (!rec) continue;
    const kids = (st.person.children || []).length;
    const moved = new Set(st.history.map((r) => r.country)).size > 1;
    const pool = [
      ...(kids >= 3 ? ['孩子们的笑声，是这一生最好听的声音。', '一桌人吃饭的热闹，比什么都好。'] : []),
      ...(kids === 0 ? ['一个人，也把日子过成了诗。', '没留下孩子，留下了很多朋友。'] : []),
      ...(moved ? ['走过很远的路，也记得回家的路。', '在异乡扎了根，心里一直有故乡。'] : []),
      ...(st.dead.age >= 90 ? ['看过足够多的春天。', '慢慢走，也走了很远。'] : []),
      ...(st.dead.age < 60 ? ['来得匆忙，爱得认真。', '日子不长，每一天都算数。'] : []),
      '被很多人爱过，也认真爱过很多人。', '把日子一点一点经营好，也照顾好了身边的人。', '平凡，但从不敷衍。',
      '一生都在读书，也一生都在学着生活。', '对世界温柔，对自己诚实。', '晴天晒被子，雨天读闲书。',
      '认真吃饭，认真告别。', '留给后人一句话：别怕，慢慢来。', '心里有灯，脚下有路。', '最骄傲的事，是没有辜负谁。',
    ];
    let ep = pool.find((x) => !usedEp.has(x)) || bio.epitaph || '';
    usedEp.add(ep);
    rec.epitaph = ep;
    rec.bio = bio.bio || rec.bio || '';
    rec.seed = true;
    rec.authorId = null;
    // spread "shared" dates over the last two weeks so the feed reads naturally (clearly labelled as examples)
    rec.createdAt = new Date(Date.UTC(2026, 9, 12 + Math.floor(i / 2), 8 + (i % 12), 0, 0)).toISOString();
    const id = 'seed-' + String(i + 1).padStart(2, '0');
    rec.lifeId = id;
    docs.push({ op: 'set', collection: 'lives', doc_id: id, data: rec });
    break;
  }
  i++;
}
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
writeFileSync(new URL('./out/seed_lives.json', import.meta.url), JSON.stringify(docs, null, 1));
for (const d of docs) console.log(d.doc_id, d.data.name, d.data.countryName, d.data.birthYear + '–' + d.data.deathYear, d.data.age + '岁', d.data.cause, '|', (d.data.epitaph || '').slice(0, 24));
console.log('docs', docs.length, 'bytes', JSON.stringify(docs).length);
