// GameController: drives one life in real time (CONTRACT §8, interactivity layer §10).
// - real-time loop (requestAnimationFrame, timer fallback); seconds per year = lifeMinutes*60 / life expectancy at birth
// - speeds 0.5x..16x, pause/resume with independent pause reasons (user, hidden tab, decision, moments, away, death)
// - decision flow: director.getDecision -> openDecision overlay -> director.resolveChoice -> engine.applyResolution;
//   the overlay can be set aside ("先看看再选") and brought back from the '有一个抉择正在等你' pill
// - interactivity (§10): the year's focus (重心), small inline choices that never stop the clock (auto-resolved when
//   the year ends), child naming and reflection moments (pause the clock), ✎ thought notes, stars on log lines,
//   the auto-choose texture; every interaction autosaves and is announced on the bus as 'life:changed'
// - custom action flow ("主动选择"), prefetch one year ahead, autosave every year, death flow
// Events: 'year' (YearResult), 'decision' (Decision), 'resolved' ({decision, choice, resolution, entries}),
//         'death' (DeathRecord), 'ai' (status text, '' = idle), 'tick' (fraction of the current year),
//         plus 'state' (control snapshot), 'skip' (boolean), 'log' (LogEntry[] added outside a year step),
//         'small' ({type:'new'|'answered'|'auto', small, optionId?, entries?}), 'moment' ({kind, open}),
//         'waiting' (boolean: a decision was set aside) and 'changed' ({what, ...}) after any interaction.

import * as engine from '../core/engine.js';
import * as worldMod from '../core/world.js';
import * as decisionsMod from '../core/decisions.js';
import * as directorMod from '../ai/director.js';
import * as saves from '../social/saves.js';
import { Rng, hashString } from '../core/rng.js';
import { storage, reducedMotion, bus } from './dom.js';
import { openDecision } from './screens/decision.js';
import { openNaming, openReflection, openThought, cleanText, NOTE_MAX } from './screens/moments.js';

export const SPEEDS = [0.5, 1, 2, 4, 8, 12, 16];
const SPEED_KEY = 'll2090.speed';
const DEFAULT_LIFE_MINUTES = 30;
const DEFAULT_LE = 72;
const SKIP_STEP_MS = 55;        // visible fast-forward: one year every ~55 ms
const SKIP_MAX_YEARS = 130;
const MAX_FRAME_DT = 0.25;      // seconds; long frames never jump more than this
const STAR_MAX = 12;
const EXTERNAL_SAVE_MS = 350;   // a panel's edits are saved this long after the last one

/**
 * Auto-choose "textures" (settings.autoTexture): how automatic choices and the auto focus lean (CONTRACT §10).
 * Same names as the settings screen (app.js AUTO_TEXTURES), so the player sees one vocabulary everywhere.
 */
export const AUTO_TEXTURES = [
  { id: 'normal', label: '顺其自然', hint: '按这个人当时的处境和性格去选，不刻意偏向哪一边。' },
  { id: 'steady', label: '求稳', hint: '更看重安全和确定，少冒险，慢一点也没关系。' },
  { id: 'adventure', label: '闯荡', hint: '愿意冒险、换个环境，抓住机会往外走。' },
  { id: 'family', label: '顾家', hint: '家人和亲密关系放在前面，常常为家里让一步。' },
  { id: 'career', label: '重事业', hint: '学业和工作优先，愿意为前途多吃些苦。' },
  { id: 'free', label: '随心', hint: '跟着兴趣走，不太在意别人的期待和眼光。' },
  { id: 'comfort', label: '安逸', hint: '过得舒服最要紧，能不折腾就不折腾。' },
  { id: 'giving', label: '乐于付出', hint: '愿意帮助别人，舍得为他人花时间和钱。' },
];
const TEXTURE_IDS = AUTO_TEXTURES.map((t) => t.id);
// settings of the interactivity layer that follow the global settings into the life being played
const V2_KEYS = ['autoTexture', 'gentle', 'music', 'reflections', 'compareIso', 'compareYear'];

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const hasDoc = () => typeof document !== 'undefined';
const raf = (fn) => (typeof requestAnimationFrame === 'function'
  ? { id: requestAnimationFrame(fn), kind: 'raf' }
  : { id: setTimeout(() => fn(now()), 50), kind: 'timer' });
const cancelRaf = (h) => {
  if (!h) return;
  if (h.kind === 'raf' && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h.id);
  else clearTimeout(h.id);
};
const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : undefined);
const quiet = (p) => { if (p && typeof p.then === 'function') p.then(null, () => {}); return p; };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

export function normSpeed(x) {
  const v = Number(x);
  if (!isFinite(v) || v <= 0) return 1;
  return SPEEDS.reduce((best, s) => (Math.abs(Math.log(s / v)) < Math.abs(Math.log(best / v)) ? s : best), 1);
}

