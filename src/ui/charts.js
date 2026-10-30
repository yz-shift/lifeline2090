// SVG charts for the game, death and about screens. Every chart returns an <svg> built with s() from dom.js,
// coloured only through CSS custom properties (stroke="var(--st-health)") so both themes work, laid out at the
// real pixel width of its container (ResizeObserver) so text stays crisp at 11px on a phone and on a desktop.
//
//   sparkline(values, {width, height, color, min, max, label, unit, dashedFrom, ref})
//   lineChart(series [{name, values, color, dashedFrom?, area?}], {years, height, yMin, yMax, projectionFrom, unit,
//             format, title, endLabels, legend, zero})
//   survivalChart({ages, personal, baseline}, {currentAge, highlightAges:[60,80,100], height, labels, color})
//
// Line and survival charts carry a crosshair + tooltip (pointer, touch drag and arrow keys when focused).

import { s, clear, fmt } from './dom.js';

let uid = 0;
const nextId = (p) => `c-${p}-${++uid}`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (v == null || v === '' ? null : isNum(Number(v)) ? Number(v) : null);
const r1 = (x) => Math.round(x * 10) / 10;

const DEFAULT_COLORS = ['var(--accent)', 'var(--st-knowledge)', 'var(--st-wealth)', 'var(--st-happiness)', 'var(--st-relationships)', 'var(--st-health)', 'var(--ink-2)'];
const TICK_SIZE = 10.5;
const LABEL_SIZE = 11;
const FONT_MONO = 'var(--font-mono)';
const FONT_BODY = 'var(--font-body)';

/** Rough text advance in px (CJK full width, mono digits) used to reserve room for labels and size tooltips. */
export function textWidth(str, size = LABEL_SIZE, mono = false) {
  let w = 0;
  for (const ch of String(str ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80 || (c >= 0xff00 && c <= 0xffef)) w += size;
    else if (mono) w += size * 0.62;
    else if (' .,:;|!\'ijl1()[]'.includes(ch)) w += size * 0.34;
    else if (/[A-Z%MW@#&]/.test(ch)) w += size * 0.7;
    else w += size * 0.57;
  }
  return w;
}

function trimZeros(t) {
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
}

/** Default value formatter: compact Chinese units above 10 000, sensible decimals below. */
export function formatValue(v, unit = '') {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  let t;
  if (a >= 1e4) t = fmt.cn(v);
  else if (a >= 100) t = Math.round(v).toLocaleString('zh-CN');
  else if (a >= 10) t = trimZeros(v.toFixed(1));
  else t = trimZeros(v.toFixed(2));
  return t + unit;
}

function stepDecimals(step) {
  for (let d = 0; d < 4; d++) {
    const k = step * Math.pow(10, d);
    if (Math.abs(k - Math.round(k)) < 1e-6) return d;
  }
  return 4;
}

/** Tick label with as many decimals as the step needs, in 万/亿 units for large values (never two equal labels). */
function tickFormat(v, step, unit = '') {
  const a = Math.abs(v);
  if (a >= 1e8) return trimZeros((v / 1e8).toFixed(Math.min(3, stepDecimals(step / 1e8)))) + '亿' + unit;
  if (a >= 1e4) return trimZeros((v / 1e4).toFixed(Math.min(3, stepDecimals(step / 1e4)))) + '万' + unit;
  return Number(v).toFixed(stepDecimals(step)).replace(/^-0(\.0+)?$/, '0') + unit;
}

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * mag;
}

/** Nice domain and ticks covering [lo, hi]. */
function niceScale(lo, hi, count = 4) {
  if (!isNum(lo) || !isNum(hi)) return { lo: 0, hi: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad; hi += pad;
  }
  const step = niceStep(hi - lo, count);
  const nlo = Math.floor(lo / step + 1e-9) * step;
  const nhi = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = nlo, i = 0; v <= nhi + step * 1e-6 && i < 50; v = nlo + step * ++i) ticks.push(Math.round(v * 1e9) / 1e9);
  return { lo: nlo, hi: nhi, step, ticks };
}

/** Year (or age) ticks: an even step that leaves at least minGap px between labels. */
function axisTicks(x0, x1, plotW, labelW, steps = [1, 2, 5, 10, 20, 25, 50, 100]) {
  if (!(x1 > x0)) return { step: 1, ticks: [x0] };
  const span = x1 - x0;
  let step = steps[steps.length - 1];
  for (const st of steps) {
    if ((span / st) * (labelW + 14) <= plotW) { step = st; break; }
  }
  const out = [];
  for (let v = Math.ceil(x0 / step) * step; v <= x1 + 1e-9; v += step) out.push(v);
  return { step, ticks: out };
}

/** Lay the SVG out at its container's pixel width; re-layout when that width changes. */
function responsive(svg, height, initialWidth, draw) {
  let cur = -1;
  const run = (w) => {
    w = Math.max(80, Math.round(w));
    if (Math.abs(w - cur) < 2) return;
    cur = w;
    clear(svg);
    svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
    draw(w);
  };
  run(initialWidth);
  if (typeof ResizeObserver === 'function') {
    try {
      const ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        const w = e && e.contentRect ? e.contentRect.width : 0;
        if (w >= 40) run(w);
      });
      ro.observe(svg);
    } catch { /* fixed-width render is still correct */ }
  }
}

