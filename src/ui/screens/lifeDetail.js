// Shared-life detail view (used by the shared feed and the memorial) plus the small UI pieces the social screens share:
// archive numbers, the compact life strip, the candle mark, stat bars, banners, empty states and an in-page confirm.
// Every value shown here comes from store.js (already sanitized) and is inserted with textContent via h().

import { photoUrl } from '../../social/seed.js';
import { h, s, clear, reducedMotion } from '../dom.js';
import { YEAR_TAGS, YEAR_TAG_LABELS, STATS, STAT_LABELS, HISTORY_END } from '../../core/constants.js';
import { hashString } from '../../core/rng.js';
import {
  initSocial, setDataSource, socialStatus, onSocialStatus, getShared, lightCandle, subscribeCandles,
  subscribeMessages, addMessage, deleteMessage, deleteShared, decodeLifemap, SHARE_LIMITS,
} from '../../social/store.js';

export const SEX_LABELS = { male: '男', female: '女' };
export const ANON = '一位访客';

// ---------------------------------------------------------------------------------------------------------------
// small formatting helpers

/** Archival number shown on cards and certificates: 2003-IND-7F3A */
export function archiveNo(life) {
  const key = String(life.lifeId || life.id || '');
  const tail = hashString(key).toString(16).toUpperCase().padStart(8, '0').slice(0, 4);
  return `${life.birthYear || '????'}-${life.country || 'XXX'}-${tail}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "刚刚", "5 分钟前", "3 天前", or a date. */
export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = Math.max(0, (now - t) / 1000);
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`;
  return absDate(iso);
}

export function absDate(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const dt = new Date(t);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

export function candleText(n) {
  if (n === '1000+' || n >= 1000) return '1000+ 支烛光';
  if (!n) return '尚无烛光';
  return `${n} 支烛光`;
}

export function lifeMeta(life) {
  return [
    SEX_LABELS[life.sex],
    life.countryName,
    `${life.birthYear}—${life.deathYear}`,
    `享年 ${life.age} 岁`,
  ].filter(Boolean).join(' · ');
}

function toast(app, text, kind) {
  try { if (app && typeof app.toast === 'function') app.toast(text, kind); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------------------------
// confirm (app.confirm when the shell provides it, otherwise an in-page dialog)

/** ask(app, {title, body, ok, cancel, danger}) -> Promise<boolean> */
export function ask(app, opts) {
  if (app && typeof app.confirm === 'function') {
    try {
      return Promise.resolve(app.confirm(opts)).then((v) => v === true).catch(() => false);
    } catch {
      /* fall through to the built-in dialog */
    }
  }
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      layer.remove();
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } };
    const okBtn = h('button.s-btn' + (opts.danger ? '.s-btn--danger' : '.s-btn--primary'), { type: 'button', onclick: () => done(true) }, opts.ok || '确定');
    const layer = h('div.s-dialog-layer', { onclick: (e) => { if (e.target === layer) done(false); } },
      h('div.s-dialog', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 's-dialog-title' },
        h('h2.s-dialog-title#s-dialog-title', opts.title || '确认'),
        opts.body ? h('p.s-dialog-body', opts.body) : null,
        h('div.s-dialog-actions',
          h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => done(false) }, opts.cancel || '取消'),
          okBtn)));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(layer);
    okBtn.focus();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// visual pieces

function tagClass(tag) { return tag && YEAR_TAGS.includes(tag) ? '.s-tag-' + tag : '.s-tag-none'; }

/**
 * Compact life strip. `tags` is an array of YEAR_TAGS ids (decodeLifemap or history.map(r => r.tag)).
 * variant 'mini': one thin bar, one slice per year. variant 'full': a strict decade grid with a legend.
 * Years after HISTORY_END are drawn as projection (dashed, cool hue).
 */
