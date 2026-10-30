// 花钱·投资 panel (opened in the life's side sheet with app.openPanel('money')): where this year's income goes (a
// stacked bar with a legend that doubles as the table), net worth and debt, what the savings are held in, how new
// savings are invested (auto, or the player's own mix of bank / balanced fund / stocks / crypto) and six spending
// habits with three levels each. Reads engine.incomeBreakdown / investOptions and writes engine.setHabit /
// setAllocation (CONTRACT §10); every engine call is feature-detected, with a plain fallback on the state shape.
// Amounts are 2021 international dollars shown in local currency (economy.formatMoney), labelled as estimates.

import { h, clear, fmt, append } from '../dom.js';
import * as engineMod from '../../core/engine.js';
import * as econMod from '../../core/economy.js';

export const meta = { tab: '花钱·投资', title: '花钱·投资', eyebrow: '附页 · 收支簿' };

export const LEVEL_LABELS = ['不花', '一些', '很多'];

/** The six spending habits (CONTRACT §10 state.habits). effect[level] is the one-line effect shown in the panel. */
export const HABITS = [
  { key: 'dining', label: '聚餐·送礼', sub: '朋友聚会、人情往来、逢年过节的礼物', minAge: 16,
    effect: ['', '人际略↑', '人际↑ · 快乐略↑'] },
  { key: 'parents', label: '孝亲费', sub: '给父母的生活费，和照顾他们的花销', minAge: 18,
    effect: ['', '人际略↑ · 父母更宽裕', '人际↑ · 父母晚年更安稳'] },
  { key: 'travel', label: '旅行', sub: '出门走走，看看别处的生活', minAge: 16,
    effect: ['', '快乐略↑ · 见识略↑', '快乐↑ · 知识略↑'] },
  { key: 'learning', label: '学习投入', sub: '书、课程、补习和考证', minAge: 6,
    effect: ['', '知识略↑', '知识↑ · 升学和升职更顺'] },
  { key: 'health', label: '健康投入', sub: '体检、运动、保险和更好的饮食', minAge: 6,
    effect: ['', '健康略↑', '健康↑ · 患病风险略降'] },
  { key: 'charity', label: '捐助', sub: '捐款、志愿和帮助陌生人', minAge: 16,
    effect: ['', '快乐略↑', '快乐↑ · 人际略↑'] },
];

// share of the person's yearly income per level: used only when the engine cannot price a habit itself
const FALLBACK_SHARE = {
  dining: [0, 0.03, 0.07], parents: [0, 0.05, 0.12], travel: [0, 0.03, 0.08],
  learning: [0, 0.02, 0.06], health: [0, 0.02, 0.05], charity: [0, 0.01, 0.04],
};

/** New-savings options when the engine does not list them (labels and hints are long-run real returns). */
export const ASSETS = [
  { id: 'bank', label: '银行存款', hint: '最稳当；扣除通胀后几乎不增值' },
  { id: 'balanced', label: '平衡型基金', hint: '股票和债券搭配；长期实际年回报约 2–4%' },
  { id: 'stocks', label: '股票', hint: '长期实际年回报约 4–6%；每隔几年会遇上一次大跌' },
  { id: 'crypto', label: '加密资产', hint: '涨跌极大；可能翻几倍，也可能归零' },
];
const ASSET_IDS = ASSETS.map((a) => a.id);

export const PRESETS = [
  { id: 'safe', label: '稳妥', pct: { bank: 70, balanced: 30, stocks: 0, crypto: 0 } },
  { id: 'mid', label: '均衡', pct: { bank: 30, balanced: 50, stocks: 20, crypto: 0 } },
  { id: 'bold', label: '进取', pct: { bank: 10, balanced: 30, stocks: 60, crypto: 0 } },
];

const HOLDING_LABELS = { cash: '现金与存款', stocks: '股票', bonds: '储蓄与债券', gold: '黄金', property: '房产', crypto: '加密资产' };
const MAX_SLOTS = 7;   // categorical colour slots (--cat-1 .. --cat-7); later items fold into “其他”

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 0) => (isNum(Number(v)) && v !== null && v !== '' ? Number(v) : d);

