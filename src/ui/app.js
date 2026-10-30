// App shell for 人生长河: screen router with a back stack and #anchor deep links, sticky header with navigation and
// AI / sharing status chips, toasts, in-page confirm modals, persisted settings, the life lifecycle
// (prepare -> start / resume -> end) around a GameController, and the life's side sheets (家人与生活 / 花钱·投资,
// a side sheet on wide screens and a bottom sheet on phones). Every screen receives the App object built here.

import { h, clear, storage, bus, reducedMotion } from './dom.js';
import { STORAGE_KEYS, FIRST_YEAR, HISTORY_END, LAST_YEAR, DATA_DATE, AI_MODES, REGIONS } from '../core/constants.js';
import { newSeed, hashString } from '../core/rng.js';
import * as worldMod from '../core/world.js';
import * as engineMod from '../core/engine.js';
import * as controllerMod from './controller.js';
import * as cards from './cards.js';
import * as saves from '../social/saves.js';
import * as aiMod from '../ai/claude.js';
import * as home from './screens/home.js';
import * as birth from './screens/birth.js';
import * as game from './screens/game.js';
import * as death from './screens/death.js';
import * as memorial from './screens/memorial.js';
import * as shared from './screens/shared.js';
import * as past from './screens/past.js';
import * as about from './screens/about.js';
import * as settingsScreen from './screens/settings.js';
import * as feedback from './screens/feedback.js';
import * as stories from './screens/stories.js';
import * as album from './screens/album.js';
import * as familyPanel from './screens/family.js';
import * as moneyPanel from './screens/money.js';

/** How automatic choices lean (CONTRACT §10 settings.autoTexture). Shown in settings and on the home screen. */
export const AUTO_TEXTURES = Object.freeze([
  // the game screen shows the same names (controller.js AUTO_TEXTURES / textureLabel): one vocabulary everywhere
  { id: 'normal', label: '顺其自然', sub: '按这个人当时的处境和性格去选，不刻意偏向哪一边。' },
  { id: 'steady', label: '求稳', sub: '更看重安全和确定，少冒险，慢一点也没关系。' },
  { id: 'adventure', label: '闯荡', sub: '愿意冒险、换个环境，抓住机会往外走。' },
  { id: 'family', label: '顾家', sub: '家人和亲密关系放在前面，常常为家里让一步。' },
  { id: 'career', label: '重事业', sub: '学业和工作优先，愿意为前途多吃些苦。' },
  { id: 'free', label: '随心', sub: '跟着兴趣走，不太在意别人的期待和眼光。' },
  { id: 'comfort', label: '安逸', sub: '过得舒服最要紧，能不折腾就不折腾。' },
  { id: 'giving', label: '乐于付出', sub: '愿意帮助别人，舍得为他人花时间和钱。' },
]);

/** The player's real birth year for the birthplace comparison (stored only in this browser). */
export const COMPARE_YEAR_MIN = 1920;
export const COMPARE_YEAR_MAX = HISTORY_END;

export const DEFAULT_SETTINGS = Object.freeze({
  lifeMinutes: 30,
  aiMode: 'default',
  decisionFreq: 'standard',
  autoChoose: false,
  theme: 'system',
  lastWorld: null, // { seed, label } of the most recently started life, for "沿用上一条世界线"
  autoTexture: 'normal', // how automatic choices lean
  gentle: false,         // 略过可怕的情节: heavy events keep their real odds but are worded gently
  music: true,           // quiet background music while a life plays
  reflections: true,     // pause at 5 / 15 / 30 / 50 / 70 to write a thought
  compareIso: null,      // the player's real birth country (ISO3), only ever kept in this browser
  compareYear: null,     // ... and real birth year
});

// the panels opened with app.openPanel(name), in tab order
const PANELS = { family: familyPanel, money: moneyPanel };
export const PANEL_NAMES = Object.freeze(['family', 'money']);

export const SCREEN_TITLES = {
  home: '首页', birth: '出生登记', game: '人生', death: '死亡证明', memorial: '追思馆', shared: '大家的人生',
  past: '前世纪录', about: '关于数据', settings: '设置', feedback: '反馈', stories: '生活片段', album: '成就图鉴',
};

const SCREENS = {
  home, birth, game, death, memorial, shared, past, about, settings: settingsScreen, feedback, stories, album,
};

// bare #anchors that deep-link into the app (only letters reach location.hash on the platform)
const ANCHORS = {
  home: 'home', memorial: 'memorial', shared: 'shared', past: 'past', about: 'about', settings: 'settings',
  feedback: 'feedback', stories: 'stories', photos: 'stories', album: 'album', cards: 'album', birth: 'birth', custom: 'birth', game: 'game', death: 'death',
};

const NAV = ['album', 'stories', 'memorial', 'shared', 'past', 'about', 'settings'];
// settings a life carries in state.settings (the engine reads them); music and the birthplace stay app-only
const LIFE_KEYS = ['lifeMinutes', 'aiMode', 'decisionFreq', 'autoChoose', 'autoTexture', 'gentle', 'reflections'];

const optBool = (v, dflt) => (v == null ? dflt : !!v);

export function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  if (![10, 30, 60, 90].includes(Number(s.lifeMinutes))) s.lifeMinutes = DEFAULT_SETTINGS.lifeMinutes;
  s.lifeMinutes = Number(s.lifeMinutes);
  if (!(s.aiMode in AI_MODES)) s.aiMode = DEFAULT_SETTINGS.aiMode;
  if (!['sparse', 'standard', 'frequent'].includes(s.decisionFreq)) s.decisionFreq = DEFAULT_SETTINGS.decisionFreq;
  s.autoChoose = !!s.autoChoose;
  if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
  if (!s.lastWorld || typeof s.lastWorld !== 'object' || !Number.isFinite(Number(s.lastWorld.seed))) s.lastWorld = null;
  else s.lastWorld = { seed: Number(s.lastWorld.seed) >>> 0, label: String(s.lastWorld.label || '').slice(0, 80) };
  if (!AUTO_TEXTURES.some((t) => t.id === s.autoTexture)) s.autoTexture = DEFAULT_SETTINGS.autoTexture;
  s.gentle = optBool(s.gentle, DEFAULT_SETTINGS.gentle);
  s.music = optBool(s.music, DEFAULT_SETTINGS.music);
  s.reflections = optBool(s.reflections, DEFAULT_SETTINGS.reflections);
  const iso = typeof s.compareIso === 'string' ? s.compareIso.trim().toUpperCase() : '';
  s.compareIso = /^[A-Z]{3}$/.test(iso) ? iso : null;
  const cy = typeof s.compareYear === 'string' && !s.compareYear.trim() ? NaN : Number(s.compareYear);
  s.compareYear = s.compareYear != null && Number.isInteger(cy) && cy >= COMPARE_YEAR_MIN && cy <= COMPARE_YEAR_MAX ? cy : null;
  return s;
}

/**
 * Give a LifeState from an older version the v2 fields that have only one sensible empty value (CONTRACT §10).
 * The engine defaults the rest (focus, habits ...) itself; this never overwrites anything that is already there.
 */