export function lifeStrip(tags, birthYear, { variant = 'mini' } = {}) {
  const n = tags.length;
  const endYear = birthYear + Math.max(0, n - 1);
  const label = n ? `人生图谱：${birthYear}–${endYear} 年，共 ${n} 年` : '人生图谱：无记录';
  if (variant === 'mini') {
    const el = h('div.s-strip', { role: 'img', 'aria-label': label });
    tags.forEach((t, i) => el.appendChild(h('span.s-cell' + tagClass(t) + (birthYear + i > HISTORY_END ? '.is-proj' : ''))));
    return el;
  }
  const grid = h('div.s-map', { role: 'img', 'aria-label': label });
  const start = Math.floor(birthYear / 10) * 10;
  for (let d = start; d <= endYear; d += 10) {
    const cells = h('div.s-map-cells');
    for (let y = d; y < d + 10; y++) {
      const i = y - birthYear;
      if (i < 0 || i >= n) { cells.appendChild(h('span.s-cell.is-void')); continue; }
      const t = tags[i];
      const proj = y > HISTORY_END;
      cells.appendChild(h('span.s-cell' + tagClass(t) + (proj ? '.is-proj' : ''), {
        title: `${y} 年 · ${i} 岁 · ${YEAR_TAG_LABELS[t] || '未记录'}${proj ? ' · 推演年份' : ''}`,
      }));
    }
    grid.appendChild(h('div.s-map-row', h('span.s-map-yr', String(d)), cells));
  }
  const present = YEAR_TAGS.filter((t) => tags.includes(t));
  const legend = h('ul.s-legend',
    present.map((t) => h('li', h('span.s-cell' + tagClass(t)), YEAR_TAG_LABELS[t])),
    h('li.s-legend-note', h('span.s-cell.s-tag-calm'), '实色：真实历史年份'),
    endYear > HISTORY_END ? h('li.s-legend-note', h('span.s-cell.s-tag-calm.is-proj'), '虚线：推演年份（2027 年起）') : null);
  return h('div.s-mapwrap', grid, legend);
}

/** Candle mark (SVG). `lit` shows the flame; size is the height in px. */
export function candleIcon({ lit = false, size = 20 } = {}) {
  return s('svg', {
    class: 's-candle' + (lit ? ' is-lit' : ''), viewBox: '0 0 24 40', width: Math.round(size * 0.6), height: size,
    'aria-hidden': 'true', focusable: 'false',
  },
  s('ellipse', { class: 's-candle-glow', cx: 12, cy: 10, rx: 11, ry: 11 }),
  s('path', { class: 's-candle-flame', d: 'M12 2.5 C15.2 7.2 16.2 10.4 12 15.2 C7.8 10.4 8.8 7.2 12 2.5 Z' }),
  s('rect', { class: 's-candle-wick', x: 11.4, y: 14.6, width: 1.2, height: 2.6, rx: 0.4 }),
  s('rect', { class: 's-candle-body', x: 7.5, y: 17, width: 9, height: 21, rx: 1.6 }));
}

/** Final stats as labelled bars. */
export function statBars(stats) {
  return h('dl.s-stats', STATS.map((k) => h('div.s-stat',
    h('dt', STAT_LABELS[k]),
    h('dd',
      h('span.s-bar', h('span.s-bar-fill.s-st-' + k, { style: { width: `${Math.max(0, Math.min(100, stats[k] ?? 0))}%` } })),
      h('span.s-bar-num', String(Math.round(stats[k] ?? 0)))))));
}

/** Empty state: what will appear here and how. */
export function emptyState(title, body, actions = []) {
  return h('div.s-empty',
    h('div.s-empty-mark', { 'aria-hidden': 'true' }, candleIcon({ lit: false, size: 34 })),
    h('p.s-empty-title', title),
    body ? h('p.s-empty-body', body) : null,
    actions.length ? h('div.s-empty-actions', actions) : null);
}