function baseSvg(cls, height) {
  return s('svg', {
    class: `c-chart ${cls}`,
    xmlns: 'http://www.w3.org/2000/svg',
    role: 'img',
    preserveAspectRatio: 'xMidYMid meet',
    style: `display:block;width:100%;height:${height}px;overflow:visible`,
  });
}

/** Path through points (null = gap) from index a to b inclusive. */
function linePath(pts, a, b) {
  let d = '';
  let pen = false;
  for (let i = Math.max(0, a); i <= Math.min(pts.length - 1, b); i++) {
    const p = pts[i];
    if (!p) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${r1(p[0])} ${r1(p[1])}`;
    pen = true;
  }
  return d;
}

/** Closed area path to the baseline for every contiguous run of >= 2 points in [a, b]. */
function areaPath(pts, a, b, base) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      d += `M${r1(run[0][0])} ${r1(base)}`;
      for (const p of run) d += `L${r1(p[0])} ${r1(p[1])}`;
      d += `L${r1(run[run.length - 1][0])} ${r1(base)}Z`;
    }
    run = [];
  };
  for (let i = Math.max(0, a); i <= Math.min(pts.length - 1, b); i++) {
    if (pts[i]) run.push(pts[i]); else flush();
  }
  flush();
  return d;
}

function lastIndex(pts) {
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i]) return i;
  return -1;
}

function hatchPattern(id, color = 'var(--proj)') {
  return s('pattern', { id, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: color, 'stroke-width': 1.2, 'stroke-opacity': 0.22 }));
}

function txt(x, y, str, { size = LABEL_SIZE, anchor = 'start', fill = 'var(--ink-3)', mono = false, weight, cls } = {}) {
  // font family comes from charts.css (.c-chart text / .c-mono); the attribute is only a fallback
  return s('text', {
    x: r1(x), y: r1(y), 'font-size': size, 'text-anchor': anchor, fill,
    'font-family': mono ? FONT_MONO : FONT_BODY, 'font-weight': weight,
    class: [mono ? 'c-mono' : '', cls || ''].filter(Boolean).join(' ') || null,
  }, String(str));
}

/** Legend row(s) at the top: a short line key in the series colour, the name in ink. Returns {node, height}. */
function legendRow(items, x0, y0, maxW) {
  const g = s('g', { class: 'c-legend', 'aria-hidden': 'true' });
  let x = x0, y = y0 + 8, rows = 1;
  for (const it of items) {
    const w = 20 + textWidth(it.name, LABEL_SIZE) + 14;
    if (x > x0 && x + w > x0 + maxW) { x = x0; y += 17; rows++; }
    g.appendChild(s('line', {
      x1: x, y1: y, x2: x + 14, y2: y, stroke: it.color, 'stroke-width': it.width || 2, 'stroke-linecap': 'round',
      'stroke-dasharray': it.dash || null, 'stroke-opacity': it.opacity ?? null,
    }));
    g.appendChild(txt(x + 19, y + 3.8, it.name, { fill: 'var(--ink-2)' }));
    x += w;
  }
  return { node: g, height: rows * 17 };
}

/** Simple collision bookkeeping for direct labels. */
function placer() {
  const boxes = [];
  return {
    fits(b) { return !boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y); },
    add(b) { boxes.push(b); },
    tryAdd(b) { if (this.fits(b)) { boxes.push(b); return true; } return false; },
  };
}

/**
 * Crosshair + tooltip layer. getLayout() returns { xs:[viewBox x per index], plot:{l,t,r,b}, W, row(i) -> {head, items} }
 * where items = [{color, value, name, y|null, dashed}]. Attached once per SVG; re-reads the layout on every event.
 */
function attachHover(svg, getLayout) {
  let idx = -1;
  let layer = null;
  const hide = () => {
    idx = -1;
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
  };
  const show = (i) => {
    const L = getLayout();
    if (!L || !L.xs.length) return;
    i = Math.max(0, Math.min(L.xs.length - 1, i));
    if (i === idx && layer && layer.parentNode === svg) return;
    hide();
    idx = i;
    const row = L.row(i);
    if (!row) return;
    const x = L.xs[i];
    const g = s('g', { class: 'c-hover', 'pointer-events': 'none' });
    g.appendChild(s('line', { x1: r1(x), y1: L.plot.t, x2: r1(x), y2: L.plot.b, stroke: 'var(--ink-3)', 'stroke-width': 1 }));
    for (const it of row.items) {
      if (!isNum(it.y)) continue;
      g.appendChild(s('circle', { cx: r1(x), cy: r1(it.y), r: 4, fill: it.color, stroke: 'var(--paper)', 'stroke-width': 2 }));
    }
    // tooltip box: head line, then value (strong) + name (muted) per series with a short line key
    const padX = 9, lineH = 17;
    const headW = textWidth(row.head, 12, false) + 2;
    let bodyW = 0;
    for (const it of row.items) bodyW = Math.max(bodyW, 20 + textWidth(it.value, 12, true) + 6 + textWidth(it.name, LABEL_SIZE));
    const bw = Math.ceil(Math.max(headW, bodyW) + padX * 2);
    const bh = 10 + 15 + row.items.length * lineH + 4;
    let bx = x + 12;
    if (bx + bw > L.W - 2) bx = x - 12 - bw;
    if (bx < 2) bx = Math.max(2, Math.min(L.W - bw - 2, x - bw / 2));
    const by = L.plot.t + 2;
    const tip = s('g', { class: 'c-tip' });
    tip.appendChild(s('rect', { x: r1(bx), y: by, width: bw, height: bh, rx: 4, fill: 'var(--paper)', stroke: 'var(--line)', 'stroke-width': 1, class: 'c-tip-box' }));
    tip.appendChild(txt(bx + padX, by + 18, row.head, { size: 12, fill: 'var(--ink)', weight: 600 }));
    row.items.forEach((it, k) => {
      const ly = by + 18 + 6 + (k + 1) * lineH - 4;
      tip.appendChild(s('line', { x1: bx + padX, y1: ly - 4, x2: bx + padX + 12, y2: ly - 4, stroke: it.color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-dasharray': it.dashed ? '3 2' : null }));
      const vx = bx + padX + 18;
      tip.appendChild(txt(vx, ly, it.value, { size: 12, fill: 'var(--ink)', weight: 600, mono: true }));
      tip.appendChild(txt(vx + textWidth(it.value, 12, true) + 6, ly, it.name, { fill: 'var(--ink-3)' }));
    });
    g.appendChild(tip);
    svg.appendChild(g);
    layer = g;
  };
  const indexAt = (clientX) => {
    const L = getLayout();
    if (!L || !L.xs.length) return -1;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return -1;
    const vx = (clientX - rect.left) * (L.W / rect.width);
    let best = 0, bd = Infinity;
    L.xs.forEach((x, i) => { const d = Math.abs(x - vx); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  svg.addEventListener('pointermove', (e) => { const i = indexAt(e.clientX); if (i >= 0) show(i); });
  svg.addEventListener('pointerdown', (e) => { const i = indexAt(e.clientX); if (i >= 0) show(i); });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
  svg.addEventListener('focus', () => { const L = getLayout(); if (L && L.xs.length) show(idx >= 0 ? idx : (L.focusIndex ?? L.xs.length - 1)); });
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const L = getLayout();
    if (!L || !L.xs.length) return;
    const cur = idx >= 0 ? idx : (L.focusIndex ?? L.xs.length - 1);
    let n = null;
    if (e.key === 'ArrowLeft') n = cur - 1;
    else if (e.key === 'ArrowRight') n = cur + 1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = L.xs.length - 1;
    else if (e.key === 'PageUp') n = cur - 10;
    else if (e.key === 'PageDown') n = cur + 10;
    else if (e.key === 'Escape') { hide(); return; }
    if (n == null) return;
    e.preventDefault();
    idx = -1;
    show(n);
  });
  return { reset() { layer = null; idx = -1; } };
}

function emptyState(svg, W, H, msg = '暂无数据') {
  svg.appendChild(s('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 4, fill: 'none', stroke: 'var(--line)', 'stroke-dasharray': '3 3' }));
  svg.appendChild(txt(W / 2, H / 2 + 4, msg, { anchor: 'middle', fill: 'var(--ink-3)' }));
}

// ---------------------------------------------------------------------------------------------------------------
// sparkline

/**
 * Small trend line for stat tiles. values: numbers (null = gap). Area wash, faint mid reference, emphasised last point.
 * @param {Array<number|null>} values
 * @param {{width?, height?, color?, min?, max?, label?, unit?, dashedFrom?: number, ref?: number}} opts
 */
export function sparkline(values = [], opts = {}) {
  const width = opts.width || 120;
  const height = opts.height || 32;
  const color = opts.color || 'var(--accent)';
  const unit = opts.unit || '';
  const vals = (Array.isArray(values) ? values : []).map(toNum);
  const finite = vals.filter(isNum);
  const svg = baseSvg('c-spark', height);
  svg.setAttribute('focusable', 'false');
  let lo = toNum(opts.min) ?? (finite.length ? Math.min(...finite) : 0);
  let hi = toNum(opts.max) ?? (finite.length ? Math.max(...finite) : 1);
  if (hi === lo) { lo -= 1; hi += 1; }
  const last = finite.length ? finite[finite.length - 1] : null;
  const label = opts.label ? `${opts.label}：` : '';
  const title = finite.length
    ? `${label}最近 ${formatValue(last, unit)}，最低 ${formatValue(Math.min(...finite), unit)}，最高 ${formatValue(Math.max(...finite), unit)}`
    : `${label}暂无数据`;
  svg.setAttribute('aria-label', title);
  const gradId = nextId('sp');

  responsive(svg, height, width, (W) => {
    svg.appendChild(s('title', {}, title));
    if (!finite.length) {
      svg.appendChild(s('line', { x1: 2, y1: height - 2.5, x2: W - 2, y2: height - 2.5, stroke: 'var(--line)', 'stroke-width': 1 }));
      return;
    }
    const pad = 4.5;
    const n = vals.length;
    const x = (i) => (n <= 1 ? W - pad : pad + (i * (W - 2 * pad)) / (n - 1));
    const y = (v) => pad + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (height - 2 * pad);
    const pts = vals.map((v, i) => (isNum(v) ? [x(i), y(v)] : null));
    const base = height - pad + 2;
    // faint reference line (e.g. 50 for stats) when inside the range
    const ref = toNum(opts.ref);
    if (isNum(ref) && ref > lo && ref < hi) {
      svg.appendChild(s('line', { x1: 0, y1: r1(y(ref)), x2: W, y2: r1(y(ref)), stroke: 'var(--line)', 'stroke-width': 1 }));
    }
    svg.appendChild(s('defs', {},
      s('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.22 }),
        s('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.02 }))));
    const dashAt = isNum(opts.dashedFrom) ? Math.max(0, Math.min(n, opts.dashedFrom)) : n;
    const area = areaPath(pts, 0, n - 1, base);
    if (area && opts.area !== false) svg.appendChild(s('path', { d: area, fill: `url(#${gradId})`, stroke: 'none' }));
    const common = { fill: 'none', stroke: color, 'stroke-width': 1.75, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
    const solid = linePath(pts, 0, dashAt - 1 >= 0 ? dashAt - 1 : -1);
    if (solid) svg.appendChild(s('path', { ...common, d: solid }));
    if (dashAt < n) {
      const dashed = linePath(pts, Math.max(0, dashAt - 1), n - 1);
      if (dashed) svg.appendChild(s('path', { ...common, d: dashed, 'stroke-dasharray': '3 3' }));
    }
    const li = lastIndex(pts);
    if (li >= 0) {
      if (pts.filter(Boolean).length === 1) {
        svg.appendChild(s('line', { x1: pad, y1: r1(pts[li][1]), x2: W - pad, y2: r1(pts[li][1]), stroke: color, 'stroke-width': 1, 'stroke-opacity': 0.35 }));
      }
      svg.appendChild(s('circle', { cx: r1(pts[li][0]), cy: r1(pts[li][1]), r: 3, fill: color, stroke: 'var(--paper)', 'stroke-width': 1.5 }));
    }
  });
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------
// lineChart

function resolveDashIndex(years, dashedFrom, fallbackIdx) {
  if (dashedFrom == null || !isNum(Number(dashedFrom))) return fallbackIdx;
  const d = Number(dashedFrom);
  if (d >= 1000) {
    const i = years.findIndex((y) => y >= d);
    return i < 0 ? years.length : i;
  }
  return Math.max(0, Math.min(years.length, Math.round(d)));
}

/**
 * Multi-series line chart on a year axis. Years after `projectionFrom` get a hatched "推演" band and dashed lines.
 * @param {Array<{name, values, color?, dashedFrom?, area?}>} series
 * @param {{years?: number[], height?, yMin?, yMax?, projectionFrom?, unit?, format?: (v, i) => string, title?,
 *          endLabels?: boolean, legend?: boolean, zero?: boolean, xFormat?: (year) => string}} opts
 */
export function lineChart(series = [], opts = {}) {
  const height = Math.max(120, opts.height || 220);
  const unit = opts.unit || '';
  const list = (Array.isArray(series) ? series : []).filter(Boolean).map((sr, i) => ({
    name: String(sr.name ?? `系列 ${i + 1}`),
    values: (Array.isArray(sr.values) ? sr.values : []).map(toNum),
    color: sr.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    dashedFrom: sr.dashedFrom,
    area: sr.area,
  }));
  const n = Math.max(0, ...list.map((sr) => sr.values.length));
  const years = (Array.isArray(opts.years) && opts.years.length ? opts.years.map(Number) : Array.from({ length: n }, (_, i) => i)).slice(0, Math.max(n, 1));
  const N = Math.min(years.length, n);
  const format = typeof opts.format === 'function' ? opts.format : (v) => formatValue(v, unit);
  const xFormat = typeof opts.xFormat === 'function' ? opts.xFormat : (y) => String(y);
  const projFrom = toNum(opts.projectionFrom);
  const projIdx = isNum(projFrom) ? (() => { const i = years.findIndex((y) => y >= projFrom); return i < 0 ? N : i; })() : N;

  const all = [];
  for (const sr of list) for (let i = 0; i < N; i++) if (isNum(sr.values[i])) all.push(sr.values[i]);
  const dataMin = all.length ? Math.min(...all) : null;
  const dataMax = all.length ? Math.max(...all) : null;

  const svg = baseSvg('c-line', height);
  svg.setAttribute('tabindex', '0');
  const xSpoken = typeof opts.xFormat === 'function' ? xFormat : (y) => (opts.years ? `${y} 年` : `第 ${y + 1} 项`);
  const summary = (() => {
    const head = opts.title || '趋势';
    if (!all.length) return `${head}：暂无数据`;
    const parts = list.map((sr, k) => {
      const idx = sr.values.map((v, i) => (i < N && isNum(v) ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) return `${sr.name}暂无数据`;
      const a = idx[0], b = idx[idx.length - 1];
      return `${sr.name}从 ${xSpoken(years[a])}的 ${format(sr.values[a], k)} 到 ${xSpoken(years[b])}的 ${format(sr.values[b], k)}`;
    });
    const tail = isNum(projFrom) && projIdx < N ? (projIdx > 0 ? `；${xSpoken(years[projIdx - 1])}之后为推演` : '；全部为推演') : '';
    return `${head}：${parts.join('；')}${tail}`;
  })();
  svg.setAttribute('aria-label', summary);

  let layout = null;
  const hover = attachHover(svg, () => layout);
  const patId = nextId('hatch');
  const gradBase = nextId('lg');

  responsive(svg, height, opts.width || 640, (W) => {
    hover.reset();
    layout = null;
    svg.appendChild(s('title', {}, summary));
    if (!all.length || N === 0) { emptyState(svg, W, height); return; }

    // y domain
    let lo = toNum(opts.yMin) ?? dataMin;
    let hi = toNum(opts.yMax) ?? dataMax;
    if (opts.yMin == null && (opts.zero || (dataMin >= 0 && dataMin < 0.25 * dataMax))) lo = 0;
    // legend
    const showLegend = opts.legend ?? list.length >= 2;
    const legendItems = list.map((sr) => ({ name: sr.name, color: sr.color }));
    const leg = showLegend ? legendRow(legendItems, 0, 0, W) : null;
    const top = (leg ? leg.height + 8 : 0) + 10;
    const bottom = 22;
    const plotH = height - top - bottom;
    const sc = niceScale(lo, hi, Math.max(2, Math.min(5, Math.floor(plotH / 38))));
    const yLo = toNum(opts.yMin) ?? sc.lo;
    const yHi = toNum(opts.yMax) ?? sc.hi;
    // only label ticks the data actually reaches (one nice step either side of the data range)
    const reachLo = dataMin - sc.step * 0.999, reachHi = dataMax + sc.step * 0.999;
    const ticks = sc.ticks.filter((t) => t >= yLo - 1e-9 && t <= yHi + 1e-9);
    const tickLabels = ticks.map((t) => ({ t, label: t >= reachLo && t <= reachHi ? tickFormat(t, sc.step, unit) : null }));
    const left = Math.max(22, ...tickLabels.map((tl) => (tl.label ? textWidth(tl.label, TICK_SIZE, true) : 0))) + 8;
    const endLabels = opts.endLabels ?? list.length <= 4;
    let right = 10;
    const ends = [];
    if (endLabels) {
      for (const sr of list) {
        let li = -1;
        for (let i = N - 1; i >= 0; i--) if (isNum(sr.values[i])) { li = i; break; }
        if (li >= 0) {
          const label = format(sr.values[li], list.indexOf(sr));
          ends.push({ sr, li, label });
          right = Math.max(right, textWidth(label, LABEL_SIZE, true) + 14);
        }
      }
    }
    right = Math.min(right, Math.max(10, W * 0.28));
    const plot = { l: left, t: top, r: W - right, b: height - bottom };
    const x0 = years[0], x1 = years[N - 1];
    const x = (yr) => (x1 === x0 ? (plot.l + plot.r) / 2 : plot.l + ((yr - x0) / (x1 - x0)) * (plot.r - plot.l));
    const y = (v) => plot.b - ((Math.min(yHi, Math.max(yLo, v)) - yLo) / (yHi - yLo || 1)) * (plot.b - plot.t);

    const defs = s('defs', {}, hatchPattern(patId));
    svg.appendChild(defs);

    // projection band
    let bx = null;
    if (projIdx > 0 && projIdx < N) {
      bx = x(years[projIdx - 1]);
      svg.appendChild(s('rect', { x: r1(bx), y: plot.t, width: r1(plot.r - bx), height: plot.b - plot.t, fill: 'var(--proj)', 'fill-opacity': 0.06, class: 'c-proj-band' }));
      svg.appendChild(s('rect', { x: r1(bx), y: plot.t, width: r1(plot.r - bx), height: plot.b - plot.t, fill: `url(#${patId})` }));
    } else if (projIdx === 0 && N > 0 && isNum(projFrom)) {
      bx = plot.l;
      svg.appendChild(s('rect', { x: plot.l, y: plot.t, width: plot.r - plot.l, height: plot.b - plot.t, fill: `url(#${patId})` }));
    }

    // grid + y labels
    for (const { t, label } of tickLabels) {
      const ty = y(t);
      svg.appendChild(s('line', { x1: plot.l, y1: r1(ty), x2: plot.r, y2: r1(ty), stroke: 'var(--line)', 'stroke-width': 1, 'shape-rendering': 'crispEdges', class: 'c-grid' }));
      if (label) svg.appendChild(txt(plot.l - 6, ty + 3.5, label, { size: TICK_SIZE, anchor: 'end', mono: true, cls: 'c-tick' }));
    }
    // x labels
    const sampleW = textWidth(xFormat(years[N - 1]), TICK_SIZE, true);
    const xt = axisTicks(x0, x1, plot.r - plot.l, sampleW);
    const placedX = [];
    const putX = (yr, strong) => {
      const px = x(yr);
      const label = xFormat(yr);
      const w = textWidth(label, TICK_SIZE, true);
      const box = { a: px - w / 2 - 4, b: px + w / 2 + 4 };
      if (box.a < 1 || box.b > W - 1) return;
      if (placedX.some((o) => box.a < o.b && box.b > o.a)) return;
      placedX.push(box);
      svg.appendChild(txt(px, plot.b + 15, label, { size: TICK_SIZE, anchor: 'middle', mono: true, cls: 'c-tick', fill: strong ? 'var(--ink-2)' : 'var(--ink-3)' }));
    };
    putX(years[0], true);
    putX(years[N - 1], true);
    for (const t of xt.ticks) putX(t, false);
    svg.appendChild(s('line', { x1: plot.l, y1: plot.b, x2: plot.r, y2: plot.b, stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-opacity': 0.6, 'shape-rendering': 'crispEdges' }));

    // boundary marker + band labels
    if (bx != null && projIdx > 0) {
      svg.appendChild(s('line', { x1: r1(bx), y1: plot.t, x2: r1(bx), y2: plot.b, stroke: 'var(--proj)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
      if (plot.r - bx > 34) svg.appendChild(txt(bx + 5, plot.t + 11, '推演', { size: 10.5, fill: 'var(--proj)', weight: 600, cls: 'c-band-label' }));
      if (bx - plot.l > 34) svg.appendChild(txt(bx - 5, plot.t + 11, '真实', { size: 10.5, anchor: 'end', fill: 'var(--ink-3)', cls: 'c-band-label' }));
    }

    // series
    const ptsAll = list.map((sr) => years.slice(0, N).map((yr, i) => (isNum(sr.values[i]) ? [x(yr), y(sr.values[i])] : null)));
    const areaFor = (k) => (list[k].area != null ? !!list[k].area : k === 0);
    list.forEach((sr, k) => {
      if (!areaFor(k)) return;
      const pts = ptsAll[k];
      const gid = `${gradBase}-${k}`;
      defs.appendChild(s('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: '0%', 'stop-color': sr.color, 'stop-opacity': list.length > 1 ? 0.14 : 0.18 }),
        s('stop', { offset: '100%', 'stop-color': sr.color, 'stop-opacity': 0.02 })));
      const d = areaPath(pts, 0, N - 1, plot.b);
      if (d) svg.appendChild(s('path', { d, fill: `url(#${gid})`, stroke: 'none', class: 'c-area' }));
    });
    const dashIdxs = list.map((sr) => resolveDashIndex(years.slice(0, N), sr.dashedFrom, projIdx));
    list.forEach((sr, k) => {
      const pts = ptsAll[k];
      const di = dashIdxs[k];
      const common = { fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'c-series' };
      const solid = di > 0 ? linePath(pts, 0, di - 1) : '';
      if (solid) svg.appendChild(s('path', { ...common, d: solid }));
      if (di < N) {
        const dashed = linePath(pts, Math.max(0, di - 1), N - 1);
        if (dashed) svg.appendChild(s('path', { ...common, d: dashed, 'stroke-dasharray': '5 4' }));
      }
      const li = lastIndex(pts);
      if (li >= 0) svg.appendChild(s('circle', { cx: r1(pts[li][0]), cy: r1(pts[li][1]), r: 4, fill: sr.color, stroke: 'var(--paper)', 'stroke-width': 2, class: 'c-end' }));
    });

    // direct end labels: only when they do not collide (legend + tooltip carry the rest)
    if (endLabels && ends.length) {
      const pl = placer();
      const sorted = ends.map((e) => ({ ...e, py: y(e.sr.values[e.li]), px: x(years[e.li]) })).sort((a, b) => a.py - b.py);
      for (const e of sorted) {
        const w = textWidth(e.label, LABEL_SIZE, true);
        const box = { x: e.px + 7, y: e.py - 7, w: w + 2, h: 14 };
        if (box.x + box.w > W) continue;
        if (pl.tryAdd(box)) svg.appendChild(txt(e.px + 8, e.py + 3.8, e.label, { size: LABEL_SIZE, mono: true, fill: 'var(--ink-2)', weight: 600, cls: 'c-end-label' }));
      }
    }
    if (leg) svg.appendChild(leg.node);

    layout = {
      W, plot,
      xs: years.slice(0, N).map((yr) => x(yr)),
      focusIndex: projIdx > 0 && projIdx < N ? projIdx - 1 : N - 1,
      row: (i) => ({
        head: `${xFormat(years[i])}${i >= projIdx ? ' · 推演' : ''}`,
        items: list.map((sr, k) => ({
          color: sr.color, name: sr.name, dashed: i >= dashIdxs[k],
          value: isNum(sr.values[i]) ? format(sr.values[i], k) : '—',
          y: ptsAll[k][i] ? ptsAll[k][i][1] : null,
        })),
      }),
    };
  });
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------
// survivalChart

function interpAt(xs, ys, x) {
  if (!xs.length) return null;
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const a = ys[i - 1], b = ys[i];
      if (!isNum(a) || !isNum(b)) return isNum(b) ? b : a;
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return a + (b - a) * t;
    }
  }
  return ys[ys.length - 1];
}

/** First age at which the curve falls to `level` (percent), linearly interpolated. */
function crossing(xs, ys, level) {
  for (let i = 1; i < xs.length; i++) {
    const a = ys[i - 1], b = ys[i];
    if (isNum(a) && isNum(b) && a >= level && b < level) return xs[i - 1] + ((a - level) / (a - b || 1)) * (xs[i] - xs[i - 1]);
  }
  return null;
}

const pctText = (v) => (!isNum(v) ? '—' : v >= 99.5 && v < 100 ? '>99%' : v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`);

/**
 * Survival curve: probability (from the current age) of being alive at each later age, personal vs baseline.
 * @param {{ages:number[], personal:number[], baseline?:number[]}} curve  probabilities 0..1 (or 0..100)
 * @param {{currentAge?, highlightAges?: number[], height?, labels?: {personal, baseline}, color?, title?}} opts
 */
export function survivalChart(curve = {}, opts = {}) {
  const height = Math.max(140, opts.height || 220);
  const ages = (Array.isArray(curve?.ages) ? curve.ages : []).map(toNum);
  const scaleOf = (arr) => {
    const f = (arr || []).map(toNum).filter(isNum);
    return f.length && Math.max(...f) > 1.5 ? 1 : 100;
  };
  const pk = scaleOf(curve?.personal);
  const bk = scaleOf(curve?.baseline);
  const n = ages.length;
  const personal = Array.from({ length: n }, (_, i) => { const v = toNum(curve?.personal?.[i]); return isNum(v) ? Math.max(0, Math.min(100, v * pk)) : null; });
  const hasBase = Array.isArray(curve?.baseline) && curve.baseline.some((v) => isNum(toNum(v)));
  const baseline = Array.from({ length: n }, (_, i) => { const v = toNum(curve?.baseline?.[i]); return isNum(v) ? Math.max(0, Math.min(100, v * bk)) : null; });
  const labels = { personal: '你', baseline: '同国同龄平均', ...(opts.labels || {}) };
  const color = opts.color || 'var(--st-health)';
  const baseColor = 'var(--ink-3)';
  const currentAge = toNum(opts.currentAge);
  const highlights = (Array.isArray(opts.highlightAges) ? opts.highlightAges : [60, 80, 100]).map(toNum).filter(isNum);
  const valid = n >= 2 && ages.every(isNum) && personal.some(isNum);
  const agesClean = valid ? ages : [];

  const median = valid ? crossing(agesClean, personal, 50) : null;
  const baseMedian = valid && hasBase ? crossing(agesClean, baseline, 50) : null;
  const summary = (() => {
    if (!valid) return '生存曲线：暂无数据';
    const h = highlights.find((a) => a > (currentAge ?? -1) && a >= agesClean[0] && a <= agesClean[n - 1]);
    const parts = [];
    if (h != null) {
      const p = interpAt(agesClean, personal, h);
      const b = hasBase ? interpAt(agesClean, baseline, h) : null;
      parts.push(`活到 ${h} 岁的概率约 ${pctText(p)}${isNum(b) ? `（${labels.baseline} ${pctText(b)}）` : ''}`);
    }
    if (isNum(median)) parts.push(`一半的可能活过 ${Math.round(median)} 岁${isNum(baseMedian) ? `（${labels.baseline} ${Math.round(baseMedian)} 岁）` : ''}`);
    return `${opts.title || '生存曲线'}：${parts.join('，') || '从现在起的存活概率'}`;
  })();

  const svg = baseSvg('c-surv', height);
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-label', summary);
  let layout = null;
  const hover = attachHover(svg, () => layout);
  const gradId = nextId('sv');

  responsive(svg, height, opts.width || 560, (W) => {
    hover.reset();
    layout = null;
    svg.appendChild(s('title', {}, summary));
    if (!valid) { emptyState(svg, W, height, '生存曲线将在出生后出现'); return; }
    const legItems = [{ name: labels.personal, color }];
    if (hasBase) legItems.push({ name: labels.baseline, color: baseColor, width: 1.5 });
    const leg = legendRow(legItems, 0, 0, W);
    const top = leg.height + 16;
    const bottom = 22;
    const ticksY = [0, 25, 50, 75, 100];
    const left = textWidth('100%', TICK_SIZE, true) + 10;
    const plot = { l: left, t: top, r: W - 12, b: height - bottom };
    const a0 = agesClean[0], a1 = agesClean[n - 1];
    const x = (a) => plot.l + ((a - a0) / (a1 - a0 || 1)) * (plot.r - plot.l);
    const y = (v) => plot.b - (Math.max(0, Math.min(100, v)) / 100) * (plot.b - plot.t);
    svg.appendChild(s('defs', {},
      s('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 },
        s('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.2 }),
        s('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.03 }))));

    // lived part of the axis (ages before now)
    if (isNum(currentAge) && currentAge > a0) {
      const cx = x(Math.min(currentAge, a1));
      svg.appendChild(s('rect', { x: plot.l, y: plot.t, width: r1(cx - plot.l), height: plot.b - plot.t, fill: 'var(--ink-3)', 'fill-opacity': 0.06 }));
    }
    for (const t of ticksY) {
      const ty = y(t);
      svg.appendChild(s('line', { x1: plot.l, y1: r1(ty), x2: plot.r, y2: r1(ty), stroke: 'var(--line)', 'stroke-width': 1, 'shape-rendering': 'crispEdges', class: 'c-grid' }));
      svg.appendChild(txt(plot.l - 6, ty + 3.5, `${t}%`, { size: TICK_SIZE, anchor: 'end', mono: true, cls: 'c-tick' }));
    }
    const xt = axisTicks(a0, a1, plot.r - plot.l, textWidth('100岁', TICK_SIZE), [5, 10, 20, 25, 50]);
    const placedX = [];
    const putX = (a, strong) => {
      const px = x(a);
      const label = `${Math.round(a)}岁`;
      const w = textWidth(label, TICK_SIZE);
      const box = { a: px - w / 2 - 4, b: px + w / 2 + 4 };
      if (box.a < 0 || box.b > W) return;
      if (placedX.some((o) => box.a < o.b && box.b > o.a)) return;
      placedX.push(box);
      svg.appendChild(txt(px, plot.b + 15, label, { size: TICK_SIZE, anchor: 'middle', cls: 'c-tick', fill: strong ? 'var(--ink-2)' : 'var(--ink-3)' }));
    };
    putX(a0, true);
    for (const t of xt.ticks) putX(t, false);
    svg.appendChild(s('line', { x1: plot.l, y1: plot.b, x2: plot.r, y2: plot.b, stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-opacity': 0.6, 'shape-rendering': 'crispEdges' }));

    const ptsP = agesClean.map((a, i) => (isNum(personal[i]) ? [x(a), y(personal[i])] : null));
    const ptsB = agesClean.map((a, i) => (isNum(baseline[i]) ? [x(a), y(baseline[i])] : null));
    const area = areaPath(ptsP, 0, n - 1, plot.b);
    if (area) svg.appendChild(s('path', { d: area, fill: `url(#${gradId})`, stroke: 'none', class: 'c-area' }));
    if (hasBase) {
      const d = linePath(ptsB, 0, n - 1);
      if (d) svg.appendChild(s('path', { d, fill: 'none', stroke: baseColor, 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'c-series c-baseline' }));
    }
    const dP = linePath(ptsP, 0, n - 1);
    if (dP) svg.appendChild(s('path', { d: dP, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'c-series' }));

    const pl = placer();
    // current age marker
    if (isNum(currentAge) && currentAge >= a0 && currentAge <= a1) {
      const cx = x(currentAge);
      svg.appendChild(s('line', { x1: r1(cx), y1: plot.t - 4, x2: r1(cx), y2: plot.b, stroke: 'var(--ink-2)', 'stroke-width': 1 }));
      const label = `现在 ${Math.floor(currentAge)}岁`;
      const w = textWidth(label, LABEL_SIZE);
      const atEnd = cx + 5 + w > plot.r;
      const lx = atEnd ? cx - 5 : cx + 5;
      svg.appendChild(txt(lx, plot.t + 8, label, { anchor: atEnd ? 'end' : 'start', fill: 'var(--ink-2)', weight: 600 }));
      pl.add({ x: atEnd ? lx - w : lx, y: plot.t - 2, w, h: 14 });
    }
    // median (50%) crossing
    if (isNum(median) && median > a0 && median <= a1) {
      const mx = x(median), my = y(50);
      svg.appendChild(s('line', { x1: r1(mx), y1: r1(my), x2: r1(mx), y2: plot.b, stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
      const label = `中位 ${Math.round(median)}岁`;
      const w = textWidth(label, LABEL_SIZE);
      const lx = mx + 6 + w > plot.r ? mx - 6 - w : mx + 6;
      if (pl.tryAdd({ x: lx, y: plot.b - 18, w, h: 14 })) svg.appendChild(txt(lx, plot.b - 7, label, { fill: 'var(--ink-2)' }));
    }
    // highlighted ages on the personal curve
    const hlDots = [];
    for (const age of highlights) {
      if (age < a0 || age > a1) continue;
      if (isNum(currentAge) && age <= currentAge) continue;
      const v = interpAt(agesClean, personal, age);
      if (!isNum(v)) continue;
      const px = x(age), py = y(v);
      hlDots.push(s('circle', { cx: r1(px), cy: r1(py), r: 4, fill: color, stroke: 'var(--paper)', 'stroke-width': 2, class: 'c-end' }));
      const label = `${age}岁 ${pctText(v)}`;
      const w = textWidth(label, LABEL_SIZE, false);
      const cands = [
        { x: px + 7, y: py - 18 }, { x: px - 7 - w, y: py - 18 }, { x: px + 7, y: py + 4 }, { x: px - 7 - w, y: py + 4 },
      ];
      for (const c of cands) {
        const box = { x: c.x, y: c.y, w, h: 14 };
        if (box.x < plot.l || box.x + w > W - 1 || box.y < plot.t - 2 || box.y + 14 > plot.b) continue;
        if (pl.tryAdd(box)) { hlDots.push(txt(c.x, c.y + 11, label, { fill: 'var(--ink-2)', weight: 600, cls: 'c-end-label' })); break; }
      }
    }
    for (const node of hlDots) svg.appendChild(node);
    svg.appendChild(leg.node);

    const startIdx = isNum(currentAge) ? Math.max(0, agesClean.findIndex((a) => a >= currentAge)) : 0;
    layout = {
      W, plot,
      xs: agesClean.map((a) => x(a)),
      focusIndex: (() => {
        const target = highlights.find((a) => a > (currentAge ?? -1));
        const i = target != null ? agesClean.findIndex((a) => a >= target) : -1;
        return i >= 0 ? i : startIdx;
      })(),
      row: (i) => {
        const items = [{ color, name: labels.personal, value: pctText(personal[i]), y: ptsP[i] ? ptsP[i][1] : null }];
        if (hasBase) items.push({ color: baseColor, name: labels.baseline, value: pctText(baseline[i]), y: ptsB[i] ? ptsB[i][1] : null });
        return { head: `活到 ${Math.round(agesClean[i])} 岁`, items };
      },
    };
  });
  return svg;
}