// ---------------------------------------------------------------------------------------------------------------
// pure helpers (exported for tests)

/** Percent weights {bank, balanced, stocks, crypto} -> fractions summing to exactly 1 (two decimals). All zero -> bank. */
export function normalizeAlloc(pct) {
  const w = ASSET_IDS.map((k) => Math.max(0, num(pct && pct[k])));
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { bank: 1, balanced: 0, stocks: 0, crypto: 0 };
  const raw = w.map((x) => x / total);
  const out = raw.map((x) => Math.round(x * 100) / 100);
  const drift = Math.round((1 - out.reduce((a, b) => a + b, 0)) * 100) / 100;
  if (drift) {
    const i = out.indexOf(Math.max(...out));
    out[i] = Math.round((out[i] + drift) * 100) / 100;
  }
  return Object.fromEntries(ASSET_IDS.map((k, i) => [k, out[i]]));
}

/** A stored allocation (fractions or percents) -> integer percents for the sliders; null when it is auto. */
export function allocToPercents(alloc) {
  if (!alloc || typeof alloc !== 'object') return null;
  const vals = ASSET_IDS.map((k) => Math.max(0, num(alloc[k])));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return Object.fromEntries(ASSET_IDS.map((k, i) => [k, Math.round((vals[i] / total) * 100)]));
}

/** Current habit levels (0..2) for the six keys; missing keys read as 0. */
export function habitLevels(state) {
  const src = state && state.habits && typeof state.habits === 'object' ? state.habits : {};
  return Object.fromEntries(HABITS.map((x) => [x.key, Math.max(0, Math.min(2, Math.round(num(src[x.key]))))]));
}

/**
 * engine.incomeBreakdown -> what the bar draws: {income, total, segments:[{key,label,amount,share,slot}],
 * negative:[items with amount < 0], over: spending above income}. Slots follow the engine's item order; items past
 * the seventh fold into one “其他” segment.
 */
export function breakdownView(bd) {
  if (!bd || typeof bd !== 'object' || !Array.isArray(bd.items)) return null;
  const income = Math.max(0, num(bd.income));
  const items = bd.items
    .filter((it) => it && typeof it === 'object' && isNum(Number(it.amount)))
    .map((it) => ({ key: String(it.key ?? it.label ?? ''), label: String(it.label || it.key || '其他'), amount: Number(it.amount), share: isNum(Number(it.share)) ? Number(it.share) : null }));
  const pos = items.filter((it) => it.amount > 0);
  const negative = items.filter((it) => it.amount < 0);
  const total = pos.reduce((a, it) => a + it.amount, 0);
  const segments = [];
  let other = null;
  pos.forEach((it, i) => {
    if (i < MAX_SLOTS - (pos.length > MAX_SLOTS ? 1 : 0)) segments.push({ ...it, slot: i + 1 });
    else {
      if (!other) { other = { key: '_other', label: '其他', amount: 0, slot: 0, parts: [] }; segments.push(other); }
      other.amount += it.amount;
      other.parts.push(it.label);
    }
  });
  const base = Math.max(total, income) || 1;
  for (const s of segments) s.share = s.amount / base;
  return { income, total, segments, negative, over: income > 0 && total > income * 1.005 ? total - income : 0 };
}

function findItem(bd, key) {
  if (!bd || !Array.isArray(bd.items)) return null;
  return bd.items.find((it) => it && (it.key === key || it.key === `habit:${key}` || it.key === `habit_${key}` || it.habit === key)) || null;
}

/**
 * Yearly cost of one habit at levels 0..2 in intl $: asks engine.incomeBreakdown for the same life with only that
 * habit changed (exact), else falls back to a share of the person's income (an estimate).
 */
