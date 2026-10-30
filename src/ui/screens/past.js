// "前世纪录": the last PAST_LIVES_MAX finished lives stored on this device. List, full detail (life map, decisions,
// complete log), delete with an in-page confirm, share to the public archive, JSON export / import (file or paste).

import { h, s, clear } from '../dom.js';
import { STATS, STAT_LABELS, HISTORY_END, PAST_LIVES_MAX } from '../../core/constants.js';
import {
  pastLives, getPastLife, deletePastLife, exportLives, importLives, updatePastLife, EXPORT_FORMAT, EXPORT_VERSION,
} from '../../social/saves.js';
import { initSocial, setDataSource, shareLife, socialStatus, onSocialStatus } from '../../social/store.js';
import { saveBlob } from '../cards.js';
import { lifeMap } from '../lifemap.js';
import { lifeStrip, statBars, ask, archiveNo, emptyState, absDate, liveBanner, SEX_LABELS } from './lifeDetail.js';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function toast(app, text, kind) {
  try { if (app && typeof app.toast === 'function') app.toast(text, kind); } catch { /* ignore */ }
}

function recMeta(rec, app) {
  return [
    SEX_LABELS[rec.sex],
    countryLabel(rec, app),
    `${rec.birthYear}—${rec.deathYear}`,
    rec.alive ? `${rec.age} 岁时中止` : `享年 ${rec.age} 岁`,
  ].filter(Boolean).join(' · ');
}

/** Archived records made without a data store carry the ISO3 code as countryName; resolve it for display. */
function countryLabel(rec, app) {
  if (rec.countryName && rec.countryName !== rec.country) return rec.countryName;
  try {
    const c = app && app.data && typeof app.data.country === 'function' ? app.data.country(rec.country) : null;
    if (c && typeof c.name === 'string' && c.name) return c.name;
  } catch { /* ignore */ }
  return rec.country || '未知地区';
}

/** Hand a JSON file to the viewer through cards.saveBlob (never throws; resolves {ok, status, message}). */
async function offerFile(app, json, filename, okText) {
  let r = null;
  try {
    r = await saveBlob(new Blob([json], { type: 'application/json' }), filename);
  } catch {
    r = null;
  }
  if (r && r.ok) toast(app, okText, 'good');
  else if (r && r.status === 'declined') toast(app, '已取消导出。', 'info');
  else toast(app, (r && r.message) || '导出失败，请稍后再试。', 'bad');
}

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function importSummary(res) {
  const base = importLivesSummary(res);
  return res.cards ? `${base} 另外合并了 ${res.cards} 张成就卡片。` : base;
}

function importLivesSummary(res) {
  if (res.error && !res.added) return res.error;
  if (res.added) return `已导入 ${res.added} 段人生` + (res.skipped ? `，跳过 ${res.skipped} 段（重复、无效或超出 ${PAST_LIVES_MAX} 段上限）。` : '。');
  return res.skipped ? `没有导入新的人生：${res.skipped} 段记录重复、无效或比现有的 ${PAST_LIVES_MAX} 段都早。` : '文件里没有人生记录。';
}

/** Small SVG trend of one stat across the life; projected years drawn dashed. */
function trend(rows, k) {
  const pts = rows.filter((r) => r && r.stats && typeof r.stats[k] === 'number');
  if (pts.length < 2) return null;
  const W = 160;
  const H = 30;
  const n = pts.length;
  const x = (i) => ((i / (n - 1)) * W).toFixed(1);
  const y = (v) => (H - 2 - (Math.max(0, Math.min(100, v)) / 100) * (H - 4)).toFixed(1);
  const real = [];
  const proj = [];
  pts.forEach((r, i) => {
    const p = `${x(i)},${y(r.stats[k])}`;
    if (r.year <= HISTORY_END) real.push(p);
    else {
      if (!proj.length && real.length) proj.push(real[real.length - 1]);
      proj.push(p);
    }
  });
  const first = Math.round(pts[0].stats[k]);
  const last = Math.round(pts[n - 1].stats[k]);
  return s('svg', {
    class: 's-trend', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': `${STAT_LABELS[k]}：一生中从 ${first} 变为 ${last}`,
  },
  real.length > 1 ? s('polyline', { class: `s-trend-line s-stroke-${k}`, points: real.join(' ') }) : null,
  proj.length > 1 ? s('polyline', { class: `s-trend-line is-proj s-stroke-${k}`, points: proj.join(' ') }) : null);
}

