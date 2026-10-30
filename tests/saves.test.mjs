// Tests for src/social/saves.js with an in-memory localStorage polyfill.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeStorage {
  constructor(quota = Infinity) { this.map = new Map(); this.quota = quota; }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    const value = String(v);
    let used = 0;
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length;
    if (used + k.length + value.length > this.quota) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.map.set(k, value);
  }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new FakeStorage();
const saves = await import('../src/social/saves.js');
const { STORAGE_KEYS, PAST_LIVES_MAX } = await import('../src/core/constants.js');

function reset(quota = Infinity) {
  globalThis.localStorage = new FakeStorage(quota);
}

/** A LifeState-shaped object; `logN` log entries of ~`textLen` characters. */
function makeState(i, { logN = 20, textLen = 40, dead = true, createdAt } = {}) {
  const birthYear = 2000 + (i % 20);
  const age = 60 + (i % 25);
  const history = Array.from({ length: age + 1 }, (_, a) => ({
    year: birthYear + a, age: a, stats: { health: 70, happiness: 60, knowledge: 50, relationships: 55, wealth: 40 },
    tag: a === 0 ? 'birth' : a < 6 ? 'childhood' : a < 22 ? 'study' : 'work', mood: 0, country: 'CHN', headline: `第${a}年`,
  }));
  const log = Array.from({ length: logN }, (_, k) => ({
    year: birthYear + Math.floor((k * age) / Math.max(1, logN)), age: Math.floor((k * age) / Math.max(1, logN)),
    kind: k === 0 ? 'birth' : 'event', text: `记录${k}：` + '岁月'.repeat(Math.ceil(textLen / 2)), tone: 0, tags: [], source: 'engine',
  }));
  return {
    v: 1, id: `life-${i}`, seed: i, rng: [1, 2, 3, 4], createdAt: createdAt || new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    mode: 'random', worldSeed: 7, worldLabel: '渐进普及的人工智能世界',
    settings: { lifeMinutes: 30, aiMode: 'off', decisionFreq: 'standard', autoChoose: false },
    birth: { mode: 'random', year: birthYear, date: `${birthYear}-03-04`, time: '08:00:00', country: 'CHN', sex: i % 2 ? 'male' : 'female', urban: true, familyPct: 0.5, parentsEdu: 'secondary', siblings: 1, motherAge: 27, fatherAge: 29, name: `测试${i}`, notes: [] },
    year: birthYear + age, age,
    person: { name: `测试${i}`, sex: i % 2 ? 'male' : 'female', country: 'CHN', urban: true, familyPct: 0.5, education: {}, career: {}, relationship: {}, children: [], parents: {}, siblings: 1, money: {}, conditions: [], flags: {} },
    stats: { health: 10, happiness: 70, knowledge: 80, relationships: 60, wealth: 45 },
    history,
    log,
    decisions: [{ id: 'd1', year: birthYear + 18, age: 18, title: '高考志愿', choice: '读师范', custom: false, source: 'local' }],
    threads: [], hazardMods: [], pending: null,
    dead: dead ? { year: birthYear + age, age, date: `${birthYear + age}-05-06`, cause: { id: 'cvd', name: '心血管疾病', detail: '' }, place: 'CHN', summary: '平静离世。', stats: { health: 5, happiness: 70, knowledge: 80, relationships: 60, wealth: 45 }, lifeExpAtBirth: 77.1, percentile: 0.4 } : null,
    cohort: [], aiNotes: { birthStory: null, lastSummary: null },
  };
}

test('autosave / loadCurrent / clearCurrent round trip', () => {
  reset();
  assert.equal(saves.loadCurrent(), null);
  const s = makeState(1, { dead: false });
  assert.equal(saves.autosave(s), true);
  const back = saves.loadCurrent();
  assert.deepEqual(back, s);
  saves.clearCurrent();
  assert.equal(saves.loadCurrent(), null);
});

test('loadCurrent rejects garbage', () => {
  reset();
  localStorage.setItem(STORAGE_KEYS.current, '{"hello":1}');
  assert.equal(saves.loadCurrent(), null);
  localStorage.setItem(STORAGE_KEYS.current, 'not json');
  assert.equal(saves.loadCurrent(), null);
});