export function upgradeLife(state) {
  if (!state || typeof state !== 'object') return state;
  for (const k of ['stars', 'notes', 'rare']) if (!Array.isArray(state[k])) state[k] = [];
  for (const k of ['smallPending', 'namingPending', 'reflectPending']) if (state[k] === undefined) state[k] = null;
  return state;
}

/**
 * Archive number shown on every registry document (LL-<birth year>-<ISO3>-<code>). Delegates to cards.js so the
 * number on screen and on the exported PNG cards is the same. Accepts a LifeState or a bare BirthSpec.
 */
export function archiveNo(stateOrSpec) {
  const st = stateOrSpec || {};
  const life = st.birth ? st : { birth: st };
  if (typeof cards.archiveNumber === 'function') {
    try { return cards.archiveNumber(life); } catch { /* fall back below */ }
  }
  const b = life.birth || {};
  const key = String(life.id ?? life.seed ?? `${b.name}|${b.date}|${b.time}|${b.country}`);
  const hx = hashString(key).toString(16).toUpperCase().padStart(8, '0').slice(0, 6);
  return `LL-${b.year ?? '0000'}-${b.country || 'XXX'}-${hx}`;
}

function parseHash() {
  try {
    const raw = decodeURIComponent((location.hash || '').replace(/^#/, '')).trim().toLowerCase();
    return /^[a-z]+$/.test(raw) ? raw : '';
  } catch { return ''; }
}

function setHash(name) {
  try {
    const url = name === 'home' ? location.pathname + location.search : '#' + name;
    history.replaceState(history.state, '', url);
  } catch { /* sandboxed frames may refuse; the in-app back stack still works */ }
}

const isThenable = (x) => x && typeof x.then === 'function';

// ---------------------------------------------------------------- shared UI pieces (exposed as app.ui)

/** Real-history vs projection badge for a year. */
function yearBadge(year, { short = false } = {}) {
  if (year > HISTORY_END) return h('span.ll-badge.ll-badge--proj', { title: '2026 年之后的内容是根据当前趋势推演的世界线' }, short ? '推演' : '推演年份');
  if (year === HISTORY_END) return h('span.ll-badge.ll-badge--real', { title: `真实数据截至 ${DATA_DATE}` }, short ? '真实' : '真实历史 · 截至 2026-10');
  return h('span.ll-badge.ll-badge--real', short ? '真实' : '真实历史');
}

/**
 * The strict year grid used across the shell: one cell per year, solid ink for real history, hatched projection
 * colour after 2026. Returns an element with setRange([a,b]|null), setSpan([a,b]|null), setMarker(year|null).
 */
function yearRuler({ from = FIRST_YEAR, to = LAST_YEAR, range = null, span = null, marker = null, ticks = null, label = '', today = true, size = '' } = {}) {
  const n = to - from + 1;
  const pos = (y) => `${(((y - from) / n) * 100).toFixed(3)}%`;
  const cells = [];
  const grid = h('div.ll-ruler-grid', { style: { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` } });
  for (let y = from; y <= to; y++) {
    const c = h('span.ll-yr' + (y > HISTORY_END ? '.ll-yr--proj' : '.ll-yr--real'));
    if (y % 10 === 0) c.classList.add('ll-yr--decade');
    cells.push(c);
    grid.appendChild(c);
  }
  const tickYears = ticks || [from, HISTORY_END, 2050, 2070, to].filter((y, i, a) => y >= from && y <= to && a.indexOf(y) === i);
  const tickRow = h('div.ll-ruler-ticks', { 'aria-hidden': 'true' });
  tickYears.forEach((y) => {
    const cls = '.ll-ruler-tick' + (y > HISTORY_END ? '.is-proj' : '') + (y === from ? '.is-first' : '') + (y === to ? '.is-last' : '');
    tickRow.appendChild(h('span' + cls, { style: { left: pos(y + 0.5) } }, String(y)));
  });
  let todayEl = null;
  if (today && HISTORY_END >= from && HISTORY_END <= to) {
    const [, mm, dd] = DATA_DATE.split('-').map(Number);
    const frac = Math.min(0.99, ((mm - 1) * 30.4 + dd) / 365);
    todayEl = h('span.ll-ruler-today', { style: { left: pos(HISTORY_END + frac) }, 'aria-hidden': 'true' }, h('span', '今天'));
  }
  const el = h('div.ll-ruler' + (size ? '.ll-ruler--' + size : ''), {
    role: 'img',
    'aria-label': label || `${from}–${to} 年时间轴：${from}–${HISTORY_END} 年为真实历史，${HISTORY_END + 1} 年起为推演`,
  }, todayEl, grid, tickRow);
  const mark = (cls, r) => {
    cells.forEach((c, i) => {
      const y = from + i;
      c.classList.toggle(cls, !!r && y >= r[0] && y <= r[1]);
    });
  };
  el.setRange = (r) => { el.classList.toggle('has-range', !!r); mark('is-in', r); };
  el.setSpan = (r) => { el.classList.toggle('has-span', !!r); mark('is-span', r); };
  el.setMarker = (y) => { cells.forEach((c, i) => c.classList.toggle('is-mark', y != null && from + i === y)); };
  if (range) el.setRange(range);
  if (span) el.setSpan(span);
  if (marker != null) el.setMarker(marker);
  return el;
}

/**
 * Paper-form style radio group ("□ 城市 ■ 农村"). options: [{value, label, sub?, disabled?}].
 * Returns the fieldset; .setValue(v) updates without firing onChange, .getValue() reads.
 */
function boxGroup({ id, name, legend, hint, options, value, onChange, columns = 0, compact = false }) {
  const gname = name || id;
  const inputs = [];
  const fs = h('fieldset.ll-boxes' + (compact ? '.ll-boxes--compact' : ''), { id });
  if (legend) fs.appendChild(h('legend.ll-boxes-legend', legend));
  if (hint) fs.appendChild(h('p.ll-boxes-hint', hint));
  const wrap = h('div.ll-boxes-grid', columns ? { style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } } : null);
  options.forEach((o, i) => {
    const inputId = `${id}-${i}`;
    const input = h('input.ll-box-input', {
      type: 'radio', name: gname, id: inputId, value: String(o.value), checked: String(o.value) === String(value), disabled: !!o.disabled,
      onchange: () => { if (input.checked && onChange) onChange(o.value); },
    });
    inputs.push([input, o]);
    wrap.appendChild(h('label.ll-box', { for: inputId },
      input,
      h('span.ll-box-mark', { 'aria-hidden': 'true' }),
      h('span.ll-box-text', h('span.ll-box-label', o.label), o.sub ? h('span.ll-box-sub', o.sub) : null)));
  });
  fs.appendChild(wrap);
  fs.setValue = (v) => inputs.forEach(([inp, o]) => { inp.checked = String(o.value) === String(v); });
  fs.getValue = () => { const hit = inputs.find(([inp]) => inp.checked); return hit ? hit[1].value : null; };
  return fs;
}

/** Labelled switch (checkbox) in the registry style. */
function switchField({ id, label, sub, checked, onChange, disabled }) {
  const input = h('input.ll-switch-input', {
    type: 'checkbox', id, checked: !!checked, disabled: !!disabled, role: 'switch',
    onchange: () => onChange && onChange(input.checked),
  });
  const el = h('label.ll-switch', { for: id },
    input,
    h('span.ll-switch-track', { 'aria-hidden': 'true' }, h('span.ll-switch-knob')),
    h('span.ll-switch-text', h('span.ll-switch-label', label), sub ? h('span.ll-switch-sub', sub) : null));
  el.input = input;
  return el;
}

/**
 * Picker for settings.autoTexture. variant 'boxes' (settings page: every option with its one-line description) or
 * 'select' (compact, for the home screen: a native select and the chosen option's description underneath).
 * Returns the element with setValue(id).
 */
function texturePicker({ id = 'll-texture', value = 'normal', onChange, variant = 'boxes', legend = '', hint = '' } = {}) {
  const known = AUTO_TEXTURES.some((t) => t.id === value) ? value : 'normal';
  if (variant !== 'select') {
    const g = boxGroup({
      id, name: id, legend, hint, value: known, onChange,
      options: AUTO_TEXTURES.map((t) => ({ value: t.id, label: t.label, sub: t.sub })),
    });
    g.classList.add('ll-texture');
    return g;
  }
  const desc = h('p.ll-hint.ll-texture-desc', { id: id + '-d' });
  const paint = (v) => { desc.textContent = (AUTO_TEXTURES.find((t) => t.id === v) || AUTO_TEXTURES[0]).sub; };
  const sel = h('select.ll-select', {
    id, 'aria-describedby': id + '-d',
    onchange: () => { paint(sel.value); if (onChange) onChange(sel.value); },
  }, AUTO_TEXTURES.map((t) => h('option', { value: t.id, selected: t.id === known }, t.label)));
  paint(known);
  const el = h('div.ll-field.ll-texture.ll-texture--select',
    h('label.ll-label', { for: id }, legend || '自动选择时的倾向'), sel, desc);
  el.setValue = (v) => { sel.value = AUTO_TEXTURES.some((t) => t.id === v) ? v : 'normal'; paint(sel.value); };
  return el;
}

/**
 * "你实际出生的国家或地区" + year, for the comparison on the death certificate. Everything stays in this browser.
 * onChange({compareIso, compareYear}) fires with both values whenever one of them is committed.
 */
function compareFields({ id = 'll-cmp', data = null, iso = null, year = null, onChange, legend = '你实际出生的国家或地区', hint = null } = {}) {
  const countries = (data && data.countries) || {};
  const isos = (data && Array.isArray(data.isoList) ? data.isoList : Object.keys(countries)).filter((c) => countries[c]);
  const nameOf = (c) => String(countries[c]?.name || c);
  const groups = new Map();
  for (const c of isos) {
    const r = countries[c].region && REGIONS[countries[c].region] ? countries[c].region : '';
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  }
  const order = [...Object.keys(REGIONS), ''].filter((r) => groups.has(r));
  const sel = h('select.ll-select.ll-cmp-country', { id: id + '-c' },
    h('option', { value: '' }, '不想选择'),
    order.map((r) => h('optgroup', { label: r ? REGIONS[r] : '其他' },
      groups.get(r).sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN')).map((c) => h('option', { value: c }, nameOf(c))))));
  const yr = h('input.ll-input.ll-cmp-year', {
    id: id + '-y', type: 'number', inputmode: 'numeric', min: COMPARE_YEAR_MIN, max: COMPARE_YEAR_MAX, step: 1,
    placeholder: '例如 1998', 'aria-describedby': id + '-yh',
  });
  const yHint = h('p.ll-hint.ll-cmp-yhint', { id: id + '-yh' }, `${COMPARE_YEAR_MIN}–${COMPARE_YEAR_MAX} 年；不填就和这一生的出生年份比较。`);
  const clearBtn = h('button.ll-btn.ll-btn--ghost.ll-btn--small', { type: 'button' }, '不想选择');
  let lastYear = null;
  const readYear = () => {
    const raw = String(yr.value || '').trim();
    if (!raw) return { ok: true, value: null };
    const v = Number(raw);
    return Number.isInteger(v) && v >= COMPARE_YEAR_MIN && v <= COMPARE_YEAR_MAX ? { ok: true, value: v } : { ok: false, value: null };
  };
  const paint = () => {
    const has = !!sel.value;
    yr.disabled = !has;
    clearBtn.disabled = !has && !yr.value;
    const y = readYear();
    yHint.classList.toggle('is-bad', !y.ok);
    yHint.textContent = y.ok ? `${COMPARE_YEAR_MIN}–${COMPARE_YEAR_MAX} 年；不填就和这一生的出生年份比较。` : `请填写 ${COMPARE_YEAR_MIN}–${COMPARE_YEAR_MAX} 之间的年份。`;
  };
  const emit = () => {
    const y = readYear();
    if (y.ok) lastYear = y.value;
    paint();
    if (onChange) onChange({ compareIso: sel.value || null, compareYear: sel.value ? lastYear : null });
  };
  sel.addEventListener('change', emit);
  yr.addEventListener('change', emit);
  yr.addEventListener('input', paint);
  clearBtn.addEventListener('click', () => { sel.value = ''; yr.value = ''; lastYear = null; emit(); sel.focus(); });
  const setValue = (c, y) => {
    sel.value = c && countries[c] ? c : '';
    lastYear = Number.isInteger(y) ? y : null;
    yr.value = sel.value && lastYear != null ? String(lastYear) : '';
    paint();
  };
  setValue(iso, year);
  const el = h('fieldset.ll-cmp', { id },
    h('legend.ll-boxes-legend', legend),
    h('p.ll-boxes-hint', hint || '只保存在这个浏览器里，不会上传，也不会出现在分享的内容中。一生结束时，会把那里的预期寿命和这一生放在一起看看。'),
    h('div.ll-cmp-row',
      h('div.ll-field.ll-cmp-c', h('label.ll-label', { for: id + '-c' }, '国家或地区'), sel),
      h('div.ll-field.ll-cmp-y', h('label.ll-label', { for: id + '-y' }, '出生年份（可不填）'), yr)),
    yHint,
    h('div.ll-actions', clearBtn));
  el.setValue = setValue;
  el.getValue = () => ({ compareIso: sel.value || null, compareYear: sel.value ? lastYear : null });
  return el;
}

/** The shared UI pieces (also handed to every screen as app.ui). */
export const UI = Object.freeze({ yearBadge, yearRuler, boxGroup, switchField, texturePicker, compareFields });

// ---------------------------------------------------------------- side / bottom sheets

let sheetSeq = 0;

/**
 * Open the life's side sheet (desktop: from the right; phones: a bottom sheet) on panel `name` with tabs for the
 * other panels. A focus-trapped modal dialog: Escape, the scrim and the close button close it; the shell behind is
 * inert. The running GameController is paused (reason 'panel') while it is open and resumed when it closes.
 * Panels re-render on bus 'life:changed' from elsewhere and after each controller year.
 * deps: {app, host (element to append to), shell (element made inert), stack (shared array of open overlays),
 *        panels ({name: module}), getLife(), worldFor(state), onClose(), params}
 * Returns {close, show(name), name()}.
 */
export function openSheet(name, deps) {
  const { app, host, shell = null, stack = [], panels = PANELS, getLife, worldFor = null, onClose = null, params = {} } = deps || {};
  const names = Object.keys(panels);
  if (!panels[name] || !host) return null;
  const seq = ++sheetSeq;
  const prevFocus = typeof document !== 'undefined' ? document.activeElement : null;
  const ids = { title: `ll-sheet-t${seq}`, body: `ll-sheet-b${seq}` };
  let current = null;
  let panelCleanup = null;
  let closed = false;
  let raf = 0;
  const offs = [];

  const lifeNow = () => (typeof getLife === 'function' ? getLife() : null);
  const life0 = lifeNow();
  const ctl = (params && params.controller) || (app && app.controller);
  let pausedCtl = null;
  if (ctl && !ctl.destroyed && life0 && !life0.dead && typeof ctl.pause === 'function') {
    try { ctl.pause('panel'); pausedCtl = ctl; } catch (e) { console.error(e); }
  }

  const title = h('h2.ll-sheet-title', { id: ids.title });
  const eyebrow = h('p.ll-eyebrow.ll-sheet-eyebrow');
  const closeBtn = h('button.ll-sheet-close', { type: 'button', 'aria-label': '关闭附页', title: '关闭（Esc）', onclick: () => close() },
    h('span', { 'aria-hidden': 'true' }, '×'));
  const tabs = names.map((n) => h('button.ll-sheet-tab', {
    type: 'button', role: 'tab', id: `ll-sheet-tab-${n}-${seq}`, 'aria-controls': ids.body, dataset: { panel: n },
    onclick: () => show(n),
  }, panels[n].meta?.tab || n));
  const tablist = h('div.ll-sheet-tabs', { role: 'tablist', 'aria-label': '附页' }, tabs);
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = names.indexOf(current);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? names.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
    show(names[j]);
    tabs[j].focus();
  });
  const note = h('p.ll-sheet-note', { role: 'status' });
  const body = h('div.ll-sheet-body', { id: ids.body, role: 'tabpanel', tabindex: '-1' });
  const panelEl = h('section.ll-sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': ids.title },
    h('span.ll-sheet-grip', { 'aria-hidden': 'true' }),
    h('header.ll-sheet-head', h('div.ll-sheet-heading', eyebrow, title), closeBtn),
    names.length > 1 ? tablist : null,
    note,
    body);
  const scrim = h('div.ll-sheet-scrim', { onclick: () => close() });
  const anim = !reducedMotion();
  const wrap = h('div.ll-sheet-wrap' + (anim ? '.ll-sheet-wrap--anim' : '.is-in'), scrim, panelEl);

  function paintHead() {
    const st = lifeNow();
    const meta = panels[current].meta || {};
    title.textContent = meta.title || meta.tab || current;
    const who = st ? (st.person?.name || st.birth?.name || '') : '';
    eyebrow.textContent = st ? [meta.eyebrow || '档案附页', who, st.age != null ? `${st.age} 岁` : '', st.year != null ? `${st.year} 年` : ''].filter(Boolean).join(' · ') : (meta.eyebrow || '档案附页');
    tabs.forEach((t) => {
      const on = t.dataset.panel === current;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    body.setAttribute('aria-labelledby', `ll-sheet-tab-${current}-${seq}`);
    note.textContent = !st ? '' : st.dead ? '这一生已经结束，这里只能查看。' : pausedCtl ? '时间暂停中 · 关上附页后继续' : '';
    note.hidden = !note.textContent;
  }

  function mountPanel(keepScroll) {
    const top = keepScroll ? body.scrollTop : 0;
    const hadFocus = keepScroll && typeof document !== 'undefined' && body.contains && body.contains(document.activeElement);
    if (panelCleanup) { try { panelCleanup(); } catch (e) { console.error(e); } }
    panelCleanup = null;
    clear(body);
    const st = lifeNow();
    let world = null;
    try { world = st && typeof worldFor === 'function' ? worldFor(st) : null; } catch { world = null; }
    const p = { ...params, state: st, world, panel: current, changed: (kind) => changed(current, kind), switchTo: (n) => show(n), close };
    try {
      const r = panels[current].mount(body, p, app);
      if (typeof r === 'function') panelCleanup = r;
    } catch (e) {
      console.error(e);
      clear(body).append(h('div.ll-sheet-err', h('p', '这一页附页暂时打不开。'), h('p.ll-hint', String(e?.message || e).slice(0, 200))));
    }
    paintHead();
    body.scrollTop = top;
    if (hadFocus) { try { body.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  function show(n) {
    if (closed || !panels[n]) return;
    if (n === current) return;
    current = n;
    mountPanel(false);
  }

  // the controller saves the life and refreshes the game screen when it hears this
  function changed(n, kind) {
    const st = lifeNow();
    paintHead();
    bus.emit('life:changed', { source: 'panel', panel: n, what: kind || 'edit', kind: kind || 'edit', state: st, year: st?.year });
  }

  function refresh() {
    if (closed || raf) return;
    const run = () => { raf = 0; if (!closed) mountPanel(true); };
    raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 0), 1);
  }

  offs.push(bus.on('life:changed', (msg) => {
    if (msg && msg.source === 'panel' && msg.panel === current) return;   // the panel already updated itself
    refresh();
  }));
  if (ctl && typeof ctl.on === 'function') {
    for (const evt of ['year', 'death']) {
      const off = ctl.on(evt, refresh);
      if (typeof off === 'function') offs.push(off);
    }
  }

  const focusables = () => Array.from(panelEl.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
    .filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
  const onKey = (e) => {
    if (stack[stack.length - 1] !== wrap) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); body.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    const inside = panelEl.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  };

  function close() {
    if (closed) return;
    closed = true;
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    offs.forEach((f) => { try { f(); } catch { /* ignore */ } });
    if (panelCleanup) { try { panelCleanup(); } catch (e) { console.error(e); } }
    panelCleanup = null;
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    const i = stack.indexOf(wrap);
    if (i >= 0) stack.splice(i, 1);
    if (shell && !stack.length) shell.inert = false;
    try { document.documentElement.classList.remove('ll-sheet-open'); } catch { /* ignore */ }
    if (pausedCtl && !pausedCtl.destroyed && typeof pausedCtl.resume === 'function') {
      try { pausedCtl.resume('panel'); } catch (e) { console.error(e); }
    }
    bus.emit('panel:closed', { panel: current });
    if (onClose) { try { onClose(); } catch { /* ignore */ } }
    try { if (prevFocus && prevFocus.isConnected !== false) prevFocus.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }

  if (typeof document !== 'undefined') document.addEventListener('keydown', onKey, true);
  host.appendChild(wrap);
  stack.push(wrap);
  if (shell) shell.inert = true;
  try { document.documentElement.classList.add('ll-sheet-open'); } catch { /* ignore */ }
  current = name;
  mountPanel(false);
  const focusFirst = () => { if (!closed) { const t = tabs.find((b) => b.dataset.panel === current); (names.length > 1 && t ? t : closeBtn).focus(); } };
  if (anim && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { wrap.classList.add('is-in'); focusFirst(); });
  else focusFirst();
  return { close, show, name: () => current, isOpen: () => !closed, element: wrap };
}

// ---------------------------------------------------------------- the App

export function createApp(root, { data, ai = {}, social = {}, snapshot = null } = {}) {
  const settings = sanitizeSettings(storage.get(STORAGE_KEYS.settings, null));
  if (settings.compareIso && data && data.countries && !data.countries[settings.compareIso]) settings.compareIso = null;
  const hostTheme = document.documentElement.getAttribute('data-theme');

  const stack = [];
  let current = null;
  let cleanup = null;
  let renderSeq = 0;
  let activeState = null;
  let ctlOff = [];
  const recorded = new Set();
  const offBus = [];
  let sheet = null;  // the open side sheet (openSheet result) or null

  const app = {
    data,
    ai: { available: !!ai.available, pending: !!ai.pending, mode: settings.aiMode },
    social: { mode: social.mode === 'shared' ? 'shared' : 'local', pending: !!social.pending },
    settings,
    controller: null,
    world: null,       // World of the life being played (the controller reuses it when the seed matches)
    lastLife: null,
    get screen() { return current ? current.name : null; },
    getLife: () => activeState || app.lastLife || null,
    go, back, canGoBack: () => stack.length > 1,
    toast, confirm, modal: openModal,
    saveSettings, lifeSettings,
    prepareLife, startLife, resumeLife, endLife, abandonLife,
    archiveNo, isProjection: (y) => y > HISTORY_END,
    setAI, setSocial,
    openPanel, closePanel,
    get panel() { return sheet && sheet.isOpen() ? sheet.name() : null; },
    defaults: DEFAULT_SETTINGS,
    textures: AUTO_TEXTURES,
    ui: UI,
  };

  applyTheme(settings.theme);
  syncTier();

  // ------------------------------------------------ chrome
  clear(root);
  const backBtn = h('button.ll-back', { type: 'button', onclick: () => back(), 'aria-label': '返回上一页', hidden: true },
    h('span.ll-back-arrow', { 'aria-hidden': 'true' }, '←'), h('span.ll-back-text', '返回'));
  const brand = h('a.ll-brand', { href: '#home', 'aria-label': '人生长河 首页', onclick: (e) => { e.preventDefault(); go('home'); } },
    h('span.ll-brand-seal', { 'aria-hidden': 'true' }, h('span', '人'), h('span', '生')),
    h('span.ll-brand-words', h('span.ll-brand-name', '人生长河'), h('span.ll-brand-sub', 'LIFELINE 2000–2090')));
  const lifePill = h('button.ll-lifepill', { type: 'button', hidden: true, onclick: () => go('game') });
  const aiChip = h('button.ll-status', { type: 'button', onclick: () => go('settings', { focus: 'ai' }) });
  const socialChip = h('span.ll-status.ll-status--quiet', { tabindex: '0' });
  const navLinks = NAV.map((n) => h('a.ll-nav-link', { href: '#' + n, dataset: { to: n }, onclick: (e) => { e.preventDefault(); go(n); } }, SCREEN_TITLES[n]));
  const nav = h('nav.ll-nav', { 'aria-label': '主导航' }, navLinks);
  const menuBtn = h('button.ll-menu-btn', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'll-menu', onclick: () => toggleMenu() },
    h('span.ll-menu-icon', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', '目录'));
  const menuLinks = ['home', ...NAV, 'feedback'].map((n) => h('a.ll-menu-link', { href: '#' + n, dataset: { to: n }, onclick: (e) => { e.preventDefault(); toggleMenu(false); go(n); } },
    h('span', SCREEN_TITLES[n]), h('span.ll-menu-code', '#' + n)));
  const menuStatus = h('div.ll-menu-status');
  const menu = h('div#ll-menu.ll-menu', { hidden: true }, h('div.ll-menu-in', h('p.ll-menu-title', '卷宗目录'), menuLinks, menuStatus));
  const header = h('header.ll-header',
    h('div.ll-header-in', backBtn, brand, h('div.ll-header-sp'), lifePill, aiChip, socialChip, nav, menuBtn),
    menu);
  const main = h('main#ll-main.ll-main', { tabindex: '-1' });
  const foot = h('footer.ll-foot', h('div.ll-foot-in',
    h('p.ll-foot-line',
      h('span', '人生长河 · LifeLine 2090'),
      h('span', `数据截至 ${DATA_DATE}`),
      h('span.ll-foot-real', `${FIRST_YEAR}–${HISTORY_END} 真实历史`),
      h('span.ll-foot-proj', `${HISTORY_END + 1}–${LAST_YEAR} 推演`),
      h('span', '人物与个人经历均为虚构')),
    h('p.ll-foot-links',
      h('a', { href: '#about', onclick: (e) => { e.preventDefault(); go('about', { section: 'sources' }); } }, '数据来源与方法'),
      h('a', { href: '#feedback', onclick: (e) => { e.preventDefault(); go('feedback', { from: current?.name }); } }, '反馈'))));
  const shell = h('div.ll-shell', header, main, foot);
  const toastsEl = h('div.ll-toasts', { 'aria-live': 'polite', 'aria-atomic': 'false' });
  const modalRoot = h('div.ll-modal-root');
  root.append(shell, toastsEl, modalRoot);

  function toggleMenu(force) {
    const open = force == null ? menu.hidden : !!force;
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('.ll-menu-link')?.focus();
  }
  const onDocClick = (e) => { if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) toggleMenu(false); };
  const onDocKey = (e) => {
    if (e.key === 'Escape' && !menu.hidden) { toggleMenu(false); menuBtn.focus(); }
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  function aiInfo() {
    const mode = app.settings.aiMode;
    let st = null;
    try { st = typeof aiMod.aiStatus === 'function' ? aiMod.aiStatus() : null; } catch { st = null; }
    const extra = st && typeof st === 'object' ? (st.message || st.reason || st.text || '') : (typeof st === 'string' ? st : '');
    const live = app.ai.available && !(st && typeof st === 'object' && (st.available === false || st.offline === true));
    if (mode === 'off') return { state: 'off', text: '内置引擎', title: 'AI 推演已关闭，人生由内置推演引擎生成。点此打开设置。' };
    if (app.ai.pending) return { state: 'pending', text: 'AI 连接中', title: '正在检查 AI 推演是否可用' };
    if (live) return { state: 'on', text: `AI 推演 · ${AI_MODES[mode]}`, title: `AI 推演已开启（${AI_MODES[mode]}），使用你自己的 Claude 用量。点此打开设置。` };
    return { state: 'offline', text: '内置引擎', title: `AI 暂不可用，正在使用内置推演引擎。${extra ? String(extra).slice(0, 80) : ''}` };
  }

  function refreshChrome() {
    const name = current?.name || 'home';
    backBtn.hidden = !(stack.length > 1 || name !== 'home');
    navLinks.forEach((a) => {
      if (a.dataset.to === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    menuLinks.forEach((a) => {
      if (a.dataset.to === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const info = aiInfo();
    aiChip.className = 'll-status ll-status--' + info.state;
    aiChip.title = info.title;
    aiChip.setAttribute('aria-label', info.title);
    clear(aiChip).append(h('span.ll-status-dot', { 'aria-hidden': 'true' }), h('span.ll-status-text', info.text));
    const sharedOn = app.social.mode === 'shared';
    const sTitle = app.social.pending ? '正在连接共享服务' : sharedOn ? '共享服务已连接：可以把人生分享到追思馆，看到大家的人生。' : '共享服务不可用：存档只保存在这台设备的浏览器里。';
    socialChip.className = 'll-status ll-status--quiet ll-status--' + (app.social.pending ? 'pending' : sharedOn ? 'on' : 'off');
    socialChip.title = sTitle;
    socialChip.setAttribute('aria-label', sTitle);
    clear(socialChip).append(h('span.ll-status-dot', { 'aria-hidden': 'true' }), h('span.ll-status-text', app.social.pending ? '共享连接中' : sharedOn ? '共享在线' : '仅本机'));
    clear(menuStatus).append(
      h('p.ll-menu-stat', h('span.ll-status-dot.is-' + info.state, { 'aria-hidden': 'true' }), info.text),
      h('p.ll-menu-stat', h('span.ll-status-dot.is-' + (sharedOn ? 'on' : 'off'), { 'aria-hidden': 'true' }), sharedOn ? '共享在线' : '仅保存在本机'));
    const st = activeState;
    if (st && !st.dead && name !== 'game') {
      lifePill.hidden = false;
      clear(lifePill).append(
        h('span.ll-lifepill-k', '继续'),
        h('span.ll-lifepill-v', `${st.person?.name || st.birth?.name || '这一生'} · ${st.age ?? 0} 岁`));
      lifePill.title = `回到进行中的人生（${st.year ?? ''} 年）`;
    } else {
      lifePill.hidden = true;
    }
  }

  // ------------------------------------------------ router
  function go(name, params = {}, opts = {}) {
    params = params || {};
    if (name === 'custom') params = { ...params, mode: 'custom' };
    name = ANCHORS[name] || name;
    if (!SCREENS[name]) name = 'home';
    if (name === 'game' && !app.controller) {
      // deep link or stale navigation: resume the autosaved life if there is one
      if (!opts._noResume) tryResumeAutosave();
      name = 'home'; params = {};
    }
    if (name === 'game') params = { ...params, controller: app.controller, state: activeState };
    if (name === 'death' && !params.state) {
      const l = app.getLife();
      if (l && l.dead) params = { ...params, state: l };
      else { name = 'home'; params = {}; }
    }
    if (current) current.scrollY = window.scrollY || 0;
    if (name === 'home' || opts.reset) stack.length = 0;
    else if (opts.replace && stack.length) stack.pop();
    if (stack.length && stack[stack.length - 1].name === name) stack.pop();
    if (!stack.length && name !== 'home') stack.push({ name: 'home', params: {} });
    stack.push({ name, params });
    render({ focus: !opts.initial });
    return name;
  }

  function back() {
    if (stack.length <= 1) { if (current?.name !== 'home') go('home'); return; }
    if (current) current.scrollY = window.scrollY || 0;
    stack.pop();
    const prev = stack[stack.length - 1];
    if (prev.name === 'game' && !app.controller) { go('home'); return; }
    if (prev.name === 'game') prev.params = { ...prev.params, controller: app.controller, state: activeState };
    render({ focus: true, restoreScroll: prev.scrollY || 0 });
  }

  function render({ focus = false, restoreScroll = 0 } = {}) {
    const entry = stack[stack.length - 1];
    const seq = ++renderSeq;
    toggleMenu(false);
    closePanel();
    // The game screen owns the controller's clock: its cleanup detaches (stops) it and its mount attaches/starts it.
    if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } }
    cleanup = null;
    current = entry;
    clear(main);
    const screenRoot = h('section.ll-screen.ll-screen--' + entry.name, { 'aria-label': SCREEN_TITLES[entry.name] || '' });
    if (!reducedMotion()) screenRoot.classList.add('ll-enter');
    main.appendChild(screenRoot);
    try {
      const r = SCREENS[entry.name].mount(screenRoot, entry.params || {}, app);
      if (typeof r === 'function') cleanup = r;
      else if (isThenable(r)) {
        r.then((fn) => {
          if (typeof fn !== 'function') return;
          if (seq === renderSeq) cleanup = fn; else { try { fn(); } catch { /* ignore */ } }
        }, (e) => { console.error(e); if (seq === renderSeq) screenError(screenRoot, entry, e); });
      }
    } catch (e) {
      console.error(e);
      screenError(screenRoot, entry, e);
    }
    setHash(entry.name === 'birth' && entry.params?.mode === 'custom' ? 'custom' : entry.name);
    refreshChrome();
    if (restoreScroll) requestAnimationFrame(() => window.scrollTo(0, restoreScroll));
    else window.scrollTo(0, 0);
    if (focus) { try { main.focus({ preventScroll: true }); } catch { /* ignore */ } }
    bus.emit('screen', entry.name);
  }

  function screenError(el, entry, e) {
    clear(el).append(h('div.ll-doc.ll-errdoc',
      h('p.ll-eyebrow', '档案调阅异常'),
      h('h1.ll-h2', `“${SCREEN_TITLES[entry.name] || entry.name}”暂时无法打开`),
      h('p.ll-muted', '这一页在加载时出错了。可以返回首页继续，其他功能不受影响。'),
      h('pre.ll-errdoc-detail', String(e?.message || e).slice(0, 400)),
      h('div.ll-actions', h('button.ll-btn.ll-btn--ink', { type: 'button', onclick: () => go('home') }, '回到首页'))));
  }

  const onHash = () => {
    const raw = parseHash();
    const name = ANCHORS[raw];
    if (!name) return;
    const sameBirthMode = name !== 'birth' || (current?.params?.mode === 'custom') === (raw === 'custom');
    if (name === current?.name && sameBirthMode) return;
    go(raw);
  };
  window.addEventListener('hashchange', onHash);

  // ------------------------------------------------ toasts & modals
  function toast(text, kind = 'info', { duration = 3800 } = {}) {
    const k = ['info', 'good', 'warn', 'bad'].includes(kind) ? kind : 'info';
    const el = h('div.ll-toast.ll-toast--' + k, { role: k === 'bad' ? 'alert' : 'status' },
      h('span.ll-toast-mark', { 'aria-hidden': 'true' }), h('span.ll-toast-text', String(text ?? '')));
    let timer = 0;
    const dismiss = () => { clearTimeout(timer); el.remove(); };
    el.addEventListener('click', dismiss);
    toastsEl.appendChild(el);
    while (toastsEl.children.length > 3) toastsEl.firstElementChild.remove();
    timer = setTimeout(dismiss, Math.max(1500, duration));
    return dismiss;
  }

  const openModals = [];
  /** Generic in-page modal. body: string | Node | array. Returns close(). */
  function openModal({ title = '', body = null, actions = [], onDismiss = null, initialFocus = null, wide = false, eyebrow = '' } = {}) {
    const prevFocus = document.activeElement;
    const titleId = 'll-modal-t-' + Math.random().toString(36).slice(2, 8);
    const bodyNodes = typeof body === 'string'
      ? body.split(/\n+/).filter(Boolean).map((p) => h('p', p))
      : body;
    const dialog = h('div.ll-dialog' + (wide ? '.ll-dialog--wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      eyebrow ? h('p.ll-eyebrow', eyebrow) : null,
      h('h2.ll-dialog-title', { id: titleId }, title),
      h('div.ll-dialog-body', bodyNodes),
      actions && actions.length ? h('div.ll-dialog-actions', actions) : null);
    const overlay = h('div.ll-modal' + (reducedMotion() ? '' : '.ll-modal--anim'), {
      onmousedown: (e) => { if (e.target === overlay && onDismiss) onDismiss(); },
    }, dialog);
    const onKey = (e) => {
      if (openModals[openModals.length - 1] !== overlay) return;
      if (e.key === 'Escape') { e.preventDefault(); if (onDismiss) onDismiss(); }
      else if (e.key === 'Tab') {
        const f = Array.from(dialog.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')).filter((x) => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    modalRoot.appendChild(overlay);
    openModals.push(overlay);
    shell.inert = true;
    const focusTarget = initialFocus || dialog.querySelector('button, input, textarea, select');
    requestAnimationFrame(() => focusTarget?.focus());
    let closed = false;
    return function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      const i = openModals.indexOf(overlay);
      if (i >= 0) openModals.splice(i, 1);
      if (!openModals.length) shell.inert = false;
      try { prevFocus?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    };
  }

  function confirm({ title = '请确认', body = '', ok = '确定', cancel = '取消', danger = false } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      let close = () => {};
      const finish = (v) => { if (settled) return; settled = true; close(); resolve(v); };
      const okBtn = h('button.ll-btn' + (danger ? '.ll-btn--danger' : '.ll-btn--ink'), { type: 'button', onclick: () => finish(true) }, ok);
      const cancelBtn = cancel ? h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => finish(false) }, cancel) : null;
      close = openModal({ title, body, actions: [cancelBtn, okBtn], onDismiss: () => finish(false), initialFocus: cancelBtn || okBtn });
    });
  }

  // ------------------------------------------------ the life's side sheets: app.openPanel('family' | 'money')
  function lifeForPanel() {
    return activeState || app.lastLife || null;
  }
  function panelWorld(st) {
    const c = app.controller;
    if (c && c.state === st && c.world) return c.world;
    if (typeof controllerMod.worldFor === 'function') return controllerMod.worldFor(app, st);
    return app.world && app.world.seed === st.worldSeed ? app.world : worldMod.createWorld(data, st.worldSeed);
  }
  /** Open 家人与生活 ('family') or 花钱·投资 ('money'); switches tabs when the sheet is already open. Returns close(). */
  function openPanel(name, params = {}) {
    if (!PANELS[name]) return null;
    if (sheet && sheet.isOpen()) { sheet.show(name); return sheet.close; }
    if (!lifeForPanel()) { toast('还没有进行中的人生。开始一段人生后，这里会记下家人和收支。', 'info'); return null; }
    sheet = openSheet(name, {
      app, host: modalRoot, shell, stack: openModals, panels: PANELS, params,
      getLife: lifeForPanel,
      worldFor: panelWorld,
      onClose: () => {
        sheet = null;
        // the controller saves on every 'life:changed'; without one, keep the panel's changes in the autosave
        const st = activeState;
        if (st && !st.dead && !app.controller) { try { saves.autosave?.(st); } catch (e) { console.error(e); } }
      },
    });
    return sheet ? sheet.close : null;
  }
  function closePanel() {
    if (sheet) sheet.close();
    sheet = null;
  }

  // ------------------------------------------------ settings
  function applyTheme(t) {
    const r = document.documentElement;
    if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t);
    else if (hostTheme) r.setAttribute('data-theme', hostTheme);
    else r.removeAttribute('data-theme');
  }

  function lifeSettings() {
    const o = {};
    for (const k of LIFE_KEYS) o[k] = app.settings[k];
    return o;
  }

  function saveSettings(patch = {}) {
    const next = sanitizeSettings({ ...app.settings, ...(patch || {}) });
    Object.assign(app.settings, next);
    storage.set(STORAGE_KEYS.settings, app.settings);
    app.ai.mode = app.settings.aiMode;
    syncTier();
    if (patch && 'theme' in patch) applyTheme(app.settings.theme);
    const lifeTouched = patch && LIFE_KEYS.some((k) => k in patch);
    if (lifeTouched && activeState && !activeState.dead) {
      activeState.settings = { ...(activeState.settings || {}), ...lifeSettings() };
      try { app.controller?.applySettings?.(lifeSettings()); } catch (e) { console.error(e); }
    }
    bus.emit('settings', { ...app.settings });
    refreshChrome();
    return app.settings;
  }

  /** claude.js keeps a global model tier; 'off' there stops every call, so it follows the settings. */
  function syncTier() {
    try { if (typeof aiMod.setTier === 'function') aiMod.setTier(settings.aiMode); } catch (e) { console.error(e); }
  }

  function setAI(r) {
    app.ai.available = !!(r && r.available);
    app.ai.pending = false;
    if (r && typeof r === 'object') for (const [k, v] of Object.entries(r)) if (!(k in app.ai) || k === 'reason') app.ai[k] = v;
    refreshChrome();
    bus.emit('ai:status', { ...app.ai, mode: app.settings.aiMode });
  }
  function setSocial(r) {
    app.social.mode = r && r.mode === 'shared' ? 'shared' : 'local';
    app.social.pending = false;
    refreshChrome();
    bus.emit('social:status', { ...app.social });
  }
  // claude.js announces late arrival of the capability, permanent refusal (not_granted ...) and rate limits here
  offBus.push(bus.on('ai:changed', (msg) => {
    if (msg && typeof msg === 'object' && typeof msg.available === 'boolean') {
      app.ai.available = msg.available;
      app.ai.pending = false;
    }
    refreshChrome();
  }));
  // one notice per session when AI switches off for good, so the player knows why stories got simpler
  let aiOffNoticed = false;
  offBus.push(bus.on('ai:status', (msg) => {
    if (!msg || typeof msg !== 'object' || !msg.permanent || msg.available || aiOffNoticed) return;
    if (app.settings.aiMode === 'off') return;
    aiOffNoticed = true;
    toast(String(msg.message || 'AI 推演不可用，已改用内置推演引擎。'), 'warn', { duration: 6000 });
  }));

  // ------------------------------------------------ life lifecycle
  function prepareLife(birthSpec, opts = {}) {
    const worldSeed = opts.world?.seed ?? opts.worldSeed ?? newSeed();
    const world = opts.world || worldMod.createWorld(data, worldSeed);
    const seed = opts.seed ?? newSeed();
    const state = engineMod.newLife(data, world, birthSpec, lifeSettings(), seed);
    if (!state.createdAt) state.createdAt = new Date().toISOString();
    if (state.worldSeed == null) state.worldSeed = world.seed ?? worldSeed;
    if (!state.worldLabel && world.label) state.worldLabel = world.label;
    if (!state.settings) state.settings = lifeSettings();
    return { state, world };
  }

  function stopController() {
    ctlOff.forEach((f) => { try { f(); } catch { /* ignore */ } });
    ctlOff = [];
    const c = app.controller;
    if (c) {
      try { c.pause?.(); } catch { /* ignore */ }
      try { c.destroy?.(); } catch { /* ignore */ }
    }
    app.controller = null;
    activeState = null;
  }

  function adoptLife(state, world = null) {
    closePanel();
    stopController();
    upgradeLife(state);
    const Ctl = controllerMod.GameController;
    if (typeof Ctl !== 'function') throw new Error('游戏控制器尚未就绪');
    // the controller reuses app.world when its seed matches the life's world seed (saves rebuilding the world)
    if (world && world.seed != null && world.seed === state.worldSeed) app.world = world;
    const ctl = new Ctl(app, state);
    app.controller = ctl;
    activeState = state;
    app.lastLife = null;
    if (typeof ctl.on === 'function') {
      const off = ctl.on('death', () => recordDeath(state));
      if (typeof off === 'function') ctlOff.push(off);
      const offY = ctl.on('year', () => { if (current?.name !== 'game') refreshChrome(); });
      if (typeof offY === 'function') ctlOff.push(offY);
    }
    return ctl;
  }

  function rememberWorld(state) {
    if (state && state.worldSeed != null) saveSettings({ lastWorld: { seed: state.worldSeed, label: state.worldLabel || '' } });
  }

  function startLife(birthSpec, opts = {}) {
    try {
      const state = opts.state || prepareLife(birthSpec, opts).state;
      state.settings = { ...(state.settings || {}), ...lifeSettings() };
      if (!state.createdAt) state.createdAt = new Date().toISOString();
      rememberWorld(state);
      const ctl = adoptLife(state, opts.world || null);
      try { saves.autosave?.(state); } catch (e) { console.error(e); }
      stack.length = 0;
      stack.push({ name: 'home', params: {} });
      go('game', { fresh: true });
      return ctl;
    } catch (e) {
      console.error(e);
      toast('这一生没能开始：' + (e?.message || '未知错误'), 'bad');
      return null;
    }
  }

  function resumeLife(state, opts = {}) {
    if (!state || typeof state !== 'object') return null;
    if (state.dead) {
      app.lastLife = state;
      recordDeath(state);
      stack.length = 0;
      stack.push({ name: 'home', params: {} });
      go('death', { state });
      return null;
    }
    try {
      // The settings screen is global: a life resumed later plays with the settings shown there (the controller
      // already reads lifeMinutes and the AI tier from app.settings; this keeps autoChoose / decisionFreq and the v2
      // settings - autoTexture, gentle, reflections - in step, so a save from before they existed gets the defaults).
      state.settings = { ...(state.settings || {}), ...lifeSettings() };
      const ctl = adoptLife(state);
      if (opts.navigate === false) { refreshChrome(); return ctl; }
      stack.length = 0;
      stack.push({ name: 'home', params: {} });
      go('game', { resumed: true });
      return ctl;
    } catch (e) {
      console.error(e);
      toast('无法继续这段人生：' + (e?.message || '存档可能来自旧版本'), 'bad');
      return null;
    }
  }

  function recordDeath(state) {
    if (!state || !state.dead || recorded.has(state.id)) return;
    recorded.add(state.id);
    try { saves.addPastLife?.(state, { data }); } catch (e) { console.error(e); }
    try { saves.clearCurrent?.(); } catch (e) { console.error(e); }
  }

  function endLife(state) {
    const st = state || activeState || app.lastLife;
    if (!st) { go('home'); return; }
    recordDeath(st);
    if (activeState && (activeState === st || activeState.id === st.id)) stopController();
    app.lastLife = st;
    stack.length = 0;
    stack.push({ name: 'home', params: {} });
    go('death', { state: st });
  }

  /** Abandon the in-progress life (stops the controller and clears the autosave). */
  function abandonLife() {
    stopController();
    try { saves.clearCurrent?.(); } catch (e) { console.error(e); }
    refreshChrome();
  }

  async function tryResumeAutosave() {
    try {
      const st = await Promise.resolve(saves.loadCurrent?.());
      if (st && typeof st === 'object' && st.birth && !app.controller) resumeLife(st);
    } catch (e) { console.error(e); }
  }

  // ------------------------------------------------ hot reload
  try {
    window.claude?.hot?.snapshot?.(() => {
      const p = current?.params || {};
      const plain = {};
      for (const k of ['mode', 'yearMode', 'focus', 'from', 'filter', 'id', 'lifeId', 'section']) if (p[k] != null && typeof p[k] !== 'object') plain[k] = p[k];
      return { screen: current?.name || 'home', params: plain, life: activeState || app.lastLife || null };
    });
  } catch (e) { console.error(e); }

  function restore(snap) {
    const life = snap && snap.life;
    const scr = snap && snap.screen;
    if (life && typeof life === 'object' && life.birth) {
      if (life.dead) {
        app.lastLife = life;
        if (scr === 'death') { go('death', { state: life }, { initial: true }); return true; }
      } else {
        try {
          adoptLife(life);
          if (scr === 'game') { go('game', {}, { initial: true }); return true; }
        } catch (e) { console.error(e); }
      }
    }
    if (scr && SCREENS[scr] && scr !== 'game' && scr !== 'death') {
      go(scr, snap.params || {}, { initial: true });
      return true;
    }
    return false;
  }

  function routeFromHash() {
    const raw = parseHash();
    const name = ANCHORS[raw];
    if (!name || name === 'home') { go('home', {}, { initial: true }); return; }
    if (name === 'game') { go('home', {}, { initial: true, _noResume: true }); tryResumeAutosave(); return; }
    go(name, raw === 'custom' ? { mode: 'custom' } : {}, { initial: true });
  }

  if (!restore(snapshot)) routeFromHash();

  app.destroy = () => {
    closePanel();
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } }
    stopController();
    offBus.forEach((f) => f && f());
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
  };
  return app;
}
