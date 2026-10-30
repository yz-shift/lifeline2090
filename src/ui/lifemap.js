// Life map: one cell per lived year, rows of ten years of age. Lived cells take the colour of the year's dominant
// tag (var(--tag-<tag>)); projected years (>= projectionFrom) carry a hatch and dashed outline; years not yet lived
// are hollow up to the expected lifespan. Cells are keyboard and tap selectable and show year / age / headline.
//
//   lifeMap(history, {birthYear, expectedYears, projectionFrom = 2027, onSelect, decisions, countryName, data,
//                     selected, legend = true, detail = true, compact = false, dead})
//   -> HTMLElement with .update(history, patch?) and .select(year)

import { h, clear } from './dom.js';
import { YEAR_TAGS, YEAR_TAG_LABELS, STATS, STAT_LABELS, HISTORY_END } from '../core/constants.js';

const MOOD_LABELS = { '-2': '艰难', '-1': '低落', '0': '平稳', '1': '顺遂', '2': '明亮' };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const tagOf = (t) => (YEAR_TAGS.includes(t) ? t : 'calm');

function normalise(history, birthYearHint) {
  const byAge = new Map();
  for (const r of Array.isArray(history) ? history : []) {
    if (!r || !isNum(Number(r.year))) continue;
    const year = Number(r.year);
    const age = isNum(Number(r.age)) && r.age !== null && r.age !== '' ? Math.round(Number(r.age)) : (isNum(birthYearHint) ? year - birthYearHint : null);
    if (age == null || age < 0 || age > 130) continue;
    byAge.set(age, { ...r, year, age, tag: tagOf(r.tag) });
  }
  return [...byAge.values()].sort((a, b) => a.age - b.age);
}

/**
 * @param {Array<{year, age, stats, tag, mood, country, headline}>} history
 * @param {object} opts see file header
 */