test('autosave trims the oldest log entries above the budget but keeps every history row', () => {
  reset();
  const s = makeState(2, { logN: 4000, textLen: 600, dead: false });
  const fullLen = JSON.stringify(s).length;
  assert.ok(fullLen > saves.SAVE_LIMITS.current, `fixture should exceed the budget (${fullLen})`);
  assert.equal(saves.autosave(s), true);
  const raw = localStorage.getItem(STORAGE_KEYS.current);
  assert.ok(raw.length <= saves.SAVE_LIMITS.current, `saved ${raw.length} chars`);
  const back = saves.loadCurrent();
  assert.equal(back.history.length, s.history.length);
  assert.deepEqual(back.history, s.history);
  assert.ok(back.log.length < s.log.length);
  assert.equal(back.log[0].kind, 'birth');
  assert.equal(back.log[1].kind, 'system');
  assert.ok(back.log[1].tags.includes('trimmed'));
  // the newest entries survive in order
  assert.deepEqual(back.log.at(-1), s.log.at(-1));
  assert.deepEqual(back.log.at(-2), s.log.at(-2));
  // the in-memory state is untouched
  assert.equal(s.log.length, 4000);
});

test('fitState leaves small states alone', () => {
  const s = makeState(3);
  const r = saves.fitState(s, 1e9);
  assert.equal(r.state, s);
  assert.equal(r.trimmed, 0);
});

test('addPastLife builds the record and pastLives lists newest first, capped', () => {
  reset();
  const rec = saves.addPastLife(makeState(0), { epitaph: '她爱过这个世界', title: '海边的教师', bio: '一生平凡。', countryName: '中国', savedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(rec);
  assert.ok(Date.parse(saves.addPastLife(makeState(99), {}).savedAt) > 0, 'savedAt defaults to now');
  saves.deletePastLife('life-99');
  for (const k of ['id', 'savedAt', 'name', 'country', 'countryName', 'birthYear', 'deathYear', 'age', 'cause', 'epitaph', 'title', 'bio', 'highlights', 'history', 'decisions', 'stats', 'worldLabel', 'state']) {
    assert.ok(k in rec, `missing ${k}`);
  }
  assert.equal(rec.name, '测试0');
  assert.equal(rec.countryName, '中国');
  assert.equal(rec.cause, '心血管疾病');
  assert.equal(rec.epitaph, '她爱过这个世界');
  assert.equal(rec.state.history.length, rec.history.length, 'state is hydrated with history');
  assert.ok(!('pending' in rec.state));
  assert.ok(rec.highlights.length >= 1, 'highlights derived from decisions');

  // stored form does not duplicate the history inside state
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.past));
  assert.ok(!('history' in stored[0].state));

  for (let i = 1; i <= 12; i++) {
    saves.addPastLife(makeState(i), { savedAt: new Date(Date.UTC(2026, 1, i)).toISOString(), countryName: '中国' });
  }
  const list = saves.pastLives();
  assert.equal(list.length, PAST_LIVES_MAX);
  assert.equal(list[0].id, 'life-12');
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].savedAt >= list[i].savedAt);
});

test('re-adding the same life replaces it instead of duplicating', () => {
  reset();
  saves.addPastLife(makeState(5), { epitaph: '旧', savedAt: '2026-01-01T00:00:00.000Z' });
  saves.addPastLife(makeState(5), { epitaph: '新', savedAt: '2026-02-01T00:00:00.000Z' });
  const list = saves.pastLives();
  assert.equal(list.length, 1);
  assert.equal(list[0].epitaph, '新');
});

test('deletePastLife and updatePastLife', () => {
  reset();
  saves.addPastLife(makeState(1), { savedAt: '2026-01-01T00:00:00.000Z' });
  saves.addPastLife(makeState(2), { savedAt: '2026-01-02T00:00:00.000Z' });
  const upd = saves.updatePastLife('life-1', { sharedId: 'life-1', name: 'ignored' });
  assert.equal(upd.sharedId, 'life-1');
  assert.equal(upd.name, '测试1');
  assert.equal(saves.deletePastLife('life-1'), true);
  assert.equal(saves.deletePastLife('nope'), false);
  assert.deepEqual(saves.pastLives().map((r) => r.id), ['life-2']);
  assert.equal(saves.deletePastLife('life-2'), true);
  assert.deepEqual(saves.pastLives(), []);
});

