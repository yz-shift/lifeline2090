// Death screen: the 死亡证明 of one (fictional) life, then the life in review — a short summary of the life (the
// happiest year, the year with the most money ...), a comparison with the player's real birthplace when they gave one
// in settings, the biography + epitaph (streamed from the AI director; templated offline), a last sentence the player
// leaves for this person, the starred 值得记住的时刻, the notes and reflections written along the way, stats over the
// whole life, the full life map, key choices, what became of the children (子女们的人生), rare moments found, and
// what became of the people born in the same second. Actions: the 人生长卷 poster (previewed so it can be long-pressed
// to save inside WeChat), download the certificate card, share to the memorial
// (in-page confirm), live again (new or same world line), past lives, about the data.
// The past-life record is kept up to date automatically (saves.addPastLife / updatePastLife).

import { h, clear, reducedMotion, storage } from '../dom.js';
import { STATS, STAT_LABELS, HISTORY_END, YEAR_TAG_LABELS } from '../../core/constants.js';
import * as charts from '../charts.js';
import * as lifemapMod from '../lifemap.js';
import * as cards from '../cards.js';
import * as saves from '../../social/saves.js';
import * as collection from '../../social/collection.js';
import { achievementDef } from '../../core/achievements.js';
import { cardTile } from './album.js';
import * as store from '../../social/store.js';
import * as engineMod from '../../core/engine.js';
import { FOCUS_NAMES } from '../../core/focus.js';
import { biographyFor, worldFor, lifeExpAtBirth, archiveNumber, countryName, streamField } from '../controller.js';
import { money } from './decision.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SHARED_KEY = 'll2090.sharedLives';
export const FINAL_PROMPT = '最后，你想对这个人说一句话';
export const FINAL_MAX = 200;
const FINAL_ON_CARD = 40;   // a final sentence this short also goes on the downloaded certificate card

// ---------------------------------------------------------------------------------------------------------------
// pure helpers (exported for tests)

const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Lines that sum up the life: engine.lifeSummary when it exists, else a summary read from the history rows.
 * Returns {lines, happiestAge, richestAge, source}.
 */
export function summaryOf(E, data, world, state) {
  if (E && typeof E.lifeSummary === 'function') {
    try {
      const r = E.lifeSummary(data, world, state);
      const lines = r && Array.isArray(r.lines) ? r.lines.map(clean).filter(Boolean).slice(0, 8) : [];
      if (lines.length) return { lines, happiestAge: r.happiestAge ?? null, richestAge: r.richestAge ?? null, source: 'engine' };
    } catch (e) { console.warn('[death] lifeSummary', e); }
  }
  const rows = (Array.isArray(state && state.history) ? state.history : []).filter((r) => r && r.stats && isNum(r.age));
  const lines = [];
  if (!rows.length) return { lines, happiestAge: null, richestAge: null, source: 'history' };
  const best = (k, sign = 1) => rows.reduce((a, r) => (isNum(r.stats[k]) && (!a || sign * r.stats[k] > sign * a.stats[k]) ? r : a), null);
  const happy = best('happiness');
  const rich = best('wealth');
  const hard = best('happiness', -1);
  const healthy = rows.length > 25 ? best('health') : null;
  const at = (r) => `${r.age} 岁（${r.year} 年）`;
  // a year's headline is named only when its mood agrees with the line (a happy year's headline was a good thing)
  const said = (r, sign) => (clean(r.headline) && r.headline !== '平常的一年' && (!isNum(r.mood) || sign * r.mood > 0) ? clean(r.headline) : '');
  if (happy) lines.push(`最快乐的一年是 ${at(happy)}${said(happy, 1) ? `，那一年：${said(happy, 1)}` : ''}。`);
  if (rich && rich.age >= 16) lines.push(`手头最宽裕的一年是 ${at(rich)}。`);
  if (hard && happy && hard !== happy && isNum(hard.stats.happiness) && hard.stats.happiness < 40) lines.push(`最难熬的一年是 ${at(hard)}${said(hard, -1) ? `：${said(hard, -1)}` : ''}。`);
  if (healthy && healthy !== happy) lines.push(`身体最好的时候是 ${healthy.age} 岁前后。`);
  const focusYears = {};
  for (const r of rows) if (typeof r.focus === 'string' && r.focus) focusYears[r.focus] = (focusYears[r.focus] || 0) + 1;
  const top = Object.entries(focusYears).sort((a, b) => b[1] - a[1])[0];
  const names = FOCUS_NAMES && typeof FOCUS_NAMES === 'object' ? FOCUS_NAMES : {};
  if (top && top[1] >= 3 && names[top[0]]) lines.push(`花得最多的年头在「${names[top[0]]}」上，一共 ${top[1]} 年。`);
  const places = [...new Set(rows.map((r) => r.country).filter(Boolean))];
  if (places.length > 1) lines.push(`一生在 ${places.length} 个国家和地区生活过。`);
  return { lines, happiestAge: happy ? happy.age : null, richestAge: rich ? rich.age : null, focusYears, source: 'history' };
}

/** The starred log entries (state.stars ids, at most 12), oldest first; ids whose entry is gone are skipped. */
export function starredMoments(state) {
  const ids = Array.isArray(state && state.stars) ? state.stars.map(String) : [];
  if (!ids.length) return [];
  const byId = new Map();
  for (const e of Array.isArray(state.log) ? state.log : []) if (e && e.id != null) byId.set(String(e.id), e);
  return ids.slice(0, 12).map((id) => byId.get(id)).filter((e) => e && clean(e.text))
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || (a.age ?? 0) - (b.age ?? 0));
}

/** Notes and reflections written during the life (not the final sentence), oldest first. */
export function lifeNotes(state) {
  return (Array.isArray(state && state.notes) ? state.notes : [])
    .filter((n) => n && n.kind !== 'final' && clean(n.text))
    .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
}

export function finalNote(state) {
  const all = (Array.isArray(state && state.notes) ? state.notes : []).filter((n) => n && n.kind === 'final' && clean(n.text));
  return all.length ? all[all.length - 1] : null;
}

/**
 * Store the player's last sentence to this person as the life's one 'final' note (engine.addNote when present).
 * Empty text removes it. Returns the stored note or null.
 */