export function lifeMap(history = [], opts = {}) {
  const o = { ...(opts && typeof opts === 'object' ? opts : {}) };
  // explicit `undefined` from callers must not switch defaults off
  const fixOpts = () => {
    const pf = o.projectionFrom == null || o.projectionFrom === '' ? NaN : Number(o.projectionFrom);
    o.projectionFrom = isNum(pf) ? pf : HISTORY_END + 1;
    o.legend = o.legend !== false;
    o.detail = o.detail !== false;
  };
  fixOpts();
  const root = h('div.c-lm', { role: 'group', 'aria-label': '人生地图：每一格是一年，每行十年' });
  if (o.compact) root.classList.add('is-compact');
  const gridWrap = h('div.c-lm-gridwrap');
  const legendEl = h('div.c-lm-legend', { 'aria-label': '图例' });
  const detailEl = h('div.c-lm-detail', { 'aria-live': 'polite' });
  root.append(gridWrap);
  let rows = [];
  let selectedAge = null;
  let buttons = new Map(); // age -> button

  const birthYearOf = () => {
    if (isNum(Number(o.birthYear)) && o.birthYear != null) return Number(o.birthYear);
    const r = rows[0];
    return r ? r.year - r.age : HISTORY_END;
  };
  const countryLabel = (iso) => {
    if (!iso) return '';
    try {
      if (typeof o.countryName === 'function') return o.countryName(iso) || iso;
      const c = o.data?.country?.(iso) || o.data?.countries?.[iso];
      return c?.name || iso;
    } catch { return iso; }
  };
  const decisionYears = () => {
    const set = new Set();
    for (const d of Array.isArray(o.decisions) ? o.decisions : []) if (d && isNum(Number(d.year))) set.add(Number(d.year));
    return set;
  };

  function describe(r, isProj) {
    const parts = [`${r.year} 年`, `${r.age} 岁`, YEAR_TAG_LABELS[r.tag] || ''];
    if (isProj) parts.push('推演年份');
    let t = parts.filter(Boolean).join('，');
    if (r.headline) t += `：${r.headline}`;
    return t;
  }

  function renderDetail(r) {
    clear(detailEl);
    if (!o.detail) return;
    if (!r) {
      detailEl.append(h('p.c-lm-hint', rows.length ? '点选任意一格，回看那一年的你。' : '出生之后，这里会一格一格地长出你的人生。'));
      return;
    }
    const isProj = r.year >= o.projectionFrom;
    const head = h('div.c-lm-dhead',
      h('span.c-lm-dyear.c-mono', String(r.year)),
      h('span.c-lm-dage', `${r.age} 岁`),
      h('span.c-lm-dtag', { style: `--cell: var(--tag-${r.tag})` }, h('i.c-lm-sw', { 'aria-hidden': 'true' }), YEAR_TAG_LABELS[r.tag] || r.tag),
      h(`span.c-badge.${isProj ? 'c-badge-proj' : 'c-badge-real'}`, isProj ? '推演' : '真实历史'),
    );
    const text = h('p.c-lm-dtext', r.headline ? String(r.headline) : (r.tag === 'calm' ? '平静的一年，日子照常流过。' : `这一年的主题：${YEAR_TAG_LABELS[r.tag] || '生活'}。`));
    const meta = [];
    const cn = countryLabel(r.country);
    if (cn) meta.push(cn);
    if (isNum(Number(r.mood)) && r.mood != null) meta.push(`心境${MOOD_LABELS[String(Math.max(-2, Math.min(2, Math.round(Number(r.mood)))))]}`);
    const statsEl = r.stats && typeof r.stats === 'object'
      ? h('ul.c-lm-stats', STATS.filter((k) => isNum(Number(r.stats[k])) && r.stats[k] != null).map((k) => h('li', { style: `--st: var(--st-${k})` },
        h('span.c-lm-stl', STAT_LABELS[k]),
        h('span.c-lm-stbar', { 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(0, Math.min(100, Number(r.stats[k])))}%` } })),
        h('span.c-lm-stv.c-mono', String(Math.round(Number(r.stats[k])))))))
      : null;
    detailEl.append(head, text, meta.length ? h('p.c-lm-dmeta', meta.join(' · ')) : null, statsEl);
  }

  function select(age, { focus = false, silent = false } = {}) {
    const r = rows.find((x) => x.age === age);
    if (!r) return;
    selectedAge = age;
    for (const [a, b] of buttons) {
      b.setAttribute('aria-pressed', a === age ? 'true' : 'false');
      b.tabIndex = a === age ? 0 : -1;
    }
    const btn = buttons.get(age);
    if (focus && btn) btn.focus();
    renderDetail(r);
    if (!silent && typeof o.onSelect === 'function') {
      try { o.onSelect(r); } catch (e) { console.error('lifeMap onSelect', e); }
    }
  }

  function render() {
    clear(gridWrap);
    buttons = new Map();
    const birthYear = birthYearOf();
    const lastAge = rows.length ? rows[rows.length - 1].age : -1;
    const dead = o.dead != null ? !!o.dead : rows.length > 0 && rows[rows.length - 1].tag === 'death';
    const expected = isNum(Number(o.expectedYears)) && o.expectedYears != null ? Math.max(0, Math.round(Number(o.expectedYears))) : 0;
    const maxAge = dead ? Math.max(lastAge, 0) : Math.max(lastAge, expected - 1, 9);
    const nRows = Math.floor(maxAge / 10) + 1;
    const byAge = new Map(rows.map((r) => [r.age, r]));
    const choices = decisionYears();
    const projFrom = o.projectionFrom;
    let anyProj = false, anyFuture = false, anyChoice = false;

    const futureCount = !dead ? Math.max(0, expected - 1 - lastAge) : 0;
    const gridLabel = `人生地图：已记录 ${rows.length} 年${futureCount ? `，尚有约 ${futureCount} 年未到来` : ''}。用方向键移动，回车查看。`;
    const grid = h('div.c-lm-grid', { role: 'group', 'aria-label': gridLabel });
    grid.append(h('div.c-lm-corner', { 'aria-hidden': 'true' }));
    for (let c = 0; c < 10; c++) grid.append(h('div.c-lm-colhead.c-mono', { 'aria-hidden': 'true' }, `+${c}`));
    for (let ri = 0; ri < nRows; ri++) {
      const a0 = ri * 10;
      const row = h('div.c-lm-row');
      row.append(h('div.c-lm-rowlab', { 'aria-hidden': 'true' },
        h('span.c-lm-rl-age', `${a0}–${a0 + 9}岁`),
        h('span.c-lm-rl-year.c-mono', String(birthYear + a0))));
      for (let c = 0; c < 10; c++) {
        const age = a0 + c;
        const year = birthYear + age;
        const isProj = year >= projFrom;
        const r = byAge.get(age);
        let cell;
        if (r) {
          const cls = ['c-lm-cell', 'is-lived', `t-${r.tag}`];
          if (isProj) { cls.push('is-proj'); anyProj = true; }
          if (!dead && age === lastAge) cls.push('is-now');
          if (choices.has(r.year)) { cls.push('is-choice'); anyChoice = true; }
          cell = h('button', {
            type: 'button', class: cls.join(' '), tabIndex: -1,
            style: `--cell: var(--tag-${r.tag})`,
            'aria-label': describe(r, isProj) + (choices.has(r.year) ? '，这一年做出了抉择' : ''),
            'aria-pressed': 'false', title: describe(r, isProj),
            dataset: { age: String(age), year: String(r.year) },
            onclick: () => select(age),
          });
          buttons.set(age, cell);
        } else if (age < lastAge) {
          cell = h('span.c-lm-cell.is-gap', { 'aria-hidden': 'true', title: `${year} 年 · ${age} 岁 · 无记录` });
        } else if (!dead && age > lastAge && age < expected) {
          cell = h(`span.c-lm-cell.is-future${isProj ? '.is-proj' : ''}`, { 'aria-hidden': 'true', title: `${year} 年 · ${age} 岁 · 尚未到来` });
          anyFuture = true;
          if (isProj) anyProj = true;
        } else {
          cell = h('span.c-lm-cell.is-void', { 'aria-hidden': 'true' });
        }
        row.append(cell);
      }
      grid.append(row);
    }
    grid.addEventListener('keydown', onKey);
    gridWrap.append(grid);

    // roving tab stop: selected cell, else the latest lived year
    const stop = selectedAge != null && buttons.has(selectedAge) ? selectedAge : lastAge;
    if (buttons.has(stop)) buttons.get(stop).tabIndex = 0;
    if (selectedAge != null && buttons.has(selectedAge)) buttons.get(selectedAge).setAttribute('aria-pressed', 'true');

    if (o.legend) {
      clear(legendEl);
      const present = YEAR_TAGS.filter((t) => rows.some((r) => r.tag === t));
      for (const t of present) {
        legendEl.append(h('span.c-lm-key', { style: `--cell: var(--tag-${t})` }, h('i.c-lm-sw', { 'aria-hidden': 'true' }), YEAR_TAG_LABELS[t]));
      }
      if (anyProj) legendEl.append(h('span.c-lm-key.is-proj-key', h('i.c-lm-sw', { 'aria-hidden': 'true' }), `推演年份（${projFrom} 起）`));
      if (anyFuture) legendEl.append(h('span.c-lm-key.is-future-key', h('i.c-lm-sw', { 'aria-hidden': 'true' }), '尚未到来'));
      if (anyChoice) legendEl.append(h('span.c-lm-key.is-choice-key', h('i.c-lm-sw', { 'aria-hidden': 'true' }), '做出抉择'));
      if (!legendEl.parentNode) root.append(legendEl);
    } else if (legendEl.parentNode) legendEl.parentNode.removeChild(legendEl);

    if (o.detail) {
      if (!detailEl.parentNode) root.append(detailEl);
      renderDetail(selectedAge != null ? byAge.get(selectedAge) : null);
    } else if (detailEl.parentNode) detailEl.parentNode.removeChild(detailEl);
  }

  function onKey(e) {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.age == null) return;
    const age = Number(t.dataset.age);
    const ages = [...buttons.keys()].sort((a, b) => a - b);
    if (!ages.length) return;
    let target = null;
    const nearest = (a) => {
      if (buttons.has(a)) return a;
      let best = null;
      for (const x of ages) if (best == null || Math.abs(x - a) < Math.abs(best - a)) best = x;
      return best;
    };
    switch (e.key) {
      case 'ArrowRight': target = ages.find((a) => a > age) ?? age; break;
      case 'ArrowLeft': target = [...ages].reverse().find((a) => a < age) ?? age; break;
      case 'ArrowDown': target = age + 10 <= ages[ages.length - 1] ? nearest(age + 10) : age; break;
      case 'ArrowUp': target = age - 10 >= ages[0] ? nearest(age - 10) : age; break;
      case 'Home': target = e.ctrlKey ? ages[0] : nearest(Math.floor(age / 10) * 10); break;
      case 'End': target = e.ctrlKey ? ages[ages.length - 1] : nearest(Math.floor(age / 10) * 10 + 9); break;
      case 'Escape':
        if (selectedAge != null) {
          selectedAge = null;
          for (const b of buttons.values()) b.setAttribute('aria-pressed', 'false');
          renderDetail(null);
        }
        return;
      default: return;
    }
    e.preventDefault();
    if (target == null) return;
    for (const [a, b] of buttons) b.tabIndex = a === target ? 0 : -1;
    buttons.get(target)?.focus();
  }

  root.update = (hist, patch) => {
    if (patch && typeof patch === 'object') { Object.assign(o, patch); fixOpts(); }
    rows = normalise(hist, isNum(Number(o.birthYear)) && o.birthYear != null ? Number(o.birthYear) : null);
    if (selectedAge != null && !rows.some((r) => r.age === selectedAge)) selectedAge = null;
    render();
    return root;
  };
  root.select = (year) => {
    const r = rows.find((x) => x.year === Number(year));
    if (r) select(r.age, { focus: false });
  };

  rows = normalise(history, isNum(Number(o.birthYear)) && o.birthYear != null ? Number(o.birthYear) : null);
  if (o.selected != null) {
    const r = rows.find((x) => x.year === Number(o.selected));
    if (r) selectedAge = r.age;
  }
  render();
  return root;
}
