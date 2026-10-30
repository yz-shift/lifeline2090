// GameController tests (src/ui/controller.js) with a fake engine, director, saves and decision overlay.
// Runs under plain Node: no DOM. Core modules that other engineers have not delivered yet (engine.js,
// decisions.js, economy.js, ...) are resolved to empty stubs so the controller can be imported on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) {
        return { url: 'data:text/javascript,export%20%7B%7D%3B', shortCircuit: true };
      }
      throw e;
    }
  },
});

// reducedMotion() -> true makes skipToDecision run without visible pacing
globalThis.window = globalThis.window || { matchMedia: () => ({ matches: true }) };

const C = await import('../src/ui/controller.js');
const { GameController, normSpeed, streamField, makeStreamAccumulator, biographyFor, SPEEDS, AUTO_TEXTURES, textureLabel } = C;
const { bus } = await import('../src/ui/dom.js');
const moments = await import('../src/ui/screens/moments.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2000, label = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

let lifeNo = 0;
function makeState(over = {}) {
  lifeNo++;
  return {
    v: 1, id: `life-${lifeNo}`, seed: lifeNo, rng: [1, 2, 3, 4], createdAt: '2026-10-24T00:00:00Z', mode: 'random',
    worldSeed: 7, worldLabel: '测试世界线',
    settings: { lifeMinutes: 10, aiMode: 'off', decisionFreq: 'standard', autoChoose: false },
    birth: { mode: 'random', year: 2000, date: '2000-03-01', time: '08:00:00', country: 'CHN', sex: 'female', urban: true, familyPct: 0.5, name: '林小雨' },
    year: 2000, age: 0,
    person: { name: '林小雨', sex: 'female', country: 'CHN', urban: true, familyPct: 0.5, children: [], money: { cash: 0, debt: 0, income: 0, portfolio: {} } },
    stats: { health: 80, happiness: 60, knowledge: 10, relationships: 50, wealth: 30 },
    history: [{ year: 2000, age: 0, stats: { health: 80, happiness: 60, knowledge: 10, relationships: 50, wealth: 30 }, tag: 'birth', mood: 1, country: 'CHN', headline: '出生' }],
    log: [{ year: 2000, age: 0, kind: 'birth', text: '你出生了。', tone: 1, tags: [], source: 'engine' }],
    decisions: [], threads: [], hazardMods: [], pending: null, dead: null, cohort: [], aiNotes: { birthStory: null, lastSummary: null },
    ...over,
  };
}

function makeEngine({ decisionAges = [5], deathAge = 12, clearsPending = false } = {}) {
  const calls = { step: 0, apply: [] };
  return {
    calls,
    stepYear(data, world, s) {
      calls.step++;
      s.year++;
      s.age++;
      const entries = [{ year: s.year, age: s.age, kind: 'event', text: `第 ${s.age} 年`, tone: 0, tags: [], source: 'engine' }];
      s.log.push(...entries);
      s.history.push({ year: s.year, age: s.age, stats: { ...s.stats }, tag: 'calm', mood: 0, country: 'CHN', headline: '' });
      let decision = null;
      let died = null;
      if (s.age >= deathAge) {
        died = s.dead = {
          year: s.year, age: s.age, date: `${s.year}-05-01`, cause: { id: 'cvd', name: '心血管疾病', detail: '' }, place: 'CHN',
          summary: '', stats: { ...s.stats }, lifeExpAtBirth: 70, percentile: 0.4,
        };
      } else if (decisionAges.includes(s.age)) {
        decision = s.pending = {
          id: `d-${s.age}`, year: s.year, age: s.age, kind: 'milestone', title: '人生的岔路口', situation: '有两条路。',
          options: [{ id: 'a', label: '稳妥', detail: '', risk: 'low' }, { id: 'b', label: '冒险', detail: '', risk: 'high' }],
          allowCustom: true, source: 'local',
        };
      }
      return { year: s.year, age: s.age, entries, news: [], decision, died, stats: s.stats };
    },
    applyResolution(data, world, s, decision, choice, resolution) {
      calls.apply.push({ decision, choice, resolution });
      s.decisions.push({ id: decision.id, year: s.year, age: s.age, title: decision.title, choice: choice.customText || choice.optionId, custom: !!choice.customText, source: 'local' });
      s.stats.happiness += (resolution.effects && resolution.effects.happiness) || 0;
      if (clearsPending) s.pending = null;
      return [{ year: s.year, age: s.age, kind: 'choice', text: resolution.narrative, tone: 0, tags: [], source: 'engine' }];
    },
  };
}

function resolutionOf(text, happiness = 5) {
  return { narrative: text, effects: { health: 0, happiness, knowledge: 0, relationships: 0, wealthDelta: 0 }, set: {}, threads: [], feasible: true };
}

function makeDirector(over = {}) {
  const calls = { get: 0, resolve: [], custom: [], prefetch: 0, bio: 0, story: 0 };
  const d = {
    calls,
    getDecision(state, ctx, opts) { calls.get++; return { decision: opts.decision, upgrade: Promise.resolve(null) }; },
    async resolveChoice(state, decision, choice, opts) {
      calls.resolve.push({ decision, choice });
      if (opts && opts.onText) opts.onText({ text: '你选了', delta: '你选了' });
      return { resolution: resolutionOf('你选择之后，日子慢慢变了。'), source: 'local' };
    },
    async customAction(state, text) {
      calls.custom.push(text);
      return {
        resolution: resolutionOf(`你决定：${text}。`, 3), source: 'local',
        decision: { id: `act-${state.year}`, year: state.year, age: state.age, kind: 'custom', title: '主动选择', situation: text, options: [], allowCustom: true, source: 'local' },
        choice: { customText: text },
      };
    },
    prefetch() { calls.prefetch++; return false; },
    async biography() { calls.bio++; return { title: '平凡的一生', bio: '她认真地生活过。', epitaph: '来过，爱过。', highlights: ['出生'], source: 'local' }; },
    async birthStory() { calls.story++; return { text: '那天清晨下着小雨。', tagline: '', source: 'ai' }; },
    usable: () => false,
    ...over,
  };
  return d;
}

function makeApp(over = {}) {
  const app = {
    data: { series: () => null },
    settings: { lifeMinutes: 10 },
    toasts: [],
    ended: null,
    toast(t, k) { app.toasts.push([t, k]); },
    saveSettings() {},
    endLife(state) { app.ended = state; },
    ...over,
  };
  return app;
}

function makeOverlay() {
  const log = [];
  const fn = (app, decision, opts) => {
    const entry = { decision, opts, closed: false };
    log.push(entry);
    const close = () => { entry.closed = true; };
    close.setAuto = (v) => { entry.auto = v; };
    close.setSpeed = () => {};
    return close;
  };
  fn.log = log;
  return fn;
}

/**
 * The interactivity layer of the engine (CONTRACT §10) on top of makeEngine: small choices at `smallAges`, a child
 * born at `childAge` (namingPending), reflections at `reflectAges`, notes, stars (max 12) and the yearly focus.
 */
function withV2(engine, { smallAges = [], childAge = null, reflectAges = [] } = {}) {
  const calls = engine.calls;
  Object.assign(calls, { small: [], named: [], notes: [], stars: [], focus: [] });
  let seq = 0;
  const entry = (s, kind, text) => ({ id: `${s.year}-v2-${++seq}`, year: s.year, age: s.age, kind, text, tone: 0, tags: [], source: 'engine' });
  const baseStep = engine.stepYear;
  engine.stepYear = (data, world, s) => {
    if (s.smallPending) throw new Error('the controller must settle the small choice before the next year');
    const r = baseStep(data, world, s);
    if (s.dead) return r;
    for (const e of r.entries) if (!e.id) e.id = `${s.year}-e-${++seq}`;
    if (smallAges.includes(s.age)) {
      s.smallPending = {
        id: `sc-${s.year}`, year: s.year, age: s.age, kind: 'small', title: '周末去哪儿', text: '难得的周末。',
        options: [{ id: 'a', label: '去图书馆', hint: '知识↑' }, { id: 'b', label: '去河边玩', hint: '快乐↑' }], expiresYear: s.year + 1,
      };
    }
    if (s.age === childAge) {
      s.person.children.push({ name: '', sex: 'female', birthYear: s.year, alive: true });
      s.namingPending = { childIndex: s.person.children.length - 1, sex: 'female', suggestions: ['林小满', '林安然', '林知夏'] };
    }
    if (reflectAges.includes(s.age)) s.reflectPending = { age: s.age, prompt: '走到这里，你最想记住什么？' };
    return r;
  };
  Object.assign(engine, {
    focusOptions(data, world, s) {
      return s.age < 6 ? [] : [{ id: 'study', label: '读书', hint: '知识↑ 快乐略↓', available: true }, { id: 'love', label: '谈恋爱', hint: '快乐↑', available: false, why: '还太小' }];
    },
    setFocus(s, id) { calls.focus.push(id); s.focus = { current: id, auto: id == null }; },
    resolveSmall(data, world, s, optionId) {
      calls.small.push(optionId);
      const sm = s.smallPending;
      const opt = sm.options.find((o) => o.id === optionId) || sm.options[0];
      const e = entry(s, 'choice', `周末，你${opt.label}。`);
      s.log.push(e);
      s.smallPending = null;
      return [e];
    },
    nameChild(s, idx, name) {
      calls.named.push([idx, name]);
      s.person.children[idx].name = name;
      const e = entry(s, 'milestone', `你给女儿取名「${name}」。`);
      s.log.push(e);
      s.namingPending = null;
      return [e];
    },
    addNote(s, text, kind, prompt) {
      calls.notes.push({ text, kind, prompt });
      (s.notes || (s.notes = [])).push({ year: s.year, age: s.age, kind, prompt: prompt ?? null, text });
      const e = entry(s, 'system', `你写下：${text}`);
      s.log.push(e);
      return [e];
    },
    toggleStar(s, id) {
      calls.stars.push(id);
      const st = s.stars || (s.stars = []);
      const i = st.indexOf(id);
      if (i >= 0) { st.splice(i, 1); return { starred: false }; }
      if (st.length >= 12) return { starred: false, full: true };
      st.push(id);
      return { starred: true };
    },
  });
  return engine;
}

function makeMoments() {
  const log = [];
  const open = (kind) => (app, opts) => {
    const entry = { kind, opts, closed: false };
    log.push(entry);
    const close = () => { entry.closed = true; };
    close.isOpen = () => !entry.closed;
    return close;
  };
  return { log, openNaming: open('naming'), openReflection: open('reflect'), openThought: open('thought') };
}

function setup({ engineOpts, v2, directorOver, appOver, stateOver } = {}) {
  const engine = makeEngine(engineOpts);
  if (v2) withV2(engine, v2);
  const director = makeDirector(directorOver);
  const app = makeApp(appOver);
  const state = makeState(stateOver);
  const saves = { n: 0, autosave() { saves.n++; return true; } };
  const overlay = makeOverlay();
  const moms = makeMoments();
  const world = { seed: 7, label: '测试世界线', lifeExpectancy: () => 60 };
  const ctl = new GameController(app, state, { engine, director, saves, openDecision: overlay, moments: moms, world, deathDelayMs: 0 });
  const events = [];
  for (const e of ['year', 'decision', 'resolved', 'death', 'ai', 'log', 'small', 'moment', 'waiting', 'changed']) ctl.on(e, (p) => events.push([e, p]));
  return { engine, director, app, state, saves, overlay, moments: moms, ctl, events };
}

// ---------------------------------------------------------------------------------------------------------------

test('normSpeed snaps to the nearest supported speed (0.5x to 16x)', () => {
  assert.deepEqual(SPEEDS, [0.5, 1, 2, 4, 8, 12, 16]);
  assert.equal(normSpeed(1), 1);
  assert.equal(normSpeed(3), 4);
  assert.equal(normSpeed(0.7), 0.5);
  assert.equal(normSpeed(10), 12);
  assert.equal(normSpeed(14), 16);
  assert.equal(normSpeed(100), 16);
  assert.equal(normSpeed('fast'), 1);
  assert.equal(normSpeed(-2), 1);
});

test('streamField shows only the prose of a streamed JSON field', () => {
  assert.equal(streamField('{"narrative":"你好\\n世界', 'narrative'), '你好\n世界');
  assert.equal(streamField('{"narrative":"他说\\"走吧\\"。","effects":{', 'narrative'), '他说"走吧"。');
  assert.equal(streamField('{"title":"x"', 'narrative'), '');
  assert.equal(streamField('只是普通的文字。', 'narrative'), '只是普通的文字。');
  assert.equal(streamField('', 'narrative'), '');
  assert.equal(streamField(null, 'narrative'), '');
});

test('makeStreamAccumulator accepts deltas, cumulative text and {text} objects', () => {
  const a = makeStreamAccumulator();
  a('你'); a('好');
  assert.equal(a(''), '你好');
  const b = makeStreamAccumulator();
  b('一'); b('一二');
  assert.equal(b('一二三'), '一二三');
  const c = makeStreamAccumulator();
  c({ text: '甲', delta: '甲' });
  assert.equal(c({ text: '甲乙', delta: '乙' }), '甲乙');
});

test('seconds per year = lifeMinutes * 60 / life expectancy at birth; speed is applied on top', () => {
  const { ctl } = setup();
  assert.equal(ctl.leBirth, 60);
  assert.equal(ctl.secondsPerYear(), 10);
  ctl.setSpeed(4);
  assert.equal(ctl.speed, 4);
  assert.equal(ctl.snapshot().secondsPerYear, 2.5);
  ctl.setSpeed(3);
  assert.equal(ctl.speed, 4);
  ctl.destroy();
});

test('real-time loop advances years, emits ticks, autosaves and prefetches every year; pause stops it', async () => {
  const { ctl, engine, saves, director, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, appOver: { settings: { lifeMinutes: 0.1 } } });
  let ticks = 0;
  ctl.on('tick', () => { ticks++; });
  ctl.setSpeed(8);
  ctl.start();
  assert.equal(ctl.snapshot().running, true);
  await waitFor(() => engine.calls.step >= 3, 3000, 'three years');
  ctl.pause();
  const stepped = engine.calls.step;
  assert.ok(ticks > 0, 'tick events');
  assert.ok(saves.n >= 3, 'autosave each year');
  assert.ok(director.calls.prefetch >= 3, 'prefetch each year');
  assert.equal(events.filter(([e]) => e === 'year').length, stepped);
  assert.equal(ctl.snapshot().running, false);
  assert.equal(ctl.snapshot().userPaused, true);
  await sleep(150);
  assert.equal(engine.calls.step, stepped, 'paused: no further years');
  ctl.resume();
  assert.equal(ctl.snapshot().running, true);
  ctl.destroy();
});

