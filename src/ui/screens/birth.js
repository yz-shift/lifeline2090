// Birth: the random flow (a short, skippable registering sequence, then the 出生登记卡) and the custom-birth form
// (year 2000–2070, searchable country picker, sex, urban/rural, family wealth, parents' education, free-text 特殊出身
// that the AI can read, "沿用上一条世界线"). Both end on the same registration card built from real data for the
// birth year: life expectancy, infant mortality, GDP per capita, internet use, and the same-second cohort.

import { h, clear, fmt, storage, reducedMotion } from '../dom.js';
import { FIRST_YEAR, HISTORY_END, LAST_YEAR, DATA_DATE, REGIONS } from '../../core/constants.js';
import { Rng, newSeed } from '../../core/rng.js';
import * as personMod from '../../core/person.js';
import * as worldMod from '../../core/world.js';
import * as cohortMod from '../../core/cohort.js';
import * as economyMod from '../../core/economy.js';
import * as saves from '../../social/saves.js';
import * as cards from '../cards.js';
import * as director from '../../ai/director.js';

const BIRTH_MIN = FIRST_YEAR;
const BIRTH_MAX = 2070;
const DRAFT_KEY = 'll2090.customDraft';
const SEX_LABEL = { male: '男', female: '女' };
const PARENT_EDU = { none: '未受正规教育', primary: '小学', secondary: '中学', tertiary: '大学及以上' };
const WEALTH = [
  { label: '贫困', sub: '全国收入最低的 20%', band: [0.02, 0.19] },
  { label: '偏低', sub: '20%–40%', band: [0.21, 0.39] },
  { label: '中等', sub: '40%–60%', band: [0.41, 0.59] },
  { label: '宽裕', sub: '60%–80%', band: [0.61, 0.79] },
  { label: '富裕', sub: '最高的 20%', band: [0.81, 0.985] },
];
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// ---------------------------------------------------------------- small helpers

const cname = (data, iso) => data.countries?.[iso]?.name || iso || '未知';
const isNum = (v) => typeof v === 'number' && isFinite(v);

export function familyWords(p) {
  if (!isNum(p)) return '—';
  if (p < 0.1) return '全国最贫困的一成家庭';
  if (p < 0.25) return '收入偏低的家庭';
  if (p < 0.45) return '中等偏下的家庭';
  if (p < 0.6) return '中等收入家庭';
  if (p < 0.8) return '中等偏上的家庭';
  if (p < 0.95) return '富裕家庭';
  if (p < 0.99) return '全国最富裕的 5% 家庭';
  return '全国最富裕的 1% 家庭';
}

export function familyShort(p) {
  if (!isNum(p)) return '家境不详';
  return ['贫困家庭', '家境偏低', '家境中等', '家境宽裕', '富裕家庭'][Math.min(4, Math.max(0, Math.floor(p * 5)))];
}