export function habitCosts(E, data, world, state, key) {
  if (E && typeof E.incomeBreakdown === 'function' && state) {
    const out = [0, null, null];
    for (const lv of [1, 2]) {
      try {
        const probe = { ...state, habits: { ...(state.habits || {}), [key]: lv } };
        const it = findItem(E.incomeBreakdown(data, world, probe), key);
        if (it && isNum(Number(it.amount))) out[lv] = Math.abs(Number(it.amount));
      } catch { out[lv] = null; }
    }
    if (out[1] != null && out[2] != null) return { costs: out, exact: true };
  }
  const inc = Math.max(0, num(state && state.person && state.person.money && state.person.money.income));
  return { costs: (FALLBACK_SHARE[key] || [0, 0, 0]).map((s) => s * inc), exact: false };
}

/** Engine-provided habit descriptions win over ours when it exports them (HABITS array or object). */
const EXT_HABITS = 'HABITS';   // optional export of engine.js or economy.js (looked up at run time)
function habitMeta(E, key) {
  const base = HABITS.find((x) => x.key === key);
  const ext = [E, econMod].map((ns) => ns && ns[EXT_HABITS]).find((x) => x && typeof x === 'object') || null;
  let e = null;
  if (Array.isArray(ext)) e = ext.find((x) => x && x.key === key);
  else if (ext && typeof ext === 'object') e = ext[key];
  if (!e || typeof e !== 'object') return base;
  const effect = Array.isArray(e.effects) && e.effects.length === 3 && e.effects.every((t) => typeof t === 'string')
    ? e.effects
    : typeof e.hint === 'string' && e.hint ? ['', e.hint, e.hint] : base.effect;
  return { ...base, label: typeof e.label === 'string' && e.label ? e.label : base.label, effect };
}

export function moneyText(data, iso, amount, opts) {
  try {
    if (typeof econMod.formatMoney === 'function') return econMod.formatMoney(data, iso, amount, opts);
  } catch { /* fall through */ }
  return isNum(amount) ? `${fmt.cn(amount)} 国际元` : '—';
}

function currencyName(data, iso) {
  try {
    const c = data && typeof data.currency === 'function' ? data.currency(iso) : null;
    return c && c.name ? String(c.name) : '当地货币';
  } catch { return '当地货币'; }
}

function parentsAlive(state) {
  const par = state && state.person && state.person.parents;
  if (!par || typeof par !== 'object') return true;
  return Object.values(par).some((x) => x && x.alive !== false);
}

// ---------------------------------------------------------------------------------------------------------------
// habit controls (also used by the family panel)

/**
 * Builds the segmented 不花 / 一些 / 很多 controls for the given habit keys.
 * ctx = {state, data, world, engine, idPrefix, readOnly, onSet(key, level)}. Returns an array of fieldsets.
 */
export function habitControls(ctx, keys = HABITS.map((x) => x.key)) {
  const { state, data, world, idPrefix = 'll-hb', readOnly = false, onSet } = ctx;
  const E = ctx.engine || engineMod;
  const iso = state?.person?.country || state?.birth?.country;
  const levels = habitLevels(state);
  const income = Math.max(0, num(state?.person?.money?.income));
  const age = num(state?.age);
  return keys.map((key) => {
    const m = habitMeta(E, key);
    if (!m) return null;
    const { costs, exact } = habitCosts(E, data, world, state, key);
    let why = '';
    if (age < m.minAge) why = m.minAge < 16 ? `${m.minAge} 岁起可以和家人商量这笔钱。` : `${m.minAge} 岁以后可以自己安排这笔钱。`;
    else if (key === 'parents' && !parentsAlive(state)) why = '父母都已经不在了。';
    const disabled = readOnly || !!why;
    const name = `${idPrefix}-${key}`;
    const eff = h('p.ll-habit-eff');
    const paintEff = (lv) => {
      eff.textContent = lv > 0 ? `${m.effect[lv] || ''}${m.effect[lv] ? ' · ' : ''}财富↓` : '不花这笔钱。';
      eff.classList.toggle('is-off', lv === 0);
    };
    const costText = (lv) => {
      if (lv === 0) return '0';
      const c = costs[lv];
      if (c == null) return '—';
      if (!(c > 0)) return income > 0 ? '很少' : '家里出';
      return `${exact ? '' : '约 '}${moneyText(data, iso, c)}/年`;
    };
    const opts = [0, 1, 2].map((lv) => {
      const id = `${name}-${lv}`;
      const input = h('input.ll-seg-input', {
        type: 'radio', name, id, value: String(lv), checked: lv === levels[key], disabled,
        onchange: () => {
          if (!input.checked) return;
          paintEff(lv);
          if (onSet) onSet(key, lv);
        },
      });
      return h('label.ll-seg-opt', { for: id }, input,
        h('span.ll-seg-label', LEVEL_LABELS[lv]),
        h('span.ll-seg-cost', costText(lv)));
    });
    paintEff(levels[key]);
    return h('fieldset.ll-habit', { class: disabled ? 'is-locked' : '', dataset: { habit: key } },
      h('legend.ll-habit-name', m.label),
      h('p.ll-habit-sub', m.sub),
      h('div.ll-seg', opts),
      eff,
      why ? h('p.ll-habit-why', why) : null);
  }).filter(Boolean);
}