test('skipToDecision fast-forwards to the pending decision; the choice is resolved and applied', async () => {
  const { ctl, engine, director, overlay, state, events, saves } = setup();
  ctl.start();
  ctl.pause();
  assert.equal(ctl.skipToDecision(), true);
  await waitFor(() => overlay.log.length === 1, 2000, 'decision overlay');
  assert.equal(state.age, 5);
  assert.equal(ctl.snapshot().skipping, false);
  assert.equal(ctl.snapshot().running, false, 'clock stops while a decision is pending');
  assert.equal(ctl.snapshot().userPaused, false, 'skip clears the user pause');
  assert.ok(saves.n >= 1);
  const { decision, opts } = overlay.log[0];
  assert.equal(decision.id, 'd-5');
  assert.equal(opts.auto, false);
  assert.ok(events.some(([e, p]) => e === 'decision' && p.id === 'd-5'));
  // the overlay may ask the controller for an automatic choice
  const auto = opts.onAuto(decision);
  assert.ok(['a', 'b'].includes(auto.optionId));
  assert.deepEqual(opts.onAuto(decision), auto, 'auto choice is deterministic');
  let streamed = '';
  const res = await opts.onChoose({ optionId: 'b' }, decision, { onText: (t) => { streamed = t; } });
  assert.equal(streamed, '你选了');
  assert.equal(res.resolution.narrative, '你选择之后，日子慢慢变了。');
  assert.equal(director.calls.resolve.length, 1);
  assert.equal(engine.calls.apply.length, 1);
  assert.deepEqual(engine.calls.apply[0].choice, { optionId: 'b' });
  assert.equal(state.pending, null, 'answered decision is cleared even when the engine leaves it');
  assert.equal(state.decisions.length, 1);
  assert.ok(events.some(([e]) => e === 'resolved'));
  assert.equal(ctl.snapshot().phase, 'resolved');
  opts.onContinue();
  assert.equal(ctl.snapshot().flow, null);
  assert.equal(overlay.log[0].closed, true);
  assert.equal(ctl.snapshot().running, true, 'clock runs again after 继续');
  ctl.destroy();
});