export function setFinalNote(E, state, text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, FINAL_MAX);
  if (!Array.isArray(state.notes)) state.notes = [];
  state.notes = state.notes.filter((n) => !(n && n.kind === 'final'));
  if (!t) return null;
  let added = false;
  if (E && typeof E.addNote === 'function') {
    try { E.addNote(state, t, 'final', FINAL_PROMPT); added = !!finalNote(state); } catch (e) { console.warn('[death] addNote', e); }
  }
  if (!added) {
    state.notes.push({ year: state.dead?.year ?? state.year, age: state.dead?.age ?? state.age, kind: 'final', prompt: FINAL_PROMPT, text: t });
  }
  return finalNote(state);
}

/** What became of the children: engine.childrenFates, else a plain line from the state. [{name, sex, birthYear, line}] */
export function childrenLines(E, data, world, state) {
  if (E && typeof E.childrenFates === 'function') {
    try {
      const r = E.childrenFates(data, world, state);
      if (Array.isArray(r)) {
        return r.filter((x) => x && typeof x === 'object' && clean(x.line))
          .map((x) => ({ name: clean(x.name) || '孩子', sex: x.sex, birthYear: isNum(x.birthYear) ? x.birthYear : null, line: clean(x.line) }));
      }
    } catch (e) { console.warn('[death] childrenFates', e); }
  }
  const kids = Array.isArray(state?.person?.children) ? state.person.children : [];
  const year = state?.dead?.year ?? state?.year;
  return kids.filter((c) => c && typeof c === 'object').map((c) => {
    const pron = c.sex === 'female' ? '她' : '他';
    const age = isNum(c.birthYear) && isNum(year) ? Math.max(0, year - c.birthYear) : null;
    const line = c.alive === false ? `${pron}比你先走了一步。` : age != null ? `你离开的时候，${pron} ${age} 岁。` : `你离开的时候，${pron}还在。`;
    return { name: clean(c.name) || '孩子', sex: c.sex, birthYear: isNum(c.birthYear) ? c.birthYear : null, line };
  });
}

function leAt(data, world, iso, year) {
  let v = null;
  try { if (year > HISTORY_END && world && typeof world.indicator === 'function') v = world.indicator(iso, 'le', year); } catch { v = null; }
  if (!isNum(v)) { try { v = data && typeof data.series === 'function' ? data.series(iso, 'le', year) : null; } catch { v = null; } }
  return isNum(v) && v > 0 ? v : null;
}

/**
 * The player's real birthplace (settings.compareIso / compareYear, kept only in this browser) next to this life:
 * life expectancy at birth there and here, from the same UN WPP series. Returns null when not set or unknown.
 * {lines:[2 strings], note, realLE, lifeLE, iso, year, approx}
 */
export function compareBirthplace(data, world, state, settings) {
  const iso = settings && typeof settings.compareIso === 'string' ? settings.compareIso : null;
  const countries = (data && data.countries) || {};
  if (!iso || !countries[iso] || !state || !state.birth) return null;
  const b = state.birth;
  const p = state.person || {};
  const d = state.dead || {};
  const name = p.name || b.name || '这个人';
  const realYear = Number.isInteger(settings.compareYear) ? settings.compareYear : null;
  const yRaw = realYear ?? b.year;
  const y = Math.max(2000, Math.min(HISTORY_END, yRaw));
  const approx = yRaw < 2000;
  const realLE = leAt(data, world, iso, y);
  const lifeLE = leAt(data, world, b.country, b.year);
  if (!isNum(realLE) || !isNum(lifeLE)) return null;
  const cn = (c) => String(countries[c]?.name || c);
  const age = d.age ?? state.age;
  const same = iso === b.country;
  const line1 = `你实际出生的${cn(iso)}，${yRaw} 年出生的人，预期寿命约 ${realLE.toFixed(1)} 岁${approx ? '（数据从 2000 年开始，这里按 2000 年计）' : ''}。`;
  const line2 = same
    ? `${name}也出生在${cn(b.country)}（${b.year} 年），那时约 ${lifeLE.toFixed(1)} 岁；${name}活到了 ${age} 岁。`
    : `${name}出生在${cn(b.country)}（${b.year} 年），那里那时约 ${lifeLE.toFixed(1)} 岁；${name}活到了 ${age} 岁。`;
  const gap = Math.abs(realLE - lifeLE);
  const note = gap >= 3
    ? `两地相差约 ${gap.toFixed(0)} 年，来自医疗、收入和安全上的差距，与一个人是否努力无关。`
    : '两地出生时的预期寿命相差不大。';
  return { lines: [line1, line2], note, realLE, lifeLE, iso, year: yRaw, approx };
}

