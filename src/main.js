// Boot: show the archive loader with real download progress while ~3.7 MB of data arrives, then connect the AI and
// sharing layers, then hand over to the app shell. A failed load shows an error document with a retry button.
// Hot reload: the viewer may hand back a snapshot ({screen, life}) which the app restores.

import { h, clear } from './ui/dom.js';
import { FIRST_YEAR, HISTORY_END, LAST_YEAR, DATA_DATE } from './core/constants.js';
import * as dataMod from './core/data.js';
import * as aiMod from './ai/claude.js';
import * as socialMod from './social/store.js';
import { createApp } from './ui/app.js';

const FILES = [
  { name: 'countries.json', label: '各国人口与经济指标', src: '联合国 WPP 2024 · 世界银行 WDI', est: 2363000 },
  { name: 'mortality.json', label: '分年龄、性别的生命表', src: '联合国 WPP 2024 · 2000–2100', est: 1142000 },
  { name: 'content.json', label: '史实、世界线与各国人生路径', src: '经核实的史料与推演研究', est: 720000 },
];

const SERVICE_WAIT_MS = 2500; // longest the loader waits for AI / sharing before opening the app (they finish later)
const HOT_WAIT_MS = 1500;     // longest boot waits for a hot-reload snapshot (data loading normally takes longer)

let currentApp = null;

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1);
}

function loaderView(root) {
  clear(root);
  const n = LAST_YEAR - FIRST_YEAR + 1;
  const cells = [];
  const strip = h('div.ll-boot-strip', { style: { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }, 'aria-hidden': 'true' });
  for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) {
    const c = h('span.ll-boot-cell' + (y > HISTORY_END ? '.is-proj' : ''));
    cells.push(c);
    strip.appendChild(c);
  }
  const rows = FILES.map((f) => {
    const fill = h('span.ll-boot-fill');
    const meta = h('span.ll-boot-meta', '等待');
    const row = h('li.ll-boot-row',
      h('span.ll-boot-file', h('span.ll-boot-label', f.label), h('span.ll-boot-src', f.src)),
      h('span.ll-boot-bar', fill),
      meta);
    return { ...f, row, fill, meta, got: 0, total: 0, done: false, started: false };
  });
  const pct = h('span.ll-boot-pct', '0');
  const bytes = h('span.ll-boot-bytes', '');
  const stage = h('p.ll-boot-stage', '正在调阅档案');
  const progress = h('div.ll-boot-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': '数据加载进度' },
    h('span.ll-boot-pctwrap', pct, h('span.ll-boot-pctunit', '%')), bytes);
  const view = h('div.ll-boot',
    h('div.ll-boot-in',
      h('p.ll-eyebrow', `人生长河 · ${FIRST_YEAR}–${LAST_YEAR}`),
      h('h1.ll-boot-title', '正在调阅档案'),
      h('p.ll-boot-lede', `载入 ${FIRST_YEAR}–${LAST_YEAR} 年世界各国的人口、死亡率与经济数据。数据截至 ${DATA_DATE}。`),
      progress,
      strip,
      h('ol.ll-boot-rows', rows.map((r) => r.row)),
      stage));
  root.appendChild(view);

  let raf = 0;
  function paint() {
    raf = 0;
    let got = 0, den = 0;
    for (const r of rows) {
      const est = r.total && r.total >= r.got ? r.total : Math.max(r.est, r.got * 1.04);
      const frac = r.done ? 1 : Math.min(0.985, r.got / est);
      got += r.got;
      den += r.done ? r.got : est;
      r.fill.style.transform = `scaleX(${frac.toFixed(4)})`;
      r.row.classList.toggle('is-done', r.done);
      r.row.classList.toggle('is-active', r.started && !r.done);
      r.meta.textContent = r.done ? `${fmtMB(r.got)} MB · 完成` : r.started ? `${fmtMB(r.got)} MB` : '等待';
    }
    const all = den > 0 ? Math.min(1, got / den) : 0;
    const p = Math.floor(all * 100);
    pct.textContent = String(p);
    progress.setAttribute('aria-valuenow', String(p));
    bytes.textContent = `${fmtMB(got)} / ${fmtMB(Math.max(den, got))} MB`;
    const lit = Math.round(all * cells.length);
    cells.forEach((c, i) => c.classList.toggle('is-lit', i < lit));
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  return {
    rows,
    schedule,
    paintNow: paint,
    setStage(text) { stage.textContent = text; },
    finishAll() { rows.forEach((r) => { if (!r.done) { r.done = true; r.started = true; } }); paint(); },
  };
}

function rowFor(loader, path) {
  const base = String(path || '').split(/[\\/]/).pop();
  return loader.rows.find((r) => r.name === base) || null;
}