test('skipToDecision runs on to death; the death flow writes the biography and ends the life', async () => {
  const { ctl, app, state, events, director } = setup({ engineOpts: { decisionAges: [], deathAge: 8 } });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => app.ended === state, 2000, 'app.endLife');
  assert.equal(state.age, 8);
  assert.ok(state.dead);
  assert.equal(events.filter(([e]) => e === 'death').length, 1);
  assert.equal(ctl.snapshot().dead, true);
  assert.equal(ctl.canAct(), false);
  assert.equal(ctl.skipToDecision(), false);
  const job = biographyFor(app, state);
  const bio = await job.promise;
  assert.equal(director.calls.bio, 1, 'biography written once');
  assert.equal(bio.biography, '她认真地生活过。');
  assert.equal(bio.epitaph, '来过，爱过。');
  assert.equal(bio.title, '平凡的一生');
  assert.equal(biographyFor(app, state), job, 'same job for the same life');
  ctl.destroy();
});

test('biography falls back to an offline text when the director fails', async () => {
  const { ctl, app, state } = setup({
    engineOpts: { decisionAges: [], deathAge: 1 },
    directorOver: { async biography() { throw new Error('offline'); } },
  });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => app.ended === state, 2000, 'app.endLife');
  const bio = await biographyFor(app, state).promise;
  assert.ok(bio.biography.includes('林小雨'));
  assert.ok(bio.epitaph.length > 0);
  assert.equal(bio.source, 'local');
  ctl.destroy();
});

