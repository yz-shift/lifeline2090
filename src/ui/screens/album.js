// 成就图鉴 — the player's card collection (kept only in this browser). Every finished life adds the cards it earned;
// locked cards stay face down with a hint. params.focus = card id opens that card's detail.

import { h, clear } from '../dom.js';
import { CATEGORIES, TIERS, TIER_ORDER } from '../../core/achievements.js';
import { readCollection, collectionView } from '../../social/collection.js';
import * as cards from '../cards.js';

const FILTERS = { all: '全部', got: '已收集', locked: '未收集' };

/** Text for how common a card is, from the simulated rate. */
export function rateText(def) {
  if (typeof def.rate !== 'number') return def.cat === 'player' ? '取决于你自己怎么玩' : def.cat === 'meta' ? '多活几次就会遇到' : '';
  if (def.rate >= 0.01) return `约 ${Math.round(def.rate * 100)}% 的人生能获得`;
  if (def.rate > 0) return '不到 1% 的人生能获得';
  return '极少有人生能获得';
}

/** Whether a locked card hides its name (the rarest ones keep a little mystery). */
const secret = (def) => def.tier === 'SR' || def.tier === 'SSR';

/** One small card tile; `got` decides face up or face down. */
export function cardTile(def, { onOpen, fresh = false } = {}) {
  const got = !!def.got;
  const hidden = !got && secret(def);
  return h('button.ac-card', {
    type: 'button',
    class: [`ac-t-${def.tier}`, got ? 'ac-got' : 'ac-locked', fresh ? 'ac-fresh' : ''].filter(Boolean).join(' '),
    'aria-label': `${hidden ? '未解锁的卡片' : def.title}，${TIERS[def.tier]}${got ? '，已收集' : '，未收集'}`,
    onclick: onOpen ? () => onOpen(def) : null,
  },
  h('span.ac-tier', def.tier),
  fresh ? h('span.ac-new', 'NEW') : null,
  h('span.ac-icon', { 'aria-hidden': 'true' }, got ? def.icon : '？'),
  h('span.ac-name', hidden ? '？？？' : def.title),
  got && def.got.n > 1 ? h('span.ac-count', `×${def.got.n}`) : null);
}