test('export / import round trip', () => {
  reset();
  for (let i = 0; i < 4; i++) saves.addPastLife(makeState(i), { savedAt: new Date(Date.UTC(2026, 2, i + 1)).toISOString(), epitaph: `墓志铭${i}` });
  const before = saves.pastLives();
  const json = saves.exportLives();
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, 'lifeline2090');
  assert.equal(parsed.v, 1);
  assert.equal(parsed.lives.length, 4);

  reset();
  const res = saves.importLives(json);
  assert.deepEqual(res, { added: 4, skipped: 0 });
  const after = saves.pastLives();
  assert.equal(after.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(after[i].id, before[i].id);
    assert.equal(after[i].name, before[i].name);
    assert.equal(after[i].epitaph, before[i].epitaph);
    assert.equal(after[i].birthYear, before[i].birthYear);
    assert.deepEqual(after[i].history, before[i].history);
    assert.deepEqual(after[i].decisions, before[i].decisions);
    assert.equal(after[i].state.log.length, before[i].state.log.length);
    assert.equal(after[i].state.history.length, before[i].history.length);
  }
});

test('import dedupes by id and reports skipped records', () => {
  reset();
  saves.addPastLife(makeState(1), { savedAt: '2026-03-01T00:00:00.000Z' });
  const json = saves.exportLives();
  assert.deepEqual(saves.importLives(json), { added: 0, skipped: 1 });

  // duplicates inside one file count once
  reset();
  const rec = JSON.parse(json).lives[0];
  const res = saves.importLives(JSON.stringify({ format: 'lifeline2090', v: 1, lives: [rec, rec, { nonsense: true }, null] }));
  assert.deepEqual(res, { added: 1, skipped: 3 });
  assert.equal(saves.pastLives().length, 1);
});

test('import accepts a bare array or a single record and rejects bad input', () => {
  reset();
  saves.addPastLife(makeState(1), { savedAt: '2026-03-01T00:00:00.000Z' });
  const rec = JSON.parse(saves.exportLives()).lives[0];
  reset();
  assert.deepEqual(saves.importLives(JSON.stringify([rec])), { added: 1, skipped: 0 });
  reset();
  assert.deepEqual(saves.importLives('﻿' + JSON.stringify(rec)), { added: 1, skipped: 0 });

  reset();
  const bad = saves.importLives('{oops');
  assert.equal(bad.added, 0);
  assert.ok(bad.error);
  const none = saves.importLives('{"hello":"world"}');
  assert.equal(none.added, 0);
  assert.ok(none.error);
  const other = saves.importLives(JSON.stringify({ format: 'someone-else', lives: [rec] }));
  assert.equal(other.added, 0);
  assert.ok(other.error);
  assert.deepEqual(saves.pastLives(), []);
});

test('import sanitizes types and lengths', () => {
  reset();
  const evil = {
    id: '../../etc', name: 42, birthYear: 2010, age: 999, deathYear: 'x', country: 'not-a-code',
    epitaph: 'x'.repeat(500), bio: 'b'.repeat(10000), highlights: ['ok', 5, 'y'.repeat(900)],
    history: [{ year: 2010, age: 0, tag: '<script>', stats: { health: 900 } }, 'junk'],
    decisions: [{ title: '选择', choice: { nested: 1 } }],
    stats: { health: -50, wealth: 'rich' },
    state: { log: [{ text: '正常记录', kind: 'weird', tone: 99 }, { text: 7 }], dead: null },
  };
  const res = saves.importLives(JSON.stringify([evil]));
  assert.equal(res.added, 1);
  const r = saves.pastLives()[0];
  assert.match(r.id, /^life-/);
  assert.equal(r.name, '');
  assert.ok(r.age <= 130);
  assert.equal(r.country, '');
  assert.ok(r.epitaph.length <= 60);
  assert.ok(r.bio.length <= 4000);
  assert.deepEqual(r.highlights.map((h) => h.length <= 200), [true, true]);
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].tag, 'calm');
  assert.equal(r.history[0].stats.health, 100);
  assert.equal(r.decisions[0].choice, '');
  assert.equal(r.stats.health, 0);
  assert.equal(r.stats.wealth, 50);
  assert.equal(r.state.log.length, 1);
  assert.equal(r.state.log[0].kind, 'event');
  assert.equal(r.state.log[0].tone, 2);
});

