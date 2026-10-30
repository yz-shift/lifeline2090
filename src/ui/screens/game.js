// Game screen: one life unfolding in real time.
// Desktop: three columns (registry card + stats + life map | focus bar + world ticker + life log | country /
// survival / same-second cohort / world-line tabs). Tablet: two columns. Phone: one column with a tab bar.
// The player takes part in almost every year (CONTRACT §10): 今年的重心 chips above the log, small choices as inline
// cards in the log that never stop the clock, ☆ on every log line, naming / reflection / thought dialogs
// (moments.js, opened by the controller), and a sticky bottom control bar with play/pause, speed 0.5×–16×,
// 跳到下一个抉择, 自动抉择 + its texture (性子), 主动选择, 家人与生活, 花钱·投资, 写下想法 and ♪ 音乐.

import { h, s, clear, append, fmt, reducedMotion, storage, bus } from '../dom.js';
import {
  STATS, STAT_LABELS, YEAR_TAG_LABELS, EDU_LABELS, CAREER_LABELS, RELATIONSHIP_LABELS, REGIONS,
  INCOME_THRESHOLDS, HISTORY_END, LAST_YEAR, FIRST_YEAR, AI_MODES,
} from '../../core/constants.js';
import * as engine from '../../core/engine.js';
import * as cohortMod from '../../core/cohort.js';
import * as charts from '../charts.js';
import * as lifemapMod from '../lifemap.js';
import { createMusic } from '../music.js';
import { createScene } from '../scene.js';
import { GameController, SPEEDS, AUTO_TEXTURES, textureLabel, archiveNumber, countryName } from '../controller.js';
import { effectChips, money, threadWhen } from './decision.js';

const TAB_KEY = 'll2090.gameTabs';
const HINT_KEY = 'll2090.gameHint';
const SIDE_TABS = [
  ['country', '国家'],
  ['survival', '生存曲线'],
  ['cohort', '同一秒'],
  ['world', '世界线'],
];
const MOBILE_TABS = [['log', '人生'], ['card', '档案'], ['country', '国家'], ['survival', '生存'], ['cohort', '同一秒'], ['world', '世界线']];
const INDICATORS = [
  { key: 'le', label: '预期寿命', unit: ' 岁', dec: 1, better: 1 },
  { key: 'gdp_pc_ppp', label: '人均 GDP', unit: ' 国际元', cn: true, better: 1, note: '购买力平价，2021 年价格' },
  { key: 'poverty', label: '极端贫困率', unit: '%', dec: 1, better: -1, note: '每天生活费低于 3 美元' },
  { key: 'internet', label: '互联网使用率', unit: '%', dec: 0, better: 1 },
  { key: 'unemployment', label: '失业率', unit: '%', dec: 1, better: -1 },
  { key: 'urban', label: '城镇化率', unit: '%', dec: 0, better: 0 },
];
const RANGE_YEARS = [2000, 2003, 2006, 2009, 2012, 2015, 2018, 2021, 2024, 2026, 2030, 2035, 2040, 2045, 2050, 2055, 2060, 2065, 2070, 2075, 2080, 2085, 2090];
const CONFLICT_LABELS = ['和平', '局势紧张', '局部冲突', '战乱'];
const SURVIVAL_AGES = [60, 70, 80, 90, 100];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
/** Replace el's children; arrays are flattened and null/false skipped (native append would print "null"). */
const fill = (el, ...kids) => append(clear(el), kids);
const speedText = (x) => `${x === 0.5 ? '0.5' : x}×`;

function svgIcon(d) {
  return s('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', focusable: 'false', class: 'g-ico' },
    s('path', { d, fill: 'currentColor' }));
}
const ICONS = {
  play: 'M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z',
  pause: 'M7 5h3.6v14H7zM13.4 5H17v14h-3.6z',
  skip: 'M5 5.6v12.8a.6.6 0 0 0 .9.5l8.6-6.4a.6.6 0 0 0 0-1L5.9 5.1a.6.6 0 0 0-.9.5zM16 5h3v14h-3z',
  pen: 'M4 17.3V20h2.7l9.9-9.9-2.7-2.7L4 17.3zm15.7-9.4a1 1 0 0 0 0-1.4l-2.2-2.2a1 1 0 0 0-1.4 0l-1.6 1.6 2.7 2.7 2.5-.7z',
  family: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.5 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5v1H2v-1zm13.2-5.3c3.3-.4 6.8 1.4 6.8 4.8V20h-6v-1c0-2-.3-3.8-.8-5.3z',
  coin: 'M12 3C7 3 3 4.6 3 6.6v10.8C3 19.4 7 21 12 21s9-1.6 9-3.6V6.6C21 4.6 17 3 12 3zm0 2c4.2 0 7 1.2 7 1.6S16.2 8.2 12 8.2 5 7 5 6.6 7.8 5 12 5zm7 12.4c0 .4-2.8 1.6-7 1.6s-7-1.2-7-1.6v-2.3c1.7.8 4.2 1.3 7 1.3s5.3-.5 7-1.3v2.3zm0-4.6c0 .4-2.8 1.6-7 1.6s-7-1.2-7-1.6v-2.4c1.7.8 4.2 1.3 7 1.3s5.3-.5 7-1.3v2.4z',
  note: 'M6 3h9l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm8 1.8V9h4.2L14 4.8zM8 12v1.8h8V12H8zm0 3.6v1.8h5.5v-1.8H8z',
  music: 'M9 6.6L20 4.2V15a3 3 0 1 1-2-2.83V8.5L11 10v7.5a3 3 0 1 1-2-2.83z',
};
const STAR_FULL_MSG = '最多只能留下 12 个值得记住的时刻。先取消一个，再标记这一个吧。';
let sharedMusic = null;   // createMusic() instance kept across mounts of the game screen
const STAR_PATH = 'M12 3.3l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.7l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z';
const MOMENT_STATUS = { naming: '正在给孩子取名', reflect: '停下来，想一想', thought: '正在写下想法' };

/** '知识↑ 快乐略↓' -> spans coloured by direction (text stays the same for screen readers). */
function hintNodes(hint) {
  return String(hint || '').split(/\s+/).filter(Boolean).map((t, i) => [
    i ? ' ' : null,
    h('span', { class: /↑/.test(t) ? 'g-up' : /↓/.test(t) ? 'g-down' : '' }, t),
  ]);
}

function badge(text, kind) {
  return h('span.g-b', { class: `g-b--${kind}` }, text);
}

function yearBadge(year) {
  if (year > HISTORY_END) return badge('推演', 'proj');
  if (year === HISTORY_END) return badge('截至 2026-10', 'real');
  return badge('真实历史', 'real');
}

function incomeLabel(id) {
  return (INCOME_THRESHOLDS.find((t) => t.id === id) || {}).label || '';
}

function familyLabel(p) {
  if (!isNum(p)) return '';
  if (p < 0.2) return '贫困';
  if (p < 0.4) return '偏低';
  if (p < 0.6) return '中等';
  if (p < 0.8) return '较好';
  return '富裕';
}

function fmtIndicator(ind, v) {
  if (!isNum(v)) return '—';
  if (ind.cn) return fmt.cn(v) + ind.unit;
  return Number(v).toFixed(ind.dec ?? 1) + ind.unit;
}

function eventSourceBadge(ev) {
  if (!ev) return null;
  if (ev.source === 'shock') return badge('突发·推演', 'proj');
  if (ev.projection || ev.source === 'future' || ev.year > HISTORY_END) return badge('推演', 'proj');
  return badge('真实', 'real');
}