/** Banner describing local mode / read-only / degraded; re-renders on status changes. */
export function liveBanner({ context = 'shared' } = {}) {
  const el = h('div.s-banner-slot', { 'aria-live': 'polite' });
  const paint = (st = socialStatus()) => {
    clear(el);
    if (!st.ready) return;
    if (st.mode === 'local') {
      el.appendChild(h('div.s-banner',
        h('strong', '本地模式'),
        h('span', context === 'past'
          ? '前世纪录始终只保存在这台设备的浏览器里。'
          : '这是单机版：你自己分享的人生、点的蜡烛和留言只保存在这台设备的浏览器里，别人看不到。下面的真实人生是本站整理的公开资料。')));
    } else if (st.degraded) {
      el.appendChild(h('div.s-banner.s-banner--warn', h('strong', '共享暂不可用'), h('span', '页面显示的是最近加载的内容。')));
    } else if (st.readOnly && context !== 'past') {
      el.appendChild(h('div.s-banner', h('strong', '只读'), h('span', '你可以浏览和阅读，但当前权限不能点蜡烛、留言或分享。')));
    }
  };
  paint();
  initSocial().then(() => paint());
  const off = onSocialStatus(paint);
  return { el, dispose: off };
}

/** Archive-style card for the feed. */
export function lifeCard(life, { onOpen } = {}) {
  const tags = decodeLifemap(life.lifemap);
  return h('article.s-card',
    h('div.s-card-top',
      h('span.s-card-no', '档案 ' + archiveNo(life)),
      life.real ? h('span.s-badge.s-badge--real', life.ordinary ? '真实人生 · 普通人' : '真实人生') : life.seed ? h('span.s-badge', '示例人生 · 模拟生成') : null,
      life.mode === 'custom' ? h('span.s-badge', '自定义出生') : null),
    h('h3.s-card-name', h('button.s-card-open', { type: 'button', onclick: () => onOpen && onOpen(life) }, life.name)),
    h('p.s-card-meta', lifeMeta(life)),
    life.cause ? h('p.s-card-cause', '死因：' + life.cause) : null,
    life.epitaph ? h('p.s-card-epitaph', life.epitaph) : null,
    life.real && life.photo ? h('img.s-card-photo', { src: photoUrl(life.photo), alt: life.name, loading: 'lazy', decoding: 'async' }) : null,
    !life.real && tags.length ? lifeStrip(tags, life.birthYear) : null,
    h('div.s-card-foot',
      h('span.s-candles', candleIcon({ lit: life.candles > 0, size: 18 }), h('span', candleText(life.candles))),
      h('time.s-card-time', { datetime: life.createdAt || null }, relTime(life.createdAt))));
}

// ---------------------------------------------------------------------------------------------------------------
// detail view

/**
 * Render one shared life into `root`. input: { life } (already sanitized) or { lifeId }.
 * opts: { variant: 'shared'|'memorial', onBack, backLabel, onRemoved }. Returns a cleanup function.
 */