test('import keeps only the newest PAST_LIVES_MAX lives', () => {
  reset();
  for (let i = 0; i < 10; i++) saves.addPastLife(makeState(i), { savedAt: new Date(Date.UTC(2026, 4, i + 1)).toISOString() });
  const older = saves.sanitizeRecord({ ...JSON.parse(saves.exportLives()).lives[0], id: 'old-one', savedAt: '2020-01-01T00:00:00.000Z' });
  const res = saves.importLives(JSON.stringify([older]));
  assert.deepEqual(res, { added: 0, skipped: 1 });
  assert.equal(saves.pastLives().length, 10);
  assert.ok(!saves.pastLives().some((r) => r.id === 'old-one'));
});

test('large finished lives are trimmed per record and storage quota drops the oldest', () => {
  reset(900_000);
  for (let i = 0; i < 6; i++) {
    const rec = saves.addPastLife(makeState(i, { logN: 1500, textLen: 300 }), { savedAt: new Date(Date.UTC(2026, 5, i + 1)).toISOString() });
    assert.ok(rec, `life ${i} stored`);
    assert.ok(JSON.stringify(rec).length < saves.SAVE_LIMITS.pastRecord + 20_000);
    assert.equal(rec.history.length, makeState(i).history.length);
  }
  const list = saves.pastLives();
  assert.ok(list.length >= 1);
  assert.equal(list[0].id, 'life-5', 'newest life always kept');
  const raw = localStorage.getItem(STORAGE_KEYS.past);
  assert.ok(raw.length <= 900_000);
});

test('autosave makes room when storage is nearly full', () => {
  reset(700_000);
  for (let i = 0; i < 4; i++) saves.addPastLife(makeState(i, { logN: 1000, textLen: 300 }), { savedAt: new Date(Date.UTC(2026, 6, i + 1)).toISOString() });
  const s = makeState(9, { logN: 1500, textLen: 300, dead: false });
  assert.equal(saves.autosave(s), true);
  const back = saves.loadCurrent();
  assert.equal(back.id, 'life-9');
  assert.equal(back.history.length, s.history.length);
});

// ---------------------------------------------------------------------------------------------------------------
// social store: local fallback and shared mode against an in-memory fake of the `db` capability

