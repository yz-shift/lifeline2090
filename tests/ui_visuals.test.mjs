// Tests for src/ui/charts.js, src/ui/lifemap.js, src/ui/cards.js, src/ui/screens/about.js, the decision overlay, and
// the interactivity layer v2 UI: the side sheet (app.js openSheet), the 家人与生活 / 花钱·投资 panels, the death screen
// additions and the new settings / home preferences.
// No browser is available here, so a small DOM + canvas shim (below) stands in for document/window. It implements
// exactly what dom.js h()/s() and these modules use, throws on innerHTML (untrusted text must never go there) and
// fails any canvas call that receives a non-finite coordinate.
// Run: node --test tests/ui_visuals.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ---------------------------------------------------------------------------------------------------------------
// minimal DOM shim

class FakeNode {
  constructor(type) { this.nodeType = type; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  appendChild(c) {
    if (!(c instanceof FakeNode)) throw new TypeError('appendChild expects a node');
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(c instanceof FakeNode ? c : new FakeText(String(c))); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && v !== '') this.appendChild(new FakeText(String(v)));
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc; }
}

class FakeText extends FakeNode {
  constructor(t) { super(3); this.data = String(t); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function parseCompound(c) {
  const m = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let x;
  while ((x = re.exec(c)) && x[0]) {
    if (x[1]) m.tag = x[1] === '*' ? null : x[1].toLowerCase();
    else if (x[2]) m.id = x[2];
    else if (x[3]) m.classes.push(x[3]);
    else m.attrs.push([x[4], x[5]]);
  }
  return m;
}
function matches(el, m) {
  if (el.nodeType !== 1) return false;
  if (m.tag && el.localName.toLowerCase() !== m.tag) return false;
  if (m.id && el.id !== m.id) return false;
  for (const c of m.classes) if (!el._classes.includes(c)) return false;
  for (const [k, v] of m.attrs) {
    const a = el.getAttribute(k);
    if (a == null || (v != null && a !== v)) return false;
  }
  return true;
}
function matchChain(el, chain) {
  if (!matches(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let p = el.parentNode;
  while (i >= 0 && p) { if (p.nodeType === 1 && matches(p, chain[i])) i--; p = p.parentNode; }
  return i < 0;
}

class FakeElement extends FakeNode {
  constructor(tag, ns = HTML_NS) {
    super(1);
    this.localName = tag;
    this.tagName = ns === HTML_NS ? tag.toUpperCase() : tag;
    this.namespaceURI = ns;
    this._attrs = new Map();
    this._classes = [];
    this._listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.id = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.tabIndex = -1;
  }
  get classList() {
    const self = this;
    return {
      add: (...c) => { for (const x of c) if (!self._classes.includes(x)) self._classes.push(x); },
      remove: (...c) => { self._classes = self._classes.filter((x) => !c.includes(x)); },
      contains: (c) => self._classes.includes(c),
      toggle: (c, force) => {
        const has = self._classes.includes(c);
        const want = force === undefined ? !has : !!force;
        if (want && !has) self._classes.push(c);
        if (!want && has) self._classes = self._classes.filter((x) => x !== c);
        return want;
      },
    };
  }
  get className() { return this._classes.join(' '); }
  set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); }
  get value() {
    if (this.localName === 'select') {
      const opts = this.querySelectorAll('option');
      const sel = opts.find((o) => o.selected) || opts[0];
      return sel ? sel.value : '';
    }
    if (this._value != null) return this._value;
    const a = this.getAttribute('value');
    return a != null ? a : this.localName === 'option' ? this.textContent : '';
  }
  set value(v) {
    if (this.localName === 'select') {
      for (const o of this.querySelectorAll('option')) o.selected = o.value === String(v);
      return;
    }
    this._value = String(v);
  }
  get innerHTML() { return ''; }
  set innerHTML(v) { throw new Error(`innerHTML must not be used (got ${String(v).slice(0, 40)})`); }
  setAttribute(k, v) {
    v = String(v);
    if (k === 'class') this.className = v;
    else if (k === 'id') this.id = v;
    else this._attrs.set(k, v);
  }
  getAttribute(k) {
    if (k === 'class') return this._classes.length ? this.className : null;
    if (k === 'id') return this.id || null;
    if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key in this.dataset) return String(this.dataset[key]);
    }
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) != null; }
  removeAttribute(k) { this._attrs.delete(k); }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const l = this._listeners.get(t);
    const i = l ? l.indexOf(fn) : -1;
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(init) {
    const ev = {
      bubbles: true, ...init, target: init.target || this, defaultPrevented: false, _stop: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stop = true; },
    };
    let n = this;
    while (n && !ev._stop) {
      for (const fn of [...(n._listeners?.get(ev.type) || [])]) { ev.currentTarget = n; fn.call(n, ev); }
      n = ev.bubbles === false ? null : n.parentNode;
    }
    return ev;
  }
  click() { return this.dispatchEvent({ type: 'click' }); }
  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 200, right: 600, bottom: 200 }; }
  scrollIntoView() { this._scrolled = true; }
  querySelectorAll(sel) {
    // child combinators are treated as descendant combinators (close enough for these tests)
    const chain = sel.trim().split(/\s+/).filter((t) => t !== '>').map(parseCompound);
    const out = [];
    const visit = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matchChain(c, chain)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

// canvas: every drawing call is validated (finite numbers) and fillText calls are recorded
const drawn = [];
function makeCtx(canvas) {
  const state = { font: '10px sans-serif', canvas };
  const fns = {
    measureText(str) {
      const m = /(\d+(?:\.\d+)?)px/.exec(state.font);
      const size = m ? Number(m[1]) : 10;
      let w = 0;
      for (const ch of String(str)) w += ch.codePointAt(0) >= 0x2e80 ? size : size * 0.56;
      return { width: w };
    },
    fillText(str, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`fillText at non-finite position ${x},${y}`);
      drawn.push(String(str));
    },
    createRadialGradient(...a) { check('createRadialGradient', a); return { addColorStop() {} }; },
    createLinearGradient(...a) { check('createLinearGradient', a); return { addColorStop() {} }; },
  };
  function check(name, args) {
    for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${name} received ${a}`);
  }
  return new Proxy(state, {
    get(t, k) {
      if (k in fns) return fns[k];
      if (k in t) return t[k];
      return (...args) => check(String(k), args);
    },
    set(t, k, v) {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`ctx.${String(k)} = ${v}`);
      t[k] = v;
      return true;
    },
    has(t, k) { return k in fns || k in t; },
  });
}
class FakeCanvas extends FakeElement {
  constructor() { super('canvas'); this.width = 300; this.height = 150; this._ctx = makeCtx(this); }
  getContext(kind) { return kind === '2d' ? this._ctx : null; }
  toBlob(cb, type) { realSetTimeout(() => cb(new Blob([`fake ${this.width}x${this.height}`], { type: type || 'image/png' })), 0); }
}

const created = [];
const doc = new FakeElement('#document');
doc.createElement = (t) => { const el = t === 'canvas' ? new FakeCanvas() : new FakeElement(t); created.push(el); return el; };
doc.createElementNS = (ns, t) => new FakeElement(t, ns);
doc.createTextNode = (t) => new FakeText(t);
doc.documentElement = doc.appendChild(new FakeElement('html'));
doc.body = doc.documentElement.appendChild(new FakeElement('body'));
doc.activeElement = doc.body;

globalThis.Node = FakeNode;
globalThis.document = doc;
globalThis.window = globalThis;

// long timers (font-load race, object-URL revoke) must not keep the test process alive
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => {
  const t = realSetTimeout(fn, ms, ...a);
  if (ms >= 1000 && t && typeof t.unref === 'function') t.unref();
  return t;
};
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));

const charts = await import('../src/ui/charts.js');
const { lifeMap } = await import('../src/ui/lifemap.js');
const cards = await import('../src/ui/cards.js');
const about = await import('../src/ui/screens/about.js');
const { makeDataStore } = await import('../src/core/data.js');
const { YEAR_TAGS } = await import('../src/core/constants.js');

// ---------------------------------------------------------------------------------------------------------------
// helpers and fixtures

function* walk(el) {
  yield el;
  for (const c of el.childNodes) if (c.nodeType === 1) yield* walk(c);
}
const textsOf = (el, sel) => el.querySelectorAll(sel).map((n) => n.textContent);

/** Every paint colour in an SVG must come from a CSS custom property (so both themes work). */
function assertThemedColours(svg) {
  const ok = (v) => v === 'none' || v === 'currentColor' || /^var\(--[\w-]+\)$/.test(v) || /^url\(#[\w-]+\)$/.test(v);
  for (const el of walk(svg)) {
    for (const attr of ['stroke', 'fill', 'stop-color']) {
      const v = el.getAttribute(attr);
      if (v != null) assert.ok(ok(v), `<${el.localName}> ${attr}="${v}" is not a theme token`);
    }
  }
}

const TAG_CYCLE = ['birth', 'childhood', 'childhood', 'study', 'study', 'study', 'love', 'work', 'work', 'family', 'calm', 'success', 'illness', 'crisis', 'migration', 'loss', 'retire'];
function makeHistory(birthYear, years, { death = false } = {}) {
  const out = [];
  for (let age = 0; age < years; age++) {
    const tag = death && age === years - 1 ? 'death' : age === 0 ? 'birth' : TAG_CYCLE[age % TAG_CYCLE.length];
    out.push({
      year: birthYear + age, age, tag, mood: (age % 5) - 2, country: 'CHN',
      headline: `第 ${age} 年的记事`,
      stats: { health: 90 - age * 0.5, happiness: 55 + (age % 7), knowledge: Math.min(95, age * 2), relationships: 60, wealth: 30 + age * 0.4 },
    });
  }
  return out;
}

let realData = null;
function loadReal() {
  if (realData) return realData;
  const read = (f) => JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
  let content = {};
  try { content = read('content.json'); } catch { content = {}; }
  realData = makeDataStore({ countries: read('countries.json'), mortality: read('mortality.json'), content });
  return realData;
}

// ---------------------------------------------------------------------------------------------------------------
// charts

test('sparkline: area, line, emphasised endpoint, title and a viewBox', () => {
  const svg = charts.sparkline([50, 55, null, 60, 70], { width: 120, height: 32, color: 'var(--st-health)', min: 0, max: 100, label: '健康' });
  assert.equal(svg.localName, 'svg');
  assert.ok(svg.classList.contains('c-chart') && svg.classList.contains('c-spark'));
  assert.equal(svg.getAttribute('viewBox'), '0 0 120 32');
  assert.match(svg.getAttribute('style'), /width:100%/);
  assert.match(svg.querySelector('title').textContent, /健康：最近 70/);
  const paths = svg.querySelectorAll('path');
  assert.ok(paths.some((p) => p.getAttribute('stroke') === 'var(--st-health)'), 'line path in the series colour');
  assert.ok(paths.some((p) => /^url\(#/.test(p.getAttribute('fill') || '')), 'gradient area fill');
  const dots = svg.querySelectorAll('circle');
  assert.equal(dots.length, 1, 'only the endpoint is emphasised');
  assertThemedColours(svg);
});

test('sparkline: empty and single values degrade gracefully, dashedFrom dashes the tail', () => {
  const empty = charts.sparkline([], {});
  assert.match(empty.querySelector('title').textContent, /暂无数据/);
  assert.equal(empty.querySelectorAll('circle').length, 0);
  const one = charts.sparkline([42], { min: 0, max: 100 });
  assert.equal(one.querySelectorAll('circle').length, 1);
  const dashed = charts.sparkline([10, 20, 30, 40, 50], { dashedFrom: 3, color: 'currentColor' });
  assert.ok(dashed.querySelectorAll('path').some((p) => p.getAttribute('stroke-dasharray')));
  assertThemedColours(dashed);
});

test('lineChart: hatched projection band, dashed projected segment, end markers, labelled only where data reaches', () => {
  const years = [];
  for (let y = 2000; y <= 2040; y++) years.push(y);
  const a = years.map((y) => 40 + (y - 2000) * 0.5);       // 40..60
  const b = years.map((y, i) => (i % 9 === 4 ? null : 50)); // with gaps
  const svg = charts.lineChart([
    { name: '健康', values: a, color: 'var(--st-health)' },
    { name: '快乐', values: b, color: 'var(--st-happiness)' },
  ], { years, height: 220, yMin: 0, yMax: 100, projectionFrom: 2027, title: '五项指标' });
  assert.equal(svg.getAttribute('viewBox'), '0 0 640 220');
  assert.equal(svg.getAttribute('tabindex'), '0');
  assert.match(svg.getAttribute('aria-label'), /五项指标：健康从 2000 年的 40 到 2040 年的 60/);
  assert.match(svg.getAttribute('aria-label'), /2026 年之后为推演/);
  assert.equal(svg.querySelectorAll('rect.c-proj-band').length, 1);
  assert.ok(svg.querySelectorAll('path.c-series').some((p) => p.getAttribute('stroke-dasharray') === '5 4'), 'dashed projection');
  assert.equal(svg.querySelectorAll('circle.c-end').length, 2, 'one emphasised endpoint per series');
  assert.ok(svg.querySelectorAll('path.c-area').length >= 1, 'area fill under the first series');
  assert.ok(svg.querySelectorAll('line.c-grid').length >= 3, 'faint grid');
  const yLabels = svg.querySelectorAll('text.c-tick').filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent);
  assert.ok(yLabels.includes('50'), `y labels: ${yLabels}`);
  assert.ok(!yLabels.includes('0') && !yLabels.includes('100'), `no labels far outside the data: ${yLabels}`);
  assert.ok(textsOf(svg, 'text.c-band-label').includes('推演'));
  const xLabels = svg.querySelectorAll('text.c-tick').filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent);
  assert.ok(xLabels.includes('2000') && xLabels.includes('2040'), `x labels: ${xLabels}`);
  assertThemedColours(svg);
});

test('lineChart: keyboard focus shows a crosshair tooltip that arrow keys move', () => {
  const years = [2020, 2021, 2022, 2023, 2024];
  const svg = charts.lineChart([{ name: '财富', values: [10, 20, 30, 40, 50], color: 'var(--st-wealth)' }], { years, height: 160 });
  svg.dispatchEvent({ type: 'focus', bubbles: false });
  let tip = svg.querySelector('g.c-tip');
  assert.ok(tip, 'tooltip shown on focus');
  assert.match(tip.textContent, /2024/);
  svg.dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
  tip = svg.querySelector('g.c-tip');
  assert.match(tip.textContent, /2023/);
  assert.match(tip.textContent, /40/);
  assert.equal(svg.querySelectorAll('g.c-hover').length, 1, 'only one hover layer at a time');
  svg.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(svg.querySelectorAll('g.c-hover').length, 0);
  assertThemedColours(svg);
});

test('lineChart: empty input renders an empty state instead of throwing', () => {
  for (const input of [[], [{ name: 'x', values: [] }], [{ name: 'x', values: [null, null] }], null]) {
    const svg = charts.lineChart(input, { years: [2000, 2001] });
    assert.ok(svg.textContent.includes('暂无数据'));
  }
  const allProj = charts.lineChart([{ name: '人口', values: [1, 2, 3] }], { years: [2030, 2040, 2050], projectionFrom: 2027 });
  assert.match(allProj.getAttribute('aria-label'), /全部为推演/);
});

test('survivalChart: personal vs baseline, current-age marker, median and highlighted ages; 0..1 and 0..100 agree', () => {
  const ages = [];
  for (let a = 30; a <= 110; a++) ages.push(a);
  const personal = ages.map((a) => Math.exp(-Math.pow((a - 30) / 55, 4)));
  const baseline = ages.map((a) => Math.exp(-Math.pow((a - 30) / 50, 4)));
  const svg = charts.survivalChart({ ages, personal, baseline }, { currentAge: 30, highlightAges: [60, 80, 100] });
  const label = svg.getAttribute('aria-label');
  assert.match(label, /活到 60 岁的概率约 \d+%/);
  assert.match(label, /一半的可能活过 80 岁/);
  const texts = svg.querySelectorAll('text').map((t) => t.textContent);
  assert.ok(texts.some((t) => t.startsWith('现在 30')), 'current age marker');
  assert.ok(texts.some((t) => /^中位 \d+岁$/.test(t)), 'median label');
  assert.ok(texts.some((t) => /^80岁 \d+%$/.test(t)), `highlight label: ${texts}`);
  assert.equal(svg.querySelectorAll('path.c-series').length, 2);
  assertThemedColours(svg);
  const pct = charts.survivalChart({ ages, personal: personal.map((v) => v * 100), baseline: baseline.map((v) => v * 100) }, { currentAge: 30 });
  assert.equal(pct.getAttribute('aria-label'), label);
  const none = charts.survivalChart({}, {});
  assert.match(none.textContent, /生存曲线将在出生后出现/);
});

// ---------------------------------------------------------------------------------------------------------------
// life map

test('lifeMap: rows of ten, tag colours, projected years marked, hollow future up to the expected lifespan, legend', () => {
  const hist = makeHistory(2015, 20); // 2015..2034, ages 0..19
  const el = lifeMap(hist, { birthYear: 2015, expectedYears: 80, projectionFrom: 2027 });
  const lived = el.querySelectorAll('button.c-lm-cell');
  assert.equal(lived.length, 20);
  assert.equal(el.querySelectorAll('div.c-lm-row').length, 8, 'ages 0..79 in rows of ten');
  assert.equal(el.querySelectorAll('span.is-future').length, 60, 'hollow cells for the years not yet lived');
  for (const b of lived) assert.match(b.getAttribute('style'), /--cell: var\(--tag-[a-z]+\)/);
  const projLived = lived.filter((b) => b.classList.contains('is-proj')).map((b) => Number(b.dataset.year));
  assert.deepEqual(projLived, [2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034]);
  assert.ok(lived[19].classList.contains('is-now'));
  assert.equal(lived.filter((b) => b.tabIndex === 0).length, 1, 'one roving tab stop');
  const legend = el.querySelector('div.c-lm-legend').textContent;
  assert.ok(legend.includes('出生') && legend.includes('求学') && legend.includes('推演年份（2027 起）') && legend.includes('尚未到来'));
  assert.ok(el.querySelector('p.c-lm-hint'));
});

test('lifeMap: tap/click and keyboard select a year and show year, age and headline', () => {
  const hist = makeHistory(2000, 30);
  const picked = [];
  const el = lifeMap(hist, { birthYear: 2000, expectedYears: 75, onSelect: (r) => picked.push(r) });
  doc.body.append(el);
  const cell = el.querySelector('button[data-age="5"]');
  cell.click();
  assert.equal(picked.length, 1);
  assert.equal(picked[0].year, 2005);
  assert.equal(cell.getAttribute('aria-pressed'), 'true');
  const detail = el.querySelector('div.c-lm-detail').textContent;
  assert.ok(detail.includes('2005') && detail.includes('5 岁') && detail.includes('第 5 年的记事') && detail.includes('真实历史'), detail);
  cell.focus();
  cell.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
  assert.equal(doc.activeElement.dataset.age, '6');
  doc.activeElement.dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.equal(doc.activeElement.dataset.age, '16');
  doc.activeElement.dispatchEvent({ type: 'keydown', key: 'End' });
  assert.equal(doc.activeElement.dataset.age, '19');
  doc.activeElement.click();
  assert.match(el.querySelector('div.c-lm-detail').textContent, /2019/);
  el.select(2028);
  assert.match(el.querySelector('div.c-lm-detail').textContent, /推演/);
  el.remove();
});

test('lifeMap: update, dead lives, unknown tags and missing options', () => {
  const el = lifeMap([], { birthYear: 2030, expectedYears: 70, projectionFrom: undefined, legend: undefined });
  assert.match(el.textContent, /出生之后/);
  assert.equal(el.querySelectorAll('span.is-future').length, 70);
  assert.ok(el.querySelector('div.c-lm-legend'), 'legend stays on when the option is passed as undefined');
  assert.ok(el.querySelectorAll('span.is-future').every((c) => c.classList.contains('is-proj')), 'years from 2027 count as projection by default');
  el.update(makeHistory(2030, 3));
  assert.equal(el.querySelectorAll('button.c-lm-cell').length, 3);
  const dead = lifeMap([...makeHistory(1990 + 10, 14, { death: true }), { year: 2005, age: 5, tag: 'mystery' }], { birthYear: 2000, expectedYears: 80, dead: true });
  assert.equal(dead.querySelectorAll('span.is-future').length, 0, 'no future cells after death');
  assert.equal(dead.querySelectorAll('div.c-lm-row').length, 2);
  assert.ok(dead.querySelector('button[data-age="5"]').classList.contains('t-calm'), 'unknown tags fall back to calm');
  assert.ok(!dead.querySelector('.is-now'));
  for (const t of YEAR_TAGS) assert.ok(typeof t === 'string');
});

// ---------------------------------------------------------------------------------------------------------------
// cards

const cardState = () => ({
  id: 'life-test-0001', seed: 42, worldLabel: '世界线 ZNN-2SU · 渐进转型',
  birth: {
    mode: 'random', year: 2000, date: '2000-03-14', time: '08:15:30', country: 'CHN', sex: 'female', urban: false,
    familyPct: 0.35, parentsEdu: 'secondary', siblings: 1, motherAge: 26, fatherAge: 28, name: '李欣怡', nameLatin: 'Li Xinyi',
    notes: ['家里在山坡上种茶', '外婆一起生活'],
  },
  person: {
    name: '李欣怡', sex: 'female', country: 'CHN',
    education: { level: 'tertiary', field: '护理' }, career: { status: 'retired', title: '护士长' },
    relationship: { status: 'married' }, children: [{ name: 'a' }, { name: 'b' }],
    money: { cash: 20000, debt: 1000, portfolio: { stocks: 15000, bonds: 0, gold: 0, property: 80000, crypto: 0 } },
  },
  stats: { health: 10, happiness: 66, knowledge: 72, relationships: 80, wealth: 41 },
  history: makeHistory(2000, 79, { death: true }),
  year: 2078, age: 78,
  dead: {
    year: 2078, age: 78, date: '2078-11-02', cause: { id: 'cvd', name: '心血管疾病', detail: '心力衰竭' }, place: 'CHN',
    summary: '她在家人身边安静地离开。', stats: { health: 8, happiness: 66, knowledge: 72, relationships: 80, wealth: 41 },
    lifeExpAtBirth: 74.2, percentile: 0.61,
  },
});

test('cards: archive numbers and file names are stable and safe', () => {
  const s = cardState();
  const no = cards.archiveNumber(s);
  assert.match(no, /^LL-2000-CHN-[0-9A-F]{6}$/);
  assert.equal(cards.archiveNumber(cardState()), no);
  const bad = { birth: { name: 'a/b:c*?"<>|', year: 2001 } };
  assert.equal(cards.cardFileName(bad, 'birth'), '人生长河-出生登记-abc-2001.png');
  assert.equal(cards.cardFileName(s, 'death'), '人生长河-一生档案-李欣怡-2078.png');
  assert.equal(cards.CARD_FOOTER, '人生长河 · 2000–2090 · 真实数据 + 推演');
});

test('cards: birth card draws a 1080x1350 PNG with the key facts, seal and footer', async () => {
  const data = loadReal();
  doc.fonts = { ready: Promise.resolve(), loaded: [], load(spec, text) { this.loaded.push([spec, text]); return Promise.resolve([]); } };
  drawn.length = 0;
  created.length = 0;
  const blob = await cards.birthCard(cardState(), data);
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'image/png');
  const canvas = created.find((c) => c.localName === 'canvas' && c.width === 1080);
  assert.ok(canvas && canvas.height === 1350, 'card canvas is 1080x1350');
  assert.ok(doc.fonts.loaded.length >= 1 && doc.fonts.loaded.some(([spec]) => /700 80px/.test(spec)), 'display font loaded before drawing');
  assert.ok(doc.fonts.loaded[0][1].includes('李') && doc.fonts.loaded[0][1].includes('欣'), 'glyphs requested');
  const all = drawn.join('\n');
  for (const s of ['出生登记', '李欣怡', 'Li Xinyi', cards.CARD_FOOTER, '出生时的世界 · 2000', '真实数据', '中国']) assert.ok(all.includes(s), `missing "${s}"`);
  assert.ok(drawn.some((t) => /^LL-2000-CHN-/.test(t)), 'archive number drawn');
  assert.ok(!/undefined|NaN|\[object/.test(all), 'no broken values drawn');
  delete doc.fonts;
});

test('cards: projected birth year carries the projection badge; minimal state still renders', async () => {
  const data = loadReal();
  drawn.length = 0;
  const s = cardState();
  s.birth.year = 2041; s.birth.date = '2041-07-01'; s.birth.country = 'NGA'; s.birth.notes = [];
  s.birth.customText = '出生在一个靠海的渔村，父亲是船长';
  const blob = await cards.birthCard(s, data);
  assert.equal(blob.type, 'image/png');
  assert.ok(drawn.includes('推演'));
  assert.ok(drawn.some((t) => t.includes('自述出身')));
  drawn.length = 0;
  const bare = await cards.birthCard({}, {});
  assert.equal(bare.type, 'image/png');
  assert.ok(drawn.includes('无名'));
  assert.ok(!/undefined|NaN/.test(drawn.join('')));
});

test('cards: death card draws facts, mini life map legend, stats, epitaph and biography', async () => {
  const data = loadReal();
  drawn.length = 0;
  const bio = '她生于茶山脚下的村庄。'.repeat(30);
  const blob = await cards.deathCard(cardState(), data, { epitaph: '她把日子过成了一杯慢慢变浓的茶', bio, title: '茶山上的护士长' });
  assert.equal(blob.type, 'image/png');
  const all = drawn.join('\n');
  for (const s of ['死亡登记', '李欣怡', '享年 78 岁', '心血管疾病（心力衰竭）', '一生 · 每格一年', '斜纹 = 推演年份', '「茶山上的护士长」', cards.CARD_FOOTER, '健康', '财富']) {
    assert.ok(all.includes(s), `missing "${s}"`);
  }
  assert.ok(all.includes('她把日子过成'), 'epitaph drawn');
  assert.ok(drawn.filter((t) => t.includes('茶山脚下')).length <= 4, 'biography excerpt is bounded');
  assert.ok(drawn.some((t) => t.endsWith('…')), 'long biography is ellipsised');
  assert.ok(all.includes('寿命长于同年出生者的 61%'));
  assert.ok(!/undefined|NaN|\[object/.test(all));
  drawn.length = 0;
  const minimal = await cards.deathCard({ birth: { year: 2010 } }, {}, {});
  assert.equal(minimal.type, 'image/png');
});

test('saveBlob: downloads capability success, decline, unknown errors, absence and the local fallback', async () => {
  const blob = new Blob(['x'], { type: 'image/png' });
  const calls = [];
  globalThis.claude = { use: async (name) => (name === 'downloads' ? { save: async (req) => { calls.push(req); return { status: 'saved' }; } } : null) };
  let r = await cards.saveBlob(blob, 'card.png');
  assert.deepEqual([r.ok, r.status], [true, 'saved']);
  assert.equal(calls[0].filename, 'card.png');
  assert.equal(calls[0].data, blob, 'the Blob is handed over as-is');

  globalThis.claude = { use: async () => ({ save: async () => { throw Object.assign(new Error('no'), { code: 'declined' }); } }) };
  r = await cards.saveBlob(blob, 'card.png');
  assert.deepEqual([r.ok, r.status, r.code], [false, 'declined', 'declined']);
  assert.ok(r.message);

  globalThis.claude = { use: async () => ({ save: async () => { throw Object.assign(new Error('?'), { code: 'capability_removed' }); } }) };
  r = await cards.saveBlob(blob, 'card.png');
  assert.deepEqual([r.ok, r.code], [false, 'unavailable']);

  globalThis.claude = { use: async () => null };
  r = await cards.saveBlob(blob, 'card.png');
  assert.deepEqual([r.ok, r.code], [false, 'unavailable']);

  globalThis.claude = { use: async () => { throw new Error('boom'); } };
  r = await cards.saveBlob(blob, 'card.png');
  assert.equal(r.ok, false);

  delete globalThis.claude;
  created.length = 0;
  let clicked = null;
  const before = doc.body.childNodes.length;
  const origCreate = doc.createElement;
  doc.createElement = (t) => { const el = origCreate(t); if (t === 'a') el.addEventListener('click', () => { clicked = { href: el.href, download: el.download }; }); return el; };
  r = await cards.saveBlob(blob, 'local.png');
  doc.createElement = origCreate;
  assert.deepEqual([r.ok, r.status], [true, 'downloaded']);
  assert.equal(clicked.download, 'local.png');
  assert.match(clicked.href, /^blob:/);
  assert.equal(doc.body.childNodes.length, before, 'temporary link removed');

  r = await cards.saveBlob(null, 'x.png');
  assert.deepEqual([r.ok, r.code], [false, 'bad_request']);
});

// ---------------------------------------------------------------------------------------------------------------
// about screen

const SECTION_TITLES = ['这是什么', '哪些是真实的', '哪些是推演', '哪些是虚构', '方法', '数据来源', '历史事件库', '免责声明', '与原作'];

test('about: renders every section with no data and no content', () => {
  const root = doc.createElement('div');
  const cleanup = about.mount(root, {}, { data: {} });
  assert.deepEqual(textsOf(root, 'h2.c-sec-title'), SECTION_TITLES);
  assert.match(root.textContent, /历史事件库仍在整理中/);
  assert.match(root.textContent, /1in8b\.life/);
  assert.equal(typeof cleanup, 'function');
  cleanup();
});

test('about: real data lists WDI indicators with last observed years, projection rules, world-line branches and sources', () => {
  const data = loadReal();
  const root = doc.createElement('div');
  const cleanup = about.mount(root, {}, { data, ai: { available: false }, getLife: () => ({ worldLabel: '世界线 TEST-001' }) });
  const wb = Object.keys(data.meta.wb_indicators);
  const rows = root.querySelectorAll('section#c-about-real tbody tr');
  assert.equal(rows.length, wb.length);
  assert.ok(rows.every((r) => /\d{4} 年|推导|推算|无观测/.test(r.textContent)), 'each indicator shows its last observed year');
  const rules = root.querySelectorAll('section#c-about-proj dl.c-rules dt');
  assert.equal(rules.length, wb.filter((k) => data.meta.wb_indicators[k].projection).length);
  assert.match(root.querySelector('section#c-about-proj').textContent, /世界线 TEST-001/);
  const dims = data.content?.future?.dimensions || [];
  assert.equal(root.querySelectorAll('div.c-dim').length, dims.length);
  if (dims.length) assert.ok(root.querySelectorAll('span.c-prob-v').every((s) => /%$/.test(s.textContent)));
  const hist = data.content?.history || [];
  if (hist.length) assert.match(root.querySelector('section#c-about-real').textContent, new RegExp(`${hist.length.toLocaleString('zh-CN')} 条`));
  // primary sources + deduplicated domains, all safe links
  const links = root.querySelectorAll('a');
  assert.ok(links.some((a) => a.getAttribute('href') === 'https://population.un.org/wpp/'));
  assert.ok(links.some((a) => /worldbank\.org/.test(a.getAttribute('href'))));
  for (const a of links) {
    assert.match(a.getAttribute('href'), /^https?:\/\//);
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(a.getAttribute('target'), '_blank', 'external links open in a new tab (artifact frame)');
  }
  const domains = textsOf(root, 'ul.c-domain-list a');
  assert.equal(new Set(domains).size, domains.length, 'domains are deduplicated');
  assert.ok(root.querySelector('figure.c-figure svg'), 'example chart rendered');
  // the headline numbers are counted from the loaded data, never typed in
  const tiles = textsOf(root, 'div.c-tile-v');
  const nCountries = (data.isoList || Object.keys(data.countries)).length;
  assert.ok(nCountries > 200, 'countries.json covers every country');
  assert.ok(tiles.includes(nCountries.toLocaleString('zh-CN')), `country tile shows ${nCountries}: ${tiles.join(' | ')}`);
  assert.ok(tiles.includes(hist.filter((e) => e && e.title).length.toLocaleString('zh-CN')), 'history tile matches the event count');
  assert.ok(tiles.includes(String(dims.length)), 'world-line dimension tile matches the data');
  cleanup();
});

test('about: the history library filters by category, country, year range and search text', async () => {
  const data = loadReal();
  const hist = (data.content?.history || []).filter((e) => e && e.title);
  if (!hist.length) return; // content not built yet: the empty state is covered above
  const root = doc.createElement('div');
  const cleanup = about.mount(root, { section: 'library' }, { data });
  const lib = root.querySelector('div.c-lib');
  const selects = lib.querySelectorAll('select');
  const byLabel = (l) => selects.find((s) => s.getAttribute('aria-label') === l);
  const items = () => lib.querySelectorAll('li.c-ev');
  assert.equal(items().length, Math.min(40, hist.length));
  assert.match(lib.querySelector('p.c-lib-count').textContent, /^共 \d+ 条/);
  if (hist.length > 40) {
    lib.querySelector('button.c-lib-more').click();
    assert.equal(items().length, Math.min(80, hist.length));
  }
  const cat = hist[0].category;
  const catSel = byLabel('类别');
  catSel.value = cat;
  catSel.dispatchEvent({ type: 'change' });
  const n = hist.filter((e) => e.category === cat).length;
  assert.equal(items().length, Math.min(40, n));
  catSel.value = '';
  catSel.dispatchEvent({ type: 'change' });

  const iso = hist.find((e) => e.scope === 'countries' && (e.countries || []).length)?.countries[0];
  if (iso) {
    const cSel = byLabel('国家或地区');
    cSel.value = iso;
    cSel.dispatchEvent({ type: 'change' });
    const name = data.country(iso).name;
    assert.ok(items().length >= 1);
    const wideOff = lib.querySelector('label.c-check input');
    wideOff.checked = false;
    wideOff.dispatchEvent({ type: 'change' });
    assert.ok(items().every((li) => li.textContent.includes(name)), 'only events naming the country');
    lib.querySelectorAll('button').find((b) => b.textContent === '清除筛选').click();
  }

  const fromSel = byLabel('起始年份');
  const toSel = byLabel('结束年份');
  const yearOptions = fromSel.querySelectorAll('option').map((o) => Number(o.value));
  assert.ok(yearOptions.length >= 1 && yearOptions.every((y) => y >= 2000 && y <= 2026), 'year range limited to real history');
  const y0 = yearOptions[Math.floor(yearOptions.length / 2)];
  // the range is normalised when from > to
  fromSel.value = String(y0 + 1 <= yearOptions[yearOptions.length - 1] ? y0 + 1 : y0); toSel.value = String(y0);
  fromSel.dispatchEvent({ type: 'change' });
  const y1 = Number(fromSel.value);
  const expected = hist.filter((e) => {
    const a = Number(e.year), b = Number(e.end_year) || a;
    return a <= y1 && Math.max(a, b) >= y0;
  }).length;
  assert.equal(items().length, Math.min(40, expected));
  for (const li of items()) {
    const [a, b] = li.querySelector('div.c-ev-when').textContent.split('–').map(Number);
    assert.ok(a <= y1 && (b || a) >= y0, `in range ${y0}-${y1}: ${a}-${b}`);
  }
  fromSel.value = String(Math.min(...hist.map((e) => e.year)));
  toSel.value = '2026';
  toSel.dispatchEvent({ type: 'change' });

  const term = hist[3 % hist.length].title.slice(0, 4);
  const q = lib.querySelector('input.c-input');
  q.value = term;
  q.dispatchEvent({ type: 'input' });
  await wait(220);
  assert.ok(items().length >= 1);
  assert.ok(items().every((li) => li.textContent.toLowerCase().includes(term.toLowerCase())));
  q.value = '这个词不可能出现在任何事件里';
  q.dispatchEvent({ type: 'input' });
  await wait(220);
  assert.equal(items().length, 0);
  assert.match(lib.querySelector('p.c-lib-count').textContent, /没有符合条件/);
  cleanup();
});

test('about: hostile content is shown as text and unsafe links are never created', () => {
  const content = {
    history: [{
      id: 'x', year: 2010, scope: 'countries', countries: ['ZZZ'], category: 'politics', importance: 3,
      title: '<img src=x onerror=alert(1)>', summary: '<b>粗体</b>', sources: ['javascript:alert(1)', 'https://example.org/a', '某报告，第 3 页'],
    }],
    future: { dimensions: [{ id: 'd', title: '维度', branches: [{ id: 'b', title: '<script>', prob: 0.4, modifiers: { gdp_growth_add: 0.3, mortality_mult: 0.95 } }] }] },
  };
  const root = doc.createElement('div');
  const cleanup = about.mount(root, {}, { data: { content, countries: {} } });
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));
  const hrefs = root.querySelectorAll('a').map((a) => a.getAttribute('href'));
  assert.ok(hrefs.every((u) => /^https?:\/\//.test(u)), `${hrefs}`);
  assert.ok(hrefs.includes('https://example.org/a'));
  assert.ok(root.textContent.includes('某报告，第 3 页'));
  assert.match(root.textContent, /GDP 年增速 \+0\.3 个百分点/);
  assert.match(root.textContent, /死亡率 ×0\.95/);
  assert.match(root.textContent, /40%/);
  cleanup();
});

// ---------------------------------------------------------------------------------------------------------------
// decision overlay (screens/decision.js)

async function loadDecision() {
  if (!FakeNode.prototype.contains) {
    FakeNode.prototype.contains = function contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; };
  }
  if (!doc.getElementById) doc.getElementById = (id) => doc.querySelector('#' + id);
  if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = (fn) => realSetTimeout(() => fn(Date.now()), 0);
  if (!doc.querySelector('#app')) {
    const appEl = doc.createElement('div');
    appEl.id = 'app';
    const shell = doc.createElement('div');
    shell.className = 'll-shell';
    shell.inert = false;
    appEl.appendChild(shell);
    doc.body.appendChild(appEl);
  }
  return import('../src/ui/screens/decision.js');
}

const DECISION = {
  id: 'd-test', year: 2010, age: 10, kind: 'milestone', title: '十岁的岔路口', situation: '眼前有两条路。',
  options: [{ id: 'a', label: '稳妥', detail: '慢慢来。', risk: 'low' }, { id: 'b', label: '冒险', detail: '试试看。', risk: 'high' }],
  allowCustom: true, source: 'local',
};
const RESOLVED = { resolution: { narrative: '日子慢慢变了。', effects: { happiness: 3 }, set: {}, threads: [] }, source: 'local' };
const keyFromBody = (key) => doc.dispatchEvent({ type: 'keydown', key, target: doc.body });

test('decision overlay: keys work even when focus fell back to the page; Escape continues; the shell is inert while open', async () => {
  const { openDecision } = await loadDecision();
  const shell = doc.querySelector('div.ll-shell');
  const chosen = [];
  let continued = 0;
  const close = openDecision({ data: {} }, DECISION, {
    state: { year: 2010, age: 10, person: { country: 'CHN' } }, data: {},
    onChoose: async (c) => { chosen.push(c); return RESOLVED; },
    onContinue: () => { continued++; },
  });
  const ov = doc.body.querySelector('div.g-ov');
  assert.ok(ov, 'overlay is appended to <body>');
  assert.equal(shell.inert, true, 'the page shell is inert');
  assert.ok(doc.documentElement.classList.contains('g-lock'));
  const dlg = ov.querySelector('div.g-dlg');
  assert.equal(dlg.getAttribute('role'), 'dialog');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  assert.ok(ov.querySelector('#' + dlg.getAttribute('aria-labelledby')), 'dialog is labelled by its title');

  doc.activeElement = doc.body;   // e.g. after a click on the backdrop
  keyFromBody('b');
  await wait(10);
  assert.deepEqual(chosen, [{ optionId: 'b' }]);
  assert.equal(ov.querySelector('span.g-res-choice-k').textContent, '你选择了');
  const cont = ov.querySelector('button.g-res-cont');
  assert.ok(cont, 'result view with 继续');
  const narrId = cont.getAttribute('aria-describedby');
  assert.ok(narrId && ov.querySelector('#' + narrId).textContent.includes('日子慢慢变了'), '继续 is described by the outcome');

  keyFromBody('Escape');
  assert.equal(continued, 1, 'Escape continues from the result');
  assert.equal(close.isOpen(), false);
  assert.equal(ov.parentNode, null, 'overlay removed');
  assert.equal(shell.inert, false);
  assert.ok(!doc.documentElement.classList.contains('g-lock'));
  keyFromBody('a');
  await wait(5);
  assert.equal(chosen.length, 1, 'a closed overlay no longer listens to keys');
});

test('decision overlay: auto-choose labels only its own pick; a click during the highlight beat stays the player\'s', async () => {
  const { openDecision } = await loadDecision();
  const base = { state: { year: 2010, age: 10, person: { country: 'CHN' } }, data: {}, auto: true, autoDelay: 20, onAuto: () => ({ optionId: 'a' }) };

  // the auto pick lands on its own
  const picks = [];
  const close1 = openDecision({ data: {} }, DECISION, { ...base, onChoose: async (c) => { picks.push(c); return RESOLVED; } });
  const ov1 = doc.body.querySelector('div.g-ov');
  await wait(1100);
  assert.deepEqual(picks, [{ optionId: 'a' }]);
  assert.equal(ov1.querySelector('span.g-res-choice-k').textContent, '自动选择');
  close1();

  // the player clicks another option while the auto pick is being highlighted
  const picks2 = [];
  const close2 = openDecision({ data: {} }, DECISION, { ...base, onChoose: async (c) => { picks2.push(c); return RESOLVED; } });
  const ov2 = doc.body.querySelector('div.g-ov');
  await wait(150);
  assert.ok(ov2.querySelector('button.g-opt--picked'), 'the auto pick is highlighted first');
  ov2.querySelectorAll('button.g-opt')[1].click();
  await wait(900);
  assert.deepEqual(picks2, [{ optionId: 'b' }], 'only the player\'s choice is resolved');
  assert.equal(ov2.querySelector('span.g-res-choice-k').textContent, '你选择了');
  assert.equal(ov2.querySelector('span.g-auto-line').textContent, '', 'no automatic continue after the player chose');
  close2();
});

// ---------------------------------------------------------------------------------------------------------------
// interactivity layer v2: side sheet, family and money panels, death additions, settings and home preferences

let v2 = null;
async function loadV2() {
  if (v2) return v2;
  await loadDecision();   // contains(), getElementById(), requestAnimationFrame and the #app shell
  if (typeof globalThis.cancelAnimationFrame !== 'function') globalThis.cancelAnimationFrame = () => {};
  v2 = {
    money: await import('../src/ui/screens/money.js'),
    family: await import('../src/ui/screens/family.js'),
    death: await import('../src/ui/screens/death.js'),
    settings: await import('../src/ui/screens/settings.js'),
    home: await import('../src/ui/screens/home.js'),
    app: await import('../src/ui/app.js'),
    dom: await import('../src/ui/dom.js'),
  };
  return v2;
}
const nextFrame = () => wait(5);
const badText = (s) => /NaN|undefined|Infinity|\[object/.test(s);
const change = (el, value) => {
  if (value !== undefined) { if (el.getAttribute('type') === 'radio') el.checked = true; else el.value = value; }
  el.dispatchEvent({ type: 'change' });
};

/** A fake engine implementing the CONTRACT §10 panel API; `log` records every write. */
function v2Engine(log = []) {
  return {
    log,
    incomeBreakdown: (d, w, s) => ({
      income: 30000,
      items: [
        { key: 'living', label: '吃穿住行', amount: 12000 },
        { key: 'housing', label: '住房', amount: 7000 },
        { key: 'dining', label: '聚餐·送礼', amount: ((s.habits && s.habits.dining) || 0) * 900 },
        { key: 'savings', label: '存下来', amount: 6000 },
      ],
    }),
    investOptions: () => [{ id: 'bank', label: '银行存款', hint: '最稳' }, { id: 'balanced', label: '平衡型基金', hint: '股债搭配' }, { id: 'stocks', label: '股票', hint: '波动大' }],
    setHabit: (s, k, v) => { log.push(['habit', k, v]); s.habits = { ...(s.habits || {}), [k]: v }; },
    setAllocation: (s, a) => { log.push(['alloc', a]); s.person.money.allocation = a; },
    familyView: () => {
      log.push(['view']);
      return {
        members: [
          { role: 'mother', name: '母亲', sex: 'female', age: 62, alive: true, status: '退休在家', closeness: 'close', note: '' },
          { role: 'father', name: '父亲', sex: 'male', age: 64, alive: false, status: '', closeness: 'ok', note: '2027 年病逝' },
          { role: 'partner', name: '<img src=x onerror=alert(1)>', sex: 'male', age: 36, alive: true, status: '做工程师', closeness: 'close', note: '2026 年结婚' },
          { role: 'child', name: '小禾', sex: 'female', age: 4, alive: true, status: '上幼儿园', closeness: 'ok', note: '' },
          { role: 'sibling', name: '林雪', sex: 'female', older: true, age: 38, alive: true, status: '在外地工作', closeness: 'distant', note: '' },
        ],
        friends: 3,
        pets: [{ name: '阿黄', kind: 'dog', age: 4 }],
        habits: [{ key: 'dining', label: '聚餐·送礼', level: 1 }],
        conditions: [{ id: 'hypertension', name: '高血压', sinceYear: 2028, severity: 2 }],
      };
    },
    nameChild: (s, i, n) => { log.push(['name', i, n]); s.person.children[i].name = n; s.namingPending = null; return []; },
  };
}

function v2Life(over = {}) {
  return {
    id: 'L-v2', seed: 7, worldSeed: 20260424, year: 2030, age: 35,
    birth: { year: 1995 + 0 + 0, country: 'CHN', sex: 'female', name: '林晓', date: '1995-04-02' },
    person: {
      name: '林晓', sex: 'female', country: 'CHN',
      parents: { mother: { age: 62, alive: true }, father: { age: 64, alive: false } },
      relationship: { status: 'married', partner: { name: '周远', sinceYear: 2026 } },
      children: [{ name: '小禾', sex: 'female', birthYear: 2026, alive: true }, { name: '', sex: 'male', birthYear: 2030, alive: true }],
      siblings: 1,
      money: { cash: 5000, debt: 2000, income: 30000, portfolio: { stocks: 3000, bonds: 0, gold: 0, property: 0, crypto: 0 }, allocation: null },
      conditions: [],
    },
    habits: { dining: 1 },
    stats: { health: 80, happiness: 60, knowledge: 60, relationships: 60, wealth: 40 },
    history: [], log: [], stars: [], notes: [], rare: [],
    ...over,
  };
}

test('money panel: income bar with legend, exact habit costs, habit and allocation writes go through the engine', async () => {
  const { money } = await loadV2();
  const data = loadReal();
  const E = v2Engine();
  const changes = [];
  const state = v2Life();
  const root = doc.createElement('div');
  money.mount(root, { state, world: null, changed: (k) => changes.push(k), deps: { engine: E } }, { data });

  const segs = root.querySelectorAll('div.ll-mn-bd span.ll-mn-seg');
  assert.equal(segs.length, 4, 'one segment per spending item');
  assert.ok(segs.every((s) => /^var\(--cat-[1-7]\)$/.test(s.style.background)), 'segment colours are theme tokens');
  const bar = root.querySelector('div.ll-mn-bd div.ll-mn-bar');
  assert.equal(bar.getAttribute('role'), 'img');
  assert.match(bar.getAttribute('aria-label'), /^一年收入的去向：吃穿住行 40%/);
  const rows = root.querySelectorAll('li.ll-mn-row');
  assert.equal(rows.length, 4, 'the legend lists every segment (it doubles as the table view)');
  segs[1].dispatchEvent({ type: 'pointerenter' });
  assert.ok(rows[1].classList.contains('is-hot') && segs[0].classList.contains('is-dim'), 'hovering a segment highlights its legend row');
  assert.match(root.querySelector('p.ll-mn-cap').textContent, /^住房 · .+ · 23%$/);
  assert.ok(!badText(root.textContent), 'no broken values');
  assert.match(root.querySelector('p.ll-pn-foot').textContent, /2021 年的购买力/);

  const habits = root.querySelectorAll('fieldset.ll-habit');
  assert.deepEqual(habits.map((f) => f.dataset.habit), ['dining', 'parents', 'travel', 'learning', 'health', 'charity']);
  const diningCosts = habits[0].querySelectorAll('span.ll-seg-cost').map((s) => s.textContent);
  assert.equal(diningCosts[0], '0');
  assert.ok(diningCosts[1].endsWith('/年') && !diningCosts[1].startsWith('约'), `exact engine price: ${diningCosts[1]}`);
  assert.ok(habits[2].querySelectorAll('span.ll-seg-cost')[1].textContent.startsWith('约 '), 'travel is not itemised: an estimate');
  change(root.querySelector('#ll-mn-hb-dining-2'), true);
  assert.deepEqual(E.log.filter((x) => x[0] === 'habit'), [['habit', 'dining', 2]]);
  assert.deepEqual(changes, ['habit']);
  assert.match(habits[0].querySelector('p.ll-habit-eff').textContent, /人际↑ · 快乐略↑ · 财富↓/);
  assert.ok(root.querySelectorAll('li.ll-mn-row').some((r) => r.textContent.includes('聚餐·送礼')), 'the breakdown follows the new level');

  // savings: auto -> own mix -> slider -> preset -> auto
  const modes = root.querySelectorAll('fieldset.ll-mn-mode input');
  assert.equal(modes[0].checked, true);
  assert.equal(root.querySelector('div.ll-mn-custom').hidden, true);
  change(modes[1], true);
  assert.equal(root.querySelector('div.ll-mn-custom').hidden, false);
  let last = E.log[E.log.length - 1];
  assert.deepEqual(last, ['alloc', { bank: 0.3, balanced: 0.5, stocks: 0.2, crypto: 0 }]);
  const ranges = root.querySelectorAll('input.ll-mn-range');
  assert.equal(ranges.length, 3, 'only the options the engine offers (no crypto here)');
  change(ranges[2], '100');
  last = E.log[E.log.length - 1][1];
  assert.equal(Math.round((last.bank + last.balanced + last.stocks + last.crypto) * 100), 100);
  assert.ok(last.stocks > last.balanced && last.balanced > last.bank);
  assert.match(root.querySelector('p.ll-mn-saved').textContent, /^已保存：银行存款 \d+% · 平衡型基金 \d+% · 股票 \d+%$/);
  root.querySelectorAll('div.ll-mn-presets button').find((b) => b.textContent === '稳妥').click();
  assert.deepEqual(E.log[E.log.length - 1], ['alloc', { bank: 0.7, balanced: 0.3, stocks: 0, crypto: 0 }]);
  change(modes[0], true);
  assert.deepEqual(E.log[E.log.length - 1], ['alloc', null]);
  assert.equal(changes.filter((c) => c === 'allocation').length, 4);
});

test('money panel: a child can only decide learning and health; a finished life is read-only; no engine still works', async () => {
  const { money } = await loadV2();
  const data = loadReal();
  const kid = v2Life({ age: 10, year: 2005, person: { ...v2Life().person, money: { cash: 0, debt: 0, income: 0, portfolio: {} } } });
  const root = doc.createElement('div');
  money.mount(root, { state: kid, deps: { engine: v2Engine() } }, { data });
  assert.match(root.querySelector('p.ll-pn-lock').textContent, /16 岁以后/);
  const locked = root.querySelectorAll('fieldset.ll-habit').filter((f) => f.classList.contains('is-locked')).map((f) => f.dataset.habit);
  assert.deepEqual(locked, ['dining', 'parents', 'travel', 'charity']);
  assert.ok(root.querySelectorAll('fieldset.ll-mn-mode input').every((i) => i.disabled), 'allocation waits until 16');

  const dead = v2Life({ dead: { year: 2070, age: 75 } });
  const root2 = doc.createElement('div');
  money.mount(root2, { state: dead, deps: { engine: v2Engine() } }, { data });
  assert.ok(root2.querySelectorAll('input').every((i) => i.disabled), 'every control is disabled');
  assert.match(root2.textContent, /这一生已经结束/);

  // without the v2 engine functions the panel still renders and writes the contract's state shape
  const bare = v2Life();
  const root3 = doc.createElement('div');
  money.mount(root3, { state: bare, deps: { engine: {} } }, { data });
  assert.match(root3.textContent, /收支明细暂时无法估算/);
  change(root3.querySelector('#ll-mn-hb-travel-1'), true);
  assert.equal(bare.habits.travel, 1);
  const emptyRoot = doc.createElement('div');
  money.mount(emptyRoot, { state: null }, { data });
  assert.match(emptyRoot.textContent, /还没有进行中的人生/);
});

test('family panel: grouped register with ages, closeness and the dead; pets, friends, health; naming and family habits', async () => {
  const { family } = await loadV2();
  const data = loadReal();
  const E = v2Engine();
  const toasts = [];
  const changes = [];
  const switched = [];
  const state = v2Life({ namingPending: { childIndex: 1, sex: 'male', suggestions: ['安然', '子墨', '一鸣'] } });
  const root = doc.createElement('div');
  family.mount(root, { state, changed: (k) => changes.push(k), switchTo: (n) => switched.push(n), deps: { engine: E } }, { data, toast: (t) => toasts.push(t) });
  const heads = textsOf(root, 'h3.ll-pn-h').map((t) => t.replace(/\d+ 人$/, ''));
  assert.deepEqual(heads, ['给儿子取个名字', '父母与长辈', '伴侣', '子女', '兄弟姐妹', '宠物与朋友', '习惯与健康', '家里的安排从今年起生效']);
  const members = root.querySelectorAll('li.ll-fam-m');
  const father = members.find((m) => m.textContent.includes('父亲'));
  assert.ok(father.classList.contains('is-gone') && father.textContent.includes('已离世'));
  assert.equal(father.querySelector('span.ll-fam-close'), null, 'no closeness chip for someone who died');
  assert.deepEqual(textsOf(root, 'span.ll-fam-close').map((t) => t.slice(1)), ['亲近', '亲近', '还好', '疏远']);
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'), 'names are text, never markup');
  assert.ok(members.some((m) => m.textContent.includes('姐姐') && m.textContent.includes('38 岁')));
  assert.ok(root.textContent.includes('阿黄') && root.textContent.includes('狗'));
  assert.equal(root.querySelectorAll('span.ll-fam-dots i').length, 3);
  assert.match(root.textContent, /高血压中度 · 2028 年起/);
  assert.deepEqual(root.querySelectorAll('fieldset.ll-habit').map((f) => f.dataset.habit), ['parents', 'dining']);
  change(root.querySelector('#ll-fam-hb-parents-1'), true);
  assert.deepEqual(E.log.filter((x) => x[0] === 'habit'), [['habit', 'parents', 1]]);
  root.querySelector('button.ll-fam-more').click();
  assert.deepEqual(switched, ['money']);

  // naming: an empty custom name is refused, a suggestion is accepted
  root.querySelector('form.ll-fam-name-form').dispatchEvent({ type: 'submit' });
  assert.match(root.querySelector('p.ll-fam-name-st').textContent, /先写下一个名字/);
  root.querySelectorAll('div.ll-fam-names button').find((b) => b.textContent === '子墨').click();
  assert.deepEqual(E.log.filter((x) => x[0] === 'name'), [['name', 1, '子墨']]);
  assert.ok(changes.includes('name') && toasts[0].includes('子墨'));
  assert.equal(root.querySelector('section.ll-fam-naming'), null, 'the naming slip disappears once named');

  // without engine.familyView the panel reads the state itself
  const root2 = doc.createElement('div');
  family.mount(root2, { state: v2Life(), deps: { engine: {} } }, { data });
  assert.deepEqual(textsOf(root2, 'h3.ll-pn-h').slice(0, 4).map((t) => t.replace(/\d+ 人$/, '')), ['父母与长辈', '伴侣', '子女', '兄弟姐妹']);
  assert.match(root2.textContent, /有 1 个兄弟姐妹/);
});

test('side sheet: a focus-trapped dialog with tabs that pauses the clock, refreshes on outside changes and closes on Escape', async () => {
  const { app: appMod, dom } = await loadV2();
  const data = loadReal();
  const E = v2Engine();
  const host = doc.createElement('div');
  doc.body.append(host);
  const shell = doc.querySelector('div.ll-shell');
  const stack = [];
  const calls = [];
  const ctlOn = {};
  const ctl = { pause: (r) => calls.push(['pause', r]), resume: (r) => calls.push(['resume', r]), on: (evt, fn) => { ctlOn[evt] = fn; return () => { delete ctlOn[evt]; }; } };
  const closedMsgs = [];
  const offClosed = dom.bus.on('panel:closed', (m) => closedMsgs.push(m));
  const state = v2Life();
  const opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();
  const sh = appMod.openSheet('family', { app: { data, controller: ctl, toast() {} }, host, shell, stack, getLife: () => state, worldFor: () => null, params: { deps: { engine: E } } });
  await nextFrame();
  const dlg = host.querySelector('section.ll-sheet');
  assert.equal(dlg.getAttribute('role'), 'dialog');
  assert.equal(dlg.getAttribute('aria-modal'), 'true');
  assert.equal(host.querySelector('#' + dlg.getAttribute('aria-labelledby')).textContent, '家人与生活');
  assert.match(dlg.querySelector('p.ll-sheet-eyebrow').textContent, /林晓 · 35 岁 · 2030 年/);
  assert.equal(shell.inert, true);
  assert.equal(stack.length, 1);
  assert.ok(doc.documentElement.classList.contains('ll-sheet-open'));
  assert.deepEqual(calls, [['pause', 'panel']]);
  assert.match(dlg.querySelector('p.ll-sheet-note').textContent, /时间暂停中/);
  assert.ok(host.querySelector('div.ll-sheet-wrap').classList.contains('is-in'));
  const tabs = dlg.querySelectorAll('button.ll-sheet-tab');
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false']);
  assert.equal(doc.activeElement, tabs[0], 'focus moves into the sheet');

  tabs[1].click();
  assert.equal(sh.name(), 'money');
  assert.equal(dlg.querySelector('h2.ll-sheet-title').textContent, '花钱·投资');
  assert.ok(dlg.querySelector('div.ll-mn-tiles'));
  dlg.querySelector('div.ll-sheet-tabs').dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
  assert.equal(sh.name(), 'family');

  // the panel's own changes do not re-render it; changes from elsewhere and a new year do
  const views = () => E.log.filter((x) => x[0] === 'view').length;
  const before = views();
  dom.bus.emit('life:changed', { source: 'panel', panel: 'family', what: 'habit' });
  await nextFrame();
  assert.equal(views(), before);
  dom.bus.emit('life:changed', { source: 'controller', what: 'focus' });
  ctlOn.year && ctlOn.year({});
  await nextFrame();
  assert.equal(views(), before + 1, 'one coalesced refresh');

  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(sh.isOpen(), false);
  assert.equal(host.querySelector('section.ll-sheet'), null);
  assert.equal(shell.inert, false);
  assert.equal(stack.length, 0);
  assert.ok(!doc.documentElement.classList.contains('ll-sheet-open'));
  assert.deepEqual(calls, [['pause', 'panel'], ['resume', 'panel']]);
  assert.deepEqual(closedMsgs, [{ panel: 'family' }]);
  assert.equal(doc.activeElement, opener, 'focus returns to the button that opened it');
  assert.equal(Object.keys(ctlOn).length, 0, 'controller listeners removed');
  sh.close();
  assert.equal(calls.length, 2, 'closing twice is harmless');

  // a finished life: nothing to pause, read-only note
  const sh2 = appMod.openSheet('money', { app: { data, controller: ctl }, host, shell, stack, getLife: () => v2Life({ dead: { year: 2070, age: 75 } }), params: { deps: { engine: E } } });
  await nextFrame();
  assert.match(host.querySelector('p.ll-sheet-note').textContent, /这一生已经结束/);
  assert.equal(calls.length, 2, 'no pause for a finished life');
  host.querySelector('div.ll-sheet-scrim').click();
  assert.equal(sh2.isOpen(), false, 'the scrim closes the sheet');
  assert.equal(appMod.openSheet('nope', { app: {}, host, getLife: () => state }), null);
  offClosed();
  host.remove();
  opener.remove();
});

function v2DeadLife() {
  const history = [];
  for (let age = 0; age <= 75; age++) {
    history.push({
      year: 1995 + age, age, tag: age === 0 ? 'birth' : 'calm', mood: age === 30 ? 2 : 0, country: 'CHN', headline: age === 30 ? '女儿出生' : '平常的一年',
      stats: { health: 90 - age * 0.6, happiness: age === 30 ? 95 : 60, knowledge: 50, relationships: 60, wealth: age === 50 ? 80 : 40 },
    });
  }
  return v2Life({
    id: 'L-v2-dead', year: 2070, age: 75, history,
    log: [
      { id: '2025-1', year: 2025, age: 30, kind: 'event', text: '女儿出生了，名字叫小禾。' },
      { id: '2041-3', year: 2041, age: 46, kind: 'event', text: '<b>第一次</b>带父母出国旅行。' },
    ],
    stars: ['2041-3', '2025-1'],
    notes: [{ year: 2010, age: 15, kind: 'reflection', prompt: '十五岁的你，最想要什么？', text: '想去看海。' }],
    rare: [{ id: 'species', year: 2052, age: 57, title: '参与命名了一个新物种' }],
    decisions: [], cohort: [],
    dead: { year: 2070, age: 75, date: '2070-03-08', cause: { id: 'cvd', name: '心血管疾病' }, place: 'CHN', lifeExpAtBirth: 74, percentile: 0.55 },
  });
}

test('death screen: summary, birthplace comparison, final words, starred moments, notes, children and rare moments', async () => {
  const { death } = await loadV2();
  const data = loadReal();
  const gone = [];
  const state = v2DeadLife();
  const app = { data, settings: { compareIso: 'IND', compareYear: 1995 }, go: (n, p) => gone.push([n, p]), toast() {}, getLife: () => state };
  const root = doc.createElement('div');
  doc.body.append(root);
  const cleanup = death.mount(root, { state, deps: { engine: {} } }, app);
  const page = root.querySelector('div.g-death');
  const order = page.children.map((c) => c.className.split(' ')[0]);
  assert.ok(order.indexOf('g-recap') > order.indexOf('g-nums') && order.indexOf('g-recap') < order.indexOf('g-death-grid'), `summary near the top: ${order}`);
  const lines = textsOf(root, 'ul.g-recap-lines li');
  assert.ok(lines.length >= 2 && lines[0].startsWith('最快乐的一年是 30 岁（2025 年），那一年：女儿出生'), lines.join('|'));
  const cmp = textsOf(root, 'p.g-cmp-line');
  assert.equal(cmp.length, 2);
  assert.match(cmp[0], /^你实际出生的印度，1995 年出生的人/);
  assert.match(cmp[1], /林晓也出生在中国|林晓出生在中国/);
  const stars = root.querySelectorAll('li.g-star');
  assert.deepEqual(stars.map((s) => s.querySelector('span.g-mono').textContent), ['2025', '2041']);
  assert.ok(stars[1].textContent.includes('<b>第一次</b>'), 'log text stays text');
  assert.equal(textsOf(root, 'blockquote.g-note-t')[0], '想去看海。');
  assert.match(root.querySelector('p.g-note-q').textContent, /15 岁 · 十五岁的你，最想要什么？/);
  const kids = root.querySelectorAll('section.g-kids li.g-peer');
  assert.equal(kids.length, 2);
  assert.match(kids[0].textContent, /小禾女 · 2026 年生你离开的时候，她 44 岁。/);
  assert.match(root.querySelector('section.g-rare').textContent, /参与命名了一个新物种.*2052 年 · 57 岁/);

  // the last sentence: written, shown, editable, saved in the life's notes as kind 'final'
  const box = root.querySelector('section.g-final');
  assert.equal(box.querySelector('h2.g-h').textContent, '最后，你想对这个人说一句话');
  const ta = box.querySelector('textarea.g-final-ta');
  ta.value = '谢谢你认真地活过。';
  ta.dispatchEvent({ type: 'input' });
  assert.equal(box.querySelector('span.g-final-count').textContent, '9/200');
  box.querySelectorAll('button').find((b) => b.textContent === '留下这句话').click();
  assert.deepEqual(state.notes.filter((n) => n.kind === 'final').map((n) => n.text), ['谢谢你认真地活过。']);
  assert.equal(box.querySelector('figure.g-final-said blockquote').textContent, '「谢谢你认真地活过。」');
  assert.match(box.textContent, /下载的死亡证明卡上也会写上它/);
  box.querySelectorAll('button').find((b) => b.textContent === '改一改').click();
  const ta2 = box.querySelector('textarea.g-final-ta');
  assert.equal(ta2.value, '谢谢你认真地活过。');
  assert.equal(doc.activeElement, ta2);
  ta2.value = '下辈子见。';
  ta2.dispatchEvent({ type: 'keydown', key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.deepEqual(state.notes.filter((n) => n.kind === 'final').map((n) => n.text), ['下辈子见。']);
  root.querySelector('section.g-compare button.g-link').click();
  assert.deepEqual(gone[0], ['settings', { focus: 'compare' }]);
  if (typeof cleanup === 'function') cleanup();
  root.remove();

  // no birthplace given: an invitation instead; no stars: a hint that teaches the ☆
  const quiet = v2DeadLife();
  quiet.stars = [];
  quiet.rare = [];
  quiet.person.children = [];
  const root2 = doc.createElement('div');
  const cleanup2 = death.mount(root2, { state: quiet, deps: { engine: {} } }, { ...app, settings: {} });
  assert.ok(root2.querySelector('section.g-compare--invite'));
  assert.match(root2.querySelector('section.g-stars').textContent, /点一下 ☆/);
  assert.match(root2.querySelector('section.g-rare').textContent, /没有遇到稀有的际遇/);
  assert.equal(root2.querySelector('section.g-kids'), null);
  root2.querySelectorAll('section.g-compare button').find((b) => b.textContent === '去填写').click();
  assert.deepEqual(gone[1], ['settings', { focus: 'compare' }]);
  if (typeof cleanup2 === 'function') cleanup2();
});

function v2ShellApp(data, saved) {
  const { app: appMod } = v2;
  const app = {
    data, settings: { ...appMod.DEFAULT_SETTINGS }, defaults: appMod.DEFAULT_SETTINGS, textures: appMod.AUTO_TEXTURES, ui: appMod.UI,
    ai: { available: false, pending: false }, social: { mode: 'local' }, controller: null,
    getLife: () => null, go() {}, toast() {}, confirm: async () => false, abandonLife() {}, archiveNo: () => 'LL-0000-XXX-000000',
    saveSettings(p) { saved.push({ ...p }); Object.assign(app.settings, p); return app.settings; },
  };
  return app;
}

test('settings: auto-choose texture, reflection pauses, 略过可怕的情节 with an honest note, music and the local-only birthplace', async () => {
  const { settings } = await loadV2();
  const data = loadReal();
  const saved = [];
  const app = v2ShellApp(data, saved);
  const root = doc.createElement('div');
  doc.body.append(root);
  const cleanup = settings.mount(root, { focus: 'compare' }, app);
  await nextFrame();
  const tex = root.querySelector('#ll-set-texture');
  assert.equal(tex.querySelectorAll('label.ll-box').length, 8);
  assert.match(tex.querySelector('p.ll-boxes-hint').textContent, /亲自做的选择不受影响/);
  change(tex.querySelectorAll('input').find((i) => i.value === 'giving'), true);
  assert.deepEqual(saved.pop(), { autoTexture: 'giving' });
  const gentle = root.querySelector('#ll-set-gentle');
  assert.match(gentle.parentNode.textContent, /略过可怕的情节/);
  assert.match(gentle.parentNode.textContent, /仍然按真实的统计概率发生/);
  assert.equal(gentle.checked, false);
  gentle.checked = true;
  change(gentle);
  assert.deepEqual(saved.pop(), { gentle: true });
  const music = root.querySelector('#ll-set-music');
  assert.equal(music.checked, true, 'music is on by default');
  music.checked = false;
  change(music);
  assert.deepEqual(saved.pop(), { music: false });
  const reflect = root.querySelector('#ll-set-reflect');
  assert.equal(reflect.checked, true);
  assert.match(reflect.parentNode.textContent, /5、15、30、50、70 岁/);

  const sel = root.querySelector('#ll-set-cmp-c');
  assert.equal(doc.activeElement, sel, 'params.focus = compare focuses the country select');
  assert.ok(root.querySelector('#ll-set-sec-cmp')._scrolled);
  const opts = sel.querySelectorAll('option');
  assert.equal(opts[0].textContent, '不想选择');
  assert.equal(opts.length - 1, data.isoList.length, 'every country and region');
  assert.ok(sel.querySelectorAll('optgroup').length >= 10, 'grouped by region');
  const year = root.querySelector('#ll-set-cmp-y');
  assert.equal(year.disabled, true, 'year waits for a country');
  change(sel, 'IND');
  assert.deepEqual(saved.pop(), { compareIso: 'IND', compareYear: null });
  assert.equal(year.disabled, false);
  change(year, '1998');
  assert.deepEqual(saved.pop(), { compareIso: 'IND', compareYear: 1998 });
  change(year, '1800');
  assert.deepEqual(saved.pop(), { compareIso: 'IND', compareYear: 1998 }, 'an impossible year is not saved');
  assert.ok(root.querySelector('p.ll-cmp-yhint').classList.contains('is-bad'));
  root.querySelector('fieldset.ll-cmp').querySelectorAll('button').find((b) => b.textContent === '不想选择').click();
  assert.deepEqual(saved.pop(), { compareIso: null, compareYear: null });
  assert.equal(sel.value, '');
  if (typeof cleanup === 'function') cleanup();
  root.remove();
});

test('home: the folded "开始之前" block shows the current choices and saves changes', async () => {
  const { home } = await loadV2();
  const data = loadReal();
  const saved = [];
  const app = v2ShellApp(data, saved);
  app.settings.compareIso = 'BRA';
  const root = doc.createElement('div');
  const cleanup = home.mount(root, {}, app);
  const det = root.querySelector('details.ll-prefs');
  assert.ok(det, 'preferences block in the start panel');
  const now = det.querySelector('span.ll-prefs-now');
  assert.equal(now.textContent, '倾向：顺其自然 · 节点停顿 · 音乐开 · 对照：巴西');
  const sel = det.querySelector('#ll-home-texture');
  assert.equal(sel.querySelectorAll('option').length, 8);
  change(sel, 'career');
  assert.deepEqual(saved.pop(), { autoTexture: 'career' });
  assert.match(det.querySelector('p.ll-texture-desc').textContent, /学业和工作/);
  assert.match(now.textContent, /^倾向：重事业/);
  const gentle = det.querySelector('#ll-home-gentle');
  gentle.checked = true;
  change(gentle);
  assert.deepEqual(saved.pop(), { gentle: true });
  assert.match(now.textContent, /温和叙述/);
  assert.equal(det.querySelector('#ll-home-cmp-c').value, 'BRA');
  assert.equal(typeof cleanup, 'function');
  cleanup();
});
