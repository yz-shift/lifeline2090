// "大家分享的人生": newest-first feed of shared lives with region / country / birth-era filters.
// Opening a card shows the shared detail view in place (lifeDetail.js); params.lifeId opens one directly.

import { h, clear, storage } from '../dom.js';
import { REGIONS } from '../../core/constants.js';
import { initSocial, setDataSource, subscribeShared, filterLives, ERAS } from '../../social/store.js';
import { lifeCard, renderLifeDetail, liveBanner, emptyState } from './lifeDetail.js';

const FILTER_KEY = 'll2090.social.filters';
const PAGE = 24;

function loadFilters() {
  const f = storage.get(FILTER_KEY, null);
  const out = { region: '', country: '', era: '' };
  if (f && typeof f === 'object') {
    if (typeof f.region === 'string' && REGIONS[f.region]) out.region = f.region;
    if (typeof f.country === 'string' && /^[A-Z]{3}$/.test(f.country)) out.country = f.country;
    if (typeof f.era === 'string' && ERAS.some((e) => e.id === f.era)) out.era = f.era;
  }
  return out;
}

function countBy(list, key) {
  const m = new Map();
  for (const x of list) m.set(x[key], (m.get(x[key]) || 0) + 1);
  return m;
}

export function mount(root, params = {}, app) {
  setDataSource(app && app.data);
  initSocial();
  clear(root);

  const page = h('section.s-page.s-shared');
  const listView = h('div.s-view');
  const detailView = h('div.s-view', { hidden: true });
  page.append(listView, detailView);
  root.appendChild(page);

  let lives = null;
  let meta = { loading: true };
  let filters = loadFilters();
  let shown = PAGE;
  let detailCleanup = null;
  let returnScroll = 0;

  // ---- header and filters
  const banner = liveBanner();
  const head = h('header.s-head',
    h('p.s-kicker', '公共档案室'),
    h('h1.s-title', { tabindex: '-1' }, '大家分享的人生'),
    h('p.s-lede', '每一份档案，都是一位访客在这里走完的一生。点开可以读 TA 的生平、点一支蜡烛，或留下一句话。'),
    h('div.s-head-actions',
      h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => app.go('memorial') }, '去追思馆'),
      h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => app.go('past') }, '我的前世纪录')));

  const regionSel = h('select.s-select', { 'aria-label': '按地区筛选' });
  const countrySel = h('select.s-select', { 'aria-label': '按国家或地区筛选' });
  const eraSel = h('select.s-select', { 'aria-label': '按出生年代筛选' });
  const resetBtn = h('button.s-btn.s-btn--ghost.s-btn--sm', { type: 'button' }, '清除筛选');
  const filterBar = h('form.s-filters', { role: 'search', onsubmit: (e) => e.preventDefault() },
    h('label.s-field', h('span.s-field-label', '地区'), regionSel),
    h('label.s-field', h('span.s-field-label', '国家/地区'), countrySel),
    h('label.s-field', h('span.s-field-label', '出生年代'), eraSel),
    resetBtn);
  const summary = h('p.s-count', { 'aria-live': 'polite' });
  const grid = h('div.s-grid');
  const more = h('button.s-btn.s-more', { type: 'button', hidden: true }, '显示更多');
  listView.append(banner.el, head, filterBar, summary, grid, more);

  const setFilters = (patch) => {
    filters = { ...filters, ...patch };
    storage.set(FILTER_KEY, filters);
    shown = PAGE;
    render();
  };
  regionSel.addEventListener('change', () => setFilters({ region: regionSel.value, country: '' }));
  countrySel.addEventListener('change', () => setFilters({ country: countrySel.value }));
  eraSel.addEventListener('change', () => setFilters({ era: eraSel.value }));
  resetBtn.addEventListener('click', () => setFilters({ region: '', country: '', era: '' }));
  more.addEventListener('click', () => { shown += PAGE; render(); });

  function fillSelect(sel, options, value) {
    clear(sel);
    for (const o of options) sel.appendChild(h('option', { value: o.value, selected: o.value === value }, o.label));
    sel.value = value;
  }

  function renderFilters(all) {
    const regionCounts = countBy(all, 'region');
    fillSelect(regionSel, [{ value: '', label: `全部地区（${all.length}）` },
      ...Object.entries(REGIONS)
        .filter(([id]) => regionCounts.get(id) || id === filters.region)
        .map(([id, label]) => ({ value: id, label: `${label}（${regionCounts.get(id) || 0}）` }))], filters.region);

    const pool = filters.region ? all.filter((l) => l.region === filters.region) : all;
    const names = new Map();
    for (const l of pool) if (!names.has(l.country)) names.set(l.country, l.countryName);
    const cc = countBy(pool, 'country');
    const countries = Array.from(names.entries())
      .filter(([iso]) => iso)
      .sort((a, b) => (cc.get(b[0]) - cc.get(a[0])) || a[1].localeCompare(b[1], 'zh-CN'))
      .map(([iso, name]) => ({ value: iso, label: `${name}（${cc.get(iso)}）` }));
    if (filters.country && !names.has(filters.country)) {
      const name = (app && app.data && typeof app.data.country === 'function' && app.data.country(filters.country)?.name) || filters.country;
      countries.unshift({ value: filters.country, label: `${name}（0）` });
    }
    fillSelect(countrySel, [{ value: '', label: '全部国家/地区' }, ...countries], filters.country);

    const eraPool = filterLives(all, { region: filters.region, country: filters.country });
    fillSelect(eraSel, [{ value: '', label: '全部出生年代' },
      ...ERAS.map((e) => ({ value: e.id, label: `${e.label}（${filterLives(eraPool, { era: e.id }).length}）` }))], filters.era);

    resetBtn.hidden = !(filters.region || filters.country || filters.era);
  }

  function skeleton() {
    clear(grid);
    for (let i = 0; i < 6; i++) grid.appendChild(h('div.s-card.s-card--ghost', { 'aria-hidden': 'true' }));
  }

  function render() {
    if (lives === null) {
      summary.textContent = '正在调阅档案……';
      filterBar.hidden = true;
      skeleton();
      more.hidden = true;
      return;
    }
    clear(grid);
    if (!lives.length) {
      filterBar.hidden = true;
      summary.textContent = meta.error || '';
      grid.appendChild(emptyState('这里还没有分享的人生',
        '走完一段人生后，可以在人生终点的页面或「前世纪录」里把它分享出来。它会作为一份档案出现在这里，供其他访客阅读、点蜡烛和留言。',
        [h('button.s-btn.s-btn--primary', { type: 'button', onclick: () => app.go('birth') }, '开始一段人生'),
          h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => app.go('past') }, '从前世纪录中分享')]));
      more.hidden = true;
      return;
    }
    filterBar.hidden = false;
    renderFilters(lives);
    const list = filterLives(lives, filters);
    const any = filters.region || filters.country || filters.era;
    summary.textContent = (any ? `筛选出 ${list.length} 段人生，共 ${lives.length} 段` : `共 ${lives.length} 段人生，最新分享在前`)
      + (meta.error ? `。${meta.error}` : '');
    if (!list.length) {
      grid.appendChild(emptyState('没有符合筛选条件的人生', '换一个地区或出生年代看看，或者清除筛选查看全部。',
        [h('button.s-btn', { type: 'button', onclick: () => setFilters({ region: '', country: '', era: '' }) }, '清除筛选')]));
      more.hidden = true;
      return;
    }
    for (const life of list.slice(0, shown)) grid.appendChild(lifeCard(life, { onOpen: (l) => openDetail(l, true) }));
    more.hidden = list.length <= shown;
    if (!more.hidden) more.textContent = `显示更多（还有 ${list.length - shown} 段）`;
  }

  // ---- detail in place
  // keyboard focus follows the view swap (the clicked card disappears while the detail is shown)
  let openedName = '';
  function openDetail(life, focus = false) {
    returnScroll = typeof window !== 'undefined' ? window.scrollY : 0;
    openedName = (life && life.name) || '';
    if (detailCleanup) detailCleanup();
    listView.hidden = true;
    detailView.hidden = false;
    detailCleanup = renderLifeDetail(detailView, life && life.name ? { life } : { lifeId: life && life.lifeId }, app, {
      variant: 'shared',
      backLabel: '返回列表',
      onBack: closeDetail,
      onRemoved: closeDetail,
    });
    try { window.scrollTo(0, 0); } catch { /* ignore */ }
    if (focus) { try { detailView.querySelector('.s-back')?.focus({ preventScroll: true }); } catch { /* ignore */ } }
  }

  function closeDetail() {
    if (detailCleanup) { detailCleanup(); detailCleanup = null; }
    clear(detailView);
    detailView.hidden = true;
    listView.hidden = false;
    render();
    try { window.scrollTo(0, returnScroll); } catch { /* ignore */ }
    const back = Array.from(grid.querySelectorAll('.s-card-open')).find((b) => openedName && b.textContent === openedName);
    try { (back || head.querySelector('.s-title'))?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  render();
  const unsub = subscribeShared((list, m) => {
    lives = list;
    meta = m || {};
    if (!listView.hidden) render();
  });
  const deepLink = params && (params.lifeId || params.id);
  if (deepLink) openDetail({ lifeId: String(deepLink) });

  return () => {
    unsub();
    banner.dispose();
    if (detailCleanup) detailCleanup();
  };
}