export function renderLifeDetail(root, input, app, opts = {}) {
  const variant = opts.variant === 'memorial' ? 'memorial' : 'shared';
  const cleanups = [];
  let destroyed = false;
  const goBack = () => { if (typeof opts.onBack === 'function') opts.onBack(); else if (app && app.back) app.back(); };

  clear(root);
  const banner = liveBanner();
  cleanups.push(banner.dispose);
  const wrap = h('article.s-detail' + (variant === 'memorial' ? '.is-memorial' : ''));
  const body = h('div.s-detail-body', h('p.s-loading', '正在调阅档案……'));
  wrap.append(
    h('div.s-detail-top', h('button.s-back', { type: 'button', onclick: goBack }, '← ' + (opts.backLabel || '返回'))),
    banner.el,
    body);
  root.appendChild(wrap);

  const lifeId = (input && input.life && input.life.lifeId) || (input && input.lifeId) || '';
  const show = (life) => {
    if (destroyed) return;
    clear(body);
    if (!life) {
      body.appendChild(emptyState('这段人生已不在分享列表中', '它可能已被分享者撤回，或被页面所有者移除。',
        [h('button.s-btn', { type: 'button', onclick: goBack }, opts.backLabel || '返回')]));
      return;
    }
    build(life);
  };

  function build(life) {
    const tags = decodeLifemap(life.lifemap);
    const projected = life.deathYear > HISTORY_END;

    // header
    body.appendChild(h('header.s-detail-head',
      h('p.s-kicker', `${variant === 'memorial' ? '追思馆' : '人生档案'} · 档案号 ${archiveNo(life)}`),
      h('h2.s-detail-name', life.name),
      h('p.s-detail-meta', lifeMeta(life)),
      life.cause ? h('p.s-detail-cause', '死因：' + life.cause) : null,
      h('div.s-badges',
        life.real ? h('span.s-badge.s-badge--real', life.ordinary ? '真实人生 · 普通人' : '真实人生') : null,
        life.real ? null : life.mode === 'custom' ? h('span.s-badge', '自定义出生') : h('span.s-badge', '随机出生'),
        !life.real && life.birthYear <= HISTORY_END ? h('span.s-badge.s-badge--real', '经历真实历史') : null,
        projected ? h('span.s-badge.s-badge--proj', '含推演年份') : null,
        life.worldLabel ? h('span.s-badge.s-badge--proj', '世界线：' + life.worldLabel) : null)));

    if (life.real && life.photo) {
      const c = life.photoCredit || {};
      body.appendChild(h('figure.s-real-photo',
        h('img', { src: photoUrl(life.photo), alt: life.name, decoding: 'async' }),
        h('figcaption', c.note ? c.note + ' ' : '', '照片：', c.author || '佚名', c.license ? ` · ${c.license}` : '',
          c.url ? [' · ', h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'Wikimedia Commons')] : null)));
    }
    if (life.epitaph) body.appendChild(h('blockquote.s-epitaph', h('p', life.epitaph)));

    // life map
    if (tags.length) {
      body.appendChild(h('section.s-section',
        h('h3.s-section-title', '人生图谱'),
        h('p.s-section-note', '一格是一年，颜色表示那一年的主题。'),
        lifeStrip(tags, life.birthYear, { variant: 'full' })));
    }

    // two columns: story | candle + stats
    const story = h('div.s-col');
    if (life.bio) {
      story.appendChild(h('section.s-section',
        h('h3.s-section-title', '生平'),
        h('div.s-bio', life.bio.split('\n').filter(Boolean).map((p) => h('p', p)))));
    }
    if (life.highlights.length) {
      story.appendChild(h('section.s-section',
        h('h3.s-section-title', '人生节点'),
        h('ul.s-highlights', life.highlights.map((x) => h('li', x)))));
    }
    if (!life.bio && !life.highlights.length) {
      story.appendChild(h('section.s-section', h('h3.s-section-title', '生平'), h('p.s-muted', '分享者没有留下传记。人生图谱记录了 TA 走过的每一年。')));
    }
    const side = h('div.s-col.s-col--side', candleBox(life),
      life.real
        ? (life.sources.length ? h('section.s-section', h('h3.s-section-title', '资料来源'),
          h('ul.s-sources', life.sources.map((x) => h('li', h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.name)))),
          h('p.s-muted', '生平依据公开资料整理，文字为本站重新撰写。')) : null)
        : h('section.s-section', h('h3.s-section-title', '离世时的状态'), statBars(life.stats)));
    body.appendChild(h('div.s-detail-grid', story, side));

    body.appendChild(messagesSection(life));
    if (life.real) body.appendChild(h('p.s-fiction', '这是一个真实的人走过的一生。资料来自公开记录，如有错误欢迎通过反馈告诉我们。'));
    else body.appendChild(h('p.s-fiction', '这是一段在《人生长河》中模拟出的人生。2026 年以前的世界大事来自真实记录，个人经历为虚构；2027 年以后的世界是基于当下趋势的推演，并非预言。'));
    const mod = moderation(life);
    if (mod) body.appendChild(mod);
  }

  function candleBox(life) {
    const icon = candleIcon({ lit: false, size: 72 });
    const count = h('strong.s-candlebox-count', candleText(life.candles));
    const btn = h('button.s-btn.s-btn--candle', { type: 'button' }, '点一支蜡烛');
    const note = h('p.s-candlebox-note');
    const st = { count: life.candles, mine: false, pending: false, known: false };
    const paint = () => {
      const status = socialStatus();
      icon.classList.toggle('is-lit', st.mine || st.count > 0);
      count.textContent = candleText(st.count);
      btn.disabled = st.mine || st.pending || !status.canWrite;
      btn.textContent = st.mine ? '你已点亮一支蜡烛' : st.pending ? '正在点亮……' : '点一支蜡烛';
      note.textContent = !status.canWrite && !st.mine
        ? '当前权限只能浏览，不能点蜡烛。'
        : status.mode === 'local' ? '本地模式下，蜡烛只记录在这台设备上。' : '每位访客可为一段人生点一支蜡烛。';
    };
    const animate = () => {
      if (reducedMotion()) return;
      icon.classList.remove('is-lighting');
      // restart the animation
      void icon.getBoundingClientRect();
      icon.classList.add('is-lighting');
      icon.addEventListener('animationend', () => icon.classList.remove('is-lighting'), { once: true });
    };
    btn.addEventListener('click', async () => {
      if (st.mine || st.pending) return;
      st.pending = true;
      st.mine = true;
      st.count = (typeof st.count === 'number' ? st.count : 0) + 1;
      paint();
      animate();
      const r = await lightCandle(life.lifeId);
      st.pending = false;
      if (!r.ok) {
        st.mine = false;
        st.count = Math.max(0, st.count - 1);
        toast(app, r.message, 'bad');
      } else if (typeof r.count === 'number') {
        st.count = Math.max(r.count, 1);
      }
      if (!destroyed) paint();
    });
    const unsub = subscribeCandles(life.lifeId, ({ count: c, mine }) => {
      if (st.pending) return;
      st.count = c;
      st.mine = mine;
      st.known = true;
      paint();
    });
    cleanups.push(unsub, onSocialStatus(paint));
    paint();
    return h('section.s-candlebox', { 'aria-label': '烛光' }, h('div.s-candlebox-icon', icon), count, btn, note);
  }

  function messagesSection(life) {
    const list = h('ol.s-msgs', { 'aria-live': 'polite' }, h('li.s-msg-empty', '正在读取留言……'));
    const area = h('textarea.s-textarea', {
      rows: 3, maxlength: SHARE_LIMITS.message, placeholder: `写给 ${life.name} 的一句话（最多 ${SHARE_LIMITS.message} 字）`,
      'aria-label': '留言内容',
    });
    const counter = h('span.s-counter', `0 / ${SHARE_LIMITS.message}`);
    const send = h('button.s-btn.s-btn--primary', { type: 'submit' }, '留下这句话');
    const hint = h('p.s-composer-hint');
    let sending = false;
    const paintComposer = () => {
      const stt = socialStatus();
      const len = area.value.length;
      counter.textContent = `${len} / ${SHARE_LIMITS.message}`;
      area.disabled = !stt.canWrite;
      send.disabled = !stt.canWrite || sending || !area.value.trim();
      hint.textContent = !stt.canWrite
        ? '当前权限只能阅读留言。'
        : stt.mode === 'local' ? '本地模式：留言只保存在这台设备上。' : '留言以「一位访客」的身份匿名显示。请友善发言。';
    };
    area.addEventListener('input', paintComposer);
    const form = h('form.s-composer', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (sending || !area.value.trim()) return;
        sending = true;
        paintComposer();
        const r = await addMessage(life.lifeId, area.value);
        sending = false;
        if (r.ok) {
          area.value = '';
          toast(app, '留言已送出。', 'good');
        } else {
          toast(app, r.message, 'bad');
        }
        if (!destroyed) paintComposer();
      },
    }, area, h('div.s-composer-row', counter, send), hint);

    const renderMsgs = (msgs) => {
      clear(list);
      if (!msgs.length) {
        list.appendChild(h('li.s-msg-empty', `还没有留言。写下第一句想对 ${life.name} 说的话吧。`));
        return;
      }
      const owner = socialStatus().owner;
      for (const m of msgs) {
        const canDelete = owner || m.mine;
        list.appendChild(h('li.s-msg',
          h('p.s-msg-text', m.text),
          h('div.s-msg-meta',
            h('span.s-msg-who', m.mine ? '你' : ANON),
            m.at ? h('time', { datetime: m.at, title: absDate(m.at) }, relTime(m.at)) : null,
            canDelete ? h('button.s-link', {
              type: 'button',
              onclick: async () => {
                const ok = await ask(app, {
                  title: '删除这条留言？', body: m.mine ? '删除后无法恢复。' : '你将以页面所有者的身份删除这条留言，删除后无法恢复。',
                  ok: '删除', cancel: '保留', danger: true,
                });
                if (!ok) return;
                const r = await deleteMessage(life.lifeId, m.id);
                toast(app, r.ok ? '留言已删除。' : r.message, r.ok ? 'info' : 'bad');
              },
            }, '删除') : null)));
      }
    };
    const unsub = subscribeMessages(life.lifeId, (msgs) => { if (!destroyed) renderMsgs(msgs); });
    cleanups.push(unsub, onSocialStatus(paintComposer));
    paintComposer();
    return h('section.s-section.s-messages',
      h('h3.s-section-title', '留言'),
      form,
      list);
  }

  function moderation(life) {
    const owner = socialStatus().owner;
    if (!owner && !life.mine) return null;
    const local = socialStatus().mode === 'local';
    const label = life.mine || local ? '撤回这段分享' : '以页面所有者身份移除';
    const btn = h('button.s-btn.s-btn--danger', {
      type: 'button',
      onclick: async () => {
        const ok = await ask(app, {
          title: '移除这段人生？',
          body: '它的档案、蜡烛和留言会从分享列表中一并删除，无法恢复。你本机的前世纪录不受影响。',
          ok: '移除', cancel: '保留', danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        const r = await deleteShared(life.lifeId);
        if (r.ok) {
          toast(app, '已移除。', 'info');
          if (typeof opts.onRemoved === 'function') opts.onRemoved(life.lifeId); else goBack();
        } else {
          btn.disabled = false;
          toast(app, r.message, 'bad');
        }
      },
    }, label);
    return h('section.s-section.s-moderate',
      h('h3.s-section-title', '管理'),
      h('p.s-muted', life.mine || local ? '这段人生是你分享的。' : '你是本页面的所有者，可以移除不合适的内容。'),
      btn);
  }

  if (input && input.life) show(input.life);
  else getShared(lifeId).then(show, () => show(null));

  return () => {
    destroyed = true;
    for (const fn of cleanups) { try { fn && fn(); } catch { /* ignore */ } }
  };
}

/** Standalone screen: params { lifeId, life?, from: 'shared'|'memorial' }. */
export function mount(root, params = {}, app) {
  setDataSource(app && app.data);
  initSocial();
  const from = params.from === 'memorial' ? 'memorial' : 'shared';
  const page = h('section.s-page' + (from === 'memorial' ? '.s-memorial' : ''));
  clear(root);
  root.appendChild(page);
  return renderLifeDetail(page, { lifeId: params.lifeId || params.id, life: params.life }, app, {
    variant: from,
    backLabel: from === 'memorial' ? '返回追思馆' : '返回大家分享的人生',
    onBack: () => app.go(from),
    onRemoved: () => app.go(from),
  });
}