export function mount(root, params = {}, app) {
  const data = app.data;
  const life = params.state || (typeof app.getLife === 'function' ? app.getLife() : null);

  let ctrl = params.controller || app.controller || null;
  if (ctrl && (ctrl.destroyed || (life && ctrl.state !== life))) ctrl = null;
  if (!ctrl) {
    const cur = GameController.current;
    if (cur && !cur.destroyed && (life ? cur.state === life : !cur.state.dead)) ctrl = cur;
  }
  let owned = false;
  if (!ctrl && life && !life.dead) {
    ctrl = new GameController(app, life);
    owned = true;
  }

  if (!ctrl) {
    root.append(h('div.g-empty.g-panel',
      h('p.g-eyebrow', '户籍档案'),
      h('h1.g-empty-t', life && life.dead ? '这一生已经结束' : '还没有正在进行的人生'),
      h('p.g-muted', life && life.dead ? '可以去看看这份死亡证明，或者重新开始。' : '从出生登记开始一段新的人生吧。'),
      h('div.g-row',
        life && life.dead ? h('button.g-btn.g-btn--primary', { type: 'button', onclick: () => app.go('death', { state: life }) }, '查看死亡证明') : null,
        h('button.g-btn', { type: 'button', onclick: () => app.go('birth') }, '出生登记'))));
    return undefined;
  }

  const state = ctrl.state;
  const world = ctrl.world;
  const birth = state.birth || {};
  const sex = state.person?.sex || birth.sex || 'female';
  const archive = typeof app.archiveNo === 'function' ? app.archiveNo(state) : archiveNumber(state);
  const expectedYears = Math.round(ctrl.leBirth);
  const saved = storage.get(TAB_KEY, {}) || {};
  const ui = {
    mtab: MOBILE_TABS.some(([k]) => k === saved.m) ? saved.m : 'log',
    side: SIDE_TABS.some(([k]) => k === saved.s) ? saved.s : 'country',
    countryView: 'now',
  };
  const offs = [];
  let destroyed = false;
  let lastSnap = null;   // latest control snapshot (controller 'state' event)
  const toast = (text, kind) => { if (typeof app.toast === 'function') app.toast(text, kind); };
  // 略过可怕的情节: entries the engine marked as sensitive carry a softer `gentleText` (and death a `causeGentle`)
  const gentleOn = () => !!(state.settings && typeof state.settings.gentle === 'boolean' ? state.settings.gentle : app.settings?.gentle);
  let gentleShown = null;

  // ------------------------------------------------------------------------------------------------------------
  // helpers bound to this life

  const cname = (iso) => countryName(data, iso);
  const indicator = (iso, key, year) => {
    try {
      const v = world && typeof world.indicator === 'function' ? world.indicator(iso, key, year) : data.series(iso, key, year);
      return isNum(v) ? v : null;
    } catch { return null; }
  };
  const nowYear = () => state.year;
  const livedYear = () => {
    const hist = state.history || [];
    return hist.length ? hist[hist.length - 1].year : state.year;
  };
  const historyRow = (() => {
    let cacheLen = -1;
    let map = new Map();
    return (year) => {
      const hist = state.history || [];
      if (hist.length !== cacheLen) {
        map = new Map();
        for (const r of hist) if (r && isNum(r.year)) map.set(r.year, r);
        cacheLen = hist.length;
      }
      return map.get(year);
    };
  })();

  // ------------------------------------------------------------------------------------------------------------
  // top strip (sticky): who / when / where / AI, month progress, phone tab bar

  const stripName = h('span.g-strip-name');
  const stripAge = h('span.g-strip-age');
  const stripYear = h('span.g-strip-year');
  const stripMonth = h('span.g-strip-month');
  const stripBadge = h('span.g-strip-badge');
  const stripPlace = h('span.g-strip-place');
  const aiDot = h('i.g-ai-dot', { 'aria-hidden': 'true' });
  const aiText = h('span.g-ai-text');
  const aiEl = h('span.g-ai', { role: 'status' }, aiDot, aiText);
  const monthFill = h('i.g-month-fill');
  const monthBar = h('div.g-month', {
    role: 'progressbar', 'aria-label': '本年进度（月）', 'aria-valuemin': '0', 'aria-valuemax': '12', 'aria-valuenow': '0',
  }, monthFill);
  const mtabBtns = MOBILE_TABS.map(([id, label]) => h('button.g-mtab', {
    type: 'button', role: 'tab', dataset: { t: id }, onclick: () => setMTab(id),
  }, label));
  const mtabBar = h('div.g-mtabs', { role: 'tablist', 'aria-label': '查看' }, mtabBtns);
  const strip = h('div.g-strip',
    h('div.g-strip-in',
      h('div.g-strip-who', stripName, stripAge),
      h('div.g-strip-when', stripYear, stripMonth, stripBadge),
      stripPlace,
      aiEl),
    monthBar,
    mtabBar);

  // ------------------------------------------------------------------------------------------------------------
  // left column: registry card, stats, life map, threads

  const cardBody = h('div.g-card-body');
  const card = h('section.g-panel.g-card', { 'aria-label': '户籍档案' },
    h('header.g-card-hd', h('span.g-card-kind', '户籍档案'), h('span.g-card-no', archive)),
    cardBody);

  const statRows = {};
  const statList = h('div.g-stat-list');
  for (const k of STATS) {
    const val = h('span.g-stat-v', '—');
    const delta = h('span.g-stat-d', { 'aria-hidden': 'true' });
    const fill = h('i.g-stat-fill');
    const spark = h('span.g-stat-spark');
    const row = h('div.g-stat', { dataset: { stat: k } },
      h('span.g-stat-l', h('i.g-stat-dot', { 'aria-hidden': 'true' }), STAT_LABELS[k]),
      val, delta,
      h('span.g-stat-bar', { 'aria-hidden': 'true' }, fill),
      spark);
    statRows[k] = { row, val, delta, fill, spark, shown: null, anim: 0, deltaTimer: 0 };
    statList.append(row);
  }
  const statsBox = h('section.g-panel.g-stats', { 'aria-label': '五项指标' },
    h('h2.g-h', '五项指标', h('span.g-h-sub', '0–100')), statList);

  const lm = typeof lifemapMod.lifeMap === 'function'
    ? lifemapMod.lifeMap(state.history || [], {
      birthYear: birth.year, expectedYears, projectionFrom: HISTORY_END + 1, data,
      decisions: state.decisions || [], countryName: cname,
      onSelect: (r) => jumpToYear(r && (isNum(r) ? r : r.year)),
    })
    : h('p.g-muted', '人生地图暂不可用');
  const mapBox = h('section.g-panel.g-mapbox', { 'aria-label': '人生地图' },
    h('h2.g-h', '人生地图', h('span.g-h-sub', `出生时预期 ${expectedYears} 岁`)), lm);

  const threadsBody = h('div.g-threads-body');
  const threadsBox = h('section.g-panel.g-threads', { 'aria-label': '伏笔' },
    h('h2.g-h', '伏笔', h('span.g-h-sub', '过去的选择埋下的线索')), threadsBody);

  const leftCol = h('div.g-col.g-left', { dataset: { panel: 'card' } }, card, statsBox, mapBox, threadsBox);

  // ------------------------------------------------------------------------------------------------------------
  // centre: world ticker + life log

  const tickerLine = h('div.g-tk-line');
  const tickerList = h('ol.g-tk-list', { hidden: true });
  const tickerYear = h('span.g-tk-y');
  const tickerToggle = h('button.g-link.g-tk-all', { type: 'button', 'aria-expanded': 'false', onclick: () => toggleTicker() });
  const ticker = h('section.g-ticker', { 'aria-label': '这一年的世界要闻' },
    h('div.g-tk-head', tickerYear, tickerToggle),
    tickerLine,
    tickerList);
  const tk = { items: [], idx: 0, year: null, open: false, hover: false, timer: 0 };

  const logEl = h('div.g-log', { 'aria-label': '人生记录（最新的一年在最上面）' });
  const hintEl = !storage.get(HINT_KEY, false)
    ? h('div.g-hint', { role: 'note' },
      h('p', h('b', '人生开始流动了。'),
        '每一年会自动推进。6 岁起可以随时调整「今年的重心」；记录里会冒出小小的选择，不选也没关系，年底会按你的性子决定。遇到人生的岔路口会停下来等你。按空格暂停，点 ☆ 留下值得记住的时刻——',
        aiDefault().on ? 'AI 会根据你之前的经历推演之后的路。' : '你之前的选择会影响之后的路。',
        `标着「真实历史」的是真实发生过的事，「推演」是 ${HISTORY_END + 1} 年以后的一种可能。`),
      h('button.g-link', { type: 'button', onclick: () => { storage.set(HINT_KEY, true); hintEl.remove(); } }, '知道了'))
    : null;

  // 今年的重心: chips from the engine's focusOptions (auto first), a status line explaining the current state
  const focusState = h('p.g-focus-st', { role: 'status', 'aria-live': 'polite' });
  const focusRow = h('div.g-focus-row', { role: 'group', 'aria-label': '今年的重心（左右方向键切换，回车选择）' });
  const focusBox = h('section.g-focus', { 'aria-label': '今年的重心', hidden: true },
    h('div.g-focus-hd', h('h2.g-focus-k', '今年的重心'), focusState),
    h('div.g-focus-scroll', focusRow));

  const starCount = h('span.g-log-stars', { role: 'status', 'aria-live': 'polite' });
  const logHd = h('div.g-log-hd', h('h2.g-log-k', '人生记录'), starCount);
  const sceneHost = h('div.g-scene-host');
  const centerCol = h('div.g-col.g-center', { dataset: { panel: 'log' } }, sceneHost, focusBox, ticker, hintEl, logHd, logEl);
  const scene = createScene(sceneHost, { data, world });
  let sceneFrac = 0;
  const sceneUpdate = (f) => { if (typeof f === 'number') sceneFrac = f; try { scene.update(ctrl.state, sceneFrac); } catch (e) { console.warn('[scene]', e); } };

  // ------------------------------------------------------------------------------------------------------------
  // right column: tabs

  const sideBtns = SIDE_TABS.map(([id, label]) => h('button.g-tab', {
    type: 'button', role: 'tab', id: `g-tab-${id}`, 'aria-controls': `g-tp-${id}`, dataset: { t: id }, onclick: () => setSide(id),
  }, label));
  const sideTabs = h('div.g-tabs', { role: 'tablist', 'aria-label': '资料' }, sideBtns);
  sideTabs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const i = SIDE_TABS.findIndex(([k]) => k === ui.side);
    const n = (i + (ev.key === 'ArrowRight' ? 1 : SIDE_TABS.length - 1)) % SIDE_TABS.length;
    setSide(SIDE_TABS[n][0]);
    sideBtns[n].focus();
    ev.preventDefault();
  });
  const panels = {};
  for (const [id] of SIDE_TABS) {
    panels[id] = h('div.g-tp', { role: 'tabpanel', id: `g-tp-${id}`, 'aria-labelledby': `g-tab-${id}`, tabindex: '0' });
  }
  const sideDirty = { country: true, survival: true, cohort: true, world: true };
  const rightCol = h('div.g-col.g-right', { dataset: { panel: 'side' } },
    h('section.g-panel.g-side', sideTabs, Object.values(panels)));

  // ------------------------------------------------------------------------------------------------------------
  // bottom control bar

  const playIcon = h('span.g-cb-ico');
  const playLabel = h('span.g-cb-lb');
  const btnPlay = h('button.g-cb.g-cb--play', { type: 'button', onclick: () => ctrl.toggle(), title: '暂停 / 继续（空格）' }, playIcon, playLabel);
  const speedBtns = SPEEDS.map((x) => h('button.g-spd', {
    type: 'button', dataset: { x: String(x) }, onclick: () => ctrl.setSpeed(x), 'aria-label': `速度 ${speedText(x)}`,
  }, speedText(x)));
  const speedGroup = h('div.g-speed', { role: 'group', 'aria-label': '速度（+ / - 键调整）' }, speedBtns);
  const speedCycle = h('button.g-cb.g-cb--cycle', {
    type: 'button',
    onclick: () => { const i = SPEEDS.indexOf(ctrl.speed); ctrl.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]); },
  });
  const btnSkip = h('button.g-cb.g-cb--skip', { type: 'button', onclick: () => ctrl.skipToDecision(), title: '快速推进到下一个人生抉择', 'aria-label': '跳到下一个抉择' },
    h('span.g-cb-ico', svgIcon(ICONS.skip)), h('span.g-cb-lb', h('span.g-long', '跳到下一个抉择'), h('span.g-short', '下个抉择')));
  const autoKnob = h('span.g-sw', { 'aria-hidden': 'true' }, h('i'));
  const btnAuto = h('button.g-cb.g-cb--auto', {
    type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': '自动抉择', onclick: () => ctrl.setAutoChoose(!ctrl.autoChoose),
    title: '开启后，抉择会在短暂停留后按你的性子自动选择',
  }, autoKnob, h('span.g-cb-lb', h('span.g-long', '自动抉择'), h('span.g-short', '自动')));
  const texValue = h('span.g-tex-v');
  const btnTexture = h('button.g-cb.g-cb--tex', {
    type: 'button', 'aria-haspopup': 'dialog', onclick: () => openTexture(),
    title: '自动抉择、没回答的小选择和自动重心，都按这种性子来',
  }, h('span.g-tex-k', '性子'), texValue);
  const btnCustom = h('button.g-cb.g-cb--custom', { type: 'button', onclick: () => ctrl.openCustomAction(), title: '暂停，写下你想主动做的事', 'aria-label': '主动选择' },
    h('span.g-cb-ico', svgIcon(ICONS.pen)), h('span.g-cb-lb', h('span.g-long', '主动选择'), h('span.g-short', '主动')));
  const panelsOn = typeof app.openPanel === 'function';
  const toolBtn = (icon, long, short, aria, title, onclick, extra = {}) => h('button.g-cb.g-cb--tool', {
    type: 'button', 'aria-label': aria, title, onclick, ...extra,
  }, h('span.g-cb-ico', svgIcon(icon)), h('span.g-cb-lb', h('span.g-long', long), h('span.g-short', short)));
  const btnFamily = panelsOn ? toolBtn(ICONS.family, '家人与生活', '家人', '家人与生活', '家人、朋友、宠物、习惯和身体状况', () => openPanel('family')) : null;
  const btnMoney = panelsOn ? toolBtn(ICONS.coin, '花钱·投资', '花钱', '花钱·投资', '一年收入的去向、存款和投资、花钱的习惯', () => openPanel('money')) : null;
  const btnNote = toolBtn(ICONS.note, '写下想法', '想法', '写下想法', '写下此刻的想法（时间会先停下）', () => ctrl.openThought());
  const btnMusic = toolBtn(ICONS.music, '音乐', '音乐', '背景音乐', '轻柔的背景音乐', () => toggleMusic(), { 'aria-pressed': 'false', class: 'g-cb--music' });
  const pill = h('button.g-pill', { type: 'button', onclick: () => ctrl.reopenDecision() },
    h('i.g-pill-dot', { 'aria-hidden': 'true' }), h('span', '有一个抉择正在等你'), h('span.g-pill-go', '回到抉择'));
  const pillRow = h('div.g-ctrl-pill', { hidden: true }, pill);
  const ctrlStatus = h('span.g-cb-status', { role: 'status', 'aria-live': 'polite' });
  const controls = h('div.g-ctrl', { role: 'toolbar', 'aria-label': '人生控制' },
    pillRow,
    h('div.g-ctrl-in', btnPlay, speedGroup, speedCycle, btnSkip, btnAuto, btnTexture, btnCustom,
      h('span.g-ctrl-br', { 'aria-hidden': 'true' }),
      btnFamily, btnMoney, btnNote, btnMusic, ctrlStatus));

  const curtain = h('div.g-curtain', { hidden: true, role: 'status', 'aria-live': 'assertive' });

  const cols = h('div.g-cols', leftCol, centerCol, rightCol);
  const page = h('div.g-game', { dataset: { mtab: ui.mtab } }, strip, cols, controls, curtain);
  root.append(page);

  // ------------------------------------------------------------------------------------------------------------
  // layout: keep sticky offsets under the app header

  const header = document.querySelector('.ll-header');
  const measure = () => {
    if (destroyed) return;
    const top = header ? Math.round(header.getBoundingClientRect().height) : 0;
    const headerSticky = header ? getComputedStyle(header).position : 'static';
    const off = headerSticky === 'sticky' || headerSticky === 'fixed' ? top : 0;
    page.style.setProperty('--g-top', `${off}px`);
    page.style.setProperty('--g-strip-h', `${Math.round(strip.getBoundingClientRect().height)}px`);
    page.style.setProperty('--g-ctrl-h', `${Math.round(controls.getBoundingClientRect().height)}px`);
  };
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => measure());
    if (header) ro.observe(header);
    ro.observe(strip);
    ro.observe(controls);
  } else {
    window.addEventListener('resize', measure);
  }

  // ------------------------------------------------------------------------------------------------------------
  // tabs

  function persistTabs() { storage.set(TAB_KEY, { m: ui.mtab, s: ui.side }); }

  function setMTab(id) {
    ui.mtab = id;
    if (SIDE_TABS.some(([k]) => k === id)) {
      ui.side = id;
      page.dataset.mtab = 'side';
    } else {
      page.dataset.mtab = id;
    }
    paintTabs();
    persistTabs();
    renderSide(true);
    if (typeof window.scrollTo === 'function') {
      const y = page.getBoundingClientRect().top + window.scrollY - (parseFloat(page.style.getPropertyValue('--g-top')) || 0);
      if (window.scrollY > y) window.scrollTo({ top: y, behavior: 'auto' });
    }
  }

  function setSide(id) {
    ui.side = id;
    if (page.dataset.mtab === 'side') ui.mtab = id;
    paintTabs();
    persistTabs();
    renderSide(true);
  }

  function paintTabs() {
    for (const b of mtabBtns) b.setAttribute('aria-selected', b.dataset.t === ui.mtab ? 'true' : 'false');
    for (const b of sideBtns) {
      const on = b.dataset.t === ui.side;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    for (const [id, p] of Object.entries(panels)) p.hidden = id !== ui.side;
  }

  // ------------------------------------------------------------------------------------------------------------
  // render scheduling

  const dirty = new Set();
  let rafId = 0;
  function mark(...parts) {
    for (const p of parts) dirty.add(p);
    if (!rafId && !destroyed) rafId = requestAnimationFrame(flush);
  }
  function flush() {
    rafId = 0;
    if (destroyed) return;
    const d = new Set(dirty);
    dirty.clear();
    const run = (k, fn) => { if (d.has(k)) { try { fn(); } catch (e) { console.error('[game]', k, e); } } };
    run('strip', renderStrip);
    run('focus', renderFocus);
    run('log', renderLog);
    run('small', syncSmall);
    run('stars', syncStars);
    run('ticker', renderTicker);
    run('card', renderCard);
    run('stats', renderStats);
    run('map', renderMap);
    run('threads', renderThreads);
    run('side', () => renderSide(false));
    run('controls', () => renderControls(ctrl.snapshot()));
  }
  const markYear = () => {
    for (const k of Object.keys(sideDirty)) sideDirty[k] = true;
    mark('strip', 'focus', 'log', 'small', 'stars', 'ticker', 'card', 'stats', 'map', 'threads', 'side', 'controls');
  };

  // ------------------------------------------------------------------------------------------------------------
  // strip

  let lastMonth = -1;
  function renderStrip() {
    const p = state.person || {};
    stripName.textContent = p.name || birth.name || '无名';
    stripAge.textContent = `${state.age ?? 0} 岁`;
    stripYear.textContent = `${nowYear()} 年`;
    clear(stripBadge).append(yearBadge(nowYear()));
    const res = p.country || birth.country;
    stripPlace.textContent = `${cname(res)} · ${p.urban ? '城市' : '乡村'}`;
    page.classList.toggle('g-game--proj', nowYear() > HISTORY_END);
    paintMonth(ctrl.progress || 0, true);
  }

  function paintMonth(frac, force) {
    const f = Math.max(0, Math.min(1, frac || 0));
    monthFill.style.transform = `scaleX(${f.toFixed(4)})`;
    const m = Math.min(12, Math.floor(f * 12) + 1);
    if (m !== lastMonth || force) {
      lastMonth = m;
      stripMonth.textContent = state.dead ? '' : `${m} 月`;
      monthBar.setAttribute('aria-valuenow', String(m - 1));
      monthBar.setAttribute('aria-valuetext', `${nowYear()} 年 ${m} 月`);
    }
    paintSmallCountdown();
  }

  // ------------------------------------------------------------------------------------------------------------
  // 今年的重心

  const focusLabels = new Map();   // focus id -> label (kept across years for the year headers)
  let focusKey = '';

  function focusLabel(id) {
    return id == null ? '' : focusLabels.get(String(id)) || '';
  }

  function focusChip(o, on, tab) {
    const off = o.available === false;
    return h('button.g-chip', {
      type: 'button',
      class: [o.id === 'auto' ? 'g-chip--auto' : '', off ? 'g-chip--off' : ''].filter(Boolean).join(' ') || null,
      dataset: { id: String(o.id) },
      'aria-pressed': on ? 'true' : 'false',
      'aria-disabled': off ? 'true' : null,
      tabindex: tab ? '0' : '-1',
      title: off ? (o.why || '眼下还做不到') : (o.hint || ''),
      onclick: () => pickFocus(o),
      onfocus: (ev) => { try { ev.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ } },
    },
    h('span.g-chip-l', o.label),
    o.hint ? h('span.g-chip-h', hintNodes(o.hint)) : null,
    off && o.why ? h('span.g-chip-why', o.why) : null);
  }

  function pickFocus(o) {
    if (!o || state.dead) return;
    if (o.available === false) {
      toast(o.why ? `现在还不行：${o.why}` : '现在还做不到这一点。', 'info');
      return;
    }
    const id = o.id === 'auto' ? null : o.id;
    if ((ctrl.focus ?? null) === id) return;
    if (ctrl.setFocus(id)) {
      focusKey = '';
      renderFocus();
      const btn = focusRow.querySelector(`.g-chip[data-id="${CSS.escape(String(o.id))}"]`);
      if (btn) btn.focus({ preventScroll: true });
    }
  }

  function renderFocus() {
    const on = typeof ctrl.hasFocus === 'function' && ctrl.hasFocus() && !state.dead;
    focusBox.hidden = !on;
    if (!on) return;
    const opts = ctrl.focusOptions();
    for (const o of opts) focusLabels.set(String(o.id), o.label);
    const cur = ctrl.focus;
    const yf = ctrl.yearFocus();
    const tex = ctrl.texture;
    const key = JSON.stringify([state.year, cur, yf, tex, opts.map((o) => [o.id, o.label, o.hint, o.available !== false, o.why || ''])]);
    if (key === focusKey) return;
    focusKey = key;
    focusBox.classList.toggle('g-focus--young', !opts.length);
    if (!opts.length) {
      clear(focusRow);
      focusState.textContent = (state.age ?? 0) < 6
        ? '6 岁以后，可以在这里决定每一年把心思放在哪里。'
        : '这一年没有可以安排的重心。';
      return;
    }
    const pressedId = cur == null ? 'auto' : String(cur);
    const hasPressed = pressedId === 'auto' || opts.some((o) => String(o.id) === pressedId);
    const auto = { id: 'auto', label: '自动', hint: `按「${textureLabel(tex)}」的性子`, available: true };
    const chips = [auto, ...opts].map((o, i) => focusChip(o, String(o.id) === pressedId, hasPressed ? String(o.id) === pressedId : i === 0));
    fill(focusRow, chips);
    if (cur == null) {
      const now = focusLabel(yf);
      focusState.textContent = now ? `自动：今年把心思放在「${now}」上（按「${textureLabel(tex)}」的性子）` : `自动：每年按「${textureLabel(tex)}」的性子安排`;
    } else {
      focusState.textContent = `你定下了「${focusLabel(cur) || cur}」，之后每年都会这样，直到你改变它`;
    }
  }

  focusRow.addEventListener('keydown', (ev) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(ev.key)) return;
    const btns = [...focusRow.querySelectorAll('.g-chip')];
    if (!btns.length) return;
    const i = Math.max(0, btns.indexOf(document.activeElement));
    let n = i;
    if (ev.key === 'Home') n = 0;
    else if (ev.key === 'End') n = btns.length - 1;
    else n = (i + (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
    ev.preventDefault();
    for (const b of btns) b.tabIndex = -1;
    btns[n].tabIndex = 0;
    btns[n].focus();
  });

  // ------------------------------------------------------------------------------------------------------------
  // small choices: an inline card in the year's log group; answering never stops the clock

  let smallCard = null;            // {id, small, el, opts, cd, bar, cdText, res, done, lastTxt}
  const absorbed = new WeakSet();  // log entries shown inside a small card instead of as their own lines
  const absorbedIds = new Set();

  const smallIdOf = (sm) => (sm && sm.id != null ? String(sm.id) : sm ? `${sm.year}-${sm.title}` : null);

  function syncSmall() {
    const sm = state.smallPending;
    if (ctrl.skipping) return;   // decided at once during a fast-forward; the outcome shows as ordinary lines
    if (!sm || typeof sm !== 'object' || state.dead) {
      if (smallCard && !smallCard.done) { smallCard.el.remove(); smallCard = null; }
      return;
    }
    const id = smallIdOf(sm);
    if (smallCard && smallCard.id === id && smallCard.el.isConnected) { paintSmallCountdown(); return; }
    if (smallCard && !smallCard.done) smallCard.el.remove();
    smallCard = buildSmallCard(sm, id);
    const year = isNum(sm.year) ? sm.year : state.year;
    const g = groupFor(year, isNum(sm.age) ? sm.age : year - (birth.year || year));
    g.body.prepend(smallCard.el);
    paintSmallCountdown();
  }

  function buildSmallCard(sm, id) {
    const family = sm.kind === 'family';
    const kindLabel = family ? '和家人一起决定' : '小小的选择';
    const options = (Array.isArray(sm.options) ? sm.options : []).filter((o) => o && o.id != null && o.label).slice(0, 3);
    const opts = h('div.g-sm-opts', { role: 'group', 'aria-label': `${kindLabel}：${sm.title || ''}` }, options.map((o) => h('button.g-sm-opt', {
      type: 'button', dataset: { id: String(o.id) }, onclick: () => answerSmall(o),
    }, h('span.g-sm-l', o.label), o.hint ? h('span.g-sm-h', hintNodes(o.hint)) : null)));
    const bar = h('i.g-sm-bar');
    const cdText = h('span.g-sm-cdt');
    const cd = h('div.g-sm-cd', h('span.g-sm-track', { 'aria-hidden': 'true' }, bar), cdText);
    const res = h('div.g-sm-res', { hidden: true, tabindex: '-1' });
    const el = h('article.g-sm', { class: family ? 'g-sm--family' : null, dataset: { small: id } },
      h('header.g-sm-hd', h('span.g-sm-k', kindLabel), h('span.g-sm-t', sm.title || '')),
      sm.text ? h('p.g-sm-x', sm.text) : null,
      opts, cd, res);
    return { id, small: sm, el, opts, cd, bar, cdText, res, done: false, lastTxt: '' };
  }

  function answerSmall(o) {
    const c = smallCard;
    if (!c || c.done) return;
    const r = ctrl.answerSmall(o.id);
    if (!r && smallCard === c && !c.done) {
      // the choice is gone (the year already ended): drop the stale card
      c.el.remove();
      smallCard = null;
      mark('small', 'log');
    }
  }

  function finishSmall(p) {
    const c = smallCard;
    if (!c || c.done || !p || !p.small || (p.small !== c.small && smallIdOf(p.small) !== c.id)) return false;
    c.done = true;
    const entries = Array.isArray(p.entries) ? p.entries : [];
    for (const e of entries) {
      absorbed.add(e);
      if (e && e.id != null) absorbedIds.add(String(e.id));
    }
    const hadFocus = c.el.contains(document.activeElement);
    const chosen = (p.small.options || []).find((o) => o && o.id === p.optionId);
    c.opts.remove();
    c.cd.remove();
    c.el.classList.add('g-sm--done');
    c.res.hidden = false;
    fill(c.res,
      h('p.g-sm-pick', p.type === 'auto'
        ? `这一年过去了，按「${textureLabel(ctrl.texture)}」的性子替你做了决定。`
        : ['你选了', chosen ? h('b', `「${chosen.label}」`) : null, '。']),
      entries.map((e) => entryEl(e)));
    if (hadFocus) c.res.focus({ preventScroll: true });
    smallCard = null;
    return true;
  }

  function paintSmallCountdown() {
    const c = smallCard;
    if (!c || c.done) return;
    const exp = Number(c.small.expiresYear);
    const extra = Number.isFinite(exp) ? Math.max(0, exp - state.year - 1) : 0;
    const total = extra + 1;
    const left = Math.max(0, total - (ctrl.progress || 0));
    c.bar.style.transform = `scaleX(${(left / total).toFixed(4)})`;
    const sn = lastSnap;
    const tex = textureLabel(ctrl.texture);
    let txt;
    if (sn && sn.running && isNum(sn.secondsPerYear)) {
      txt = `年底前没选的话，会按「${tex}」的性子自动决定 · 约 ${Math.max(1, Math.ceil(left * sn.secondsPerYear))} 秒`;
    } else {
      txt = `年底前没选的话，会按「${tex}」的性子自动决定 · 时间停着`;
    }
    if (txt !== c.lastTxt) { c.lastTxt = txt; c.cdText.textContent = txt; }
  }

  // ------------------------------------------------------------------------------------------------------------
  // stars: ☆ on every log line that has an id (max 12 值得记住的时刻)

  const starBtns = new Map();      // entry id -> Set of buttons (a line may show in a small card and in the log)
  const starsOn = () => typeof ctrl.has === 'function' && ctrl.has('toggleStar');

  function starButton(e) {
    const id = String(e.id);
    const on = ctrl.isStarred(e.id);
    const b = h('button.g-star', {
      type: 'button', 'aria-pressed': on ? 'true' : 'false',
      'aria-label': on ? '取消「值得记住的时刻」' : '标记为值得记住的时刻',
      title: on ? '取消标记' : '值得记住的时刻',
      onclick: () => onStar(e.id),
    }, s('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': 'true', focusable: 'false' },
      s('path', { d: STAR_PATH, 'stroke-linejoin': 'round' })));
    let set = starBtns.get(id);
    if (!set) starBtns.set(id, (set = new Set()));
    set.add(b);
    return b;
  }

  function onStar(id) {
    const r = ctrl.toggleStar(id);
    if (!r) return;
    if (r.full) { toast(STAR_FULL_MSG, 'info'); return; }
    syncStars();
  }

  function syncStars() {
    const on = starsOn();
    starCount.hidden = !on;
    if (!on) return;
    const n = ctrl.starCount();
    const max = ctrl.starMax();
    starCount.textContent = n ? `★ ${n}/${max} 个值得记住的时刻` : `点 ☆ 留下值得记住的时刻（最多 ${max} 个）`;
    for (const [id, set] of starBtns) {
      const starred = ctrl.isStarred(id) || ctrl.isStarred(Number(id));
      for (const b of set) {
        if (!b.isConnected) { set.delete(b); continue; }
        b.setAttribute('aria-pressed', starred ? 'true' : 'false');
        b.setAttribute('aria-label', starred ? '取消「值得记住的时刻」' : '标记为值得记住的时刻');
        b.title = starred ? '取消标记' : '值得记住的时刻';
        const ent = b.closest('.g-ent');
        if (ent) ent.classList.toggle('g-ent--star', starred);
      }
      if (!set.size) starBtns.delete(id);
    }
  }

  function aiDefault() {
    const mode = app.settings?.aiMode || state.settings?.aiMode || 'default';
    if (mode === 'off') return { text: '内置推演引擎', on: false };
    if (app.ai && app.ai.available) return { text: `AI 推演 · ${AI_MODES[mode] || mode}`, on: true };
    return { text: '内置推演引擎', on: false };
  }

  function renderAi(text) {
    const busy = !!text;
    const d = aiDefault();
    aiText.textContent = busy ? text : d.text;
    aiEl.className = 'g-ai' + (busy ? ' g-ai--busy' : d.on ? ' g-ai--on' : '');
  }

  // ------------------------------------------------------------------------------------------------------------
  // registry card

  function regRow(label, ...value) {
    return [h('dt', label), h('dd', ...value)];
  }

  function renderCard() {
    const p = state.person || {};
    const edu = p.education || {};
    const car = p.career || {};
    const rel = p.relationship || {};
    const kids = Array.isArray(p.children) ? p.children : [];
    const par = p.parents || {};
    const m = p.money || {};
    const pf = m.portfolio || {};
    const iso = p.country || birth.country;
    const net = (Number(m.cash) || 0) + Object.values(pf).reduce((a, v) => a + (Number(v) || 0), 0) - (Number(m.debt) || 0);
    const migrated = p.country && birth.country && p.country !== birth.country;

    const eduText = [EDU_LABELS[edu.level] || (edu.level ? String(edu.level) : '未上学'), edu.inSchool ? '在读' : null, edu.field || null].filter(Boolean).join(' · ');
    const carText = [CAREER_LABELS[car.status] || (car.status ? String(car.status) : '—'), car.title || null, car.employer || null].filter(Boolean).join(' · ');
    const relText = [RELATIONSHIP_LABELS[rel.status] || (rel.status ? String(rel.status) : '单身'), rel.partner && rel.partner.name ? rel.partner.name : null].filter(Boolean).join(' · ');
    const aliveKids = kids.filter((c) => c && c.alive !== false);
    const kidText = kids.length
      ? `${aliveKids.length} 个${kids.length !== aliveKids.length ? `（另有 ${kids.length - aliveKids.length} 个已离世）` : ''}${aliveKids.length ? `：${aliveKids.slice(0, 4).map((c) => c.name).filter(Boolean).join('、')}${aliveKids.length > 4 ? ' 等' : ''}` : ''}`
      : '无';
    const mAlive = par.mother ? par.mother.alive !== false : null;
    const fAlive = par.father ? par.father.alive !== false : null;
    let parText = '—';
    if (mAlive != null || fAlive != null) {
      if (mAlive && fAlive) parText = '父母健在';
      else if (!mAlive && !fAlive) parText = '父母均已离世';
      else parText = `${mAlive ? '母亲健在' : '母亲已离世'}，${fAlive ? '父亲健在' : '父亲已离世'}`;
    }
    const conds = (Array.isArray(p.conditions) ? p.conditions : []).filter((c) => c && c.name);

    clear(cardBody).append(
      h('div.g-card-name', h('span.g-card-name-zh', p.name || birth.name || '无名'),
        birth.nameLatin || p.nameLatin ? h('span.g-card-latin', birth.nameLatin || p.nameLatin) : null),
      h('dl.g-reg',
        regRow('性别', sex === 'male' ? '男' : '女'),
        regRow('出生', h('span.g-mono', `${birth.date || birth.year}${birth.time ? ' ' + String(birth.time).slice(0, 5) : ''}`),
          ` · ${cname(birth.country)}${birth.urban ? '城市' : '乡村'}`),
        regRow('现居', `${cname(iso)} · ${p.urban ? '城市' : '乡村'}`, migrated ? h('span.g-tag-mini', '迁居') : null),
        regRow('家境', isNum(p.familyPct ?? birth.familyPct) ? `${familyLabel(p.familyPct ?? birth.familyPct)}（同国家庭中位于 ${Math.round((p.familyPct ?? birth.familyPct) * 100)}%）` : '—'),
        regRow('教育', eduText),
        regRow('职业', carText),
        regRow('感情', relText),
        regRow('子女', kidText),
        regRow('父母', parText),
        regRow('财富', h('span', `净资产 ${money(data, iso, net)}`),
          isNum(Number(m.income)) && Number(m.income) > 0 ? h('span.g-reg-sub', `年收入 ${money(data, iso, Number(m.income))}`) : null,
          Number(m.debt) > 0 ? h('span.g-reg-sub', `负债 ${money(data, iso, Number(m.debt))}`) : null,
          h('span.g-reg-sub', '按 2021 年物价')),
        regRow('健康', conds.length
          ? h('span.g-conds', conds.slice(0, 4).map((c) => h('span.g-cond', { class: `g-cond--${clampInt(c.severity, 1, 3)}` }, c.name)))
          : '无已知疾病')),
      h('p.g-card-foot', `已做出 ${(state.decisions || []).length} 个抉择 · 世界线 ${world && world.code ? world.code : '—'}`));
  }

  // ------------------------------------------------------------------------------------------------------------
  // stats with tweened numbers and sparklines

  function renderStats() {
    const hist = state.history || [];
    const appendNow = !hist.length || hist[hist.length - 1].year !== state.year;
    const yrs = hist.map((r) => (r ? r.year : null));
    if (appendNow) yrs.push(state.year);
    const tail = yrs.slice(-60);
    const dashIdx = tail.findIndex((y) => y > HISTORY_END);
    for (const k of STATS) {
      const r = statRows[k];
      const target = clampInt(state.stats?.[k] ?? 50, 0, 100);
      const from = r.shown == null ? target : r.shown;
      const diff = target - from;
      r.fill.style.width = `${target}%`;
      r.row.setAttribute('aria-label', `${STAT_LABELS[k]} ${target}`);
      if (r.shown != null && Math.abs(diff) >= 1) flashDelta(r, diff);
      tween(r, from, target);
      const values = hist.map((row) => (row && row.stats ? row.stats[k] : null));
      if (appendNow) values.push(target);
      const sp = typeof charts.sparkline === 'function'
        ? charts.sparkline(values.slice(-60), {
          width: 88, height: 26, color: 'currentColor', min: 0, max: 100, ref: 50, label: STAT_LABELS[k],
          dashedFrom: dashIdx >= 0 ? dashIdx : undefined,
        })
        : null;
      clear(r.spark);
      if (sp) r.spark.append(sp);
    }
  }

  function tween(r, from, to) {
    cancelAnimationFrame(r.anim);
    if (reducedMotion() || from === to || ctrl.skipping) {
      r.shown = to;
      r.val.textContent = String(to);
      return;
    }
    const t0 = performance.now();
    const dur = 650;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const v = Math.round(from + (to - from) * e);
      r.val.textContent = String(v);
      r.shown = v;
      if (k < 1 && !destroyed) r.anim = requestAnimationFrame(step);
      else r.shown = to;
    };
    r.anim = requestAnimationFrame(step);
  }

  function flashDelta(r, diff) {
    clearTimeout(r.deltaTimer);
    r.delta.textContent = `${diff > 0 ? '+' : '−'}${Math.abs(Math.round(diff))}`;
    r.delta.className = 'g-stat-d ' + (diff > 0 ? 'g-stat-d--up' : 'g-stat-d--down');
    if (!reducedMotion()) {
      r.delta.classList.remove('g-flash');
      void r.delta.offsetWidth;
      r.delta.classList.add('g-flash');
    }
    r.deltaTimer = setTimeout(() => { r.delta.textContent = ''; r.delta.className = 'g-stat-d'; }, 1800);
  }

  // ------------------------------------------------------------------------------------------------------------
  // life map and threads

  function renderMap() {
    if (lm && typeof lm.update === 'function') {
      lm.update(state.history || [], { decisions: state.decisions || [], dead: !!state.dead });
    }
  }

  function jumpToYear(year) {
    if (!isNum(year)) return;
    const g = groups.get(year);
    if (!g || logEl.offsetParent === null) return;
    g.el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    g.el.classList.remove('g-yr--hl');
    void g.el.offsetWidth;
    g.el.classList.add('g-yr--hl');
  }

  function renderThreads() {
    const list = (Array.isArray(state.threads) ? state.threads : []).filter((t) => t && (t.title || t.text));
    threadsBox.hidden = !list.length;
    if (!list.length) return;
    fill(threadsBody, h('ul.g-thread-list', list.slice(0, 6).map((t) => h('li.g-thread',
      h('span.g-thread-t', t.title || '一件尚未发生的事'),
      h('span.g-thread-w', threadWhen(t, state)),
      t.source === 'ai' ? badge('AI', 'ai') : null))),
    list.length > 6 ? h('p.g-muted.g-small', `还有 ${list.length - 6} 条伏笔`) : null);
  }

  // ------------------------------------------------------------------------------------------------------------
  // life log, grouped by year (newest year first; entries inside a year in order)

  const groups = new Map();
  let rendered = 0;
  let logRef = null;
  let divider = null;

  function insertSorted(el, key) {
    el._k = key;
    for (const c of logEl.children) {
      if (c._k != null && c._k < key) { logEl.insertBefore(el, c); return; }
    }
    logEl.appendChild(el);
  }

  function groupFor(year, age) {
    let g = groups.get(year);
    if (g) return g;
    const proj = year > HISTORY_END;
    const tagEl = h('span.g-yr-tag');
    const focusEl = h('span.g-yr-focus');
    const hd = h('header.g-yr-hd',
      h('span.g-yr-y', String(year)),
      h('span.g-yr-a', isNum(age) ? `${age} 岁` : ''),
      focusEl,
      tagEl,
      proj ? badge('推演', 'proj') : year === HISTORY_END ? badge('截至 2026-10', 'real') : null);
    const body = h('div.g-yr-body');
    const el = h('section.g-yr', { class: proj ? 'g-yr--proj' : 'g-yr--real', dataset: { year: String(year) } }, hd, body);
    insertSorted(el, year);
    g = { el, hd, body, tagEl, focusEl, year, tag: null, focus: '' };
    groups.set(year, g);
    if (!divider) {
      const years = [...groups.keys()];
      if (years.some((y) => y > HISTORY_END) && years.some((y) => y <= HISTORY_END)) {
        divider = h('div.g-now-div', { role: 'separator' },
          h('span.g-now-div-k', '今天 · 2026 年 10 月'),
          h('span.g-now-div-t', '以上是推演的未来，以下是真实的历史'));
        insertSorted(divider, HISTORY_END + 0.5);
      }
    }
    return g;
  }

  function entryBadges(e) {
    const out = [];
    const proj = e.year > HISTORY_END;
    if (e.kind === 'decision' || e.kind === 'choice') out.push(badge('抉择', 'choice'));
    else if (e.kind === 'thread') out.push(badge('伏笔', 'thread'));
    else if (e.kind === 'milestone') out.push(badge('里程碑', 'mile'));
    if (e.source === 'history' || (e.kind === 'news' && !proj && e.source !== 'future')) out.push(badge('真实历史', 'real'));
    else if (e.source === 'future' || (e.kind === 'news' && proj)) out.push(badge('推演', 'proj'));
    if (e.source === 'ai') out.push(badge('AI', 'ai'));
    return out;
  }

  function entryEl(e) {
    const tone = clampInt(e.tone, -2, 2);
    const badges = entryBadges(e);
    const fx = effectChips(e.effects, { data, iso3: state.person?.country || birth.country });
    const star = e.id != null && starsOn() ? starButton(e) : null;
    const text = gentleOn() && typeof e.gentleText === 'string' && e.gentleText ? e.gentleText : e.text;
    const el = h('article.g-ent', {
      class: `g-tone-${tone < 0 ? 'n' : 'p'}${Math.abs(tone)}${star ? ' g-ent--starable' : ''}${star && ctrl.isStarred(e.id) ? ' g-ent--star' : ''}`,
      dataset: { kind: e.kind || 'event' },
    },
    badges.length ? h('div.g-ent-b', badges) : null,
    h('p.g-ent-t', String(text || '')),
    fx.length ? h('div.g-fxs.g-fxs--sm', fx) : null,
    star);
    return el;
  }

  const isAbsorbed = (e) => absorbed.has(e) || (e.id != null && absorbedIds.has(String(e.id)));

  function renderLog() {
    const log = Array.isArray(state.log) ? state.log : [];
    const gentle = gentleOn();
    if (gentle !== gentleShown) { gentleShown = gentle; logRef = null; }   // re-word the whole log
    if (log !== logRef || log.length < rendered) {
      clear(logEl);
      groups.clear();
      divider = null;
      rendered = 0;
      logRef = log;
      starBtns.clear();
      absorbedIds.clear();     // a rebuilt log shows every line on its own again
      if (smallCard) smallCard = null;
    }
    const fresh = [];
    for (; rendered < log.length; rendered++) {
      const e = log[rendered];
      if (!e || typeof e !== 'object') continue;
      const year = isNum(e.year) ? e.year : state.year;
      const g = groupFor(year, isNum(e.age) ? e.age : year - (birth.year || year));
      if (isAbsorbed(e) && g.body.querySelector('.g-sm--done')) continue;   // already shown inside its small card
      const el = entryEl(e);
      g.body.append(el);
      fresh.push(el);
    }
    if (fresh.length && !reducedMotion() && !ctrl.skipping && rendered > fresh.length) {
      for (const el of fresh) el.classList.add('g-ent--new');
    }
    for (const g of groups.values()) {
      const row = historyRow(g.year);
      const tag = row && row.tag;
      if (tag && tag !== g.tag) {
        g.tag = tag;
        clear(g.tagEl).append(h('i.g-yr-dot', { 'aria-hidden': 'true', dataset: { tag } }), YEAR_TAG_LABELS[tag] || tag);
        g.tagEl.dataset.tag = tag;
      }
      const fl = row && row.focus != null ? focusLabel(row.focus) : '';
      if (fl !== (g.focus || '')) {
        g.focus = fl;
        g.focusEl.textContent = fl ? `重心 · ${fl}` : '';
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // world ticker (rotates; full list on demand)

  function currentNews() {
    const y = livedYear();
    let items = [];
    const lr = ctrl.lastResult;
    if (lr && lr.year === y && Array.isArray(lr.news) && lr.news.length) items = lr.news;
    else {
      try { items = world && typeof world.headlines === 'function' ? world.headlines(y, state.person?.country || birth.country, 6) : []; } catch { items = []; }
    }
    return { year: y, items: (items || []).filter((e) => e && e.title).slice(0, 8) };
  }

  function tickerItem(ev, full) {
    return h(full ? 'li.g-tk-item' : 'div.g-tk-cur',
      eventSourceBadge(ev),
      h('span.g-tk-t', ev.title),
      full && ev.summary ? h('span.g-tk-s', ev.summary) : null);
  }

  function renderTicker() {
    const { year, items } = currentNews();
    const changed = year !== tk.year || items.length !== tk.items.length || items.some((e, i) => tk.items[i] !== e);
    tk.year = year;
    if (changed) { tk.items = items; tk.idx = 0; }
    tickerYear.textContent = `${year} 年的世界`;
    ticker.classList.toggle('g-ticker--proj', year > HISTORY_END);
    tickerToggle.hidden = items.length < 2;
    tickerToggle.textContent = tk.open ? '收起' : `全部 ${items.length} 条`;
    tickerToggle.setAttribute('aria-expanded', tk.open ? 'true' : 'false');
    clear(tickerLine);
    if (!items.length) {
      tickerLine.append(h('span.g-muted', year > HISTORY_END ? '这一年的推演世界里没有特别的大事。' : '这一年没有收录的大事。'));
    } else {
      const ev = items[tk.idx % items.length];
      const cur = tickerItem(ev, false);
      cur.title = ev.summary || '';
      if (!reducedMotion() && changed === false) cur.classList.add('g-tk-cur--in');
      append(tickerLine, [cur, items.length > 1 ? h('span.g-tk-n', { 'aria-hidden': 'true' }, `${(tk.idx % items.length) + 1}/${items.length}`) : null]);
    }
    tickerList.hidden = !tk.open;
    if (tk.open) fill(tickerList, items.map((e) => tickerItem(e, true)));
  }

  function toggleTicker() {
    tk.open = !tk.open;
    renderTicker();
  }

  ticker.addEventListener('pointerenter', () => { tk.hover = true; });
  ticker.addEventListener('pointerleave', () => { tk.hover = false; });
  ticker.addEventListener('focusin', () => { tk.hover = true; });
  ticker.addEventListener('focusout', () => { tk.hover = false; });
  tickerLine.addEventListener('click', () => { if (tk.items.length > 1) toggleTicker(); });
  if (!reducedMotion()) {
    tk.timer = setInterval(() => {
      if (destroyed || tk.hover || tk.open || tk.items.length < 2 || document.hidden) return;
      tk.idx = (tk.idx + 1) % tk.items.length;
      renderTicker();
    }, 5200);
  }

  // ------------------------------------------------------------------------------------------------------------
  // right panels

  function sideVisible() {
    return rightCol.offsetParent !== null || getComputedStyle(rightCol).display !== 'none';
  }

  function renderSide(force) {
    const id = ui.side;
    if (!force && !sideDirty[id]) return;
    if (!sideVisible()) return;
    if (ctrl.skipping && !force) return;   // repainted when the fast-forward ends
    sideDirty[id] = false;
    const p = panels[id];
    try {
      if (id === 'country') renderCountry(p);
      else if (id === 'survival') renderSurvival(p);
      else if (id === 'cohort') renderCohort(p);
      else if (id === 'world') renderWorld(p);
    } catch (e) {
      console.error('[game] side', id, e);
      clear(p).append(h('p.g-muted', '这部分资料暂时无法显示。'));
    }
  }

  // ---- 国家 ----
  const seriesCache = new Map();
  function rangeSeries(iso, key) {
    const ck = `${iso}|${key}`;
    if (seriesCache.has(ck)) return seriesCache.get(ck);
    const pts = RANGE_YEARS.map((y) => ({ y, v: indicator(iso, key, y) }));
    seriesCache.set(ck, pts);
    return pts;
  }

  function rangeSvg(pts, { birthYear, year, birthV, nowV }) {
    const W = 240;
    const H = 44;
    const P = 5;
    const vals = pts.filter((p) => isNum(p.v));
    if (vals.length < 2) return h('span.g-muted.g-small', '数据不足');
    let lo = Math.min(...vals.map((p) => p.v));
    let hi = Math.max(...vals.map((p) => p.v));
    for (const v of [birthV, nowV]) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const X = (yy) => P + ((Math.min(LAST_YEAR, Math.max(FIRST_YEAR, yy)) - FIRST_YEAR) / (LAST_YEAR - FIRST_YEAR)) * (W - 2 * P);
    const Y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
    const path = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${X(p.y).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ');
    const real = vals.filter((p) => p.y <= HISTORY_END);
    const proj = vals.filter((p) => p.y >= HISTORY_END);
    const nodes = [
      s('rect', { x: X(HISTORY_END + 0.8), y: 0, width: W - P - X(HISTORY_END + 0.8), height: H, class: 'g-ind-projbg' }),
      s('line', { x1: X(HISTORY_END + 0.8), x2: X(HISTORY_END + 0.8), y1: 0, y2: H, class: 'g-ind-today' }),
    ];
    if (real.length > 1) nodes.push(s('path', { d: path(real), class: 'g-ind-real' }));
    if (proj.length > 1) nodes.push(s('path', { d: path(proj), class: 'g-ind-proj' }));
    if (isNum(birthV) && birthYear >= FIRST_YEAR && birthYear <= LAST_YEAR) {
      nodes.push(s('circle', { cx: X(birthYear).toFixed(1), cy: Y(birthV).toFixed(1), r: 3.2, class: 'g-ind-birth' }));
    }
    if (isNum(nowV)) nodes.push(s('circle', { cx: X(year).toFixed(1), cy: Y(nowV).toFixed(1), r: 3.6, class: 'g-ind-now' }));
    return s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'g-ind-svg', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'none' }, nodes);
  }

  function countryCtx(iso, year) {
    try {
      if (typeof engine.countryContext === 'function') {
        const c = engine.countryContext(data, world, iso, year);
        if (c) return c;
      }
    } catch (e) { console.warn('[game] countryContext', e); }
    const c = data.country ? data.country(iso) : null;
    let events = [];
    try { events = world && world.events ? world.events(iso, year) : []; } catch { events = []; }
    return {
      iso3: iso, year, country: cname(iso), region: c ? c.region : '', incomeGroup: data.incomeGroup ? data.incomeGroup(iso, year) : '',
      tfr: indicator(iso, 'tfr', year), medAge: indicator(iso, 'med_age', year), gini: indicator(iso, 'gini', year),
      secEnroll: indicator(iso, 'sec_enroll', year), terEnroll: indicator(iso, 'ter_enroll', year), conflict: 0, events,
      projection: year > HISTORY_END,
    };
  }

  function renderCountry(p) {
    const res = state.person?.country || birth.country;
    const migrated = res && birth.country && res !== birth.country;
    const iso = migrated && ui.countryView === 'birth' ? birth.country : res;
    const year = nowYear();
    const ctx = countryCtx(iso, year);
    const proj = year > HISTORY_END;
    const pop = indicator(iso, 'pop', year);
    const igroup = ctx.incomeGroup || (world && world.incomeGroup ? world.incomeGroup(iso, year) : '');

    const head = h('div.g-cty-hd',
      h('h3.g-cty-name', cname(iso)),
      h('p.g-cty-meta', [REGIONS[ctx.region] || '', incomeLabel(igroup) ? `${incomeLabel(igroup)}国家` : '', isNum(pop) ? `人口 ${fmt.cn(pop * 1000)}` : ''].filter(Boolean).join(' · ')),
      h('p.g-cty-when', `${year} 年 `, yearBadge(year)));
    const switcher = migrated ? h('div.g-seg', { role: 'group', 'aria-label': '查看哪个国家' },
      h('button.g-seg-b', { type: 'button', 'aria-pressed': ui.countryView !== 'birth' ? 'true' : 'false', onclick: () => { ui.countryView = 'now'; renderSide(true); } }, `现居 · ${cname(res)}`),
      h('button.g-seg-b', { type: 'button', 'aria-pressed': ui.countryView === 'birth' ? 'true' : 'false', onclick: () => { ui.countryView = 'birth'; renderSide(true); } }, `出生地 · ${cname(birth.country)}`)) : null;

    const rows = INDICATORS.map((ind) => {
      const nowV = indicator(iso, ind.key, year);
      const birthV = indicator(iso, ind.key, birth.year);
      const pts = rangeSeries(iso, ind.key);
      const v2000 = pts[0] && pts[0].v;
      const v2090 = pts[pts.length - 1] && pts[pts.length - 1].v;
      let trend = null;
      if (isNum(nowV) && isNum(birthV) && Math.abs(nowV - birthV) > Math.abs(birthV) * 0.005 && year !== birth.year) {
        const up = nowV > birthV;
        const good = ind.better === 0 ? null : (up ? ind.better > 0 : ind.better < 0);
        trend = h('span.g-ind-trend', { class: good == null ? '' : good ? 'g-ind-trend--good' : 'g-ind-trend--bad', title: '与出生时相比' }, up ? '↑' : '↓');
      }
      return h('div.g-ind', { class: proj ? 'g-ind--proj' : '' },
        h('div.g-ind-top',
          h('span.g-ind-l', ind.label, ind.note ? h('span.g-ind-note', ind.note) : null),
          h('span.g-ind-v', fmtIndicator(ind, nowV), trend, proj ? h('span.g-ind-pmark', { title: '推演值' }, '推演') : null)),
        rangeSvg(pts, { birthYear: birth.year, year, birthV, nowV }),
        h('div.g-ind-foot',
          h('span', `2000 年 ${fmtIndicator(ind, v2000)}`),
          h('span.g-ind-birthlbl', `出生时 ${fmtIndicator(ind, birthV)}`),
          h('span.g-ind-proj-l', `2090 年 ${fmtIndicator(ind, v2090)}`)));
    });

    const facts = [];
    if (isNum(ctx.tfr)) facts.push(['总和生育率', ctx.tfr.toFixed(2)]);
    if (isNum(ctx.medAge)) facts.push(['年龄中位数', `${ctx.medAge.toFixed(1)} 岁`]);
    if (isNum(ctx.gini)) facts.push(['基尼系数', (ctx.gini > 1 ? ctx.gini / 100 : ctx.gini).toFixed(2)]);
    if (isNum(ctx.secEnroll)) facts.push(['中学毛入学率', `${Math.round(ctx.secEnroll)}%`]);
    if (isNum(ctx.terEnroll)) facts.push(['高等教育毛入学率', `${Math.round(ctx.terEnroll)}%`]);
    if (isNum(ctx.youthUnemp)) facts.push(['青年失业率', `${ctx.youthUnemp.toFixed(1)}%`]);
    facts.push(['安全局势', CONFLICT_LABELS[clampInt(ctx.conflict, 0, 3)]]);

    const evs = (Array.isArray(ctx.events) ? ctx.events : []).filter((e) => e && e.title).slice(0, 4);
    fill(p,
      head, switcher,
      h('div.g-legend-row', h('span.g-lg.g-lg--birth', '出生时'), h('span.g-lg.g-lg--now', '今年'), h('span.g-lg.g-lg--proj', '2027 年起为推演')),
      h('div.g-inds', rows),
      h('dl.g-facts', facts.map(([k, v]) => [h('dt', k), h('dd', v)])),
      evs.length ? h('div.g-cty-evs', h('h4.g-h4', '这一年影响这里的大事'),
        h('ul.g-evlist', evs.map((e) => h('li', eventSourceBadge(e), h('span.g-ev-t', e.title), e.summary ? h('span.g-ev-s', e.summary) : null)))) : null,
      h('p.g-src', '数据：联合国《世界人口展望 2024》、世界银行 WDI。2027 年起为基于当前趋势和本条世界线情景的推演值，不是预测。'));
  }

  // ---- 生存曲线 ----
  function interpAt(ages, vals, a) {
    for (let i = 1; i < ages.length; i++) {
      if (a <= ages[i]) {
        const t = (a - ages[i - 1]) / ((ages[i] - ages[i - 1]) || 1);
        const x = vals[i - 1];
        const y = vals[i];
        if (!isNum(x) || !isNum(y)) return isNum(y) ? y : x;
        return x + (y - x) * t;
      }
    }
    return null;
  }
  function crossAt(ages, vals, level) {
    for (let i = 1; i < ages.length; i++) {
      const a = vals[i - 1];
      const b = vals[i];
      if (isNum(a) && isNum(b) && a >= level && b < level) return ages[i - 1] + ((a - level) / ((a - b) || 1)) * (ages[i] - ages[i - 1]);
    }
    return null;
  }
  const pctTxt = (v) => (!isNum(v) ? '—' : v >= 0.995 && v < 1 ? '>99%' : v > 0 && v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`);

  function renderSurvival(p) {
    let curve = null;
    try { curve = typeof engine.survivalCurve === 'function' ? engine.survivalCurve(data, world, state) : null; } catch (e) { console.warn('[game] survivalCurve', e); }
    const ages = curve && Array.isArray(curve.ages) ? curve.ages.map(Number) : [];
    const norm = (arr) => {
      const a = Array.isArray(arr) ? arr.map((v) => (v == null ? null : Number(v))) : [];
      const mx = Math.max(0, ...a.filter(isNum));
      return mx > 1.5 ? a.map((v) => (isNum(v) ? v / 100 : null)) : a;
    };
    const personal = norm(curve && curve.personal);
    const baseline = norm(curve && curve.baseline);
    const ok = ages.length >= 2 && personal.some(isNum);
    const age = state.age ?? 0;
    const items = [];
    if (ok) {
      for (const a of SURVIVAL_AGES) {
        if (a <= age || a > ages[ages.length - 1]) continue;
        items.push(h('div.g-surv-k',
          h('span.g-surv-a', `活到 ${a} 岁`),
          h('span.g-surv-p', pctTxt(interpAt(ages, personal, a))),
          baseline.some(isNum) ? h('span.g-surv-b', `同龄平均 ${pctTxt(interpAt(ages, baseline, a))}`) : null));
      }
    }
    const median = ok ? crossAt(ages, personal, 0.5) : null;
    const baseMedian = ok && baseline.some(isNum) ? crossAt(ages, baseline, 0.5) : null;
    const lede = items.length
      ? h('p.g-surv-lede', h('span', '活到 80 岁的概率'), h('b', age >= 80 ? '已活过 80 岁' : pctTxt(interpAt(ages, personal, 80))))
      : null;
    const chart = ok && typeof charts.survivalChart === 'function'
      ? charts.survivalChart({ ages, personal, baseline }, { currentAge: age, highlightAges: [60, 80, 100], height: 210 })
      : h('p.g-muted', '生存曲线暂时无法计算。');

    const now = state.year;
    const factors = [];
    for (const m of Array.isArray(state.hazardMods) ? state.hazardMods : []) {
      if (!m || !isNum(Number(m.mult)) || (m.untilYear != null && m.untilYear < now)) continue;
      if (Math.abs(m.mult - 1) < 0.03) continue;
      factors.push(h('li', { class: m.mult > 1 ? 'g-fac--bad' : 'g-fac--good' }, `${m.mult > 1 ? '风险上升' : '风险下降'}：${m.reason || '近期经历'}${m.untilYear ? `（至 ${m.untilYear} 年）` : ''}`));
    }
    for (const c of Array.isArray(state.person?.conditions) ? state.person.conditions : []) {
      if (c && c.name) factors.push(h('li.g-fac--bad', `疾病：${c.name}`));
    }
    if (state.person?.flags?.smoker) factors.push(h('li.g-fac--bad', '吸烟'));
    const hs = state.stats?.health;
    if (isNum(hs)) factors.push(h('li', { class: hs >= 60 ? 'g-fac--good' : hs < 40 ? 'g-fac--bad' : '' }, `健康指标 ${Math.round(hs)}`));

    fill(p,
      lede,
      chart,
      items.length ? h('div.g-surv-grid', items) : null,
      h('dl.g-facts',
        h('dt', '出生时预期寿命'), h('dd', `${ctrl.leBirth.toFixed(1)} 岁`),
        isNum(median) ? [h('dt', '一半的可能活过'), h('dd', `${Math.round(median)} 岁${isNum(baseMedian) ? `（同龄平均 ${Math.round(baseMedian)} 岁）` : ''}`)] : null),
      factors.length ? h('div', h('h4.g-h4', '正在影响你寿命的因素'), h('ul.g-factors', factors)) : null,
      h('p.g-src', `基于联合国《世界人口展望 2024》${cname(state.person?.country || birth.country)}生命表（2024 年后为中方案预测），并按你的健康、收入、疾病、经历和这条世界线调整。概率只描述可能性，不是命运。`));
  }

  // ---- 同一秒 ----
  function peerNow(peer, year) {
    let st = null;
    try { st = typeof cohortMod.peerStatusAt === 'function' ? cohortMod.peerStatusAt(peer, year) : null; } catch { st = null; }
    const dead = peer.deathYear != null && peer.deathYear <= year;
    let status = '';
    if (typeof st === 'string') status = st;
    else if (st && typeof st === 'object') status = st.status || st.text || '';
    if (!status) {
      const tl = Array.isArray(peer.timeline) ? peer.timeline.filter((t) => t && t.year <= year) : [];
      status = tl.length ? tl[tl.length - 1].status : '';
    }
    const alive = st && typeof st === 'object' && typeof st.alive === 'boolean' ? st.alive : !dead;
    return { alive, status };
  }

  function renderCohort(p) {
    const peers = Array.isArray(state.cohort) ? state.cohort.filter(Boolean) : [];
    const year = nowYear();
    if (!peers.length) {
      clear(p).append(h('p.g-muted', '这一次没有记录到与你同一秒出生的人。'));
      return;
    }
    const rows = peers.map((peer) => {
      const st = peerNow(peer, year);
      const cause = peer.deathCause && typeof peer.deathCause === 'object' ? peer.deathCause.name : peer.deathCause;
      return h('li.g-peer', { class: st.alive ? '' : 'g-peer--gone' },
        h('span.g-peer-av', { 'aria-hidden': 'true' }, String(peer.name || '?').slice(0, 1)),
        h('span.g-peer-main',
          h('span.g-peer-n', peer.name || '无名', h('span.g-peer-sx', peer.sex === 'male' ? '男' : '女')),
          h('span.g-peer-c', `${cname(peer.country)}${isNum(peer.familyPct) ? ` · 家境${familyLabel(peer.familyPct)}` : ''}`),
          h('span.g-peer-s', st.alive ? (st.status || '还在生活着') : `已于 ${peer.deathYear} 年离世${cause ? `（${cause}）` : ''}`)));
    });
    const alive = peers.filter((pe) => peerNow(pe, year).alive).length;
    fill(p,
      h('p.g-cohort-lede', `${birth.date || birth.year}${birth.time ? ` ${birth.time}` : ''}，与你同一秒出生的还有这些人（虚构，按当年各国出生人数抽取）。`),
      h('p.g-cohort-count', h('b', `${alive}`), ` / ${peers.length} 人在 ${year} 年仍在世`),
      h('ul.g-peers', rows),
      h('p.g-src', '他们的人生由同一套数据和规则推演：同一秒出生，命运却因国家、家庭和时代而不同。'));
  }

  // ---- 世界线 ----
  function renderWorld(p) {
    if (!world) {
      clear(p).append(h('p.g-muted', '世界线暂时无法显示。'));
      return;
    }
    const year = nowYear();
    let tl = [];
    try { tl = typeof world.timeline === 'function' ? world.timeline() : []; } catch { tl = []; }
    tl = (tl || []).filter((e) => e && e.title && isNum(e.year)).sort((a, b) => a.year - b.year || (b.importance || 0) - (a.importance || 0));
    const upcoming = tl.filter((e) => e.year > year).slice(0, 8);
    const passed = tl.filter((e) => e.year <= year && e.year >= Math.max(HISTORY_END + 1, birth.year || 0)).slice(-4).reverse();
    const evItem = (e) => h('li.g-wl-ev', { class: e.source === 'shock' ? 'g-wl-ev--shock' : '' },
      h('span.g-wl-y', String(e.year)),
      h('span.g-wl-main', h('span.g-wl-t', e.title, ' ', eventSourceBadge(e)), e.summary ? h('span.g-wl-s', e.summary) : null));
    const dims = Array.isArray(world.dims) ? world.dims : [];
    fill(p,
      h('h3.g-wl-label', world.label || '世界线'),
      world.description ? h('p.g-wl-desc', world.description) : null,
      dims.length ? h('div.g-wl-dims', h('h4.g-h4', '这条世界线上的走向'),
        h('ul.g-dims', dims.map((d) => h('li.g-dim',
          h('span.g-dim-t', d.title),
          h('span.g-dim-b', d.branch?.title || '—'),
          isNum(d.branch?.prob) ? h('span.g-dim-p', `约 ${Math.max(1, Math.round(d.branch.prob * 100))}%`) : null,
          d.branch?.description ? h('span.g-dim-d', d.branch.description) : null)))) : null,
      year <= HISTORY_END ? h('p.g-wl-note', `你现在还在真实历史里（${year} 年）。从 2027 年开始，世界会沿着这条推演的世界线展开。`) : null,
      upcoming.length ? h('div', h('h4.g-h4', '接下来可能发生'), h('ol.g-wl-list', upcoming.map(evItem))) : h('p.g-muted', '在可见的推演范围内没有更多大事。'),
      passed.length ? h('div', h('h4.g-h4', '你已经经历的推演事件'), h('ol.g-wl-list.g-wl-list--past', passed.map(evItem))) : null,
      h('p.g-src', '2027 年以后的世界是根据今天的人口、经济、技术、气候和地缘趋势推演出的众多可能之一，不是预言。每次新的人生都会抽取一条新的世界线，也可以选择沿用这一条。'));
  }

  // ------------------------------------------------------------------------------------------------------------
  // controls

  function renderControls(snap) {
    const sn = snap || ctrl.snapshot();
    lastSnap = sn;
    const busy = !!sn.flow || sn.pending;
    const playing = sn.running || sn.skipping;
    clear(playIcon).append(svgIcon(playing ? ICONS.pause : ICONS.play));
    playLabel.textContent = sn.dead ? '已结束' : busy ? '抉择中' : sn.moment ? '停一下' : playing ? '暂停' : '继续';
    btnPlay.disabled = sn.dead || busy || !!sn.moment;
    btnPlay.setAttribute('aria-label', playing ? '暂停' : '继续');
    for (const b of speedBtns) b.setAttribute('aria-pressed', Number(b.dataset.x) === sn.speed ? 'true' : 'false');
    speedCycle.textContent = speedText(sn.speed);
    speedCycle.setAttribute('aria-label', `速度 ${speedText(sn.speed)}，点按切换`);
    btnSkip.disabled = !sn.canAct || sn.skipping;
    btnSkip.classList.toggle('g-cb--busy', sn.skipping);
    btnAuto.setAttribute('aria-checked', sn.autoChoose ? 'true' : 'false');
    btnAuto.disabled = sn.dead;
    const tex = textureLabel(sn.texture);
    texValue.textContent = tex;
    btnTexture.setAttribute('aria-label', `自动抉择的性子：${tex}，点按更换`);
    btnTexture.disabled = sn.dead;
    btnCustom.disabled = !sn.canAct;
    btnNote.disabled = sn.dead || !!sn.moment || (!!sn.flow && !sn.waiting);
    if (btnFamily) btnFamily.disabled = false;
    if (btnMoney) btnMoney.disabled = false;
    pillRow.hidden = !sn.waiting;
    let st = '';
    if (sn.dead) st = '这一生结束了';
    else if (sn.skipping) st = '正在快进到下一个抉择…';
    else if (sn.moment) st = MOMENT_STATUS[sn.moment] || '时间停在这里';
    else if (sn.waiting) st = '有一个抉择在等你';
    else if (sn.flow === 'custom') st = '主动选择中';
    else if (busy) st = '等待你的抉择';
    else if (sn.hidden) st = '页面在后台，已暂停';
    else if (sn.reasons && sn.reasons.includes('panel')) st = '正在翻看，时间停着';
    else if (sn.userPaused) st = '已暂停 · 按空格继续';
    else if (sn.running) st = `每年约 ${sn.secondsPerYear < 10 ? sn.secondsPerYear.toFixed(1) : Math.round(sn.secondsPerYear)} 秒`;
    ctrlStatus.textContent = st;
    page.classList.toggle('g-game--paused', !playing && !sn.dead);
    page.classList.toggle('g-game--skipping', sn.skipping);
    page.classList.toggle('g-game--waiting', !!sn.waiting);
    syncMusic(sn);
    paintSmallCountdown();
  }

  // ------------------------------------------------------------------------------------------------------------
  // auto-choose texture (性子): a small dialog listing the textures; the choice is saved in settings.autoTexture

  function openTexture() {
    if (state.dead) return;
    if (typeof app.modal !== 'function') { app.go?.('settings'); return; }
    let close = () => {};
    const cur = ctrl.texture;
    const list = h('div.g-texlist', { role: 'group', 'aria-label': '自动抉择的性子' }, AUTO_TEXTURES.map((t) => h('button.g-texopt', {
      type: 'button', 'aria-pressed': t.id === cur ? 'true' : 'false', dataset: { id: t.id },
      onclick: () => {
        if (t.id !== ctrl.texture) {
          ctrl.setTexture(t.id);
          toast(`之后会按「${t.label}」的性子替你选择。`, 'good');
        }
        close();
      },
    }, h('span.g-texopt-l', t.label), h('span.g-texopt-h', t.hint))));
    list.addEventListener('keydown', (ev) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(ev.key)) return;
      const btns = [...list.querySelectorAll('.g-texopt')];
      const i = Math.max(0, btns.indexOf(document.activeElement));
      const n = (i + (ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length;
      ev.preventDefault();
      btns[n].focus();
    });
    const pressed = list.querySelector('.g-texopt[aria-pressed="true"]');
    close = app.modal({
      eyebrow: '自动抉择',
      title: '按什么性子替你选',
      body: [
        h('p.g-texlede', '开启「自动抉择」后替你做的选择、年底前没回答的小选择，以及交给「自动」的每年重心，都会按这种性子来。'),
        list,
      ],
      actions: [h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => close() }, '关闭')],
      onDismiss: () => close(),
      initialFocus: pressed || undefined,
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // panels (家人与生活 / 花钱·投资, provided by the app shell) and the background music

  /** The shell's side sheet; it holds the clock (reason 'panel') while it is open and saves what changes there. */
  function openPanel(name) {
    if (typeof app.openPanel !== 'function') return;
    try { app.openPanel(name); } catch (e) {
      console.error('[game] openPanel', e);
      toast('这一页附页暂时打不开。', 'warn');
    }
  }

  // one soundtrack for the whole session: leaving the game screen only pauses it, so coming back needs no new gesture
  const music = sharedMusic || (sharedMusic = createMusic());
  let musicOn = !!app.settings?.music;
  let musicArmed = false;

  // the page already had a click or key press (e.g. 开始这一生), so audio may start without waiting for another one
  const activated = () => { try { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); } catch { return false; } };

  /** Follow the saved switch: start now when the page has had a gesture, otherwise on the next one. */
  function initMusic() {
    paintMusic();
    if (!musicOn) { disarmGesture(); if (music.isOn()) music.stop(); return; }
    music.setMood(moodNow());
    if (music.isOn() || activated()) { music.start(); syncMusic(); }
    armMusic();   // the next gesture (re)unlocks audio in browsers that still held it back
  }

  function paintMusic() {
    btnMusic.setAttribute('aria-pressed', musicOn ? 'true' : 'false');
    btnMusic.title = musicOn ? '关掉背景音乐' : '打开轻柔的背景音乐';
    btnMusic.hidden = !music.isAvailable();
  }

  function syncMusic(sn) {
    const s2 = sn || lastSnap;
    music.setPlaying(!destroyed && !!s2 && !s2.dead && !s2.hidden && !s2.userPaused && !(s2.reasons || []).includes('away'));
  }

  function moodNow() {
    const hist = state.history || [];
    const row = hist.length ? hist[hist.length - 1] : null;
    return row && isNum(row.mood) ? row.mood : 0;
  }

  // a saved "music on" can only start after the first gesture on the page (browsers block audio before one)
  const armGesture = (ev) => {
    if (destroyed || !musicOn) return;
    if (ev && ev.target && btnMusic.contains(ev.target)) return;   // the toggle itself decides
    disarmGesture();
    music.setMood(moodNow());
    music.start();
    syncMusic();
  };
  function armMusic() {
    if (musicArmed || !musicOn) return;
    musicArmed = true;
    document.addEventListener('pointerdown', armGesture, true);
    document.addEventListener('keydown', armGesture, true);
  }
  function disarmGesture() {
    if (!musicArmed) return;
    musicArmed = false;
    document.removeEventListener('pointerdown', armGesture, true);
    document.removeEventListener('keydown', armGesture, true);
  }

  function toggleMusic() {
    musicOn = !musicOn;
    disarmGesture();
    try { app.saveSettings?.({ music: musicOn }); } catch { /* settings are optional */ }
    if (musicOn) {
      music.setMood(moodNow());
      if (!music.start()) {
        musicOn = false;
        try { app.saveSettings?.({ music: false }); } catch { /* ignore */ }
        toast('这个浏览器放不了网页音乐。', 'warn');
      } else {
        toast(lastSnap && lastSnap.running ? '音乐很轻，暂停时也会跟着停下。' : '时间走起来时，音乐会轻轻响起。', 'info');
      }
    } else {
      music.stop();
    }
    paintMusic();
    syncMusic();
  }

  // ------------------------------------------------------------------------------------------------------------
  // death curtain

  function showCurtain(rec) {
    const d0 = rec || state.dead || {};
    const d = gentleOn() && d0.causeGentle && d0.causeGentle.name ? { ...d0, cause: d0.causeGentle } : d0;
    const p = state.person || {};
    clear(curtain).append(h('div.g-curtain-in',
      h('p.g-curtain-k', '生命的终点'),
      h('p.g-curtain-name', p.name || birth.name || ''),
      h('p.g-curtain-years', `${birth.year} — ${d.year ?? state.year}`),
      h('p.g-curtain-age', `享年 ${d.age ?? state.age} 岁`),
      d.cause && d.cause.name ? h('p.g-curtain-cause', d.cause.name) : null,
      h('p.g-curtain-note', h('span.g-dots', { 'aria-hidden': 'true' }), '正在整理死亡证明')));
    curtain.hidden = false;
    requestAnimationFrame(() => curtain.classList.add('g-curtain--in'));
  }

  // ------------------------------------------------------------------------------------------------------------
  // keyboard

  const onKey = (ev) => {
    if (destroyed || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('.g-ov, .ll-modal, .ll-sheet-wrap')) return;
    if (ev.key === ' ' || ev.code === 'Space') {
      if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return;
      ev.preventDefault();
      ctrl.toggle();
    } else if (ev.key === '+' || ev.key === '=') {
      ctrl.faster();
    } else if (ev.key === '-' || ev.key === '_') {
      ctrl.slower();
    }
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------------------------------------------------------
  // controller events

  offs.push(ctrl.on('year', () => {
    sceneUpdate(0);
    if (typeof music.setStage === 'function') music.setStage(Number(ctrl.state && ctrl.state.age) || 0);
    markYear();
    if (!ctrl.skipping) music.setMood(moodNow());
  }));
  offs.push(ctrl.on('resolved', () => markYear()));
  offs.push(ctrl.on('tick', (f) => { if (!destroyed) { paintMonth(f, false); if (!ctrl.skipping) sceneUpdate(f); } }));
  offs.push(ctrl.on('state', (snap) => { if (!destroyed) renderControls(snap); }));
  offs.push(ctrl.on('ai', (text) => { if (!destroyed) renderAi(text); }));
  offs.push(ctrl.on('decision', () => { mark('controls', 'strip'); if (!ctrl.skipping && typeof music.motif === 'function') music.motif('decision'); }));
  offs.push(ctrl.on('log', () => mark('log', 'stars')));
  offs.push(ctrl.on('small', (p) => {
    if (destroyed || !p) return;
    if (p.type === 'new') { mark('small'); return; }
    finishSmall(p);
    mark('log', 'card', 'stats', 'small', 'stars');
  }));
  offs.push(ctrl.on('changed', (p) => {
    if (destroyed) return;
    const what = p && p.what;
    if (what === 'stars') mark('stars');
    else if (what === 'focus' || what === 'texture') mark('focus', 'small', 'controls');
    else mark('log', 'card', 'stats', 'focus', 'stars', 'controls');
  }));
  offs.push(ctrl.on('moment', () => mark('controls')));
  offs.push(ctrl.on('waiting', () => { if (!destroyed) renderControls(ctrl.snapshot()); }));
  offs.push(ctrl.on('skip', (on) => {
    if (!on) { for (const k of Object.keys(sideDirty)) sideDirty[k] = true; markYear(); music.setMood(moodNow()); }
  }));
  offs.push(ctrl.on('death', (rec) => {
    sceneUpdate(1);
    if (typeof music.motif === 'function') music.motif('death');
    markYear();
    showCurtain(rec);
    music.setPlaying(false);
  }));
  offs.push(bus.on('ai:status', () => { if (!destroyed) renderAi(ctrl.aiText || ''); }));
  offs.push(bus.on('ai:changed', () => { if (!destroyed) renderAi(ctrl.aiText || ''); }));
  offs.push(bus.on('settings', (st) => {
    if (destroyed) return;
    renderAi(ctrl.aiText || '');
    renderControls(ctrl.snapshot());
    mark('focus');
    if (gentleOn() !== gentleShown) mark('log', 'small', 'stars');
    // music switched in the settings screen (or another tab of the shell)
    const want = !!(st && typeof st === 'object' ? st.music : app.settings?.music);
    if (want !== musicOn) {
      musicOn = want;
      initMusic();
    }
  }));

  // ------------------------------------------------------------------------------------------------------------
  // first paint

  paintTabs();
  setMTabInitial();
  renderAi(ctrl.aiText || '');
  renderStrip();
  renderFocus();
  renderCard();
  renderStats();
  renderMap();
  renderThreads();
  renderLog();
  syncSmall();
  syncStars();
  renderTicker();
  renderControls(ctrl.snapshot());
  initMusic();
  measure();
  requestAnimationFrame(() => { measure(); renderSide(true); });

  function setMTabInitial() {
    page.dataset.mtab = SIDE_TABS.some(([k]) => k === ui.mtab) ? 'side' : ui.mtab;
    if (page.dataset.mtab === 'side') ui.side = ui.mtab;
    paintTabs();
  }

  ctrl.attach();
  ctrl.start();
  if (state.dead) showCurtain(state.dead);

  requestAnimationFrame(() => sceneUpdate());
  return () => {
    destroyed = true;
    scene.destroy();
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    document.removeEventListener('keydown', onKey);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', measure);
    if (rafId) cancelAnimationFrame(rafId);
    clearInterval(tk.timer);
    for (const k of STATS) { cancelAnimationFrame(statRows[k].anim); clearTimeout(statRows[k].deltaTimer); }
    disarmGesture();
    music.setPlaying(false);
    ctrl.detach();
    if (owned) ctrl.destroy();
  };
}