test('a life that is already over ends asynchronously on start (never re-enters the router)', async () => {
  const dead = { year: 2070, age: 70, date: '2070-01-01', cause: { id: 'x', name: '衰老', detail: '' }, place: 'CHN', summary: '', stats: {}, lifeExpAtBirth: 70, percentile: 0.5 };
  const { ctl, app, state } = setup({ stateOver: { dead, year: 2070, age: 70 } });
  ctl.start();
  assert.equal(app.ended, null);
  await waitFor(() => app.ended === state, 1000, 'app.endLife');
  ctl.destroy();
});

test('customAction pauses the clock, applies the director result and resumes', async () => {
  const { ctl, engine, director, state, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
  ctl.start();
  const p = ctl.customAction('  去学  画画  ');
  assert.equal(ctl.snapshot().running, false, 'paused during the action');
  assert.equal(ctl.canAct(), false);
  const res = await p;
  assert.equal(director.calls.custom[0], '去学 画画');
  assert.equal(res.custom, true);
  assert.equal(res.resolution.narrative, '你决定：去学 画画。');
  assert.equal(engine.calls.apply.length, 1);
  assert.deepEqual(engine.calls.apply[0].choice, { customText: '去学 画画' });
  assert.equal(state.decisions[0].custom, true);
  assert.ok(events.some(([e, pl]) => e === 'resolved' && pl.custom));
  assert.equal(ctl.snapshot().flow, null);
  assert.equal(ctl.snapshot().running, true);
  assert.equal(await ctl.customAction('   '), null, 'empty text is ignored');
  ctl.destroy();
});

test('openCustomAction opens the overlay in custom mode and resolves through customAction', async () => {
  const { ctl, overlay, director } = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
  ctl.start();
  assert.equal(ctl.openCustomAction(), true);
  assert.equal(overlay.log.length, 1);
  const { opts, decision } = overlay.log[0];
  assert.equal(opts.custom, true);
  assert.equal(decision.kind, 'custom');
  assert.equal(ctl.openCustomAction(), false, 'one dialog at a time');
  const res = await opts.onChoose({ customText: '开一家书店' }, decision, {});
  assert.equal(res.resolution.narrative, '你决定：开一家书店。');
  assert.equal(director.calls.custom.length, 1);
  opts.onContinue();
  assert.equal(ctl.snapshot().flow, null);
  // cancelling a custom action leaves no trace
  ctl.openCustomAction();
  overlay.log[1].opts.onCancel();
  assert.equal(ctl.snapshot().flow, null);
  assert.equal(director.calls.custom.length, 1);
  ctl.destroy();
});

test('auto-choose setting is passed to the overlay and can be toggled while it is open', async () => {
  const { ctl, overlay } = setup();
  ctl.setAutoChoose(true);
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => overlay.log.length === 1, 2000, 'overlay');
  assert.equal(overlay.log[0].opts.auto, true);
  ctl.setAutoChoose(false);
  assert.equal(overlay.log[0].auto, false);
  assert.equal(ctl.snapshot().autoChoose, false);
  ctl.destroy();
});