export function mount(root, params = {}, app) {
  let filter = 'all';
  let cat = 'all';
  let col = readCollection();
  let view = collectionView(col);
  const total = view.length;
  const have = () => view.filter((d) => d.got).length;
  const index = new Map(view.map((d, i) => [d.id, i]));

  const bar = h('div.ac-progress-bar', h('span.ac-progress-fill'));
  const progressText = h('p.ac-progress-t');
  const tierRow = h('ul.ac-tiers');
  const chips = h('div.ac-chips', { role: 'group', 'aria-label': '按类别筛选' });
  const filters = h('div.ac-filters', { role: 'group', 'aria-label': '按收集情况筛选' });
  const grid = h('div.ac-grid');
  const dialog = h('div.ac-dialog', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': '卡片详情' });

  root.append(h('section.ac-page',
    h('header.ac-hd',
      h('p.ac-eyebrow', '成就图鉴 · 只保存在这台设备上'),
      h('h1.ac-title', '人生卡片收藏'),
      h('p.ac-lede', '每走完一段人生，它经历过的事都会变成卡片收进这里。有的卡片大多数人生都能拿到，有的几百段人生里才出现一次。'),
      h('div.ac-progress', progressText, bar, tierRow)),
    filters, chips, grid,
    h('p.ac-foot', '卡片会跟着「前世纪录」里的导出备份一起保存，换设备时导入备份就能带走。稀有度来自几千段模拟人生的实际统计。')));
  // the dialog lives on <body>: a transformed screen container would turn position:fixed into position:absolute
  document.body.append(dialog);

  function paintHead() {
    const n = have();
    progressText.textContent = `已收集 ${n} / ${total}`;
    bar.firstChild.style.width = `${Math.round((n / total) * 100)}%`;
    clear(tierRow);
    for (const t of TIER_ORDER) {
      const all = view.filter((d) => d.tier === t);
      tierRow.append(h('li', { class: `ac-t-${t}` }, h('b', TIERS[t]), ` ${all.filter((d) => d.got).length}/${all.length}`));
    }
  }

  function paintControls() {
    clear(filters);
    for (const [k, label] of Object.entries(FILTERS)) {
      filters.append(h('button.ac-filter', { type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; paintControls(); paintGrid(); } }, label));
    }
    clear(chips);
    for (const [k, label] of [['all', '全部类别'], ...Object.entries(CATEGORIES)]) {
      const list = k === 'all' ? view : view.filter((d) => d.cat === k);
      chips.append(h('button.ac-chip', { type: 'button', 'aria-pressed': String(cat === k), onclick: () => { cat = k; paintControls(); paintGrid(); } },
        label, h('span.ac-chip-n', `${list.filter((d) => d.got).length}/${list.length}`)));
    }
  }

  function paintGrid() {
    clear(grid);
    let list = view.filter((d) => (cat === 'all' || d.cat === cat) && (filter === 'all' || (filter === 'got' ? d.got : !d.got)));
    if (!list.length) {
      grid.append(h('p.ac-empty', have() ? '这里还没有卡片。' : '还没有收集到卡片。走完一段人生，就能收到第一张。',
        have() ? null : h('button.g-btn.g-btn--primary', { type: 'button', onclick: () => app.go('birth') }, '开始一段人生')));
      return;
    }
    const groups = cat === 'all' ? Object.keys(CATEGORIES) : [cat];
    for (const g of groups) {
      const part = list.filter((d) => d.cat === g);
      if (!part.length) continue;
      grid.append(h('section.ac-group', { 'aria-label': CATEGORIES[g] },
        h('h2.ac-group-t', CATEGORIES[g], h('span.ac-group-n', `${part.filter((d) => d.got).length}/${part.length}`)),
        h('div.ac-tiles', part.map((d) => cardTile(d, { onOpen: openCard })))));
    }
  }

  let lastFocus = null;
  function closeCard() {
    dialog.hidden = true;
    clear(dialog);
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }

  function openCard(def) {
    lastFocus = document.activeElement;
    const got = def.got;
    const hidden = !got && secret(def);
    const life = got && got.life;
    const lifeLine = life && life.name
      ? `第一次由「${life.name}」获得${typeof life.by === 'number' ? `，${life.by} 年生` : ''}${life.country ? `，${(app.data.country(life.country) || {}).name || life.country}` : ''}${typeof life.age === 'number' ? `，享年 ${life.age} 岁` : ''}。`
      : '';
    const dl = got ? h('button.g-btn.g-btn--primary', { type: 'button', onclick: () => download(def, dl) }, '下载这张卡片') : null;
    clear(dialog);
    dialog.append(h('div.ac-dialog-box',
      h('div.ac-big', { class: `ac-t-${def.tier} ${got ? 'ac-got' : 'ac-locked'}` },
        h('span.ac-big-tier', `${TIERS[def.tier]} · ${def.tier}`),
        h('span.ac-big-icon', { 'aria-hidden': 'true' }, got ? def.icon : '？'),
        h('h2.ac-big-t', hidden ? '？？？' : def.title),
        h('p.ac-big-d', got || !def.hint ? def.desc : def.hint),
        h('p.ac-big-r', rateText(def))),
      h('div.ac-dialog-meta',
        h('p', CATEGORIES[def.cat]),
        got ? h('p', lifeLine) : h('p.ac-muted', '还没有收集到这张卡片。'),
        got ? h('p.ac-muted', `收集于 ${String(got.at || '').slice(0, 10)}${got.n > 1 ? ` · 一共获得过 ${got.n} 次` : ''}`) : null),
      h('div.g-row.ac-dialog-actions', dl, h('button.g-btn', { type: 'button', onclick: closeCard }, '关闭'))));
    dialog.hidden = false;
    const btn = dialog.querySelector('button');
    if (btn) btn.focus();
  }

  async function download(def, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '正在生成…';
    try {
      const url = /^https?:$/.test(location.protocol) && !/claude\.ai$|claudeusercontent/.test(location.hostname) ? location.host + location.pathname.replace(/index\.html$/, '') : '';
      const blob = await cards.achievementCard(def, def.got, { have: have(), total, index: index.get(def.id), category: CATEGORIES[def.cat], url, data: app.data });
      const res = await cards.saveBlob(blob, `人生长河-成就卡片-${def.title}.png`);
      if (res && res.ok === false) { if (res.status !== 'declined') app.toast?.(res.message || '没能保存这张卡片。', 'warn'); }
      else app.toast?.('卡片已保存', 'good');
    } catch (e) {
      console.error('[album] card', e);
      app.toast?.('生成卡片时出了点问题，请稍后再试。', 'bad');
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
    }
  }

  const onKey = (e) => { if (e.key === 'Escape' && !dialog.hidden) closeCard(); };
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeCard(); });
  document.addEventListener('keydown', onKey);

  paintHead();
  paintControls();
  paintGrid();
  if (params.focus) {
    const d = view.find((x) => x.id === params.focus);
    if (d) openCard(d);
  }
  // another tab may have finished a life meanwhile
  const onStorage = () => { col = readCollection(); view = collectionView(col); paintHead(); paintControls(); paintGrid(); };
  window.addEventListener('storage', onStorage);
  return () => {
    document.removeEventListener('keydown', onKey);
    dialog.remove();
    window.removeEventListener('storage', onStorage);
  };
}
