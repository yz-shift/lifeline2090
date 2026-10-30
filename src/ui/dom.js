// Tiny DOM helpers shared by every UI module. Never put untrusted text (AI output, shared db data, user input)
// into innerHTML: h() sets text via textContent.

/**
 * h('div.card#id', {onclick, class, style, dataset, attrs...}, ...children)
 * children: strings (text nodes), nodes, arrays, null/false (skipped)
 */
export function h(tag, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'text') el.textContent = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** SVG element helper (same signature as h, attributes set with setAttribute) */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const fmt = {
  int: (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('zh-CN')),
  num: (n, d = 1) => (n == null || !isFinite(n) ? '—' : Number(n).toFixed(d)),
  pct: (n, d = 0) => (n == null || !isFinite(n) ? '—' : `${Number(n).toFixed(d)}%`),
  /** large numbers in Chinese units: 1.2万, 3.4亿 */
  cn: (n) => {
    if (n == null || !isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '亿';
    if (a >= 1e4) return (n / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '万';
    return Math.round(n).toLocaleString('zh-CN');
  },
  age: (a) => `${Math.floor(a)} 岁`,
  year: (y) => `${y} 年`,
};

/** Respect prefers-reduced-motion everywhere animations are optional. */
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Safe localStorage wrapper: never throws, returns fallback when unavailable. */
export const storage = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

/** Simple pub/sub used for app-wide events (e.g. 'life:year', 'life:decision', 'life:death', 'settings') */
const listeners = new Map();
export const bus = {
  on(evt, fn) { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); return () => listeners.get(evt)?.delete(fn); },
  emit(evt, data) { for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(evt, e); } } },
};