/** Write a habit through the engine (fallback: the CONTRACT §10 state shape). */
export function applyHabit(E, state, key, level) {
  const lv = Math.max(0, Math.min(2, Math.round(num(level))));
  if (E && typeof E.setHabit === 'function') {
    try { E.setHabit(state, key, lv); return true; } catch (e) { console.error(e); }
  }
  if (!state.habits || typeof state.habits !== 'object') state.habits = {};
  state.habits[key] = lv;
  return true;
}

/** Write the savings allocation (fractions, or null = auto) through the engine (fallback: state shape). */
export function applyAllocation(E, state, alloc) {
  if (E && typeof E.setAllocation === 'function') {
    try { E.setAllocation(state, alloc); return true; } catch (e) { console.error(e); }
  }
  const m = state.person && state.person.money;
  if (m) m.allocation = alloc ? { ...alloc } : null;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// the panel

/**
 * mount(root, params, app). params: {state, world, changed(kind), switchTo(name), deps?: {engine, economy}}.
 */
export function mount(root, params = {}, app = {}) {
  const state = params.state;
  const data = app.data || params.data || {};
  const world = params.world || null;
  const E = (params.deps && params.deps.engine) || engineMod;
  const changed = typeof params.changed === 'function' ? params.changed : () => {};
  if (!state || !state.person) {
    root.append(h('div.ll-pn-empty', h('p', '还没有进行中的人生。'), h('p.ll-hint', '开始一段人生后，这里会记下一年的收入、花销和积蓄。')));
    return undefined;
  }
  const p = state.person;
  const m = p.money || {};
  const iso = p.country || state.birth?.country;
  const name = p.name || state.birth?.name || '这个人';
  const age = num(state.age);
  const dead = !!state.dead;
  const readOnly = dead || age < 16;
  const lockNote = dead ? '这一生已经结束，这里只能查看。'
    : age < 6 ? `${name}还小，家里的钱由大人安排。6 岁起，学习和健康上的投入可以和家人商量；16 岁以后，其余的花销和投资由自己决定。`
      : age < 16 ? `家里的钱还由大人安排。学习和健康上的投入可以和家人商量；16 岁以后，其余的花销和投资由${name}自己决定。` : '';

  const tilesEl = h('div.ll-mn-tiles');
  const bdEl = h('div.ll-mn-bd');
  const holdEl = h('div.ll-mn-hold');

  // ---- tiles: net worth, income, debt -----------------------------------------------------------------------
  function paintTiles() {
    const cash = num(m.cash);
    const port = m.portfolio && typeof m.portfolio === 'object' ? m.portfolio : {};
    let net = null;
    try { if (typeof econMod.netWorth === 'function') net = econMod.netWorth(m); } catch { net = null; }
    if (!isNum(net)) net = cash + Object.values(port).reduce((a, v) => a + num(v), 0) - num(m.debt);
    const tile = (k, v, sub, cls = '') => h('div.ll-mn-tile' + cls, h('span.ll-mn-tile-k', k), h('span.ll-mn-tile-v', v), sub ? h('span.ll-mn-tile-s', sub) : null);
    clear(tilesEl).append(
      tile('净资产', moneyText(data, iso, net), net < 0 ? '欠的比有的多' : '现金、存款、投资和房产，减去负债', net < 0 ? '.is-neg' : ''),
      tile('今年收入', num(m.income) > 0 ? moneyText(data, iso, num(m.income)) : '—', num(m.income) > 0 ? '税后、按年计' : age < 16 ? '还没有自己的收入' : '今年没有收入'),
      tile('负债', num(m.debt) > 0 ? moneyText(data, iso, num(m.debt)) : '没有', num(m.debt) > 0 ? '房贷、助学贷款和其他借款' : '无欠款', num(m.debt) > 0 ? '.is-debt' : ''));
  }

  // ---- where this year's income goes ------------------------------------------------------------------------
  function paintBreakdown() {
    let bd = null;
    try { bd = typeof E.incomeBreakdown === 'function' ? E.incomeBreakdown(data, world, state) : null; } catch (e) { console.error(e); bd = null; }
    const v = breakdownView(bd);
    clear(bdEl);
    if (!v) {
      bdEl.append(h('p.ll-hint', '这一年的收支明细暂时无法估算。'));
      return;
    }
    if (!v.segments.length) {
      bdEl.append(h('p.ll-mn-none', v.income > 0 ? '这一年的收入还没有安排去处。' : age < 16 ? '还没有自己的收入，吃穿用度由家里承担。' : '这一年没有收入，日常开销靠积蓄或家人支撑。'));
      return;
    }
    const pct = (s) => `${Math.round(s * 100)}%`;
    const summary = v.segments.slice().sort((a, b) => b.amount - a.amount).slice(0, 3).map((s) => `${s.label} ${pct(s.share)}`).join('，');
    const cap = h('p.ll-mn-cap', { 'aria-hidden': 'true' }, '指向色块或下面的条目查看金额');
    const segs = [];
    const rows = [];
    const hot = (key) => {
      segs.forEach((el) => el.classList.toggle('is-dim', key != null && el.dataset.key !== key));
      rows.forEach((el) => el.classList.toggle('is-hot', key != null && el.dataset.key === key));
      const s = v.segments.find((x) => x.key === key);
      cap.textContent = s ? `${s.label} · ${moneyText(data, iso, s.amount)} · ${pct(s.share)}${s.parts ? `（${s.parts.join('、')}）` : ''}` : '指向色块或下面的条目查看金额';
    };
    const color = (s) => (s.slot ? `var(--cat-${s.slot})` : 'var(--ink-3)');
    const bar = h('div.ll-mn-bar', { role: 'img', 'aria-label': `一年收入的去向：${summary}` },
      v.segments.map((s) => {
        const el = h('span.ll-mn-seg', {
          dataset: { key: s.key }, title: `${s.label} ${pct(s.share)}`,
          style: { flexGrow: String(Math.max(0.004, s.share)), background: color(s) },
          onpointerenter: () => hot(s.key), onpointerleave: () => hot(null),
        });
        segs.push(el);
        return el;
      }));
    const legend = h('ul.ll-mn-legend', v.segments.map((s) => {
      const li = h('li.ll-mn-row', { dataset: { key: s.key }, onpointerenter: () => hot(s.key), onpointerleave: () => hot(null) },
        h('span.ll-mn-sw', { 'aria-hidden': 'true', style: { background: color(s) } }),
        h('span.ll-mn-row-k', s.label, s.parts ? h('span.ll-mn-row-sub', s.parts.join('、')) : null),
        h('span.ll-mn-row-v', moneyText(data, iso, s.amount)),
        h('span.ll-mn-row-p', pct(s.share)));
      rows.push(li);
      return li;
    }));
    append(bdEl, [
      h('p.ll-mn-income', v.income > 0 ? ['收入 ', h('b', moneyText(data, iso, v.income)), ' 的去向'] : '今年的开销'),
      bar, cap, legend,
      v.over > 0 ? h('p.ll-mn-warn', `今年的花销比收入多 ${moneyText(data, iso, v.over)}，差额从积蓄里出，或者借来。`) : null,
      v.negative.length ? h('p.ll-hint', v.negative.map((it) => `${it.label} ${moneyText(data, iso, it.amount)}`).join('；')) : null]);
  }

  // ---- what the savings are held in -------------------------------------------------------------------------
  function paintHoldings() {
    const port = m.portfolio && typeof m.portfolio === 'object' ? m.portfolio : {};
    const rows = [['cash', num(m.cash)], ...Object.keys(HOLDING_LABELS).filter((k) => k !== 'cash').map((k) => [k, num(port[k])])]
      .filter(([, v]) => Math.abs(v) >= 1);
    clear(holdEl);
    if (!rows.length) { holdEl.append(h('p.ll-hint', '还没有积蓄。')); return; }
    holdEl.append(h('dl.ll-mn-dl', rows.map(([k, v]) => h('div', h('dt', HOLDING_LABELS[k] || k), h('dd', moneyText(data, iso, v))))));
  }

  // ---- how new savings are invested -------------------------------------------------------------------------
  let options = null;
  try { options = typeof E.investOptions === 'function' ? E.investOptions(data, world, state) : null; } catch { options = null; }
  const assets = Array.isArray(options) && options.length
    ? ASSETS.filter((a) => options.some((o) => o && o.id === a.id)).map((a) => {
      const o = options.find((x) => x.id === a.id);
      return { id: a.id, label: typeof o.label === 'string' && o.label ? o.label : a.label, hint: typeof o.hint === 'string' && o.hint ? o.hint : a.hint };
    })
    : ASSETS.filter((a) => a.id !== 'crypto' || num(state.year) >= 2010);
  const stored = allocToPercents(m.allocation);
  let mode = stored ? 'custom' : 'auto';
  const pctState = stored || { ...PRESETS[1].pct };
  for (const k of ASSET_IDS) if (!assets.some((a) => a.id === k)) pctState[k] = 0;
  const allocStatus = h('p.ll-mn-saved', { role: 'status', 'aria-live': 'polite' });
  const preview = h('div.ll-mn-bar.ll-mn-bar--alloc', { 'aria-hidden': 'true' });
  const outputs = {};
  const ranges = {};
  const shares = () => normalizeAlloc(pctState);
  function paintAlloc() {
    const w = shares();
    for (const a of assets) {
      if (outputs[a.id]) outputs[a.id].textContent = `${Math.round(w[a.id] * 100)}%`;
      if (ranges[a.id]) ranges[a.id].setAttribute('aria-valuetext', `${Math.round(w[a.id] * 100)}%`);
    }
    append(clear(preview), assets.filter((a) => w[a.id] > 0).map((a) => h('span.ll-mn-seg', {
      style: { flexGrow: String(w[a.id]), background: `var(--cat-${ASSET_IDS.indexOf(a.id) + 1})` },
    })));
    customBox.hidden = mode !== 'custom';
  }
  function describe(w) {
    return assets.filter((a) => w[a.id] > 0).map((a) => `${a.label} ${Math.round(w[a.id] * 100)}%`).join(' · ');
  }
  function commit() {
    if (readOnly) return;
    if (mode === 'auto') {
      applyAllocation(E, state, null);
      allocStatus.textContent = '已改为自动安排。';
    } else {
      const w = shares();
      applyAllocation(E, state, w);
      allocStatus.textContent = `已保存：${describe(w)}`;
    }
    changed('allocation');
  }
  const modeName = `ll-mn-mode-${Math.random().toString(36).slice(2, 7)}`;
  const modeOpt = (value, label, sub) => {
    const id = `${modeName}-${value}`;
    const input = h('input.ll-box-input', {
      type: 'radio', name: modeName, id, value, checked: mode === value, disabled: readOnly,
      onchange: () => { if (!input.checked) return; mode = value; paintAlloc(); commit(); },
    });
    return h('label.ll-box', { for: id }, input, h('span.ll-box-mark', { 'aria-hidden': 'true' }),
      h('span.ll-box-text', h('span.ll-box-label', label), h('span.ll-box-sub', sub)));
  };
  const modeGroup = h('fieldset.ll-boxes.ll-mn-mode',
    h('legend.ll-sr', '新存下的钱怎么放'),
    h('div.ll-boxes-grid',
      modeOpt('auto', '自动安排', '按年龄、收入和当地的情况，替你决定放在哪里'),
      modeOpt('custom', '自己决定比例', '用下面的滑块分配；以后每年新存的钱都按这个比例')));
  const presetRow = h('div.ll-mn-presets', { role: 'group', 'aria-label': '常用比例' },
    h('span.ll-mn-presets-k', '常用比例'),
    PRESETS.map((pr) => h('button.ll-btn.ll-btn--line.ll-btn--small', {
      type: 'button', disabled: readOnly,
      onclick: () => {
        for (const k of ASSET_IDS) pctState[k] = assets.some((a) => a.id === k) ? pr.pct[k] : 0;
        for (const a of assets) if (ranges[a.id]) ranges[a.id].value = String(pctState[a.id]);
        paintAlloc();
        commit();
      },
    }, pr.label)));
  const sliderRows = assets.map((a) => {
    const id = `${modeName}-r-${a.id}`;
    const range = h('input.ll-range.ll-mn-range', {
      type: 'range', id, min: 0, max: 100, step: 5, value: String(pctState[a.id] ?? 0), disabled: readOnly,
      'aria-describedby': `${id}-h`,
    });
    range.addEventListener('input', () => { pctState[a.id] = Number(range.value) || 0; paintAlloc(); });
    range.addEventListener('change', () => { pctState[a.id] = Number(range.value) || 0; paintAlloc(); commit(); });
    ranges[a.id] = range;
    outputs[a.id] = h('output.ll-mn-pct', { for: id });
    return h('div.ll-mn-asset',
      h('div.ll-mn-asset-head',
        h('span.ll-mn-sw', { 'aria-hidden': 'true', style: { background: `var(--cat-${ASSET_IDS.indexOf(a.id) + 1})` } }),
        h('label.ll-mn-asset-k', { for: id }, a.label),
        outputs[a.id]),
      range,
      h('p.ll-hint', { id: `${id}-h` }, a.hint));
  });
  const customBox = h('div.ll-mn-custom', preview, presetRow, sliderRows);

  // ---- habits ------------------------------------------------------------------------------------------------
  const habitBox = h('div.ll-mn-habits');
  function paintHabits() {
    // each habit has its own minimum age (learning and health from 6, decided with the family)
    append(clear(habitBox), habitControls({
      state, data, world, engine: E, idPrefix: 'll-mn-hb', readOnly: dead,
      onSet: (key, lv) => {
        if (dead) return;
        applyHabit(E, state, key, lv);
        paintBreakdown();
        changed('habit');
      },
    }));
  }

  const sec = (id, title, sub, ...body) => h('section.ll-pn-sec', { 'aria-labelledby': id },
    h('h3.ll-pn-h', { id }, title, sub ? h('span.ll-pn-h-sub', sub) : null), body);

  paintTiles();
  paintBreakdown();
  paintHoldings();
  paintAlloc();
  paintHabits();

  append(root, [
    lockNote ? h('p.ll-pn-lock', lockNote) : null,
    tilesEl,
    sec('ll-mn-s1', '一年收入的去向', `${state.year} 年 · 估算`, bdEl),
    sec('ll-mn-s2', '积蓄放在哪里', null, holdEl),
    sec('ll-mn-s3', '新存下的钱怎么放', '实际回报已扣除通胀',
      modeGroup, customBox, allocStatus,
      h('p.ll-hint', '投资有赚有赔。过去的回报来自真实的市场数据，2026 年以后由这条世界线推演。')),
    sec('ll-mn-s4', '花销习惯', '每年都会花',
      h('p.ll-hint', '每一项都会花掉一部分收入，也会慢慢改变这个人的生活。随时可以调整，从今年起生效。'),
      habitBox),
    h('p.ll-pn-foot', `金额按 2021 年的购买力估算，并换算成${currencyName(data, iso)}，不计物价上涨；都是按这个国家的收入水平推算的估计值，不是真实账目。`)]);
  return undefined;
}