test('the AI upgrade of a decision reaches the overlay and replaces the choice set', async () => {
  let resolveUp;
  const up = new Promise((r) => { resolveUp = r; });
  const { ctl, overlay, events } = setup({
    directorOver: { getDecision: (s, c, o) => ({ decision: o.decision, upgrade: up }) },
  });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => overlay.log.length === 1, 2000, 'overlay');
  const shown = overlay.log[0].decision;
  assert.equal(typeof shown.upgrade.then, 'function');
  assert.ok(events.some(([e, t]) => e === 'ai' && t), 'AI status shown while the upgrade is pending');
  const better = { ...shown, upgrade: undefined, source: 'ai', options: [{ id: 'a', label: '读夜校', detail: '', risk: 'mid' }, { id: 'b', label: '学手艺', detail: '', risk: 'low' }, { id: 'c', label: '去南方', detail: '', risk: 'high' }] };
  resolveUp(better);
  const swapped = await shown.upgrade;
  assert.equal(swapped.options.length, 3);
  overlay.log[0].opts.onUpgrade(swapped);
  await sleep(0);
  assert.equal(ctl.flow.decision.options.length, 3);
  assert.equal(ctl.aiText, '');
  ctl.destroy();
});

test('hidden tab pauses the clock and showing it again resumes', () => {
  const listeners = {};
  globalThis.document = {
    hidden: false,
    addEventListener(t, f) { listeners[t] = f; },
    removeEventListener(t) { delete listeners[t]; },
  };
  try {
    const { ctl } = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
    ctl.start();
    assert.equal(ctl.snapshot().running, true);
    document.hidden = true;
    listeners.visibilitychange();
    assert.equal(ctl.snapshot().hidden, true);
    assert.equal(ctl.snapshot().running, false);
    document.hidden = false;
    listeners.visibilitychange();
    assert.equal(ctl.snapshot().running, true);
    ctl.destroy();
    assert.equal(listeners.visibilitychange, undefined, 'listener removed on destroy');
  } finally {
    delete globalThis.document;
  }
});

test('detach closes the overlay and attach re-opens the pending decision', async () => {
  const { ctl, overlay } = setup();
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => overlay.log.length === 1, 2000, 'overlay');
  ctl.detach();
  assert.equal(overlay.log[0].closed, true);
  assert.equal(ctl.snapshot().reasons.includes('away'), true);
  ctl.attach();
  assert.equal(overlay.log.length, 2);
  assert.equal(overlay.log[1].decision.id, 'd-5');
  ctl.destroy();
});

test('a broken engine pauses with a message instead of crashing', () => {
  const { ctl, app } = setup();
  ctl.deps.engine = { stepYear() { throw new Error('boom'); }, applyResolution() { return []; } };
  ctl.start();
  const err = console.error;
  console.error = () => {};
  try { ctl.skipToDecision(); } finally { console.error = err; }
  assert.equal(ctl.snapshot().skipping, false);
  assert.ok(ctl.snapshot().reasons.includes('error'));
  assert.equal(app.toasts.length, 1);
  ctl.destroy();
});

test('the AI birth story is requested once and added to the birth year of the log', async () => {
  const { ctl, state, events, director } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, directorOver: { usable: () => true } });
  ctl.start();
  ctl.pause();
  await waitFor(() => events.some(([e]) => e === 'log'), 1000, 'log event');
  const story = state.log[state.log.length - 1];
  assert.equal(story.kind, 'birth');
  assert.equal(story.source, 'ai');
  assert.equal(story.year, 2000);
  assert.equal(state.aiNotes.birthStory, '那天清晨下着小雨。');
  ctl.start();
  assert.equal(director.calls.story, 1);
  ctl.destroy();
  // AI unusable: no call
  const other = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
  other.ctl.start();
  await sleep(10);
  assert.equal(other.director.calls.story, 0);
  other.ctl.destroy();
});