/** fetch + JSON.parse with streamed progress; relative to the page ('data/<file>'). */
async function fetchJsonWithProgress(path, row, onProgress) {
  const base = String(path || '').split(/[\\/]/).pop();
  const url = /^(https?:)?\/\//.test(path) || String(path).includes('/') ? String(path) : 'data/' + base;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${base}：HTTP ${res.status}`);
  if (row) {
    row.started = true;
    const len = Number(res.headers.get('content-length')) || 0;
    // gzip transfer may report the compressed size; only trust it while the stream stays within it
    row.total = len;
  }
  let text;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (row) { row.got = got; if (row.total && got > row.total) row.total = 0; }
      onProgress();
    }
    const buf = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    text = new TextDecoder('utf-8').decode(buf);
  } else {
    text = await res.text();
    if (row) row.got = text.length;
  }
  if (row) { row.done = true; row.total = row.got; }
  onProgress();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${base} 不是有效的数据文件`);
  }
}

async function loadAllData(loader) {
  const fetchJson = (path) => fetchJsonWithProgress(path, rowFor(loader, path), loader.schedule);
  if (typeof dataMod.loadData === 'function') return dataMod.loadData(fetchJson);
  if (typeof dataMod.makeDataStore === 'function') {
    const [countries, mortality, content] = await Promise.all(FILES.map((f) => fetchJson('data/' + f.name)));
    return dataMod.makeDataStore({ countries, mortality, content });
  }
  throw new Error('数据模块缺失');
}

function errorView(root, err, kind, retry) {
  clear(root);
  const msg = String(err && err.message ? err.message : err || '未知错误').slice(0, 400);
  const isData = kind === 'data';
  const retryBtn = h('button.ll-btn.ll-btn--ink', { type: 'button', onclick: retry }, '重新调阅');
  root.appendChild(h('div.ll-boot.ll-boot--error',
    h('div.ll-boot-in',
      h('div.ll-doc.ll-errdoc', { role: 'alert' },
        h('p.ll-eyebrow', isData ? '档案调阅失败' : '启动失败'),
        h('h1.ll-h2', isData ? '数据没有加载成功' : '程序启动时出错'),
        h('p', isData
          ? '人口、死亡率或史实数据没有完整下载。可能是网络中断，或者页面刚刚更新过。请检查网络后重新调阅。'
          : '数据已经载入，但程序在初始化时出错。重新调阅通常可以解决；如果反复出现，请把下面的信息反馈给我们。'),
        h('pre.ll-errdoc-detail', msg),
        h('div.ll-actions', retryBtn)))));
  requestAnimationFrame(() => retryBtn.focus());
}

function settleWithin(promise, ms) {
  let timer = 0;
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); return { done: true, value: v }; }),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); }),
  ]);
}

async function boot(snapshotSource) {
  let root = document.getElementById('app');
  if (!root) { root = h('div#app'); document.body.appendChild(root); }
  if (currentApp) { try { currentApp.destroy?.(); } catch { /* ignore */ } currentApp = null; }

  const loader = loaderView(root);
  let data;
  try {
    data = await loadAllData(loader);
    loader.finishAll();
  } catch (e) {
    console.error(e);
    errorView(root, e, 'data', () => boot(snapshotSource));
    return;
  }

  loader.setStage('正在连接 AI 推演与共享服务');
  const aiP = Promise.resolve().then(() => (typeof aiMod.initAI === 'function' ? aiMod.initAI() : { available: false }))
    .then((r) => r || { available: false }, (e) => { console.error(e); return { available: false, reason: String(e?.message || e) }; });
  const socialP = Promise.resolve().then(() => {
    try { socialMod.setDataSource?.(data); } catch { /* optional */ }
    return typeof socialMod.initSocial === 'function' ? socialMod.initSocial({ data }) : { mode: 'local' };
  }).then((r) => r || { mode: 'local' }, (e) => { console.error(e); return { mode: 'local' }; });
  const [aiR, socialR, snapshot] = await Promise.all([
    settleWithin(aiP, SERVICE_WAIT_MS),
    settleWithin(socialP, SERVICE_WAIT_MS),
    Promise.resolve(snapshotSource).catch(() => null),
  ]);

  try {
    clear(root);
    const app = createApp(root, {
      data,
      ai: aiR.done ? aiR.value : { available: false, pending: true },
      social: socialR.done ? socialR.value : { mode: 'local', pending: true },
      snapshot: snapshot && typeof snapshot === 'object' ? snapshot : null,
    });
    currentApp = app;
    if (!aiR.done) aiP.then((r) => app.setAI(r));
    if (!socialR.done) socialP.then((r) => app.setSocial(r));
  } catch (e) {
    console.error(e);
    errorView(root, e, 'init', () => boot(snapshot));
  }
}

/**
 * Hot reload: the host may hand back the last snapshot ({screen, params, life}) that app.js registered with
 * window.claude.hot.snapshot(). `hot.ready` may deliver it to a callback, return it (or a promise of it), or leave it
 * on `hot.data`; every form is accepted, and boot never waits on it longer than HOT_WAIT_MS. The data download starts
 * at once, so waiting for the snapshot costs nothing in practice.
 */
function hotSnapshot() {
  let hot;
  try { hot = typeof window !== 'undefined' && window.claude ? window.claude.hot : undefined; } catch { hot = undefined; }
  if (!hot || typeof hot !== 'object') return Promise.resolve(null);
  const fromData = () => { try { return hot.data && typeof hot.data === 'object' ? hot.data : null; } catch { return null; } };
  if (typeof hot.ready !== 'function') return Promise.resolve(fromData());
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v && typeof v === 'object' ? v : fromData());
    };
    const timer = setTimeout(() => finish(null), HOT_WAIT_MS);
    let r;
    try { r = hot.ready((snap) => finish(snap)); } catch { r = undefined; }
    if (r && typeof r.then === 'function') r.then((v) => finish(v), () => finish(null));
    else if (r && typeof r === 'object') finish(r);
    else if (fromData()) finish(fromData());
  });
}

boot(hotSnapshot());
