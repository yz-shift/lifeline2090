// "追思馆": a quieter, candle-lit presentation of the shared lives, sorted by candles or by recency.
// Uses the same live feed as the shared screen and the same detail view (variant 'memorial').

import { h, clear, storage } from '../dom.js';
import { initSocial, setDataSource, subscribeShared } from '../../social/store.js';
import { renderLifeDetail, liveBanner, emptyState, candleIcon, candleText, archiveNo, SEX_LABELS } from './lifeDetail.js';

const SORT_KEY = 'll2090.social.memorialSort';
const PAGE = 30;
const SORTS = [
  { id: 'candles', label: '烛光最多' },
  { id: 'recent', label: '最近安放' },
];

function sortLives(list, sort) {
  const out = list.slice();
  if (sort === 'candles') {
    out.sort((a, b) => (b.candles - a.candles) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  } else {
    out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  return out;
}

function plaque(life, onOpen) {
  return h('article.s-plaque',
    h('div.s-plaque-flame', candleIcon({ lit: life.candles > 0, size: 40 })),
    h('p.s-plaque-no', archiveNo(life)),
    h('h3.s-plaque-name', h('button.s-card-open', { type: 'button', onclick: () => onOpen(life) }, life.name)),
    h('p.s-plaque-years', `${life.birthYear} — ${life.deathYear}`),
    h('p.s-plaque-place', [SEX_LABELS[life.sex], life.countryName, `享年 ${life.age} 岁`].filter(Boolean).join(' · ')),
    life.epitaph ? h('p.s-plaque-epitaph', life.epitaph) : h('p.s-plaque-epitaph.is-empty', '（未留墓志铭）'),
    h('p.s-plaque-candles', candleText(life.candles)));
}

export function mount(root, params = {}, app) {
  setDataSource(app && app.data);
  initSocial();
  clear(root);

  const page = h('section.s-page.s-memorial');
  const listView = h('div.s-view');
  const detailView = h('div.s-view', { hidden: true });
  page.append(listView, detailView);
  root.appendChild(page);

  let lives = null;
  let meta = {};
  let sort = SORTS.some((x) => x.id === storage.get(SORT_KEY, '')) ? storage.get(SORT_KEY, '') : 'candles';
  let shown = PAGE;
  let detailCleanup = null;
  let returnScroll = 0;

  const banner = liveBanner();
  const totals = h('p.s-memorial-totals', { 'aria-live': 'polite' });
  const head = h('header.s-head.s-head--center',
    h('div.s-memorial-candles', { 'aria-hidden': 'true' },
      candleIcon({ lit: true, size: 30 }), candleIcon({ lit: true, size: 40 }), candleIcon({ lit: true, size: 30 })),
    h('p.s-kicker', '追思馆'),
    h('h1.s-title', { tabindex: '-1' }, '在这里，安静地读一读他们的一生'),
    h('p.s-lede', '每一段人生都被认真地走完了。为 TA 点一支蜡烛，或留下一句话。'),
    totals);

  const sortBar = h('div.s-seg', { role: 'group', 'aria-label': '排序方式' });
  const sortBtns = SORTS.map((x) => {
    const b = h('button.s-seg-btn', { type: 'button', 'aria-pressed': String(x.id === sort) }, x.label);
    b.addEventListener('click', () => {
      sort = x.id;
      storage.set(SORT_KEY, sort);
      shown = PAGE;
      for (const [i, btn] of sortBtns.entries()) btn.setAttribute('aria-pressed', String(SORTS[i].id === sort));
      render();
    });
    return b;
  });
  sortBar.append(...sortBtns);

  const grid = h('div.s-plaques');
  const more = h('button.s-btn.s-btn--ghost.s-more', { type: 'button', hidden: true }, '继续往里走');
  more.addEventListener('click', () => { shown += PAGE; render(); });
  listView.append(banner.el, head, sortBar, grid, more);

  function render() {
    clear(grid);
    if (lives === null) {
      totals.textContent = '正在点亮……';
      sortBar.hidden = true;
      for (let i = 0; i < 4; i++) grid.appendChild(h('div.s-plaque.s-plaque--ghost', { 'aria-hidden': 'true' }));
      more.hidden = true;
      return;
    }
    if (!lives.length) {
      totals.textContent = meta.error || '';
      sortBar.hidden = true;
      grid.appendChild(emptyState('追思馆还很安静',
        '当有人把走完的一生分享出来，TA 的档案会被安放在这里，等待被阅读和点亮。你也可以分享自己走完的人生。',
        [h('button.s-btn.s-btn--primary', { type: 'button', onclick: () => app.go('birth') }, '开始一段人生'),
          h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => app.go('past') }, '打开前世纪录')]));
      more.hidden = true;
      return;
    }
    sortBar.hidden = false;
    const candles = lives.reduce((sum, l) => sum + (l.candles || 0), 0);
    totals.textContent = `${lives.length} 段人生安放于此 · ${candles >= 1000 ? candles.toLocaleString('zh-CN') : candles} 支烛光` + (meta.error ? `（${meta.error}）` : '');
    const list = sortLives(lives, sort);
    for (const life of list.slice(0, shown)) grid.appendChild(plaque(life, (l) => openDetail(l, true)));
    more.hidden = list.length <= shown;
  }

  // keyboard focus follows the view swap (the clicked plaque disappears while the detail is shown)
  let openedName = '';
  function openDetail(life, focus = false) {
    returnScroll = typeof window !== 'undefined' ? window.scrollY : 0;
    openedName = (life && life.name) || '';
    if (detailCleanup) detailCleanup();
    listView.hidden = true;
    detailView.hidden = false;
    detailCleanup = renderLifeDetail(detailView, life && life.name ? { life } : { lifeId: life && life.lifeId }, app, {
      variant: 'memorial',
      backLabel: '返回追思馆',
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