// ---------------------------------------------------------------------------------------------------------------
// Interactivity layer (CONTRACT §10)

test('a small choice is offered inline and answered without stopping the clock; it is saved and announced', () => {
  const { ctl, engine, state, saves, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, v2: { smallAges: [1] } });
  const busMsgs = [];
  const off = bus.on('life:changed', (m) => busMsgs.push(m));
  try {
    ctl.start();
    ctl.pause();
    ctl._advance(false);
    assert.equal(state.age, 1);
    assert.ok(events.some(([e, p]) => e === 'small' && p.type === 'new' && p.small.id === 'sc-2001'));
    assert.equal(ctl.snapshot().small, 'sc-2001');
    assert.ok(busMsgs.some((m) => m.what === 'year' && m.source === 'controller' && m.state === state));
    ctl.resume();
    assert.equal(ctl.answerSmall('zz'), null, 'an unknown option is ignored');
    assert.deepEqual(engine.calls.small, []);
    const before = saves.n;
    const r = ctl.answerSmall('b');
    assert.equal(r.type, 'answered');
    assert.equal(r.optionId, 'b');
    assert.deepEqual(engine.calls.small, ['b']);
    assert.equal(state.smallPending, null);
    assert.equal(state.log.filter((e) => e.text === '周末，你去河边玩。').length, 1, 'logged once');
    assert.ok(saves.n > before, 'autosaved');
    assert.equal(ctl.snapshot().running, true, 'answering never stops the clock');
    assert.ok(events.some(([e, p]) => e === 'log' && p[0].text === '周末，你去河边玩。'));
    assert.ok(busMsgs.some((m) => m.what === 'small' && m.source === 'controller'));
    assert.equal(ctl.answerSmall('a'), null, 'nothing left to answer');
  } finally {
    off();
    ctl.destroy();
  }
});

test('an unanswered small choice is decided when its year ends, inside its own year', () => {
  const { ctl, engine, state, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, v2: { smallAges: [1] } });
  ctl.start();
  ctl.pause();
  ctl._advance(false);
  ctl._advance(false);   // the fake engine throws if a small choice is still pending here
  assert.deepEqual(engine.calls.small, [null]);
  const auto = events.find(([e, p]) => e === 'small' && p.type === 'auto');
  assert.ok(auto, 'auto event');
  assert.equal(auto[1].entries[0].year, 2001);
  assert.equal(state.year, 2002);
  assert.equal(state.smallPending, null);
  ctl.destroy();
});

test('a child born during a fast-forward pauses for naming; the skip carries on to the decision afterwards', async () => {
  const { ctl, engine, state, moments, overlay, events } = setup({ v2: { childAge: 3 } });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => moments.log.length === 1, 2000, 'naming dialog');
  const m = moments.log[0];
  assert.equal(m.kind, 'naming');
  assert.equal(state.age, 3);
  assert.deepEqual(m.opts.naming.suggestions, ['林小满', '林安然', '林知夏']);
  const sn = ctl.snapshot();
  assert.equal(sn.moment, 'naming');
  assert.equal(sn.skipping, false);
  assert.equal(sn.running, false);
  assert.ok(sn.reasons.includes('naming'));
  assert.equal(ctl.canAct(), false);
  assert.equal(ctl.skipToDecision(), false, 'no skipping while the dialog is open');
  m.opts.onName('  林小满 ');
  assert.deepEqual(engine.calls.named, [[0, '林小满']]);
  assert.equal(state.person.children[0].name, '林小满');
  assert.equal(state.namingPending, null);
  assert.ok(events.some(([e, p]) => e === 'moment' && p.kind === 'naming' && p.open === false));
  await waitFor(() => overlay.log.length === 1, 2000, 'the skip goes on to the decision');
  assert.equal(state.age, 5);
  ctl.destroy();
});

test('closing the naming dialog keeps the suggested name; leaving the screen re-opens it later', async () => {
  const { ctl, engine, state, moments } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, v2: { childAge: 2 } });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => moments.log.length === 1, 2000, 'naming dialog');
  ctl.detach();
  assert.equal(moments.log[0].closed, true);
  assert.equal(ctl.snapshot().moment, null);
  assert.ok(state.namingPending, 'still waiting for a name');
  ctl.attach();
  assert.equal(moments.log.length, 2);
  assert.equal(moments.log[1].kind, 'naming');
  moments.log[1].opts.onKeep();
  assert.deepEqual(engine.calls.named, [[0, '林小满']]);
  assert.equal(state.person.children[0].name, '林小满');
  assert.equal(state.namingPending, null);
  assert.equal(ctl.snapshot().running, true);
  ctl.destroy();
});