function logGroups(log) {
  const groups = [];
  let cur = null;
  let lastYear = null;
  for (const e of log) {
    if (!e || typeof e.text !== 'string') continue;
    const year = typeof e.year === 'number' ? e.year : lastYear;
    lastYear = year;
    const decade = year == null ? null : Math.floor(year / 10) * 10;
    if (!cur || cur.decade !== decade) {
      cur = { decade, items: [], ages: [] };
      groups.push(cur);
    }
    cur.items.push(e);
    if (typeof e.age === 'number') cur.ages.push(e.age);
  }
  return groups;
}

function logEntry(e) {
  const proj = typeof e.year === 'number' && e.year > HISTORY_END;
  const badge = e.source === 'history' ? h('span.s-badge.s-badge--real', '真实历史')
    : e.source === 'future' ? h('span.s-badge.s-badge--proj', '推演')
      : e.kind === 'news' ? h('span.s-badge', '世界')
        : e.kind === 'decision' || e.kind === 'choice' ? h('span.s-badge', '抉择')
          : e.kind === 'death' ? h('span.s-badge', '离世') : null;
  const tone = e.tone > 0 ? '.is-up' : e.tone < 0 ? '.is-down' : '';
  return h('li.s-log-item' + tone + (proj ? '.is-proj' : ''),
    h('span.s-log-when', [typeof e.year === 'number' ? `${e.year}` : '', typeof e.age === 'number' ? `${e.age} 岁` : ''].filter(Boolean).join(' · ')),
    h('p.s-log-text', badge, e.text));
}