function badge(text, kind) {
  return h('span.g-b', { class: `g-b--${kind}` }, text);
}
function yearBadge(year) {
  if (year > HISTORY_END) return badge('推演', 'proj');
  if (year === HISTORY_END) return badge('截至 2026-10', 'real');
  return badge('真实历史', 'real');
}
function paragraphs(text) {
  return String(text || '').split(/\n+/).map((t) => t.trim()).filter(Boolean).map((t) => h('p', t));
}
function dateText(date, year) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    const [y, m, d] = date.slice(0, 10).split('-').map(Number);
    return `${y} 年 ${m} 月 ${d} 日`;
  }
  if (typeof date === 'string' && /^\d{4}-\d{2}$/.test(date)) {
    const [y, m] = date.split('-').map(Number);
    return `${y} 年 ${m} 月`;
  }
  return isNum(year) ? `${year} 年` : '—';
}
function sharedMap() {
  const m = storage.get(SHARED_KEY, {});
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

export function mount(root, params = {}, app) {
  const data = app.data;
  const state = params.state || (params.record && params.record.state) || (typeof app.getLife === 'function' ? app.getLife() : null);

  if (!state || !state.dead) {
    root.append(h('div.g-empty.g-panel',
      h('p.g-eyebrow', '死亡证明'),
      h('h1.g-empty-t', '这里还没有可以查看的证明'),
      h('p.g-muted', '一段人生结束后，它的死亡证明会出现在这里。'),
      h('div.g-row',
        h('button.g-btn.g-btn--primary', { type: 'button', onclick: () => app.go('birth') }, '开始一段人生'),
        h('button.g-btn', { type: 'button', onclick: () => app.go('past') }, '前世纪录'))));
    return undefined;
  }

  const world = worldFor(app, state);
  const E = (params.deps && params.deps.engine) || engineMod;
  const b = state.birth || {};
  const p = state.person || {};
  const d = state.dead;
  const sex = p.sex || b.sex;
  const name = p.name || b.name || '无名';
  const le = lifeExpAtBirth(app, state, world);
  const archive = typeof app.archiveNo === 'function' ? app.archiveNo(state) : archiveNumber(state);
  const history = Array.isArray(state.history) ? state.history : [];
  const deathIso = d.place || p.country || b.country;
  let destroyed = false;
  const offs = [];
  let bio = null; // {biography, epitaph, title, highlights, source}
  let job = null; // biography job while it is being written

  // ---- the stored record: reuse a finished biography instead of writing it again ------------------------------
  let record = null;
  try { record = typeof saves.getPastLife === 'function' ? saves.getPastLife(state.id) : null; } catch { record = null; }
  if (!record && typeof saves.addPastLife === 'function') {
    try { record = saves.addPastLife(state, { data }); } catch (e) { console.warn('[death] addPastLife', e); }
  }
  // achievement cards: counted once per life (recordLife is idempotent), new ones flip in below the certificate
  let cardsGot = { fresh: [], earned: [] };
  const regionOf = (iso) => { try { return (data.country(iso) || {}).region || null; } catch { return null; } };
  try { cardsGot = collection.recordLife(state, { regionOf }); } catch (e) { console.warn('[death] cards', e); }
  if (record && record.epitaph && record.bio) {
    bio = { biography: record.bio, epitaph: record.epitaph, title: record.title || '', highlights: record.highlights || [], source: 'saved' };
  }

  // ------------------------------------------------------------------------------------------------------------
  // certificate

  let pct = isNum(d.percentile) ? d.percentile : null;
  if (isNum(pct) && pct <= 1) pct *= 100;
  const diff = isNum(d.age) ? d.age - le : null;
  const diffText = !isNum(diff) ? '' : Math.abs(diff) < 0.5 ? '，与预期相当' : diff > 0 ? `，比预期多活了 ${diff.toFixed(1)} 年` : `，比预期少了 ${Math.abs(diff).toFixed(1)} 年`;
  const migrated = deathIso && b.country && deathIso !== b.country;
  const worldLabel = state.worldLabel || (world && world.label) || '';

  const row = (k, ...v) => [h('dt', k), h('dd', ...v)];
  const cert = h('article.g-cert', { class: d.year > HISTORY_END ? 'g-cert--proj' : '', 'aria-labelledby': 'g-cert-title' },
    h('div.g-seal', { 'aria-hidden': 'true' }, h('span', '人生长河'), h('span.g-seal-m', '档案'), h('span', '专用章')),
    h('header.g-cert-hd',
      h('p.g-cert-org', '人生长河 · 人口档案馆'),
      h('h1.g-cert-title#g-cert-title', '死亡证明'),
      h('p.g-cert-no', h('span', '档案号 '), h('span.g-mono', archive))),
    h('dl.g-cert-grid',
      row('姓名', h('span.g-cert-name', name), b.nameLatin ? h('span.g-cert-latin', b.nameLatin) : null),
      row('性别', sex === 'male' ? '男' : '女'),
      row('出生', h('span', `${dateText(b.date, b.year)}${b.time ? ` ${String(b.time).slice(0, 8)}` : ''}`),
        h('span.g-cert-sub', `${countryName(data, b.country)} · ${b.urban ? '城市' : '乡村'}`), yearBadge(b.year)),
      row('死亡', h('span', dateText(d.date, d.year)),
        h('span.g-cert-sub', `${countryName(data, deathIso)}${migrated ? `（生于${countryName(data, b.country)}）` : ''}`), yearBadge(d.year)),
      row('享年', h('span.g-cert-big', `${d.age ?? state.age} 岁`)),
      row('死因', h('span', d.cause && d.cause.name ? d.cause.name : '—'), d.cause && d.cause.detail ? h('span.g-cert-sub', d.cause.detail) : null),
      row('预期寿命', `出生时 ${le.toFixed(1)} 岁 · 实际 ${d.age ?? state.age} 岁${diffText}`),
      isNum(pct) ? row('同龄排位', `比同年同国出生的 ${Math.round(pct)}% 的人更长寿`) : null,
      worldLabel ? row('世界线', worldLabel) : null),
    d.summary ? h('div.g-cert-remark', h('span.g-cert-remark-k', '备注'), h('p', d.summary)) : null,
    h('footer.g-cert-foot',
      h('span', `签发日期 ${dateText(d.date, d.year)}`),
      h('span', `本证明所载人物及经历均为虚构；${HISTORY_END + 1} 年以后的内容为推演。`)));

  // ------------------------------------------------------------------------------------------------------------
  // actions

  const canCard = typeof cards.deathCard === 'function' && typeof cards.saveBlob === 'function';
  const btnCard = canCard ? h('button.g-btn', { type: 'button', onclick: () => downloadCard() }, '下载死亡证明卡') : null;
  const canPoster = typeof cards.lifePoster === 'function';
  const btnPoster = canPoster ? h('button.g-btn.g-btn--primary', { type: 'button', onclick: (e) => openPoster(e.currentTarget) }, '生成人生长卷 · 分享图') : null;
  let sharedId = sharedMap()[state.id] || (record && record.sharedId) || null;
  const btnShare = typeof store.shareLife === 'function'
    ? h('button.g-btn', { type: 'button', 'aria-expanded': 'false', onclick: () => (sharedId ? goMemorial() : toggleShare(true)) })
    : null;
  const sharePanel = h('div.g-share', { hidden: true, role: 'region', 'aria-label': '分享到追思馆' });
  const btnAgain = h('button.g-btn.g-btn--ink', { type: 'button', onclick: () => app.go('birth', {}) }, '再活一次');
  const btnSame = state.worldSeed != null
    ? h('button.g-btn', { type: 'button', onclick: () => liveAgainSameWorld() }, '沿用这条世界线再活一次')
    : null;
  const actions = h('div.g-death-actions', { role: 'group', 'aria-label': '接下来' },
    btnPoster, btnCard, btnShare, btnAgain, btnSame,
    h('button.g-btn.g-btn--ghost', { type: 'button', onclick: () => app.go('past') }, '前世纪录'),
    h('button.g-btn.g-btn--ghost', { type: 'button', onclick: () => app.go('about') }, '关于数据'));

  function paintShareBtn() {
    if (!btnShare) return;
    btnShare.textContent = sharedId ? '已分享 · 去追思馆看看' : '分享到追思馆';
  }
  paintShareBtn();

  function goMemorial() {
    app.go('memorial', { id: sharedId, lifeId: sharedId });
  }

  function liveAgainSameWorld() {
    try { app.saveSettings?.({ lastWorld: { seed: state.worldSeed, label: worldLabel } }); } catch { /* optional */ }
    app.go('birth', { mode: 'custom', prefill: { keepWorld: true } });
  }

  async function downloadCard() {
    if (!btnCard || btnCard.disabled) return;
    btnCard.disabled = true;
    const label = btnCard.textContent;
    try {
      if (!bio && job) {
        btnCard.textContent = '等待墓志铭完成…';
        await job.promise;
      }
      if (destroyed) return;
      btnCard.textContent = '正在生成…';
      const extra = bio ? { epitaph: bio.epitaph, bio: bio.biography, title: bio.title } : {};
      const fin = finalNote(state);
      if (fin && clean(fin.text).length <= FINAL_ON_CARD) {
        const rest = clean(extra.bio || d.summary || '');
        extra.bio = `你想对${name}说：「${clean(fin.text)}」${rest ? `\n${rest}` : ''}`;
      }
      const blob = await cards.deathCard(state, data, extra);
      const file = typeof cards.cardFileName === 'function' ? cards.cardFileName(state, 'death') : `人生长河-死亡证明-${name}.png`;
      const res = await cards.saveBlob(blob, file);
      if (res && res.ok === false) {
        if (res.status !== 'declined') app.toast?.(res.message || '没能保存这张卡片。', 'warn');
      } else {
        app.toast?.(res && res.status === 'downloaded' ? '死亡证明卡已开始下载' : '死亡证明卡已保存', 'good');
      }
    } catch (e) {
      console.error('[death] card', e);
      app.toast?.('生成卡片时出了点问题，请稍后再试。', 'bad');
    } finally {
      if (btnCard.isConnected) { btnCard.disabled = false; btnCard.textContent = label; }
    }
  }

  // ---- 人生长卷: drawn once, shown in a preview (long-press to save on phones), downloadable --------------------
  let poster = null; // {blob, url}
  const posterImg = h('img.g-poster-img', { alt: `${name}的人生长卷` });
  const posterSave = h('button.g-btn.g-btn--primary', { type: 'button', onclick: () => savePoster() }, '下载图片');
  const posterClose = h('button.g-btn.g-btn--ghost', { type: 'button', onclick: () => closePoster() }, '关闭');
  const posterDlg = h('div.g-poster-ov', { hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': '人生长卷', onclick: (e) => { if (e.target === posterDlg) closePoster(); } },
    h('div.g-poster-box',
      h('p.g-poster-tip', '手机上长按图片即可保存或发给朋友；电脑上点“下载图片”。'),
      h('div.g-poster-frame', posterImg),
      h('div.g-row', posterSave, posterClose)));
  document.body.append(posterDlg);
  let posterFrom = null;
  const onPosterKey = (e) => { if (e.key === 'Escape' && !posterDlg.hidden) closePoster(); };
  document.addEventListener('keydown', onPosterKey);
  offs.push(() => {
    document.removeEventListener('keydown', onPosterKey);
    posterDlg.remove();
    if (poster) { try { URL.revokeObjectURL(poster.url); } catch { /* ignore */ } }
  });

  function posterCards() {
    const ids = [...new Set([...(cardsGot.fresh || []), ...(cardsGot.earned || [])])];
    return ids.map((id) => achievementDef(id)).filter(Boolean);
  }

  async function openPoster(btn) {
    if (!btn || btn.disabled) return;
    posterFrom = btn;
    if (!poster) {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '正在生成…';
      try {
        const blob = await cards.lifePoster(state, data, { title: bio ? bio.title : '', cards: posterCards(), url: cards.shareUrl() });
        if (destroyed) return;
        poster = { blob, url: URL.createObjectURL(blob) };
      } catch (e) {
        console.error('[death] poster', e);
        app.toast?.('生成分享图时出了点问题，请稍后再试。', 'bad');
        return;
      } finally {
        if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      }
    }
    posterImg.src = poster.url;
    posterDlg.hidden = false;
    posterSave.focus();
  }

  function closePoster() {
    posterDlg.hidden = true;
    if (posterFrom && posterFrom.isConnected) posterFrom.focus();
  }

  async function savePoster() {
    if (!poster) return;
    const file = `人生长河-人生长卷-${String(name).replace(/[\\/:*?"<>|\s]+/g, '')}.png`;
    const res = await cards.saveBlob(poster.blob, file);
    if (res && res.ok === false) {
      if (res.status !== 'declined') app.toast?.(res.message || '没能保存这张图，可以长按图片保存。', 'warn');
    } else {
      app.toast?.(res && res.status === 'downloaded' ? '人生长卷已开始下载' : '人生长卷已保存', 'good');
    }
  }

  // ---- share (in-page confirm with a preview of exactly what becomes public) -------------------------------
  function toggleShare(open) {
    sharePanel.hidden = !open;
    if (btnShare) btnShare.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) return;
    renderSharePanel();
    const first = sharePanel.querySelector('button');
    if (first) first.focus();
  }

  /** Exactly what store.shareLife will receive (the archived record with the finished biography merged in). */
  function shareInput() {
    let rec = null;
    try { rec = typeof saves.getPastLife === 'function' ? saves.getPastLife(state.id) : null; } catch { rec = null; }
    const extras = bio ? { epitaph: bio.epitaph, bio: bio.biography, title: bio.title, highlights: bio.highlights } : {};
    return rec ? { ...rec, ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v && (!Array.isArray(v) || v.length))) } : state;
  }

  function renderSharePanel(busy = false) {
    const local = !app.social || app.social.mode !== 'shared';
    let preview = null;
    try { preview = typeof store.buildShareRecord === 'function' ? store.buildShareRecord(shareInput()) : null; } catch { preview = null; }
    const ep = preview ? preview.epitaph : bio ? bio.epitaph : '';
    const bioText = bio ? (preview && preview.bio) || bio.biography : '';
    const highlights = preview && Array.isArray(preview.highlights) ? preview.highlights.filter(Boolean) : [];
    const confirmBtn = h('button.g-btn.g-btn--primary', { type: 'button', disabled: busy, onclick: () => doShare() }, busy ? '正在分享…' : '确认分享');
    clear(sharePanel).append(
      h('h3.g-h3', '分享到追思馆'),
      h('p.g-muted', local
        ? '共享服务目前不可用：这段人生只会保存到这台设备上的“大家的人生”列表里。'
        : '其他玩家将能在追思馆看到下面这些内容，为这段人生点一支蜡烛、留一句话。'),
      h('div.g-share-prev',
        h('p.g-share-name', (preview && preview.name) || name, h('span.g-share-years', ` ${b.year}—${d.year} · 享年 ${d.age} 岁`)),
        h('p.g-share-meta', `${countryName(data, b.country)} · ${d.cause && d.cause.name ? d.cause.name : '—'}`),
        ep ? h('p.g-share-ep', `“${ep}”`) : null,
        bioText ? h('p.g-share-bio', bioText.length > 140 ? `${bioText.slice(0, 140)}…` : bioText) : h('p.g-muted', '传记还在撰写，确认分享时会附上它。'),
        highlights.length ? h('ul.g-share-hl', highlights.map((x) => h('li', x))) : null),
      h('p.g-muted.g-small', '你亲手写下的选择只会显示为「自己写下的选择」，原文不会被分享。'),
      h('div.g-row', confirmBtn, h('button.g-btn.g-btn--ghost', { type: 'button', disabled: busy, onclick: () => { toggleShare(false); if (btnShare) btnShare.focus(); } }, '取消')));
  }

  async function doShare() {
    renderSharePanel(true);
    try {
      if (!bio && job) await job.promise;
      if (destroyed) return;
      const res = await store.shareLife(shareInput());
      if (destroyed) return;
      if (res && res.ok) {
        sharedId = res.lifeId || state.id;
        const m = sharedMap();
        m[state.id] = sharedId;
        storage.set(SHARED_KEY, m);
        try { saves.updatePastLife?.(state.id, { sharedId }); } catch { /* optional */ }
        toggleShare(false);
        paintShareBtn();
        app.toast?.(res.local ? '已保存到本机的“大家的人生”' : '已分享到追思馆', 'good');
        if (btnShare) btnShare.focus();
      } else {
        renderSharePanel(false);
        app.toast?.((res && res.message) || '分享没有成功，请稍后再试。', 'bad');
      }
    } catch (e) {
      console.error('[death] share', e);
      if (!destroyed) {
        renderSharePanel(false);
        app.toast?.('分享没有成功，请稍后再试。', 'bad');
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // the life in numbers

  const countries = [...new Set(history.map((r) => r && r.country).filter(Boolean))];
  if (!countries.length && b.country) countries.push(b.country);
  const realYears = history.filter((r) => r && r.year <= HISTORY_END).length;
  const projYears = history.filter((r) => r && r.year > HISTORY_END).length;
  const decisions = Array.isArray(state.decisions) ? state.decisions : [];
  const customCount = decisions.filter((x) => x && x.custom).length;
  const kids = Array.isArray(p.children) ? p.children.length : 0;
  const m = p.money || {};
  const net = (Number(m.cash) || 0) + Object.values(m.portfolio || {}).reduce((a, v) => a + (Number(v) || 0), 0) - (Number(m.debt) || 0);
  const numbers = h('section.g-panel.g-nums', { 'aria-label': '一生的数字' },
    h('div.g-num', h('span.g-num-v', String(d.age ?? state.age)), h('span.g-num-k', '年'),
      h('span.g-num-s', [realYears ? `${realYears} 年真实历史` : '', projYears ? `${projYears} 年推演的未来` : ''].filter(Boolean).join(' · '))),
    h('div.g-num', h('span.g-num-v', String(countries.length)), h('span.g-num-k', '个国家'),
      h('span.g-num-s', countries.slice(0, 3).map((c) => countryName(data, c)).join('、'))),
    h('div.g-num', h('span.g-num-v', String(decisions.length)), h('span.g-num-k', '个抉择'),
      h('span.g-num-s', customCount ? `其中 ${customCount} 个是自己写下的` : '都在给出的道路里选择')),
    h('div.g-num', h('span.g-num-v', String(kids)), h('span.g-num-k', '个孩子'),
      h('span.g-num-s', `身后财富 ${money(data, deathIso, net)}（按 2021 年物价）`)));

  // ------------------------------------------------------------------------------------------------------------
  // biography + epitaph

  const bioTitle = h('h3.g-bio-title');
  // polite live region, busy while the biography streams in: screen readers announce it once, when it is done
  const bioText = h('div.g-bio-text', { 'aria-live': 'polite', 'aria-busy': bio ? 'false' : 'true' });
  const bioEp = h('figure.g-epitaph', { hidden: true });
  const bioSrc = h('p.g-src');
  const bioBox = h('section.g-panel.g-bio', { 'aria-label': '生平与墓志铭' },
    h('h2.g-h', '生平'), bioTitle, bioText, bioEp, bioSrc);

  function paintBio() {
    if (!bio) {
      bioTitle.hidden = true;
      if (!bioText.firstChild) bioText.append(h('p.g-bio-wait', h('span.g-dots', { 'aria-hidden': 'true' }), '正在为这一生撰写传记…'));
      bioSrc.textContent = '';
      return;
    }
    bioTitle.hidden = !bio.title;
    bioTitle.textContent = bio.title || '';
    clear(bioText).append(...paragraphs(bio.biography));
    bioText.setAttribute('aria-busy', 'false');
    if (bio.epitaph) {
      bioEp.hidden = false;
      clear(bioEp).append(h('blockquote', bio.epitaph), h('figcaption', '墓志铭'));
    } else {
      bioEp.hidden = true;
    }
    bioSrc.textContent = bio.source === 'ai'
      ? '传记由 AI 根据这一生的记录撰写。人物与经历均为虚构，真实历史部分只作背景。'
      : bio.source === 'saved'
        ? '传记写于这一生结束时。人物与经历均为虚构。'
        : '传记由内置引擎根据这一生的记录整理。人物与经历均为虚构。';
  }

  /** Save the whole state again (after the final sentence changed), keeping the biography, date and share id. */
  function rearchive() {
    if (typeof saves.addPastLife !== 'function') return;
    let rec = null;
    try { rec = typeof saves.getPastLife === 'function' ? saves.getPastLife(state.id) : null; } catch { rec = null; }
    const extras = { data };
    if (bio) Object.assign(extras, { epitaph: bio.epitaph || '', bio: bio.biography || '', title: bio.title || '', highlights: Array.isArray(bio.highlights) ? bio.highlights.slice(0, 12) : undefined });
    else if (rec) Object.assign(extras, { epitaph: rec.epitaph, bio: rec.bio, title: rec.title, highlights: rec.highlights });
    if (rec && rec.savedAt) extras.savedAt = rec.savedAt;
    if (sharedId || (rec && rec.sharedId)) extras.sharedId = sharedId || rec.sharedId;
    for (const k of Object.keys(extras)) if (extras[k] === undefined || extras[k] === null) delete extras[k];
    try { saves.addPastLife(state, extras); } catch (e) { console.warn('[death] addPastLife', e); }
    try {
      const again = collection.recordLife(state, { regionOf });
      if (again.fresh.length) {
        cardsGot = { fresh: [...cardsGot.fresh, ...again.fresh], earned: again.earned };
        paintCards();
        const d0 = achievementDef(again.fresh[0]);
        if (d0) app.toast?.(`收集到新卡片：${d0.title}`, 'good');
      }
    } catch (e) { console.warn('[death] cards', e); }
  }

  function archiveBio(r) {
    const patch = { epitaph: r.epitaph || '', bio: r.biography || '', title: r.title || '' };
    if (Array.isArray(r.highlights) && r.highlights.length) patch.highlights = r.highlights.slice(0, 12);
    let ok = null;
    try { ok = typeof saves.updatePastLife === 'function' ? saves.updatePastLife(state.id, patch) : null; } catch { ok = null; }
    if (!ok && typeof saves.addPastLife === 'function') {
      try { saves.addPastLife(state, { ...patch, data, sharedId: sharedId || undefined }); } catch (e) { console.warn('[death] addPastLife', e); }
    }
  }

  if (!bio) {
    job = biographyFor(app, state, world);
    if (job) {
      offs.push(job.subscribe((text) => {
        if (destroyed || bio) return;
        const shown = streamField(text, 'bio') || streamField(text, 'biography');
        if (!shown) return;
        clear(bioText).append(...paragraphs(shown));
        if (bioText.lastChild) bioText.lastChild.append(h('span.g-caret', { 'aria-hidden': 'true' }));
      }));
      job.promise.then((r) => {
        archiveBio(r);
        if (destroyed) return;
        bio = r;
        paintBio();
        if (!sharePanel.hidden) renderSharePanel(false);
      });
    }
  }
  paintBio();

  // ------------------------------------------------------------------------------------------------------------
  // stats over the whole life

  const years = history.map((r) => r.year);
  const statsChart = typeof charts.lineChart === 'function' && history.length >= 2
    ? charts.lineChart(STATS.map((k) => ({
      name: STAT_LABELS[k],
      values: history.map((r) => (r && r.stats ? r.stats[k] : null)),
      color: `var(--st-${k})`,
    })), {
      years, height: 240, projectionFrom: HISTORY_END + 1, yMin: 0, yMax: 100, legend: true, title: '一生的五项指标',
      xFormat: (y) => `${y}`,
    })
    : h('p.g-muted', '这一生太短，没有留下足够的记录。');
  const statsBox = h('section.g-panel.g-dstats', { 'aria-label': '一生的五项指标' },
    h('h2.g-h', '一生的五项指标', h('span.g-h-sub', '2027 年起为推演')), statsChart);

  // ------------------------------------------------------------------------------------------------------------
  // full life map

  const lm = typeof lifemapMod.lifeMap === 'function'
    ? lifemapMod.lifeMap(history, {
      birthYear: b.year, expectedYears: Math.round(le), projectionFrom: HISTORY_END + 1, data, dead: true,
      decisions, countryName: (iso) => countryName(data, iso),
    })
    : null;
  const tagsSeen = [...new Set(history.map((r) => r && r.tag).filter(Boolean))];
  const mapBox = h('section.g-panel.g-dmap', { 'aria-label': '人生地图' },
    h('h2.g-h', '人生地图', h('span.g-h-sub', `每格一年 · ${tagsSeen.length} 种人生主题`)),
    lm || h('p.g-muted', '人生地图暂不可用。'),
    tagsSeen.length && !lm ? h('p.g-muted', tagsSeen.map((t) => YEAR_TAG_LABELS[t] || t).join('、')) : null);

  // ------------------------------------------------------------------------------------------------------------
  // key choices

  const choicesBox = h('section.g-panel.g-choices', { 'aria-label': '关键抉择' },
    h('h2.g-h', '关键抉择', h('span.g-h-sub', `${decisions.length} 个`)),
    decisions.length
      ? h('ol.g-ch-list', decisions.map((x) => h('li.g-ch', { class: x.year > HISTORY_END ? 'g-ch--proj' : '' },
        h('span.g-ch-when', h('span.g-mono', String(x.year ?? '')), ` · ${x.age ?? ''} 岁`),
        h('span.g-ch-main',
          h('span.g-ch-t', x.title || '抉择'),
          h('span.g-ch-c', '→ ', String(x.choice || '')),
          h('span.g-ch-b', x.custom ? badge('自己写下', 'choice') : null, x.source === 'ai' ? badge('AI', 'ai') : null)))))
      : h('p.g-muted', '这一生没有留下抉择记录。'));

  // ------------------------------------------------------------------------------------------------------------
  // what became of the people born in the same second

  const peers = Array.isArray(state.cohort) ? state.cohort.filter(Boolean) : [];
  let cohortBox = null;
  if (peers.length) {
    const lifespan = (pe) => (pe.deathYear != null && isNum(pe.birthYear ?? b.year) ? pe.deathYear - (pe.birthYear ?? b.year) : Infinity);
    const myAge = d.age ?? state.age;
    const rank = 1 + peers.filter((pe) => lifespan(pe) > myAge).length;
    const sorted = peers.slice().sort((a, c) => lifespan(c) - lifespan(a));
    cohortBox = h('section.g-panel.g-dcohort', { 'aria-label': '同一秒出生的人后来怎样了' },
      h('h2.g-h', '同一秒出生的人后来怎样了'),
      h('p.g-cohort-lede', `在与你同一秒出生的 ${peers.length + 1} 个人里，你的寿命排第 ${rank}。`),
      h('ul.g-peers.g-peers--fates', sorted.map((pe) => {
        const span = lifespan(pe);
        const cause = pe.deathCause && typeof pe.deathCause === 'object' ? pe.deathCause.name : pe.deathCause;
        return h('li.g-peer', { class: isFinite(span) ? 'g-peer--gone' : '' },
          h('span.g-peer-av', { 'aria-hidden': 'true' }, String(pe.name || '?').slice(0, 1)),
          h('span.g-peer-main',
            h('span.g-peer-n', pe.name || '无名', h('span.g-peer-sx', pe.sex === 'male' ? '男' : '女')),
            h('span.g-peer-c', `${countryName(data, pe.country)} · ${isFinite(span) ? `${span} 岁离世${cause ? `（${cause}）` : ''}` : '在推演结束时仍然在世'}`),
            pe.fate ? h('span.g-peer-s', pe.fate) : null));
      })),
      h('p.g-src', '他们是按当年各国出生人数抽取的虚构人物，命运由同一套数据与规则推演。'));
  }

  // ------------------------------------------------------------------------------------------------------------
  // the life in a few lines, and the player's real birthplace next to it

  const sum = summaryOf(E, data, world, state);
  const summaryBox = h('section.g-panel.g-recap-sum', { 'aria-labelledby': 'g-recap-t' },
    h('h2.g-h#g-recap-t', '这一生', sum.source === 'engine' ? null : h('span.g-h-sub', '按每一年的记录整理')),
    sum.lines.length
      ? h('ul.g-recap-lines', sum.lines.map((t) => h('li', t)))
      : h('p.g-muted', '这一生太短，还来不及留下更多记录。'));

  const settings = app.settings || {};
  const cmp = compareBirthplace(data, world, state, settings);
  let cmpBox = null;
  if (cmp) {
    cmpBox = h('section.g-panel.g-compare', { 'aria-labelledby': 'g-cmp-t' },
      h('h2.g-h#g-cmp-t', '和你自己的出生地放在一起'),
      h('p.g-cmp-line', cmp.lines[0]),
      h('p.g-cmp-line', cmp.lines[1]),
      h('p.g-cmp-note', cmp.note),
      h('p.g-src', '出生时的预期寿命来自联合国《世界人口展望 2024》', b.year > HISTORY_END ? '；这一生出生在推演年份，那一项来自这条世界线' : '',
        '。你填写的出生地只保存在这个浏览器里。 ',
        h('button.g-link', { type: 'button', onclick: () => app.go('settings', { focus: 'compare' }) }, '修改')));
  } else if (!settings.compareIso) {
    cmpBox = h('section.g-panel.g-compare.g-compare--invite', { 'aria-labelledby': 'g-cmp-t' },
      h('h2.g-h#g-cmp-t', '和你自己的出生地放在一起'),
      h('p.g-muted', '在设置里写下你实际出生的国家或地区（只保存在这台设备上），这里会把那里出生时的预期寿命和这一生并排放着看看。'),
      h('div.g-row', h('button.g-btn', { type: 'button', onclick: () => app.go('settings', { focus: 'compare' }) }, '去填写')));
  }

  // ------------------------------------------------------------------------------------------------------------
  // the last sentence to this person

  const finalBox = h('section.g-panel.g-final', { 'aria-labelledby': 'g-final-t' });
  function paintFinal(editing = false, focus = false) {
    const fin = finalNote(state);
    clear(finalBox).append(h('h2.g-h#g-final-t', FINAL_PROMPT));
    if (fin && !editing) {
      const edit = h('button.g-btn', { type: 'button', onclick: () => paintFinal(true, true) }, '改一改');
      finalBox.append(
        h('figure.g-final-said', h('blockquote', `「${clean(fin.text)}」`), h('figcaption', `写给${name}`)),
        h('p.g-muted.g-small', '这句话和这一生一起保存在这台设备的前世纪录里，不会被分享出去。',
          clean(fin.text).length <= FINAL_ON_CARD ? '下载的死亡证明卡上也会写上它。' : ''),
        h('div.g-row', edit));
      if (focus) edit.focus();
      return;
    }
    const hintId = 'g-final-h';
    const ta = h('textarea.g-final-ta', {
      rows: 3, maxlength: FINAL_MAX, placeholder: '比如：谢谢你认真地活过。', 'aria-labelledby': 'g-final-t', 'aria-describedby': hintId,
    });
    ta.value = fin ? clean(fin.text) : '';
    const count = h('span.g-final-count', { 'aria-hidden': 'true' });
    const paintCount = () => { count.textContent = `${ta.value.length}/${FINAL_MAX}`; };
    const submit = () => {
      const had = !!finalNote(state);
      const saved = setFinalNote(E, state, ta.value);
      rearchive();
      if (!saved && had) app.toast?.('已删去这句话。', 'info');
      paintFinal(false, true);
      if (!saved) { const t = finalBox.querySelector('textarea'); if (t) t.focus(); }
    };
    ta.addEventListener('input', paintCount);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    paintCount();
    finalBox.append(
      h('p.g-muted.g-small', { id: hintId }, `一句话就好，最多 ${FINAL_MAX} 个字。只保存在这台设备上，不会被分享；${FINAL_ON_CARD} 个字以内的话也会写在下载的死亡证明卡上。`),
      ta,
      h('div.g-row.g-final-row',
        h('button.g-btn.g-btn--primary', { type: 'button', onclick: submit }, fin ? '保存' : '留下这句话'),
        fin ? h('button.g-btn.g-btn--ghost', { type: 'button', onclick: () => paintFinal(false, true) }, '算了') : null,
        count));
    if (focus) ta.focus();
  }
  paintFinal(false, false);

  // ------------------------------------------------------------------------------------------------------------
  // starred moments, notes written along the way

  const stars = starredMoments(state);
  const starsBox = h('section.g-panel.g-stars', { 'aria-labelledby': 'g-stars-t' },
    h('h2.g-h#g-stars-t', h('span', h('span.g-star-mark', { 'aria-hidden': 'true' }, '★ '), '值得记住的时刻'), stars.length ? h('span.g-h-sub', `${stars.length} 个`) : null),
    stars.length
      ? h('ol.g-stars-list', stars.map((e) => h('li.g-star', { class: e.year > HISTORY_END ? 'g-star--proj' : '' },
        h('span.g-star-when', h('span.g-mono', String(e.year ?? '')), isNum(e.age) ? ` · ${e.age} 岁` : ''),
        h('p.g-star-t', clean(e.text)))))
      : h('p.g-muted', '这一生没有标记值得记住的时刻。下一次，可以在人生记录里点一下 ☆，把想留住的那一刻标出来（最多 12 个）。'));

  const notes = lifeNotes(state);
  const notesBox = notes.length
    ? h('section.g-panel.g-notes', { 'aria-labelledby': 'g-notes-t' },
      h('h2.g-h#g-notes-t', '一路上写下的话', h('span.g-h-sub', `${notes.length} 段`)),
      h('ol.g-notes-list', notes.map((n) => h('li.g-note',
        h('p.g-note-q', h('span.g-mono', isNum(n.age) ? `${n.age} 岁` : ''), clean(n.prompt) ? ` · ${clean(n.prompt)}` : n.kind === 'reflection' ? ' · 停下来想一想' : ' · 随手写下'),
        h('blockquote.g-note-t', clean(n.text))))),
      h('p.g-src', '这些是你在这一生里亲手写下的，只保存在这台设备上。'))
    : null;

  // ------------------------------------------------------------------------------------------------------------
  // what became of the children, rare moments

  const kidLines = childrenLines(E, data, world, state);
  const kidsBox = kidLines.length
    ? h('section.g-panel.g-kids', { 'aria-labelledby': 'g-kids-t' },
      h('h2.g-h#g-kids-t', '子女们的人生', h('span.g-h-sub', `${kidLines.length} 个孩子`)),
      h('ul.g-peers.g-peers--fates', kidLines.map((k) => h('li.g-peer',
        h('span.g-peer-av', { 'aria-hidden': 'true' }, k.name.slice(0, 1)),
        h('span.g-peer-main',
          h('span.g-peer-n', k.name, h('span.g-peer-sx', [k.sex === 'female' ? '女' : k.sex === 'male' ? '男' : '', k.birthYear ? `${k.birthYear} 年生` : ''].filter(Boolean).join(' · '))),
          h('span.g-peer-s', k.line))))),
      h('p.g-src', '孩子们后来的人生，按他们所在国家和年代的数据推演；人物都是虚构的。'))
    : null;

  const rare = (Array.isArray(state.rare) ? state.rare : []).filter((r) => r && clean(r.title));
  const rareBox = h('section.g-panel.g-rare', { 'aria-labelledby': 'g-rare-t' },
    h('h2.g-h#g-rare-t', '稀有的际遇', rare.length ? h('span.g-h-sub', `${rare.length} 个`) : null),
    rare.length
      ? [h('ul.g-rare-list', rare.map((r) => h('li.g-rare-i',
        h('span.g-rare-mark', { 'aria-hidden': 'true' }, '✦'),
        h('span.g-rare-main', h('span.g-rare-t', clean(r.title)),
          h('span.g-rare-w', [isNum(r.year) ? `${r.year} 年` : '', isNum(r.age) ? `${r.age} 岁` : ''].filter(Boolean).join(' · ')))))),
      h('p.g-src', '这样的事在现实中极少发生，出现的机会参照真实世界的频率：大约几十段人生里才有一段会遇到。')]
      : h('p.g-muted', '这一生没有遇到稀有的际遇。现实里，大约几十个人里才有一个会遇到。'));

  // ------------------------------------------------------------------------------------------------------------
  // achievement cards earned by this life

  const cardsBox = h('section.g-panel.g-cards', { 'aria-labelledby': 'g-cards-t' });
  function paintCards() {
    clear(cardsBox);
    const fresh = new Set(cardsGot.fresh);
    const view = new Map(collection.collectionView().map((d) => [d.id, d]));
    const ids = [...cardsGot.fresh.filter((id) => !cardsGot.earned.includes(id)), ...cardsGot.earned];
    const defs = ids.map((id) => view.get(id) || achievementDef(id)).filter(Boolean)
      .sort((a, b) => (fresh.has(b.id) - fresh.has(a.id)) || (['SSR', 'SR', 'R', 'N'].indexOf(a.tier) - ['SSR', 'SR', 'R', 'N'].indexOf(b.tier)));
    cardsBox.append(
      h('h2.g-h#g-cards-t', '这一生收集到的卡片', h('span.g-h-sub', fresh.size ? `${defs.length} 张 · 新收集 ${fresh.size} 张` : `${defs.length} 张`)),
      defs.length
        ? h('div.ac-tiles', defs.map((d, i) => {
          const el = cardTile(d, { fresh: fresh.has(d.id), onOpen: () => app.go('album', { focus: d.id }) });
          el.setAttribute('style', `--i: ${Math.min(i, 12)}`);
          return el;
        }))
        : h('p.g-muted', '这一生没有收集到卡片。'),
      h('div.g-row', h('button.g-btn', { type: 'button', onclick: () => app.go('album') }, '打开成就图鉴')));
  }
  paintCards();

  // ------------------------------------------------------------------------------------------------------------
  // assemble

  const page = h('div.g-death',
    cert,
    actions,
    sharePanel,
    cardsBox,
    numbers,
    h('div.g-recap', { class: cmpBox ? '' : 'g-recap--one' }, summaryBox, cmpBox),
    h('div.g-death-grid',
      h('div.g-death-main', bioBox, finalBox,
        h('section.g-panel.g-realmem', { 'aria-label': '你自己的真实回忆' },
          h('p.g-realmem-k', '这段人生是推演出来的。你自己的人生里，有没有一个值得留下的瞬间？'),
          h('div.g-realmem-a',
            h('button.g-btn.g-btn--primary', { type: 'button', onclick: () => app.go('stories', { compose: true }) }, '写下一段真实回忆'),
            h('button.g-link', { type: 'button', onclick: (e) => { const sec = e.currentTarget.closest('.g-realmem'); if (sec) sec.hidden = true; } }, '跳过'))),
        starsBox, notesBox, statsBox, mapBox),
      h('div.g-death-side', choicesBox, kidsBox, rareBox, cohortBox)),
    h('div.g-death-end',
      h('p.g-death-end-t', '每一段人生都值得被认真记住。'),
      h('div.g-row', canPoster ? h('button.g-btn.g-btn--primary', { type: 'button', onclick: (e) => openPoster(e.currentTarget) }, '生成人生长卷') : null,
        btnCard ? h('button.g-btn', { type: 'button', onclick: () => downloadCard() }, '下载死亡证明卡') : null,
        h('button.g-btn.g-btn--ink', { type: 'button', onclick: () => app.go('birth', {}) }, '再活一次'))));
  root.append(page);
  if (!reducedMotion()) {
    cert.classList.add('g-cert--enter');
    requestAnimationFrame(() => cert.classList.add('g-cert--in'));
  }

  return () => {
    destroyed = true;
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
  };
}