test('a reflection comes before the decision of the same year; "以后不再这样暂停" turns them off', async () => {
  const saved = [];
  const { ctl, engine, state, moments, overlay } = setup({ v2: { reflectAges: [5] }, appOver: { saveSettings(p) { saved.push(p); } } });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => moments.log.length === 1, 2000, 'reflection dialog');
  const m = moments.log[0];
  assert.equal(m.kind, 'reflect');
  assert.equal(m.opts.reflect.age, 5);
  assert.equal(overlay.log.length, 0, 'the decision waits for the reflection');
  m.opts.onSave('  我想当宇航员  ', { never: true });
  assert.deepEqual(engine.calls.notes, [{ text: '我想当宇航员', kind: 'reflection', prompt: '走到这里，你最想记住什么？' }]);
  assert.equal(state.reflectPending, null);
  assert.equal(state.settings.reflections, false);
  assert.ok(saved.some((p) => p.reflections === false));
  await waitFor(() => overlay.log.length === 1, 2000, 'decision after the reflection');
  ctl.destroy();
});

test('with reflections switched off the engine\'s reflection moment is dropped silently', async () => {
  const { ctl, state, moments, overlay } = setup({ v2: { reflectAges: [5] }, appOver: { settings: { lifeMinutes: 10, reflections: false } } });
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => overlay.log.length === 1, 2000, 'decision');
  assert.equal(moments.log.length, 0);
  assert.equal(state.reflectPending, null);
  assert.equal(state.settings.reflections, false, 'the global setting follows into the life');
  ctl.destroy();
});

test('✎ 写下想法 pauses while the note is written and resumes afterwards', () => {
  const { ctl, engine, moments } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, v2: {} });
  ctl.start();
  assert.equal(ctl.openThought(), true);
  assert.equal(ctl.snapshot().running, false);
  assert.equal(ctl.snapshot().moment, 'thought');
  assert.equal(ctl.openThought(), false, 'one dialog at a time');
  moments.log[0].opts.onSave('今天很开心');
  assert.deepEqual(engine.calls.notes[0], { text: '今天很开心', kind: 'thought', prompt: null });
  assert.equal(ctl.snapshot().running, true);
  assert.equal(ctl.openThought(), true);
  moments.log[1].opts.onCancel();
  assert.equal(engine.calls.notes.length, 1, 'cancel writes nothing');
  assert.equal(ctl.snapshot().running, true);
  ctl.destroy();
});

test('notes fall back to the life record when the engine has no notes API', () => {
  const { ctl, state, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
  const entries = ctl.addNote('一句话', 'thought');
  assert.equal(entries.length, 1);
  assert.deepEqual(state.notes, [{ year: 2000, age: 0, kind: 'thought', prompt: null, text: '一句话' }]);
  assert.ok(state.log.includes(entries[0]));
  assert.ok(events.some(([e]) => e === 'log'));
  assert.deepEqual(ctl.addNote('   '), [], 'empty notes are ignored');
  ctl.destroy();
});

test('stars: toggled through the engine, saved, max 12 with a refusal that changes nothing', () => {
  const { ctl, state, saves, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, v2: {} });
  state.log[0].id = '2000-1';
  assert.equal(ctl.has('toggleStar'), true);
  const n = saves.n;
  assert.deepEqual(ctl.toggleStar('2000-1'), { starred: true });
  assert.equal(ctl.isStarred('2000-1'), true);
  assert.equal(ctl.starCount(), 1);
  assert.equal(ctl.starMax(), 12);
  assert.ok(saves.n > n);
  assert.ok(events.some(([e, p]) => e === 'changed' && p.what === 'stars' && p.starred === true));
  assert.deepEqual(ctl.toggleStar('2000-1'), { starred: false });
  state.stars = Array.from({ length: 12 }, (_, i) => `x${i}`);
  const n2 = saves.n;
  assert.deepEqual(ctl.toggleStar('2000-1'), { starred: false, full: true });
  assert.equal(saves.n, n2, 'a refused star is not saved');
  ctl.destroy();
  const plain = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
  assert.equal(plain.ctl.has('toggleStar'), false);
  assert.equal(plain.ctl.toggleStar('x'), null);
  assert.equal(plain.ctl.hasFocus(), false);
  assert.deepEqual(plain.ctl.focusOptions(), []);
  assert.equal(plain.ctl.setFocus('study'), false);
  plain.ctl.destroy();
});

test('focus: options from age 6, the chosen focus is stored through the engine, null goes back to auto', () => {
  const { ctl, engine, state, saves, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 }, v2: {} });
  assert.equal(ctl.hasFocus(), true);
  assert.deepEqual(ctl.focusOptions(), [], 'nothing before age 6');
  state.age = 8;
  assert.deepEqual(ctl.focusOptions().map((o) => o.id), ['study', 'love']);
  assert.equal(ctl.focus, null);
  const n = saves.n;
  assert.equal(ctl.setFocus('study'), true);
  assert.equal(ctl.focus, 'study');
  assert.equal(ctl.snapshot().focus, 'study');
  assert.ok(saves.n > n);
  assert.ok(events.some(([e, p]) => e === 'changed' && p.what === 'focus' && p.focus === 'study'));
  assert.equal(ctl.setFocus('auto'), true);
  assert.deepEqual(engine.calls.focus, ['study', null]);
  assert.equal(ctl.focus, null);
  state.history[state.history.length - 1].focus = 'study';
  assert.equal(ctl.yearFocus(), 'study', "the current year's focus comes from its history row");
  ctl.destroy();
});