/** Label of an auto-choose texture id ('顺其自然' for unknown ids). */
export function textureLabel(id) {
  return (AUTO_TEXTURES.find((t) => t.id === id) || AUTO_TEXTURES[0]).label;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers used by the game and death screens

export function countryName(data, iso3) {
  if (!iso3) return '未知';
  try { return data?.country?.(iso3)?.name || data?.countries?.[iso3]?.name || iso3; } catch { return iso3; }
}

/**
 * Archive number shown on registry documents, stable per life. Same format as cards.archiveNumber
 * (LL-<year>-<ISO3>-<6 hex>), used when the shell does not provide app.archiveNo.
 */
export function archiveNumber(state) {
  const b = state?.birth || {};
  const key = String(state?.id ?? state?.seed ?? `${b.name}|${b.date}|${b.time}|${b.country}`);
  const hx = hashString(key).toString(16).toUpperCase().padStart(8, '0').slice(0, 6);
  const year = b.year ?? (typeof b.date === 'string' && /^\d{4}/.test(b.date) ? b.date.slice(0, 4) : '0000');
  return `LL-${year}-${b.country || 'XXX'}-${hx}`;
}

const worldCache = new Map();
/** World for a life: app.world when it matches, otherwise createWorld(data, worldSeed) (cached). */
export function worldFor(app, state) {
  if (!state) return null;
  const seed = state.worldSeed;
  if (app?.world && app.world.seed === seed) return app.world;
  const forced = state.forcedBranches || state.worldBranches || undefined;
  const key = `${seed}|${forced ? JSON.stringify(forced) : ''}`;
  if (worldCache.has(key)) return worldCache.get(key);
  let w = null;
  try { w = worldMod.createWorld?.(app.data, seed, forced) || null; } catch (e) { console.error('[controller] createWorld', e); }
  if (w) {
    worldCache.set(key, w);
    if (worldCache.size > 4) worldCache.delete(worldCache.keys().next().value);
  }
  return w;
}

let sharedDirector = null;
let sharedDirectorData = null;
/**
 * The AI director instance (src/ai/director.js createDirector) for this app and world. Uses app.director when the
 * shell provides one; otherwise one shared instance per DataStore, switched to the life's world with setWorld().
 */
export function directorFor(app, world) {
  let d = app && app.director && typeof app.director.getDecision === 'function' ? app.director : null;
  if (!d) {
    if (!sharedDirector || sharedDirectorData !== app.data) {
      if (typeof directorMod.createDirector !== 'function') return null;
      try {
        sharedDirector = directorMod.createDirector({ data: app.data, world, decisions: decisionsMod, engine });
        sharedDirectorData = app.data;
      } catch (e) {
        console.error('[controller] createDirector', e);
        return null;
      }
    }
    d = sharedDirector;
  }
  if (world && typeof d.setWorld === 'function' && (typeof d.getWorld !== 'function' || d.getWorld() !== world)) d.setWorld(world);
  return d;
}

/** Period life expectancy at birth for this person's birth country/year/sex (years). */
export function lifeExpAtBirth(app, state, world) {
  const b = state?.birth || {};
  const sex = b.sex || state?.person?.sex || 'female';
  let le = state?.dead?.lifeExpAtBirth;
  if (!(le > 0)) { try { le = world?.lifeExpectancy?.(b.country, b.year, sex); } catch { le = null; } }
  if (!(le > 0)) {
    try {
      le = app?.data?.series?.(b.country, sex === 'male' ? 'le_m' : 'le_f', b.year)
        ?? app?.data?.series?.(b.country, 'le', b.year);
    } catch { le = null; }
  }
  return le > 15 && le < 120 ? le : DEFAULT_LE;
}

/**
 * Extract a (possibly partial) string field from streamed text. AI output streams as JSON
 * ({"narrative":"…), so show only the field's prose; plain text is returned as is.
 */
export function streamField(text, field) {
  if (typeof text !== 'string' || !text) return '';
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('```') && !t.includes(`"${field}"`)) return text;
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(t);
  if (!m) return '';
  return m[1]
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\(["\\/])/g, '$1')
    .replace(/\\$/, '');
}

/** Accumulate streamed text whether the source sends deltas or the full text so far. */
export function makeStreamAccumulator() {
  let acc = '';
  return (chunk) => {
    const c = typeof chunk === 'string' ? chunk : (chunk && typeof chunk.text === 'string' ? chunk.text : '');
    if (!c) return acc;
    acc = c.startsWith(acc) ? c : acc + c;
    return acc;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Biography jobs (started at death by the controller, picked up by the death screen; one per life)

const bioJobs = new Map();

function fallbackBiography(state, data) {
  const p = state.person || {};
  const b = state.birth || {};
  const d = state.dead || {};
  const name = p.name || b.name || '这个人';
  const parts = [`${name}于 ${b.year} 年出生在${countryName(data, b.country)}${b.urban ? '的城市' : '的乡村'}。`];
  const ch = (state.decisions || []).filter((x) => x && x.choice).slice(-3);
  if (ch.length) parts.push(`这一生里，${ch.map((x) => `${x.age} 岁时选择了「${String(x.choice).slice(0, 24)}」`).join('；')}。`);
  const kids = (p.children || []).length;
  if (kids) parts.push(`有过 ${kids} 个孩子。`);
  if (p.country && p.country !== b.country) parts.push(`后来在${countryName(data, p.country)}生活。`);
  if (d.year) parts.push(`${d.year} 年，因${d.cause?.name || '病'}离世，享年 ${d.age} 岁。`);
  return { biography: parts.join(''), epitaph: '认真地来过，也被认真地记住。', source: 'local', title: '', highlights: [] };
}

function normalizeBio(r, state, data) {
  if (!r) return fallbackBiography(state, data);
  if (typeof r === 'string') return { biography: r, epitaph: '', source: 'ai', title: '', highlights: [] };
  const biography = r.biography || r.bio || r.text || r.story || '';
  const epitaph = r.epitaph || r.epigraph || '';
  if (!biography) return fallbackBiography(state, data);
  return {
    biography: String(biography), epitaph: String(epitaph || ''), source: r.source || 'ai', title: r.title || '',
    highlights: Array.isArray(r.highlights) ? r.highlights.filter((x) => typeof x === 'string') : [],
  };
}

/**
 * Start (or get) the biography for a dead life (director.biography, streamed; `director` defaults to the shared
 * instance from directorFor). Returns a job:
 * { promise -> {biography, epitaph, title, highlights, source}, text (streamed so far), done, result,
 *   subscribe(fn(text)) -> unsubscribe }
 */
export function biographyFor(app, state, world, director) {
  if (!state) return null;
  const key = state.id || state.seed;
  if (bioJobs.has(key)) return bioJobs.get(key);
  const subs = new Set();
  const acc = makeStreamAccumulator();
  const job = {
    text: '', done: false, result: null,
    subscribe(fn) { subs.add(fn); if (job.text) { try { fn(job.text); } catch { /* ignore */ } } return () => subs.delete(fn); },
  };
  const onText = (chunk) => {
    if (job.done) return;
    job.text = acc(chunk);
    for (const fn of subs) { try { fn(job.text); } catch { /* ignore */ } }
  };
  const w = world || worldFor(app, state);
  job.promise = Promise.resolve()
    .then(() => {
      const d = director && typeof director.biography === 'function' ? director : directorFor(app, w);
      if (!d || typeof d.biography !== 'function') return null;
      return d.biography(state, onText);
    })
    .then((r) => normalizeBio(r, state, app.data), (e) => { console.warn('[controller] biography', e); return fallbackBiography(state, app.data); })
    .then((r) => { job.done = true; job.result = r; return r; });
  bioJobs.set(key, job);
  if (bioJobs.size > 6) bioJobs.delete(bioJobs.keys().next().value);
  return job;
}

// ---------------------------------------------------------------------------------------------------------------

const RISK_WEIGHT = { low: 3, mid: 2, high: 1 };

function validDecision(d) {
  return !!(d && typeof d === 'object' && typeof d.title === 'string' && Array.isArray(d.options) && d.options.length >= 2);
}
function sameDecision(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return a.title === b.title && JSON.stringify((a.options || []).map((o) => [o.id, o.label])) === JSON.stringify((b.options || []).map((o) => [o.id, o.label]));
  } catch { return false; }
}
function asResolution(r) {
  if (!r || typeof r !== 'object') return null;
  if (typeof r.narrative === 'string') return r;
  if (r.resolution && typeof r.resolution.narrative === 'string') return r.resolution;
  return null;
}

export class GameController {
  /**
   * @param {object} app    App object (CONTRACT §8)
   * @param {object} state  LifeState
   * @param {object} [deps] optional overrides {engine, director (instance), saves, decisions, openDecision,
   *                        moments: {openNaming, openReflection, openThought}, world, deathDelayMs}
   */
  constructor(app, state, deps = {}) {
    this.app = app;
    this.state = state;
    this.data = app.data;
    this.deps = { engine, saves, decisions: decisionsMod, openDecision, moments: { openNaming, openReflection, openThought }, ...deps };
    this.world = deps.world || worldFor(app, state);
    this.dir = deps.director || directorFor(app, this.world) || {};
    this.listeners = new Map();
    this.reasons = new Set();
    this.speed = normSpeed(storage.get(SPEED_KEY, 1));
    this.progress = 0;
    this.started = false;
    this.destroyed = false;
    this.skipping = false;
    this.flow = null;          // {kind:'decision'|'custom', phase, decision, minimized?, ...}
    this.overlay = null;       // close() function returned by openDecision
    this.moment = null;        // {kind:'naming'|'reflect'|'thought', reason, close}
    this.lastResult = null;
    this.aiText = '';
    this._frameH = null;
    this._skipTimer = 0;
    this._skipSeq = 0;
    this._resumeSkip = false;
    this._deathTimer = 0;
    this._extSave = 0;
    this._dying = false;
    this._ended = false;
    this._storyAsked = false;
    this._last = 0;
    this._smallId = isObj(state.smallPending) ? state.smallPending.id ?? null : null;
    this.deathDelayMs = Number.isFinite(deps.deathDelayMs) ? Math.max(0, deps.deathDelayMs) : null;
    this.leBirth = lifeExpAtBirth(app, state, this.world);
    this._onVis = () => this._visibility();
    this._frame = this._frame.bind(this);
    this._syncSettings(app.settings);
    this._offBus = [
      bus.on('settings', (s) => { if (!this.destroyed) this._syncSettings(s); }),
      // panels (家人与生活 / 花钱·投资) may change the life through the engine and announce it here
      bus.on('life:changed', (p) => this._external(p)),
    ];

    const prev = GameController.current;
    if (prev && prev !== this && !prev.destroyed) prev.destroy();
    GameController.current = this;
  }

  // ---- events ------------------------------------------------------------------------------------------------
  on(evt, fn) {
    let set = this.listeners.get(evt);
    if (!set) this.listeners.set(evt, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  emit(evt, payload) {
    const set = this.listeners.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (e) { console.error('[controller]', evt, e); }
    }
  }

  // ---- public controls ---------------------------------------------------------------------------------------
  start() {
    if (this.destroyed) return this;
    if (!this.started) {
      this.started = true;
      if (hasDoc()) {
        document.addEventListener('visibilitychange', this._onVis);
        if (document.hidden) this.reasons.add('hidden');
      }
    }
    this.reasons.delete('away');
    if (this.state.dead) { this._onDeath(true); return this; }
    this._reopen();
    this._birthStory();
    this._emitState();
    this._schedule(true);
    return this;
  }

  pause(reason = 'user') {
    if (reason === 'user' && this.skipping) this._stopSkip(false);
    this.reasons.add(reason);
    this._cancelFrame();
    this._emitState();
  }

  resume(reason = 'user') {
    this.reasons.delete(reason);
    if (reason === 'user') this.reasons.delete('error');
    this._emitState();
    this._schedule(true);
  }

  toggle() {
    if (this.reasons.has('user') || this.reasons.has('error')) this.resume('user');
    else this.pause('user');
  }

  setSpeed(x) {
    this.speed = normSpeed(x);
    storage.set(SPEED_KEY, this.speed);
    if (this.flow && this.overlay && typeof this.overlay.setSpeed === 'function') this.overlay.setSpeed(this.speed);
    this._emitState();
  }

  faster() { const i = SPEEDS.indexOf(this.speed); this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]); }
  slower() { const i = SPEEDS.indexOf(this.speed); this.setSpeed(SPEEDS[Math.max(0, i - 1)]); }

  get autoChoose() { return !!this.state.settings?.autoChoose; }

  /** True when the player paused the clock (the app shell checks this before pausing on navigation). */
  get paused() { return this.reasons.has('user') || this.reasons.has('error'); }

  /** Life settings changed in the settings screen (app.saveSettings already merged them into state.settings). */
  applySettings(patch = {}) {
    if (!this.state.settings) this.state.settings = {};
    for (const k of ['lifeMinutes', 'aiMode', 'decisionFreq', 'autoChoose', ...V2_KEYS]) {
      if (patch && k in patch) this.state.settings[k] = patch[k];
    }
    if (this.overlay && typeof this.overlay.setAuto === 'function') this.overlay.setAuto(this.autoChoose);
    this._emitState();
  }

  setAutoChoose(on) {
    const v = !!on;
    if (!this.state.settings) this.state.settings = {};
    this.state.settings.autoChoose = v;
    try { this.app.saveSettings?.({ autoChoose: v }); } catch { /* settings are optional */ }
    if (this.overlay && typeof this.overlay.setAuto === 'function') this.overlay.setAuto(v);
    this._save();
    this._emitState();
  }

  isRunning() {
    return this.started && !this.destroyed && !this.state.dead && !this.state.pending && !this.flow
      && !this.skipping && this.reasons.size === 0;
  }

  /** True when the player may start a skip or a custom action right now. */
  canAct() {
    return this.started && !this.destroyed && !this.state.dead && !this.state.pending && !this.flow && !this.moment && !this._dying;
  }

  secondsPerYear() {
    const minutes = Number(this.app.settings?.lifeMinutes) || Number(this.state.settings?.lifeMinutes) || DEFAULT_LIFE_MINUTES;
    return Math.max(0.4, (minutes * 60) / this.leBirth);
  }

  snapshot() {
    const f = this.flow;
    return {
      running: this.isRunning(),
      userPaused: this.reasons.has('user') || this.reasons.has('error'),
      hidden: this.reasons.has('hidden'),
      reasons: [...this.reasons],
      speed: this.speed,
      skipping: this.skipping,
      flow: f ? f.kind : null,
      phase: f ? f.phase : null,
      waiting: !!(f && f.kind === 'decision' && f.minimized),
      moment: this.moment ? this.moment.kind : null,
      small: isObj(this.state.smallPending) ? this.state.smallPending.id ?? null : null,
      pending: !!this.state.pending,
      autoChoose: this.autoChoose,
      texture: this.texture,
      focus: this.focus,
      dead: !!this.state.dead,
      canAct: this.canAct(),
      secondsPerYear: this.secondsPerYear() / this.speed,
      ai: this.aiText,
    };
  }

  /** Game screen mounted again. */
  attach() {
    if (this.destroyed) return;
    this.reasons.delete('away');
    if (this.started) {
      if (this.state.dead) { this._onDeath(true); return; }
      this._reopen();
      this._emitState();
      this._schedule(true);
    }
  }

  /** Game screen unmounted: stop the clock, close any overlay (a pending decision or moment re-opens on attach). */
  detach() {
    if (this.destroyed) return;
    this.reasons.add('away');
    this._resumeSkip = false;
    this._stopSkip(false);
    this._cancelFrame();
    if (this.overlay) {
      const close = this.overlay;
      this.overlay = null;
      try { close(); } catch { /* ignore */ }
    }
    if (this.moment) {
      const m = this.moment;
      this.moment = null;
      this.reasons.delete(m.reason);
      try { call(m.close); } catch { /* ignore */ }
    }
    const f = this.flow;
    if (f) {
      if (f.phase === 'resolved') this._endFlow(f, true);
      else if (f.phase === 'resolving') f.endOnResolve = true;
      else if (f.kind === 'custom') this._endFlow(f, true);
    }
    this._save();
    this._emitState();
  }

  destroy() {
    if (this.destroyed) return;
    this.detach();
    this.destroyed = true;
    clearTimeout(this._deathTimer);
    clearTimeout(this._extSave);
    if (hasDoc()) document.removeEventListener('visibilitychange', this._onVis);
    for (const off of this._offBus || []) { try { off(); } catch { /* ignore */ } }
    this._offBus = [];
    this.listeners.clear();
    if (GameController.current === this) GameController.current = null;
  }

  stop() { this.destroy(); }

  // ---- fast forward ------------------------------------------------------------------------------------------
  skipToDecision() {
    if (!this.canAct() || this.skipping) return false;
    this.reasons.delete('user');
    this.reasons.delete('error');
    this.skipping = true;
    this._resumeSkip = false;
    const token = ++this._skipSeq;
    this._cancelFrame();
    this.emit('skip', true);
    this._emitState();
    const instant = reducedMotion();
    let steps = 0;
    const live = () => this.skipping && !this.destroyed && token === this._skipSeq;
    const step = () => {
      this._skipTimer = 0;
      if (!live()) return;
      const t0 = now();
      do {
        const r = this._advance(true);
        steps++;
        if (!live()) return;                         // a decision, a moment or death stopped the skip
        if (!r || this.state.dead || this.state.pending || steps >= SKIP_MAX_YEARS) { this._stopSkip(true); return; }
        if (steps % 5 === 0) this._save();
      } while (instant && now() - t0 < 12);
      this._skipTimer = setTimeout(step, instant ? 0 : SKIP_STEP_MS);
    };
    step();
    return true;
  }

  _stopSkip(save) {
    if (!this.skipping) return;
    this.skipping = false;
    clearTimeout(this._skipTimer);
    this._skipTimer = 0;
    if (save) this._save();
    this.emit('skip', false);
    this._emitState();
    this._schedule(true);
  }

  // ---- custom action -----------------------------------------------------------------------------------------
  /** Open the "主动选择" dialog (pauses the clock until it is closed). */
  openCustomAction() {
    if (!this.canAct()) return false;
    this._stopSkip(false);
    const flow = { kind: 'custom', phase: 'choosing', decision: this._customDecision('') };
    this.flow = flow;
    this._cancelFrame();
    this._emitState();
    this.overlay = this.deps.openDecision(this.app, flow.decision, {
      state: this.state,
      data: this.data,
      world: this.world,
      custom: true,
      auto: false,
      speed: this.speed,
      onChoose: (choice, _used, hooks) => this.customAction(choice && choice.customText, hooks, flow),
      onCancel: () => this._endFlow(flow),
      onContinue: () => this._endFlow(flow),
    });
    return true;
  }

  /**
   * Run a free-text action for the current year. Resolves to {decision, choice, resolution, entries} or null.
   * When called directly (no dialog) it pauses the clock for the duration of the AI call.
   */
  async customAction(text, hooks = {}, flowIn = null) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean || this.state.dead || this.state.pending || this.destroyed) return null;
    let flow = flowIn;
    let own = false;
    if (!flow) {
      if (this.flow || this.moment) return null;
      flow = { kind: 'custom', phase: 'choosing' };
      this.flow = flow;
      own = true;
      this._stopSkip(false);
      this._cancelFrame();
      this._emitState();
    }
    let decision = this._customDecision(clean);
    flow.decision = decision;
    let choice = { customText: clean };
    flow.phase = 'resolving';
    if (this._aiUsable()) this._ai('AI 正在推演你的主动选择…');
    const acc = makeStreamAccumulator();
    const onText = (t) => { const full = acc(t); call(hooks && hooks.onText, streamField(full, 'narrative')); };
    let resolution = null;
    let source = 'local';
    try {
      const d = this.dir;
      if (typeof d.customAction === 'function') {
        const r = await d.customAction(this.state, clean, onText);
        resolution = asResolution(r);
        if (r && typeof r === 'object') {
          if (r.decision && typeof r.decision === 'object' && r.decision.id) decision = { ...decision, ...r.decision, options: [] };
          if (r.choice && typeof r.choice.customText === 'string' && r.choice.customText) choice = { customText: r.choice.customText };
          source = r.source || resolution?.source || 'local';
        }
      }
    } catch (e) { console.warn('[controller] customAction', e); }
    if (this.destroyed && !flow.endOnResolve) return null;
    if (!resolution) resolution = this._offlineResolution(decision, choice);
    flow.decision = decision;
    const payload = this._apply(decision, choice, resolution, true, null, source);
    flow.phase = 'resolved';
    flow.result = payload;
    this._ai('');
    if (own || flow.endOnResolve) this._endFlow(flow);
    return payload;
  }

  _customDecision(text) {
    const s = this.state;
    return {
      id: `custom-${s.year}-${(s.decisions || []).length}`,
      year: s.year, age: s.age, kind: 'custom', title: '主动选择',
      situation: text || '此刻，你想主动做点什么？',
      options: [], allowCustom: true, source: 'local',
    };
  }

  /** Choice the auto-chooser would make for this decision (deterministic per life + decision). */
  autoChoice(decision) {
    const d = decision || this.state.pending;
    if (!d) return null;
    const rng = new Rng(hashString(`${this.state.id}:${d.id}:auto`));
    try {
      const c = this.deps.decisions.autoChoose?.(this.state, d, rng);
      if (c && (c.optionId || c.customText) && (!c.optionId || (d.options || []).some((o) => o.id === c.optionId))) return c;
    } catch (e) { console.warn('[controller] autoChoose', e); }
    const opts = d.options || [];
    if (!opts.length) return null;
    const pick = rng.weighted(opts, (o) => RISK_WEIGHT[o.risk] || 2) || opts[0];
    return { optionId: pick.id };
  }

  // ---- interactivity layer (CONTRACT §10) --------------------------------------------------------------------
  /** Engine function by name when the engine provides it (the v2 API lands module by module). */
  _eng(name) {
    const e = this.deps.engine;
    const f = e && e[name];
    return typeof f === 'function' ? f : null;
  }

  /** True when the engine provides the named v2 function (e.g. 'toggleStar', 'resolveSmall'). */
  has(name) { return !!this._eng(name); }

  /** True when the engine offers the yearly focus (重心). */
  hasFocus() { return !!(this._eng('focusOptions') && this._eng('setFocus')); }

  /** Focus options for this year: [{id, label, hint, available, why?}] ([] before age 6 or without the engine API). */
  focusOptions() {
    const f = this._eng('focusOptions');
    if (!f || this.state.dead) return [];
    try {
      const r = f(this.data, this.world, this.state);
      return Array.isArray(r) ? r.filter((o) => o && o.id != null && o.label) : [];
    } catch (e) {
      console.warn('[controller] focusOptions', e);
      return [];
    }
  }

  /** The player's chosen focus id, or null while it is left to auto. */
  get focus() {
    const f = this.state.focus;
    return isObj(f) && f.current != null ? f.current : null;
  }

  /** What the current year is spent on (the history row's focus, player-chosen or auto), or null. */
  yearFocus() {
    const hist = Array.isArray(this.state.history) ? this.state.history : [];
    const row = hist.length ? hist[hist.length - 1] : null;
    return row && row.year === this.state.year && row.focus != null ? row.focus : null;
  }

  /** Choose the focus from now on (null / 'auto' = let auto decide each year). */
  setFocus(id) {
    const f = this._eng('setFocus');
    if (!f || this.state.dead) return false;
    const v = id == null || id === 'auto' ? null : String(id);
    try { f(this.state, v); } catch (e) { console.warn('[controller] setFocus', e); return false; }
    this._changed('focus', { focus: v });
    return true;
  }

  /** Spending habit (聚餐·送礼 / 孝亲费 / ...): level 0..2. */
  setHabit(key, level) {
    const f = this._eng('setHabit');
    if (!f || this.state.dead) return false;
    try { f(this.state, key, level); } catch (e) { console.warn('[controller] setHabit', e); return false; }
    this._changed('habits', { key, level });
    return true;
  }

  /** Where new savings go ({bank, balanced, stocks, crypto} weights, null = auto). */
  setAllocation(alloc) {
    const f = this._eng('setAllocation');
    if (!f || this.state.dead) return false;
    try { f(this.state, alloc == null ? null : alloc); } catch (e) { console.warn('[controller] setAllocation', e); return false; }
    this._changed('allocation', { allocation: alloc == null ? null : alloc });
    return true;
  }

  /** The auto-choose texture of this life (settings.autoTexture). */
  get texture() {
    const t = this.state.settings?.autoTexture || this.app.settings?.autoTexture;
    return TEXTURE_IDS.includes(t) ? t : 'normal';
  }

  setTexture(id) {
    if (!TEXTURE_IDS.includes(id)) return false;
    if (!this.state.settings) this.state.settings = {};
    this.state.settings.autoTexture = id;
    try { this.app.saveSettings?.({ autoTexture: id }); } catch { /* settings are optional */ }
    this._changed('texture', { texture: id });
    return true;
  }

  /** Turn the reflection pauses (5/15/30/50/70) on or off, for this life and as the global setting. */
  setReflections(on) {
    const v = !!on;
    if (!this.state.settings) this.state.settings = {};
    this.state.settings.reflections = v;
    try { this.app.saveSettings?.({ reflections: v }); } catch { /* settings are optional */ }
    this._changed('settings', { reflections: v }, false);
  }

  /** Star / unstar a log line as 值得记住的时刻 (max 12). Returns {starred, full?, moved?} or null. */
  toggleStar(entryId) {
    const f = this._eng('toggleStar');
    if (!f || entryId == null) return null;
    let r = null;
    try { r = f(this.state, entryId); } catch (e) { console.warn('[controller] toggleStar', e); return null; }
    if (!isObj(r)) return null;
    if (!r.full) this._changed('stars', { entryId, starred: !!r.starred, moved: r.moved ?? null });
    return r;
  }

  isStarred(entryId) {
    return Array.isArray(this.state.stars) && this.state.stars.includes(entryId);
  }

  starCount() { return Array.isArray(this.state.stars) ? this.state.stars.length : 0; }

  starMax() { return STAR_MAX; }

  /**
   * Answer the pending small choice (engine.resolveSmall). optionId null lets the engine decide (texture-biased).
   * Never pauses the clock. Returns {type, small, optionId, entries} or null.
   */
  answerSmall(optionId) {
    return this._resolveSmall(optionId == null ? null : optionId, false);
  }

  _resolveSmall(optionId, batch) {
    const s = this.state;
    const sm = s.smallPending;
    const f = this._eng('resolveSmall');
    if (!isObj(sm) || !f || s.dead || this.destroyed) return null;
    if (optionId != null && !(sm.options || []).some((o) => o && o.id === optionId)) return null;
    let entries = [];
    try { entries = f(this.data, this.world, s, optionId) || []; } catch (e) { console.warn('[controller] resolveSmall', e); entries = []; }
    entries = this._ensureLogged(entries);
    if (s.smallPending === sm || (isObj(s.smallPending) && s.smallPending.id === sm.id)) s.smallPending = null;
    this._smallId = isObj(s.smallPending) ? s.smallPending.id ?? null : null;
    const payload = { type: optionId == null ? 'auto' : 'answered', small: sm, optionId, entries };
    this.emit('small', payload);
    if (entries.length) this.emit('log', entries);
    this._changed('small', { small: sm, optionId, entries }, !batch);
    return payload;
  }

  /** A small choice that was not answered is decided when its year ends (before the next year is stepped). */
  _expireSmall(batch) {
    const sm = this.state.smallPending;
    if (!isObj(sm) || !this._eng('resolveSmall')) return;
    const exp = Number(sm.expiresYear);
    if (Number.isFinite(exp) && exp > this.state.year + 1) return;
    this._resolveSmall(null, batch);
  }

  /** After a year step: announce a newly offered small choice. */
  _noteSmall() {
    const sm = this.state.smallPending;
    if (isObj(sm)) {
      const id = sm.id ?? `${sm.year}-${sm.title}`;
      if (id !== this._smallId) {
        this._smallId = id;
        this.emit('small', { type: 'new', small: sm });
      }
    } else {
      this._smallId = null;
    }
  }

  /** Write a note (thought / reflection / final) for the current year. Returns the log entries it added. */
  addNote(text, kind = 'thought', prompt = null) {
    const clean = cleanText(text, NOTE_MAX);
    const s = this.state;
    if (!clean || this.destroyed) return [];
    let entries = [];
    const f = this._eng('addNote');
    if (f) {
      try { entries = f(s, clean, kind, prompt == null ? null : String(prompt)) || []; } catch (e) { console.warn('[controller] addNote', e); entries = []; }
      entries = this._ensureLogged(entries);
    } else {
      // engine without the notes API: keep the note on the life and show it as a log line
      if (!Array.isArray(s.notes)) s.notes = [];
      s.notes.push({ year: s.year, age: s.age, kind, prompt: prompt == null ? null : String(prompt), text: clean });
      const e = { id: `${s.year}-note-${s.notes.length}`, year: s.year, age: s.age, kind: 'system', text: `${kind === 'reflection' ? '你写下' : '你记下'}：「${clean}」`, tone: 0, tags: ['note', kind], source: 'engine' };
      entries = this._ensureLogged([e]);
    }
    if (entries.length) this.emit('log', entries);
    this._changed('notes', { kind, entries });
    return entries;
  }

  /** Open the ✎ 写下想法 dialog (pauses the clock while it is open). */
  openThought() {
    const M = this.deps.moments || {};
    if (typeof M.openThought !== 'function' || this.destroyed || this.state.dead || this._dying || this.moment) return false;
    if (this.flow && !(this.flow.kind === 'decision' && this.flow.minimized)) return false;
    if (this.skipping) this._stopSkip(false);
    const m = { kind: 'thought', reason: 'note', close: null };
    this.moment = m;
    this.reasons.add(m.reason);
    this._cancelFrame();
    try {
      m.close = M.openThought(this.app, {
        state: this.state, data: this.data, world: this.world,
        onSave: (text) => { if (this.moment === m) this.addNote(text, 'thought'); this._endMoment(m); },
        onCancel: () => this._endMoment(m),
      });
    } catch (e) {
      console.error('[controller] openThought', e);
      this._endMoment(m);
      return false;
    }
    this._emitState();
    this.emit('moment', { kind: m.kind, open: true });
    return true;
  }

  /** A moment the engine asked for and the UI can show: 'naming' | 'reflect' | null. Settles the rest silently. */
  _momentDue() {
    const s = this.state;
    if (s.dead || this.destroyed) return null;
    const M = this.deps.moments || {};
    if (isObj(s.namingPending)) {
      if (typeof M.openNaming === 'function') return 'naming';
      this._keepName(s.namingPending);
    }
    if (isObj(s.reflectPending)) {
      if (this._reflectionsOff() || typeof M.openReflection !== 'function') s.reflectPending = null;
      else return 'reflect';
    }
    return null;
  }

  _reflectionsOff() {
    return this.app.settings?.reflections === false || this.state.settings?.reflections === false;
  }

  _openMoment(kind) {
    if (this.moment || this.destroyed || this.reasons.has('away') || this.state.dead) return false;
    const M = this.deps.moments || {};
    const s = this.state;
    const m = { kind, reason: kind === 'naming' ? 'naming' : 'reflect', close: null };
    this.moment = m;
    this.reasons.add(m.reason);
    this._cancelFrame();
    const common = { state: s, data: this.data, world: this.world, auto: this.autoChoose, speed: this.speed };
    try {
      m.close = kind === 'naming'
        ? M.openNaming(this.app, {
          ...common,
          naming: s.namingPending,
          onName: (name) => this._finishNaming(m, name),
          onKeep: () => this._finishNaming(m, null),
        })
        : M.openReflection(this.app, {
          ...common,
          reflect: s.reflectPending,
          onSave: (text, o) => this._finishReflect(m, text, o),
          onSkip: (o) => this._finishReflect(m, null, o),
        });
    } catch (e) {
      console.error('[controller] moment', kind, e);
      if (kind === 'naming') this._keepName(s.namingPending);
      else s.reflectPending = null;
      this._endMoment(m);
      return false;
    }
    this._emitState();
    this.emit('moment', { kind, open: true });
    return true;
  }

  /** Keep the suggested name (the engine's first suggestion) when the player did not choose one. */
  _keepName(np) {
    const s = this.state;
    if (!isObj(np)) return [];
    let entries = [];
    const child = (s.person?.children || [])[np.childIndex];
    const suggestion = Array.isArray(np.suggestions) ? cleanText(np.suggestions[0], 12) : '';
    if (child && !child.name && suggestion) {
      const f = this._eng('nameChild');
      if (f) {
        try { entries = this._ensureLogged(f(s, np.childIndex, suggestion) || []); } catch (e) { console.warn('[controller] nameChild', e); }
      }
      if (!child.name) child.name = suggestion;
    }
    if (s.namingPending === np) s.namingPending = null;
    return entries;
  }

  _finishNaming(m, name) {
    if (this.moment !== m) return;
    const s = this.state;
    const np = s.namingPending;
    let entries = [];
    const clean = cleanText(name, 12);
    if (isObj(np) && clean) {
      const f = this._eng('nameChild');
      if (f) {
        try { entries = this._ensureLogged(f(s, np.childIndex, clean) || []); } catch (e) { console.warn('[controller] nameChild', e); }
      } else {
        const child = (s.person?.children || [])[np.childIndex];
        if (child) child.name = clean;
      }
      if (s.namingPending === np) s.namingPending = null;
    } else {
      entries = this._keepName(np);
    }
    if (entries.length) this.emit('log', entries);
    this._changed('naming', { name: clean || null, entries }, false);
    this._endMoment(m);
  }

  _finishReflect(m, text, opts = {}) {
    if (this.moment !== m) return;
    const s = this.state;
    const rp = s.reflectPending;
    if (text) this.addNote(text, 'reflection', isObj(rp) ? rp.prompt ?? null : null);
    if (opts && opts.never) this.setReflections(false);
    if (s.reflectPending === rp) s.reflectPending = null;
    this._endMoment(m);
  }

  _endMoment(m) {
    if (this.moment !== m) return;
    this.moment = null;
    this.reasons.delete(m.reason);
    this._save();
    this.emit('moment', { kind: m.kind, open: false });
    this._continue();
  }

  /** After a moment (or anything that held the clock): the next moment, the pending decision, the skip, or play. */
  _continue() {
    if (this.destroyed || this.state.dead) { this._emitState(); return; }
    if (this.reasons.has('away')) { this._emitState(); return; }
    if (!this.flow) {
      const next = this._momentDue();
      if (next && this._openMoment(next)) return;
      if (this.state.pending) { this._resumeSkip = false; this._beginDecision(this.state.pending); return; }
      if (this._resumeSkip) {
        this._resumeSkip = false;
        if (this.skipToDecision()) return;
      }
    }
    this._emitState();
    this._schedule(true);
  }

  /** Push engine-returned entries into state.log unless the engine already did (same object or same id). */
  _ensureLogged(entries) {
    if (!Array.isArray(entries)) return [];
    const list = entries.filter((e) => isObj(e) && typeof e.text === 'string');
    if (!list.length) return list;
    const s = this.state;
    if (!Array.isArray(s.log)) s.log = [];
    const tail = s.log.slice(-Math.max(60, list.length * 4));
    const objs = new Set(tail);
    const ids = new Set(tail.map((e) => e && e.id).filter((x) => x != null));
    for (const e of list) {
      if (objs.has(e) || (e.id != null && ids.has(e.id))) continue;
      s.log.push(e);
    }
    return list;
  }

  /** Bookkeeping after any interaction: autosave, control snapshot, local 'changed' and the bus 'life:changed'. */
  _changed(what, extra = {}, save = true) {
    if (save) this._save();
    this._emitState();
    this.emit('changed', { what, ...extra });
    bus.emit('life:changed', { what, state: this.state, year: this.state.year, source: 'controller', ...extra });
  }

  /**
   * Another module (a panel) changed this life and announced it on the bus: refresh the screen and save soon after
   * (debounced, so dragging through a panel's controls does not write the whole life on every step).
   */
  _external(p) {
    if (this.destroyed || !isObj(p) || p.source === 'controller') return;
    if ((p.state && p.state !== this.state) || (p.id != null && p.id !== this.state.id)) return;
    clearTimeout(this._extSave);
    this._extSave = setTimeout(() => { this._extSave = 0; if (!this.destroyed) this._save(); }, EXTERNAL_SAVE_MS);
    this._emitState();
    this.emit('changed', { what: p.what || p.kind || 'external', external: true });
  }

  /** Copy the interactivity settings (autoTexture, gentle, music, reflections, compare*) into the life. */
  _syncSettings(src) {
    if (!isObj(src)) return;
    if (!this.state.settings) this.state.settings = {};
    for (const k of V2_KEYS) if (k in src && src[k] !== undefined) this.state.settings[k] = src[k];
  }

  // ---- loop --------------------------------------------------------------------------------------------------
  _schedule(resetClock) {
    if (!this.isRunning()) return;
    if (resetClock || !this._frameH) this._last = now();
    if (!this._frameH) this._frameH = raf(this._frame);
  }

  _cancelFrame() {
    cancelRaf(this._frameH);
    this._frameH = null;
  }

  _frame() {
    this._frameH = null;
    if (!this.isRunning()) return;
    const t = now();
    const dt = Math.min(MAX_FRAME_DT, Math.max(0, (t - this._last) / 1000));
    this._last = t;
    this.progress += (dt * this.speed) / this.secondsPerYear();
    if (this.progress >= 1) {
      this.progress = 0;
      this._advance(false);
    }
    this.emit('tick', this.progress);
    if (this.isRunning()) this._frameH = raf(this._frame);
  }

  _visibility() {
    if (!hasDoc()) return;
    if (document.hidden) {
      this.reasons.add('hidden');
      this._cancelFrame();
      this._save();
    } else {
      this.reasons.delete('hidden');
    }
    this._emitState();
    this._schedule(true);
  }

  /** Step exactly one year. batch=true during fast-forward (no per-year save/prefetch). */
  _advance(batch) {
    const s = this.state;
    if (s.dead || s.pending || this.destroyed || this.moment) return null;
    this._expireSmall(batch);
    let result;
    try {
      result = this.deps.engine.stepYear(this.data, this.world, s);
    } catch (e) {
      console.error('[controller] stepYear', e);
      this._stopSkip(false);
      this.reasons.add('error');
      this._cancelFrame();
      this._emitState();
      call(this.app.toast, '推演引擎出了点问题，已暂停。可以再按一次继续。', 'bad');
      return null;
    }
    this.progress = 0;
    this.lastResult = result || null;
    this._noteSmall();
    this.emit('year', result || { year: s.year, age: s.age, entries: [], news: [], decision: null, died: s.dead, stats: s.stats });
    bus.emit('life:changed', { what: 'year', state: s, year: s.year, source: 'controller' });
    if (s.dead || (result && result.died)) {
      this._onDeath(false);
      return result;
    }
    const dec = s.pending || (result && result.decision);
    const moment = this._momentDue();
    if (moment || dec) {
      if (this.skipping) {
        this._resumeSkip = !!moment && !dec;   // a moment interrupts a skip; it carries on afterwards
        this._stopSkip(false);
      }
      this._save();
      if (moment && this._openMoment(moment)) return result;
      if (s.pending) this._beginDecision(s.pending);
      else this._continue();
      return result;
    }
    if (!batch) {
      this._save();
      this._prefetch();
    }
    return result;
  }

  // ---- decisions ---------------------------------------------------------------------------------------------
  _ai(text) {
    const t = text || '';
    if (t === this.aiText) return;
    this.aiText = t;
    this.emit('ai', t);
  }

  _aiUsable() {
    try { return typeof this.dir.usable === 'function' ? !!this.dir.usable(this.state) : false; } catch { return false; }
  }

  _prefetch() {
    const d = this.dir;
    if (typeof d.prefetch !== 'function' || this.state.dead) return;
    try { quiet(d.prefetch(this.state)); } catch (e) { console.warn('[controller] prefetch', e); }
  }

  /**
   * One AI-written birth story per life (director.birthStory), asked for while the first years play. Only an AI
   * story is added (the engine already logs the birth itself); it lands in the birth year's log group and in
   * state.aiNotes.birthStory, which later prompts use as narrative memory. Emits 'log'.
   */
  _birthStory() {
    const s = this.state;
    const d = this.dir;
    if (this._storyAsked || this.destroyed || s.dead || typeof d.birthStory !== 'function') return;
    if ((Number(s.age) || 0) > 1 || (s.aiNotes && s.aiNotes.birthStory)) return;
    if (!this._aiUsable()) return;
    this._storyAsked = true;
    const label = 'AI 正在书写你出生时的故事…';
    if (!this.aiText) this._ai(label);
    Promise.resolve()
      .then(() => d.birthStory(s))
      .then((r) => {
        if (this.destroyed || !r || r.source !== 'ai') return;
        const text = String(r.text || r.story || '').trim();
        if (!text) return;
        if (!s.aiNotes || typeof s.aiNotes !== 'object') s.aiNotes = { birthStory: null, lastSummary: null };
        s.aiNotes.birthStory = Array.from(text).slice(0, 600).join('');
        const by = s.birth && Number.isFinite(s.birth.year) ? s.birth.year : s.year;
        const entry = { id: `${by}-story`, year: by, age: 0, kind: 'birth', text, tone: 1, tags: ['story'], source: 'ai' };
        if (Array.isArray(s.log)) s.log.push(entry); else s.log = [entry];
        this._save();
        this.emit('log', [entry]);
      }, (e) => { console.warn('[controller] birthStory', e); })
      .then(() => { if (this.aiText === label) this._ai(''); });
  }

  /** Re-open whatever the current flow needs after start/attach. */
  _reopen() {
    if (this.reasons.has('away') || this.destroyed || this.moment) return;
    const f = this.flow;
    if (f && f.kind === 'decision' && f.phase === 'choosing' && !this.overlay && f.decision && !f.minimized) this._openDecisionOverlay(f);
    else if (!f) {
      const m = this._momentDue();
      if (m && this._openMoment(m)) return;
      if (this.state.pending) this._beginDecision(this.state.pending);
    }
  }

  async _beginDecision(pending) {
    if (this.flow || this.destroyed) return;
    const flow = { kind: 'decision', phase: 'loading', decision: pending, pending, pendingId: pending && pending.id };
    this.flow = flow;
    this._cancelFrame();
    this._emitState();
    this.emit('decision', pending);

    // The director answers at once with the offline decision (the engine's pending one) plus an `upgrade`
    // promise for the AI version tailored to this life (prefetched a year early when possible). The overlay opens
    // immediately and swaps the options in place if the upgrade arrives before the player chooses.
    const d = this.dir;
    let decision = pending;
    let upgrade = null;
    if (typeof d.getDecision === 'function') {
      try {
        let r = d.getDecision(this.state, undefined, { decision: pending });
        if (r && typeof r.then === 'function') r = await r;
        if (this.flow !== flow || this.destroyed) return;
        if (r && validDecision(r.decision)) decision = r.decision;
        else if (validDecision(r)) decision = r;
        const up = r && r.upgrade;
        if (up && typeof up.then === 'function') {
          const base = decision;
          upgrade = up.then((u) => (validDecision(u) && !sameDecision(u, base) ? u : null), () => null);
        }
      } catch (e) { console.warn('[controller] getDecision', e); }
    }
    if (!validDecision(decision)) decision = this._repairDecision(decision || pending);
    if (upgrade) {
      this._ai('AI 正在根据你的经历构思选项…');
      upgrade.then(() => { if (this.flow === flow && flow.phase !== 'resolving') this._ai(''); });
    } else {
      this._ai('');
    }
    const shown = { ...decision };
    delete shown.upgrade;
    if (upgrade) shown.upgrade = upgrade;
    flow.decision = shown;
    flow.phase = 'choosing';
    this._emitState();
    if (this.reasons.has('away')) return;   // re-opened on attach()
    this._openDecisionOverlay(flow);
  }

  _repairDecision(d) {
    const base = d && typeof d === 'object' ? d : {};
    const options = Array.isArray(base.options) ? base.options.filter((o) => o && o.id && o.label) : [];
    while (options.length < 2) {
      const id = ['a', 'b', 'c', 'd'][options.length];
      options.push(options.length === 0
        ? { id, label: '顺其自然', detail: '按眼下的日子继续过下去。', risk: 'low' }
        : { id, label: '做出改变', detail: '试着换一种活法。', risk: 'mid' });
    }
    return {
      id: base.id || `d-${this.state.year}-${this.state.age}`, year: base.year ?? this.state.year, age: base.age ?? this.state.age,
      kind: base.kind || 'milestone', title: base.title || '人生的岔路口', situation: base.situation || '眼前有几条路可以走。',
      options, allowCustom: true, source: base.source || 'local', context: base.context,
    };
  }

  _openDecisionOverlay(flow, { auto } = {}) {
    this.overlay = this.deps.openDecision(this.app, flow.decision, {
      state: this.state,
      data: this.data,
      world: this.world,
      auto: auto ?? this.autoChoose,
      speed: this.speed,
      onChoose: (choice, used, hooks) => this._resolve(flow, used || flow.decision, choice, hooks),
      onAuto: (d) => this.autoChoice(d || flow.decision),
      onUpgrade: (d) => { if (this.flow === flow && validDecision(d)) flow.decision = d; },
      onContinue: () => this._endFlow(flow),
      onDismiss: () => this.dismissDecision(flow),
    });
  }

  /** Set the open decision aside (the clock stays stopped); the game shows '有一个抉择正在等你'. */
  dismissDecision(flowIn) {
    const f = flowIn || this.flow;
    if (!f || f !== this.flow || f.kind !== 'decision' || f.phase !== 'choosing' || f.minimized) return false;
    f.minimized = true;
    if (this.overlay) {
      const close = this.overlay;
      this.overlay = null;
      try { close(); } catch { /* ignore */ }
    }
    this._emitState();
    this.emit('waiting', true);
    return true;
  }

  /** Bring a decision that was set aside back (from the pill). */
  reopenDecision() {
    const f = this.flow;
    if (!f || f.kind !== 'decision' || !f.minimized || this.moment || this.reasons.has('away') || this.destroyed) return false;
    f.minimized = false;
    // the player chose to look at it: no automatic countdown this time
    this._openDecisionOverlay(f, { auto: false });
    this._emitState();
    this.emit('waiting', false);
    return true;
  }

  async _resolve(flow, decision, choice, hooks = {}) {
    if (this.flow !== flow || flow.phase === 'resolving' || flow.phase === 'resolved') return flow.result || null;
    flow.phase = 'resolving';
    flow.minimized = false;
    flow.decision = decision;
    this._emitState();
    this._ai(this._aiUsable() ? 'AI 正在推演这个选择的后果…' : '');
    const acc = makeStreamAccumulator();
    const onText = (t) => { const full = acc(t); call(hooks && hooks.onText, streamField(full, 'narrative')); };
    const clean = choice && choice.customText != null
      ? { customText: String(choice.customText).replace(/\s+/g, ' ').trim().slice(0, 200) }
      : choice;
    let resolution = null;
    let source = 'local';
    try {
      const d = this.dir;
      if (typeof d.resolveChoice === 'function') {
        const r = await d.resolveChoice(this.state, decision, clean, { onText });
        resolution = asResolution(r);
        source = (r && r.source) || resolution?.source || 'local';
      }
    } catch (e) { console.warn('[controller] resolveChoice', e); }
    if (this.destroyed && !flow.endOnResolve) return null;
    if (!resolution) resolution = this._offlineResolution(decision, clean);
    const payload = this._apply(decision, clean, resolution, false, flow, source);
    flow.phase = 'resolved';
    flow.result = payload;
    this._ai('');
    this._emitState();
    if (flow.endOnResolve) this._endFlow(flow);
    return payload;
  }

  _offlineResolution(decision, choice) {
    const rng = new Rng(hashString(`${this.state.id}:${decision.id}:${JSON.stringify(choice)}`));
    try {
      const r = this.deps.decisions.resolveOffline?.(this.data, this.world, this.state, decision, choice, rng);
      if (r && typeof r.narrative === 'string') return r;
    } catch (e) { console.warn('[controller] resolveOffline', e); }
    const opt = (decision.options || []).find((o) => o.id === choice?.optionId);
    return {
      narrative: opt ? `你选择了「${opt.label}」。日子照常往前走，结果还要慢慢显现。` : '你试着去做了。世界没有立刻给出回应，但有些东西已经在悄悄改变。',
      effects: { health: 0, happiness: 0, knowledge: 0, relationships: 0, wealthDelta: 0 },
      set: {}, threads: [], feasible: true,
    };
  }

  _apply(decision, choice, resolution, custom, flow = null, source = 'local') {
    const s = this.state;
    let entries = [];
    try {
      entries = this.deps.engine.applyResolution(this.data, this.world, s, decision, choice, resolution) || [];
    } catch (e) {
      console.error('[controller] applyResolution', e);
      call(this.app.toast, '这个选择的后果没能完整记录下来。', 'warn');
    }
    // The answered decision must not stay pending (a *new* pending decision raised by the resolution is kept).
    if (!custom && s.pending && flow && this._isAnswered(s.pending, flow, decision)) s.pending = null;
    this._save();
    const payload = { decision, choice, resolution, entries, custom: !!custom, source };
    this.emit('resolved', payload);
    bus.emit('life:changed', { what: custom ? 'custom' : 'decision', state: s, year: s.year, source: 'controller' });
    return payload;
  }

  _isAnswered(pending, flow, decision) {
    if (!pending) return false;
    if (pending === flow.pending || pending === decision) return true;
    const id = pending.id;
    return id != null && (id === flow.pendingId || id === decision?.id);
  }

  _endFlow(flow, silent = false) {
    if (this.flow !== flow) return;
    this.flow = null;
    if (this.overlay) {
      const close = this.overlay;
      this.overlay = null;
      try { close(); } catch { /* ignore */ }
    }
    this._ai('');
    if (flow.minimized) this.emit('waiting', false);
    if (this.destroyed) return;
    if (this.state.dead) { this._onDeath(false); return; }
    if (this.state.pending && flow.kind === 'decision' && flow.phase === 'resolved' && this._isAnswered(this.state.pending, flow, flow.decision)) {
      // The engine did not clear the decision it raised; do not ask the same question twice.
      this.state.pending = null;
    }
    this._emitState();
    if (silent) return;
    if (this.state.pending) { this._beginDecision(this.state.pending); return; }
    const m = this._momentDue();
    if (m && this._openMoment(m)) return;
    this._prefetch();
    this._schedule(true);
  }

  // ---- death -------------------------------------------------------------------------------------------------
  _onDeath(immediate) {
    if (this._dying) {
      if (immediate && !this.reasons.has('away') && !this._ended) this._scheduleEnd(0);
      return;
    }
    this._dying = true;
    this._resumeSkip = false;
    this._stopSkip(false);
    this._cancelFrame();
    this.reasons.add('death');
    if (this.overlay) { const c = this.overlay; this.overlay = null; try { c(); } catch { /* ignore */ } }
    if (this.moment) {
      const m = this.moment;
      this.moment = null;
      this.reasons.delete(m.reason);
      try { call(m.close); } catch { /* ignore */ }
    }
    this.flow = null;
    this._ai('');
    this._save();
    this._finalSaved = true;   // the app archives the life and clears the autosave on 'death'; never write it back
    this.emit('death', this.state.dead);
    bus.emit('life:changed', { what: 'death', state: this.state, year: this.state.year, source: 'controller' });
    this._emitState();
    biographyFor(this.app, this.state, this.world, this.dir);   // start writing while the curtain falls
    const delay = immediate ? 0 : this.deathDelayMs != null ? this.deathDelayMs : reducedMotion() ? 900 : 2800;
    this._scheduleEnd(delay);
  }

  /**
   * Navigate to the death screen after `ms` (always asynchronous, so a screen that is still mounting never
   * re-enters the router). Skipped while the game screen is away; attach()/start() finish it later.
   */
  _scheduleEnd(ms) {
    clearTimeout(this._deathTimer);
    this._deathTimer = setTimeout(() => {
      this._deathTimer = 0;
      if (this.destroyed || this._ended || this.reasons.has('away')) return;
      this._endLife();
    }, Math.max(0, ms || 0));
  }

  _endLife() {
    if (this._ended) return;
    this._ended = true;
    clearTimeout(this._deathTimer);
    if (typeof this.app.endLife === 'function') this.app.endLife(this.state);
    else call(this.app.go, 'death', { state: this.state });
  }

  _save() {
    if (this._finalSaved) return;
    try { this.deps.saves.autosave?.(this.state); } catch (e) { console.warn('[controller] autosave', e); }
  }

  _emitState() {
    if (this.destroyed) return;
    this.emit('state', this.snapshot());
  }
}

GameController.current = null;