export function mount(root, params = {}, app) {
  setDataSource(app && app.data);
  initSocial();
  clear(root);

  const page = h('section.s-page.s-past');
  root.appendChild(page);
  let viewCleanups = [];
  let returnScroll = 0;

  function resetView() {
    for (const fn of viewCleanups) { try { fn(); } catch { /* ignore */ } }
    viewCleanups = [];
    clear(page);
  }

  // ---------------------------------------------------------------- list view
  function showList() {
    resetView();
    const lives = pastLives();
    const banner = liveBanner({ context: 'past' });
    viewCleanups.push(banner.dispose);

    const fileInput = h('input.s-file', { type: 'file', accept: '.json,application/json', 'aria-label': '选择要导入的备份文件', tabindex: '-1' });
    const status = h('p.s-import-status', { 'aria-live': 'polite' });
    const pasteArea = h('textarea.s-textarea.s-textarea--mono', {
      rows: 5, placeholder: '把导出的 JSON 内容粘贴到这里', 'aria-label': '粘贴备份内容', spellcheck: 'false',
    });
    const pastePanel = h('div.s-paste', { hidden: true },
      pasteArea,
      h('div.s-paste-actions',
        h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => { pastePanel.hidden = true; pasteArea.value = ''; } }, '取消'),
        h('button.s-btn.s-btn--primary', {
          type: 'button',
          onclick: () => {
            if (!pasteArea.value.trim()) { status.textContent = '请先粘贴导出的内容。'; return; }
            finishImport(importLives(pasteArea.value));
          },
        }, '导入')));

    const finishImport = (res) => {
      const msg = importSummary(res);
      status.textContent = msg;
      toast(app, msg, res.added || res.cards ? 'good' : 'warn');
      if (res.added) {
        pasteArea.value = '';
        // re-render with the new records, keeping the result message visible
        showList();
        const st = page.querySelector('.s-import-status');
        if (st) st.textContent = msg;
      }
    };

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_IMPORT_BYTES) { status.textContent = '文件太大，不像是《人生长河》的备份。'; return; }
      try {
        finishImport(importLives(await file.text()));
      } catch {
        status.textContent = '无法读取这个文件。';
      }
    });

    const exportBtn = h('button.s-btn', {
      type: 'button',
      disabled: !lives.length,
      onclick: () => offerFile(app, exportLives(), `lifeline2090-past-lives-${stamp()}.json`, '备份文件已导出。'),
    }, '导出备份');

    page.append(
      banner.el,
      h('header.s-head',
        h('p.s-kicker', '档案室 · 本机'),
        h('h1.s-title', '前世纪录'),
        h('p.s-lede', `你最近走完的 ${PAST_LIVES_MAX} 段人生保存在这台设备的浏览器里。可以随时回看每一年的经历和每一次抉择，也可以导出备份、在别的设备上导入。`)),
      h('div.s-toolbar',
        exportBtn,
        h('button.s-btn', { type: 'button', onclick: () => fileInput.click() }, '从文件导入'),
        h('button.s-btn.s-btn--ghost', { type: 'button', onclick: () => { pastePanel.hidden = !pastePanel.hidden; if (!pastePanel.hidden) pasteArea.focus(); } }, '粘贴导入'),
        h('span.s-toolbar-count', `已保存 ${lives.length} / ${PAST_LIVES_MAX}`),
        fileInput),
      pastePanel,
      status);

    if (!lives.length) {
      page.appendChild(emptyState('还没有前世纪录',
        `开始一段人生并走到终点，它就会被归档在这里（最多保留最近 ${PAST_LIVES_MAX} 段）。也可以导入之前导出的备份文件。`,
        [h('button.s-btn.s-btn--primary', { type: 'button', onclick: () => app.go('birth') }, '开始一段人生')]));
      return;
    }

    const list = h('ol.s-past-list');
    lives.forEach((rec, i) => {
      const open = () => { returnScroll = window.scrollY || 0; showDetail(rec.id); };
      list.appendChild(h('li',
        h('article.s-past-row',
          h('div.s-past-idx',
            h('span.s-past-no', String(i + 1).padStart(2, '0')),
            h('span.s-past-when', absDate(rec.savedAt))),
          h('div.s-past-main',
            h('p.s-card-no', '档案 ' + archiveNo(rec)),
            h('h3.s-past-name', h('button.s-card-open', { type: 'button', onclick: open }, rec.name || '无名者')),
            h('p.s-past-meta', recMeta(rec, app)),
            rec.title ? h('p.s-past-title', rec.title) : null,
            h('p.s-past-cause', rec.alive ? '这段人生没有走到终点' : `死因：${rec.cause || '未记录'}`),
            rec.history.length ? lifeStrip(rec.history.map((r) => r.tag), rec.birthYear) : null),
          h('div.s-past-actions',
            rec.sharedId ? h('span.s-badge.s-badge--seal', '已分享') : null,
            h('button.s-btn.s-btn--sm', { type: 'button', onclick: open }, '查看'),
            h('button.s-btn.s-btn--sm.s-btn--ghost', { type: 'button', onclick: () => confirmDelete(rec, showList) }, '删除')))));
    });
    page.append(list,
      h('p.s-footnote', '存档只保存在这台设备的浏览器中，清除浏览器数据会一并删除。想长期保留，请定期导出备份。'));
    if (returnScroll) { try { window.scrollTo(0, returnScroll); } catch { /* ignore */ } returnScroll = 0; }
  }

  async function confirmDelete(rec, after) {
    const ok = await ask(app, {
      title: `删除「${rec.name || '无名者'}」的前世纪录？`,
      body: '这段人生的全部记录会从这台设备上删除，无法恢复。' + (rec.sharedId ? '已分享到公共档案的副本不受影响。' : ''),
      ok: '删除', cancel: '保留', danger: true,
    });
    if (!ok) return;
    deletePastLife(rec.id);
    toast(app, '已删除。', 'info');
    after();
  }

  // ---------------------------------------------------------------- detail view
  function showDetail(id) {
    const rec = getPastLife(id);
    if (!rec) { showList(); return; }
    resetView();
    try { window.scrollTo(0, 0); } catch { /* ignore */ }

    const back = h('button.s-back', { type: 'button', onclick: showList }, '← 返回前世纪录');
    const actions = h('div.s-detail-actions');
    const paintActions = () => {
      clear(actions);
      const cur = getPastLife(id) || rec;
      const st = socialStatus();
      if (!cur.alive) {
        if (cur.sharedId) {
          actions.appendChild(h('button.s-btn', { type: 'button', onclick: () => app.go('shared', { lifeId: cur.sharedId }) }, '查看已分享的档案'));
        } else if (st.ready && st.canWrite) {
          const shareBtn = h('button.s-btn.s-btn--primary', {
            type: 'button',
            onclick: async () => {
              shareBtn.disabled = true;
              shareBtn.textContent = '正在分享……';
              const r = await shareLife({ ...cur, countryName: countryLabel(cur, app) });
              if (r.ok) {
                updatePastLife(cur.id, { sharedId: r.lifeId });
                toast(app, r.local ? '已保存到本机的分享列表。单机版里的分享只有你自己看得到。' : '已分享到「大家分享的人生」。', 'good');
              } else {
                toast(app, r.message, 'bad');
              }
              paintActions();
            },
          }, '分享给大家');
          actions.appendChild(shareBtn);
        }
      }
      actions.append(
        h('button.s-btn', {
          type: 'button',
          onclick: () => offerFile(app,
            JSON.stringify({ format: EXPORT_FORMAT, v: EXPORT_VERSION, exportedAt: new Date().toISOString(), lives: [cur] }),
            `lifeline2090-${cur.birthYear}-${cur.country || 'life'}-${stamp()}.json`, '这段人生已导出。'),
        }, '导出这段人生'),
        h('button.s-btn.s-btn--danger', { type: 'button', onclick: () => confirmDelete(cur, showList) }, '删除'));
    };
    paintActions();
    viewCleanups.push(onSocialStatus(paintActions));
    initSocial().then(() => { if (actions.isConnected) paintActions(); });

    const tags = rec.history.map((r) => r.tag);
    let map = null;
    try {
      const el = lifeMap(rec.history, {
        birthYear: rec.birthYear, expectedYears: rec.history.length, decisions: rec.decisions,
        data: app && app.data, dead: !rec.alive, legend: true, detail: true,
      });
      if (el && typeof el === 'object' && el.nodeType === 1) map = el;
    } catch {
      map = null;
    }
    if (!map && tags.length) map = lifeStrip(tags, rec.birthYear, { variant: 'full' });

    const story = h('div.s-col');
    if (rec.bio) story.appendChild(h('section.s-section', h('h3.s-section-title', '生平'), h('div.s-bio', rec.bio.split('\n').filter(Boolean).map((p) => h('p', p)))));
    if (rec.deathSummary && rec.deathSummary !== rec.bio) story.appendChild(h('section.s-section', h('h3.s-section-title', '最后的日子'), h('p', rec.deathSummary)));
    if (rec.highlights.length) story.appendChild(h('section.s-section', h('h3.s-section-title', '人生节点'), h('ul.s-highlights', rec.highlights.map((x) => h('li', x)))));
    if (!story.childNodes.length) story.appendChild(h('section.s-section', h('h3.s-section-title', '生平'), h('p.s-muted', '这段人生没有生成传记。下面的抉择和逐年记录完整保留了 TA 的经历。')));

    const trends = h('ul.s-trends', STATS.map((k) => {
      const t = trend(rec.history, k);
      return t ? h('li', h('span.s-trend-label', STAT_LABELS[k]), t) : null;
    }));
    const side = h('div.s-col.s-col--side',
      h('section.s-section', h('h3.s-section-title', rec.alive ? '中止时的状态' : '离世时的状态'), statBars(rec.stats)),
      trends.childNodes.length ? h('section.s-section', h('h3.s-section-title', '一生的起伏'), h('p.s-section-note', '虚线为 2027 年以后的推演年份。'), trends) : null);

    const decisions = rec.decisions.length
      ? h('ol.s-decisions', rec.decisions.map((d) => h('li.s-decision' + (typeof d.year === 'number' && d.year > HISTORY_END ? '.is-proj' : ''),
        h('span.s-decision-when', [typeof d.year === 'number' ? `${d.year} 年` : '', typeof d.age === 'number' ? `${d.age} 岁` : ''].filter(Boolean).join(' · ')),
        h('p.s-decision-title', d.title, d.source === 'ai' ? h('span.s-badge', 'AI 推演') : null),
        h('p.s-decision-choice', (d.custom ? '自拟行动：' : '选择：') + (d.choice || '—')))))
      : h('p.s-muted', '这段人生没有记录下抉择。');

    const log = rec.state && Array.isArray(rec.state.log) ? rec.state.log : [];
    const groups = logGroups(log);
    const logBox = h('div.s-log');
    if (!groups.length) {
      logBox.appendChild(h('p.s-muted', '完整的逐年记录没有保存下来（存储空间不足时会被精简）。人生图谱和抉择仍然完整。'));
    }
    for (const g of groups) {
      const ages = g.ages.length ? `${Math.min(...g.ages)}–${Math.max(...g.ages)} 岁` : '';
      const label = g.decade == null ? '未标注年份' : `${g.decade} 年代`;
      const listEl = h('ol.s-log-list');
      const det = h('details.s-decade' + (g.decade != null && g.decade + 9 > HISTORY_END ? '.is-proj' : ''),
        h('summary', h('span.s-decade-label', label), h('span.s-decade-meta', [ages, `${g.items.length} 条`].filter(Boolean).join(' · '))),
        listEl);
      let filled = false;
      det.addEventListener('toggle', () => {
        if (det.open && !filled) {
          filled = true;
          for (const e of g.items) listEl.appendChild(logEntry(e));
        }
      });
      logBox.appendChild(det);
    }

    page.append(h('article.s-detail',
      h('div.s-detail-top', back),
      h('header.s-detail-head',
        h('p.s-kicker', `前世档案 · 档案号 ${archiveNo(rec)} · 归档于 ${absDate(rec.savedAt)}`),
        h('h2.s-detail-name', rec.name || '无名者'),
        rec.title ? h('p.s-detail-title', rec.title) : null,
        h('p.s-detail-meta', recMeta(rec, app)),
        rec.alive ? h('p.s-detail-cause', '这段人生没有走到终点。')
          : h('p.s-detail-cause', '死因：' + (rec.cause || '未记录') + (rec.causeDetail ? `（${rec.causeDetail}）` : '')),
        typeof rec.lifeExpAtBirth === 'number' && !rec.alive
          ? h('p.s-detail-note', `出生时当地的预期寿命约为 ${rec.lifeExpAtBirth.toFixed(1)} 岁，TA 活到了 ${rec.age} 岁。`)
          : null,
        h('div.s-badges',
          h('span.s-badge', rec.mode === 'custom' ? '自定义出生' : '随机出生'),
          rec.birthYear <= HISTORY_END ? h('span.s-badge.s-badge--real', '经历真实历史') : null,
          rec.deathYear > HISTORY_END ? h('span.s-badge.s-badge--proj', '含推演年份') : null,
          rec.worldLabel ? h('span.s-badge.s-badge--proj', '世界线：' + rec.worldLabel) : null),
        actions),
      rec.epitaph ? h('blockquote.s-epitaph', h('p', rec.epitaph)) : null,
      map ? h('section.s-section', h('h3.s-section-title', '人生图谱'), map) : null,
      h('div.s-detail-grid', story, side),
      h('section.s-section', h('h3.s-section-title', `抉择（${rec.decisions.length}）`), decisions),
      h('section.s-section', h('h3.s-section-title', '逐年记录'), h('p.s-section-note', '按年代展开查看这一生的全部经历。'), logBox),
      h('p.s-fiction', '个人经历为模拟生成的虚构故事；2026 年以前的世界大事来自真实记录，2027 年以后为基于当下趋势的推演。')));
  }

  if (params && params.id && getPastLife(String(params.id))) showDetail(String(params.id));
  else showList();

  return () => resetView();
}