test('a decision can be set aside: the clock stays stopped, a thought can be written, and it comes back', async () => {
  const { ctl, overlay, moments, events } = setup({ v2: {} });
  ctl.setAutoChoose(true);
  ctl.start();
  ctl.skipToDecision();
  await waitFor(() => overlay.log.length === 1, 2000, 'overlay');
  assert.equal(typeof overlay.log[0].opts.onDismiss, 'function');
  overlay.log[0].opts.onDismiss();
  assert.equal(overlay.log[0].closed, true);
  let sn = ctl.snapshot();
  assert.equal(sn.waiting, true);
  assert.equal(sn.flow, 'decision');
  assert.equal(sn.running, false);
  assert.ok(events.some(([e, v]) => e === 'waiting' && v === true));
  ctl.detach();
  ctl.attach();
  assert.equal(overlay.log.length, 1, 'leaving and coming back keeps it set aside');
  assert.equal(ctl.openThought(), true, 'a note can be written while the decision waits');
  moments.log[0].opts.onCancel();
  assert.equal(ctl.snapshot().waiting, true);
  assert.equal(ctl.snapshot().running, false);
  assert.equal(ctl.reopenDecision(), true);
  assert.equal(overlay.log.length, 2);
  assert.equal(overlay.log[1].opts.auto, false, 'no auto countdown when the player comes back to it');
  sn = ctl.snapshot();
  assert.equal(sn.waiting, false);
  assert.equal(ctl.reopenDecision(), false);
  const res = await overlay.log[1].opts.onChoose({ optionId: 'a' }, overlay.log[1].decision, {});
  assert.ok(res.resolution);
  overlay.log[1].opts.onContinue();
  assert.equal(ctl.snapshot().running, true);
  ctl.destroy();
});

test('auto-choose texture: saved in the settings, unknown ids refused, global settings follow into the life', () => {
  const saved = [];
  const { ctl, state } = setup({ appOver: { saveSettings(p) { saved.push(p); } } });
  assert.equal(AUTO_TEXTURES.length, 8);
  assert.equal(textureLabel('family'), '顾家');
  assert.equal(textureLabel('nope'), '顺其自然');
  assert.equal(ctl.texture, 'normal');
  assert.equal(ctl.setTexture('family'), true);
  assert.equal(state.settings.autoTexture, 'family');
  assert.deepEqual(saved[saved.length - 1], { autoTexture: 'family' });
  assert.equal(ctl.setTexture('chaos'), false);
  bus.emit('settings', { autoTexture: 'career', reflections: false, music: false });
  assert.equal(state.settings.autoTexture, 'career');
  assert.equal(state.settings.reflections, false);
  assert.equal(ctl.snapshot().texture, 'career');
  ctl.applySettings({ gentle: true });
  assert.equal(state.settings.gentle, true);
  ctl.destroy();
});

test('panel edits announced on the bus refresh the screen and are saved once, shortly after the last one', async () => {
  const { ctl, state, saves, events } = setup({ engineOpts: { decisionAges: [], deathAge: 99 } });
  const n = saves.n;
  bus.emit('life:changed', { source: 'panel', panel: 'money', kind: 'habit', state, year: state.year });
  bus.emit('life:changed', { source: 'panel', panel: 'money', what: 'allocation', id: state.id });
  assert.ok(events.some(([e, p]) => e === 'changed' && p.external && p.what === 'habit'));
  assert.ok(events.some(([e, p]) => e === 'changed' && p.external && p.what === 'allocation'));
  assert.equal(saves.n, n, 'not written on every step');
  await waitFor(() => saves.n === n + 1, 2000, 'debounced save');
  await sleep(450);
  assert.equal(saves.n, n + 1, 'one save for the burst');
  bus.emit('life:changed', { source: 'panel', panel: 'money', kind: 'habit', id: 'another-life' });
  assert.equal(events.filter(([e, p]) => e === 'changed' && p.external).length, 2, 'other lives are ignored');
  ctl.destroy();
});

test('moments.cleanText strips control and bidi characters and counts characters, not code units', () => {
  assert.equal(moments.cleanText('  你好‮ 世界\n\n ', 200), '你好 世界');
  assert.equal(moments.cleanText('一二三四五六七八九十一二三', 12), '一二三四五六七八九十一二');
  assert.equal(moments.cleanText('😀😀😀', 2), '😀😀');
  assert.equal(moments.cleanText(null), '');
  assert.equal(moments.NAME_MAX, 12);
  assert.equal(moments.NOTE_MAX, 200);
});