function dateWords(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return String(date || '—');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${y} 年 ${mo} 月 ${d} 日 · ${wd}${time ? ' · ' + time : ''}`;
}

function safe(fn, fallback = null) {
  try { const v = fn(); return v == null ? fallback : v; } catch { return fallback; }
}

/** indicator for the birth year: world line (scenario-aware) first, data series as fallback */
function indicatorGetter(data, world, year) {
  return (iso, key) => {
    let v = null;
    if (world && typeof world.indicator === 'function') v = safe(() => world.indicator(iso, key, year));
    if (!isNum(v)) v = safe(() => data.series(iso, key, year));
    return isNum(v) ? Number(v) : null;
  };
}

function lifeExpGetter(data, world, year, get) {
  return (iso, sex) => {
    let v = null;
    if (world && typeof world.lifeExpectancy === 'function') v = safe(() => world.lifeExpectancy(iso, year, sex));
    if (!isNum(v)) v = get(iso, sex === 'female' ? 'le_f' : sex === 'male' ? 'le_m' : 'le');
    if (!isNum(v)) v = get(iso, 'le');
    return isNum(v) ? v : null;
  };
}

/** share of the world's newborns that year born in a country whose value is lower than v */
function newbornShareBelow(isos, births, fn, v) {
  if (!isNum(v)) return null;
  let below = 0, tot = 0;
  for (const c of isos) {
    const b = births.get(c);
    if (!b) continue;
    const x = fn(c);
    if (!isNum(x)) continue;
    tot += b;
    if (x < v) below += b;
    else if (x === v) below += b / 2;
  }
  return tot > 0 ? below / tot : null;
}

export function birthFacts(data, world, spec) {
  const y = spec.year;
  const iso = spec.country;
  const sex = spec.sex === 'female' ? 'female' : 'male';
  const get = indicatorGetter(data, world, y);
  const leOf = lifeExpGetter(data, world, y, get);
  const isos = data.isoList || Object.keys(data.countries || {});
  const births = new Map();
  let totalBirths = 0;
  for (const c of isos) {
    const b = safe(() => data.series(c, 'births', y), 0) || 0;
    births.set(c, b);
    totalBirths += b;
  }
  const facts = [];
  const le = leOf(iso, sex);
  if (isNum(le)) {
    const p = newbornShareBelow(isos, births, (c) => leOf(c, sex), le);
    facts.push({ key: 'le', label: `出生时预期寿命（${SEX_LABEL[sex]}）`, value: le.toFixed(1), unit: '岁', meter: p,
      note: p == null ? '' : `全球 ${Math.round(p * 100)}% 的新生儿出生在预期寿命更短的地方` });
  }
  const imr = get(iso, 'imr');
  if (isNum(imr)) {
    const below = newbornShareBelow(isos, births, (c) => get(c, 'imr'), imr);
    const p = below == null ? null : 1 - below;
    facts.push({ key: 'imr', label: '婴儿死亡率', value: imr < 10 ? imr.toFixed(1) : imr.toFixed(0), unit: '‰', meter: p,
      note: `每千名活产婴儿中约 ${imr < 10 ? imr.toFixed(1) : Math.round(imr)} 名活不到一岁` + (p == null ? '' : `；全球 ${Math.round(p * 100)}% 的新生儿出生在比这里更高的地方`) });
  }
  const gdp = get(iso, 'gdp_pc_ppp');
  if (isNum(gdp)) {
    const p = newbornShareBelow(isos, births, (c) => get(c, 'gdp_pc_ppp'), gdp);
    let local = '';
    if (typeof economyMod.formatMoney === 'function') {
      const s = safe(() => economyMod.formatMoney(data, iso, gdp), '');
      if (s && typeof s === 'string') local = `约合 ${s}（按2021年物价）`;
    }
    facts.push({ key: 'gdp', label: '人均 GDP（购买力平价）', value: fmt.int(gdp), unit: '国际元', meter: p,
      note: [local, p == null ? '' : `全球 ${Math.round(p * 100)}% 的新生儿出生在更穷的地方`].filter(Boolean).join('；') });
  }
  const net = get(iso, 'internet');
  if (isNum(net)) {
    const p = newbornShareBelow(isos, births, (c) => get(c, 'internet'), net);
    facts.push({ key: 'internet', label: '互联网使用率', value: net.toFixed(net < 10 ? 1 : 0), unit: '%', meter: p,
      note: p == null ? '' : `全球 ${Math.round(p * 100)}% 的新生儿出生在上网比例更低的地方` });
  }
  const b = births.get(iso);
  if (b && totalBirths) {
    const share = b / totalBirths;
    facts.push({ key: 'births', label: `${y} 年本国出生人数`, value: fmt.cn(b * 1000), unit: '人', meter: null,
      note: `占全球 ${fmt.cn(totalBirths * 1000)} 名新生儿的 ${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%` });
  }
  // source label
  const c = data.countries?.[iso] || {};
  const notes = [];
  if (y > HISTORY_END) notes.push(`${y} 年的数字是推演值：联合国中方案与世界银行趋势外推，再叠加本局世界线`);
  else {
    const lag = [['gdp_pc_ppp', '人均 GDP'], ['internet', '互联网使用率']]
      .map(([k, label]) => (c.lastObs && isNum(c.lastObs[k]) && c.lastObs[k] < y ? `${label}在 ${c.lastObs[k]} 年后为外推估计` : ''))
      .filter(Boolean);
    notes.push(...lag);
    if (y === HISTORY_END) notes.push(`2026 年人口数字为联合国 2024 年版的估计，数据截至 ${DATA_DATE}`);
  }
  const imputed = Array.isArray(c.imputed) ? c.imputed.filter((k) => ['gdp_pc_ppp', 'internet'].includes(k)) : [];
  if (imputed.length) notes.push('部分指标缺少本国统计，以所在地区中位数填补');
  return { facts, le, notes, totalBirths };
}

/** Clean a parsed custom birth (AI or offline parser) into the fields this form understands. -> object | null */
export function normalizeParsed(raw, data) {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw.fields && typeof raw.fields === 'object' ? { ...raw, ...raw.fields } : raw;
  const out = {};
  const y = Math.round(Number(src.year));
  if (y >= BIRTH_MIN && y <= BIRTH_MAX) out.year = y;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(src.date || ''));
  if (dm && out.year === Number(dm[1])) {
    const d = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])));
    if (d.getUTCMonth() === Number(dm[2]) - 1 && d.getUTCDate() === Number(dm[3])) out.date = String(src.date);
  }
  if (out.date && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(String(src.time || ''))) out.time = String(src.time);
  if (typeof src.nameLatin === 'string' && src.nameLatin.trim()) out.nameLatin = src.nameLatin.trim().slice(0, 40);
  const c = String(src.country || '').toUpperCase();
  if (c && data.countries?.[c]) out.country = c;
  if (src.sex === 'male' || src.sex === 'female') out.sex = src.sex;
  if (typeof src.urban === 'boolean') out.urban = src.urban;
  const fp = Number(src.familyPct);
  if (src.familyPct != null && isFinite(fp)) out.familyPct = Math.min(0.995, Math.max(0.005, fp));
  if (PARENT_EDU[src.parentsEdu]) out.parentsEdu = src.parentsEdu;
  const sib = Math.round(Number(src.siblings));
  if (src.siblings != null && sib >= 0 && sib <= 15) out.siblings = sib;
  const ma = Math.round(Number(src.motherAge));
  if (src.motherAge != null && ma >= 14 && ma <= 55) out.motherAge = ma;
  const fa = Math.round(Number(src.fatherAge));
  if (src.fatherAge != null && fa >= 15 && fa <= 80) out.fatherAge = fa;
  if (typeof src.name === 'string' && src.name.trim()) out.name = src.name.trim().slice(0, 24);
  const notes = Array.isArray(src.notes) ? src.notes : typeof src.notes === 'string' ? [src.notes] : [];
  out.notes = notes.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 140)).slice(0, 4);
  const summary = [src.summary, src.understood, src.note].find((x) => typeof x === 'string' && x.trim());
  if (summary) out.summary = summary.trim().slice(0, 240);
  const keys = Object.keys(out).filter((k) => k !== 'notes' && k !== 'summary');
  if (!keys.length && !out.notes.length && !out.summary) return null;
  return out;
}

function understoodChips(data, p) {
  const chips = [];
  if (p.date) {
    const [, mo, d] = p.date.split('-').map(Number);
    chips.push(`${p.year} 年 ${mo} 月 ${d} 日`);
  } else if (p.year) chips.push(`${p.year} 年`);
  if (p.country) chips.push(cname(data, p.country));
  if (p.sex) chips.push(SEX_LABEL[p.sex]);
  if (p.urban != null) chips.push(p.urban ? '城市' : '农村');
  if (p.familyPct != null) chips.push(familyShort(p.familyPct));
  if (p.parentsEdu) chips.push(`父母：${PARENT_EDU[p.parentsEdu]}`);
  if (p.siblings != null) chips.push(p.siblings ? `${p.siblings} 个兄弟姐妹` : '独生');
  if (p.motherAge) chips.push(`母亲 ${p.motherAge} 岁`);
  if (p.fatherAge) chips.push(`父亲 ${p.fatherAge} 岁`);
  if (p.name) chips.push(`名字：${p.name}`);
  return chips;
}

// ---------------------------------------------------------------- screen

export function mount(root, params, app) {
  const { data } = app;
  let alive = true;
  const timers = new Set();
  const disposers = [];
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); return t; };
  const mode = params.mode === 'custom' ? 'custom' : 'random';
  const yearMode = ['2000', 'history', 'now', 'future', 'any'].includes(String(params.yearMode)) ? String(params.yearMode) : '2000';

  const aiUsable = () => !!(app.ai && app.ai.available && app.settings.aiMode !== 'off' && typeof director.parseCustomBirth === 'function');

  // ------------------------------------------------ errors
  function showError(e, retry) {
    console.error(e);
    clear(root).append(h('div.ll-doc.ll-errdoc', { role: 'alert' },
      h('p.ll-eyebrow', '登记未完成'),
      h('h1.ll-h2', '这次出生登记没有成功'),
      h('p.ll-muted', '生成出生信息时出错了。可以再试一次，或者回到首页。'),
      h('pre.ll-errdoc-detail', String(e?.message || e).slice(0, 300)),
      h('div.ll-actions',
        h('button.ll-btn.ll-btn--ink', { type: 'button', onclick: retry }, '再试一次'),
        h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => app.go('home') }, '回到首页'))));
  }

  // ------------------------------------------------ life creation
  function makeLife(kind, input, keepWorldSeed) {
    const worldSeed = keepWorldSeed != null ? keepWorldSeed : newSeed();
    const world = worldMod.createWorld(data, worldSeed);
    const rng = new Rng(newSeed());
    const spec = kind === 'custom'
      ? personMod.customBirth(data, world, rng, input)
      : personMod.randomBirth(data, world, rng, { yearMode });
    let state = null;
    let prepError = null;
    try { state = app.prepareLife(spec, { world }).state; } catch (e) { prepError = e; console.error(e); }
    return { spec: (state && state.birth) || spec, state, world, prepError };
  }

  // ------------------------------------------------ registering sequence (random flow)
  function playRegistering(ctx, { short = false } = {}) {
    return new Promise((resolve) => {
      if (reducedMotion()) { resolve(); return; }
      const spec = ctx.spec;
      const y = spec.year;
      const isos = data.isoList || Object.keys(data.countries || {});
      const weighted = isos
        .map((c) => [c, safe(() => data.series(c, 'births', y), 0) || 0])
        .filter((x) => x[1] > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 80);
      const tot = weighted.reduce((s, x) => s + x[1], 0);
      const pickName = () => {
        let r = Math.random() * tot;
        for (const [c, w] of weighted) { r -= w; if (r <= 0) return cname(data, c); }
        return cname(data, spec.country);
      };
      let finished = false;
      const lines = h('ol.ll-reg-anim-lines');
      const flick = h('span.ll-reg-anim-flick', pickName());
      const skipBtn = h('button.ll-btn.ll-btn--ghost.ll-btn--small', { type: 'button', onclick: () => finish() }, '跳过');
      const panel = h('section.ll-reg-anim.ll-doc', { 'aria-live': 'polite', 'aria-label': '正在登记出生' },
        h('div.ll-reg-anim-head',
          h('div', h('p.ll-eyebrow', '人生长河档案馆'), h('h1.ll-reg-anim-title', '出生登记中')),
          skipBtn),
        lines,
        h('p.ll-reg-anim-hint', '点击、按回车或 Esc 即可跳过'));
      const onKey = (e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); }
      };
      const onClick = (e) => { if (e.target !== skipBtn) finish(); };
      document.addEventListener('keydown', onKey);
      panel.addEventListener('click', onClick);
      clear(root).append(panel);
      requestAnimationFrame(() => skipBtn.focus({ preventScroll: true }));
      let flickTimer = 0;
      function finish() {
        if (finished) return;
        finished = true;
        clearInterval(flickTimer);
        document.removeEventListener('keydown', onKey);
        panel.removeEventListener('click', onClick);
        resolve();
      }
      disposers.push(() => { finished = true; clearInterval(flickTimer); document.removeEventListener('keydown', onKey); });
      const add = (k, v, cls = '') => lines.appendChild(h('li.ll-reg-anim-line' + cls, h('span.ll-reg-anim-k', k), v));
      const scale = short ? 0.45 : 1;
      add(`调阅 ${y} 年全球出生记录`, h('span.ll-reg-anim-v', `${fmt.cn(tot * 1000)} 名新生儿`));
      later(() => {
        add('按各国出生人数抽签', flick, '.is-live');
        flickTimer = setInterval(() => { flick.textContent = pickName(); }, 70);
        timers.add(flickTimer);
      }, 380 * scale);
      later(() => {
        clearInterval(flickTimer);
        flick.textContent = cname(data, spec.country);
        flick.classList.add('is-set');
      }, 1300 * scale);
      later(() => add('分配家庭与城乡', h('span.ll-reg-anim-v', `${spec.urban ? '城市' : '农村'} · ${familyShort(spec.familyPct)}`)), 1600 * scale);
      later(() => add('编制档案号', h('span.ll-reg-anim-v.ll-num', app.archiveNo(ctx.state || spec))), 1900 * scale);
      later(() => finish(), 2450 * scale);
    });
  }

  // ------------------------------------------------ the registration card
  function renderCard(ctx) {
    const { spec, state, world } = ctx;
    const y = spec.year;
    const iso = spec.country;
    const country = data.countries?.[iso] || {};
    const sex = spec.sex === 'female' ? 'female' : 'male';
    const proj = y > HISTORY_END;
    const facts = birthFacts(data, world, spec);
    const no = app.archiveNo(state || spec);
    const name = state?.person?.name || spec.name || '（未命名）';

    // identity rows
    const parentsAges = [spec.motherAge ? `母亲 ${spec.motherAge} 岁` : '', spec.fatherAge ? `父亲 ${spec.fatherAge} 岁` : ''].filter(Boolean).join(' · ');
    const rows = [
      ['性别', SEX_LABEL[sex]],
      ['出生时间', h('span.ll-num', dateWords(spec.date, spec.time))],
      ['出生地', h('span', cname(data, iso), h('span.ll-reg-en', ` ${country.en || ''} · ${iso}`))],
      ['所在地区', REGIONS[country.region] || country.subregion || '—'],
      ['城乡', (spec.urban ? '城市' : '农村') + (spec.city ? ` · ${spec.city}` : '')],
      ['家庭经济', h('span', familyWords(spec.familyPct),
        isNum(spec.familyPct) ? h('span.ll-reg-sub', `比全国约 ${Math.round(spec.familyPct * 100)}% 的家庭宽裕`) : null)],
      ['父母受教育程度', PARENT_EDU[spec.parentsEdu] || '—'],
      ['兄弟姐妹', isNum(spec.siblings) ? (spec.siblings ? `${spec.siblings} 人` : '无') : '—'],
      parentsAges ? ['父母年龄', parentsAges] : null,
      ['登记方式', spec.mode === 'custom' || ctx.mode === 'custom' ? '自定义出生' : '随机出生（按真实出生分布）'],
    ].filter(Boolean);
    const notes = Array.isArray(spec.notes) ? spec.notes.filter((n) => typeof n === 'string' && n.trim()) : [];
    const customText = spec.customText || ctx.input?.customText || '';

    const fieldList = h('dl.ll-reg-fields', rows.map(([k, v]) => h('div.ll-reg-row', h('dt', k), h('dd', v))));
    if (customText) fieldList.appendChild(h('div.ll-reg-row.ll-reg-row--wide', h('dt', '特殊出身'), h('dd.ll-reg-quote', customText)));
    const extraNotes = notes.filter((n) => n !== customText);
    if (extraNotes.length) fieldList.appendChild(h('div.ll-reg-row.ll-reg-row--wide', h('dt', '备注'), h('dd', h('ul.ll-reg-notes', extraNotes.map((n) => h('li', n))))));
    if (ctx.ai && ctx.ai.chips && ctx.ai.chips.length) {
      fieldList.appendChild(h('div.ll-reg-row.ll-reg-row--wide', h('dt', ctx.ai.source === 'ai' ? 'AI 的理解' : '从特殊出身读到'),
        h('dd', h('ul.ll-chips', ctx.ai.chips.map((c) => h('li.ll-chip', c))), ctx.ai.summary ? h('p.ll-reg-sub', ctx.ai.summary) : null)));
    }

    // facts
    const factsSection = h('section.ll-reg-facts' + (proj ? '.is-proj' : ''), { 'aria-labelledby': 'll-reg-facts-t' },
      h('h3#ll-reg-facts-t.ll-reg-h', `${y} 年的${cname(data, iso)}`, app.ui.yearBadge(y, { short: true })),
      facts.facts.length
        ? h('ul.ll-facts', facts.facts.map((f) => h('li.ll-fact',
          h('p.ll-fact-label', f.label),
          h('p.ll-fact-value', h('span.ll-num', f.value), h('span.ll-fact-unit', f.unit)),
          f.meter != null ? h('div.ll-meter', { role: 'img', 'aria-label': `全球新生儿中的位置：${Math.round(f.meter * 100)}%` },
            h('span.ll-meter-fill', { style: { width: `${Math.max(1.5, f.meter * 100).toFixed(1)}%` } })) : null,
          f.note ? h('p.ll-fact-note', f.note) : null)))
        : h('p.ll-muted', '这一年这里缺少可用的统计数据。'),
      h('p.ll-source',
        h('span.ll-source-k', '来源'),
        '联合国《世界人口展望 2024》（中方案）；世界银行《世界发展指标》',
        facts.notes.length ? h('span.ll-source-note', '。' + facts.notes.join('；') + '。') : '。'));

    // lifespan on the year grid
    let spanSection = null;
    if (isNum(facts.le)) {
      const y1 = Math.round(y + facts.le);
      const realYears = y > HISTORY_END ? 0 : Math.max(0, Math.min(y1, HISTORY_END) - y + 1);
      const projYears = Math.max(0, y1 - Math.max(y, HISTORY_END + 1) + 1);
      const to = Math.max(2100, Math.min(2140, y1));
      const ruler = app.ui.yearRuler({ from: FIRST_YEAR, to, span: [y, Math.min(y1, to)], marker: y, size: 'span',
        ticks: [FIRST_YEAR, HISTORY_END, LAST_YEAR, to].filter((v, i, a) => a.indexOf(v) === i),
        label: `预期一生：${y}–${y1} 年` });
      spanSection = h('section.ll-reg-span', { 'aria-labelledby': 'll-reg-span-t' },
        h('h3#ll-reg-span-t.ll-reg-h', '这一生大约会经过的年份'),
        ruler,
        h('p.ll-reg-span-text',
          `按 ${y} 年${cname(data, iso)}${SEX_LABEL[sex]}婴儿的预期寿命 ${facts.le.toFixed(0)} 岁估算，这一生大约从 ${y} 年延续到 ${y1} 年：`,
          realYears > 0
            ? h('span', h('b.ll-real-ink', `约 ${realYears} 年是真实历史`), '，', h('b.ll-proj-ink', `约 ${projYears} 年是推演`), '。')
            : h('span', h('b.ll-proj-ink', '整段人生都在推演的世界线里'), '。'),
          '实际能活多久，取决于运气、家境、选择和这条世界线。'));
    }

    // world line
    const dims = Array.isArray(world?.dims) ? world.dims : [];
    const worldSection = h('details.ll-reg-world',
      h('summary', h('span.ll-reg-world-k', '本局世界线'), h('span.ll-reg-world-v', world?.label || state?.worldLabel || '基线推演')),
      h('div.ll-reg-world-body',
        world?.description ? h('p', world.description) : null,
        dims.length
          ? h('ul.ll-reg-dims', dims.map((d) => h('li',
            h('span.ll-reg-dim-k', d.title || d.id),
            h('span.ll-reg-dim-v', d.branch?.title || '—'),
            isNum(d.branch?.prob) ? h('span.ll-reg-dim-p', `概率 ${Math.round(d.branch.prob * 100)}%`) : null)))
          : h('p.ll-muted', '推演维度仍在整理中，本局使用联合国中方案的基线世界。'),
        h('p.ll-reg-sub', `世界线只影响 ${HISTORY_END + 1} 年以后；在那之前，所有人经历的都是同一段真实历史。`)));

    // cohort
    let peers = Array.isArray(state?.cohort) ? state.cohort : [];
    if (!peers.length && !state && typeof cohortMod.makeCohort === 'function') {
      peers = safe(() => cohortMod.makeCohort(data, world, spec, new Rng(newSeed())), []) || [];
    }
    let cohortSection = null;
    if (peers.length) {
      const nCountries = new Set(peers.map((p) => p.country)).size;
      cohortSection = h('section.ll-reg-cohort', { 'aria-labelledby': 'll-reg-cohort-t' },
        h('h3#ll-reg-cohort-t.ll-reg-h', `同一秒出生的另外 ${peers.length} 人`),
        h('p.ll-reg-sub', `他们和你在同一秒降生在 ${nCountries} 个国家和地区。你会在人生的各个阶段看到他们的近况。`),
        h('ol.ll-cohort', peers.slice(0, 12).map((p) => h('li.ll-cohort-item',
          h('span.ll-cohort-name', p.name || '—'),
          h('span.ll-cohort-meta', [SEX_LABEL[p.sex] || '', cname(data, p.country), familyShort(p.familyPct)].filter(Boolean).join(' · '))))),
        peers.length > 12 ? h('p.ll-reg-sub', `以及另外 ${peers.length - 12} 人。`) : null);
    }

    // actions
    const startBtn = h('button.ll-btn.ll-btn--ink.ll-btn--big', { type: 'button', onclick: () => begin() }, '开始这一生');
    const rerollBtn = h('button.ll-btn.ll-btn--line', { type: 'button', onclick: () => reroll() }, ctx.mode === 'custom' ? '同样条件再登记一次' : '换一个出生');
    const editBtn = ctx.mode === 'custom' ? h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => renderForm() }, '修改条件') : null;
    const shareBtn = h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => share() }, '分享出生卡');

    async function begin() {
      startBtn.disabled = true;
      try {
        const cur = app.getLife();
        let other = cur && !cur.dead && app.controller && (!state || cur.id !== state.id) ? cur : null;
        if (!other && !app.controller) {
          const saved = await Promise.resolve(safe(() => saves.loadCurrent?.()));
          if (saved && typeof saved === 'object' && saved.birth && !saved.dead && (!state || saved.id !== state.id)) other = saved;
        }
        if (other) {
          const ok = await app.confirm({
            title: '开始新的人生？',
            body: `${other.person?.name || other.birth?.name || '上一段人生'} 还没有结束（${other.age ?? 0} 岁，${other.year ?? ''} 年）。开始新的人生后，那份自动存档会被这一生替换。`,
            ok: '开始新的人生', cancel: '再想想',
          });
          if (!ok || !alive) return;
        }
        app.startLife(spec, state ? { state, world } : { world });
      } finally {
        if (alive) startBtn.disabled = false;
      }
    }

    async function share() {
      if (typeof cards.birthCard !== 'function') { app.toast('分享卡片暂不可用', 'warn'); return; }
      shareBtn.disabled = true;
      const label = shareBtn.textContent;
      shareBtn.textContent = '正在生成…';
      try {
        const life = state || { birth: spec, seed: null, person: { name, sex, country: iso } };
        const blob = await cards.birthCard(life, data);
        if (!blob) throw new Error('卡片没有生成');
        const filename = typeof cards.cardFileName === 'function' ? cards.cardFileName(life, 'birth') : `出生登记卡-${no}.png`;
        const r = typeof cards.saveBlob === 'function' ? await cards.saveBlob(blob, filename) : null;
        if (!alive) return;
        if (r && r.ok) app.toast(r.status === 'downloaded' ? '出生登记卡已开始下载' : '出生登记卡已保存', 'good');
        else if (r && r.status === 'declined') app.toast('已取消保存出生卡', 'info');
        else app.toast((r && r.message) || '当前环境不支持下载文件', 'warn');
      } catch (e) {
        console.error(e);
        app.toast('出生卡生成失败：' + (e?.message || '未知错误'), 'bad');
      } finally {
        if (alive) { shareBtn.disabled = false; shareBtn.textContent = label; }
      }
    }

    const card = h('article.ll-doc.ll-reg' + (proj ? '.is-proj' : '') + (reducedMotion() ? '' : '.ll-reg--stamp'), { 'aria-labelledby': 'll-reg-name' },
      h('header.ll-reg-head',
        h('div.ll-reg-head-l',
          h('p.ll-eyebrow', '人生长河档案馆 · 出生登记'),
          h('h1.ll-reg-title', '出生登记卡')),
        h('div.ll-reg-head-r',
          h('p.ll-reg-no-k', '档案号'),
          h('p.ll-reg-no', no),
          app.ui.yearBadge(y))),
      h('div.ll-reg-body',
        h('div.ll-reg-id',
          h('div.ll-reg-namebox',
            h('div.ll-reg-seal', { 'aria-hidden': 'true' }, h('span.ll-reg-seal-a', '已登记'), h('span.ll-reg-seal-b', String(y))),
            h('p.ll-reg-name-k', '姓名'),
            h('h2#ll-reg-name.ll-reg-name', name),
            spec.nameLatin ? h('p.ll-reg-latin', spec.nameLatin) : null),
          fieldList),
        h('div.ll-reg-data', factsSection, spanSection)),
      worldSection,
      cohortSection,
      ctx.prepError ? h('p.ll-reg-warn', '人生引擎初始化时出错，开始这一生时会重新尝试。') : null);

    const bar = h('div.ll-reg-bar', h('div.ll-reg-bar-in', startBtn, rerollBtn, editBtn, shareBtn));
    clear(root).append(card, bar);
    window.scrollTo(0, 0);
    requestAnimationFrame(() => { if (alive) startBtn.focus({ preventScroll: true }); });
  }

  // ------------------------------------------------ random flow
  let lastCtx = null;
  async function runRandom({ short = false } = {}) {
    let ctx;
    try {
      ctx = { ...makeLife('random'), mode: 'random' };
    } catch (e) {
      showError(e, () => runRandom());
      return;
    }
    lastCtx = ctx;
    await playRegistering(ctx, { short });
    if (!alive || lastCtx !== ctx) return;
    renderCard(ctx);
  }

  function reroll() {
    if (lastCtx && lastCtx.mode === 'custom') submitCustom(lastCtx.input, lastCtx.ai, true);
    else runRandom({ short: true });
  }

  // ------------------------------------------------ custom form
  const draft = storage.get(DRAFT_KEY, null);
  const form = {
    year: 2000, yearRandom: false, country: null, sex: 'random', urban: 'random', wealth: 'random', parentsEdu: 'random',
    name: '', text: '', keepWorld: false, familyPct: null, siblings: null, motherAge: null, fatherAge: null,
    ...(draft && typeof draft === 'object' ? draft : {}),
    ...(params.prefill && typeof params.prefill === 'object' ? params.prefill : {}),
  };
  if (!(form.year >= BIRTH_MIN && form.year <= BIRTH_MAX)) form.year = 2000;
  if (form.country && !data.countries?.[form.country]) form.country = null;
  const touched = new Set();
  const aiFields = new Set();
  let aiResult = null;       // { chips, summary, notes } from the last successful parse
  let aiState = 'idle';      // idle | busy | done | failed
  let parsedText = '';
  const saveDraft = () => storage.set(DRAFT_KEY, form);

  function collectInput() {
    const input = { mode: 'custom' };
    if (!form.yearRandom) input.year = form.year;
    if (form.country) input.country = form.country;
    if (form.sex === 'male' || form.sex === 'female') input.sex = form.sex;
    if (form.urban === 'urban' || form.urban === 'rural') input.urban = form.urban === 'urban';
    if (isNum(form.familyPct)) input.familyPct = form.familyPct;
    else if (form.wealth !== 'random' && WEALTH[form.wealth]) {
      const [a, b] = WEALTH[form.wealth].band;
      input.familyPct = Math.round((a + (b - a) * Math.random()) * 1000) / 1000;
    }
    if (PARENT_EDU[form.parentsEdu]) input.parentsEdu = form.parentsEdu;
    if (isNum(form.siblings)) input.siblings = form.siblings;
    if (isNum(form.motherAge)) input.motherAge = form.motherAge;
    if (isNum(form.fatherAge)) input.fatherAge = form.fatherAge;
    const nm = String(form.name || '').trim().slice(0, 24);
    if (nm) input.name = nm;
    const text = String(form.text || '').trim();
    if (text) {
      input.customText = text;
      const extra = aiResult && parsedText === text ? aiResult.notes || [] : [];
      input.notes = [text, ...extra].slice(0, 5);
    }
    // an exact birth date / time / romanised name read from the text, kept only while the form still agrees with it
    const p = aiResult && parsedText === text ? aiResult.parsed || null : null;
    if (p && p.date && !form.yearRandom && form.year === p.year) {
      input.date = p.date;
      if (p.time) input.time = p.time;
    }
    if (p && p.nameLatin && nm && nm === p.name) input.nameLatin = p.nameLatin;
    return input;
  }

  const aiTag = () => h('span.ll-ai-tag', { title: aiResult && aiResult.source === 'ai' ? '由 AI 根据特殊出身填写' : '根据特殊出身的文字填写' },
    aiResult && aiResult.source !== 'ai' ? '解析' : 'AI');

  function applyParsed(p) {
    const set = (key, apply) => { if (!touched.has(key)) { apply(); aiFields.add(key); } };
    if (p.year != null) set('year', () => { form.year = p.year; form.yearRandom = false; });
    if (p.country) set('country', () => { form.country = p.country; });
    if (p.sex) set('sex', () => { form.sex = p.sex; });
    if (p.urban != null) set('urban', () => { form.urban = p.urban ? 'urban' : 'rural'; });
    if (p.familyPct != null) set('wealth', () => { form.familyPct = p.familyPct; form.wealth = Math.min(4, Math.floor(p.familyPct * 5)); });
    if (p.parentsEdu) set('parentsEdu', () => { form.parentsEdu = p.parentsEdu; });
    if (p.siblings != null) { form.siblings = p.siblings; aiFields.add('siblings'); }
    if (p.motherAge != null) { form.motherAge = p.motherAge; aiFields.add('motherAge'); }
    if (p.fatherAge != null) { form.fatherAge = p.fatherAge; aiFields.add('fatherAge'); }
    if (p.name) set('name', () => { form.name = p.name; });
    saveDraft();
  }

  async function parseText({ rerender = true } = {}) {
    const text = String(form.text || '').trim();
    if (!text || !aiUsable()) return null;
    aiState = 'busy';
    if (rerender) updateAiBox();
    let parsed = null;
    let source = 'ai';
    try {
      const opts = { aiMode: app.settings.aiMode };
      let raw;
      if (typeof director.parseCustomBirthDetailed === 'function') {
        const r = await director.parseCustomBirthDetailed(text, data, opts);
        raw = r && r.spec;
        source = r && r.source === 'ai' ? 'ai' : 'local';
      } else {
        raw = await director.parseCustomBirth(text, data, opts);
      }
      parsed = normalizeParsed(raw, data);
    } catch (e) {
      console.error(e);
      parsed = null;
    }
    if (!alive) return null;
    parsedText = text;
    if (parsed) {
      applyParsed(parsed);
      aiResult = { chips: understoodChips(data, parsed), summary: parsed.summary || '', notes: parsed.notes || [], source, parsed };
      aiState = 'done';
    } else {
      aiResult = null;
      aiState = 'failed';
    }
    return parsed;
  }

  let aiBox = null;
  let formEls = null;

  function updateAiBox() {
    if (!aiBox) return;
    clear(aiBox);
    if (!aiUsable()) {
      aiBox.append(h('p.ll-ai-note',
        app.settings.aiMode === 'off'
          ? 'AI 推演已关闭，这段文字会作为备注记入出生登记卡。可以在设置里开启 AI，让它读懂这段描述并填好上面的条件。'
          : 'AI 暂不可用，这段文字会作为备注记入出生登记卡。'));
      return;
    }
    const btn = h('button.ll-btn.ll-btn--line.ll-btn--small', {
      type: 'button',
      disabled: aiState === 'busy' || !String(form.text || '').trim(),
      onclick: async () => {
        await parseText();
        if (!alive) return;
        renderForm({ focusAi: true });
        if (aiState === 'failed') app.toast('AI 没能读懂这段描述，它会作为备注保留', 'warn');
      },
    }, aiState === 'busy' ? '正在解读…' : '让 AI 解读这段描述');
    aiBox.append(h('div.ll-ai-row', btn, h('p.ll-ai-note', '解读会使用你自己的 Claude 用量。AI 只填写你没有动过的条件，填好后仍可修改。')));
    if (aiState === 'done' && aiResult) {
      aiBox.append(h('div.ll-ai-result', { tabindex: '-1' },
        h('p.ll-ai-k', aiResult.source === 'ai' ? 'AI 的理解' : 'AI 这次没有回应，以下是内置解析从文字里读到的条件'),
        aiResult.chips.length ? h('ul.ll-chips', aiResult.chips.map((c) => h('li.ll-chip.ll-chip--ai', c))) : null,
        aiResult.summary ? h('p.ll-ai-summary', aiResult.summary) : null,
        aiResult.notes.length ? h('ul.ll-ai-notes', aiResult.notes.map((n) => h('li', n))) : null));
    } else if (aiState === 'failed') {
      aiBox.append(h('p.ll-ai-note.is-warn', { tabindex: '-1' }, '这次没能解读成功。登记时这段文字会作为备注保留。'));
    }
  }

  function countryPicker() {
    const items = (data.isoList || Object.keys(data.countries || {})).map((iso) => {
      const c = data.countries[iso] || {};
      return { iso, name: c.name || iso, en: c.en || '', lower: (c.en || '').toLowerCase() };
    });
    const birthsFor = (iso) => safe(() => data.series(iso, 'births', form.yearRandom ? 2026 : form.year), 0) || 0;
    let active = -1;
    let results = [];
    const input = h('input#ll-c-country.ll-input', {
      type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false',
      'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'll-c-country-list',
      placeholder: '输入中文名、英文名或代码：巴西 / Brazil / BRA',
    });
    const list = h('ul#ll-c-country-list.ll-combo-list', { role: 'listbox', hidden: true, 'aria-label': '国家和地区' });
    const chosen = h('div.ll-combo-chosen');
    function paintChosen() {
      clear(chosen);
      if (form.country) {
        const c = data.countries[form.country] || {};
        chosen.append(
          h('span.ll-combo-pick', h('b', c.name || form.country), h('span.ll-combo-en', ` ${c.en || ''} · ${form.country}`),
            aiFields.has('country') ? aiTag() : null),
          h('button.ll-btn.ll-btn--ghost.ll-btn--small', {
            type: 'button', onclick: () => { form.country = null; touched.add('country'); aiFields.delete('country'); saveDraft(); paintChosen(); input.focus(); },
          }, '改为随机'));
      } else {
        chosen.append(h('span.ll-combo-pick.is-random', '随机：按当年各国出生人数抽取'));
      }
    }
    function search(q) {
      q = q.trim();
      const ql = q.toLowerCase();
      let r;
      if (!q) {
        r = items.map((it) => ({ it, score: 3, b: birthsFor(it.iso) }));
      } else {
        r = [];
        for (const it of items) {
          let score = -1;
          if (it.iso.toLowerCase() === ql) score = 0;
          else if (it.name.startsWith(q) || it.lower.startsWith(ql)) score = 1;
          else if (it.name.includes(q) || it.lower.includes(ql) || it.iso.toLowerCase().startsWith(ql)) score = 2;
          if (score >= 0) r.push({ it, score, b: birthsFor(it.iso) });
        }
      }
      r.sort((a, b) => a.score - b.score || b.b - a.b);
      return r.slice(0, 10);
    }
    const total = () => {
      let t = 0;
      for (const it of items) t += birthsFor(it.iso);
      return t;
    };
    function open(q) {
      results = search(q);
      const tot = total() || 1;
      active = results.length ? 0 : -1;
      clear(list);
      if (!results.length) {
        list.append(h('li.ll-combo-empty', { role: 'option', 'aria-disabled': 'true' }, '没有找到。试试中文全称、英文名或三位代码。'));
      }
      results.forEach((r, i) => {
        const id = `ll-c-opt-${r.it.iso}`;
        list.append(h('li.ll-combo-opt', {
          id, role: 'option', 'aria-selected': i === active ? 'true' : 'false',
          onmousedown: (e) => { e.preventDefault(); pick(r.it.iso); },
        },
        h('span.ll-combo-opt-name', r.it.name),
        h('span.ll-combo-opt-en', `${r.it.en} · ${r.it.iso}`),
        r.b ? h('span.ll-combo-opt-share', `占新生儿 ${((r.b / tot) * 100).toFixed(r.b / tot < 0.01 ? 2 : 1)}%`) : null));
      });
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight();
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function highlight() {
      Array.from(list.children).forEach((li, i) => li.setAttribute('aria-selected', i === active ? 'true' : 'false'));
      const li = list.children[active];
      if (li && li.id) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); }
    }
    function pick(iso) {
      form.country = iso;
      touched.add('country');
      aiFields.delete('country');
      saveDraft();
      input.value = '';
      close();
      paintChosen();
    }
    input.addEventListener('input', () => open(input.value));
    input.addEventListener('focus', () => open(input.value));
    input.addEventListener('blur', () => close());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(input.value); else { active = Math.min(results.length - 1, active + 1); highlight(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); highlight(); }
      else if (e.key === 'Enter') { if (!list.hidden && results[active]) { e.preventDefault(); pick(results[active].it.iso); } }
      else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } }
    });
    paintChosen();
    return h('div.ll-field',
      h('label.ll-label', { for: 'll-c-country' }, '国家或地区'),
      chosen,
      h('div.ll-combo', input, list),
      h('p.ll-hint', `共 ${items.length} 个国家和地区。不选则按当年真实出生人数随机。`));
  }

  function yearField() {
    const ruler = app.ui.yearRuler({ from: BIRTH_MIN, to: BIRTH_MAX, marker: form.yearRandom ? null : form.year, size: 'mini',
      ticks: [2000, 2026, 2050, 2070], label: '出生年份' });
    const num = h('input#ll-c-year.ll-input.ll-input--year', { type: 'number', min: BIRTH_MIN, max: BIRTH_MAX, step: 1, inputmode: 'numeric', value: form.year, disabled: form.yearRandom });
    const range = h('input#ll-c-year-range.ll-range', { type: 'range', min: BIRTH_MIN, max: BIRTH_MAX, step: 1, value: form.year, disabled: form.yearRandom, 'aria-label': '出生年份滑块' });
    const badgeSlot = h('span.ll-year-badge');
    const note = h('p.ll-hint');
    const paint = () => {
      clear(badgeSlot).append(form.yearRandom ? h('span.ll-badge', '随机') : app.ui.yearBadge(form.year));
      note.textContent = form.yearRandom
        ? '在 2000–2070 年间按全球出生人数随机抽取。'
        : form.year <= HISTORY_END
          ? `${form.year} 年是真实历史：出生时的国家数据和世界大事都是真实的，${HISTORY_END + 1} 年以后进入推演。`
          : `${form.year} 年属于推演：出生时的世界来自本局世界线，数据基于联合国中方案和当前趋势。`;
      ruler.setMarker(form.yearRandom ? null : form.year);
    };
    const setYear = (v, from) => {
      const y = Math.min(BIRTH_MAX, Math.max(BIRTH_MIN, Math.round(Number(v) || 2000)));
      form.year = y;
      touched.add('year');
      aiFields.delete('year');
      if (from !== num) num.value = y;
      if (from !== range) range.value = y;
      saveDraft();
      paint();
    };
    range.addEventListener('input', () => setYear(range.value, range));
    num.addEventListener('change', () => setYear(num.value, num));
    const rand = app.ui.switchField({
      id: 'll-c-year-rand', label: '随机年份', checked: form.yearRandom,
      onChange: (on) => { form.yearRandom = on; touched.add('year'); num.disabled = on; range.disabled = on; saveDraft(); paint(); },
    });
    paint();
    return h('div.ll-field.ll-field--year',
      h('div.ll-field-head', h('label.ll-label', { for: 'll-c-year' }, '出生年份'), badgeSlot,
        aiFields.has('year') ? aiTag() : null),
      h('div.ll-year-row', num, rand),
      h('div.ll-year-scale', ruler, range),
      note);
  }

  function renderForm({ focusAi = false } = {}) {
    lastCtx = null;
    const tagged = (label, key) => (aiFields.has(key) ? [label, ' ', aiTag()] : label);
    const sexG = app.ui.boxGroup({
      id: 'll-c-sex', legend: tagged('性别', 'sex'), value: form.sex, compact: true,
      options: [{ value: 'random', label: '随机' }, { value: 'male', label: '男' }, { value: 'female', label: '女' }],
      onChange: (v) => { form.sex = v; touched.add('sex'); aiFields.delete('sex'); saveDraft(); },
    });
    const urbanG = app.ui.boxGroup({
      id: 'll-c-urban', legend: tagged('城乡', 'urban'), value: form.urban, compact: true,
      options: [{ value: 'random', label: '随机' }, { value: 'urban', label: '城市' }, { value: 'rural', label: '农村' }],
      onChange: (v) => { form.urban = v; touched.add('urban'); aiFields.delete('urban'); saveDraft(); },
    });
    const wealthG = app.ui.boxGroup({
      id: 'll-c-wealth', legend: tagged('家境', 'wealth'), value: form.wealth, compact: true,
      hint: '按本国家庭收入的五等分。',
      options: [{ value: 'random', label: '随机' }, ...WEALTH.map((w, i) => ({ value: i, label: w.label, sub: w.sub }))],
      onChange: (v) => { form.wealth = v === 'random' ? 'random' : Number(v); form.familyPct = null; touched.add('wealth'); aiFields.delete('wealth'); saveDraft(); },
    });
    const eduG = app.ui.boxGroup({
      id: 'll-c-edu', legend: tagged('父母受教育程度', 'parentsEdu'), value: form.parentsEdu, compact: true,
      options: [{ value: 'random', label: '随机' }, ...Object.entries(PARENT_EDU).map(([k, v]) => ({ value: k, label: v }))],
      onChange: (v) => { form.parentsEdu = v; touched.add('parentsEdu'); aiFields.delete('parentsEdu'); saveDraft(); },
    });
    const nameInput = h('input#ll-c-name.ll-input', { type: 'text', maxlength: 24, value: form.name || '', placeholder: '留空则按当地常见名字生成', autocomplete: 'off' });
    nameInput.addEventListener('input', () => { form.name = nameInput.value; touched.add('name'); aiFields.delete('name'); saveDraft(); });
    const text = h('textarea#ll-c-text.ll-textarea', {
      rows: 4, maxlength: 400,
      placeholder: '例如：生在内蒙古草原上的牧民家庭，父亲是兽医，家里有三个孩子。\n或者：2041 年出生在因海平面上升而搬迁的孟加拉沿海家庭。',
    });
    text.value = form.text || '';
    const counter = h('span.ll-count.ll-num', `${text.value.length} / 400`);
    text.addEventListener('input', () => {
      form.text = text.value;
      counter.textContent = `${text.value.length} / 400`;
      if (aiState !== 'busy') { aiState = parsedText && parsedText === text.value.trim() ? aiState : 'idle'; }
      saveDraft();
      updateAiBox();
    });
    aiBox = h('div.ll-ai-box', { 'aria-live': 'polite' });
    updateAiBox();
    const last = app.settings.lastWorld;
    const keep = app.ui.switchField({
      id: 'll-c-keepworld', label: '沿用上一条世界线', checked: !!(form.keepWorld && last), disabled: !last,
      sub: last ? `上一局：${last.label || '未命名的世界线'}。${HISTORY_END + 1} 年以后的世界会和上一局一样。` : '还没有上一条世界线。开始过一次人生后即可沿用。',
      onChange: (on) => { form.keepWorld = on; saveDraft(); },
    });
    const submitBtn = h('button.ll-btn.ll-btn--ink.ll-btn--big', { type: 'submit' }, '登记出生');
    const resetBtn = h('button.ll-btn.ll-btn--ghost', {
      type: 'button',
      onclick: () => {
        Object.assign(form, { year: 2000, yearRandom: false, country: null, sex: 'random', urban: 'random', wealth: 'random', parentsEdu: 'random', name: '', text: '', keepWorld: false, familyPct: null, siblings: null, motherAge: null, fatherAge: null });
        touched.clear(); aiFields.clear(); aiResult = null; aiState = 'idle'; parsedText = '';
        saveDraft();
        renderForm();
      },
    }, '全部重置');
    const formEl = h('form.ll-form', {
      id: 'll-custom-form', novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        try {
          const t = String(form.text || '').trim();
          if (t && aiUsable() && parsedText !== t) {
            submitBtn.textContent = 'AI 正在解读特殊出身…';
            await parseText({ rerender: false });
            if (!alive) return;
          }
          const input = collectInput();
          const keepSeed = form.keepWorld && app.settings.lastWorld ? app.settings.lastWorld.seed : null;
          submitCustom(input, aiState === 'done' ? aiResult : null, false, keepSeed);
        } finally {
          if (alive && submitBtn.isConnected) { submitBtn.disabled = false; submitBtn.textContent = '登记出生'; }
        }
      },
    },
    h('div.ll-form-head',
      h('p.ll-eyebrow', '表 A-02'),
      h('h1.ll-h1', '自定义出生'),
      h('p.ll-lede', '你可以指定任何一项，也可以全部留给随机。没有指定的部分仍按当年、当地的真实分布生成。')),
    h('div.ll-form-grid',
      h('div.ll-form-col', yearField(), countryPicker(), sexG, urbanG),
      h('div.ll-form-col', wealthG, eduG,
        h('div.ll-field', h('label.ll-label', { for: 'll-c-name' }, tagged('姓名（可选）', 'name')), nameInput))),
    h('div.ll-field.ll-field--text',
      h('div.ll-field-head', h('label.ll-label', { for: 'll-c-text' }, '特殊出身（可选）'), counter),
      h('p.ll-hint', '用一段话描述出身：地方、家庭、职业、处境都可以。AI 会读懂它，并在之后的人生里记得。'),
      text,
      aiBox),
    h('div.ll-field', keep),
    h('div.ll-form-actions', submitBtn, resetBtn,
      h('button.ll-btn.ll-btn--ghost', { type: 'button', onclick: () => app.go('home') }, '取消')));
    formEls = { formEl, submitBtn };
    clear(root).append(formEl);
    if (focusAi) requestAnimationFrame(() => aiBox?.querySelector('[tabindex="-1"]')?.focus());
  }

  function submitCustom(input, ai, reroll, keepSeed) {
    let ctx;
    const seed = keepSeed != null ? keepSeed : (reroll && lastCtx?.keepSeed != null ? lastCtx.keepSeed : null);
    try {
      // re-draw the wealth position inside its band on every registration
      const fresh = { ...input };
      if (reroll && form.familyPct == null && form.wealth !== 'random' && WEALTH[form.wealth]) {
        const [a, b] = WEALTH[form.wealth].band;
        fresh.familyPct = Math.round((a + (b - a) * Math.random()) * 1000) / 1000;
      }
      ctx = { ...makeLife('custom', fresh, seed), mode: 'custom', input: fresh, ai, keepSeed: seed };
    } catch (e) {
      showError(e, () => renderForm());
      return;
    }
    lastCtx = ctx;
    renderCard(ctx);
  }

  // ------------------------------------------------ go
  if (mode === 'custom') renderForm();
  else runRandom();

  return () => {
    alive = false;
    timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    timers.clear();
    disposers.forEach((f) => { try { f(); } catch { /* ignore */ } });
    if (formEls) saveDraft();
  };
}