/** Minimal in-memory imitation of the artifact db (paths, where/orderBy/limit, onSnapshot, injected DbErrors). */
function makeFakeDb() {
  const docs = new Map();
  const listeners = new Set();
  const failures = [];
  const maybeFail = (op) => {
    const i = failures.findIndex((f) => f.op === op);
    if (i >= 0) { const f = failures.splice(i, 1)[0]; throw { code: f.code, message: 'injected' }; }
  };
  const snapDoc = (path) => {
    const body = docs.get(path);
    return { id: path.split('/').pop(), exists: docs.has(path), data: () => (body ? Object.freeze(structuredClone(body)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const runQuery = (q) => {
    const prefix = q.path + '/';
    let list = [...docs.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(snapDoc);
    for (const [f, op, v] of q.wheres) {
      list = list.filter((d) => {
        const x = d.data()[f];
        if (op === '==') return x === v;
        if (op === '>=') return x >= v;
        if (op === '<=') return x <= v;
        throw new Error('op ' + op);
      });
    }
    if (q.order) {
      const [f, dir] = q.order;
      list.sort((a, b) => {
        const x = a.data()[f]; const y = b.data()[f];
        if (x === undefined) return 1;
        if (y === undefined) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
      });
    }
    if (q.lim) list = list.slice(0, q.lim);
    return { docs: list, size: list.length, empty: !list.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const notify = () => { for (const l of listeners) l.next(runQuery(l.q)); };
  const checkPath = (path, even) => {
    const n = path.split('/').length;
    if ((n % 2 === 0) !== even || !path.split('/').every((s) => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s))) throw new TypeError('bad path ' + path);
  };
  function query(path, wheres = [], order = null, lim = null) {
    checkPath(path, false);
    const q = { path, wheres, order, lim };
    return {
      path,
      where: (f, op, v) => query(path, [...wheres, [f, op, v]], order, lim),
      orderBy: (f, dir = 'asc') => query(path, wheres, [f, dir], lim),
      limit: (n) => query(path, wheres, order, n),
      get: async () => { maybeFail('get'); if (lim > 1000) throw { code: 'invalid_argument' }; return runQuery(q); },
      onSnapshot: (next, error) => {
        const l = { q, next, error };
        listeners.add(l);
        queueMicrotask(() => { if (listeners.has(l)) next(runQuery(q)); });
        return () => listeners.delete(l);
      },
      doc: (id) => docRef(path + '/' + (id || 'auto' + Math.random().toString(36).slice(2))),
    };
  }
  function docRef(path) {
    checkPath(path, true);
    return {
      id: path.split('/').pop(),
      path,
      get: async () => { maybeFail('get'); return snapDoc(path); },
      set: async (data) => { maybeFail('set'); docs.set(path, structuredClone(data)); notify(); },
      update: async (data) => { maybeFail('update'); if (!docs.has(path)) throw { code: 'invalid_argument' }; docs.set(path, { ...docs.get(path), ...structuredClone(data) }); notify(); },
      delete: async () => { maybeFail('delete'); docs.delete(path); notify(); },
      collection: (sub) => query(path + '/' + sub),
    };
  }
  return {
    db: Object.freeze({ doc: docRef, collection: (p) => query(p) }),
    docs,
    fail: (op, code) => failures.push({ op, code }),
    listenerCount: () => listeners.size,
  };
}

function fakeUser({ id = 'u_me', owner = false, can = true } = {}) {
  return Object.freeze({ id: async () => id, isOwner: async () => owner, can: async () => can, canEdit: async () => owner });
}

function pastRecordFor(i) {
  reset();
  return saves.addPastLife(makeState(i), {
    epitaph: '她把一生都留给了海边的那所学校，和每一个曾经坐在教室里的孩子', title: '海边的教师', countryName: '中国',
    bio: '第一段。\n\n\n\n第二段。', highlights: Array.from({ length: 9 }, (_, k) => `节点${k}`),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('store local mode: share, candles, messages, delete, feedback', async () => {
  const rec = pastRecordFor(3);
  globalThis.window = undefined;
  const store = await import('../src/social/store.js?local');
  assert.deepEqual(await store.initSocial(), { mode: 'local' });
  assert.equal(store.socialStatus().ready, true);
  assert.equal(await store.canWrite(), true);

  const res = await store.shareLife(rec);
  assert.equal(res.ok, true);
  assert.equal(res.local, true);
  assert.equal(res.lifeId, rec.id);
  const list = await store.listShared({});
  assert.equal(list.length, 1);
  const life = list[0];
  assert.equal(life.mine, true);
  assert.ok(!('authorId' in life));
  assert.equal(life.epitaph.length, store.SHARE_LIMITS.epitaph);
  assert.equal(life.highlights.length, 6);
  assert.equal(life.bio, '第一段。\n\n第二段。');
  assert.equal(life.lifemap.length, rec.history.length);
  assert.deepEqual(store.decodeLifemap(life.lifemap), rec.history.map((r) => r.tag));

  const seen = [];
  const unsub = store.subscribeShared((l) => seen.push(l.length));
  await tick();
  assert.deepEqual(seen, [1]);

  assert.deepEqual(await store.lightCandle(rec.id), { ok: true, count: 1 });
  assert.equal((await store.lightCandle(rec.id)).already, true);
  assert.equal(await store.candleCount(rec.id), 1);
  assert.equal(await store.hasLitCandle(rec.id), true);

  assert.equal((await store.addMessage(rec.id, '   ')).error, 'empty');
  const m = await store.addMessage(rec.id, '愿你安息。'.repeat(80));
  assert.equal(m.ok, true);
  assert.equal(m.message.text.length, store.SHARE_LIMITS.message);
  assert.equal((await store.addMessage(rec.id, '再说一句')).error, 'busy', 'cooldown between messages');
  const msgs = await store.listMessages(rec.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].mine, true);

  assert.equal((await store.sendFeedback('很好玩', 'memorial')).ok, true);
  assert.equal((await store.listFeedback()).length, 1);

  assert.equal((await store.deleteShared(rec.id)).ok, true);
  assert.equal((await store.listShared({})).length, 0);
  assert.equal(seen[0], 1);
  assert.equal(seen.at(-1), 0, 'feed listeners see the removal');
  unsub();
});

test('store shared mode: share, feed, filters, candles, messages, moderation', async () => {
  const rec = pastRecordFor(4);
  const fake = makeFakeDb();
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? fake.db : name === 'user' ? fakeUser() : null) } };
  const store = await import('../src/social/store.js?shared');
  assert.deepEqual(await store.initSocial(), { mode: 'shared' });
  assert.equal(await store.isOwner(), false);

  const res = await store.shareLife(rec);
  assert.equal(res.ok, true);
  const body = fake.docs.get('lives/' + rec.id);
  assert.equal(body.authorId, 'u_me');
  assert.equal(body.v, 1);
  for (const k of ['lifeId', 'createdAt', 'name', 'sex', 'country', 'countryName', 'birthYear', 'deathYear', 'age', 'cause', 'stats', 'lifemap', 'highlights', 'epitaph', 'bio', 'worldLabel', 'mode']) {
    assert.ok(k in body, 'share record has ' + k);
  }
  assert.ok(body.highlights.length <= 6 && body.highlights.every((x) => x.length <= 60));
  assert.ok(body.bio.length <= 1200 && body.epitaph.length <= 30);

  // live feed (one shared subscription for many listeners)
  const a = [];
  const b = [];
  const offA = store.subscribeShared((l) => a.push(l.map((x) => x.lifeId)));
  const offB = store.subscribeShared((l) => b.push(l.length));
  await tick(); await tick();
  assert.equal(fake.listenerCount(), 1);
  assert.deepEqual(a.at(-1), [rec.id]);

  // untrusted rows are sanitized or dropped
  fake.docs.set('lives/junk', { name: 1, birthYear: 'soon' });
  fake.docs.set('lives/odd', {
    v: 1, lifeId: 'odd', createdAt: '2026-10-20T00:00:00.000Z', name: '名'.repeat(500), birthYear: 2031, deathYear: 2101, age: 70,
    country: 'IND', countryName: 'x'.repeat(99), region: 'SAS', highlights: Array(20).fill('h'.repeat(200)), stats: { health: 999 },
    lifemap: 'bcs!!w', authorId: 'u_other', bio: 7, epitaph: { a: 1 }, candles: -5,
  });
  const all = await store.listShared({ limit: 50 });
  assert.deepEqual(all.map((l) => l.lifeId).sort(), ['odd', rec.id].sort());
  const odd = all.find((l) => l.lifeId === 'odd');
  assert.equal(odd.name.length, 40);
  assert.equal(odd.countryName.length, 30);
  assert.equal(odd.highlights.length, 6);
  assert.equal(odd.stats.health, 100);
  assert.equal(odd.lifemap, 'bcs..w');
  assert.equal(odd.bio, '');
  assert.equal(odd.epitaph, '');
  assert.equal(odd.candles, 0);
  assert.equal(odd.mine, false);
  assert.ok(!('authorId' in odd));

  // filters
  assert.deepEqual((await store.listShared({ country: 'IND' })).map((l) => l.lifeId), ['odd']);
  assert.deepEqual((await store.listShared({ region: 'SAS' })).map((l) => l.lifeId), ['odd']);
  assert.deepEqual((await store.listShared({ era: '2030s' })).map((l) => l.lifeId), ['odd']);
  assert.deepEqual((await store.listShared({ era: '2050s' })).map((l) => l.lifeId), []);
  assert.deepEqual(store.filterLives(all, { country: 'CHN' }).map((l) => l.lifeId), [rec.id]);

  // candles: one per viewer, cached count on the life document
  assert.equal((await store.lightCandle(rec.id)).ok, true);
  assert.equal((await store.lightCandle(rec.id)).already, true);
  assert.equal(await store.candleCount(rec.id), 1);
  assert.ok(fake.docs.has(`lives/${rec.id}/candles/u_me`));
  assert.equal(fake.docs.get('lives/' + rec.id).candles, 1);
  for (let i = 0; i < 1000; i++) fake.docs.set(`lives/odd/candles/v${i}`, { at: '2026-10-01T00:00:00.000Z' });
  assert.equal(await store.candleCount('odd'), '1000+');

  // messages
  const m = await store.addMessage(rec.id, '一路走好');
  assert.equal(m.ok, true);
  fake.docs.set(`lives/${rec.id}/messages/other`, { text: '<b>来自别人</b>', at: '2026-01-01T00:00:00.000Z', authorId: 'u_other' });
  fake.docs.set(`lives/${rec.id}/messages/bad`, { text: 42 });
  const msgs = await store.listMessages(rec.id);
  assert.deepEqual(msgs.map((x) => [x.text, x.mine]), [['一路走好', true], ['<b>来自别人</b>', false]]);
  assert.ok(msgs.every((x) => !('authorId' in x)));
  assert.equal((await store.deleteMessage(rec.id, 'other')).error, 'readonly', 'cannot delete other people\'s messages');
  assert.equal((await store.deleteMessage(rec.id, m.message.id)).ok, true);

  // moderation: not owner, not author
  assert.equal((await store.deleteShared('odd')).error, 'readonly');
  // author may withdraw; nested candles and messages go too
  assert.equal((await store.deleteShared(rec.id)).ok, true);
  assert.ok(![...fake.docs.keys()].some((k) => k.startsWith(`lives/${rec.id}`)));
  await tick();
  assert.deepEqual(a.at(-1), ['odd']);

  offA();
  assert.equal(fake.listenerCount(), 1);
  offB();
  assert.equal(fake.listenerCount(), 0, 'last unsubscribe closes the shared subscription');
});

test('store shared mode: DbError handling', async () => {
  const rec = pastRecordFor(5);
  const fake = makeFakeDb();
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? fake.db : name === 'user' ? fakeUser({ can: null }) : null) } };
  const store = await import('../src/social/store.js?errors');
  await store.initSocial();
  assert.equal(await store.canWrite(), true, 'unknown write permission keeps controls until a write is refused');

  // unavailable: one retry after a short delay, then success
  fake.fail('get', 'unavailable');
  fake.docs.set('lives/x1', { birthYear: 2001, age: 3, createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal((await store.listShared({})).length, 1);
  // unavailable twice: gives up with a network message
  fake.fail('set', 'unavailable');
  fake.fail('set', 'unavailable');
  const net = await store.shareLife(rec);
  assert.equal(net.ok, false);
  assert.equal(net.error, 'network');
  // quota_exceeded: surfaced to the viewer, not retried
  fake.fail('set', 'quota_exceeded');
  const q = await store.shareLife(rec);
  assert.equal(q.error, 'quota');
  assert.match(q.message, /空间已满/);
  // resource_exhausted: slow down
  fake.fail('set', 'resource_exhausted');
  assert.equal((await store.shareLife(rec)).error, 'busy');
  // works again
  assert.equal((await store.shareLife(rec)).ok, true);
  // invalid_argument on a well-formed write: read-only for the rest of the visit
  fake.fail('set', 'invalid_argument');
  assert.equal((await store.lightCandle(rec.id)).error, 'readonly');
  assert.equal(await store.canWrite(), false);
  assert.equal(store.socialStatus().readOnly, true);
  assert.equal((await store.addMessage(rec.id, '你好')).error, 'readonly');
  // reads still work while read-only
  assert.equal((await store.listShared({})).length, 2);
});

test('store shared mode: revoked degrades', async () => {
  const fake = makeFakeDb();
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? fake.db : null) } };
  const store = await import('../src/social/store.js?revoked');
  await store.initSocial();
  fake.docs.set('lives/x1', { birthYear: 2001, age: 3, createdAt: '2026-01-01T00:00:00.000Z' });
  const got = [];
  const off = store.subscribeShared((l, meta) => got.push([l.length, meta.error || null]));
  await tick(); await tick();
  assert.deepEqual(got.at(-1), [1, null]);
  fake.fail('get', 'revoked');
  const after = await store.listShared({});
  assert.deepEqual(after.map((l) => l.lifeId), ['x1'], 'degraded mode keeps showing the last loaded lives');
  assert.equal(store.socialStatus().degraded, true);
  assert.equal(fake.listenerCount(), 0, 'live subscription closed after revocation');
  assert.equal(store.socialStatus().canWrite, false);
  assert.equal((await store.lightCandle('x1')).error, 'degraded');
  off();
  globalThis.window = undefined;
});

test('store shared mode: one write at a time per document, no double posts', async () => {
  const rec = pastRecordFor(6);
  const fake = makeFakeDb();
  const sets = [];
  // every set() takes a moment, like the real store, so overlapping requests really overlap
  const db = Object.freeze({
    doc: (p) => { const r = fake.db.doc(p); return { ...r, set: async (d) => { sets.push(p); await tick(); return r.set(d); } }; },
    collection: (p) => fake.db.collection(p),
  });
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? db : name === 'user' ? fakeUser() : null) } };
  const store = await import('../src/social/store.js?single');
  await store.initSocial();

  const [s1, s2] = await Promise.all([store.shareLife(rec), store.shareLife(rec)]);
  assert.ok(s1.ok && s2.ok);
  assert.equal(s1.lifeId, s2.lifeId);
  assert.equal(sets.filter((p) => p === 'lives/' + rec.id).length, 1, 'a double click shares once');

  const [c1, c2] = await Promise.all([store.lightCandle(rec.id), store.lightCandle(rec.id)]);
  assert.ok(c1.ok && c2.ok);
  assert.equal(sets.filter((p) => p.includes('/candles/')).length, 1, 'one candle write');
  assert.equal((await store.lightCandle(rec.id)).already, true);

  // a refused message gives the cooldown back; a double click then posts exactly once
  fake.fail('set', 'quota_exceeded');
  assert.equal((await store.addMessage(rec.id, '一路走好')).error, 'quota');
  sets.length = 0;
  const [m1, m2] = await Promise.all([store.addMessage(rec.id, '一路走好'), store.addMessage(rec.id, '一路走好')]);
  assert.deepEqual([m1.ok, m2.error], [true, 'busy']);
  assert.equal(sets.filter((p) => p.includes('/messages/')).length, 1, 'a double click posts once');

  // feedback: anonymous, but not a flood (the store holds at most 25,000 documents for everyone)
  const f1 = await store.sendFeedback('第一条反馈', 'about');
  const f2 = await store.sendFeedback('第二条反馈', 'about');
  assert.deepEqual([f1.ok, f2.ok, f2.error], [true, false, 'busy']);
  assert.equal([...fake.docs.keys()].filter((k) => k.startsWith('feedback/')).length, 1);
  assert.ok(!('authorId' in fake.docs.get([...fake.docs.keys()].find((k) => k.startsWith('feedback/')))), 'feedback stays anonymous');

  // a row dated far in the future cannot pin itself to the top of the newest-first lists
  fake.docs.set('lives/pinned', { birthYear: 2001, age: 3, createdAt: '9999-01-01T00:00:00.000Z' });
  assert.equal(store.sanitizeLife('pinned', fake.docs.get('lives/pinned')).createdAt, '');
  const newest = await store.listShared({});
  assert.equal(newest[0].lifeId, rec.id);
  assert.equal(newest.at(-1).lifeId, 'pinned');
  globalThis.window = undefined;
});
